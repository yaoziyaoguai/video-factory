#!/usr/bin/env node
/** 只读业务核验；每个容器仅挂自己的持久根，并使用对应业务 UID/GID。 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { FileRunStore } from "../packages/production-pipeline/dist/run-store.js";
import { parseModelConnectionInput } from "../packages/production-pipeline/dist/model-connection.js";
import { validatePreparedOperation } from "../packages/production-pipeline/dist/codex-chat.js";
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
const fail = (message) => { throw new Error(message); };

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!["--role", "--root", "--logical-root", "--codex-home"].includes(flag) || !argv[index + 1]) fail("参数无效");
    args[flag.slice(2)] = argv[index + 1];
  }
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
    ledgers.push({ path: path.relative(args.root, file), ...await hashed(file) });
  }
  return ledgers;
}

async function verifyPlanningSqlite(root) {
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
    const checkpoints = [];
    for (const row of rows) {
      const value = await saver.serde.loadsTyped(row.type ?? "json", row.checkpoint);
      const meta = await saver.serde.loadsTyped(row.type ?? "json", row.metadata);
      if (!record(value) || value.id !== row.checkpoint_id || !Number.isInteger(value.v)
        || !record(value.channel_values) || !record(value.channel_versions) || !record(value.versions_seen)
        || typeof row.thread_id !== "string" || !row.thread_id || !record(meta)
        || (row.parent_checkpoint_id && !identities.has(canonical([row.thread_id, row.checkpoint_ns, row.parent_checkpoint_id])))) fail("planning checkpoint 身份或结构无效");
      checkpoints.push({ thread: row.thread_id, namespace: row.checkpoint_ns, id: row.checkpoint_id,
        sha256: digest(canonical({ value, meta, parent: row.parent_checkpoint_id })) });
    }
    const writes = [];
    for (const row of db.prepare("SELECT * FROM writes ORDER BY thread_id, checkpoint_ns, checkpoint_id, task_id, idx").all()) {
      if (!identities.has(canonical([row.thread_id, row.checkpoint_ns, row.checkpoint_id]))) fail("planning write 缺少原 checkpoint");
      const value = await saver.serde.loadsTyped(row.type ?? "json", row.value);
      writes.push(digest(canonical({ ...row, value })));
    }
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
  const store = new FileRunStore(path.join(args.root, "runs"));
  const scan = await store.scan();
  if (!scan.complete || scan.issues.length) fail("run store 完整性检查失败");
  const runs = [], ledgers = [], media = new Map(), requests = new Map();
  for (const run of scan.runs) {
    const loaded = await store.load(run.id);
    const directory = store.runDirectory(run.id);
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
  const { readPlanningMaintenanceIntegrity } = await import("../apps/studio/dist/server/server/planning-operations.js");
  const planning = await readPlanningMaintenanceIntegrity(args.root);
  if (!planning.complete || planning.issues.length) fail("规划检查点不可恢复或身份不完整");
  const checkpoints = [];
  for (const file of await walk(path.join(args.root, "checkpoints"))) {
    if (!file.endsWith(".json")) continue;
    collectPrepared(await json(file), requests);
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
    if (await exists(file)) { await read(file); settings.push({ path: relative, ...await hashed(file) }); }
  }
  return { complete: true, runs: runs.sort((a, b) => a.id.localeCompare(b.id)), issues: [], checkpoints, settings,
    planningSqlite: await verifyPlanningSqlite(args.root), ledgers,
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
    const storeId = (await readFile(path.join(store.tasks, ".store-id"), "utf8")).trim();
    if (!isStoreId(storeId)) fail("broker store-id 无效");
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
      if (!record(value) || value.version !== 3 || !identifier.test(value.requestId ?? "")
        || entry.name !== `${digest(value.requestId)}.json` || !hashPattern.test(value.digest ?? "")
        || !isDurableTaskBinding(value.binding) || value.binding.storeId !== storeId || value.binding.providerId !== store.provider
        || !["accepted", "not_accepted", "completed"].includes(value.state)) fail("broker request/store/binding 身份不一致");
      if (value.state === "accepted") {
        if (value.uncertainty !== undefined && (!record(value.uncertainty) || !Number.isFinite(Date.parse(value.uncertainty.localExecutionEndedAt)))) fail("broker unknown 停点无效");
      } else {
        const outcome = value.outcome;
        if (!record(outcome)) fail("broker outcome 缺失");
        if (outcome.ok === true) {
          const trace = outcome.trace;
          if (value.state !== "completed" || typeof outcome.output !== "string" || !record(trace)
            || trace.providerId !== value.binding.providerId || trace.modelId !== value.binding.modelId
            || trace.taskKind !== value.binding.kind || (value.binding.contractDigest !== null && trace.contractDigest !== value.binding.contractDigest)) fail("broker outcome trace 与请求绑定不符");
        } else if (outcome.ok !== false || typeof outcome.message !== "string" || ![400, 409, 413, 422, 503, 500].includes(outcome.status)) fail("broker failure outcome 无效");
        if (value.sessionRecord !== undefined || outcome.sessionHandle !== undefined) {
          const session = value.sessionRecord;
          if (!validSession(session) || session.taskKind !== value.binding.kind || !outcome.ok || outcome.sessionHandle !== session.handle
            || ![sessionDigest({ key: session.key }), sessionDigest({ key: session.key, handle: session.handle })].includes(value.binding.sessionDigest)) fail("broker response/session/digest 绑定不符");
          const existing = embedded.get(session.handle);
          if (existing && canonical(existing) !== canonical(session)) fail("同一 session handle 的 thread 身份冲突");
          embedded.set(session.handle, session);
        }
      }
      records.push({ requestId: value.requestId, state: value.state, binding: value.binding, ...await hashed(file) });
    }
    for (const [handle, session] of sessions) {
      if (!embedded.has(handle) || canonical(embedded.get(handle)) !== canonical(session)) fail("session 索引与权威 completed 请求不一致");
    }
    // session 索引缺失时业务可从 completed record 重建；不在验证阶段写回。
    for (const session of embedded.values()) if (store.provider === "openai" || store.provider === "zai") codexThreads.add(session.threadId);
    results.push({ name, storeId, records, sessions: [...sessions.values()].sort((a, b) => a.handle.localeCompare(b.handle)) });
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
  const result = args.role === "app-workspace" ? await verifyApp(args) : await verifyBroker(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // JSON/parser/provider 配置异常可能携带原 payload，仅输出受控错误类别。
  process.stderr.write(`verify-production-backup: 业务完整性验证失败 (${error?.code ?? error?.name ?? "Error"})\n`);
  process.exitCode = 1;
}
