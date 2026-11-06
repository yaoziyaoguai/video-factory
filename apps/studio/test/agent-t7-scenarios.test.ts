import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { ArkMediaPort, RealMediaGateway } from "../src/server/agent/ark-media.js";
import { OpenAISpeechPort } from "../src/server/agent/openai-speech.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import {
  narratedRenderCatalogEntry, renderCatalogEntry, openaiSpeechBinding, openaiSpeechProfile,
} from "../src/server/agent/media-config.js";
import {
  additionalMediaCatalog, insertAdditionalMediaVersion, readAdditionalMediaCurrent, resolveOpenAISpeechBinding,
} from "../src/server/agent/additional-media-settings.js";
import { probeVideoFile } from "../src/server/agent/media-probe.js";
import {
  defaultTextBindingOf, initializeTextModelSettings, textRegistrationOf,
} from "../src/server/agent/text-model-settings.js";
import { readProviderConnections, saveProviderConnection } from "../src/server/agent/provider-connections.js";
import { attemptsFor, runRow, specFor } from "../src/server/agent/production-store.js";
import { canonicalJson, digestOf, newAgentId } from "../src/server/agent/util.js";
import { bindPreparedPlan, seedPlanStageWork } from "./helpers/creative-work-fixture.js";
import { toolIntentOf } from "./helpers/tool-args.js";
import { FakeRealtimeHub } from "./helpers/agent-openai-media.js";
import type { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import type { MediaExecutionPort } from "../src/shared/agent/ports.js";
import type { ConnectionModel, ModelBinding, ProviderConnection, ProductionIntent, Proposal, RenderParameters, Run } from "../src/shared/agent/generated/contracts.js";

// T7 综合场景服务级验收（§11 T7-01/03/04/05/06）：Skill 三种选择形态、四条端到端场景。
// 全程本地：faux 文本宿主与本地拼接目录；场景③用本地 SSE 桩走真实 Pi 链。
// 不以此声明真实模型选择质量（外部未验证），只验收产品规则与数据一致性。

const run = promisify(execFile);
let sequence = 0;
const cmd = () => `t7-${++sequence}`;
const staticClock = () => "2026-10-28T00:00:00.000Z";

const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
  name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
  verificationNote: "离线 Faux 文本", isDefault: true };

const LOCAL_CATALOG = () => ({ "render:ordered_concat": renderCatalogEntry(true), "render:narrated_concat": narratedRenderCatalogEntry() });
const workRootOf = (directory: string) => path.join(directory, "media-work");

async function buildScenarioRuntime(directory: string, ffmpegPath?: string): Promise<AgentRuntime> {
  return createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    media: { autoStart: false, factory: (db, blobs) => ({
      port: new LocalRenderPort(db, blobs, staticClock, { workRoot: workRootOf(directory), ...(ffmpegPath ? { ffmpegPath } : {}) }),
      catalog: LOCAL_CATALOG, models: () => [],
    }) },
  });
}

async function makeClip(file: string, seconds: number): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=red:s=1280x720:r=24:d=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
}

async function makeMp3(file: string, seconds: number): Promise<void> {
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-ar", "32000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", file]);
}

interface Ref { artifactId: string; revisionId: string; digest: string }

function mediaRevision(runtime: AgentRuntime, conversationId: string, buffer: Buffer, mimeType: "video/mp4" | "audio/mpeg", durationMs: number): Ref {
  const blob = runtime.production!.blobs.persist("local-owner", conversationId, buffer, mimeType, durationMs);
  const content = { format: "media", blobId: blob.id, mimeType, durationMs };
  const artifactId = newAgentId("art"), revisionId = newAgentId("rev"), now = staticClock();
  const db = runtime.database;
  db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,1,?,?,?)")
    .run(artifactId, conversationId, "local-owner", mimeType.startsWith("audio/") ? "配音片段" : "素材片段",
      mimeType.startsWith("audio/") ? "audio" : "video", revisionId,
      (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM artifacts WHERE conversation_id=?").get(conversationId) as { n: number }).n, now, now);
  db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,run_id,digest,content_json,created_at) VALUES(?,?,1,NULL,?,?,?)")
    .run(revisionId, artifactId, digestOf(content), canonicalJson(content), now);
  db.prepare("UPDATE artifacts SET head_revision_id=? WHERE id=?").run(revisionId, artifactId);
  return { artifactId, revisionId, digest: digestOf(content) };
}

async function sendChat(runtime: AgentRuntime, conversationId: string, text: string, overrides: Record<string, unknown> = {}) {
  const receipt = await runtime.service.sendMessage("local-owner", conversationId, {
    commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, ...overrides,
  });
  for (let i = 0; i < 200 && runtime.service.snapshot("local-owner", conversationId).activeRequestId; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(runtime.service.snapshot("local-owner", conversationId).activeRequestId, null, "请求应自然结束（停留，不自动开下一批）");
  return receipt;
}

const countOf = (runtime: AgentRuntime, table: string) =>
  (runtime.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const terminal = (state: Run["state"]) => state === "succeeded" || state === "failed" || state === "cancelled";
async function drive(runtime: AgentRuntime, runId: string, cap = 24): Promise<Run> {
  for (let i = 0; i < cap; i++) {
    await runtime.worker!.pollOnce();
    if (terminal(runtime.service.getRun("local-owner", runId).state)) break;
  }
  return runtime.service.getRun("local-owner", runId);
}

// —— T7-01：Skill 三种选择形态 ——

it("T7-01：显式点名/未点名时工具加载 Skill；非视频闲聊不强制套用", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t7-skill-"));
  const runtime = await buildScenarioRuntime(directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "Skill 选择" }).conversation;
    let sawExpansion = "";
    runtime.host.faux?.setResponses([context => {
      sawExpansion = JSON.stringify(context.messages.filter(message => message.role === "user" || message.role === "system"));
      return fauxAssistantMessage("按 kit 结构给了三段文案。");
    }]);
    await sendChat(runtime, conversation.id, "用 travel-prompt-kit 给我旅行脚本", { skillId: "travel-prompt-kit" });
    assert.match(sawExpansion, /旅行短视频文案 Kit/, "显式点名应把技能正文注入本请求");
    // 替身代表模型判断适用后的工具动作；只证明加载路径，不冒充真实模型选择质量。
    const natural = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "自然适用" }).conversation;
    let skillReadback = "";
    runtime.host.faux?.setResponses([
      fauxAssistantMessage([fauxToolCall("read_skill_file", { path: "travel-prompt-kit/SKILL.md" })]),
      context => {
        skillReadback = JSON.stringify(context.messages.filter(message => message.role === "toolResult"));
        return fauxAssistantMessage("按旅行结构整理了三段文案。先给你看，不开始制作。");
      },
    ]);
    await sendChat(runtime, natural.id, "给我写一个旅行短视频的 prompt");
    assert.match(skillReadback, /旅行短视频文案 Kit/, "未点名时，Pi 可自行调用只读工具加载适用技能");
    assert.equal(runtime.service.snapshot("local-owner", natural.id).runs.items.length, 0);
    // 非视频闲聊：没有 skillId 时不展开；available_skills 候选仍在，模型可自然判断适用。
    // 用新会话避免第一次显式展开留在历史里。
    const casual = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "闲聊" }).conversation;
    let plainPrompt = "";
    runtime.host.faux?.setResponses([context => {
      plainPrompt = JSON.stringify(context.messages.filter(message => message.role === "user" || message.role === "system"));
      return fauxAssistantMessage("这个热点和旅行无关，聊了两句。");
    }]);
    await sendChat(runtime, casual.id, "最近有什么科技热点，随便聊聊");
    assert.doesNotMatch(plainPrompt, /用户没有明确要求时不要主动套用/, "非视频闲聊不得强制注入技能正文");
    assert.match(plainPrompt, /travel-prompt-kit/, "候选列表仍应可见，模型可自然选用");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

// —— T7-03 场景①：Prompt 留在普通聊天里，继续讨论也不登记作品 ——

it("T7-03 场景①：Prompt 与后续修改都是聊天答复，重启可读，不创建作品或制作", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t7-s1-"));
  let runtime = await buildScenarioRuntime(directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "热点与文案" }).conversation;
    runtime.host.faux?.setResponses([
      fauxAssistantMessage("Prompt：清晨沿山路行进的固定镜头，缓慢推近。"),
      fauxAssistantMessage("Prompt：黄昏沿山路行进的固定镜头，缓慢推近。"),
    ]);
    await sendChat(runtime, conversation.id, "给我一条山路视频的 Prompt，先不制作");
    await sendChat(runtime, conversation.id, "换成黄昏呢？");
    await runtime.close();
    runtime = await buildScenarioRuntime(directory);
    const snapshot = runtime.service.snapshot("local-owner", conversation.id);
    assert.equal(snapshot.artifacts.items.length, 0, "普通回复不登记为作品");
    assert.ok(snapshot.messages.items.some(message => message.role === "assistant" && message.text === "Prompt：清晨沿山路行进的固定镜头，缓慢推近。"));
    assert.ok(snapshot.messages.items.some(message => message.role === "assistant" && message.text === "Prompt：黄昏沿山路行进的固定镜头，缓慢推近。"));
    assert.equal(countOf(runtime, "proposals"), 0, "没有准备任何提案");
    assert.equal(countOf(runtime, "production_runs"), 0, "没有任何制作开始");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

// —— T7-04 场景②：同对话两个无关主题批量交付→定向改一份，另一份不动 ——

it("T7-04 场景②：一次批量交付两个主题，定向只改其中一份", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t7-s2-"));
  const runtime = await buildScenarioRuntime(directory);
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "两件事" }).conversation;
    runtime.host.faux?.setResponses([
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "山路文案", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } },
        { mode: "create", title: "咖啡文案", kind: "prompt", content: { format: "markdown", text: "手冲咖啡的特写与蒸汽。" } },
      ] })]),
      fauxAssistantMessage("两份都给你了。"),
    ]);
    await sendChat(runtime, conversation.id, "给我一条山路文案和一条咖啡文案");
    const items = runtime.service.snapshot("local-owner", conversation.id).artifacts.items;
    assert.equal(items.length, 2);
    const mountain = items.find(item => item.title === "山路文案")!;
    const coffee = items.find(item => item.title === "咖啡文案")!;
    assert.equal(mountain.revisionNumber, 1);
    assert.equal(coffee.revisionNumber, 1);
    // 定向修改山路文案：只动这一份。
    runtime.host.faux?.setResponses([
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "revise", artifactId: mountain.id, baseRevisionId: mountain.revisionId, title: "山路文案", kind: "prompt", content: { format: "markdown", text: "改成黄昏下山的固定镜头。" } },
      ] })]),
      fauxAssistantMessage("只改了山路那份。"),
    ]);
    await sendChat(runtime, conversation.id, "山路那份改成黄昏", { target: { artifactId: mountain.id, revisionId: mountain.revisionId, workId: null } });
    assert.equal(runtime.service.readArtifactHead("local-owner", mountain.id).revisionNumber, 2, "目标文案升到 v2");
    assert.equal(runtime.service.readArtifactHead("local-owner", coffee.id).revisionNumber, 1, "无关文案保持 v1 不动");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

// —— T7-06 场景④：素材→旁白提案→确认→有声成片→记录下一版意见，原运行不改 ——

// 场景④走完整图（speech+render）：配音供应商是进程内 Realtime 替身，音频由端口经真实 FFmpeg 转码。
it("T7-06 场景④：素材正式交付后下一请求准备有声提案，一次确认出有声成片，意见留给下一版", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t7-s4-"));
  await makeClip(path.join(directory, "clip.mp4"), 2);
  const hub = new FakeRealtimeHub({ audioSeconds: 1 });
  const workRoot = workRootOf(directory);
  const runtime = await createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    media: { autoStart: false, factory: (db, blobs: ProductionBlobs) => {
      // 桩地址版 profile 直接按统一连接保存的落库形状建版本与当前行（不触真实官方域）。
      const profile = openaiSpeechProfile("gpt-realtime-2.1-mini", "http://127.0.0.1:9/v1");
      const binding = openaiSpeechBinding(profile, newAgentId("conn"));
      insertAdditionalMediaVersion(db, staticClock(), "openai-speech", binding, profile, "t7-speech-key");
      db.prepare("INSERT INTO additional_media_settings(channel_id,revision,display_name,current_configuration_revision_id,updated_at) VALUES('openai-speech',0,?,?,?)")
        .run(`OpenAI 配音（${profile.modelId}）`, binding.configurationRevisionId, staticClock());
      const speechPort = new OpenAISpeechPort(db, blobs, staticClock, {
        resolve: item => resolveOpenAISpeechBinding(db, item), workRoot, transportFactory: hub.factory,
      });
      return {
        port: new RealMediaGateway(
          new LocalRenderPort(db, blobs, staticClock, { workRoot }),
          { resolveProviderPort: item => (resolveOpenAISpeechBinding(db, item) ? speechPort : null), clock: staticClock },
        ),
        catalog: () => ({ "render:ordered_concat": renderCatalogEntry(true), "render:narrated_concat": narratedRenderCatalogEntry(),
          ...additionalMediaCatalog(db, true) }),
        models: () => [],
      };
    } },
  });
  try {
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "有声短片" }).conversation;
    const material = mediaRevision(runtime, conversation.id, readFileSync(path.join(directory, "clip.mp4")), "video/mp4", 2000);
    // 第一条请求：整批正式交付旁白文本后结束（素材为已有媒体修订，无需重复交付）。
    runtime.host.faux?.setResponses([
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "旁白文本", kind: "prompt", content: { format: "markdown", text: "清晨的山脊铺满阳光。" } }] })]),
      fauxAssistantMessage("旁白文本已交付，等你下一条指示。"),
    ]);
    await sendChat(runtime, conversation.id, "用这段素材配旁白");
    assert.equal(countOf(runtime, "proposals"), 0, "交付关闭本请求，不暗中准备提案");
    // 第二条请求（用户明确要求）：准备 speech+render 有声提案。
    const planWork = seedPlanStageWork(runtime.database, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, "山脊晨光有声版");
    const specOf = (): ProductionIntent => {
      const artifacts = runtime.service.snapshot("local-owner", conversation.id).artifacts.items;
      const narrationArtifact = artifacts.find(item => item.title === "旁白文本")!;
      const narrationRevision = runtime.service.readRevision("local-owner", narrationArtifact.id, narrationArtifact.revisionId);
      const narration: Ref = { artifactId: narrationArtifact.id, revisionId: narrationArtifact.revisionId, digest: narrationRevision.digest };
      const speechBinding = JSON.parse(readAdditionalMediaCurrent(runtime.database, "openai-speech")!.version.binding_json) as ModelBinding;
      const inputs = [{ kind: "artifact_revision" as const, artifactId: material.artifactId, revisionId: material.revisionId, digest: material.digest },
        { kind: "operation_output" as const, producerOperationId: "speech-1", outputSlot: "speech-1" }] as ProductionIntent["operations"][number]["inputs"];
      const parameters: Extract<RenderParameters, { assembly: "narrated_concat" }> = { assembly: "narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24, videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" };
      return { workId: planWork.workId, title: "山脊晨光有声版",
        inputRevisions: [material, narration].map(ref => ({ artifactId: ref.artifactId, revisionId: ref.revisionId })) as unknown as ProductionIntent["inputRevisions"],
        operations: [
          { operationId: "speech-1", outputSlot: "speech-1", kind: "speech", model: speechBinding,
            inputs: [{ kind: "artifact_revision", artifactId: narration.artifactId, revisionId: narration.revisionId, digest: narration.digest }],
            maxCreateAttempts: 1 as const, parameters: { voiceId: "marin", format: "mp3" } },
          { operationId: "render", outputSlot: "final", kind: "render" as const, model: null, inputs, maxCreateAttempts: 1 as const, parameters },
        ],
        finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 40 } };
    };
    runtime.host.faux?.setResponses([
      () => fauxAssistantMessage([fauxToolCall("prepare_production", { spec: JSON.parse(JSON.stringify(toolIntentOf(specOf()))) })]),
      fauxAssistantMessage("有声提案已就绪，请确认。"),
    ]);
    await sendChat(runtime, conversation.id, "按刚才的交付准备有声提案");
    const proposalRow = runtime.database.prepare("SELECT id, digest FROM proposals").get() as { id: string; digest: string };
    const proposal = (await runtime.service.readProposal("local-owner", proposalRow.id)) as Proposal;
    assert.equal(proposal.state, "ready");
    assert.match(proposal.priceDisclosure, /使用旁白替换原声/);
    bindPreparedPlan(runtime.database, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, proposal, planWork);
    // 第三条请求：用户确认 → 后台制作有声成片。
    runtime.host.faux?.setResponses([fauxAssistantMessage("已开始制作。")]);
    const confirmed = await sendChat(runtime, conversation.id, "确认制作", { proposalRef: { proposalId: proposal.id, digest: proposal.digest } });
    assert.ok(confirmed.receipt.runId, "确认受理进入制作");
    const result = await drive(runtime, confirmed.receipt.runId!);
    assert.equal(result.state, "succeeded");
    assert.equal(result.outputRevisions.length, 2, "配音与成片各一个产出");
    assert.equal(hub.sessions.length, 1, "配音通道恰好一次 Realtime 会话");
    const output = result.outputRevisions.at(-1)!;
    const revision = runtime.service.readRevision("local-owner", output.artifactId, output.revisionId);
    assert.equal(revision.content.format, "media");
    const attempt = attemptsFor(runtime.database, confirmed.receipt.runId!).find(row => row.operation_id === "render")!;
    const file = path.join(workRoot, attempt.id, "output.mp4");
    const facts = await probeVideoFile(file);
    assert.equal(facts.hasAudio, true, "成片含旁白音轨");
    assert.ok(Math.abs(facts.durationMs - 2000) <= 250, "preserve_all：成片时长=画面 2s");
    // 意见留给下一版：成片完成后的反馈只记录，不改原运行与产出（制作中的反馈才占用 next_version 锁定期）。
    const feedback = runtime.service.addFeedback("local-owner", conversation.id, {
      commandId: cmd(), target: { artifactId: output.artifactId, revisionId: output.revisionId, workId: null }, text: "下一版节奏更紧凑" });
    assert.equal(feedback.receipt.disposition, "noted", "意见被记录为下一版参考");
    assert.equal(runtime.service.getRun("local-owner", confirmed.receipt.runId!).state, "succeeded", "原运行状态不变");
    assert.equal(runtime.service.readArtifactHead("local-owner", output.artifactId).revisionNumber, 1, "已确认产出不被就地修改");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

// —— T7-05 场景③：生成中聊热点/切文本默认→旧制作原绑定，新的聊天换模型 ——

interface TextStub { server: http.Server; baseUrl: string }

// OpenAI Responses 协议替身：真实 Pi SDK → OpenAI 官方 client → 本地 SSE。
function responsesSse(text: string): string {
  const events = [
    { type: "response.created", response: { id: "resp_stub" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_stub", status: "completed", usage: { input_tokens: 24, output_tokens: 6 } } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function startTextStub(): Promise<TextStub> {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.end(responsesSse("收到，聊点别的也行。"));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1` }));
  });
}

it("T7-05 场景③：制作进行中另聊热点并切默认模型，旧制作仍原绑定完成", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-t7-s3-"));
  await makeClip(path.join(directory, "clip.mp4"), 1.2);
  const startedFile = path.join(directory, "started");
  const continueFile = path.join(directory, "continue");
  const [startedArg, continueArg] = [startedFile, continueFile].map(file => `'${file.replaceAll("'", "'\\''")}'`);
  const wrapper = path.join(directory, "slow-ffmpeg.sh");
  writeFileSync(wrapper, `#!/bin/sh\nprintf 'started\\n' > ${startedArg}\nwhile [ ! -f ${continueArg} ]; do sleep 0.02; done\nexec ffmpeg "$@"\n`);
  chmodSync(wrapper, 0o755);
  const stub = await startTextStub();
  const runtime = await createAgentRuntime({
    providerConnections: true, importedSettings: [],
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: {}, models: [], defaultModelId: "unconfigured", clock: staticClock,
    text: { factory: async db => {
      initializeTextModelSettings(db, staticClock);
      return {
        models: () => [],
        defaultBinding: () => defaultTextBindingOf(db),
        resolve: binding => {
          const registration = textRegistrationOf(db, binding);
          return registration ? { ...registration, baseUrl: stub.baseUrl } : null;
        },
      };
    } },
    media: { autoStart: false, factory: (db, blobs: ProductionBlobs) => ({
      port: new LocalRenderPort(db, blobs, staticClock, { workRoot: workRootOf(directory), ffmpegPath: wrapper }),
      catalog: LOCAL_CATALOG, models: () => [],
    }) },
  });
  let pending: Promise<void> | undefined;
  try {
    // 单一 OpenAI 连接承载两个文本型号（A 默认、B 备用）；resolver 内部改道到本地 Responses SSE 桩（真实 Pi 链）。
    const db = runtime.database;
    const connectionId = newAgentId("provider");
    const textModel = (id: string, modelId: string, isDefault: boolean): ConnectionModel => ({
      id, kind: "text", name: modelId, modelId, features: ["对话"], contextWindowTokens: 272_000, maxOutputTokens: 16_384,
      enabled: true, isDefault, baseUrl: null, thinkingLevel: "default",
    });
    const saveConnection = (models: ConnectionModel[]) => {
      const state = readProviderConnections(db);
      const connection: ProviderConnection = { id: connectionId, name: "OpenAI 文本", protocol: "openai",
        baseUrl: "https://api.openai.com/v1", apiKey: "sk-key-t7", enabled: true, models };
      return saveProviderConnection(db, staticClock, "local-owner",
        { commandId: cmd(), expectedRevision: state.revision, connection });
    };
    saveConnection([textModel("model-a", "gpt-6.1-sol", true), textModel("model-b", "gpt-6-luna", false)]);
    // 制作：无声拼接在后台执行（慢包装让执行可观察）。
    const conversation = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "制作与切换" }).conversation;
    const material = mediaRevision(runtime, conversation.id, readFileSync(path.join(directory, "clip.mp4")), "video/mp4", 1200);
    const planWork = seedPlanStageWork(db, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, "后台拼接");
    const intent: ProductionIntent = { workId: planWork.workId, title: "后台拼接",
      inputRevisions: [{ artifactId: material.artifactId, revisionId: material.revisionId }] as unknown as ProductionIntent["inputRevisions"],
      operations: [{ operationId: "render", outputSlot: "final", kind: "render", model: null,
        inputs: [{ kind: "artifact_revision", artifactId: material.artifactId, revisionId: material.revisionId, digest: material.digest }],
        maxCreateAttempts: 1, parameters: { assembly: "ordered_concat", format: "mp4", width: 1280, height: 720, fps: 24 } }],
      finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
    const { proposal } = await runtime.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: intent });
    bindPreparedPlan(db, staticClock(), { ownerId: "local-owner", conversationId: conversation.id }, proposal, planWork);
    const admitted = runtime.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    pending = runtime.worker!.pollOnce();
    for (let i = 0; i < 500 && !existsSync(startedFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(startedFile), true, "制作子进程已启动");
    const snapshotDigest = () => (db.prepare("SELECT digest FROM production_snapshots WHERE id=?").get(admitted.run.snapshotId) as { digest: string }).digest;
    const digestBefore = snapshotDigest();
    // 制作进行中聊热点：真实 Pi 请求走默认 A。
    const chatA = await sendChat(runtime, conversation.id, "聊聊最近的科技热点");
    const bindingA = JSON.parse((db.prepare("SELECT model_binding_json FROM requests WHERE id=?").get(chatA.receipt.requestId) as { model_binding_json: string }).model_binding_json) as ModelBinding;
    assert.equal(bindingA.modelId, "gpt-6.1-sol", "热点聊天按当前默认 A 冻结");
    // 切默认到 B：旧制作不受影响，新聊天换模型。
    saveConnection([textModel("model-a", "gpt-6.1-sol", false), textModel("model-b", "gpt-6-luna", true)]);
    const chatB = await sendChat(runtime, conversation.id, "再聊点别的");
    const bindingB = JSON.parse((db.prepare("SELECT model_binding_json FROM requests WHERE id=?").get(chatB.receipt.requestId) as { model_binding_json: string }).model_binding_json) as ModelBinding;
    assert.equal(bindingB.modelId, "gpt-6-luna", "切换后的新聊天按新默认 B 冻结");
    assert.equal(terminal(runtime.service.getRun("local-owner", admitted.run.id).state), false, "两次聊天均发生在制作期间");
    writeFileSync(continueFile, "continue");
    await pending;
    const result = await drive(runtime, admitted.run.id, 2);
    assert.equal(result.state, "succeeded", "旧制作按原快照完成，不受默认切换影响");
    assert.equal(snapshotDigest(), digestBefore, "快照摘要不变（原绑定未动）");
    assert.equal(specFor(db, runRow(db, admitted.run.id)).operations.length, 1);
  } finally { writeFileSync(continueFile, "continue"); await pending; await runtime.close(); stub.server.close(); await rm(directory, { recursive: true, force: true }); }
});
