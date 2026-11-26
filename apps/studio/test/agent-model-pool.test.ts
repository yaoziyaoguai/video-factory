import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type JsonValue,
} from "@earendil-works/pi-ai";
import { createAgentRuntime } from "../src/server/agent/assembly.js";
import { buildFrameApp } from "../src/server/agent/app.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { RealMediaGateway } from "../src/server/agent/ark-media.js";
import {
  EDGE_SPEECH_BINDING,
  EdgeSpeechPort,
  isEdgeSpeechBinding,
} from "../src/server/agent/edge-speech.js";
import { initializeArkVideoSettings, resolveArkBinding } from "../src/server/agent/ark-video-settings.js";
import {
  resolveColabVideoBinding,
  resolveImageBinding,
  resolveMinimaxSpeechBinding,
} from "../src/server/agent/additional-media-settings.js";
import {
  connectedMediaPool,
  readProviderConnections,
  saveProviderConnection,
} from "../src/server/agent/provider-connections.js";
import { saveEdgeTtsServiceSettings } from "../src/server/agent/free-service-settings.js";
import { PortObservations, withZeroCostBilling } from "../src/server/agent/media-port-support.js";
import { attemptOutput, recordAttemptOutput, runRow } from "../src/server/agent/production-store.js";
import { consumeSubmitPermit } from "../src/server/agent/submit-permit.js";
import { finalVideoTarget, seedConfirmedWork } from "./helpers/creative-work-fixture.js";
import type {
  AdmissionReceipt,
  ArtifactRevision,
  ExecutionInput,
  ExecutionObservation,
  InputRef,
  ModelBinding,
  Proposal,
  ProviderConnection,
  RecoveryQuery,
  Run,
  SubtitleTrack,
  ToolOperationRequest,
  ToolProductionIntent,
} from "../src/shared/agent/generated/contracts.js";
import type { MediaExecutionPort, SubmitPermit } from "../src/shared/agent/ports.js";
import type { AgentDatabase } from "../src/server/agent/db.js";
import type { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import type { AgentClock } from "../src/server/agent/util.js";

const execFileAsync = promisify(execFile);
const asJsonArgs = <T>(value: T): Record<string, JsonValue> =>
  JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;

async function makeSilentMp4(dest: string): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=darkslateblue:s=1280x720:r=24:d=5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=5",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    dest,
  ]);
}

async function makeFirstFramePng(dest: string): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=navy:s=1280x720:d=1",
    "-frames:v",
    "1",
    dest,
  ]);
}

async function makeSampleMp3(dest: string): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.6",
    "-c:a",
    "libmp3lame",
    "-f",
    "mp3",
    dest,
  ]);
}

interface RecordedSubmission {
  channel: string;
  attemptId: string;
  operationId: string;
  binding: ModelBinding;
  apiKey: string | null;
  voiceId?: string;
}

class DeterministicVideoStubPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly observations: PortObservations;

  constructor(
    private readonly channelName: string,
    private readonly db: AgentDatabase,
    private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock,
    private readonly sampleMp4Path: string,
    private readonly resolveApiKey: (binding: ModelBinding) => string | null,
    private readonly submissions: RecordedSubmission[],
  ) {
    this.observations = new PortObservations(db, clock, channelName);
  }

  async submit(input: ExecutionInput, permit: SubmitPermit): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    const model = input.operation.model;
    const apiKey = model ? this.resolveApiKey(model) : null;
    if (!model || !apiKey) {
      return withZeroCostBilling(
        this.observations.deterministic(input.attemptId, "failed", null, `${this.channelName} 缺少有效凭据`),
      );
    }
    this.submissions.push({
      channel: this.channelName,
      attemptId: input.attemptId,
      operationId: input.operation.operationId,
      binding: model,
      apiKey,
    });
    const run = runRow(this.db, input.runId);
    const staged = path.join(path.dirname(this.sampleMp4Path), `out-${input.attemptId}.mp4`);
    copyFileSync(this.sampleMp4Path, staged);
    const stored = await this.blobs.persistFromFileAsync(run.owner_id, run.conversation_id, staged, "video/mp4", 5000);
    this.db.transaction(() =>
      recordAttemptOutput(this.db, this.clock(), input.attemptId, {
        blobId: stored.id,
        digest: stored.digest,
        exitKind: "completed",
        detail: `${this.channelName} 本地桩完成`,
        usage: { width: 1280, height: 720, mediaDurationMs: 5000 },
      }),
    )();
    return withZeroCostBilling(
      this.observations.deterministicSucceeded(
        input.attemptId,
        `stub-${this.channelName}-${input.attemptId}`,
        stored.id,
        stored.digest,
        "video/mp4",
        `${this.channelName} 本地桩完成`,
      ),
    );
  }

  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    const receipt = attemptOutput(this.db, query.attemptId);
    if (receipt?.blob_id && receipt.digest) {
      return withZeroCostBilling(
        this.observations.deterministicSucceeded(
          query.attemptId,
          `stub-${this.channelName}-${query.attemptId}`,
          receipt.blob_id,
          receipt.digest,
          "video/mp4",
          receipt.detail ?? "已恢复",
        ),
      );
    }
    return this.observations.stableUnknown(query.attemptId, "本地桩无远端查询");
  }

  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    return this.query(query);
  }
}

async function createPoolFixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "vf-model-pool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sampleMp4 = path.join(dir, "fixtures", "sample-720p.mp4");
  const firstFramePng = path.join(dir, "fixtures", "first-frame.png");
  const sampleMp3 = path.join(dir, "fixtures", "sample-speech.mp3");
  await Promise.all([makeSilentMp4(sampleMp4), makeFirstFramePng(firstFramePng), makeSampleMp3(sampleMp3)]);

  let nowMs = Date.parse("2026-11-26T04:00:00.000Z");
  const clock = () => {
    nowMs += 100;
    return new Date(nowMs).toISOString();
  };
  const renderFacts = { available: true, probeAvailable: true, aacAvailable: true, reason: "" };
  const workRoot = path.join(dir, "media-work");
  const submissions: RecordedSubmission[] = [];
  let edgeDriverCalls = 0;

  const runtime = await createAgentRuntime({
    dataDir: dir,
    skillsRoot: defaultSkillsRoot,
    providerConnections: true,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [
      {
        binding: {
          providerId: FAUX_PROVIDER,
          modelId: FAUX_TEXT_MODEL,
          connectionId: "offline-fixture",
          configurationRevisionId: "pool-faux-text",
        },
        name: "Faux 创作文本模型",
        kind: "text",
        features: [],
        availability: "configured",
        verificationNote: "离线文本替身（0 外部调用）",
        isDefault: true,
      },
    ],
    defaultModelId: FAUX_TEXT_MODEL,
    clock,
    media: {
      pollMs: 25,
      factory: (db, blobs) => {
        initializeArkVideoSettings(db, { clock });
        const arkStub = new DeterministicVideoStubPort(
          "ark",
          db,
          blobs,
          clock,
          sampleMp4,
          binding => resolveArkBinding(db, binding)?.apiKey ?? null,
          submissions,
        );
        const colabStub = new DeterministicVideoStubPort(
          "colab",
          db,
          blobs,
          clock,
          sampleMp4,
          binding => resolveColabVideoBinding(db, binding)?.apiKey ?? null,
          submissions,
        );
        const edgePort = new EdgeSpeechPort(db, blobs, clock, {
          workRoot,
          runner: async (outputFile, payload) => {
            edgeDriverCalls += 1;
            submissions.push({
              channel: "edge-tts",
              attemptId: path.basename(path.dirname(outputFile)),
              operationId: "speech",
              binding: EDGE_SPEECH_BINDING,
              apiKey: "free",
              voiceId: payload.voice,
            });
            copyFileSync(sampleMp3, outputFile);
            return {
              boundaries: [
                { text: "帧工坊", offsetMs: 0, durationMs: 280 },
                { text: "模型池", offsetMs: 280, durationMs: 280 },
              ],
            };
          },
        });
        return {
          requireSpeechConfirmation: true,
          port: new RealMediaGateway(new LocalRenderPort(db, blobs, clock, { workRoot }), {
            resolveProviderPort: binding => {
              if (isEdgeSpeechBinding(binding)) return edgePort;
              if (resolveColabVideoBinding(db, binding)) return colabStub;
              if (resolveArkBinding(db, binding)) return arkStub;
              return null;
            },
            clock,
          }),
          catalog: () => connectedMediaPool(db, renderFacts).catalog,
          models: () => connectedMediaPool(db, renderFacts).models,
        };
      },
    },
  });

  const app = buildFrameApp({
    logger: false,
    agent: {
      service: runtime.service,
      resolveOwner: () => "local-owner",
      localOwnerOnly: true,
      uiOrigin: "http://127.0.0.1:4318",
    },
  });
  t.after(async () => {
    await app.close();
    await runtime.close();
  });

  const writeHeaders = {
    origin: "http://127.0.0.1:4318",
    "x-video-factory-request": "studio",
    "content-type": "application/json",
  };

  const saveConn = async (connection: ProviderConnection) => {
    const rev = readProviderConnections(runtime.database).revision;
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/v1/settings/model-connections",
      headers: writeHeaders,
      payload: {
        commandId: `save-${connection.id}-${rev}`,
        expectedRevision: rev,
        connection,
      },
    });
    assert.equal(res.statusCode, 200, `saveConn failed: ${res.body}`);
    return res.json();
  };

  const saveEdge = async (
    commandId: string,
    expectedRevision: number,
    enabled: boolean,
    voice: string,
    isDefault?: boolean,
  ) => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/agent/v1/settings/services/edge-tts",
      headers: writeHeaders,
      payload: {
        commandId,
        expectedRevision,
        enabled,
        voice,
        ...(typeof isDefault === "boolean" ? { isDefault } : {}),
      },
    });
    assert.equal(res.statusCode, 200, `saveEdge failed: ${res.body}`);
    return res.json();
  };

  const createConv = async (commandId: string, title: string): Promise<{ id: string; revision: number }> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/v1/conversations",
      headers: writeHeaders,
      payload: { commandId, title },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json() as { conversation?: { id: string; revision: number }; id?: string; revision?: number };
    return (body.conversation ?? body) as { id: string; revision: number };
  };

  const sendChatAndWait = async (
    conversationId: string,
    commandId: string,
    text: string,
    target: { kind: "artifact_revision"; artifactId: string; revisionId: string } | null = null,
  ) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${conversationId}/messages`,
      headers: writeHeaders,
      payload: {
        commandId,
        text,
        target,
        skillId: null,
        proposalRef: null,
        mode: "new",
        steerRequestId: null,
      },
    });
    assert.equal(res.statusCode, 202);
    const requestId = (res.json() as { requestId: string }).requestId;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const snap = runtime.service.snapshot("local-owner", conversationId);
      const reqRow = runtime.database.prepare("SELECT state FROM requests WHERE id = ?").get(requestId) as
        | { state: string }
        | undefined;
      if (snap.activeRequestId === null && reqRow && reqRow.state !== "queued" && reqRow.state !== "running") {
        return snap;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("等待对话回合超时");
  };

  const waitForRun = async (runId: string): Promise<Run> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await app.inject({ method: "GET", url: `/api/agent/v1/runs/${runId}` });
      assert.equal(res.statusCode, 200);
      const run = res.json() as Run;
      if (run.state === "succeeded" || run.state === "failed" || run.state === "cancelled") {
        return run;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`等待制作运行 ${runId} 超时`);
  };

  return {
    dir,
    runtime,
    app,
    clock,
    writeHeaders,
    firstFramePng,
    submissions,
    getEdgeDriverCalls: () => edgeDriverCalls,
    saveConn,
    saveEdge,
    createConv,
    sendChatAndWait,
    waitForRun,
  };
}

describe("Model Pool, Deterministic Rebind, Multi-Account Routing & Free Speech Gate (0 CU)", () => {
  it("MP-01/02 纯文本对话直用默认且零媒体确认打断；多活模型池与通用 video-generation 技能并存", async (t: TestContext) => {
    const fx = await createPoolFixture(t);

    await fx.saveConn({
      id: "conn-ark-main",
      name: "火山引擎主账号",
      protocol: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-main-key",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-ark-seedance",
          kind: "video",
          name: "Seedance 2.5",
          modelId: "doubao-seedance-2-5-260628",
          features: ["有声视频"],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: true,
        },
        {
          id: "m-ark-seedream",
          kind: "image",
          name: "Seedream 5.0 Flash",
          modelId: "doubao-seedream-5-0-flash-260915",
          features: ["分镜首帧"],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: true,
        },
      ],
    });
    await fx.saveConn({
      id: "conn-colab-pool",
      name: "Google Colab 算力池",
      protocol: "colab",
      baseUrl: "https://colab.research.google.com",
      apiKey: "hf_synthetic_token",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-colab-ltx",
          kind: "video",
          name: "LTX-2.5 Distilled",
          modelId: "Lightricks/LTX-2.5-distilled",
          features: ["首帧生视频", "Colab CU"],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: false,
        },
      ],
    });
    await fx.saveConn({
      id: "conn-mm-pool",
      name: "MiniMax 语音",
      protocol: "minimax",
      baseUrl: "https://api.minimax.cn",
      apiKey: "mm-key-pool",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-mm-speech",
          kind: "speech",
          name: "Speech 2.8 Turbo",
          modelId: "speech-2.8-turbo",
          features: ["多音色"],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: true,
        },
      ],
    });
    await fx.saveEdge("enable-edge-mp01", 0, true, "zh-CN-YunxiNeural");

    const boot = fx.runtime.service.bootstrap("local-owner");
    const skillIds = boot.skills.map(s => s.id);
    assert.ok(skillIds.includes("video-generation"), "内置通用 video-generation 技能可见");
    assert.ok(skillIds.includes("colab-ltx-video"), "原有 colab-ltx-video 专项技能完整保留");

    const videoPool = boot.models.filter(m => m.kind === "video");
    assert.equal(videoPool.length, 2, "视频模型池同时暴露火山默认与 Colab 备选");
    assert.equal(videoPool.find(m => m.binding.providerId === "ark")?.isDefault, true);
    assert.equal(videoPool.find(m => m.binding.providerId === "colab")?.isDefault, false);
    assert.equal(videoPool.find(m => m.binding.providerId === "colab")?.externalUnit, "colab_cu");

    const speechPool = boot.models.filter(m => m.kind === "speech");
    assert.equal(speechPool.length, 2, "配音模型池同时暴露付费默认与 Edge 免费配音");
    const edgeView = speechPool.find(m => m.binding.providerId === "edge-tts")!;
    assert.equal(edgeView.isDefault, false);
    assert.equal(edgeView.defaultVoiceId, "zh-CN-YunxiNeural");
    assert.ok((edgeView.voices?.length ?? 0) >= 4);

    // 纯文本对话：直接使用默认文本模型回复，零确认卡、零媒体调用
    fx.runtime.host.faux!.setResponses([fauxAssistantMessage("纯文本分镜构思已完成，未发起任何媒体生成。")]);
    const conv = await fx.createConv("conv-text-only", "纯文本构思");
    const snap = await fx.sendChatAndWait(conv.id, "msg-text-only", "先帮我想三句纪录片开场词，不要生成音视频");
    assert.equal(snap.proposals.items.length, 0, "纯文本回合不产生制作确认卡");
    assert.equal(fx.submissions.length, 0, "零媒体调用");
    assert.ok(resolveImageBinding(fx.runtime.database, boot.models.find(m => m.kind === "image")!.binding));
    assert.ok(resolveMinimaxSpeechBinding(fx.runtime.database, speechPool.find(m => m.binding.providerId === "minimax")!.binding));
  });

  it("MP-03 同 modelId 双账号连接独立绑定：换绑精确落到账号乙 Key，停用账号乙绝不静默回退账号甲", async (t: TestContext) => {
    const fx = await createPoolFixture(t);

    await fx.saveConn({
      id: "conn-ark-a",
      name: "火山账号甲",
      protocol: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-key-alpha",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-ark-a",
          kind: "video",
          name: "Seedance 2.5",
          modelId: "doubao-seedance-2-5-260628",
          features: [],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: true,
        },
      ],
    });
    await fx.saveConn({
      id: "conn-ark-b",
      name: "火山账号乙",
      protocol: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-key-beta",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-ark-b",
          kind: "video",
          name: "Seedance 2.5",
          modelId: "doubao-seedance-2-5-260628",
          features: [],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: false,
        },
      ],
    });

    const poolVideos = fx.runtime.service.bootstrap("local-owner").models.filter(m => m.kind === "video");
    assert.equal(poolVideos.length, 2, "同 modelId 两个连接在模型池中独立并存");
    const entryA = poolVideos.find(m => m.connectionName === "火山账号甲")!;
    const entryB = poolVideos.find(m => m.connectionName === "火山账号乙")!;
    assert.notEqual(
      entryA.binding.configurationRevisionId,
      entryB.binding.configurationRevisionId,
      "同 modelId 不同连接拥有独立 configurationRevisionId",
    );

    const conv = await fx.createConv("conv-dual", "双账号隔离");
    const seeded = seedConfirmedWork(fx.runtime.database, fx.clock(), { ownerId: "local-owner", conversationId: conv.id });

    const baseVideoOp: Extract<ToolOperationRequest, { kind: "video" }> = {
      operationId: "shot-1",
      outputSlot: "shot_1",
      kind: "video",
      model: entryA.binding,
      inputs: [{ kind: "text", text: "清晨海雾缓缓散开，镜头推向灯塔。" }],
      parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
    };

    const prepareSpec: ToolProductionIntent = {
      workId: seeded.workId,
      title: "单镜双账号核验",
      purpose: "production",
      scope: "生成 1 条 5 秒镜头",
      reviewInputs: [seeded.reviewInput],
      inputSources: [],
      operations: [baseVideoOp],
      finalOutput: { operationId: "shot-1", outputSlot: "shot_1" },
      outputTarget: finalVideoTarget("成片"),
      maxSpend: { currency: "CNY", amountMinor: 1000 },
    };

    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: prepareSpec }), { id: "tc-dual-1" })]),
      fauxAssistantMessage("提案已备好，默认使用火山账号甲。"),
    ]);
    const snap = await fx.sendChatAndWait(conv.id, "msg-dual-1", "生成灯塔镜头");
    const initialProposal = snap.proposals.items[0]!;
    assert.equal(
      "defaultsAtPrepare" in initialProposal.spec && initialProposal.spec.defaultsAtPrepare?.video?.configurationRevisionId,
      entryA.binding.configurationRevisionId,
    );

    // 用户在确认卡将 shot-1 换绑到同 modelId 的“火山账号乙”
    const rebindRes = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${initialProposal.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-to-account-b",
        expectedDigest: initialProposal.digest,
        changes: [{ operationId: "shot-1", model: entryB.binding }],
      },
    });
    assert.equal(rebindRes.statusCode, 200);
    const rebound = rebindRes.json() as Proposal;
    assert.notEqual(rebound.digest, initialProposal.digest);
    const opAfter = rebound.spec.operations[0]!;
    assert.equal(opAfter.kind !== "render" && opAfter.model.configurationRevisionId, entryB.binding.configurationRevisionId);
    assert.equal(
      "selectionSources" in rebound.spec && rebound.spec.selectionSources?.find(s => s.operationId === "shot-1")?.source,
      "card_selected",
    );

    // 确认前 0 次提交；确认后 Worker 精确携带账号乙 API Key 执行
    assert.equal(fx.submissions.length, 0);
    const acceptRes = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${rebound.id}/acceptances`,
      headers: fx.writeHeaders,
      payload: { commandId: "accept-account-b", proposalDigest: rebound.digest },
    });
    assert.equal(acceptRes.statusCode, 202);
    const admitted = acceptRes.json() as AdmissionReceipt;
    const completed = await fx.waitForRun(admitted.run.id);
    assert.equal(completed.state, "succeeded");
    assert.equal(fx.submissions.length, 1);
    assert.equal(fx.submissions[0]!.apiKey, "ark-key-beta", "精确使用账号乙凭据，不串号到账号甲");

    // 再建一张绑定到账号乙的未受理提案；随后停用账号乙 → 该提案必须转 stale，绝不静默回退到同 modelId 的账号甲
    const namedSpec: ToolProductionIntent = {
      ...prepareSpec,
      title: "待停用账号乙提案",
      operations: [
        {
          ...baseVideoOp,
          model: entryB.binding,
          modelSource: "user_named",
        },
      ],
    };
    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: namedSpec }), { id: "tc-dual-2" })]),
      fauxAssistantMessage("已按指定生成账号乙提案。"),
    ]);
    const snap2 = await fx.sendChatAndWait(conv.id, "msg-dual-2", "再用火山账号乙准备一条提案");
    const pendingB = snap2.proposals.items.find(p => p.id !== rebound.id)!;
    assert.equal(pendingB.state, "ready");

    const currentConnB = readProviderConnections(fx.runtime.database).connections.find(c => c.id === "conn-ark-b")!;
    await fx.saveConn({ ...currentConnB, enabled: false });
    const refreshedRes = await fx.app.inject({ method: "GET", url: `/api/agent/v1/proposals/${pendingB.id}` });
    assert.equal((refreshedRes.json() as Proposal).state, "stale", "停用账号乙后未受理提案转 stale，不按裸 modelId 回退账号甲");
  });

  it("MP-04 无默认类别与全局切默认隔离：未点名返回 MODEL_SELECTION_REQUIRED 阻断受理，卡片选模后放行，聊天点名直接可执行", async (t: TestContext) => {
    const fx = await createPoolFixture(t);

    await fx.saveConn({
      id: "conn-ark-nodef",
      name: "火山无默认池",
      protocol: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-nodef-key",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-ark-nodef",
          kind: "video",
          name: "Seedance 2.5",
          modelId: "doubao-seedance-2-5-260628",
          features: [],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: false,
        },
      ],
    });

    const arkModel = fx.runtime.service.bootstrap("local-owner").models.find(m => m.kind === "video")!;
    assert.equal(arkModel.isDefault, false);

    const conv = await fx.createConv("conv-nodef", "无默认选模");
    const seeded = seedConfirmedWork(fx.runtime.database, fx.clock(), { ownerId: "local-owner", conversationId: conv.id });

    const baseOp: Extract<ToolOperationRequest, { kind: "video" }> = {
      operationId: "shot-1",
      outputSlot: "shot_1",
      kind: "video",
      model: arkModel.binding,
      inputs: [{ kind: "text", text: "山谷晨雾。" }],
      parameters: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
    };

    // 1) 未设默认且对话未点名：生成带 MODEL_SELECTION_REQUIRED 阻断的待选模提案，拒绝直接 accept
    const unnamedSpec: ToolProductionIntent = {
      workId: seeded.workId,
      title: "未设默认待选镜头",
      purpose: "production",
      scope: "1 条 5 秒镜头",
      reviewInputs: [seeded.reviewInput],
      inputSources: [],
      operations: [baseOp],
      finalOutput: { operationId: "shot-1", outputSlot: "shot_1" },
      outputTarget: finalVideoTarget("成片"),
      maxSpend: { currency: "CNY", amountMinor: 1000 },
    };
    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: unnamedSpec }), { id: "tc-nodef-1" })]),
      fauxAssistantMessage("当前视频未设默认，请在卡片选择具体模型。"),
    ]);
    const snap1 = await fx.sendChatAndWait(conv.id, "msg-nodef-1", "帮我生成山谷晨雾视频");
    const blockedProposal = snap1.proposals.items[0]!;
    assert.equal(blockedProposal.acceptanceBlocker?.code, "MODEL_SELECTION_REQUIRED");

    const prematureAccept = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${blockedProposal.id}/acceptances`,
      headers: fx.writeHeaders,
      payload: { commandId: "accept-before-select", proposalDigest: blockedProposal.digest },
    });
    assert.equal(prematureAccept.statusCode >= 400, true, "未选定模型前严禁放行受理");
    assert.equal(fx.submissions.length, 0);

    // 用户在确认卡选定池内模型 → blocker 清除，产生新 digest
    const rebindRes = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${blockedProposal.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-select-nodef",
        expectedDigest: blockedProposal.digest,
        changes: [{ operationId: "shot-1", model: arkModel.binding }],
      },
    });
    assert.equal(rebindRes.statusCode, 200);
    const cleared = rebindRes.json() as Proposal;
    assert.equal(cleared.acceptanceBlocker, null, "选定模型后清除 MODEL_SELECTION_REQUIRED 阻断");

    // 2) 对话显式点名（modelSource: 'user_named'）：即使无全局默认也直接立即可确认
    const userNamedSpec: ToolProductionIntent = {
      ...unnamedSpec,
      title: "聊天显式点名提案",
      operations: [
        {
          ...baseOp,
          modelSource: "user_named",
        },
      ],
    };
    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: userNamedSpec }), { id: "tc-nodef-2" })]),
      fauxAssistantMessage("已按点名选用火山 Seedance 2.0。"),
    ]);
    const snap2 = await fx.sendChatAndWait(conv.id, "msg-nodef-2", "这次直接用火山无默认池的 Seedance 2.0 生成");
    const namedProposal = snap2.proposals.items.find(p => p.id !== cleared.id)!;
    assert.equal(namedProposal.acceptanceBlocker, null, "聊天点名池内模型无需二次选模即可确认");

    // 3) 另一窗口修改全局默认：只要型号仍在池内启用，已有 ready 提案不作废、冻结快照不篡改
    const savedConn = readProviderConnections(fx.runtime.database).connections[0]!;
    await fx.saveConn({ ...savedConn, models: savedConn.models.map(m => ({ ...m, isDefault: true })) });
    const afterSetRes = await fx.app.inject({ method: "GET", url: `/api/agent/v1/proposals/${cleared.id}` });
    const afterSetDefault = afterSetRes.json() as Proposal;
    assert.equal(afterSetDefault.state, "ready", "切换全局默认不作废池内已启用提案");
    assert.equal(afterSetDefault.digest, cleared.digest, "已有未受理提案 digest 与快照保持不变");

    // 4) [P1-2 回归] 已被 replacesProposal 替换撤销的旧提案（state='stale'，但绑定仍在池内可用）严禁经 /rebind 复活为 ready
    const replaceSpec: ToolProductionIntent = {
      ...userNamedSpec,
      title: "替换旧提案的新方案",
    };
    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([
        fauxToolCall(
          "prepare_production",
          asJsonArgs({
            spec: replaceSpec,
            replacesProposal: { proposalId: namedProposal.id, digest: namedProposal.digest },
          }),
          { id: "tc-nodef-replace" },
        ),
      ]),
      fauxAssistantMessage("已用新方案替换旧报价。"),
    ]);
    await fx.sendChatAndWait(conv.id, "msg-nodef-replace", "替换刚才那份提案");
    const revokedCheck = await fx.app.inject({ method: "GET", url: `/api/agent/v1/proposals/${namedProposal.id}` });
    assert.equal((revokedCheck.json() as Proposal).state, "stale");
    const reviveAttempt = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${namedProposal.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-try-revive-revoked",
        expectedDigest: namedProposal.digest,
        changes: [{ operationId: "shot-1", model: arkModel.binding }],
      },
    });
    assert.equal(reviveAttempt.statusCode, 409, "已被 replacesProposal 撤销的旧提案绝不允许通过 /rebind 复活");
  });

  it("MP-05 10 镜头单镜换绑 Colab LTX-2.5：确定性重算 CNY + Colab CU 披露、窄换绑防越权、旧 digest 拒绝与混合路由执行", async (t: TestContext) => {
    const fx = await createPoolFixture(t);

    await fx.saveConn({
      id: "conn-ark-10",
      name: "火山引擎",
      protocol: "ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-10-key",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-ark-10",
          kind: "video",
          name: "Seedance 2.5",
          modelId: "doubao-seedance-2-5-260628",
          features: [],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: true,
        },
      ],
    });
    await fx.saveConn({
      id: "conn-colab-10",
      name: "Google Colab",
      protocol: "colab",
      baseUrl: "https://colab.research.google.com",
      apiKey: "hf_10_key",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-colab-10",
          kind: "video",
          name: "LTX-2.5 Distilled",
          modelId: "Lightricks/LTX-2.5-distilled",
          features: ["首帧生视频", "Colab CU"],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: false,
        },
      ],
    });

    const pool = fx.runtime.service.bootstrap("local-owner").models;
    const arkEntry = pool.find(m => m.kind === "video" && m.binding.providerId === "ark")!;
    const colabEntry = pool.find(m => m.kind === "video" && m.binding.providerId === "colab")!;

    const conv = await fx.createConv("conv-10shot", "十镜单镜换绑");
    const seeded = seedConfirmedWork(fx.runtime.database, fx.clock(), { ownerId: "local-owner", conversationId: conv.id });

    // 通过真实 multipart 上传 1 张首帧图，仅供 shot-2 使用（shot-1 无首帧图，验证不兼容拦截）
    const boundary = "----PoolShot2Boundary12345";
    const pngBytes = readFileSync(fx.firstFramePng);
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="commandId"\r\n\r\nupload-shot2-frame\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n${conv.revision}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="rights"\r\n\r\nowned_or_licensed\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot2-frame.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      pngBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadRes = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/conversations/${conv.id}/uploads`,
      headers: {
        origin: "http://127.0.0.1:4318",
        "x-video-factory-request": "studio",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    });
    assert.equal(uploadRes.statusCode, 201);
    const ulBody = uploadRes.json() as { attachment: { source: { artifactId: string; revisionId: string } } };
    const revDigest = fx.runtime.database
      .prepare("SELECT digest FROM artifact_revisions WHERE id = ?")
      .pluck()
      .get(ulBody.attachment.source.revisionId) as string;
    const frameRef: InputRef = {
      kind: "artifact_revision",
      artifactId: ulBody.attachment.source.artifactId,
      revisionId: ulBody.attachment.source.revisionId,
      digest: revDigest,
    };

    const shotOps: Extract<ToolOperationRequest, { kind: "video" }>[] = Array.from({ length: 10 }, (_, idx) => {
      const n = idx + 1;
      const inputs: [InputRef, ...InputRef[]] =
        n === 2
          ? [frameRef, { kind: "text", text: `第 ${n} 镜画面动作` }]
          : [{ kind: "text", text: `第 ${n} 镜纯文本镜头` }];
      return {
        operationId: `shot-${n}`,
        outputSlot: `shot_${n}`,
        kind: "video",
        model: arkEntry.binding,
        inputs,
        parameters: {
          durationSeconds: 5,
          aspectRatio: "16:9",
          resolution: "720p",
          audioMode: "native",
          ...(n === 2 ? { firstFrameSlot: 0 } : {}),
        },
      };
    });

    const tenShotSpec: ToolProductionIntent = {
      workId: seeded.workId,
      title: "十镜头成片提案",
      purpose: "production",
      scope: "生成 10 条 5 秒镜头并拼接成片",
      reviewInputs: [seeded.reviewInput],
      inputSources: [frameRef],
      operations: [
        shotOps[0]!,
        ...shotOps.slice(1),
        {
          operationId: "final-concat",
          outputSlot: "final_video",
          kind: "render",
          model: null,
          inputs: shotOps.map(op => ({
            kind: "operation_output" as const,
            producerOperationId: op.operationId,
            outputSlot: op.outputSlot,
          })),
          parameters: {
            assembly: "ordered_concat",
            format: "mp4",
            width: 1280,
            height: 720,
            fps: 24,
          },
        },
      ],
      finalOutput: { operationId: "final-concat", outputSlot: "final_video" },
      outputTarget: finalVideoTarget("成片"),
      maxSpend: { currency: "CNY", amountMinor: 8000 },
    };

    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: tenShotSpec }), { id: "tc-10shot" })]),
      fauxAssistantMessage("十镜头方案已备好。"),
    ]);
    const snap = await fx.sendChatAndWait(conv.id, "msg-10shot", "生成十镜头成片");
    const original = snap.proposals.items[0]!;
    const originalMaxMinor = original.spec.maxSpend.amountMinor;
    assert.ok(originalMaxMinor > 0, "10 镜全用火山默认时人民币上限 > 0");

    // 试图把没有首帧图的 shot-1 换绑到 Colab LTX-2.5 → 必须被参数兼容校验拦截
    const invalidRebind = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${original.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-shot1-missing-frame",
        expectedDigest: original.digest,
        changes: [{ operationId: "shot-1", model: colabEntry.binding }],
      },
    });
    assert.equal(invalidRebind.statusCode >= 400, true);
    assert.match(JSON.stringify(invalidRebind.json()), /首帧/);

    // 仅将有首帧图的 shot-2 换绑到 Colab LTX-2.5
    const validRebind = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${original.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-shot2-colab",
        expectedDigest: original.digest,
        changes: [{ operationId: "shot-2", model: colabEntry.binding }],
      },
    });
    assert.equal(validRebind.statusCode, 200);
    const updated = validRebind.json() as Proposal;
    assert.notEqual(updated.digest, original.digest);
    const oneShotMinor =
      original.spec.operations[0]!.kind !== "render" ? original.spec.operations[0]!.quotePerAttempt.amountMinor : 0;
    assert.equal(
      updated.spec.maxSpend.amountMinor,
      oneShotMinor * 9,
      "人民币预算精确按 9 条火山镜头重算（Colab 镜头 ¥0.00）",
    );
    assert.match(updated.priceDisclosure, /计算单元（CU）/, "价格披露同时说明 Colab CU 消耗");
    assert.deepEqual(
      "outputTarget" in updated.spec ? updated.spec.outputTarget : null,
      "outputTarget" in original.spec ? original.spec.outputTarget : null,
      "窄换绑绝不篡改交付目标",
    );
    assert.deepEqual(
      "inputSources" in updated.spec ? updated.spec.inputSources : null,
      "inputSources" in original.spec ? original.spec.inputSources : null,
      "窄换绑绝不篡改输入源",
    );

    // 同一 commandId 重放幂等
    const replayRebind = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${original.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-shot2-colab",
        expectedDigest: original.digest,
        changes: [{ operationId: "shot-2", model: colabEntry.binding }],
      },
    });
    assert.equal(replayRebind.statusCode, 200);
    assert.equal((replayRebind.json() as Proposal).digest, updated.digest);

    // 旧按钮携带旧 digest 发起确认 → 必须返回 409 PROPOSAL_STALE
    const staleAccept = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${original.id}/acceptances`,
      headers: fx.writeHeaders,
      payload: { commandId: "accept-stale-10shot", proposalDigest: original.digest },
    });
    assert.equal(staleAccept.statusCode, 409);

    // 携带最新 digest 确认并重复提交同一 commandId → 只创建一次 Run，Shot 2 走 Colab、其余 9 镜走 Ark
    const acceptPayload = { commandId: "accept-fresh-10shot", proposalDigest: updated.digest };
    const accept1 = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${original.id}/acceptances`,
      headers: fx.writeHeaders,
      payload: acceptPayload,
    });
    const accept2 = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${original.id}/acceptances`,
      headers: fx.writeHeaders,
      payload: acceptPayload,
    });
    assert.equal(accept1.statusCode, 202);
    assert.equal(accept2.statusCode, 202);
    const adm1 = accept1.json() as AdmissionReceipt;
    const adm2 = accept2.json() as AdmissionReceipt;
    assert.equal(adm1.run.id, adm2.run.id, "重复确认命令幂等只受理一次");
    assert.equal(adm2.replayed, true);

    const completed = await fx.waitForRun(adm1.run.id);
    assert.equal(completed.state, "succeeded");
    assert.equal(fx.submissions.length, 10, "10 条镜头各精确提交 1 次");
    const colabSubs = fx.submissions.filter(s => s.channel === "colab");
    const arkSubs = fx.submissions.filter(s => s.channel === "ark");
    assert.deepEqual(colabSubs.map(s => s.operationId), ["shot-2"]);
    assert.equal(arkSubs.length, 9);
    assert.ok(arkSubs.every(s => s.binding.configurationRevisionId === arkEntry.binding.configurationRevisionId));
  });

  it("MP-06 免费配音同门禁与音色切换：dub_free 直调被 AUTHORIZATION_REQUIRED 拦截，换绑 Edge 免费配音产出词级边界与自动字幕轨", async (t: TestContext) => {
    const fx = await createPoolFixture(t);

    await fx.saveConn({
      id: "conn-mm-speech",
      name: "MiniMax 配音",
      protocol: "minimax",
      baseUrl: "https://api.minimax.cn",
      apiKey: "mm-speech-key",
      credentialConfigured: true,
      enabled: true,
      models: [
        {
          id: "m-mm-speech-1",
          kind: "speech",
          name: "Speech 2.8 Turbo",
          modelId: "speech-2.8-turbo",
          features: [],
          contextWindowTokens: null,
          maxOutputTokens: null,
          enabled: true,
          isDefault: true,
        },
      ],
    });
    await fx.saveEdge("enable-edge-mp06", 0, true, "zh-CN-XiaoxiaoNeural");

    const conv = await fx.createConv("conv-edge-speech", "免费配音同门验证");
    const seeded = seedConfirmedWork(fx.runtime.database, fx.clock(), { ownerId: "local-owner", conversationId: conv.id });

    // 1) 模型试图绕过提案确认直接调 dub_free → 必须被 AUTHORIZATION_REQUIRED 阻断，零驱动调用
    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([
        fauxToolCall(
          "dub_free",
          asJsonArgs({
            title: "偷跑免费配音",
            source: { kind: "inline", text: "帧工坊模型池" },
            voice: "zh-CN-XiaoxiaoNeural",
          }),
          { id: "tc-dub-direct" },
        ),
      ]),
      fauxAssistantMessage("直接配音被门禁拦截，改为提交制作提案。"),
    ]);
    await fx.sendChatAndWait(conv.id, "msg-dub-direct", "帮我给旁白配一段免费语音");
    assert.equal(fx.getEdgeDriverCalls(), 0, "未经提案确认绝不执行免费配音驱动");

    // 2) 通过 prepare_production 生成配音提案（初始默认 MiniMax Speech 2.8 Turbo）
    const mmBinding = fx.runtime.service
      .bootstrap("local-owner")
      .models.find(m => m.kind === "speech" && m.binding.providerId === "minimax")!.binding;

    const speechSpec: ToolProductionIntent = {
      workId: seeded.workId,
      title: "旁白配音确认",
      purpose: "production",
      scope: "生成 1 段中文旁白配音",
      reviewInputs: [seeded.reviewInput],
      inputSources: [],
      operations: [
        {
          operationId: "narration-1",
          outputSlot: "narration_audio",
          kind: "speech",
          model: mmBinding,
          inputs: [{ kind: "text", text: "帧工坊模型池" }],
          parameters: { voiceId: "Chinese (Mandarin)_Gentleman", format: "mp3" },
        },
      ],
      finalOutput: { operationId: "narration-1", outputSlot: "narration_audio" },
      maxSpend: { currency: "CNY", amountMinor: 100 },
    };
    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: speechSpec }), { id: "tc-speech-prep" })]),
      fauxAssistantMessage("配音提案已就绪。"),
    ]);
    const snap = await fx.sendChatAndWait(conv.id, "msg-speech-prep", "准备旁白配音提案");
    const paidProposal = snap.proposals.items[0]!;
    assert.ok(paidProposal.spec.maxSpend.amountMinor > 0, "初始付费默认配音有人民币报价");

    // 先在 MiniMax 内切换音色为新闻女声
    const voiceSwitchRes = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${paidProposal.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-mm-voice",
        expectedDigest: paidProposal.digest,
        changes: [
          {
            operationId: "narration-1",
            model: mmBinding,
            voiceId: "Chinese (Mandarin)_News_Anchor",
          },
        ],
      },
    });
    assert.equal(voiceSwitchRes.statusCode, 200);
    const voiceSwitched = voiceSwitchRes.json() as Proposal;
    const opVoice = voiceSwitched.spec.operations[0]!;
    assert.equal(opVoice.kind === "speech" && opVoice.parameters.voiceId, "Chinese (Mandarin)_News_Anchor");

    // 再换绑到池内 Edge 免费配音并选定云希男声 → 报价降为 ¥0.00，确认后生成词级边界并自动挂字幕轨
    const edgeRebindRes = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${paidProposal.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-to-edge-free",
        expectedDigest: voiceSwitched.digest,
        changes: [
          {
            operationId: "narration-1",
            model: EDGE_SPEECH_BINDING,
            voiceId: "zh-CN-YunxiNeural",
          },
        ],
      },
    });
    assert.equal(edgeRebindRes.statusCode, 200);
    const edgeProposal = edgeRebindRes.json() as Proposal;
    assert.equal(edgeProposal.spec.maxSpend.amountMinor, 0, "换绑 Edge 免费配音后人民币上限重算为 0 分");
    const edgeOp = edgeProposal.spec.operations[0]!;
    assert.equal(edgeOp.kind === "speech" && edgeOp.parameters.voiceId, "zh-CN-YunxiNeural");

    assert.equal(fx.getEdgeDriverCalls(), 0, "点击确认前仍为 0 次调用");
    const acceptEdgeRes = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${edgeProposal.id}/acceptances`,
      headers: fx.writeHeaders,
      payload: { commandId: "accept-edge-speech", proposalDigest: edgeProposal.digest },
    });
    assert.equal(acceptEdgeRes.statusCode, 202);
    const admitted = acceptEdgeRes.json() as AdmissionReceipt;
    const completed = await fx.waitForRun(admitted.run.id);
    assert.equal(completed.state, "succeeded");
    assert.equal(fx.getEdgeDriverCalls(), 1, "确认后精确调用 1 次免费配音驱动");
    assert.equal(fx.submissions.at(-1)?.voiceId, "zh-CN-YunxiNeural");

    // 校验已发布音频制品携带词级时间边界 dub，且会话/作品下已自动生成 tts_word 字幕制品
    const outRef = completed.outputRevisions[0]!;
    const revRes = await fx.app.inject({
      method: "GET",
      url: `/api/agent/v1/artifacts/${outRef.artifactId}/revisions/${outRef.revisionId}`,
    });
    assert.equal(revRes.statusCode, 200);
    const audioRevision = revRes.json() as ArtifactRevision;
    assert.equal(audioRevision.content.format, "media");
    assert.equal(audioRevision.content.dub?.voice, "zh-CN-YunxiNeural");
    assert.equal(audioRevision.content.dub?.boundaries.length, 2);

    const subRows = fx.runtime.database
      .prepare(
        `SELECT r.content_json
         FROM artifact_revisions r
         JOIN artifacts a ON a.id = r.artifact_id
         WHERE a.conversation_id = ? AND json_extract(r.content_json, '$.format') = 'subtitles'`,
      )
      .all(conv.id) as { content_json: string }[];
    assert.equal(subRows.length, 1, "Edge 免费配音完成后自动为作品登记词级字幕制品");
    const subContent = JSON.parse(subRows[0]!.content_json) as SubtitleTrack;
    assert.equal(subContent.alignment, "tts_word");
    assert.ok(subContent.cues.length >= 1);

    // 4) [P1-1 / P3-1 / P3-2 回归] 配音三态默认闭环（付费默认 ↔ Edge 免费默认 ↔ 无默认）+ 非零 rate 换绑拒绝 + 同连接重复型号拦截
    const setEdgeDef = await fx.saveEdge("edge-make-default", 1, true, "zh-CN-XiaoxiaoNeural", true);
    assert.equal(setEdgeDef.settings.isDefault, true);
    const bootAfterEdgeDef = fx.runtime.service.bootstrap("local-owner");
    assert.equal(
      bootAfterEdgeDef.models.find(m => m.kind === "speech" && m.binding.providerId === "edge-tts")?.isDefault,
      true,
      "显式将 Edge 免费配音设为默认后，即使池内有付费配音也以免费配音为默认",
    );
    assert.equal(
      bootAfterEdgeDef.models.find(m => m.kind === "speech" && m.binding.providerId === "minimax")?.isDefault,
      false,
      "付费配音连接默认标记已同步清除但仍留在池内可用",
    );

    const clearEdgeDef = await fx.saveEdge("edge-clear-default", setEdgeDef.settings.revision, true, "zh-CN-XiaoxiaoNeural", false);
    assert.equal(clearEdgeDef.settings.isDefault, false);
    const bootNoDef = fx.runtime.service.bootstrap("local-owner");
    assert.equal(
      bootNoDef.models.filter(m => m.kind === "speech").every(m => m.isDefault === false),
      true,
      "取消免费配音默认后进入无默认手动选态",
    );

    // 非零 rate 的免费配音提案若换绑到不支持 rate 的付费配音 → 必须被校验拦截
    const rateSpec: ToolProductionIntent = {
      ...speechSpec,
      title: "带语速倍率的免费配音提案",
      operations: [
        {
          operationId: "narration-rate",
          outputSlot: "narration_audio",
          kind: "speech",
          model: EDGE_SPEECH_BINDING,
          modelSource: "user_named",
          inputs: [{ kind: "text", text: "测试加速语速" }],
          parameters: { voiceId: "zh-CN-XiaoxiaoNeural", format: "mp3", rate: "+15%" },
        },
      ],
      finalOutput: { operationId: "narration-rate", outputSlot: "narration_audio" },
    };
    fx.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("prepare_production", asJsonArgs({ spec: rateSpec }), { id: "tc-rate" })]),
      fauxAssistantMessage("加速配音提案已就绪。"),
    ]);
    const snapRate = await fx.sendChatAndWait(conv.id, "msg-rate-prep", "准备加速配音提案");
    const rateProp = snapRate.proposals.items.find(p => p.spec.title === "带语速倍率的免费配音提案")!;
    const badRateRebind = await fx.app.inject({
      method: "POST",
      url: `/api/agent/v1/proposals/${rateProp.id}/rebind`,
      headers: fx.writeHeaders,
      payload: {
        commandId: "rebind-rate-to-mm",
        expectedDigest: rateProp.digest,
        changes: [{ operationId: "narration-rate", model: mmBinding, voiceId: "Chinese (Mandarin)_Gentleman" }],
      },
    });
    assert.equal(badRateRebind.statusCode >= 400, true, "非 +0% 语速倍率换绑至不支持 rate 的付费通道必须拒绝");

    // 同一连接内重复添加相同 (kind, modelId) 必须被 saveProviderConnection 拦截
    const curState = readProviderConnections(fx.runtime.database);
    const mmConn = curState.connections.find(c => c.id === "conn-mm-speech")!;
    const dupRes = await fx.app.inject({
      method: "POST",
      url: "/api/agent/v1/settings/model-connections",
      headers: fx.writeHeaders,
      payload: {
        commandId: "dup-model-in-conn",
        expectedRevision: curState.revision,
        connection: {
          ...mmConn,
          models: [
            ...mmConn.models,
            { ...mmConn.models[0]!, id: "m-mm-speech-dup", isDefault: false },
          ],
        },
      },
    });
    assert.equal(dupRes.statusCode, 400, "同一连接重复 (kind, modelId) 必须拒绝");
  });
});
