import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Artifact } from "@video-factory/workflow-core";
import type { WorkerResponse } from "../src/index.js";
import * as pipeline from "../src/index.js";

const brief = {
  protocolVersion: "video-factory/brief-v1",
  title: "做决定前，先避开这 3 个坑",
  angle: "低风险、可收藏的生活清单",
  audience: "有决策压力的普通上班族",
  nicheSlug: "life-avoidance",
  durationSeconds: 30,
  platform: "douyin",
  reviewMode: "manual",
  providers: {
    script: "python-template-v1",
    assets: "local-editorial-v1",
    voice: "macos-say-v1",
    render: "python-ffmpeg-v1",
    technicalReview: "python-technical-review-v1",
  },
  voiceDirection: {
    profileId: "macos:Sandy (中文（中国大陆）)",
    rate: 178,
    pauseScale: 1.25,
    masteringPreset: "intimate",
  },
} as const;

class FakeWorker {
  readonly calls: Array<Record<string, unknown>> = [];

  constructor(private readonly rejectedCapability?: string) {}

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    this.calls.push(request);
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "script.draft": { scriptPath: path.join(outputDir, "script.json") },
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": {
        voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"),
        trackPath: path.join(outputDir, "narration.m4a"),
      },
      "video.render": {
        videoPath: path.join(outputDir, "final.mp4"),
        renderManifestPath: path.join(outputDir, "render_manifest.json"),
      },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected fake capability: ${capability}`);
    const primaryPath = String(Object.values(output)[0]);
    const content = capability === "script.draft"
      ? JSON.stringify({
          scenes: [
            {
              position: 1,
              narration: "第一幕",
              duration: 5,
              visual_strategy: "stock",
              visual_prompt: "城市早餐摊",
              on_screen_text: "早餐第一步",
              sound_cue: "摊位环境声",
            },
            {
              position: 2,
              narration: "第二幕",
              duration: 5,
              visual_strategy: "stock",
              visual_prompt: "食物制作特写",
              on_screen_text: "看清制作动作",
              sound_cue: "煎制声",
            },
          ],
        })
      : JSON.stringify({ capability });
    await writeFile(primaryPath, content, "utf8");
    const providerId = String((request.parameters as Record<string, unknown>).providerId);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: capability === this.rejectedCapability ? "rejected" : "succeeded",
      output,
      artifacts: [
        {
          kind: capability.replace(".", "_"),
          uri: primaryPath,
          sha256: createHash("sha256").update(content).digest("hex"),
          sizeBytes: Buffer.byteLength(content),
          contentType: capability === "video.render" ? "video/mp4" : "application/json",
          provenance: {
            providerId,
            producerNodeId: String(request.nodeRunId),
            attempt: Number(request.attempt),
            licenseNote: "Fake worker artifact for integration testing.",
          },
        },
      ],
    };
  }
}

describe("ProductionPipeline", () => {
  it("pauses before the metered GLM visual-review role, then runs it after explicit spend approval", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-visual-review-"));
    const worker = new FakeWorker();
    const reviewCalls: Array<{ videoPath: string; runRoot: string }> = [];
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: [{
        id: "glm-visual-review-v1",
        label: "GLM-5.3-Flash 视觉审片",
        modelId: "glm-5.3-flash",
        transport: "unix_socket",
        billing: "metered",
        estimatedCostCny: 0.1,
        maxAttempts: 1,
      }],
      visualReviewAgents: [
        {
          id: "codex-visual-review-v1",
          modelId: "codex-default",
          review: async () => { throw new Error("The non-selected reviewer must not run."); },
        },
        {
          id: "glm-visual-review-v1",
          modelId: "glm-5.3-flash",
          review: async (input) => {
            reviewCalls.push(input);
            return {
              version: "video-factory/visual-review-v1",
              summary: "画面可进入人工终审。",
              scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 95 },
              findings: [],
              confidence: 0.8,
              recommendation: "approve",
            };
          },
        },
      ],
    });

    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, visualReview: "glm-visual-review-v1" },
    });
    const plan = paused.nodeRuns.find((node) => node.nodeId === "visual-review")?.spendPlan;
    assert.equal(paused.status, "awaiting_spend_approval");
    assert.equal(reviewCalls.length, 0);
    assert.ok(plan);
    assert.equal(plan.estimatedCostCny, 0.1);
    assert.equal(plan.maxAttempts, 1);

    const waiting = await subject.authorizeSpend(paused.id, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(waiting.status, "needs_human");
    assert.equal(waiting.workflowVersion, "1.2.0");
    assert.equal(reviewCalls.length, 1);
    assert.match(reviewCalls[0]!.videoPath, /final\.mp4$/);
    assert.ok(waiting.nodeRuns.some((node) => node.nodeId === "visual-review" && node.status === "succeeded"));
    assert.equal(waiting.nodeRuns.find((node) => node.nodeId === "visual-review")?.executionReceipt?.modelId, "glm-5.3-flash");
    assert.ok(waiting.artifacts.some((artifact) => artifact.kind === "review_report" && artifact.provenance.providerId === "glm-visual-review-v1"));
  });

  it("fails closed when a known metered visual reviewer has no runtime metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-visual-review-metadata-"));
    let calls = 0;
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new FakeWorker(),
      visualReviewAgents: [{
        id: "glm-visual-review-v1",
        modelId: "glm-5.3-flash",
        review: async () => {
          calls += 1;
          throw new Error("must not execute");
        },
      }],
    });

    await assert.rejects(() => subject.start({
      ...brief,
      providers: { ...brief.providers, visualReview: "glm-visual-review-v1" },
      economics: { recipeId: "economy-daily", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    }), /Metered provider 'glm-visual-review-v1' requires runtime metadata/);
    assert.equal(calls, 0);
  });

  it("forces human review when automatic mode receives a non-approve visual recommendation", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-visual-reject-"));
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new FakeWorker(),
      visualReviewAgent: {
        id: "codex-visual-review-v1",
        modelId: "codex-default",
        review: async () => ({
          version: "video-factory/visual-review-v1",
          summary: "字幕遮挡了主体。",
          scores: { composition: 45, continuity: 70, pacing: 70, legibility: 30, safety: 90 },
          findings: [{ timecodeMs: 1_000, category: "legibility", severity: "critical", description: "字幕不可读", suggestion: "重新排版" }],
          confidence: 0.9,
          recommendation: "reject",
        }),
      },
    });

    const waiting = await subject.start({
      ...brief,
      reviewMode: "automatic",
      providers: { ...brief.providers, visualReview: "codex-visual-review-v1" },
    });

    assert.equal(waiting.status, "needs_human");
    assert.equal(waiting.nodeRuns.find((node) => node.nodeId === "final-review")?.status, "needs_human");
    assert.match(waiting.interventions.at(-1)?.reason ?? "", /视觉审片判定/);
    assert.ok(!waiting.artifacts.some((artifact) => artifact.kind === "publish_package"));
  });

  it("keeps an existing run editable when its visual-review agent is temporarily unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-visual-recovery-"));
    const worker = new FakeWorker();
    const configured = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      visualReviewAgent: {
        id: "codex-visual-review-v1",
        modelId: "codex-default",
        review: async () => ({
          version: "video-factory/visual-review-v1",
          summary: "可进入终审。",
          scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 95 },
          findings: [],
          confidence: 0.8,
          recommendation: "approve",
        }),
      },
    });
    const waiting = await configured.start({
      ...brief,
      providers: { ...brief.providers, visualReview: "codex-visual-review-v1" },
    });
    const technicalOutput = waiting.nodeRuns.find((node) => node.nodeId === "technical-review")?.output;
    assert.ok(technicalOutput);

    const unavailable = new pipeline.ProductionPipeline({ workspaceRoot, worker });
    const stale = await unavailable.applyNodeOverride(waiting.id, {
      nodeId: "technical-review",
      actor: "reviewer",
      output: technicalOutput,
    });
    assert.equal(stale.status, "stale");
    assert.equal(stale.nodeRuns.find((node) => node.nodeId === "visual-review")?.status, "stale");

    const failed = await unavailable.resumeStale(waiting.id);
    const visualReview = failed.nodeRuns.find((node) => node.nodeId === "visual-review");
    assert.equal(failed.status, "failed");
    assert.equal(visualReview?.status, "failed");
    assert.equal(visualReview?.executionReceipt?.status, "failed");
    assert.match(visualReview?.error ?? "", /temporarily unavailable/);

    const recovered = await unavailable.applyNodeOverride(waiting.id, {
      nodeId: "visual-review",
      actor: "reviewer",
      output: waiting.nodeRuns.find((node) => node.nodeId === "visual-review")?.output,
      allowTerminalEdit: true,
    });
    assert.equal(recovered.status, "stale");
    assert.equal(recovered.nodeRuns.find((node) => node.nodeId === "visual-review")?.status, "succeeded");
  });

  it("can authorize an existing paid run while visual review is unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-visual-authorize-"));
    const worker = new FakeWorker();
    const metadata: pipeline.ProductionProviderRuntimeMetadata[] = [{
      id: "hailuo-video-v1",
      label: "MiniMax 海螺",
      modelId: "MiniMax-Hailuo-02",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 2,
      maxAttempts: 1,
    }];
    const configured = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: metadata,
      visualReviewAgent: {
        id: "codex-visual-review-v1",
        modelId: "codex-default",
        review: async () => ({
          version: "video-factory/visual-review-v1",
          summary: "可进入终审。",
          scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 95 },
          findings: [],
          confidence: 0.8,
          recommendation: "approve",
        }),
      },
    });
    const paused = await configured.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1", visualReview: "codex-visual-review-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 3 },
    });
    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(plan);

    const unavailable = new pipeline.ProductionPipeline({ workspaceRoot, worker, providerRuntimeMetadata: metadata });
    const failed = await unavailable.authorizeSpend(paused.id, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(failed.status, "failed");
    assert.equal(failed.nodeRuns.find((node) => node.nodeId === "assets")?.status, "succeeded");
    assert.equal(failed.nodeRuns.find((node) => node.nodeId === "visual-review")?.executionReceipt?.status, "failed");
  });

  it("rejects an invalid pipeline override without changing the persisted run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-override-schema-"));
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const waiting = await subject.start(brief);

    await assert.rejects(
      () => subject.applyNodeOverride(waiting.id, { nodeId: "script", actor: "editor", output: { scriptPath: "" } }),
      /scriptPath must be a non-empty string/,
    );
    const unchanged = await subject.show(waiting.id);
    assert.equal(unchanged.revision, waiting.revision);
    assert.deepEqual(unchanged.nodeRuns.find((node) => node.nodeId === "script")?.output, waiting.nodeRuns.find((node) => node.nodeId === "script")?.output);
  });

  it("lets an editor revise brief content while protecting workflow infrastructure", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-brief-override-"));
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const waiting = await subject.start(brief);
    const briefOutput = waiting.nodeRuns.find((node) => node.nodeId === "brief")?.output as pipeline.ProductionBrief;

    const revised = await subject.applyNodeOverride(waiting.id, {
      nodeId: "brief",
      actor: "producer",
      output: { ...briefOutput, title: "人工修改后的选题" },
    });

    assert.equal(revised.status, "stale");
    assert.equal((revised.nodeRuns.find((node) => node.nodeId === "brief")?.output as pipeline.ProductionBrief).title, "人工修改后的选题");
    assert.equal(revised.nodeRuns.find((node) => node.nodeId === "script")?.status, "stale");
    await assert.rejects(() => subject.applyNodeOverride(waiting.id, {
      nodeId: "brief",
      actor: "producer",
      output: { ...briefOutput, reviewMode: "automatic" },
    }), /requires starting a new run/);
  });

  it("rejects override paths outside the selected run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-override-boundary-"));
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const waiting = await subject.start(brief);
    const outside = path.join(workspaceRoot, "outside-script.json");
    await writeFile(outside, "{}\n", "utf8");

    await assert.rejects(
      () => subject.applyNodeOverride(waiting.id, { nodeId: "script", actor: "editor", output: { scriptPath: outside } }),
      /outside run/,
    );
    assert.equal((await subject.show(waiting.id)).revision, waiting.revision);
  });

  it("does not let an override revive a rejected run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rejected-override-"));
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const waiting = await subject.start(brief);
    const rejected = await subject.decide(waiting.id, {
      interventionId: waiting.interventions.at(-1)!.id,
      action: "reject",
      actor: "director",
    });

    await assert.rejects(
      () => subject.applyNodeOverride(rejected.id, {
        nodeId: "script",
        actor: "editor",
        output: rejected.nodeRuns.find((node) => node.nodeId === "script")!.output,
      }),
      /must be restarted/,
    );
    assert.equal((await subject.show(rejected.id)).status, "rejected");
  });

  it("persists a manual review pause and resumes in another instance without rerunning media nodes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const ProductionPipeline = (pipeline as { ProductionPipeline?: new (options: {
      workspaceRoot: string;
      worker: FakeWorker;
      clock: () => string;
      idFactory: (prefix: string) => string;
    }) => {
      start: (brief: unknown) => Promise<{ id: string; status: string; interventions: Array<{ id: string }> }>;
      decide: (runId: string, decision: { interventionId: string; action: "approve"; actor: string; note: string }) => Promise<{ status: string; decisions: Array<{ actor: string }>; artifacts: Artifact[] }>;
    } }).ProductionPipeline;
    assert.equal(typeof ProductionPipeline, "function");
    let nextId = 1;
    const idFactory = (prefix: string): string => `${prefix}-${nextId++}`;
    const options = {
      workspaceRoot,
      worker,
      clock: () => "2026-08-21T10:00:00.000Z",
      idFactory,
    };
    const firstProcess = new ProductionPipeline!(options);

    const waiting = await firstProcess.start(brief);

    assert.equal(waiting.status, "needs_human");
    assert.equal(worker.calls.length, 5);
    assert.deepEqual(worker.calls.map((call) => call.capability), [
      "script.draft",
      "asset.prepare",
      "voice.synthesize",
      "video.render",
      "quality.review",
    ]);
    const assetCall = worker.calls[1];
    assert.equal((assetCall?.parameters as Record<string, unknown>).provider, "local");
    const voiceParameters = worker.calls[2]?.parameters as Record<string, unknown>;
    assert.equal(voiceParameters.profileId, "macos:Sandy (中文（中国大陆）)");
    assert.equal(voiceParameters.voice, "Sandy (中文（中国大陆）)");
    assert.equal(voiceParameters.rate, 178);
    assert.equal(voiceParameters.pauseScale, 1.25);
    assert.equal(voiceParameters.masteringPreset, "intimate");
    const persisted = JSON.parse(
      await readFile(path.join(workspaceRoot, "runs", waiting.id, "run.json"), "utf8"),
    );
    assert.equal(persisted.status, "needs_human");

    const secondProcess = new ProductionPipeline!(options);
    const approved = await secondProcess.decide(waiting.id, {
      interventionId: waiting.interventions[0]!.id,
      action: "approve",
      actor: "director",
      note: "Picture, subtitles and narration are aligned.",
    });

    assert.equal(approved.status, "succeeded");
    assert.equal(approved.decisions[0]?.actor, "director");
    assert.equal(worker.calls.length, 5);
    const publishArtifact = approved.artifacts.find((artifact) => artifact.kind === "publish_package");
    assert.ok(publishArtifact?.uri);
    const publishPackage = JSON.parse(await readFile(publishArtifact.uri, "utf8"));
    assert.equal(publishPackage.approval.actor, "director");
    assert.equal(publishPackage.platform, "douyin");
    const packageBytes = await readFile(publishArtifact.uri);
    assert.equal(publishArtifact.sha256, createHash("sha256").update(packageBytes).digest("hex"));
    assert.equal(publishArtifact.sizeBytes, packageBytes.byteLength);
    const voiceArtifact = approved.artifacts.find((artifact) => artifact.producer?.nodeId === "voice");
    assert.ok(voiceArtifact);
    const parentNodes = (voiceArtifact.parentArtifactIds ?? []).map((parentId) =>
      approved.artifacts.find((artifact) => artifact.id === parentId)?.producer?.nodeId,
    );
    assert.deepEqual(parentNodes, ["script"]);
  });

  it("rejects provider IDs that do not serve the bound capability", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });

    await assert.rejects(
      () => subject.start({
        ...brief,
        providers: { ...brief.providers, assets: "python-template-v1" },
      }),
      /cannot serve capability 'asset.prepare'/,
    );
    assert.equal(worker.calls.length, 0);
  });

  it("passes bounded economics to a metered visual provider", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: [{
        id: "seedance-video-v1",
        label: "Seedance",
        modelId: "seedance-v1",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 2,
        maxAttempts: 1,
      }],
    });

    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 4,
      },
    });
    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(plan);
    await subject.authorizeSpend(paused.id, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    const parameters = worker.calls.find((call) => call.capability === "asset.prepare")?.parameters as Record<string, unknown>;
    assert.equal(parameters.provider, "seedance");
    assert.equal(parameters.maxPaidShots, 1);
    assert.equal(parameters.maxCostCny, 4);
    assert.equal(parameters.maxAttempts, 1);
  });

  it("fails closed when a known metered worker has no runtime metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-missing-metered-metadata-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });

    await assert.rejects(
      () => subject.start({
        ...brief,
        providers: { ...brief.providers, assets: "hailuo-video-v1" },
        economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 3 },
      }),
      /requires runtime metadata/,
    );
    assert.equal(worker.calls.length, 0);
  });

  it("runs an AI director before assets and passes its per-shot plan to the router", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    let directorInput: pipeline.VisualDirectorAgentInput | undefined;
    const directorAgent: pipeline.VisualDirectorAgent = {
      id: "api-visual-director-v1",
      plan: async (input) => {
        directorInput = input;
        return ({
        version: "video-factory/director-plan-v1",
        requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer",
        profileRationale: "本题需要真实动作与食物细节。",
        visualBible: {
          narrativeApproach: "用动作建立问题，再给出具体证据。",
          pacing: "前快后稳",
          composition: "环境中景与手部特写交替",
          camera: "轻微手持",
          color: "自然暖色",
          continuity: "同一早餐时段",
          sound: "保留摊位环境声",
        },
        shots: input.scenes.map((scene, index) => ({
          scenePosition: scene.position,
          narrativeRole: index === 0 ? "钩子" : "证据",
          authenticityPolicy: index === 0 ? "illustrative" : "evidence",
          preferredProviderId: index === 0 ? "local-editorial-v1" : "pexels-stock-v1",
          deliveryType: index === 0 ? "editorial_card" : "stock_video",
          alternativeProviderIds: [],
          temporalBeats: [
            `[0s-${scene.duration / 2}s] 建立主体与环境`,
            `[${scene.duration / 2}s-${scene.duration}s] 保持构图并完成镜头意图`,
          ],
          query: scene.visualPrompt,
          generationPrompt: scene.visualPrompt,
          rationale: "逐镜选择，与经济策略无固定对应。",
          continuityNote: "保持同一时间和暖色调。",
          confidence: 0.8,
          estimatedCostCny: 0,
        })),
        });
      },
    };
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent,
      assetProviders: [
        { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video", "stock_image"] },
      ],
    });

    const templateSnapshot = {
      templateId: "knowledge-explainer",
      templateVersion: 1,
      resolvedAt: "2026-08-27T00:00:00.000Z",
      resolvedBlueprint: {
        platform: "douyin",
        durationSeconds: 24,
        automationLevel: "assisted",
        storyStructure: [{ id: "question", label: "提出问题", purpose: "从日常误解切入", required: true }],
        shotSlots: [{ id: "shot-question", beatId: "question", purpose: "建立问题", durationSeconds: 6, allowedCapabilities: ["asset.search"], manualReplacement: true }],
        visualSystem: { composition: "一个镜头一个概念", colorIntent: "自然底色", subtitleDensity: "medium", pacing: "measured" },
        soundSystem: { voiceIntent: "可信", pace: "medium", musicIntent: "克制" },
        qualityRules: [{ id: "facts", label: "事实准确", dimension: "factual", required: true, threshold: 80 }],
        capabilityRequirements: [{ capability: "storyboard.plan", required: true }],
        costPolicy: { currency: "CNY", maxCost: 0, maxPaidShots: 0 },
      },
      sourceLayers: [{ layer: "template", sourceId: "knowledge-explainer@1", appliedFields: ["visualSystem"] }],
      fieldSources: { visualSystem: "template" },
    } as const;
    const run = await subject.start({
      ...brief,
      templateSnapshot,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: {
        profileId: "auto",
        assetProviderIds: ["local-editorial-v1", "pexels-stock-v1"],
      },
    });

    assert.deepEqual(["brief", "script", "visual-direction", "assets"].map((id) => {
      const node = run.nodeRuns.find((item) => item.nodeId === id);
      return [node?.nodeId, node?.role];
    }), [
      ["brief", "制片人"],
      ["script", "编剧"],
      ["visual-direction", "导演"],
      ["assets", "素材导演"],
    ]);
    const directorArtifact = run.artifacts.find((artifact) => artifact.kind === "storyboard");
    assert.ok(directorArtifact?.uri);
    const plan = JSON.parse(await readFile(directorArtifact.uri, "utf8"));
    assert.deepEqual(plan.shots.map((shot: { preferredProviderId: string }) => shot.preferredProviderId), [
      "local-editorial-v1",
      "pexels-stock-v1",
    ]);
    const assetCall = worker.calls.find((call) => call.capability === "asset.prepare");
    assert.equal((assetCall?.input as Record<string, unknown>).directorPlanPath, directorArtifact.uri);
    assert.deepEqual(directorInput?.brief.templateBlueprint, templateSnapshot.resolvedBlueprint);
    assert.equal(directorInput?.scenes[0]?.onScreenText, "早餐第一步");
    assert.equal(directorInput?.scenes[0]?.soundCue, "摊位环境声");
  });

  it("routes a Kokoro profile through the local neural voice provider", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });

    await subject.start({
      ...brief,
      providers: { ...brief.providers, voice: "kokoro-local-v1" },
      voiceDirection: {
        profileId: "kokoro:zf_001",
        rate: 180,
        pauseScale: 1.1,
        masteringPreset: "social",
      },
    });

    const parameters = worker.calls.find((call) => call.capability === "voice.synthesize")?.parameters as Record<string, unknown>;
    assert.equal(parameters.provider, "kokoro");
    assert.equal(parameters.voice, "zf_001");
    assert.equal(parameters.profileId, "kokoro:zf_001");
  });

  it("routes a MiniMax actor through cloud speech synthesis", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: [{
        id: "minimax-tts-v1",
        label: "MiniMax TTS",
        modelId: "speech-2.5-hd-preview",
        transport: "http_api",
        billing: "metered",
        billingUnit: "run",
        estimatedCostCny: 0.1,
        maxAttempts: 1,
      }],
    });

    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
      voiceDirection: {
        profileId: "minimax:Chinese (Mandarin)_News_Anchor",
        rate: 190,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    });
    const plan = paused.nodeRuns.find((node) => node.nodeId === "voice")?.spendPlan;
    assert.ok(plan);
    assert.equal(plan.maxCostCny, 0.1);
    await subject.authorizeSpend(paused.id, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    const parameters = worker.calls.find((call) => call.capability === "voice.synthesize")?.parameters as Record<string, unknown>;
    assert.equal(parameters.provider, "minimax");
    assert.equal(parameters.voice, "Chinese (Mandarin)_News_Anchor");
    assert.equal(parameters.profileId, "minimax:Chinese (Mandarin)_News_Anchor");
  });

  it("lists persisted runs through the production service", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const first = await subject.start(brief);
    const second = await subject.start({ ...brief, title: "第二条视频" });

    const runs = await subject.list();

    assert.deepEqual(runs.map((run) => run.id), [second.id, first.id]);
  });

  it("shows a historical run even when its persisted workflow version is older", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const runRoot = path.join(workspaceRoot, "runs", "run-historical");
    await mkdir(runRoot, { recursive: true });
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify({
      id: "run-historical",
      revision: 0,
      workflowId: "daily-production",
      workflowVersion: "0.9.0",
      status: "succeeded",
      initialInput: brief,
      startedAt: "2026-08-20T08:00:00.000Z",
      finishedAt: "2026-08-20T08:00:01.000Z",
      nodeRuns: [{
        nodeId: "brief",
        status: "succeeded",
        output: brief,
        artifactIds: [],
        qualityGateResults: [],
      }],
      artifacts: [],
      interventions: [],
      decisions: [],
    }, null, 2)}\n`, "utf8");
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });

    const historical = await subject.show("run-historical");

    assert.equal(historical.workflowVersion, "0.9.0");
    assert.ok(historical.nodeRuns[0]?.outputState?.effectiveVersionId);
  });

  it("preserves a rejected technical-review artifact and does not package it", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker("quality.review");
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });

    const rejected = await subject.start(brief);

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.interventions.length, 0);
    assert.equal(rejected.nodeRuns.at(-1)?.error, undefined);
    assert.ok(rejected.artifacts.some((artifact) => artifact.kind === "quality_review"));
    assert.ok(!rejected.artifacts.some((artifact) => artifact.kind === "publish_package"));
    const persisted = JSON.parse(await readFile(path.join(workspaceRoot, "runs", rejected.id, "run.json"), "utf8"));
    assert.equal(persisted.status, "rejected");
  });

  it("supports automatic final review without a human intervention", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });

    const completed = await subject.start({ ...brief, reviewMode: "automatic" });

    assert.equal(completed.status, "succeeded");
    assert.equal(completed.interventions.length, 0);
    assert.equal(worker.calls.length, 5);
    const publishArtifact = completed.artifacts.find((artifact) => artifact.kind === "publish_package");
    assert.ok(publishArtifact?.uri);
    const publishPackage = JSON.parse(await readFile(publishArtifact.uri, "utf8"));
    assert.equal(publishPackage.approval.actor, "automatic-review");
  });

  it("persists the active node before its worker finishes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "script.draft") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new BlockingWorker(),
      idFactory: () => "run-checkpoint",
    });

    const runningPromise = subject.start(brief);
    await entered;
    const checkpoint = JSON.parse(
      await readFile(path.join(workspaceRoot, "runs", "run-checkpoint", "run.json"), "utf8"),
    );
    assert.equal(checkpoint.status, "running");
    assert.deepEqual(
      checkpoint.nodeRuns.map((node: { nodeId: string; status: string }) => [node.nodeId, node.status]),
      [["brief", "succeeded"], ["script", "running"]],
    );
    releaseResolve();
    assert.equal((await runningPromise).status, "needs_human");
  });

  it("dispatches after the initial checkpoint while completion continues", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "script.draft") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    let nextId = 1;
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new BlockingWorker(),
      idFactory: (prefix) => prefix === "run" ? "run-web" : `${prefix}-${nextId++}`,
    });
    const snapshots: Array<{ status: string; nodes: string[] }> = [];

    const dispatched = await subject.dispatch(brief, (run) => {
      snapshots.push({ status: run.status, nodes: run.nodeRuns.map((node) => node.nodeId) });
    });

    assert.equal(dispatched.runId, "run-web");
    assert.equal((await subject.show(dispatched.runId)).status, "running");
    await entered;
    assert.deepEqual(snapshots[0], { status: "running", nodes: [] });
    releaseResolve();
    assert.equal((await dispatched.completion).status, "needs_human");
    assert.equal(snapshots.at(-1)?.status, "needs_human");
  });

  it("marks persisted running work as interrupted when a new process starts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const runRoot = path.join(workspaceRoot, "runs", "run-interrupted");
    await mkdir(runRoot, { recursive: true });
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify({
      id: "run-interrupted",
      revision: 0,
      workflowId: "daily-production",
      workflowVersion: "1.0.0",
      status: "running",
      initialInput: brief,
      startedAt: "2026-08-24T08:00:00.000Z",
      nodeRuns: [{
        nodeId: "brief",
        status: "succeeded",
        startedAt: "2026-08-24T08:00:00.000Z",
        finishedAt: "2026-08-24T08:00:01.000Z",
        artifactIds: [],
        qualityGateResults: [],
      }],
      artifacts: [],
      interventions: [],
      decisions: [],
    }, null, 2)}\n`, "utf8");
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new FakeWorker(),
      clock: () => "2026-08-24T09:00:00.000Z",
    });

    const recovered = await subject.recoverInterruptedRuns();
    const persisted = await subject.show("run-interrupted");

    assert.equal(recovered, 1);
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.finishedAt, "2026-08-24T09:00:00.000Z");
    assert.equal(persisted.revision, 1);
    assert.equal(persisted.nodeRuns.at(-1)?.nodeId, "script");
    assert.match(persisted.nodeRuns.at(-1)?.error ?? "", /应用重启/);
  });

  it("does not recover a run owned by a live execution lease", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "script.draft") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const owner = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new BlockingWorker(),
      idFactory: (prefix) => prefix === "run" ? "run-live" : `${prefix}-live`,
      executionLeaseHeartbeatMs: 10,
    });
    const observer = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });

    const dispatched = await owner.dispatch(brief);
    await entered;

    assert.equal(await observer.recoverInterruptedRuns({ leaseStaleAfterMs: 1_000 }), 0);
    assert.equal((await observer.show(dispatched.runId)).status, "running");

    releaseResolve();
    assert.equal((await dispatched.completion).status, "needs_human");
    await assert.rejects(
      readFile(path.join(workspaceRoot, "runs", dispatched.runId, ".execution-lease.json"), "utf8"),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
  });

  it("blocks node edits while another process owns the execution lease", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "script.draft") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const owner = new pipeline.ProductionPipeline({ workspaceRoot, worker: new BlockingWorker() });
    const editor = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const dispatched = await owner.dispatch(brief);
    await entered;
    const active = await editor.show(dispatched.runId);
    const briefNode = active.nodeRuns.find((node) => node.nodeId === "brief")!;
    const expectedVersionId = briefNode.outputState?.effectiveVersionId;
    assert.ok(expectedVersionId);

    try {
      await assert.rejects(
        () => editor.applyNodeOverride(dispatched.runId, {
          nodeId: "brief",
          actor: "editor",
          output: briefNode.output,
          expectedVersionId,
        }),
        pipeline.RunLockedError,
      );
    } finally {
      releaseResolve();
    }
    await dispatched.completion;
  });

  it("marks the director node as interrupted when a directed run stops after scripting", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const runRoot = path.join(workspaceRoot, "runs", "run-director-interrupted");
    const directedBrief = {
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: {
        profileId: "auto",
        assetProviderIds: ["local-editorial-v1"],
      },
    } as const;
    await mkdir(runRoot, { recursive: true });
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify({
      id: "run-director-interrupted",
      revision: 0,
      workflowId: "daily-production",
      workflowVersion: "1.1.0",
      status: "running",
      initialInput: directedBrief,
      startedAt: "2026-08-24T08:00:00.000Z",
      nodeRuns: ["brief", "script"].map((nodeId) => ({
        nodeId,
        status: "succeeded",
        startedAt: "2026-08-24T08:00:00.000Z",
        finishedAt: "2026-08-24T08:00:01.000Z",
        artifactIds: [],
        qualityGateResults: [],
      })),
      artifacts: [],
      interventions: [],
      decisions: [],
    }, null, 2)}\n`, "utf8");
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new FakeWorker(),
      clock: () => "2026-08-24T09:00:00.000Z",
    });

    await subject.recoverInterruptedRuns();
    const persisted = await subject.show("run-director-interrupted");

    assert.equal(persisted.nodeRuns.at(-1)?.nodeId, "visual-direction");
  });

  it("serializes concurrent approvals before publish side effects", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    let nextId = 1;
    const idCounts = new Map<string, number>();
    const options = {
      workspaceRoot,
      worker,
      idFactory: (prefix: string): string => {
        idCounts.set(prefix, (idCounts.get(prefix) ?? 0) + 1);
        return `${prefix}-${nextId++}`;
      },
    };
    const waiting = await new pipeline.ProductionPipeline(options).start(brief);
    const decision = {
      interventionId: waiting.interventions[0]!.id,
      action: "approve" as const,
      actor: "director",
    };

    const results = await Promise.allSettled([
      new pipeline.ProductionPipeline(options).decide(waiting.id, decision),
      new pipeline.ProductionPipeline(options).decide(waiting.id, decision),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const persisted = await new pipeline.ProductionPipeline(options).show(waiting.id);
    assert.equal(persisted.revision, 1);
    assert.equal(persisted.decisions.length, 1);
    assert.equal(worker.calls.length, 5);
    assert.equal(idCounts.get("decision"), 1);
  });

  it("pauses before a metered worker and only calls it after the exact spend plan is approved", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: [{
        id: "hailuo-video-v1",
        label: "MiniMax 海螺关键镜头",
        modelId: "MiniMax-Hailuo-02",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 2.4,
        maxAttempts: 1,
      }],
    });
    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 3 },
    });

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.deepEqual(worker.calls.map((call) => call.capability), ["script.draft"]);
    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(plan);
    assert.deepEqual({ providerId: plan.providerId, modelId: plan.modelId, estimated: plan.estimatedCostCny, max: plan.maxCostCny }, {
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      estimated: 2.4,
      max: 3,
    });

    const resumed = await subject.authorizeSpend(paused.id, {
      nodeId: "assets",
      inputVersionIds: [...plan.inputVersionIds],
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "owner",
    });

    assert.equal(resumed.status, "needs_human");
    assert.ok(worker.calls.some((call) => call.capability === "asset.prepare"));
    assert.equal(resumed.nodeRuns.find((node) => node.nodeId === "assets")?.executionReceipt?.billing, "metered");
  });

  it("persists spend authorization and the running paid node before the provider finishes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-checkpoint-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingPaidWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "asset.prepare") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new BlockingPaidWorker(),
      executionLeaseHeartbeatMs: 10,
      providerRuntimeMetadata: [{
        id: "hailuo-video-v1",
        label: "MiniMax 海螺关键镜头",
        modelId: "MiniMax-Hailuo-02",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 2.4,
        maxAttempts: 1,
      }],
    });
    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1" },
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true, maxPaidShots: 1, maxCostCny: 3 },
    });
    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")!.spendPlan!;
    const completion = subject.authorizeSpend(paused.id, {
      nodeId: plan.nodeId,
      inputVersionIds: [...plan.inputVersionIds],
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "owner",
    });

    await entered;
    const persisted = await subject.show(paused.id);
    assert.equal(persisted.status, "running");
    assert.equal(persisted.spendAuthorizations?.length, 1);
    assert.equal(persisted.nodeRuns.find((node) => node.nodeId === "assets")?.status, "running");
    const observer = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    assert.equal(await observer.recoverInterruptedRuns({ leaseStaleAfterMs: 1_000 }), 0);

    releaseResolve();
    assert.equal((await completion).status, "needs_human");
  });

  it("fails a node when the worker artifact bytes do not match its descriptor", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    class LyingWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        const response = await super.run(request);
        response.artifacts[0]!.sha256 = "0".repeat(64);
        return response;
      }
    }
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new LyingWorker() });

    const failed = await subject.start(brief);

    assert.equal(failed.status, "failed");
    assert.match(failed.nodeRuns.at(-1)?.error ?? "", /sha256 does not match/);
    assert.equal((await subject.show(failed.id)).status, "failed");
  });

  it("reruns stale nodes in immutable attempt directories and packages only current artifacts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rerun-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });
    const waiting = await subject.start(brief);
    const scriptOutput = waiting.nodeRuns.find((node) => node.nodeId === "script")?.output;
    assert.ok(scriptOutput);
    const firstArtifacts = waiting.artifacts.filter((artifact) => artifact.uri);

    const stale = await subject.applyNodeOverride(waiting.id, {
      nodeId: "script",
      actor: "editor",
      output: scriptOutput,
    });
    assert.equal(stale.interventions.length, 0);
    assert.equal(stale.nodeRuns.find((node) => node.nodeId === "final-review")?.intervention, undefined);
    const rerun = await subject.resumeStale(stale.id);

    assert.equal(rerun.status, "needs_human");
    for (const request of worker.calls.slice(5)) {
      assert.match(String(request.outputDir), /attempt-2$/);
      assert.equal(request.attempt, 2);
    }
    for (const artifact of firstArtifacts) {
      const bytes = await readFile(artifact.uri!);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256, artifact.kind);
    }

    const approved = await subject.decide(rerun.id, {
      interventionId: rerun.interventions.at(-1)!.id,
      action: "approve",
      actor: "director",
    });
    assert.equal(approved.status, "succeeded");
    const packageArtifact = approved.artifacts.find((artifact) => artifact.kind === "publish_package");
    assert.ok(packageArtifact?.uri);
    const payload = JSON.parse(await readFile(packageArtifact.uri, "utf8")) as { artifacts: Artifact[] };
    const packagedUris = payload.artifacts.flatMap((artifact) => artifact.uri ? [artifact.uri] : []);
    assert.equal(new Set(packagedUris).size, packagedUris.length);
    assert.ok(packagedUris.some((uri) => /attempt-2/.test(uri)));
    assert.ok(packagedUris.every((uri) => !/attempt-1/.test(uri) || /nodes\/script\//.test(uri)));
  });

  it("refuses approval when an artifact changed after technical review", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const waiting = await subject.start(brief);
    const renderArtifact = waiting.artifacts.find((artifact) => artifact.producer?.nodeId === "render");
    assert.ok(renderArtifact?.uri);
    await writeFile(renderArtifact.uri, "changed-after-review", "utf8");

    const failed = await subject.decide(waiting.id, {
      interventionId: waiting.interventions[0]!.id,
      action: "approve",
      actor: "director",
    });

    assert.equal(failed.status, "failed");
    assert.match(failed.nodeRuns.at(-1)?.error ?? "", /sha256 does not match/);
    assert.equal((await subject.show(waiting.id)).status, "failed");
  });
});
