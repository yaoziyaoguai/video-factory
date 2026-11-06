import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { renderCatalogEntry } from "../src/server/agent/media-config.js";
import { probeVideoFile } from "../src/server/agent/media-probe.js";
import { attemptOutput, attemptsFor, recordAttemptOutput } from "../src/server/agent/production-store.js";
import { openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { ProductionBlobs, type BlobRow } from "../src/server/agent/production-blobs.js";
import { issueSubmitPermit } from "../src/server/agent/submit-permit.js";
import { canonicalJson, digestOf, newAgentId } from "../src/server/agent/util.js";
import { bindPreparedPlan, ensurePlanStageWork, type PlanStageWork } from "./helpers/creative-work-fixture.js";
import type { ExecutionInput, ProductionIntent, RecoveryQuery, RenderParameters, Run } from "../src/shared/agent/generated/contracts.js";

// M3 ordered_concat audioMode 验收（§11.4）：preserve 按画面时段保留可识别原声并可调序、
// 无声段补静音；explicit none 接受有声输入并输出无声（0.1.22 前该输入在 prepare 被拒）；
// 链式案例用前序 render 的 operation_output 作为输入。全程本地 ffmpeg 字节，零外呼。

const run = promisify(execFile);
let sequence = 0;
const cmd = () => `m3-${++sequence}`;
const staticClock = () => "2026-10-28T00:00:00.000Z";

const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
  name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
  verificationNote: "离线 Faux 文本", isDefault: true };

const LOCAL_CATALOG = () => ({ "render:ordered_concat": renderCatalogEntry(true) });

// —— 夹具：可区分音调的 1280×720/24fps 片段（toneHz 为 null 时无声） ——

async function makeToneClip(file: string, color: "red" | "blue" | "green", seconds: number, toneHz: number | null, audioSeconds = seconds): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:r=24:d=${seconds}`];
  if (toneHz !== null) args.push("-f", "lavfi", "-i", `sine=frequency=${toneHz}:duration=${audioSeconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (toneHz !== null) args.push("-c:a", "aac");
  args.push(file);
  await run("ffmpeg", args);
}

// 指定窗口、指定频带的最大音量（dB）：用音调频率区分两段原声，不靠总音量猜。
async function bandVolumeDb(file: string, fromSeconds: number, seconds: number, centerHz: number): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-ss", String(fromSeconds), "-t", String(seconds), "-i", file,
    "-map", "0:a:0", "-af", `bandpass=f=${centerHz}:w=150,volumedetect`, "-f", "null", "-"], { timeout: 60_000 });
  const match = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  assert.ok(match, "volumedetect 应输出 max_volume");
  return Number(match[1]);
}

// E2/AUD-02：VP8+Opus 的 WebM，音轨明显长于画面。Matroska 把轨级时长写在流标签 DURATION，
// 不写 stream.duration；有声时容器时长被较长音轨带偏，不能拿来代画面时长。
async function makeWebmToneClip(file: string, color: "red" | "blue" | "green", seconds: number, toneHz: number, audioSeconds: number): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:r=24:d=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${toneHz}:duration=${audioSeconds}`,
    "-c:v", "libvpx", "-c:a", "libopus", file]);
}

// —— 修订/intent 助手（与 narrated 套件同形状） ——

interface Ref { artifactId: string; revisionId: string; digest: string }

function mediaRevision(runtime: AgentRuntime, conversationId: string, buffer: Buffer, durationMs: number): Ref {
  const blob = runtime.production!.blobs.persist("local-owner", conversationId, buffer, "video/mp4", durationMs);
  const content = { format: "media", blobId: blob.id, mimeType: "video/mp4", durationMs };
  const artifactId = newAgentId("art"), revisionId = newAgentId("rev"), now = staticClock();
  const db = runtime.database;
  db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,1,?,?,?)")
    .run(artifactId, conversationId, "local-owner", "拼接片段", "video", revisionId,
      (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM artifacts WHERE conversation_id=?").get(conversationId) as { n: number }).n, now, now);
  db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,run_id,digest,content_json,created_at) VALUES(?,?,1,NULL,?,?,?)")
    .run(revisionId, artifactId, digestOf(content), canonicalJson(content), now);
  db.prepare("UPDATE artifacts SET head_revision_id=? WHERE id=?").run(revisionId, artifactId);
  return { artifactId, revisionId, digest: digestOf(content) };
}

function orderedIntent(clips: Ref[], audioMode?: "none" | "preserve"): ProductionIntent {
  const inputs = clips.map(ref => ({ kind: "artifact_revision" as const, artifactId: ref.artifactId, revisionId: ref.revisionId, digest: ref.digest })) as ProductionIntent["operations"][number]["inputs"];
  return { workId: null, title: audioMode === "preserve" ? "保留原声拼接" : "无声拼接",
    inputRevisions: clips.map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
    operations: [{ operationId: "render", outputSlot: "final", kind: "render" as const, model: null, inputs,
      maxCreateAttempts: 1 as const,
      parameters: { assembly: "ordered_concat" as const, format: "mp4" as const, width: 1280, height: 720, fps: 24, ...(audioMode ? { audioMode } : {}) } }],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
}

// 链式：第一个 ordered preserve 成片作为第二个 ordered preserve 的前序 operation_output 输入。
function chainedIntent(first: Ref[], tail: Ref): ProductionIntent {
  const firstInputs = first.map(ref => ({ kind: "artifact_revision" as const, artifactId: ref.artifactId, revisionId: ref.revisionId, digest: ref.digest })) as ProductionIntent["operations"][number]["inputs"];
  return { workId: null, title: "链式保留原声",
    inputRevisions: [...first, tail].map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
    operations: [
      { operationId: "mid", outputSlot: "mid", kind: "render" as const, model: null, inputs: firstInputs, maxCreateAttempts: 1 as const,
        parameters: { assembly: "ordered_concat" as const, format: "mp4" as const, width: 1280, height: 720, fps: 24, audioMode: "preserve" as const } },
      { operationId: "render", outputSlot: "final", kind: "render" as const, model: null,
        inputs: [{ kind: "operation_output", producerOperationId: "mid", outputSlot: "mid" },
          { kind: "artifact_revision" as const, artifactId: tail.artifactId, revisionId: tail.revisionId, digest: tail.digest }],
        maxCreateAttempts: 1 as const,
        parameters: { assembly: "ordered_concat" as const, format: "mp4" as const, width: 1280, height: 720, fps: 24, audioMode: "preserve" as const } },
    ],
    finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
}

const scopeOf = (conversationId: string) => ({ ownerId: "local-owner", conversationId });

async function acceptIntent(runtime: AgentRuntime, conversationId: string, intent: ProductionIntent): Promise<{ runId: string; disclosure: string }> {
  const work: PlanStageWork = ensurePlanStageWork(runtime.database, staticClock(), scopeOf(conversationId), intent.title);
  intent.workId = work.workId;
  const prepared = await runtime.service.prepareProposal("local-owner", conversationId, { commandId: cmd(), spec: intent });
  bindPreparedPlan(runtime.database, staticClock(), scopeOf(conversationId), prepared.proposal, work);
  const admitted = runtime.service.acceptProposal("local-owner", prepared.proposal.id, { commandId: cmd(), proposalDigest: prepared.proposal.digest });
  return { runId: admitted.run.id, disclosure: prepared.proposal.priceDisclosure };
}

const terminal = (state: Run["state"]) => state === "succeeded" || state === "failed" || state === "cancelled";
async function drive(runtime: AgentRuntime, runId: string, cap = 24): Promise<Run> {
  for (let i = 0; i < cap; i++) {
    await runtime.worker!.pollOnce();
    if (terminal(runtime.service.getRun("local-owner", runId).state)) break;
  }
  return runtime.service.getRun("local-owner", runId);
}

async function outputFileOf(runtime: AgentRuntime, runId: string, workRoot: string, operationId = "render"): Promise<string> {
  const attempt = attemptsFor(runtime.database, runId).find(row => row.operation_id === operationId)!;
  assert.ok(attempt, `应存在 ${operationId} 尝试`);
  const file = path.join(workRoot, attempt.id, "output.mp4");
  assert.ok(existsSync(file), "成片应落在确定性位置");
  return file;
}

const workRootOf = (directory: string) => path.join(directory, "media-work");

async function buildRuntime(directory: string): Promise<AgentRuntime> {
  return createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    media: { autoStart: false, factory: (db, blobs) => ({
      port: new LocalRenderPort(db, blobs, staticClock, { workRoot: path.join(directory, "media-work") }),
      catalog: LOCAL_CATALOG, models: () => [],
    }) },
  });
}

async function outputAudioSpec(file: string): Promise<void> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "json", file]);
  const stream = (JSON.parse(stdout) as { streams?: { codec_name?: string; channels?: number; sample_rate?: string }[] }).streams?.[0] ?? {};
  assert.equal(stream.codec_name, "aac", "preserve 输出应统一为 AAC");
  assert.equal(stream.channels, 1, "preserve 输出应统一为单声道");
  assert.equal(stream.sample_rate, "32000", "preserve 输出应统一为 32kHz");
}

interface ToneAssets { directory: string; clipX: Buffer; clipY: Buffer; clipZ: Buffer; clipW: Buffer }

// X=红/440Hz 1.2s，Y=蓝/1300Hz 0.8s，Z=绿/无声 1.0s，W=红/220Hz 1.0s。
async function prepareToneAssets(): Promise<ToneAssets> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-m3-"));
  const x = path.join(directory, "x.mp4"), y = path.join(directory, "y.mp4"), z = path.join(directory, "z.mp4"), w = path.join(directory, "w.mp4");
  await makeToneClip(x, "red", 1.2, 440);
  await makeToneClip(y, "blue", 0.8, 1300);
  await makeToneClip(z, "green", 1.0, null);
  await makeToneClip(w, "red", 1.0, 220);
  return { directory, clipX: readFileSync(x), clipY: readFileSync(y), clipZ: readFileSync(z), clipW: readFileSync(w) };
}

// —— M3-01：preserve 按画面时段保留两段可区分原声，调序后声音跟随画面 ——

it("M3-01：preserve 保留各镜头原声且顺序跟随画面，调序后声音对调", async () => {
  const assets = await prepareToneAssets();
  const runtime = await buildRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "保留原声" }).conversation;
    const clipX = mediaRevision(runtime, conversation.id, assets.clipX, 1200);
    const clipY = mediaRevision(runtime, conversation.id, assets.clipY, 800);
    const xyAccepted = await acceptIntent(runtime, conversation.id, orderedIntent([clipX, clipY], "preserve"));
    const xy = await drive(runtime, xyAccepted.runId);
    assert.equal(xy.state, "succeeded");
    assert.match(xyAccepted.disclosure, /保留各镜头原声/);
    const xyFile = await outputFileOf(runtime, xy.id, workRootOf(assets.directory));
    const xyFacts = await probeVideoFile(xyFile);
    assert.equal(xyFacts.hasAudio, true);
    assert.equal(xyFacts.width, 1280); assert.equal(xyFacts.height, 720);
    assert.ok(Math.abs(xyFacts.durationMs - 2000) <= 250, `成片时长 ${xyFacts.durationMs}ms 应≈2000ms`);
    await outputAudioSpec(xyFile);
    assert.ok(await bandVolumeDb(xyFile, 0.1, 0.9, 440) > -35, "第一段应保留 440Hz 原声");
    assert.ok(await bandVolumeDb(xyFile, 0.1, 0.9, 1300) < -50, "第一段不应有第二段的 1300Hz");
    assert.ok(await bandVolumeDb(xyFile, 1.35, 0.5, 1300) > -35, "第二段应保留 1300Hz 原声");
    assert.ok(await bandVolumeDb(xyFile, 1.35, 0.5, 440) < -50, "第二段不应有第一段的 440Hz");
    // F04：画面各 2s，A 原声仅 1s，B 原声长于画面；边界按视频轨而非容器最长流。
    const shortFile = path.join(assets.directory, "short-audio.mp4"), longFile = path.join(assets.directory, "long-audio.mp4");
    await makeToneClip(shortFile, "red", 2, 440, 1);
    await makeToneClip(longFile, "blue", 2, 1300, 3);
    const clipped = await drive(runtime, (await acceptIntent(runtime, conversation.id, orderedIntent([
      mediaRevision(runtime, conversation.id, readFileSync(shortFile), 2000),
      mediaRevision(runtime, conversation.id, readFileSync(longFile), 3000),
    ], "preserve"))).runId);
    assert.equal(clipped.state, "succeeded");
    const clippedFile = await outputFileOf(runtime, clipped.id, workRootOf(assets.directory));
    assert.ok(await bandVolumeDb(clippedFile, 1.25, 0.4, 1300) < -50, "A 尾部静音期不能提前听到 B");
    assert.ok(await bandVolumeDb(clippedFile, 2.25, 0.5, 1300) > -35, "B 声音在 B 画面开始后出现");
    assert.ok(Math.abs((await probeVideoFile(clippedFile)).durationMs - 4000) <= 250, "过长 B 原声裁至 2s 画面边界");
    // 调序 [Y,X]：声音窗口对调，证明按画面时段对齐而非按输入声道排序。
    const yx = await drive(runtime, (await acceptIntent(runtime, conversation.id, orderedIntent([clipY, clipX], "preserve"))).runId);
    assert.equal(yx.state, "succeeded");
    const yxFile = await outputFileOf(runtime, yx.id, workRootOf(assets.directory));
    assert.ok(await bandVolumeDb(yxFile, 0.1, 0.6, 1300) > -35, "调序后第一段应是 1300Hz");
    assert.ok(await bandVolumeDb(yxFile, 1.0, 0.9, 440) > -35, "调序后第二段应是 440Hz");
    assert.ok(await bandVolumeDb(yxFile, 0.1, 0.6, 440) < -50, "调序后第一段不应残留 440Hz");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— M3-02：一有声一无声的 preserve 时间线：无声段补等长静音 ——

it("M3-02：preserve 遇无音轨片段按等长静音补位，时间线不塌缩", async () => {
  const assets = await prepareToneAssets();
  const runtime = await buildRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "静音补位" }).conversation;
    const clipX = mediaRevision(runtime, conversation.id, assets.clipX, 1200);
    const clipZ = mediaRevision(runtime, conversation.id, assets.clipZ, 1000);
    const result = await drive(runtime, (await acceptIntent(runtime, conversation.id, orderedIntent([clipX, clipZ], "preserve"))).runId);
    assert.equal(result.state, "succeeded");
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    assert.equal(facts.hasAudio, true, "整条成片必须仍有统一音轨");
    assert.ok(Math.abs(facts.durationMs - 2200) <= 250, `成片时长 ${facts.durationMs}ms 应≈2200ms`);
    assert.ok(await bandVolumeDb(file, 0.1, 0.9, 440) > -35, "有声段保留 440Hz 原声");
    assert.ok(await bandVolumeDb(file, 1.4, 0.6, 440) < -50, "无声段应补静音，而非拼接前段音频");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— M3-03：explicit none 接受有声输入并输出无声（0.1.22 前在 prepare 被拒“含声音轨”） ——

it("M3-03：audioMode none 接受有声输入，输出整条无声", async () => {
  const assets = await prepareToneAssets();
  const runtime = await buildRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "全片静音" }).conversation;
    const clipX = mediaRevision(runtime, conversation.id, assets.clipX, 1200);
    const clipY = mediaRevision(runtime, conversation.id, assets.clipY, 800);
    const noneAccepted = await acceptIntent(runtime, conversation.id, orderedIntent([clipX, clipY], "none"));
    const result = await drive(runtime, noneAccepted.runId);
    assert.equal(result.state, "succeeded");
    assert.match(noneAccepted.disclosure, /全片静音/);
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    assert.equal(facts.hasAudio, false, "none 输出不得带音轨");
    assert.ok(Math.abs(facts.durationMs - 2000) <= 250);
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// —— M3-04：前序 operation_output 作为 preserve 输入（链式 render→render，不绕过提案） ——

it("M3-04：前序 render 成片经 operation_output 参与 preserve，原声逐段保留", async () => {
  const assets = await prepareToneAssets();
  const runtime = await buildRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "链式拼接" }).conversation;
    const clipX = mediaRevision(runtime, conversation.id, assets.clipX, 1200);
    const clipY = mediaRevision(runtime, conversation.id, assets.clipY, 800);
    const clipW = mediaRevision(runtime, conversation.id, assets.clipW, 1000);
    const result = await drive(runtime, (await acceptIntent(runtime, conversation.id, chainedIntent([clipX, clipY], clipW))).runId);
    assert.equal(result.state, "succeeded");
    assert.equal(result.outputRevisions.length, 2, "两个 render 各发布一个产出");
    assert.equal(attemptsFor(runtime.database, result.id).length, 2, "两个 render 各恰好一次尝试");
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    assert.equal(facts.hasAudio, true);
    assert.ok(Math.abs(facts.durationMs - 3000) <= 300, `成片时长 ${facts.durationMs}ms 应≈3000ms`);
    // 前半来自前序成片（440→1300），后半来自本地 220Hz 修订：operation_output 的原声被逐段保留。
    assert.ok(await bandVolumeDb(file, 0.1, 0.9, 440) > -35, "前序成片第一段 440Hz 应保留");
    assert.ok(await bandVolumeDb(file, 2.3, 0.6, 220) > -35, "尾部本地片段 220Hz 应保留");
    assert.ok(await bandVolumeDb(file, 2.3, 0.6, 440) < -50, "尾部不应残留前序 440Hz");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});

// M2 端口验收直接使用 canonical mixed 参数，不依赖仍在接线的 prepare/catalog。
type MixedParameters = Extract<RenderParameters, { assembly: "mixed_concat" }>;

function mixedAttempt(db: AgentDatabase, inputs: BlobRow[], parameters: MixedParameters, attemptId: string): ExecutionInput {
  const now = staticClock();
  if (!db.prepare("SELECT 1 FROM production_runs WHERE id='mixed-run'").get()) {
    db.prepare("INSERT INTO works(id,owner_id,conversation_id) VALUES('mixed-work','local-owner','mixed-conversation')").run();
    db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES('mixed-snapshot','{}','fixture-snapshot',?)").run(now);
    db.prepare("INSERT INTO proposals(id,conversation_id,owner_id,digest,spec_json,state,price_disclosure,expires_at,created_seq,created_at,updated_at) VALUES('mixed-proposal','mixed-conversation','local-owner','fixture-proposal','{}','ready','本地验收',?,1,?,?)").run(now, now, now);
    db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,title,state,created_seq,created_at,updated_at) VALUES('mixed-run','local-owner','mixed-conversation','mixed-work','mixed-snapshot','mixed-proposal','混音端口验收','running',1,?,?)").run(now, now);
  }
  const operation: ExecutionInput["operation"] = { operationId: attemptId, outputSlot: "final", kind: "render", model: null,
    inputs: inputs.map(blob => ({ kind: "blob" as const, blobId: blob.id, digest: blob.digest })) as ExecutionInput["operation"]["inputs"],
    maxCreateAttempts: 1, quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded", parameters };
  db.prepare("INSERT INTO production_operations(run_id,id,spec_json,state) VALUES('mixed-run',?,?,'running')").run(attemptId, canonicalJson(operation));
  db.prepare("INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES(?,'mixed-run',?,1,?,'submit_started','running',0)").run(attemptId, attemptId, `request-${attemptId}`);
  return { runId: "mixed-run", snapshotId: "mixed-snapshot", operationId: attemptId, attemptId, requestIdentity: `request-${attemptId}`,
    operation, resolvedInputs: inputs.map((blob, slot) => ({ slot, blobId: blob.id, digest: blob.digest })) };
}

const mixedQuery = (input: ExecutionInput): RecoveryQuery => ({ kind: "local", runId: input.runId,
  operationId: input.operationId, attemptId: input.attemptId, requestIdentity: input.requestIdentity });

// 实际解码成 48k stereo PCM，直接测每个声道的频率幅度；不用滤镜字符串代替输出证据。
async function mixedPcm(file: string): Promise<Float32Array> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "f32le", "pipe:1"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  const samples = new Float32Array(stdout.length / 4);
  for (let index = 0; index < samples.length; index++) samples[index] = stdout.readFloatLE(index * 4);
  return samples;
}

function mixedTone(pcm: Float32Array, start: number, duration: number, hz: number, channel = 0): number {
  const from = Math.round(start * 48000), count = Math.round(duration * 48000);
  assert.ok((from + count) * 2 <= pcm.length, "测量窗口必须落在实际 PCM 内");
  let real = 0, imaginary = 0;
  for (let index = 0; index < count; index++) {
    const sample = pcm[(from + index) * 2 + channel]!;
    const phase = 2 * Math.PI * hz * index / 48000;
    real += sample * Math.cos(phase); imaginary += sample * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / count;
}

function mixedRms(pcm: Float32Array, start: number, duration: number, channel = 0): number {
  const from = Math.round(start * 48000), count = Math.round(duration * 48000);
  let squares = 0;
  for (let index = 0; index < count; index++) squares += pcm[(from + index) * 2 + channel]! ** 2;
  return Math.sqrt(squares / count);
}

it("M2 V3/V4/V6/V7：真实三路混音的裁切、立体声、选区循环、淡变、配音避让与换曲及失败回执", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-mixed-audio-"));
  const workRoot = path.join(directory, "media-work");
  const evidence = process.env.FRAME_MUSIC_EVIDENCE_DIR;
  const db = openAgentDatabase(directory);
  const blobs = new ProductionBlobs(db, directory, staticClock);
  const port = new LocalRenderPort(db, blobs, staticClock, { workRoot });
  try {
    const native = path.join(directory, "original.mp4"), image = path.join(directory, "image.png"), silent = path.join(directory, "silent.mp4");
    const musicA = path.join(directory, "music-a.mp3"), musicB = path.join(directory, "music-b.mp3"), voice = path.join(directory, "paused-narration.mp3");
    // 原声先 440Hz 后 660Hz，音频 2.5s / 画面 4s；裁切从 1s 开始，必须只留 660Hz 并补本段尾静音。
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:r=24:d=4",
      "-f", "lavfi", "-i", "aevalsrc=0.12*sin(2*PI*if(lt(t\\,1)\\,440\\,660)*t)|0.12*sin(2*PI*if(lt(t\\,1)\\,440\\,660)*t):s=48000:d=2.5",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", native]);
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=160x240", "-frames:v", "1", image]);
    await makeToneClip(silent, "blue", 2, null);
    // 44.1k stereo 音乐：选区 [1,3)s 的两个小节左右频率不同，区外 330/550Hz 必须全程不出现。
    const left = "if(lt(t\\,1)\\,330\\,if(lt(t\\,2)\\,880\\,if(lt(t\\,3)\\,1760\\,330)))";
    const right = "if(lt(t\\,1)\\,550\\,if(lt(t\\,2)\\,1320\\,if(lt(t\\,3)\\,2200\\,550)))";
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=0.16*sin(2*PI*${left}*t)|0.16*sin(2*PI*${right}*t):s=44100:d=5`,
      "-c:a", "libmp3lame", "-b:a", "192k", musicA]);
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.16*sin(2*PI*1040*t)|0.16*sin(2*PI*1560*t):s=44100:d=4",
      "-c:a", "libmp3lame", "-b:a", "192k", musicB]);
    // 合法自造测试配音信号，三个 3000Hz 有声窗口，中间有停顿；不是供应商合成或可听语言验收。
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.28*sin(2*PI*3000*t)*(lt(t\\,0.8)+between(t\\,2.5\\,3.3)+gte(t\\,5)):s=32000:d=6.4",
      "-c:a", "libmp3lame", "-b:a", "128k", voice]);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      for (const file of [native, image, silent, musicA, musicB, voice]) copyFileSync(file, path.join(evidence, path.basename(file)));
    }
    // 先建会话，再存真实媒体字节；之后所有变式仅 submit render。
    const parameters: MixedParameters = { assembly: "mixed_concat", format: "mp4", width: 1280, height: 720, fps: 24,
      segments: [
        { kind: "video", inputSlot: 0, startMs: 1000, durationMs: 3000, originalGain: 0.4 },
        { kind: "image", inputSlot: 1, durationMs: 2000 },
        { kind: "video", inputSlot: 2, startMs: 0, durationMs: 2000 },
        { kind: "video", inputSlot: 0, startMs: 1000, durationMs: 3000, originalGain: 0.2 },
      ], segmentIds: ["shot-a", "shot-image", "shot-silent", "shot-a-repeat"],
      music: { inputSlot: 3, candidateId: "fixture-music-a", sourceStartMs: 1000, sourceDurationMs: 2000,
        timelineStartMs: 1000, playDurationMs: 6000, repeat: true, gain: 0.25, fadeInMs: 1000, fadeOutMs: 1000, duckUnderNarration: false },
      narration: { inputSlot: 4, timelineStartMs: 1500, gain: 0.7 } };
    db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('mixed-conversation','local-owner','混音端口验收',1,'mixed-session',?,?)").run(staticClock(), staticClock());
    const files = [native, image, silent, musicA, voice];
    const inputs = files.map((file, slot) => blobs.persist("local-owner", "mixed-conversation", readFileSync(file), slot === 1 ? "image/png" : slot >= 3 ? "audio/mpeg" : "video/mp4", null));
    const replacement = blobs.persist("local-owner", "mixed-conversation", readFileSync(musicB), "audio/mpeg", null);
    const dryInput = mixedAttempt(db, inputs, parameters, "mixed-dry");
    const duckParameters: MixedParameters = { ...parameters, music: { ...parameters.music!, duckUnderNarration: true } };
    const duckInput = mixedAttempt(db, inputs, duckParameters, "mixed-duck");
    const { narration: _narration, ...noVoice } = duckParameters;
    const noVoiceInput = mixedAttempt(db, inputs.slice(0, 4), noVoice, "mixed-no-narration");
    const replacedParameters: MixedParameters = { ...duckParameters, music: { ...duckParameters.music!, candidateId: "fixture-music-b",
      sourceStartMs: 500, sourceDurationMs: 2500, timelineStartMs: 4000, playDurationMs: 2500,
      repeat: false, gain: 0.3, fadeInMs: 0, fadeOutMs: 0, duckUnderNarration: false } };
    const replacedInput = mixedAttempt(db, inputs.map((blob, slot) => slot === 3 ? replacement : blob), replacedParameters, "mixed-replaced-b");
    const rendered: { input: ExecutionInput; file: string; pcm: Float32Array; frameDigest: string; facts: Awaited<ReturnType<typeof probeVideoFile>> }[] = [];
    for (const input of [dryInput, duckInput, noVoiceInput, replacedInput]) {
      const result = await port.submit(input, issueSubmitPermit(input.attemptId, 1));
      assert.equal(result.state, "succeeded", result.message ?? input.attemptId);
      const file = path.join(workRoot, input.attemptId, "output.mp4");
      if (evidence) copyFileSync(file, path.join(evidence, `${input.attemptId}.mp4`));
      assert.equal(existsSync(path.join(workRoot, input.attemptId, "output.part")), false, "成片通过检查后应原子改名");
      assert.equal(attemptOutput(db, input.attemptId)?.exit_kind, "completed");
      assert.deepEqual(await port.query(mixedQuery(input)), result, "沿用可恢复的成品收据");
      const facts = await probeVideoFile(file);
      assert.equal(facts.width, 1280); assert.equal(facts.height, 720); assert.equal(facts.frameRate, 24);
      assert.ok(Math.abs(facts.durationMs - 10000) <= 42, `成片时长 ${facts.durationMs}ms 应为 10s`);
      const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,channels,sample_rate", "-of", "json", file]);
      assert.deepEqual(JSON.parse(stdout).streams[0], { codec_name: "aac", sample_rate: "48000", channels: 2 });
      const frames = await run("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"]);
      const frameHashes = frames.stdout.split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1)!.trim());
      assert.equal(frameHashes.length, 240);
      rendered.push({ input, file, pcm: await mixedPcm(file), frameDigest: digestOf(frameHashes), facts });
    }
    const [dry, duck, noNarration, replaced] = rendered as [typeof rendered[number], typeof rendered[number], typeof rendered[number], typeof rendered[number]];
    const tone = (pcm: Float32Array, at: number, hz: number, channel = 0, duration = 0.2) => mixedTone(pcm, at, duration, hz, channel);
    const originalPcm = await mixedPcm(native), musicPcm = await mixedPcm(musicA), voicePcm = await mixedPcm(voice);
    const originalGain = tone(dry.pcm, 0.2, 660) / tone(originalPcm, 1.2, 660);
    const repeatOriginalGain = tone(dry.pcm, 7.2, 660) / tone(dry.pcm, 0.2, 660);
    assert.ok(Math.abs(originalGain - 0.4) < 0.008, `原声实际增益 ${originalGain} 应≈0.4`);
    assert.ok(Math.abs(repeatOriginalGain - 0.5) < 0.04, "重复段单独应用 0.2 增益，不按输入去重");
    assert.ok(tone(dry.pcm, 0.2, 440) < 0.001, "原声选区外 440Hz 应被裁去");
    for (const at of [1.8, 3.4, 5.4, 8.8]) assert.ok(tone(dry.pcm, at, 660) < 0.001, "短原声尾、图片、无声视频必须按本段补静音");
    const musicGain = tone(dry.pcm, 2.4, 1760) / tone(musicPcm, 2.4, 1760);
    assert.ok(Math.abs(musicGain - 0.25) < 0.005, `音乐实际增益 ${musicGain} 应≈0.25（不得 amix/limiter 自动归一）`);
    const voiceGain = tone(dry.pcm, 1.7, 3000) / tone(voicePcm, 0.2, 3000);
    assert.ok(Math.abs(voiceGain - 0.7) < 0.014, `配音实际增益 ${voiceGain} 应≈0.7`);
    for (const at of [0.4, 7.2, 8.5]) {
      for (const hz of [880, 1320, 1760, 2200]) assert.ok(tone(dry.pcm, at, hz) < 0.001, "音乐只在 [1,7)s 播放");
    }
    const loopWindows = [3.2, 4.2, 5.2, 6.2].map((at, index) => ({ at, hz: index % 2 === 0 ? 880 : 1760, amplitude: tone(dry.pcm, at, index % 2 === 0 ? 880 : 1760) }));
    for (const window of loopWindows) assert.ok(window.amplitude > 0.018, `选区重采样后应在 ${window.at}s 重复 ${window.hz}Hz`);
    for (const at of [1.2, 3.2, 5.2]) {
      assert.ok(tone(dry.pcm, at, 330) < 0.001 && tone(dry.pcm, at, 550, 1) < 0.001, "不能循环整个音乐源或渗入选区外频率");
    }
    const stereo = { left880: tone(dry.pcm, 3.2, 880), right880: tone(dry.pcm, 3.2, 880, 1),
      left1320: tone(dry.pcm, 3.2, 1320), right1320: tone(dry.pcm, 3.2, 1320, 1) };
    assert.ok(stereo.left880 > stereo.right880 * 15 && stereo.right1320 > stereo.left1320 * 15, "左右音乐必须保持不同频率，不能先降成 mono");
    const fadeInRatio = tone(dry.pcm, 1.05, 880, 0, 0.1) / tone(dry.pcm, 3.2, 880);
    const fadeOutRatio = tone(dry.pcm, 6.8, 1760, 0, 0.1) / tone(dry.pcm, 4.2, 1760);
    assert.ok(fadeInRatio > 0.04 && fadeInRatio < 0.18, `淡入窗口幅度比 ${fadeInRatio} 应≈0.1`);
    assert.ok(fadeOutRatio > 0.08 && fadeOutRatio < 0.23, `淡出窗口幅度比 ${fadeOutRatio} 应≈0.15`);
    const duckSpeakingRatio = tone(duck.pcm, 4.4, 1760) / tone(dry.pcm, 4.4, 1760);
    const duckPauseRatio = tone(duck.pcm, 5.8, 880) / tone(dry.pcm, 5.8, 880);
    const originalUnderVoiceRatio = tone(duck.pcm, 7.2, 660) / tone(dry.pcm, 7.2, 660);
    assert.ok(duckSpeakingRatio < 0.45, `配音有声时音乐应降低，实际幅度比 ${duckSpeakingRatio}`);
    assert.ok(duckPauseRatio > 0.9, `配音停顿音乐应恢复，实际幅度比 ${duckPauseRatio}`);
    assert.ok(Math.abs(originalUnderVoiceRatio - 1) < 0.05, "sidechain 不能压低视频原声");
    assert.ok(Math.abs(tone(duck.pcm, 4.4, 3000) / tone(dry.pcm, 4.4, 3000) - 1) < 0.05, "sidechain 不能压低配音本身");
    const noNarrationRatio = tone(noNarration.pcm, 4.4, 1760) / tone(dry.pcm, 4.4, 1760);
    assert.ok(Math.abs(noNarrationRatio - 1) < 0.05, "无独立配音时 duck 标志不能让音乐自行触发避让");
    for (const at of [1.1, 2.6, 5.4, 8.1]) assert.ok(tone(dry.pcm, at, 3000) < 0.001, "完整配音起播前与原停顿必须保留");
    assert.ok(tone(dry.pcm, 7.6, 3000) > 0.1, "配音最后一段必须完整保留，不得截断或变速");
    const silentTailRms = mixedRms(dry.pcm, 8.8, 0.4);
    assert.ok(silentTailRms < 0.001, "最后一段原声结束后应按画面补足静音");
    let narrationOnsetMs = 0;
    for (let ms = 1470; ms < 1540; ms++) {
      if (mixedTone(dry.pcm, ms / 1000, 0.005, 3000) > 0.07) { narrationOnsetMs = ms; break; }
    }
    // 5ms 检测窗口以中心定位跃变；容差小于 limiter 默认 5ms lookahead，能识别未补偿的延迟。
    const narrationCenteredOnsetMs = narrationOnsetMs + 2.5;
    assert.ok(Math.abs(narrationCenteredOnsetMs - 1500) <= 4, `配音实际起点 ${narrationCenteredOnsetMs}ms 应≈1500ms`);
    for (const output of rendered) {
      assert.equal(output.frameDigest, dry.frameDigest, "换曲/避让保持全部 240 帧的内容和顺序");
      if (output.input.operation.kind === "render" && output.input.operation.parameters.assembly === "mixed_concat")
        assert.deepEqual(output.input.operation.parameters.segmentIds, parameters.segmentIds);
    }
    const colors: number[][] = [];
    for (const at of [0.5, 3.5, 5.5, 7.5]) {
      const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(at), "-i", replaced.file, "-frames:v", "1", "-vf", "crop=2:2,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", maxBuffer: 1024 });
      colors.push([...stdout]);
    }
    assert.ok(colors[0]![0]! > 200 && colors[1]![1]! > 100 && colors[2]![2]! > 200 && colors[3]![0]! > 200, "画面顺序必须是红→绿图片→蓝无声视频→红重复段");
    const replacementMusic = { left1040: tone(replaced.pcm, 4.3, 1040), right1560: tone(replaced.pcm, 4.3, 1560, 1),
      beforeStart: tone(replaced.pcm, 3.5, 1040), afterEnd: tone(replaced.pcm, 6.8, 1040),
      oldMusicBandMax: Math.max(...[880, 1320, 1760, 2200].map(hz => tone(replaced.pcm, 4.3, hz, hz === 1320 || hz === 2200 ? 1 : 0))) };
    assert.ok(replacementMusic.left1040 > 0.035 && replacementMusic.right1560 > 0.035, "B 音乐实际进入左右声道");
    assert.ok(replacementMusic.beforeStart < 0.001 && replacementMusic.afterEnd < 0.001, "不循环的 B 只在 [4,6.5)s 播放");
    assert.ok(replacementMusic.oldMusicBandMax < 0.001, "换 B 后不得叠加旧 A");
    assert.deepEqual(replacedInput.resolvedInputs.filter(item => item.slot !== 3), dryInput.resolvedInputs.filter(item => item.slot !== 3), "换曲准确复用原视觉与配音 blob");
    const kinds = db.prepare("SELECT json_extract(spec_json,'$.kind') AS kind, COUNT(*) AS n FROM production_operations GROUP BY kind").all();
    assert.deepEqual(kinds, [{ kind: "render", n: 4 }], "连续换曲只有四次本地 render，新增 video/speech 操作均为零");

    // 已成功 speech 的实际 MP3 与收据先存在，render 发现起播后超长必须保留它。
    const speechOperation = { operationId: "fixture-speech", outputSlot: "voice", kind: "speech", inputs: [{ kind: "text", text: "本地测试信号" }],
      model: FAUX_TEXT_ENTRY.binding, parameters: { voiceId: "fixture", format: "mp3" }, maxCreateAttempts: 1,
      quotePerAttempt: { currency: "CNY", amountMinor: 0 }, priceKind: "bounded" };
    db.prepare("INSERT INTO production_operations(run_id,id,spec_json,state,output_blob_id) VALUES('mixed-run','fixture-speech',?,'succeeded',?)").run(canonicalJson(speechOperation), inputs[4]!.id);
    db.prepare("INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES('fixture-speech-attempt','mixed-run','fixture-speech',1,'fixture-speech-request','observed','succeeded',0)").run();
    recordAttemptOutput(db, staticClock(), "fixture-speech-attempt", { blobId: inputs[4]!.id, digest: inputs[4]!.digest, exitKind: "completed" });
    const speechReceipt = attemptOutput(db, "fixture-speech-attempt");
    const longInput = mixedAttempt(db, inputs, { ...parameters, narration: { ...parameters.narration!, timelineStartMs: 4000 } }, "mixed-too-long");
    longInput.operation.inputs[4] = { kind: "operation_output", producerOperationId: "fixture-speech", outputSlot: "voice" };
    const longResult = await port.submit(longInput, issueSubmitPermit(longInput.attemptId, 1));
    assert.equal(longResult.state, "failed"); assert.match(longResult.message ?? "", /旁白.*超过画面总长.*保留/);
    assert.equal(attemptOutput(db, longInput.attemptId)?.exit_kind, "failed");
    assert.deepEqual(await port.query(mixedQuery(longInput)), longResult);
    assert.deepEqual(attemptOutput(db, "fixture-speech-attempt"), speechReceipt);
    blobs.verify(inputs[4]!);
    assert.equal(existsSync(path.join(workRoot, longInput.attemptId, "output.mp4")), false);
    const invalidInput = mixedAttempt(db, inputs.map((blob, slot) => slot === 3 ? inputs[2]! : blob), parameters, "mixed-no-audio-stream");
    const invalidResult = await port.submit(invalidInput, issueSubmitPermit(invalidInput.attemptId, 1));
    assert.equal(invalidResult.state, "failed"); assert.match(invalidResult.message ?? "", /音乐输入不可读/);
    assert.equal(attemptOutput(db, invalidInput.attemptId)?.exit_kind, "failed");
    assert.equal(existsSync(path.join(workRoot, invalidInput.attemptId, "output.mp4")), false);
    const cancelledInput = mixedAttempt(db, inputs, parameters, "mixed-cancelled");
    const cancelledResult = await port.submit(cancelledInput, issueSubmitPermit(cancelledInput.attemptId, 1), AbortSignal.abort());
    assert.equal(cancelledResult.state, "cancelled"); assert.equal(attemptOutput(db, cancelledInput.attemptId)?.exit_kind, "terminated");
    const measurements = { sampleRate: 48000, channels: 2, frames: 240,
      outputs: rendered.map(output => ({ name: output.input.attemptId, ...output.facts, frameDigest: output.frameDigest })), originalGain, repeatOriginalGain,
      musicGain, voiceGain, loopWindows, stereo, fadeInRatio, fadeOutRatio, duckSpeakingRatio, duckPauseRatio, originalUnderVoiceRatio,
      noNarrationRatio, narrationOnsetMs, narrationCenteredOnsetMs, silentTailRms, frameDigest: dry.frameDigest, colors, replacementMusic,
      generationOperationsBeforeFailureFixtures: kinds, failures: [longResult, invalidResult], cancelled: cancelledResult, listening: "未听音；保留自造信号输入和四份成片供人工待听" };
    console.log("M2 PCM measurements", JSON.stringify(measurements));
    if (evidence) writeFileSync(path.join(evidence, "measurements.json"), JSON.stringify(measurements, null, 2));
  } finally { await port.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

// —— M3-E2：WebM 轨级时长写在流标签 DURATION，有声 WebM 不再被“视频轨时长不可读”拒绝 ——

it("M3-E2：音轨长于画面的有声 WebM 经 prepare→worker 真实拼接，原声按画面时段保留", async () => {
  const assets = await prepareToneAssets();
  const webmFile = path.join(assets.directory, "tone.webm");
  // 画面 2s、700Hz 音轨 3.2s：容器时长≈3.2s，画面时段 2s 只在视频轨标签里。
  await makeWebmToneClip(webmFile, "red", 2, 700, 3.2);
  const webmFacts = await probeVideoFile(webmFile);
  assert.equal(webmFacts.mimeType, "video/webm");
  assert.equal(webmFacts.hasAudio, true);
  assert.ok(Math.abs(webmFacts.durationMs - 3208) <= 40, `容器时长 ${webmFacts.durationMs}ms 应≈3208ms`);
  assert.ok(Math.abs(webmFacts.videoDurationMs - 2000) <= 40, `画面时长 ${webmFacts.videoDurationMs}ms 应取视频轨标签≈2000ms，不被较长音轨带偏`);
  const runtime = await buildRuntime(assets.directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "WebM 原声" }).conversation;
    const clipWebm = mediaRevision(runtime, conversation.id, readFileSync(webmFile), 3208);
    const clipX = mediaRevision(runtime, conversation.id, assets.clipX, 1200);
    // 准备阶段逐输入 ffprobe：修复前这份 WebM 在这里被“视频轨时长不可读”拒绝。
    const accepted = await acceptIntent(runtime, conversation.id, orderedIntent([clipWebm, clipX], "preserve"));
    const result = await drive(runtime, accepted.runId);
    assert.equal(result.state, "succeeded");
    const file = await outputFileOf(runtime, result.id, workRootOf(assets.directory));
    const facts = await probeVideoFile(file);
    await outputAudioSpec(file);
    // 时间线按画面时段 2s+1.2s，3.2s 的音轨裁在画面边界，不拖长成片也不渗进下一段。
    assert.ok(Math.abs(facts.durationMs - 3200) <= 250, `成片时长 ${facts.durationMs}ms 应≈3200ms`);
    assert.ok(await bandVolumeDb(file, 0.1, 0.9, 700) > -35, "WebM 段应保留 700Hz 原声");
    assert.ok(await bandVolumeDb(file, 2.3, 0.6, 440) > -35, "后段 MP4 的 440Hz 应在自己的窗口");
    assert.ok(await bandVolumeDb(file, 2.3, 0.6, 700) < -50, "WebM 的过长音轨不得渗进后段窗口");
  } finally { await runtime.close(); await rm(assets.directory, { recursive: true, force: true }); }
});
