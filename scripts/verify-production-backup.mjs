#!/usr/bin/env node
/** 只读业务核验；每个容器仅挂自己的持久根，并使用对应业务 UID/GID。 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { FileRunStore } from "../packages/production-pipeline/dist/run-store.js";
import { parseModelConnectionInput } from "../packages/production-pipeline/dist/model-connection.js";
import { validatePreparedOperation } from "../packages/production-pipeline/dist/codex-chat.js";
import { projectCheckpointExecutions } from "../packages/production-pipeline/dist/model-execution-facts.js";
import { DocumentCommandStore } from "../packages/production-pipeline/dist/document-command.js";
import { isDurableTaskBinding, isStoreId, sessionDigest } from "../apps/codex-broker/dist/task-binding.js";
import { BROKER_TASK_KINDS } from "../apps/codex-broker/dist/task-definitions.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hashPattern = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sessionHandle = /^vfs_[A-Za-z0-9_-]{32}$/;
const threadId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
class VerificationError extends Error {}
const fail = (message) => { throw new VerificationError(message); };

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!["--role", "--root", "--logical-root", "--codex-home", "--require-idle", "--require-locally-idle", "--writer-stopped", "--allow-legacy"].includes(flag)
      || !argv[index + 1] || args[flag.slice(2)] !== undefined) fail("参数无效");
    args[flag.slice(2)] = argv[index + 1];
  }
  for (const key of ["require-idle", "require-locally-idle", "writer-stopped", "allow-legacy"]) {
    if (args[key] !== undefined && !["true", "false"].includes(args[key])) fail("策略参数必须为 true 或 false");
  }
  args.requireIdle = args["require-idle"] === "true";
  args.requireLocallyIdle = args["require-locally-idle"] === "true";
  args.allowLegacy = args["allow-legacy"] === "true";
  args.writerStopped = args["writer-stopped"] === "true";
  if (args.requireIdle && args.requireLocallyIdle || args.writerStopped && (!args.requireLocallyIdle || !args.allowLegacy || args.role !== "broker-workspace")) fail("闲置策略组合无效");
  args.checkIdle = args.requireIdle || args.requireLocallyIdle;
  if (!["app-workspace", "broker-workspace"].includes(args.role) || !path.isAbsolute(args.root ?? "")) fail("缺少业务角色或持久根");
  args.root = path.resolve(args.root);
  args.logicalRoot = path.resolve(args["logical-root"] ?? args.root);
  return args;
}

async function exists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
async function children(target) {
  if (!await exists(target)) return [];
  return (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
}
async function json(target) {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch { fail("持久 JSON 不可读取或解析"); }
}
async function hashed(target) {
  const bytes = await readFile(target);
  return { sha256: digest(bytes), bytes: bytes.byteLength };
}
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function fileInside(root, target) {
  if (!within(root, target) || !await exists(target)) fail("必要引用媒体缺失或越出持久根");
  const actual = await realpath(target);
  if (!within(await realpath(root), actual) || !(await stat(actual)).isFile()) fail("引用媒体不是根内普通文件");
  return actual;
}
function mappedPath(value, args, relativeRoot = args.root) {
  if (typeof value !== "string" || !value) fail("媒体路径缺失");
  if (!path.isAbsolute(value)) return path.resolve(relativeRoot, value);
  if (!within(args.logicalRoot, value)) fail("绝对引用越出备份 logical root");
  return path.resolve(args.root, path.relative(args.logicalRoot, value));
}
async function verifyMedia(target, expected, args, media, scope = args.root) {
  await fileInside(scope, target);
  const actual = await hashed(target);
  if (!hashPattern.test(expected.sha256 ?? "") || actual.sha256 !== expected.sha256
    || (expected.sizeBytes !== undefined && actual.bytes !== expected.sizeBytes)) fail("引用媒体摘要或大小不符");
  media.set(path.relative(args.root, target), actual);
  return actual;
}
async function walk(directory) {
  const files = [];
  for (const entry of await children(directory)) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("持久数据不能通过符号链接逃逸");
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

const terminalExecutions = ["completed", "completed_failure", "not_accepted"];
const terminalFailures = ["completed_failure", "not_accepted", "rejected"];

function idleState(value, field, allowed) {
  if (!record(value) || !allowed.includes(value[field])) fail("持久任务未终结或状态未知");
}
function noUncertainOutcome(value) {
  if ((value.outcomeUncertain !== undefined && value.outcomeUncertain !== false)
    || (value.outcomeUncertainOperationIds !== undefined
      && (!Array.isArray(value.outcomeUncertainOperationIds) || value.outcomeUncertainOperationIds.length))) fail("执行结果尚未核清");
}
async function idleFiles(directory) {
  if (await exists(directory) && !(await lstat(directory)).isDirectory()) fail("闲置检查根目录类型无效");
  const files = [];
  for (const entry of await children(directory)) {
    // 冷切换不猜测 PID/时间是否过期，也不回收锁；正常 broker owner fence 在另一条路径处理。
    if (entry.name.endsWith(".lock") || entry.name === ".execution-lease.json"
      || entry.name === ".narration-relayout-worker-active.json" || /\.tmp(?:-|\.|$)/.test(entry.name)) fail("持久执行租约或未完成写入仍存在");
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await idleFiles(target));
    else if (entry.isFile()) files.push(target);
    else fail("闲置检查发现未知持久文件类型");
  }
  return files;
}
function idleRun(run) {
  idleState(run, "status", ["succeeded", "failed", "rejected"]);
  noUncertainOutcome(run);
  const ids = new Set();
  for (const node of run.nodeRuns) {
    idleState(node, "status", ["succeeded", "failed", "rejected", "skipped"]);
    noUncertainOutcome(node);
    if (ids.has(node.nodeId) || node.reexecutionRequiredForInputVersionId !== undefined) fail("节点身份重复或仍需执行");
    ids.add(node.nodeId);
  }
  for (const operation of run.creativeReviewOperations ?? []) {
    idleState(operation, "status", ["completed", "failed", "not_accepted"]);
    if (!identifier.test(operation.commandId ?? "") || !hashPattern.test(operation.requestDigest ?? "")
      || !Number.isFinite(Date.parse(operation.finishedAt))) fail("创作命令缺少终结身份");
    if (operation.durationChange !== undefined) idleState(operation.durationChange, "phase", ["applied"]);
  }
  for (const operation of run.reviewContinuationOperations ?? []) {
    idleState(operation, "status", ["applied", "failed"]);
    if (!identifier.test(operation.commandId ?? "") || !hashPattern.test(operation.requestDigest ?? "")
      || !Number.isFinite(Date.parse(operation.finishedAt))) fail("续接命令缺少终结身份");
  }
}
function idleLoop(value) {
  if (!/^video-factory\/agent-loop-checkpoint-v[3-9]$/.test(value.version)
    || !hashPattern.test(value.key ?? "") || !Array.isArray(value.completed) || !Array.isArray(value.attemptedRequestIds)
    || value.attemptedRequestIds.some((id) => typeof id !== "string" || !id)) fail("规划检查点结构未知");
  idleState(value, "status", ["passed", "failed", "exhausted"]);
  if (value.pendingOperation !== undefined) fail("规划原请求仍待核");
  for (const iteration of value.completed) {
    if (!record(iteration) || !Number.isSafeInteger(iteration.iteration) || iteration.iteration < 1
      || !record(iteration.audit) || !["pass", "repair"].includes(iteration.audit.verdict)) fail("规划已完成迭代结构无效");
  }
  if (value.status === "passed" && (!value.completed.length || value.completed.at(-1).audit.verdict !== "pass"
    || value.pendingCandidate !== undefined)) fail("规划通过状态缺少完成证据");
  if (value.failure !== undefined) idleState(value.failure, "stage", terminalFailures);
  if (value.requestExecutions !== undefined) {
    if (!record(value.requestExecutions)) fail("规划执行事实无效");
    for (const execution of Object.values(value.requestExecutions)) idleState(execution, "state", terminalExecutions);
  }
  const facts = projectCheckpointExecutions("planning", value, "idle-check");
  for (const fact of facts) {
    idleState(fact, "state", terminalExecutions);
    if (fact.conflict) fail("规划执行事实冲突");
  }
  return new Set(facts.map((fact) => fact.requestId));
}

/** 只检查执行协议字段，不把创作正文里的 status/state 当作调度状态。 */
function idleEvidence(value, settled = new Set()) {
  if (Array.isArray(value)) { for (const item of value) idleEvidence(item, settled); return; }
  if (!record(value)) return;
  if (typeof value.version === "string" && value.version.startsWith("video-factory/agent-loop-checkpoint-")) settled = idleLoop(value);
  if (value.version === "video-factory/codex-prepared-operation-v1") {
    if (!["not_submitted", "possibly_submitted", "accepted", "running", "accepted_unknown"].includes(value.taskFact)) fail("原请求 taskFact 未知");
    if (!settled.has(value.requestId)) fail("原请求缺少已核实终态");
    return;
  }
  if (value.version === "video-factory/creative-discussion-execution-v1") {
    idleState(value, "state", terminalExecutions);
    if (!identifier.test(value.requestId ?? "") || !identifier.test(value.commandId ?? "")) fail("创作执行身份无效");
    if (value.candidates !== undefined) {
      if (!Array.isArray(value.candidates)) fail("创作候选执行事实无效");
      for (const candidate of value.candidates) idleState(candidate, "state", ["failed", "not_accepted"]);
    }
  }
  if (value.version === "video-factory/narration-confirm-operation-v1") idleState(value, "state", ["projected"]);
  if (value.version === "video-factory/narration-relayout-operation-v1") idleState(value, "state", ["applied", "failed", "discarded"]);
  for (const child of Object.values(value)) idleEvidence(child, settled);
}

async function verifyIdleRunFiles(run, directory, files) {
  const settled = new Set();
  const documents = [];
  for (const nodeId of ["reference-grammar", "publish-package"]) {
    const store = new DocumentCommandStore(directory, nodeId);
    for (const command of await store.list()) {
      idleState(command, "state", ["applied", "failed", "stale", "unchanged", "invalid"]);
      if (command.prepared) {
        if (!command.execution && !terminalFailures.includes(command.error?.stage)) fail("文字命令的原请求仍待核");
        settled.add(command.prepared.requestId);
      }
      // 旧候选没有各自终态证据，不能只用最后一个请求的结果放行。
      if (command.priorRequests !== undefined && (!Array.isArray(command.priorRequests) || command.priorRequests.length)) fail("文字命令候选仍待核");
    }
  }
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    const value = await json(file);
    documents.push({ file, value });
    if (value?.version === "video-factory/creative-discussion-execution-v1") {
      idleEvidence(value);
      settled.add(value.requestId);
    }
  }
  for (const { file, value } of documents) {
    if (path.basename(path.dirname(file)) !== ".audio-review-requests" || value?.version !== "video-factory/codex-prepared-operation-v1") continue;
    const result = documents.find((item) => item.file === path.join(path.dirname(file), `${value.requestId}.result.json`))?.value;
    const binding = value.audioInputBinding;
    if (!record(binding) || binding.version !== "video-factory/audio-review-input-v1" || binding.requestId !== value.requestId
      || !record(result) || result.version !== "video-factory/audio-review-result-v1"
      || !["completed", "settled_unusable", "request_failed"].includes(result.kind)
      || ["requestId", "modelId", "videoSha256", "audioSha256", "durationMs"].some((key) => result[key] !== binding[key])
      || !hashPattern.test(binding.videoSha256 ?? "") || !hashPattern.test(binding.audioSha256 ?? "")
      || !Number.isSafeInteger(binding.durationMs) || binding.durationMs <= 0) fail("声音审片缺少绑定的终态证据");
    if (result.kind === "request_failed") idleState(result, "requestState", ["settled", "not_accepted"]);
    else if (!record(result.trace) || result.trace.providerId !== value.binding?.providerId || result.trace.modelId !== value.binding?.modelId
      || result.trace.brokerRequestIdHash !== undefined && result.trace.brokerRequestIdHash !== digest(value.requestId)) fail("声音审片终态身份不一致");
    settled.add(value.requestId);
  }
  for (const { file, value } of documents) {
    const parent = path.basename(path.dirname(file));
    const version = { "document-commands": "video-factory/document-command-v1",
      "discussion-prepared": "video-factory/creative-discussion-prepared-v1",
      "discussion-executions": "video-factory/creative-discussion-execution-v1",
      "relayout-operations": "video-factory/narration-relayout-operation-v1" }[parent];
    if (version && value?.version !== version) fail("持久操作协议未知");
    if (parent === "discussion-executions" && path.basename(file) !== `${digest(value.requestId)}.json`) fail("创作执行文件身份无效");
    if (parent === "agent-loop-checkpoints" && (!record(value) || !/^video-factory\/agent-loop-checkpoint-v[3-9]$/.test(value.version ?? "")
      || path.basename(file) !== `${value.storageKey ?? value.key}.json`)) fail("节点规划检查点身份无效");
    if (parent === "plan-preview-tickets" && path.basename(file) === "reservations.json") {
      if (!Array.isArray(value)) fail("旁白预览预留结构无效");
      for (const reservation of value) idleState(reservation, "state", ["ticketed"]);
    }
    idleEvidence(value, settled);
  }
  await verifyIdlePublishing(run.id, path.join(directory, "publishing"));
}

async function verifyIdlePublishing(runId, directory) {
  const batches = new Map(), journals = new Map();
  for (const entry of await children(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) fail("发布记录布局未知");
    const value = await json(path.join(directory, entry.name));
    const journal = entry.name.endsWith(".journal.json");
    const id = journal ? value?.requestId : value?.id;
    if (!record(value) || !identifier.test(id ?? "") || value.runId !== runId
      || entry.name !== `${id}${journal ? ".journal" : ""}.json`
      || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.deliveries) || !value.deliveries.length) fail("发布记录身份无效");
    const platforms = new Set();
    for (const delivery of value.deliveries) {
      // failed 是 publisher 抛错后保存的“平台结果不确定”，不能冒充可靠终态。
      idleState(delivery, "status", ["submitted", "export_ready", "needs_config"]);
      if (!["douyin", "toutiao", "kuaishou", "bilibili", "xiaohongshu"].includes(delivery.platformId)
        || platforms.has(delivery.platformId)) fail("发布平台身份无效");
      platforms.add(delivery.platformId);
    }
    if (journal) {
      idleState(value, "state", ["completed"]);
      if (value.version !== "video-factory/publish-journal-v1" || !hashPattern.test(value.requestDigest ?? "")
        || value.inProgressPlatformId !== undefined) fail("发布请求仍未结清");
      journals.set(id, value);
    } else {
      const successes = value.deliveries.filter((delivery) => delivery.status !== "needs_config").length;
      if (value.status !== (successes === value.deliveries.length ? "succeeded" : successes ? "partial" : "failed")) fail("发布回执状态不一致");
      batches.set(id, value);
    }
  }
  if (batches.size !== journals.size) fail("发布终态回执未落定");
  for (const [id, journal] of journals) {
    const batch = batches.get(id);
    if (!batch || batch.createdAt !== journal.createdAt || canonical(batch.deliveries) !== canonical(journal.deliveries)) fail("发布 journal 与回执不一致");
  }
}

async function verifyIdleSeries(root) {
  const file = path.join(root, "series/series.json");
  if (!await exists(file)) return;
  const { JsonSeriesStore } = await import("../apps/studio/dist/server/server/series-store.js");
  // list 只做内存投影；不调用 Studio 的 reconcileRuns 或其它恢复入口。
  const raw = await json(file);
  if (!record(raw) || ![1, 2].includes(raw.version) || !Array.isArray(raw.series)) fail("系列记录结构无效");
  for (const series of raw.series) {
    if (!record(series) || typeof series.id !== "string" || !series.id
      || (series.episodes !== undefined && !Array.isArray(series.episodes))
      || (raw.version === 2 && !Array.isArray(series.episodes))) fail("系列记录结构无效");
  }
  const ids = new Set();
  for (const series of await new JsonSeriesStore(file).list()) {
    idleState(series, "status", ["active", "paused"]);
    if (ids.has(series.id)) fail("系列身份重复");
    ids.add(series.id);
    for (const episode of series.episodes) {
      idleState(episode, "status", ["planned", "selected", "ready", "published"]);
      if (episode.runReservation !== undefined || episode.editLease !== undefined) fail("系列预留或编辑租约仍存在");
      idleState(episode.planning, "auditStatus", ["passed", "fallback", "human_override", "stale", "not_audited", "failed"]);
      if (episode.auditHistory !== undefined) {
        if (!Array.isArray(episode.auditHistory)) fail("系列审计历史结构无效");
        for (const audit of episode.auditHistory) idleState(audit, "status", ["passed", "fallback", "human_override", "stale", "not_audited", "failed"]);
      }
    }
  }
}

async function verifyLedgers(runDirectory, args, media) {
  const ledgers = [];
  for (const file of await walk(path.join(runDirectory, "nodes"))) {
    const parent = path.basename(path.dirname(file));
    if (![".voice-operations", ".generation-operations"].includes(parent) || !file.endsWith(".json")) continue;
    const ledger = await json(file);
    if (!record(ledger) || !["video-factory/paid-operation-v2", "video-factory/voice-operation-v3"].includes(ledger.version)
      || typeof ledger.operationId !== "string" || !ledger.operationId || !Array.isArray(ledger.items)
      || path.basename(file) !== `${digest(ledger.operationId)}.json`) fail("付费账本身份或结构无效");
    const nodeRoot = path.dirname(path.dirname(file));
    const ids = new Set();
    for (const item of ledger.items) {
      if (!record(item) || !identifier.test(item.itemRequestId ?? "") || ids.has(item.itemRequestId)
        || typeof item.providerId !== "string" || !item.providerId || typeof item.modelId !== "string" || !item.modelId
        || !["prepared", "unknown", "submitted", "provider_succeeded", "materialized", "terminal_failed"].includes(item.state)) fail("付费账本 item 无效");
      ids.add(item.itemRequestId);
      if (args.checkIdle) idleState(item, "state", ["materialized", "terminal_failed"]);
      if (item.state !== "materialized" && !item.localPath && !item.metadataPath) continue;
      let bytes;
      if (item.state === "materialized" || item.localPath) {
        if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) fail("物化媒体缺少字节数");
        bytes = await verifyMedia(mappedPath(item.localPath, args, nodeRoot), item, args, media, nodeRoot);
      }
      if (ledger.version === "video-factory/voice-operation-v3" && item.state === "materialized" && !item.metadataPath) fail("语音响应元数据缺失");
      if (item.metadataPath) {
        const metadata = mappedPath(item.metadataPath, args, nodeRoot);
        await fileInside(nodeRoot, metadata);
        const response = await json(metadata);
        if (!bytes) {
          const raw = mappedPath(item.pendingRawPath, args, nodeRoot);
          await fileInside(nodeRoot, raw);
          bytes = await hashed(raw);
          media.set(path.relative(args.root, raw), bytes);
        }
        const expectedRequest = { itemRequestId: item.responseItemRequestId ?? item.reusedFromItemRequestId ?? item.itemRequestId,
          synthesisKey: item.synthesisKey };
        if (!hashPattern.test(item.synthesisKey ?? "") || !record(response) || canonical(response.request) !== canonical(expectedRequest)
          || response.audio_sha256 !== bytes.sha256 || response.audio_size_bytes !== bytes.bytes) fail("语音响应与原请求/媒体绑定不符");
        const metadataHash = await hashed(metadata);
        if (item.state === "materialized" && metadataHash.sha256 !== item.metadataSha256) fail("语音响应摘要不符");
        media.set(path.relative(args.root, metadata), metadataHash);
      }
    }
    if (ledger.completed === true && ledger.items.some((item) => item.state !== "materialized")) fail("付费账本 completed 与 item 不一致");
    if (args.checkIdle && (typeof ledger.completed !== "boolean" || !ledger.items.length
      || (!ledger.completed && !ledger.items.some((item) => item.state === "terminal_failed")))) fail("付费账本尚未闭合");
    ledgers.push({ path: path.relative(args.root, file), ...await hashed(file) });
  }
  return ledgers;
}

async function verifyIdlePlanningTuples(tuples, runs) {
  const { BaseCheckpointSaver } = await import("@langchain/langgraph-checkpoint");
  const { createCreativePlanningGraph } = await import("../packages/production-pipeline/dist/creative-planning.js");
  const { planningThreadId } = await import("../packages/production-pipeline/dist/creative-planning-store.js");
  // 用官方图解释调度通道；只给解码后的最新 tuple，任何执行或持久化入口都显式拒绝。
  const forbidden = () => fail("闲置检查不得执行规划或写入检查点");
  class ReadonlyCheckpoint extends BaseCheckpointSaver {
    async getTuple() { return structuredClone(this.tuple); }
    put = forbidden;
    putWrites = forbidden;
    deleteThread = forbidden;
  }
  const reader = new ReadonlyCheckpoint();
  const graph = createCreativePlanningGraph({ checkpointer: reader, ports: {
    treatment: forbidden, screenwriter: forbidden, director: forbidden, compile: forbidden,
    searchCandidates: forbidden, rank: forbidden, integrateDirector: forbidden, discuss: forbidden,
  } });
  for (const tuple of tuples.values()) {
    const config = tuple.config.configurable, checkpoint = tuple.checkpoint, value = checkpoint.channel_values;
    const run = runs.get(value.runId);
    if (config.checkpoint_ns !== "" || !run || !record(value.base) || value.base.runId !== value.runId
      || typeof value.inputDigest !== "string" || !value.inputDigest || value.base.inputDigest !== value.inputDigest
      || config.thread_id !== planningThreadId(value.runId, value.inputDigest)
      || checkpoint.v !== 4 || !Number.isFinite(Date.parse(checkpoint.ts))
      || !["treatment", "script", "director", "candidates", "rank", "integrate", "compile"].includes(value.stage)
      || !Number.isInteger(tuple.metadata.step)) fail("规划图身份或调度协议未知");
    for (const channels of [checkpoint.channel_values, checkpoint.channel_versions]) {
      if (Object.keys(channels).some((key) => !(key in graph.channels))) fail("规划图出现未知通道");
    }
    if (checkpoint.pending_sends !== undefined && (!Array.isArray(checkpoint.pending_sends) || checkpoint.pending_sends.length)) fail("规划图仍有待发任务");
    reader.tuple = tuple;
    // 指定 checkpoint_id 禁止把未提交 writes 投影成已完成；数据仅在内存副本内解码。
    const snapshot = await graph.getState(tuple.config);
    const failedStop = ["failed", "rejected"].includes(run.status) && snapshot.tasks.length > 0
      && snapshot.tasks.every((task) => task.error && !task.interrupts?.length)
      && tuple.pendingWrites.every(([, channel]) => channel === "__error__");
    if (!failedStop && (snapshot.next.length || snapshot.tasks.length || tuple.pendingWrites.length)) fail("规划图仍有未完成工作");
    if (!failedStop && !record(value.executablePlan) && !record(value.halt)) fail("规划图缺少确定终态");
    if (value.halt !== null && value.halt !== undefined
      && (!record(value.halt) || !["needs_user", "needs_source", "duplicate_issue", "cross_role_revisions_exhausted"].includes(value.halt.reason)
        || !Array.isArray(value.halt.issueIds) || typeof value.halt.detail !== "string")) fail("规划图停止原因未知");
  }
}

async function verifyPlanningSqlite(root, idleRuns) {
  const target = path.join(root, "planning/checkpoints.sqlite");
  if (!await exists(target)) return [];
  const { default: Database } = await import("better-sqlite3");
  const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");
  const db = new Database(target, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok") fail("planning SQLite 完整性失败");
    // 不调用 setup/fromConnString：它们会切 WAL/建表。只用真实 saver 的反序列化器读取已存在表。
    const saver = new SqliteSaver(db);
    const rows = db.prepare("SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints ORDER BY thread_id, checkpoint_ns, checkpoint_id").all();
    const identities = new Set(rows.map((row) => canonical([row.thread_id, row.checkpoint_ns, row.checkpoint_id])));
    const checkpoints = [], latest = new Map();
    for (const row of rows) {
      const value = await saver.serde.loadsTyped(row.type ?? "json", row.checkpoint);
      const meta = await saver.serde.loadsTyped(row.type ?? "json", row.metadata);
      if (!record(value) || value.id !== row.checkpoint_id || !Number.isInteger(value.v)
        || !record(value.channel_values) || !record(value.channel_versions) || !record(value.versions_seen)
        || typeof row.thread_id !== "string" || !row.thread_id || !record(meta)
        || (row.parent_checkpoint_id && !identities.has(canonical([row.thread_id, row.checkpoint_ns, row.parent_checkpoint_id])))) fail("planning checkpoint 身份或结构无效");
      checkpoints.push({ thread: row.thread_id, namespace: row.checkpoint_ns, id: row.checkpoint_id,
        sha256: digest(canonical({ value, meta, parent: row.parent_checkpoint_id })) });
      if (idleRuns) latest.set(canonical([row.thread_id, row.checkpoint_ns]), {
        config: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } },
        checkpoint: value, metadata: meta, pendingWrites: [],
      });
    }
    const writes = [];
    for (const row of db.prepare("SELECT * FROM writes ORDER BY thread_id, checkpoint_ns, checkpoint_id, task_id, idx").all()) {
      if (!identities.has(canonical([row.thread_id, row.checkpoint_ns, row.checkpoint_id]))) fail("planning write 缺少原 checkpoint");
      const value = await saver.serde.loadsTyped(row.type ?? "json", row.value);
      writes.push(digest(canonical({ ...row, value })));
      const current = latest.get(canonical([row.thread_id, row.checkpoint_ns]));
      if (current?.checkpoint.id === row.checkpoint_id) current.pendingWrites.push([row.task_id, row.channel, value]);
    }
    if (idleRuns) await verifyIdlePlanningTuples(latest, idleRuns);
    return { checkpoints, writes };
  } finally { db.close(); }
}

function collectPrepared(value, requests) {
  if (Array.isArray(value)) { for (const item of value) collectPrepared(item, requests); return; }
  if (!record(value)) return;
  if (value.version === "video-factory/codex-prepared-operation-v1") {
    if (!record(value.route) || typeof value.route.socketPath !== "string" || !isDurableTaskBinding(value.binding)) fail("持久原请求缺少完整身份");
    validatePreparedOperation(value, value.route.socketPath);
    const key = `${value.binding.storeId}/${value.requestId}`;
    const prior = requests.get(key);
    if (prior && canonical(prior.binding) !== canonical(value.binding)) fail("同一原请求出现冲突 binding");
    requests.set(key, { requestId: value.requestId, binding: value.binding,
      required: (prior?.required ?? false) || value.taskFact !== "not_submitted" });
    return;
  }
  for (const child of Object.values(value)) collectPrepared(child, requests);
}

async function verifyApp(args) {
  if (args.checkIdle) {
    for (const directory of ["runs", "checkpoints", "series", "opportunities", "planning"]) await idleFiles(path.join(args.root, directory));
  }
  const store = new FileRunStore(path.join(args.root, "runs"));
  const scan = await store.scan();
  if (!scan.complete || scan.issues.length) fail("run store 完整性检查失败");
  const runs = [], ledgers = [], media = new Map(), requests = new Map();
  for (const run of scan.runs) {
    const loaded = await store.load(run.id);
    const directory = store.runDirectory(run.id);
    if (args.checkIdle) {
      idleRun(loaded);
      await verifyIdleRunFiles(loaded, directory, await walk(directory));
    }
    runs.push({ id: loaded.id, revision: loaded.revision, status: loaded.status, ...await hashed(path.join(directory, "run.json")) });
    for (const artifact of loaded.artifacts ?? []) {
      if (!artifact.uri || !artifact.sha256) continue;
      const candidates = [mappedPath(artifact.uri, args), mappedPath(artifact.uri, args, directory)];
      let target;
      for (const candidate of candidates) if (await exists(candidate)) { target = candidate; break; }
      if (!target) fail("run 工件媒体缺失");
      await verifyMedia(target, artifact, args, media);
    }
    ledgers.push(...await verifyLedgers(directory, args, media));
    for (const file of await walk(directory)) if (file.endsWith(".json") && path.basename(file) !== ".execution-lease.json") {
      collectPrepared(await json(file), requests);
    }
  }
  const { readPlanningMaintenanceIntegrity, readPlanningCheckpoints } = await import("../apps/studio/dist/server/server/planning-operations.js");
  const planning = await readPlanningMaintenanceIntegrity(args.root);
  if (!planning.complete || planning.issues.length) fail("规划检查点不可恢复或身份不完整");
  if (args.checkIdle) {
    for (const name of ["series-showrunner", "topic-editor"]) {
      for (const { checkpoint } of await readPlanningCheckpoints(path.join(args.root, "checkpoints", name))) idleEvidence(checkpoint);
    }
    await verifyIdleSeries(args.root);
  }
  const checkpoints = [];
  for (const file of await walk(path.join(args.root, "checkpoints"))) {
    if (!file.endsWith(".json")) continue;
    const value = await json(file);
    if (args.checkIdle) {
      if (!record(value) || !/^video-factory\/agent-loop-checkpoint-v[3-9]$/.test(value.version ?? "")
        || path.basename(file) !== `${value.key}.json`
        || !["series-showrunner", "topic-editor"].includes(path.basename(path.dirname(file)))) fail("规划检查点布局或协议未知");
      idleEvidence(value);
    }
    collectPrepared(value, requests);
    checkpoints.push({ path: path.relative(args.root, file), ...await hashed(file) });
  }
  const { JsonCreatorSettingsStore } = await import("../apps/studio/dist/server/server/creator-settings-store.js");
  const { JsonOpportunityStore } = await import("../apps/studio/dist/server/server/opportunity-store.js");
  const settings = [];
  for (const [relative, read] of [
    ["settings/creator-settings.json", (file) => new JsonCreatorSettingsStore(file).get()],
    ["opportunities/opportunities.json", (file) => new JsonOpportunityStore(file).list()],
  ]) {
    const file = path.join(args.root, relative);
    // 这些 getter 只读；缺失沿可选默认合同，不创建新文件，也不把默认值写回源。
    if (await exists(file)) {
      const values = await read(file);
      if (args.checkIdle && relative.startsWith("opportunities/")) {
        const ids = new Set();
        for (const value of values) {
          idleState(value.candidate, "status", ["draft", "shortlisted", "approved", "rejected", "tested"]);
          if (!identifier.test(value.candidate.id ?? "") || ids.has(value.candidate.id)) fail("选题身份无效");
          ids.add(value.candidate.id);
          if (value.adoptedCandidateAuditStatus !== undefined) idleState(value, "adoptedCandidateAuditStatus", ["passed", "not_audited"]);
        }
      }
      settings.push({ path: relative, ...await hashed(file) });
    }
  }
  return { complete: true, runs: runs.sort((a, b) => a.id.localeCompare(b.id)), issues: [], checkpoints, settings,
    planningSqlite: await verifyPlanningSqlite(args.root, args.checkIdle ? new Map(scan.runs.map((run) => [run.id, run])) : undefined), ledgers,
    requests: [...requests.values()].sort((a, b) => `${a.binding.storeId}/${a.requestId}`.localeCompare(`${b.binding.storeId}/${b.requestId}`)),
    media: [...media].sort(([a], [b]) => a.localeCompare(b)).map(([uri, value]) => ({ uri, ...value })) };
}

function validSession(value) {
  return record(value) && value.version === 1 && sessionHandle.test(value.handle ?? "") && identifier.test(value.key ?? "")
    && BROKER_TASK_KINDS.includes(value.taskKind) && threadId.test(value.threadId ?? "");
}
async function verifyBroker(args) {
  const base = path.join(args.root, ".video-factory");
  const modelsRoot = path.join(base, "models");
  const modelsFile = path.join(modelsRoot, "models.json");
  if (args.checkIdle) {
    for (const directory of [base, modelsRoot, path.join(base, "codex-idempotency"), path.join(base, "codex-sessions")]) {
      if (await exists(directory) && !(await lstat(directory)).isDirectory()) fail("broker 持久根类型无效");
    }
    for (const entry of await children(modelsRoot)) {
      if (entry.name === "models.json" ? !entry.isFile() : !entry.isDirectory() || !/^m-[a-f0-9]{12}$/.test(entry.name)) fail("模型 registry 布局或写入未完成");
    }
  }
  let models = [], registryHash = null;
  if (await exists(modelsFile)) {
    const registry = await json(modelsFile);
    if (!record(registry) || registry.version !== 1 || !Array.isArray(registry.entries)) fail("models registry 无效");
    const seen = new Set();
    for (const entry of registry.entries) {
      if (!record(entry) || !/^m-[a-f0-9]{12}$/.test(entry.id) || typeof entry.enabled !== "boolean" || seen.has(entry.id)) fail("models identity 无效");
      parseModelConnectionInput(entry.connection);
      seen.add(entry.id);
      models.push({ id: entry.id, enabled: entry.enabled, modelId: entry.connection.modelId });
    }
    registryHash = await hashed(modelsFile);
  }
  const stores = new Map();
  for (const directory of ["codex-idempotency", "codex-sessions"]) {
    for (const entry of await children(path.join(base, directory))) {
      if (!entry.isDirectory()) fail("默认 broker store 布局无效");
      stores.set(`default/${entry.name}`, { provider: entry.name, tasks: path.join(base, "codex-idempotency", entry.name), sessions: path.join(base, "codex-sessions", entry.name) });
    }
  }
  for (const id of new Set([...models.map((item) => item.id), ...(await children(modelsRoot)).filter((item) => item.isDirectory()).map((item) => item.name)])) {
    if (!/^m-[a-f0-9]{12}$/.test(id)) fail("注册/保留模型目录无效");
    stores.set(`registered/${id}`, { provider: id, tasks: path.join(modelsRoot, id, "tasks"), sessions: path.join(modelsRoot, id, "sessions") });
  }
  const results = [], codexThreads = new Set();
  for (const [name, store] of [...stores].sort(([a], [b]) => a.localeCompare(b))) {
    if (args.checkIdle) for (const directory of [store.tasks, store.sessions]) {
      if (await exists(directory) && !(await lstat(directory)).isDirectory()) fail("broker store 根目录类型无效");
    }
    const identityFile = path.join(store.tasks, ".store-id");
    if (args.checkIdle && await exists(identityFile) && !(await lstat(identityFile)).isFile()) fail("broker store-id 文件类型无效");
    const storeId = args.allowLegacy && !await exists(identityFile) ? null : (await readFile(identityFile, "utf8")).trim();
    if (storeId !== null && !isStoreId(storeId)) fail("broker store-id 无效");
    const sessions = new Map(), records = [], embedded = new Map();
    for (const entry of await children(store.sessions)) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) fail("broker session 文件名/布局无效");
      const file = path.join(store.sessions, entry.name), value = await json(file);
      if (!validSession(value) || entry.name !== `${digest(value.handle)}.json`) fail("broker session identity 无效");
      sessions.set(value.handle, value);
    }
    for (const entry of await children(store.tasks)) {
      if ([".store-id", ".owner.lock"].includes(entry.name)) continue;
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) fail("broker request 文件名/布局无效");
      const file = path.join(store.tasks, entry.name), value = await json(file);
      const legacy = args.allowLegacy && [1, 2].includes(value?.version);
      if (!record(value) || !identifier.test(value.requestId ?? "")
        || entry.name !== `${digest(value.requestId)}.json` || !hashPattern.test(value.digest ?? "")
        || (legacy ? value.binding !== undefined || !(["completed", ...(value.version === 1 ? ["accepted"] : [])].includes(value.state))
          : value.version !== 3 || !storeId || !isDurableTaskBinding(value.binding) || value.binding.storeId !== storeId
            || value.binding.providerId !== store.provider || !["accepted", "not_accepted", "completed"].includes(value.state))) fail("broker request/store/binding 身份不一致");
      if (args.requireIdle) {
        idleState(value, "state", ["not_accepted", "completed"]);
        if (value.uncertainty !== undefined) fail("broker 原任务结果仍未知");
      }
      if (args.checkIdle && value.outcome?.outcomeUncertain !== undefined && value.outcome.outcomeUncertain !== false) fail("broker 原任务结果仍未知");
      if (value.state === "accepted") {
        const stop = value.uncertainty?.localExecutionEndedAt;
        const locallyEnded = record(value.uncertainty) && typeof stop === "string" && Number.isFinite(Date.parse(stop))
          && Date.parse(stop) <= Date.now();
        if (value.uncertainty !== undefined && (!record(value.uncertainty) || typeof stop !== "string" || !Number.isFinite(Date.parse(stop)))) fail("broker unknown 停点无效");
        // local 模式只证明本地生命周期结束；原 accepted/unknown 事实与字节保持不变。
        if (args.requireLocallyIdle && !(legacy ? args.writerStopped : locallyEnded)) fail("broker 原任务缺少本地停止证据");
        if (legacy && (value.outcome !== undefined || value.sessionRecord !== undefined || value.uncertainty !== undefined)) fail("旧版 accepted 结构无效");
      } else {
        const outcome = value.outcome;
        if (!record(outcome)) fail("broker outcome 缺失");
        if (outcome.ok === true) {
          const trace = outcome.trace;
          if (value.state !== "completed" || typeof outcome.output !== "string" || !record(trace)
            || (legacy ? trace.providerId !== store.provider || typeof trace.modelId !== "string" || !trace.modelId
              || !BROKER_TASK_KINDS.includes(trace.taskKind)
              : trace.providerId !== value.binding.providerId || trace.modelId !== value.binding.modelId
                || trace.taskKind !== value.binding.kind || (value.binding.contractDigest !== null && trace.contractDigest !== value.binding.contractDigest))) fail("broker outcome trace 与请求绑定不符");
        } else if (outcome.ok !== false || typeof outcome.message !== "string" || ![400, 409, 413, 422, 503, 500].includes(outcome.status)) fail("broker failure outcome 无效");
        if (value.sessionRecord !== undefined || outcome.sessionHandle !== undefined) {
          const session = value.sessionRecord;
          if (!validSession(session) || !outcome.ok || outcome.sessionHandle !== session.handle
            || (legacy ? value.version !== 2 || session.taskKind !== outcome.trace.taskKind
              : session.taskKind !== value.binding.kind || ![sessionDigest({ key: session.key }), sessionDigest({ key: session.key, handle: session.handle })].includes(value.binding.sessionDigest))) fail("broker response/session/digest 绑定不符");
          const existing = embedded.get(session.handle);
          if (existing && canonical(existing) !== canonical(session)) fail("同一 session handle 的 thread 身份冲突");
          embedded.set(session.handle, session);
        }
      }
      records.push({ requestId: value.requestId, state: value.state,
        ...(legacy ? { legacyVersion: value.version, digest: value.digest } : { binding: value.binding }), ...await hashed(file) });
    }
    for (const [handle, session] of sessions) {
      if (!embedded.has(handle) || canonical(embedded.get(handle)) !== canonical(session)) fail("session 索引与权威 completed 请求不一致");
    }
    // session 索引缺失时业务可从 completed record 重建；冷切换必须已完成这项写入。
    if (args.checkIdle && [...embedded.keys()].some((handle) => !sessions.has(handle))) fail("broker session 索引仍待物化");
    for (const session of embedded.values()) if (store.provider === "openai" || store.provider === "zai") codexThreads.add(session.threadId);
    if (storeId === null && (!records.length || records.some((item) => item.legacyVersion === undefined))) fail("缺少 store-id 且无法证明旧版 store");
    results.push({ name, storeId, ...(storeId === null ? { legacy: true } : {}), records,
      sessions: [...sessions.values()].sort((a, b) => a.handle.localeCompare(b.handle)) });
  }
  const codexSessions = [];
  if (codexThreads.size && !args["codex-home"]) fail("CLI session 缺少实际 CODEX_HOME 映射");
  if (args["codex-home"]) {
    const available = new Set();
    for (const subdirectory of ["sessions", "archived_sessions"]) for (const file of await walk(path.join(args["codex-home"], subdirectory))) {
      if (!file.endsWith(".jsonl")) continue;
      const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === "session_meta" && threadId.test(event.payload?.id ?? "")) available.add(event.payload.id);
      }
      codexSessions.push({ path: path.relative(args["codex-home"], file), ...await hashed(file) });
    }
    if ([...codexThreads].some((id) => !available.has(id))) fail("broker session 指向缺失的 CLI thread");
  }
  return { complete: true, models: models.sort((a, b) => a.id.localeCompare(b.id)), registryHash, stores: results, codexSessions,
    brokerRecords: results.reduce((sum, store) => sum + store.records.length, 0),
    brokerSessions: results.reduce((sum, store) => sum + store.sessions.length, 0) };
}

try {
  const args = parseArgs(process.argv);
  if (args.checkIdle && !(await lstat(args.root)).isDirectory()) fail("闲置检查缺少实际持久根");
  const result = args.role === "app-workspace" ? await verifyApp(args) : await verifyBroker(args);
  if (args.requireIdle) result.quiescent = true;
  if (args.requireLocallyIdle) result.localQuiescent = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // JSON/parser/provider 配置异常可能携带原 payload，仅输出受控错误类别。
  const reason = error instanceof VerificationError ? error.message : error?.code ?? error?.name ?? "Error";
  process.stderr.write(`verify-production-backup: 业务完整性验证失败 (${reason})\n`);
  process.exitCode = 1;
}
