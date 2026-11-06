import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { LocalRenderPort, localRenderAvailability } from "../src/server/agent/local-render.js";
import { realRenderValidator } from "../src/server/agent/media-config.js";
import { probeVideoFile } from "../src/server/agent/media-probe.js";
import { blobSources, recordBlobSources } from "../src/server/agent/material-store.js";
import { attemptsFor } from "../src/server/agent/production-store.js";
import { canonicalJson, digestOf, newAgentId } from "../src/server/agent/util.js";
import { bindPreparedPlan, seedPlanStageWork, type PlanStageWork } from "./helpers/creative-work-fixture.js";
import type { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import type { AgentDatabase } from "../src/server/agent/db.js";
import type { MediaExecutionPort } from "../src/shared/agent/ports.js";
import type { MediaProvenance, ProductionIntent, RenderParameters } from "../src/shared/agent/generated/contracts.js";

const run = promisify(execFile);
let sequence = 0;
const cmd = () => `render-${++sequence}`;

// C1-04：真实 FFmpeg ordered_concat。输入用不同帧率的红/蓝纯色片段验证顺序与归一；
// 输出规格、总时长、无声、并发峰值 1、跨重启恢复、无退出证据占位全部按真实进程行为断言。

const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
  name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
  verificationNote: "离线 Faux 文本", isDefault: true };
const RENDER_CATALOG = { "render:ordered_concat": { binding: null, quoteMinor: 0, priceKind: "bounded" as const, validate: realRenderValidator, probeRenderInputs: true } };

async function makeClip(file: string, color: "red" | "blue", rate: number, seconds: number): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=640x360:r=${rate}:d=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
}

async function frameColor(file: string, atSeconds: number): Promise<[number, number, number]> {
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(atSeconds), "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1024, encoding: "buffer" });
  return [stdout[0]!, stdout[1]!, stdout[2]!];
}

const isRed = (rgb: [number, number, number]) => rgb[0]! > 150 && rgb[2]! < 100;
const isBlue = (rgb: [number, number, number]) => rgb[2]! > 150 && rgb[0]! < 100;

async function buildRuntime(directory: string, clock: () => string,
  createPort: (blobs: ProductionBlobs, db: AgentDatabase) => MediaExecutionPort): Promise<AgentRuntime> {
  return createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock,
    media: { autoStart: false, factory: (db, blobs) => ({ port: createPort(blobs, db), catalog: () => RENDER_CATALOG, models: () => [] }) },
  });
}

interface Assets { directory: string; workRoot: string; clipA: Buffer; clipB: Buffer }

async function prepareAssets(): Promise<Assets> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-render-"));
  await makeClip(path.join(directory, "a.mp4"), "red", 12, 1.2);
  await makeClip(path.join(directory, "b.mp4"), "blue", 30, 0.8);
  return { directory, workRoot: path.join(directory, "media-work"), clipA: readFileSync(path.join(directory, "a.mp4")), clipB: readFileSync(path.join(directory, "b.mp4")) };
}

// 媒体修订按 worker.publish 的行形状直接落库：render 输入走 artifact_revision(media) 引用。
function mediaRevision(runtime: AgentRuntime, conversationId: string, buffer: Buffer, durationMs: number): { artifactId: string; revisionId: string; digest: string } {
  const blobs = runtime.production!.blobs;
  const blob = blobs.persist("local-owner", conversationId, buffer, "video/mp4", durationMs);
  const content = { format: "media", blobId: blob.id, mimeType: "video/mp4", durationMs };
  const artifactId = newAgentId("art"), revisionId = newAgentId("rev"), now = staticClock();
  const db = runtime.database;
  db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,1,?,?,?)")
    .run(artifactId, conversationId, "local-owner", "拼接片段", "video", revisionId, (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM artifacts WHERE conversation_id=?").get(conversationId) as { n: number }).n, now, now);
  db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,run_id,digest,content_json,created_at) VALUES(?,?,1,NULL,?,?,?)")
    .run(revisionId, artifactId, digestOf(content), canonicalJson(content), now);
  db.prepare("UPDATE artifacts SET head_revision_id=? WHERE id=?").run(revisionId, artifactId);
  return { artifactId, revisionId, digest: digestOf(content) };
}

// RenderParameters 已是 ordered/narrated 判别联合；本文件只构造 ordered 分支。
type OrderedRenderParameters = Extract<RenderParameters, { assembly: "ordered_concat" }>;

// 视频 render 只能落在已正式开始的视频创作内（B04/T04）：用产品内核把事项推进到方案阶段，
// 并行时把方案主稿交付关联到本次提案；测试不手写 creation_binding，也不放宽阶段规则。
function stageWork(runtime: AgentRuntime, conversationId: string, title = "拼接视频"): PlanStageWork {
  return seedPlanStageWork(runtime.database, staticClock(), { ownerId: "local-owner", conversationId }, title);
}

function renderIntent(work: { workId: string }, order: { artifactId: string; revisionId: string; digest: string }[], overrides: Partial<OrderedRenderParameters> = {}): ProductionIntent {
  if (!order.length) throw new Error("render 输入不能为空");
  const revisions = order.map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId }));
  const inputs = order.map(ref => ({ kind: "artifact_revision" as const, artifactId: ref.artifactId, revisionId: ref.revisionId, digest: ref.digest }));
  return { workId: work.workId, title: "拼接", inputRevisions: revisions as ProductionIntent["inputRevisions"],
    operations: [{ operationId: "render", outputSlot: "final", kind: "render", model: null,
      inputs: inputs as ProductionIntent["operations"][number]["inputs"], maxCreateAttempts: 1,
      parameters: { assembly: "ordered_concat", format: "mp4", width: 1280, height: 720, fps: 24, ...overrides } satisfies OrderedRenderParameters }],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
}

async function prepareWithPlan(runtime: AgentRuntime, conversationId: string, work: PlanStageWork, intent: ProductionIntent) {
  const prepared = await runtime.service.prepareProposal("local-owner", conversationId, { commandId: cmd(), spec: intent });
  bindPreparedPlan(runtime.database, staticClock(), { ownerId: "local-owner", conversationId }, prepared.proposal, work);
  return prepared;
}

async function acceptRender(runtime: AgentRuntime, conversationId: string, work: PlanStageWork, intent: ProductionIntent): Promise<string> {
  const { proposal } = await prepareWithPlan(runtime, conversationId, work, intent);
  const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
  return admitted.run.id;
}

const staticClock = () => "2026-10-26T00:00:00.000Z";

it("T3 引用边界：明确提案可复用同会话未交付 blob，确认前不制作", async () => {
  const assets = await prepareAssets();
  let submits = 0;
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) => {
    const port = new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot });
    const submit = port.submit.bind(port);
    port.submit = (...args) => { submits++; return submit(...args); };
    return port;
  });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "复用素材" }).conversation;
    const revision = mediaRevision(runtime, conversation.id, assets.clipA, 1200);
    const blob = runtime.production!.blobs.persist("local-owner", conversation.id, assets.clipB, "video/mp4", 800);
    const work = stageWork(runtime, conversation.id, "复用素材视频");
    const intent = renderIntent(work, [revision]);
    intent.operations[0]!.inputs.push({ kind: "blob", blobId: blob.id, digest: blob.digest });
    const prepared = await prepareWithPlan(runtime, conversation.id, work, intent);
    assert.equal(prepared.proposal.state, "ready");
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
    assert.equal(submits, 0);
    const accepted = runtime.service.acceptProposal("local-owner", prepared.proposal.id, { commandId: cmd(), proposalDigest: prepared.proposal.digest });
    for (let i = 0; i < 8; i++) await runtime.worker!.pollOnce();
    assert.equal(runtime.service.getRun("local-owner", accepted.run.id).state, "succeeded");
    assert.equal(submits, 1);
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

it("T3 来源上限：64 项可交付，65 项在准备时拒绝，同图依赖按去重后的来源计算", async () => {
  const assets = await prepareAssets();
  await makeClip(path.join(assets.directory, "c.mp4"), "blue", 24, 0.4);
  let submits = 0;
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) => {
    const port = new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot });
    const submit = port.submit.bind(port);
    port.submit = (...args) => { submits++; return submit(...args); };
    return port;
  });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "来源上限" }).conversation;
    const work = stageWork(runtime, conversation.id, "来源上限视频");
    const refs = [mediaRevision(runtime, conversation.id, assets.clipA, 1200),
      mediaRevision(runtime, conversation.id, assets.clipB, 800),
      mediaRevision(runtime, conversation.id, readFileSync(path.join(assets.directory, "c.mp4")), 400)];
    const sources: MediaProvenance[] = Array.from({ length: 65 }, (_, index) => ({
      provider: "pexels", assetId: String(index), sourceUrl: `https://www.pexels.com/video/${index}/`,
      creatorName: "作者", creatorUrl: "https://www.pexels.com/@author/", licenseUrl: "https://www.pexels.com/license/", acquiredAt: staticClock(),
    }));
    const groups = [sources.slice(0, 32), sources.slice(32, 64), sources.slice(64)];
    for (const [index, ref] of refs.entries()) {
      const revision = runtime.service.readRevision("local-owner", ref.artifactId, ref.revisionId);
      assert.equal(revision.content.format, "media");
      if (revision.content.format === "media") recordBlobSources(runtime.database, revision.content.blobId, groups[index]!);
    }
    const over = renderIntent(work, refs);
    await assert.rejects(runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: over }),
      (error: any) => error.code === "INVALID_INPUT" && /64/.test(error.message));
    assert.equal(submits, 0);
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM proposals").get() as { n: number }).n, 0);
    const chained = renderIntent(work, refs.slice(0, 2));
    chained.operations.push({ ...chained.operations[0]!, operationId: "second", outputSlot: "second-final", inputs: [
      { kind: "operation_output", producerOperationId: "render", outputSlot: "final" },
      { kind: "artifact_revision", ...refs[2]! },
    ] });
    chained.inputRevisions.push({ artifactId: refs[2]!.artifactId, revisionId: refs[2]!.revisionId });
    chained.finalOutput = { operationId: "second", outputSlot: "second-final" };
    await assert.rejects(runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: chained }),
      (error: any) => error.code === "INVALID_INPUT" && /64/.test(error.message));
    assert.equal(submits, 0);
    chained.operations[1]!.inputs[1] = { kind: "artifact_revision", ...refs[0]! };
    chained.inputRevisions.pop();
    const runId = await acceptRender(runtime, conversation.id, work, chained);
    for (let i = 0; i < 8; i++) await runtime.worker!.pollOnce();
    const result = runtime.service.getRun("local-owner", runId);
    assert.equal(result.state, "succeeded");
    const output = result.outputRevisions.at(-1)!;
    const revision = runtime.service.readRevision("local-owner", output.artifactId, output.revisionId);
    assert.equal(revision.content.format, "media");
    if (revision.content.format === "media") assert.deepEqual(revision.content.sources, sources.slice(0, 64));
    assert.equal(submits, 2);
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

it("C1-04：不同帧率输入按声明顺序拼接并归一到冻结规格（A→B / B→A / A→B→A）", async () => {
  assert.equal((await localRenderAvailability()).available, true, "本机需有 ffmpeg/ffprobe/libx264 才能跑真实拼接");
  const assets = await prepareAssets();
  const probeTrace = path.join(assets.directory, "probe-trace.log");
  const probeWrapper = path.join(assets.directory, "ffprobe-trace.sh");
  writeFileSync(probeWrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${probeTrace}'\nexec ffprobe "$@"\n`);
  chmodSync(probeWrapper, 0o755);
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) => new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot, ffprobePath: probeWrapper }));
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "顺序验证" }).conversation;
    const work = stageWork(runtime, conversation.id, "顺序验证视频");
    const clipA = mediaRevision(runtime, conversation.id, assets.clipA, 1200);
    const clipB = mediaRevision(runtime, conversation.id, assets.clipB, 800);
    const cases: { order: ("a" | "b")[]; expectMs: number; checks: [number, (rgb: [number, number, number]) => boolean][] }[] = [
      { order: ["a", "b"], expectMs: 2000, checks: [[0.2, isRed], [1.8, isBlue]] },
      { order: ["b", "a"], expectMs: 2000, checks: [[0.2, isBlue], [1.8, isRed]] },
      { order: ["a", "b", "a"], expectMs: 3200, checks: [[0.2, isRed], [1.6, isBlue], [3.0, isRed]] },
    ];
    for (const [index, testcase] of cases.entries()) {
      const runId = await acceptRender(runtime, conversation.id, work, renderIntent(work, testcase.order.map(key => key === "a" ? clipA : clipB)));
      writeFileSync(probeTrace, "");
      for (let i = 0; i < 5; i++) await runtime.worker!.pollOnce();
      assert.equal(readFileSync(probeTrace, "utf8").trim().split("\n").length, new Set(testcase.order).size + 1,
        "同次提交每个不同输入只探测一次，另探测一次输出；播放顺序不去重");
      const result = runtime.service.getRun("local-owner", runId);
      assert.equal(result.state, "succeeded", `顺序 ${testcase.order.join("→")} 应成功`);
      assert.equal(result.outputRevisions.length, 1);
      const revision = runtime.service.readRevision("local-owner", result.outputRevisions[0]!.artifactId, result.outputRevisions[0]!.revisionId);
      assert.equal(revision.content.format, "media");
      if (revision.content.format !== "media") return;
      const file = path.join(assets.workRoot, attemptsFor(runtime.database, runId).at(-1)!.id, "output.mp4");
      const facts = await probeVideoFile(file);
      assert.equal(facts.width, 1280); assert.equal(facts.height, 720);
      assert.equal(facts.hasAudio, false, "拼接输出必须无声");
      assert.equal(Math.round(facts.frameRate ?? 0), 24, "输出帧率归一到 24fps");
      assert.ok(Math.abs(facts.durationMs - testcase.expectMs) <= 250, `第 ${index + 1} 组总时长 ${facts.durationMs}ms 应≈${testcase.expectMs}ms`);
      for (const [at, judge] of testcase.checks) assert.ok(judge(await frameColor(file, at)), `第 ${index + 1} 组 t=${at}s 帧颜色应匹配顺序 ${testcase.order.join("→")}`);
    }
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

it("C1-04：本地并发峰值 1——两条渲染运行的 ffmpeg 进程不重叠", async () => {
  const assets = await prepareAssets();
  const trace = path.join(assets.directory, "ffmpeg-trace.log");
  const wrapper = path.join(assets.directory, "ffmpeg-trace.sh");
  writeFileSync(wrapper, `#!/bin/sh\nprintf 'start %s\\n' "$(date +%s%3N)" >> '${trace}'\nffmpeg "$@"\nstatus=$?\nprintf 'end %s\\n' "$(date +%s%3N)" >> '${trace}'\nexit $status\n`);
  chmodSync(wrapper, 0o755);
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) =>
    new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot, ffmpegPath: wrapper }));
  try {
    const runs: string[] = [];
    for (let index = 0; index < 2; index++) {
      const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: `并发 ${index}` }).conversation;
      const work = stageWork(runtime, conversation.id, `并发视频 ${index}`);
      runs.push(await acceptRender(runtime, conversation.id, work, renderIntent(work, [
        mediaRevision(runtime, conversation.id, assets.clipA, 1200),
        mediaRevision(runtime, conversation.id, assets.clipB, 800),
      ])));
    }
    for (let i = 0; i < 10; i++) await runtime.worker!.pollOnce();
    for (const runId of runs) assert.equal(runtime.service.getRun("local-owner", runId).state, "succeeded");
    const events = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => {
      const [kind, at] = line.split(" ");
      return { kind: kind as "start" | "end", at: Number(at) };
    });
    assert.equal(events.filter(event => event.kind === "start").length, 2, "恰好两次 ffmpeg 拼接");
    let peak = 0, active = 0;
    for (const event of events) { active += event.kind === "start" ? 1 : -1; peak = Math.max(peak, active); }
    assert.equal(peak, 1, "两次拼接不得重叠（本地并发 1）");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

it("C1-04：文件完成而业务未提交的窗口——重启后 query 发现成品、只发布一次", async () => {
  const assets = await prepareAssets();
  // 第一段装配：黑洞端口把尝试停在 submit_started/unknown（模拟提交后进程崩溃、未写收据）。
  const blackHole = (): MediaExecutionPort => ({
    submit: async input => ({ observationId: "obs-blackhole", attemptId: input.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "模拟进程在拼接后崩溃。", billing: null }),
    query: async query => ({ observationId: "obs-blackhole", attemptId: query.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "模拟进程未恢复。", billing: null }),
    cancel: async query => ({ observationId: "obs-blackhole", attemptId: query.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "模拟进程未恢复。", billing: null }),
  });
  const first = await buildRuntime(assets.directory, staticClock, blackHole);
  let second: AgentRuntime | null = null;
  try {
    const conversation = first.service.createConversation("local-owner", { commandId: cmd(), title: "窗口验证" }).conversation;
    const work = stageWork(first, conversation.id, "窗口验证视频");
    const runId = await acceptRender(first, conversation.id, work, renderIntent(work, [
      mediaRevision(first, conversation.id, assets.clipA, 1200),
      mediaRevision(first, conversation.id, assets.clipB, 800),
    ]));
    await first.worker!.pollOnce();
    const attempt = attemptsFor(first.database, runId).at(-1)!;
    assert.equal(attempt.state, "unknown", "黑洞提交后应停在无退出证据的 unknown");
    assert.equal(attempt.phase !== "prepared", true);
    await first.close();
    // 模拟“文件已完整落盘但业务收据未写”：直接在确定性位置产出合规成品。
    const attemptDir = path.join(assets.workRoot, attempt.id);
    await run("mkdir", ["-p", attemptDir]);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-i", path.join(assets.directory, "a.mp4"), "-i", path.join(assets.directory, "b.mp4"),
      "-filter_complex", "[0:v]scale=1280:720,fps=24,setsar=1[v0];[1:v]scale=1280:720,fps=24,setsar=1[v1];[v0][v1]concat=n=2:v=1:a=0[out]",
      "-map", "[out]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", path.join(attemptDir, "output.mp4")]);
    // 完整文件之后的持久化异常必须传到 worker 边界，不能被当作文件尚未就绪吞掉。
    const probeRuntime = await buildRuntime(assets.directory, staticClock, (blobs, db) => new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot }));
    try {
      const blobs = probeRuntime.production!.blobs;
      const persist = blobs.persist;
      const port = new LocalRenderPort(probeRuntime.database, blobs, staticClock, { workRoot: assets.workRoot });
      blobs.persist = () => { throw new Error("synthetic persist failure"); };
      try {
        await assert.rejects(port.query({ kind: "local", runId, operationId: attempt.operation_id, attemptId: attempt.id, requestIdentity: attempt.request_identity }), /synthetic persist failure/);
      } finally { blobs.persist = persist; }
      assert.equal((probeRuntime.database.prepare("SELECT COUNT(*) AS n FROM production_attempt_outputs").get() as { n: number }).n, 0);
    } finally { await probeRuntime.close(); }
    // 第二段装配：真实端口按“收据缺失但成品在位”路径恢复。
    second = await buildRuntime(assets.directory, staticClock, (blobs, db) => new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot }));
    for (let i = 0; i < 3; i++) await second.worker!.pollOnce();
    const recovered = second.service.getRun("local-owner", runId);
    assert.equal(recovered.state, "succeeded", "确定性位置的完整成品应被采纳");
    assert.equal(recovered.outputRevisions.length, 1, "恢复后恰好发布一次");
    assert.equal((second.database.prepare("SELECT COUNT(*) AS n FROM production_attempt_outputs").get() as { n: number }).n, 1);
    await second.worker!.pollOnce(); await second.worker!.pollOnce();
    assert.equal(second.service.getRun("local-owner", runId).outputRevisions.length, 1, "后续轮询不得重复发布");
  } finally { if (first.database.open) await first.close(); await (second ? second.close() : Promise.resolve()); await rm(assets.directory, { recursive: true, force: true }); }
});

it("C1-04：无退出证据——稳定 unknown 且跨重启保留本地占用，其他渲染不得开始", async () => {
  const assets = await prepareAssets();
  const vanish = (): MediaExecutionPort => ({
    submit: async input => ({ observationId: "obs-vanish", attemptId: input.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "进程消失且无收据。", billing: null }),
    query: async query => ({ observationId: "obs-vanish", attemptId: query.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "进程消失且无收据。", billing: null }),
    cancel: async query => ({ observationId: "obs-vanish", attemptId: query.attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: staticClock(), message: "进程消失且无收据。", billing: null }),
  });
  const first = await buildRuntime(assets.directory, staticClock, vanish);
  let second: AgentRuntime | null = null;
  try {
    const conversation = first.service.createConversation("local-owner", { commandId: cmd(), title: "无证据" }).conversation;
    const work = stageWork(first, conversation.id, "无证据视频");
    const stuckRunId = await acceptRender(first, conversation.id, work, renderIntent(work, [
      mediaRevision(first, conversation.id, assets.clipA, 1200),
      mediaRevision(first, conversation.id, assets.clipB, 800),
    ]));
    await first.worker!.pollOnce();
    const stuckAttempt = attemptsFor(first.database, stuckRunId).at(-1)!;
    await first.close();
    // 重启：真实端口查询无收据尝试 → 稳定 unknown；账本不增长。
    second = await buildRuntime(assets.directory, staticClock, (blobs, db) => new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot }));
    await second.worker!.pollOnce(); // 首次恢复查询写入稳定 unknown。
    const observationCount = () => (second!.database.prepare("SELECT COUNT(*) AS n FROM ledger_observations WHERE attempt_id=?").get(stuckAttempt.id) as { n: number }).n;
    const baseline = observationCount();
    for (let i = 0; i < 3; i++) await second.worker!.pollOnce();
    assert.equal(second.service.getRun("local-owner", stuckRunId).state, "unknown", "无退出证据的运行保持非终态 unknown");
    assert.equal(observationCount(), baseline, "重复查询同一稳定 unknown 不产生新账本行");
    assert.match(second.service.getRun("local-owner", stuckRunId).issue?.message ?? "", /退出证据|重新渲染/, "问题说明保留本地占用语义");
    // 新的渲染运行必须被占位规则挡住：不产生任何尝试。
    const other = second.service.createConversation("local-owner", { commandId: cmd(), title: "第二个渲染" }).conversation;
    const otherWork = stageWork(second, other.id, "第二个渲染视频");
    const blockedRunId = await acceptRender(second, other.id, otherWork, renderIntent(otherWork, [
      mediaRevision(second, other.id, assets.clipA, 1200),
      mediaRevision(second, other.id, assets.clipB, 800),
    ]));
    for (let i = 0; i < 3; i++) await second.worker!.pollOnce();
    assert.equal(attemptsFor(second.database, blockedRunId).length, 0, "本地占用未释放前不得开始新的渲染尝试");
  } finally { if (first.database.open) await first.close(); await (second ? second.close() : Promise.resolve()); await rm(assets.directory, { recursive: true, force: true }); }
});


it("C1 审计：本地拼接只启用 1280×720 / 24fps / 一次尝试", async () => {
  const assets = await prepareAssets();
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) => new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot }));
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "输出范围" }).conversation;
    const work = stageWork(runtime, conversation.id, "输出范围视频");
    const clip = mediaRevision(runtime, conversation.id, assets.clipA, 1200);
    for (const parameters of [{ width: 640, height: 360 }, { fps: 30 }]) {
      await assert.rejects(() => prepareWithPlan(runtime, conversation.id, work, renderIntent(work, [clip], parameters)),
        (error: { code?: string }) => error.code === "CAPABILITY_UNAVAILABLE");
    }
    const multipleAttempts = renderIntent(work, [clip]);
    multipleAttempts.operations[0]!.maxCreateAttempts = 2;
    await assert.rejects(() => prepareWithPlan(runtime, conversation.id, work, multipleAttempts),
      (error: { code?: string }) => error.code === "INVALID_INPUT");
    const textInput = renderIntent(work, [clip]);
    textInput.inputRevisions = [];
    textInput.operations[0]!.inputs = [{ kind: "text", text: "文字不能直接交给视频拼接。" }];
    await assert.rejects(() => prepareWithPlan(runtime, conversation.id, work, textInput),
      (error: { code?: string }) => error.code === "INVALID_INPUT");
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

it("C1 审计：收窄能力后，旧提案不能继续受理不再支持的输出规格", async () => {
  const assets = await prepareAssets();
  const first = await createAgentRuntime({
    dataDir: assets.directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    catalog: () => ({ "render:ordered_concat": { binding: null, quoteMinor: 0, priceKind: "bounded", probeRenderInputs: true } }),
  });
  let second: AgentRuntime | undefined;
  try {
    const conversation = first.service.createConversation("local-owner", { commandId: cmd(), title: "旧规格提案" }).conversation;
    const work = stageWork(first, conversation.id, "旧规格视频");
    const clip = mediaRevision(first, conversation.id, assets.clipA, 1200);
    const { proposal } = await prepareWithPlan(first, conversation.id, work,
      renderIntent(work, [clip], { width: 640, height: 360 }));
    await first.close();
    second = await buildRuntime(assets.directory, staticClock, (blobs, db) =>
      new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot }));
    assert.throws(() => second!.service.acceptProposal("local-owner", proposal.id,
      { commandId: cmd(), proposalDigest: proposal.digest }), (error: { code?: string }) => error.code === "PROPOSAL_STALE");
    assert.equal((second.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
  } finally {
    if (first.database.open) await first.close();
    await second?.close();
    await rm(assets.directory, { recursive: true, force: true });
  }
});

it("C1 审计：点击停止能终止正在执行的本地子进程", async () => {
  const assets = await prepareAssets();
  const startedFile = path.join(assets.directory, "started");
  const wrapper = path.join(assets.directory, "slow-ffmpeg.cjs");
  writeFileSync(wrapper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(startedFile)}, 'started');\nsetTimeout(() => process.exit(1), 3000);\n`);
  chmodSync(wrapper, 0o755);
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) =>
    new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot, ffmpegPath: wrapper }));
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "停止拼接" }).conversation;
    const work = stageWork(runtime, conversation.id, "停止拼接视频");
    const clip = mediaRevision(runtime, conversation.id, assets.clipA, 1200);
    const runId = await acceptRender(runtime, conversation.id, work, renderIntent(work, [clip]));
    const pending = runtime.worker!.pollOnce();
    for (let i = 0; i < 100 && !existsSync(startedFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(startedFile), true, "子进程已启动后才发停止请求");
    const current = runtime.service.getRun("local-owner", runId);
    runtime.service.cancelRun("local-owner", runId, { commandId: cmd(), expectedRevision: current.revision });
    await runtime.worker!.pollOnce();
    await pending;
    const attempt = attemptsFor(runtime.database, runId).at(-1)!;
    const receipt = runtime.database.prepare("SELECT exit_kind FROM production_attempt_outputs WHERE attempt_id=?").get(attempt.id) as { exit_kind: string };
    assert.equal(receipt.exit_kind, "terminated", "停止请求必须到达正在运行的子进程");
    assert.equal(runtime.service.getRun("local-owner", runId).state, "cancelled");
    assert.equal(runtime.service.getRun("local-owner", runId).outputRevisions.length, 0);
  } finally {
    await runtime.close();
    await rm(assets.directory, { recursive: true, force: true });
  }
});


it("C1 审计：关闭装配等待异步端口清理后再关闭 SQLite", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-close-port-"));
  let cleanupDone = false;
  let databaseStayedOpen = false;
  const runtime = await buildRuntime(directory, staticClock, (blobs, db) => {
    const port = new LocalRenderPort(db, blobs, staticClock, { workRoot: path.join(directory, "media-work") });
    port.close = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      databaseStayedOpen = db.open;
      cleanupDone = true;
    };
    return port;
  });
  try {
    await runtime.close();
    assert.equal(cleanupDone, true, "异步端口清理不能 fire-and-forget");
    assert.equal(databaseStayedOpen, true, "清理期间 SQLite 必须仍然可用");
  } finally {
    await new Promise(resolve => setTimeout(resolve, 30));
    await rm(directory, { recursive: true, force: true });
  }
});


it("C1 审计：HTTP prepare 重放直接返回回执，不重复探测同一输入", async () => {
  const assets = await prepareAssets();
  const originalPath = process.env.PATH;
  const ffprobe = (await run("which", ["ffprobe"])).stdout.trim();
  const trace = path.join(assets.directory, "probe-count.log");
  const wrapper = path.join(assets.directory, "ffprobe");
  writeFileSync(wrapper, `#!/bin/sh\nprintf 'probe\\n' >> '${trace}'\nexec '${ffprobe}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  process.env.PATH = `${assets.directory}:${originalPath}`;
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) => new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot }));
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "准备重放" }).conversation;
    const work = stageWork(runtime, conversation.id, "准备重放视频");
    const clip = mediaRevision(runtime, conversation.id, assets.clipA, 1200);
    const request = { commandId: cmd(), spec: renderIntent(work, [clip]) };
    const first = await runtime.service.prepareProposal("local-owner", conversation.id, request);
    const before = readFileSync(trace, "utf8");
    const replay = await runtime.service.prepareProposal("local-owner", conversation.id, request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.proposal.id, first.proposal.id);
    assert.equal(readFileSync(trace, "utf8"), before, "重放不应再启动 ffprobe");
  } finally {
    process.env.PATH = originalPath;
    await runtime.close(); await rm(assets.directory, { recursive: true, force: true });
  }
});

it("T3 来源回归：A/B/A 合成、成片再合成与同图依赖输出均继承原来源", async () => {
  const assets = await prepareAssets();
  const runtime = await buildRuntime(assets.directory, staticClock, (blobs, db) => new LocalRenderPort(db, blobs, staticClock, { workRoot: assets.workRoot }));
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "来源继承" }).conversation;
    const work = stageWork(runtime, conversation.id, "来源继承视频");
    const a = mediaRevision(runtime, conversation.id, assets.clipA, 1200);
    const b = mediaRevision(runtime, conversation.id, assets.clipB, 800);
    for (const [ref, assetId] of [[a, "A"], [b, "B"]] as const) {
      const revision = runtime.service.readRevision("local-owner", ref.artifactId, ref.revisionId);
      assert.equal(revision.content.format, "media");
      if (revision.content.format !== "media") throw new Error("fixture missing media");
      recordBlobSources(runtime.database, revision.content.blobId, [{ provider: "pexels", assetId,
        sourceUrl: `https://www.pexels.com/video/${assetId}/`, creatorName: assetId, creatorUrl: "https://www.pexels.com/@a/",
        licenseUrl: "https://www.pexels.com/license/", acquiredAt: staticClock() }]);
    }
    const intents = [renderIntent(work, [a, b, a])];
    for (let stage = 0; stage < 3; stage++) {
      const runId = await acceptRender(runtime, conversation.id, work, intents[stage]!);
      for (let i = 0; i < 8; i++) await runtime.worker!.pollOnce();
      const result = runtime.service.getRun("local-owner", runId);
      assert.equal(result.state, "succeeded");
      const output = result.outputRevisions.at(-1)!;
      const revision = runtime.service.readRevision("local-owner", output.artifactId, output.revisionId);
      if (revision.content.format !== "media") throw new Error("result missing media");
      assert.deepEqual(revision.content.sources?.map(source => source.assetId), ["A", "B"]);
      assert.deepEqual(blobSources(runtime.database, revision.content.blobId).map(source => source.assetId), ["A", "B"]);
      if (stage === 0) intents.push(renderIntent(work, [{ ...output, digest: revision.digest }, a]));
      if (stage === 1) {
        const chain = renderIntent(work, [a, b]);
        const first = chain.operations[0]!;
        chain.operations.push({ ...first, operationId: "render-again", outputSlot: "final-again", inputs: [
          { kind: "operation_output", producerOperationId: "render", outputSlot: "final" },
          { kind: "artifact_revision", ...a },
        ] });
        chain.finalOutput = { operationId: "render-again", outputSlot: "final-again" };
        intents.push(chain);
      }
    }
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});
