import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
  canonicalQualityContractDigest,
  type CreativeTreatmentAgent,
  type ProductionBrief,
  type VisualAssetProviderCapability,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type WorkerResponse,
} from "@video-factory/production-pipeline";
import { buildStudioApp, type StudioServicePort } from "../src/server/app.js";
import { ProductionStudio } from "../src/server/production-studio.js";
import type { StudioProvider } from "../src/shared/api.js";

// ---------------------------------------------------------------------------
// C2：报价准备与授权业务命令（production-quotes / production-authorizations /
// amendments）。全部走真实 ProductionPipeline + ProductionStudio + HTTP 层：
// - 报价只计算并保存不可变 quote，不调用媒体 Provider；
// - 授权命令只接受服务端生成的 fundingRequest/quote，幂等重放同 key 同结果；
// - 追加是 delta，supersede 当前授权，旧花费不清零；
// - 暂停后阻止新 create；旧 revision 409；篡改 quote 400。
// ---------------------------------------------------------------------------

const TREATMENT_PROVIDER_ID = "codex-creative-treatment-v1";

class QuoteWorker {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "script.draft": { scriptPath: path.join(outputDir, "script.json") },
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"), trackPath: path.join(outputDir, "narration.m4a") },
      "video.render": { videoPath: path.join(outputDir, "final.mp4"), renderManifestPath: path.join(outputDir, "render_manifest.json") },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected capability: ${capability}`);
    const jsonContent = JSON.stringify({ capability });
    const primaryPath = String(Object.values(output)[0]);
    const primaryContent = capability === "video.render" ? "video" : jsonContent;
    await writeFile(primaryPath, primaryContent);
    if (capability === "voice.synthesize") await writeFile(String(output.trackPath), "audio");
    if (capability === "video.render") await writeFile(String(output.renderManifestPath), jsonContent);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output,
      artifacts: [{
        kind: capability.replace(".", "_"),
        uri: primaryPath,
        sha256: createHash("sha256").update(primaryContent).digest("hex"),
        sizeBytes: Buffer.byteLength(primaryContent),
        contentType: capability === "video.render" ? "video/mp4" : "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }],
    };
  }
}

const METERED_ASSET_PROVIDERS: VisualAssetProviderCapability[] = [
  { id: "seedance-video-v1", label: "Seedance", billing: "metered", modes: ["文生视频"], deliveryTypes: ["generated_video"], estimatedCnyPerClip: 2.4, generative: true },
];

function quoteBrief(): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "C2 授权命令",
    angle: "报价与授权边界",
    audience: "创作者",
    nicheSlug: "c2-auth-api",
    durationSeconds: 24,
    durationRange: { minSeconds: 20, maxSeconds: 34 },
    platform: "douyin",
    runPurpose: "test",
    reviewMode: "manual",
    providers: {
      script: "codex-screenwriter-v1",
      director: "api-visual-director-v1",
      assets: "seedance-video-v1",
      voice: "macos-say-v1",
      render: "python-ffmpeg-v1",
      technicalReview: "python-technical-review-v1",
    },
    workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1" },
    director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
    economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  } as unknown as ProductionBrief;
}

function quoteAgents(): { treatmentAgents: Array<{ providerId: string; agent: CreativeTreatmentAgent }>; screenwriterAgent: unknown; directorAgent: VisualDirectorAgent } {
  return {
    treatmentAgents: [{
      providerId: "openai",
      agent: {
        id: TREATMENT_PROVIDER_ID,
        modelId: "treatment-model-a",
        treat: async () => ({
          version: "video-factory/creative-treatment-v1",
          viewerPromise: "看完能记住三个要点",
          hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
          progression: [
            { beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" },
            { beatId: "beat-2", purpose: "给出方法", viewerGain: "可执行步骤" },
          ],
          payoff: "低风险决策清单",
          visualPrinciples: ["真实动作"],
          soundPrinciples: ["环境声先行"],
          evidenceRequirements: [],
          feasibilityQuestions: [],
        }),
      },
    }],
    screenwriterAgent: {
      id: "codex-screenwriter-v1",
      modelId: "screenwriter-model-one",
      draft: async () => ({
        viewerPromise: "看完能记住三个要点",
        narrativeArc: "问题-方法-清单",
        canonFacts: ["要点可执行"],
        scenes: [1, 2, 3].map((position) => ({
          position,
          narration: `第${position}段旁白`,
          duration: 8,
          visual_strategy: "generated",
          visual_prompt: `第${position}个生成镜头`,
          search_terms: [`镜头 ${position}`],
        })),
      }),
    },
    directorAgent: {
      id: "api-visual-director-v1",
      modelId: "director-model-one",
      plan: async (input: VisualDirectorAgentInput) => ({
        version: "video-factory/director-plan-v1",
        requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer",
        profileRationale: "生成镜头交付。",
        visualBible: {
          narrativeApproach: "逐步展示", pacing: "均匀", composition: "稳定中景",
          camera: "固定机位", color: "自然色", continuity: "同一时段", sound: "环境声",
        },
        shots: input.scenes.map((scene) => ({
          scenePosition: scene.position,
          narrativeRole: "解释",
          authenticityPolicy: "illustrative",
          preferredProviderId: "seedance-video-v1",
          deliveryType: "generated_video",
          alternativeProviderIds: [],
          temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
          query: `镜头内容 ${scene.position}`,
          generationPrompt: `第${scene.position}个生成镜头`,
          rationale: "生成能力可以交付。",
          continuityNote: "保持自然色。",
          confidence: 0.8,
          estimatedCostCny: 0,
        })),
      }),
    } as unknown as VisualDirectorAgent,
  };
}

const C2_PROVIDERS: StudioProvider[] = [
  { id: "codex-screenwriter-v1", capability: "script.draft", label: "AI 编剧", available: true, kind: "external" },
  { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "external" },
  { id: TREATMENT_PROVIDER_ID, capability: "creative.treatment", label: "AI 前期构思", available: true, kind: "external" },
  { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
  { id: "seedance-video-v1", capability: "asset.prepare", label: "Seedance", available: true, kind: "external", billing: "metered" },
  { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" },
  { id: "python-ffmpeg-v1", capability: "video.render", label: "本地渲染", available: true, kind: "local" },
  { id: "python-technical-review-v1", capability: "quality.review", label: "机器质检", available: true, kind: "local" },
];

async function newQuoteStudio(workspaceRoot: string): Promise<{ studio: ProductionStudio; pipeline: ProductionPipeline }> {
  const agents = quoteAgents();
  const pipeline = new ProductionPipeline({
    workspaceRoot,
    worker: new QuoteWorker(),
    treatmentAgents: agents.treatmentAgents,
    screenwriterAgent: agents.screenwriterAgent as never,
    directorAgent: agents.directorAgent,
    assetProviders: METERED_ASSET_PROVIDERS,
    providerRuntimeMetadata: [{
      id: "seedance-video-v1", label: "Seedance", modelId: "seedance-v1", transport: "http_api" as const, billing: "metered" as const, estimatedCostCny: 2.4, maxAttempts: 2,
    }],
  });
  const studio = new ProductionStudio({
    workspaceRoot,
    pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
    listProviders: async () => C2_PROVIDERS,
  });
  return { studio, pipeline };
}

async function awaitingRun(harness: { studio: ProductionStudio; pipeline: ProductionPipeline }): Promise<string> {
  const run = await harness.pipeline.start(quoteBrief());
  assert.equal(
    run.status,
    "awaiting_spend_approval",
    JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))),
  );
  return run.id;
}

async function currentQuoteDraft(harness: { studio: ProductionStudio; pipeline: ProductionPipeline }, runId: string) {
  const run = await harness.pipeline.show(runId);
  const assets = run.nodeRuns.find((node) => node.nodeId === "assets")!;
  const plan = assets.spendPlan!;
  const effectiveInput = assets.inputState?.versions.find((v) => v.id === assets.inputState?.effectiveVersionId)?.value as {
    executablePlanPath?: string;
  };
  const planDigest = createHash("sha256").update(await readFile(effectiveInput.executablePlanPath!)).digest("hex");
  const brief = (run as unknown as { initialInput: Record<string, unknown> }).initialInput as unknown as ProductionBrief;
  const qualityDigest = canonicalQualityContractDigest({
    angle: brief.angle,
    audience: brief.audience,
    durationRange: brief.durationRange ?? { minSeconds: 0, maxSeconds: 0 },
    directorProfileId: brief.director?.profileId ?? "",
  });
  const quoteItems = (plan.items ?? []).map((item) => ({
    assetKey: item.id,
    intentDigest: createHash("sha256").update(item.id).digest("hex"),
    models: [{ providerId: item.providerId, modelId: item.modelId }],
    maxCreateAttempts: 2,
  }));
  return { run, plan, planDigest, qualityDigest, quoteItems };
}

describe("C2 production quotes and authorization commands", () => {
  it("prepares an immutable quote and authorizes via the service, replaying idempotently", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-c2-quote-"));
    const harness = await newQuoteStudio(workspaceRoot);
    const runId = await awaitingRun(harness);
    const draft = await currentQuoteDraft(harness, runId);

    const quote = await harness.studio.prepareProductionQuote(runId, {
      expectedRunRevision: draft.run.revision,
      acceptedPlanDigest: draft.planDigest,
      requestedMaximumCny: 15,
    });
    assert.ok(quote.quoteId, "the service must generate the immutable quote id");
    assert.equal(quote.acceptedPlanDigest, draft.planDigest);
    assert.equal(quote.maximumCostCny, 15);
    assert.ok(quote.estimatedCostCny > 0, "the quote must carry the estimated media cost");

    // 篡改 acceptedPlanDigest → 400。
    await assert.rejects(
      () => harness.studio.authorizeProductionScope(runId, {
        expectedRunRevision: draft.run.revision,
        quoteId: quote.quoteId,
        acceptedPlanDigest: "f".repeat(64),
        idempotencyKey: "auth-key-1",
      }),
      /不一致|digest|quote/i,
    );

    const authorized = await harness.studio.authorizeProductionScope(runId, {
      expectedRunRevision: draft.run.revision,
      quoteId: quote.quoteId,
      acceptedPlanDigest: draft.planDigest,
      idempotencyKey: "auth-key-1",
    });
    assert.equal(authorized.id, runId);
    // 覆盖授权 → 自动继续，不停在报价等待。
    assert.notEqual(authorized.status, "awaiting_spend_approval");

    // 幂等重放：同 key 同结果（run 已继续，不重复授权）。
    const replay = await harness.studio.authorizeProductionScope(runId, {
      expectedRunRevision: draft.run.revision,
      quoteId: quote.quoteId,
      acceptedPlanDigest: draft.planDigest,
      idempotencyKey: "auth-key-1",
    });
    assert.equal(replay.revision, authorized.revision, "idempotent replay must not bump the run revision");
  });

  it("recovers an interrupted amendment from its prepared receipt by reusing the saved scope bytes", async () => {
    // CG-01：prepared receipt 落盘后、授权接受完成前进程中断——重放必须复用保存的原始
    // scope 字节（approvedAt 等字段完全一致），不能重新构造出"同 id 不同内容"的授权。
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-c2-amend-crash-"));
    const harness = await newQuoteStudio(workspaceRoot);
    const runId = await awaitingRun(harness);
    const draft = await currentQuoteDraft(harness, runId);
    const quote = await harness.studio.prepareProductionQuote(runId, {
      expectedRunRevision: draft.run.revision,
      acceptedPlanDigest: draft.planDigest,
    });
    await harness.studio.authorizeProductionScope(runId, {
      expectedRunRevision: draft.run.revision,
      quoteId: quote.quoteId,
      acceptedPlanDigest: draft.planDigest,
      idempotencyKey: "crash-key-1",
    });
    const active = await harness.pipeline.readProductionAuthorization(runId);
    assert.ok(active);
    const postAuthorize = await harness.pipeline.show(runId);

    // 模拟崩溃残留：一份 prepared receipt（含完整 scope）+ 已写入磁盘的授权文件，
    // 但 run 从未提交该授权（active 仍是旧 head）。
    const input = { expectedRunRevision: postAuthorize.revision, fundingRequestId: "never-saved", idempotencyKey: "crash-key-2" };
    const actor = "studio-owner";
    const amendDigest = createHash("sha256").update(JSON.stringify({ runId, actor, target: active.id, input })).digest("hex");
    const authorizationId = `auth-${createHash("sha256").update(amendDigest).digest("hex").slice(0, 32)}`;
    const crashedScope = {
      version: "video-factory/production-authorization-v1" as const,
      id: authorizationId,
      runId,
      approvalRevision: postAuthorize.revision,
      acceptedPlanDigest: draft.planDigest,
      qualityContractDigest: draft.qualityDigest,
      approvedAmountCents: active.approvedAmountCents + 500,
      approvedBy: actor,
      approvedAt: "2026-09-12T00:00:00.000Z",
      permittedAssets: active.permittedAssets,
      supersedesAuthorizationId: active.id,
    };
    const receiptName = createHash("sha256").update("crash-key-2").digest("hex");
    const receiptPath = path.join(workspaceRoot, "runs", runId, ".commands", "production-amendment", `${receiptName}.json`);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify({
      version: "video-factory/production-command-v1",
      status: "prepared",
      digest: amendDigest,
      runId,
      actor,
      authorizationId,
      scope: crashedScope,
    }, null, 2)}\n`, "utf8");
    const crashedAuthPath = path.join(workspaceRoot, "runs", runId, "production-authorization", `${authorizationId}.json`);
    await mkdir(path.dirname(crashedAuthPath), { recursive: true });
    await writeFile(crashedAuthPath, `${JSON.stringify(crashedScope, null, 2)}\n`, "utf8");

    const input2 = { ...input };
    const amended = await harness.studio.amendProductionScope(runId, active.id, input2);
    assert.notEqual(amended.status, "awaiting_spend_approval");
    const amendedActive = await harness.pipeline.readProductionAuthorization(runId);
    assert.equal(amendedActive?.id, authorizationId);
    // 原始 payload 被逐字节复用（fixed approvedAt 不变）。
    assert.equal(amendedActive?.approvedAt, "2026-09-12T00:00:00.000Z");
    assert.equal(amendedActive?.approvedAmountCents, active.approvedAmountCents + 500);
    // 再次重放：幂等，无第二次 delta。
    const replay = await harness.studio.amendProductionScope(runId, active.id, input2);
    const replayActive = await harness.pipeline.readProductionAuthorization(runId);
    assert.equal(replayActive?.id, authorizationId);
    assert.equal(replayActive?.approvedAmountCents, active.approvedAmountCents + 500);
    assert.equal(replay.status, amended.status);
  });

  it("rejects a requested maximum that is not an exact number of cents", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-c2-cents-"));
    const harness = await newQuoteStudio(workspaceRoot);
    const runId = await awaitingRun(harness);
    const draft = await currentQuoteDraft(harness, runId);
    // 8.006 元 = 800.6 分：不能四舍五入成 801 分——展示与签发金额必须完全一致（RC2-03）。
    await assert.rejects(
      () => harness.studio.prepareProductionQuote(runId, {
        expectedRunRevision: draft.run.revision,
        acceptedPlanDigest: draft.planDigest,
        requestedMaximumCny: 8.006,
      }),
      /精确到分/,
    );
    // 二进制浮点表示误差（8.01 × 100 = 800.999…）不误伤合法金额。
    const quote = await harness.studio.prepareProductionQuote(runId, {
      expectedRunRevision: draft.run.revision,
      acceptedPlanDigest: draft.planDigest,
      requestedMaximumCny: 8.01,
    });
    assert.equal(quote.maximumCostCny, 8.01);
  });

  it("rejects stale revisions with a conflict and foreign quotes with input errors", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-c2-stale-"));
    const harness = await newQuoteStudio(workspaceRoot);
    const runId = await awaitingRun(harness);
    const draft = await currentQuoteDraft(harness, runId);
    const quote = await harness.studio.prepareProductionQuote(runId, {
      expectedRunRevision: draft.run.revision,
      acceptedPlanDigest: draft.planDigest,
    });
    await assert.rejects(
      () => harness.studio.authorizeProductionScope(runId, {
        expectedRunRevision: draft.run.revision + 5,
        quoteId: quote.quoteId,
        acceptedPlanDigest: draft.planDigest,
        idempotencyKey: "auth-key-stale",
      }),
      /刷新后重试|revision/i,
    );
    await assert.rejects(
      () => harness.studio.authorizeProductionScope(runId, {
        expectedRunRevision: draft.run.revision,
        quoteId: "quote-that-never-existed",
        acceptedPlanDigest: draft.planDigest,
        idempotencyKey: "auth-key-foreign",
      }),
      /报价|quote/i,
    );
  });

  it("amends as a delta that supersedes the current authorization without zeroing spend", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-c2-amend-"));
    const harness = await newQuoteStudio(workspaceRoot);
    const runId = await awaitingRun(harness);
    const draft = await currentQuoteDraft(harness, runId);
    const quote = await harness.studio.prepareProductionQuote(runId, {
      expectedRunRevision: draft.run.revision,
      acceptedPlanDigest: draft.planDigest,
      // 首次授权只批 estimated（3 镜 × 2.4 = 7.2 元），低于计划最高占用 14.4 元：
      // 覆盖判定失败，run 必须停在报价等待，而不是自动继续。
      requestedMaximumCny: draft.plan.estimatedCostCny,
    });
    const authorized = await harness.studio.authorizeProductionScope(runId, {
      expectedRunRevision: draft.run.revision,
      quoteId: quote.quoteId,
      acceptedPlanDigest: draft.planDigest,
      idempotencyKey: "amend-key-1",
    });
    assert.equal(authorized.status, "awaiting_spend_approval", "a scope below the plan maximum must not auto-continue");
    const active = await harness.pipeline.readProductionAuthorization(runId);
    assert.ok(active);
    // 追加的权威差额只能来自服务端保存的 funding request（prepare 在已有 active 授权时生成）；
    // 客户端不能自报 additionalCents。
    const postAuthorize = await harness.pipeline.show(runId);
    const followupQuote = await harness.studio.prepareProductionQuote(runId, {
      expectedRunRevision: postAuthorize.revision,
      acceptedPlanDigest: draft.planDigest,
      requestedMaximumCny: 15,
    });
    assert.ok(followupQuote.fundingRequestId, "a follow-up quote with an active scope must carry a funding request");
    assert.equal(followupQuote.additionalCents, 780, "the funding request reports the exact server-computed delta (1500-720)");
    const amended = await harness.studio.amendProductionScope(runId, active.id, {
      expectedRunRevision: postAuthorize.revision,
      fundingRequestId: followupQuote.fundingRequestId,
      idempotencyKey: "amend-key-2",
    });
    assert.notEqual(amended.status, "awaiting_spend_approval", "the amendment must let the run continue within the widened scope");
    const amendedActive = await harness.pipeline.readProductionAuthorization(runId);
    assert.ok(amendedActive);
    assert.notEqual(amendedActive.id, active.id, "the amendment must supersede the previous authorization");
    assert.equal(amendedActive.supersedesAuthorizationId, active.id);
    assert.equal(amendedActive.approvedAmountCents, active.approvedAmountCents + 780, "amendment is a delta added on top, not a reset");
    // 幂等重放：同 key 同参数（含首次的 revision）在幂等检查命中后直接返回当前 run，
    // 不重复追加 delta，也不因 revision 已推进而 409。
    const replay = await harness.studio.amendProductionScope(runId, active.id, {
      expectedRunRevision: postAuthorize.revision,
      fundingRequestId: followupQuote.fundingRequestId,
      idempotencyKey: "amend-key-2",
    });
    assert.equal(replay.revision, amended.revision, "idempotent replay must return the amended state without a second delta");
    const replayActive = await harness.pipeline.readProductionAuthorization(runId);
    assert.equal(replayActive?.approvedAmountCents, active.approvedAmountCents + 780, "no double delta");
  });

  it("maps validation and conflict failures to 400/409 at the HTTP layer", async () => {
    const overrides: string[] = [];
    const service: StudioServicePort = {
      health: async () => ({ status: "ok", runtime: { ffmpeg: true, ffprobe: true, say: true } }),
      prepareProductionQuote: async (_runId, input) => {
        if (input.expectedRunRevision < 0) throw new (await import("../src/shared/api.js")).StudioInputError("制作编号格式不正确。");
        overrides.push(`quote:${input.expectedRunRevision}`);
        return {
          quoteId: "quote-1",
          acceptedPlanDigest: input.acceptedPlanDigest,
          estimatedCostCny: 4.8,
          maximumCostCny: input.requestedMaximumCny ?? 4.8,
          scopeSummary: "三个生成镜头",
        };
      },
      authorizeProductionScope: async (_runId, input) => {
        if (input.quoteId === "bad") throw new (await import("../src/shared/api.js")).StudioInputError("报价已经变化，请重新确认。");
        if (input.expectedRunRevision > 100) throw new (await import("../src/server/studio-service.js")).StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
        overrides.push(`auth:${input.idempotencyKey}`);
        return {} as never;
      },
      amendProductionScope: async (_runId, authorizationId, input) => {
        overrides.push(`amend:${authorizationId}:${input.idempotencyKey}`);
        return {} as never;
      },
    } as unknown as StudioServicePort;
    const app = buildStudioApp({ service });
    const inject = async (method: string, url: string, body: unknown) => app.inject({ method, url, payload: body });

    let response = await inject("POST", "/api/runs/run-1/production-quotes", { expectedRunRevision: -1, acceptedPlanDigest: "a".repeat(64) });
    assert.equal(response.statusCode, 400, response.body);

    response = await inject("POST", "/api/runs/run-1/production-quotes", { expectedRunRevision: 3, acceptedPlanDigest: "a".repeat(64), requestedMaximumCny: 10 });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().quoteId, "quote-1");

    response = await inject("POST", "/api/runs/run-1/production-authorizations", { expectedRunRevision: 3, quoteId: "bad", acceptedPlanDigest: "a".repeat(64), idempotencyKey: "k1" });
    assert.equal(response.statusCode, 400);

    response = await inject("POST", "/api/runs/run-1/production-authorizations", { expectedRunRevision: 999, quoteId: "q", acceptedPlanDigest: "a".repeat(64), idempotencyKey: "k2" });
    assert.equal(response.statusCode, 409);

    response = await inject("POST", "/api/runs/run-1/production-authorizations", { expectedRunRevision: 3, quoteId: "q", acceptedPlanDigest: "a".repeat(64), idempotencyKey: "k3" });
    assert.equal(response.statusCode, 200);

    response = await inject("POST", "/api/runs/run-1/production-authorizations/auth-1/amendments", { expectedRunRevision: 3, fundingRequestId: "fr-1", idempotencyKey: "k4" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(overrides, ["quote:3", "auth:k3", "amend:auth-1:k4"]);
  });
});
