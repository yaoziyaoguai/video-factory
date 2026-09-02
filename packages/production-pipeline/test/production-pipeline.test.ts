import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  it("runs GLM visual review through Code Plan without a cash spend approval", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-visual-review-"));
    const worker = new FakeWorker();
    const reviewCalls: pipeline.VisualReviewAgentInput[] = [];
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: [{
        id: "glm-visual-review-v1",
        label: "GLM-5.3-Flash 视觉审片",
        modelId: "glm-5.3-flash",
        transport: "unix_socket",
        billing: "subscription",
        approvalPolicy: "none",
        maxAttempts: 3,
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
          review: async () => { throw new Error("Detailed review must be used."); },
          reviewDetailed: async (input) => {
            reviewCalls.push(input);
            const output: pipeline.VisualReviewReport = {
              version: "video-factory/visual-review-v1",
              summary: "画面可进入人工终审。",
              scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 95 },
              findings: [],
              confidence: 0.8,
              recommendation: "approve",
            };
            return {
              output,
              agentLoop: {
                version: "video-factory/agent-loop-v1",
                role: "视觉审片员",
                contractVersion: "visual-review-test-v1",
                criteria: ["忠于画面证据"],
                status: "passed",
                maxIterations: 3,
                modelCallCount: 3,
                producerModelCallCount: 2,
                auditModelCallCount: 1,
                iterations: [],
              },
            };
          },
        },
      ],
    });

    const waiting = await subject.start({
      ...brief,
      providers: { ...brief.providers, visualReview: "glm-visual-review-v1" },
    });

    assert.equal(waiting.status, "needs_human");
    assert.equal(waiting.workflowVersion, "1.2.0");
    assert.equal(reviewCalls.length, 1);
    assert.match(reviewCalls[0]!.videoPath, /final\.mp4$/);
    assert.match(reviewCalls[0]!.renderManifestPath ?? "", /render_manifest\.json$/);
    assert.ok(waiting.nodeRuns.some((node) => node.nodeId === "visual-review" && node.status === "succeeded"));
    assert.equal(waiting.nodeRuns.find((node) => node.nodeId === "visual-review")?.executionReceipt?.modelId, "glm-5.3-flash");
    assert.equal(waiting.nodeRuns.find((node) => node.nodeId === "visual-review")?.spendPlan, undefined);
    assert.equal(waiting.nodeRuns.find((node) => node.nodeId === "visual-review")?.executionReceipt?.billing, "subscription");
    assert.equal(waiting.nodeRuns.find((node) => node.nodeId === "visual-review")?.executionReceipt?.estimatedCostCny, 0);
    assert.ok(waiting.artifacts.some((artifact) => artifact.kind === "review_report" && artifact.provenance.providerId === "glm-visual-review-v1"));
  });

  it("fails closed when the Code Plan visual reviewer has no subscription metadata", async () => {
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
    }), /must use subscription billing without spend approval/);
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

  it("requires confirmation before creating a revision from a rejected run", async () => {
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
      /explicit confirmation/,
    );
    assert.equal((await subject.show(rejected.id)).status, "rejected");

    const revised = await subject.applyNodeOverride(rejected.id, {
      nodeId: "script",
      actor: "editor",
      output: rejected.nodeRuns.find((node) => node.nodeId === "script")!.output,
      allowTerminalEdit: true,
    });
    assert.equal(revised.status, "stale");
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
    assert.deepEqual(parentNodes, ["script", "assets"]);
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

  it("authorizes every required scene for a direct metered visual provider", async () => {
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
    assert.equal(parameters.maxPaidShots, undefined);
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
      modelId: "gpt-5.6-terra",
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
      },
      sourceLayers: [{ layer: "template", sourceId: "knowledge-explainer@1", appliedFields: ["visualSystem"] }],
      fieldSources: { visualSystem: "template" },
    };
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
    assert.equal(
      run.nodeRuns.find((node) => node.nodeId === "visual-direction")?.executionReceipt?.parameters?.promptPack,
      "video-factory/director-v10",
    );
    assert.equal(
      run.nodeRuns.find((node) => node.nodeId === "visual-direction")?.executionReceipt?.modelId,
      "gpt-5.6-terra",
    );
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

  it("re-synthesizes voice with a human-edited node input", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });
    const waiting = await subject.start(brief);
    const voiceNode = waiting.nodeRuns.find((node) => node.nodeId === "voice");
    const originalInput = voiceNode?.inputState?.versions.find(
      (version) => version.id === voiceNode.inputState?.effectiveVersionId,
    )?.value as Record<string, unknown> | undefined;
    assert.ok(originalInput);
    assert.equal(originalInput.voice, "Sandy (中文（中国大陆）)");
    assert.equal(originalInput.rate, 178);

    const stale = await subject.applyNodeInputOverride(waiting.id, {
      nodeId: "voice",
      actor: "producer",
      input: {
        ...originalInput,
        voice: "Tingting",
        rate: 166,
        pause_scale: 1.1,
        mastering_preset: "social",
      },
    });
    assert.equal(stale.status, "stale");
    assert.equal(stale.nodeRuns.find((node) => node.nodeId === "voice")?.status, "stale");

    const rerun = await subject.resumeStale(waiting.id);
    const voiceCalls = worker.calls.filter((call) => call.capability === "voice.synthesize");
    assert.equal(voiceCalls.length, 2);
    assert.deepEqual(voiceCalls.at(-1)?.input, {
      scriptPath: originalInput.scriptPath,
      voice: "Tingting",
      rate: 166,
      pause_scale: 1.1,
      mastering_preset: "social",
    });
    const receipt = rerun.nodeRuns.find((node) => node.nodeId === "voice")?.executionReceipt;
    assert.equal(receipt?.parameters?.voice, "Tingting");
    assert.equal(receipt?.parameters?.rate, 166);
    assert.equal(receipt?.parameters?.pauseScale, 1.1);
    assert.equal(receipt?.parameters?.masteringPreset, "social");
  });

  it("routes a MiniMax actor through cloud speech synthesis", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const directorAgent: pipeline.VisualDirectorAgent = {
      id: "api-visual-director-v1",
      plan: async (input) => ({
        version: "video-factory/director-plan-v1",
        requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer",
        profileRationale: "用真实动作建立可信解释。",
        visualBible: {
          narrativeApproach: "用动作展示问题和结果。",
          pacing: "均匀推进",
          composition: "中景与特写交替",
          camera: "稳定机位",
          color: "自然色",
          continuity: "同一时段",
          sound: "保留环境声",
        },
        shots: input.scenes.map((scene) => ({
          scenePosition: scene.position,
          narrativeRole: "解释",
          authenticityPolicy: "illustrative",
          preferredProviderId: "local-editorial-v1",
          deliveryType: "editorial_card",
          alternativeProviderIds: [],
          temporalBeats: [
            `[0s-${scene.duration / 2}s] 建立信息`,
            `[${scene.duration / 2}s-${scene.duration}s] 保持可读`,
          ],
          query: scene.visualPrompt,
          generationPrompt: scene.visualPrompt,
          rationale: "免费本地卡片足以交付。",
          continuityNote: "保持相同版式。",
          confidence: 0.8,
          estimatedCostCny: 0,
        })),
      }),
    };
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent,
      assetProviders: [{
        id: "local-editorial-v1",
        label: "本地编辑卡片",
        billing: "free",
        modes: ["本地"],
        deliveryTypes: ["editorial_card"],
      }],
      providerRuntimeMetadata: [{
        id: "minimax-tts-v1",
        label: "MiniMax TTS",
        modelId: "speech-2.5-hd-preview",
        transport: "http_api",
        billing: "metered",
        approvalPolicy: "automatic",
        billingUnit: "run",
        estimatedCostCny: 0.1,
        maxAttempts: 1,
      }],
    });

    const completed = await subject.start({
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        voice: "minimax-tts-v1",
      },
      director: {
        profileId: "auto",
        assetProviderIds: ["local-editorial-v1"],
      },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
      voiceDirection: {
        profileId: "minimax:Chinese (Mandarin)_News_Anchor",
        rate: 190,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    });
    const voiceNode = completed.nodeRuns.find((node) => node.nodeId === "voice");
    const assetsNode = completed.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(assetsNode?.status, "succeeded");
    assert.equal(voiceNode?.status, "succeeded", JSON.stringify({ status: completed.status, voiceNode }));
    assert.equal(voiceNode?.spendPlan, undefined);
    assert.equal(voiceNode?.executionReceipt?.billing, "metered");
    assert.equal(voiceNode?.executionReceipt?.estimatedCostCny, 0.1);
    assert.ok(worker.calls.some((call) => call.capability === "voice.synthesize"));

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

  it("dispatches a failed-node retry after its running checkpoint instead of holding the web request", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-retry-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class RetriableWorker extends FakeWorker {
      failScript = true;
      blockRetry = false;

      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "script.draft" && this.failScript) {
          this.failScript = false;
          throw new Error("temporary script failure");
        }
        if (request.capability === "script.draft" && this.blockRetry) {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const worker = new RetriableWorker();
    let nextId = 1;
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      idFactory: (prefix) => prefix === "run" ? "run-retry-web" : `${prefix}-${nextId++}`,
    });
    const failed = await subject.start(brief);
    assert.equal(failed.status, "failed");
    worker.blockRetry = true;

    const dispatched = await subject.dispatchRetryFailedNode(failed.id, "script");

    assert.equal(dispatched.runId, failed.id);
    assert.equal((await subject.show(failed.id)).status, "running");
    await entered;
    releaseResolve();
    assert.equal((await dispatched.completion).status, "needs_human");
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

  it("locks an interrupted authorized paid node until its provider outcome is reconciled", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-interrupted-"));
    const runRoot = path.join(workspaceRoot, "runs", "run-paid-interrupted");
    await mkdir(runRoot, { recursive: true });
    await writeFile(path.join(runRoot, "run.json"), `${JSON.stringify({
      id: "run-paid-interrupted",
      revision: 0,
      workflowId: "daily-production",
      workflowVersion: "1.0.0",
      status: "running",
      initialInput: brief,
      startedAt: "2026-08-24T08:00:00.000Z",
      nodeRuns: [{
        nodeId: "assets",
        status: "running",
        startedAt: "2026-08-24T08:00:00.000Z",
        operationRequestId: "paid-operation-1",
        spendAuthorizationId: "authorization-1",
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

    assert.equal(await subject.recoverInterruptedRuns(), 1);
    const recovered = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as {
      nodeRuns: Array<{ interrupted?: boolean; outcomeUncertain?: boolean; operationRequestId?: string }>;
    };
    assert.equal(recovered.nodeRuns[0]?.interrupted, true);
    assert.equal(recovered.nodeRuns[0]?.outcomeUncertain, true);
    assert.equal(recovered.nodeRuns[0]?.operationRequestId, "paid-operation-1");
  });

  it("reconciles an accepted paid task under the original operation id without new approval", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-reconcile-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingReconciliationWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "asset.prepare") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const worker = new BlockingReconciliationWorker();
    const options: pipeline.ProductionPipelineOptions = {
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
    };
    const subject = new pipeline.ProductionPipeline(options);
    const interrupted = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });
    const assetsNode = interrupted.nodeRuns.find((node) => node.nodeId === "assets");
    const scriptPath = String((interrupted.nodeRuns.find((node) => node.nodeId === "script")?.output as Record<string, unknown>)?.scriptPath);
    assert.ok(assetsNode);
    const operationId = "accepted-operation-1";
    assetsNode.status = "failed";
    assetsNode.operationRequestId = operationId;
    assetsNode.spendAuthorizationId = "authorization-before-crash";
    assetsNode.outcomeUncertain = true;
    assetsNode.interrupted = true;
    assetsNode.error = "process exited while polling";
    interrupted.status = "failed";
    interrupted.finishedAt = "2026-08-24T09:00:00.000Z";
    await writeFile(
      path.join(workspaceRoot, "runs", interrupted.id, "run.json"),
      `${JSON.stringify(interrupted, null, 2)}\n`,
      "utf8",
    );

    const sourceFingerprint = await pipeline.paidAssetSourceFingerprint([scriptPath]);
    const ledgerDirectory = path.join(workspaceRoot, "runs", interrupted.id, "nodes", "assets", ".generation-operations");
    await mkdir(ledgerDirectory, { recursive: true });
    await writeFile(
      path.join(ledgerDirectory, `${createHash("sha256").update(operationId).digest("hex")}.json`),
      `${JSON.stringify({
        version: "video-factory/paid-operation-v2",
        operationId,
        completed: false,
        items: [{
          itemRequestId: "accepted-scene-1",
          quoteItemId: "scene-1",
          inputFingerprint: "accepted-input-1",
          sourceFingerprint,
          scenePosition: 1,
          executorProviderId: "hailuo-video-v1",
          providerId: "hailuo-video-v1",
          modelId: "MiniMax-Hailuo-02",
          parameters: { mediaType: "video", durationSeconds: 5, ratio: "9:16" },
          state: "submitted",
          estimatedCostCny: 2.4,
          actualCostCny: 2.4,
          actualCostSource: "configured_rate",
        }, {
          itemRequestId: "carried-scene-2",
          quoteItemId: "scene-2",
          inputFingerprint: "carried-input-2",
          sourceFingerprint,
          scenePosition: 2,
          executorProviderId: "hailuo-video-v1",
          providerId: "hailuo-video-v1",
          modelId: "MiniMax-Hailuo-02",
          parameters: { mediaType: "video", durationSeconds: 5, ratio: "9:16" },
          state: "materialized",
          estimatedCostCny: 2.4,
          taskId: "carried-task-2",
          resultUrl: "https://provider.example/carried-scene-2.mp4",
          carriedForwardFromItemRequestId: "older-scene-2",
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    const pendingReconciliation = await subject.inspectPaidNode(interrupted.id, "assets");
    assert.equal(pendingReconciliation.recommendedOutcome, undefined);
    assert.equal(pendingReconciliation.requiresManualReconciliation, true);
    assert.deepEqual(pendingReconciliation.items.map((item) => ({ state: item.state, taskId: item.taskId })), [
      { state: "submitted", taskId: undefined },
      { state: "materialized", taskId: "carried-task-2" },
    ]);
    assert.equal("resultUrl" in pendingReconciliation.items[0]!, false);
    assert.equal("localPath" in pendingReconciliation.items[0]!, false);

    const operationLedgerPath = path.join(ledgerDirectory, `${createHash("sha256").update(operationId).digest("hex")}.json`);
    const duplicateTaskLedger = JSON.parse(await readFile(operationLedgerPath, "utf8"));
    duplicateTaskLedger.items.push({
      ...duplicateTaskLedger.items[0],
      itemRequestId: "already-bound-scene-2",
      quoteItemId: "scene-2",
      inputFingerprint: "already-bound-input-2",
      scenePosition: 2,
      state: "provider_succeeded",
      taskId: "provider-task-1",
      resultUrl: "https://provider.example/already-bound.mp4",
    });
    await writeFile(operationLedgerPath, `${JSON.stringify(duplicateTaskLedger, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "reject-duplicate-task-binding",
        outcome: "resume_original",
        taskId: "provider-task-1",
      }),
      /exactly one unresolved paid item/,
    );
    duplicateTaskLedger.items.pop();
    await writeFile(operationLedgerPath, `${JSON.stringify(duplicateTaskLedger, null, 2)}\n`, "utf8");

    const reconciliation = subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "reconcile-accepted-operation-1",
      outcome: "resume_original",
      taskId: "provider-task-1",
    });
    await entered;
    const concurrent = await Promise.allSettled([
      new pipeline.ProductionPipeline(options).reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "reconcile-accepted-operation-1",
        outcome: "resume_original",
        taskId: "provider-task-1",
      }),
    ]);
    assert.equal(concurrent[0]?.status, "rejected");
    releaseResolve();
    const reconciled = await reconciliation;

    const assetCall = worker.calls.find((call) => call.capability === "asset.prepare");
    assert.equal(reconciled.status, "needs_human");
    assert.equal(assetCall?.commandId, operationId);
    assert.equal((assetCall?.parameters as Record<string, unknown>).maxCostCny, 0);
    assert.equal(reconciled.nodeRuns.find((node) => node.nodeId === "assets")?.operationRequestId, operationId);
    assert.equal(reconciled.spendAuthorizations?.length ?? 0, 0);
    const operationReceipt = reconciled.executionReceipts?.find((receipt) => receipt.requestId === operationId);
    assert.equal(operationReceipt?.billing, "metered");
    assert.equal(operationReceipt?.actualCostCny, 2.4);
    assert.equal(operationReceipt?.meteredAttemptCount, 1);
    const reconciledLedger = JSON.parse(await readFile(
      operationLedgerPath,
      "utf8",
    )) as { items: Array<{ taskId?: string }> };
    assert.equal(reconciledLedger.items[0]?.taskId, "provider-task-1");

    const callCount = worker.calls.length;
    const replayed = await subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "reconcile-accepted-operation-1",
      outcome: "resume_original",
      taskId: "provider-task-1",
    });
    assert.equal(replayed.revision, reconciled.revision);
    assert.equal(worker.calls.length, callCount);
    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "reconcile-accepted-operation-1",
        outcome: "requote",
      }),
      /conflicts with its persisted request/,
    );

    const crashReplayRun = structuredClone(interrupted);
    crashReplayRun.id = `${interrupted.id}-crash-replay`;
    const crashReplayRoot = path.join(workspaceRoot, "runs", crashReplayRun.id);
    await mkdir(path.join(crashReplayRoot, "nodes", "assets", ".generation-operations"), { recursive: true });
    await writeFile(path.join(crashReplayRoot, "run.json"), `${JSON.stringify(crashReplayRun, null, 2)}\n`, "utf8");
    const attachedLedger = JSON.parse(await readFile(
      operationLedgerPath,
      "utf8",
    ));
    attachedLedger.items[0].state = "provider_succeeded";
    attachedLedger.items[0].resultUrl = "https://provider.example/original-result.mp4";
    await writeFile(
      path.join(crashReplayRoot, "nodes", "assets", ".generation-operations", `${createHash("sha256").update(operationId).digest("hex")}.json`),
      `${JSON.stringify(attachedLedger, null, 2)}\n`,
      "utf8",
    );
    const crashReconciliationId = "reconcile-after-task-id-attachment-crash";
    const crashRecordRoot = path.join(crashReplayRoot, ".paid-reconciliations");
    await mkdir(crashRecordRoot, { recursive: true });
    await writeFile(
      path.join(crashRecordRoot, `${createHash("sha256").update(crashReconciliationId).digest("hex")}.json`),
      `${JSON.stringify({
        version: "video-factory/paid-reconciliation-v1",
        reconciliationId: crashReconciliationId,
        nodeId: "assets",
        outcome: "resume_original",
        taskId: "provider-task-1",
        expectedRunRevision: crashReplayRun.revision,
        status: "in_progress",
        createdAt: "2026-08-24T09:00:00.000Z",
      }, null, 2)}\n`,
      "utf8",
    );
    const crashReplayAssetCallCount = worker.calls.filter((call) => call.capability === "asset.prepare").length;
    const recoveredCrashReplay = await subject.reconcilePaidNode(crashReplayRun.id, {
      nodeId: "assets",
      expectedRunRevision: crashReplayRun.revision,
      reconciliationId: crashReconciliationId,
      outcome: "resume_original",
      taskId: "provider-task-1",
    });
    assert.equal(recoveredCrashReplay.nodeRuns.find((node) => node.nodeId === "assets")?.operationRequestId, operationId);
    const crashReplayAssetCalls = worker.calls.filter((call) => call.capability === "asset.prepare");
    assert.equal(crashReplayAssetCalls.length, crashReplayAssetCallCount + 1);
    assert.equal(crashReplayAssetCalls.at(-1)?.commandId, operationId);
  });

  it("creates an incremental quote for a terminal failure while preserving a materialized scene", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-requote-"));
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
    const interrupted = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });
    const assetsNode = interrupted.nodeRuns.find((node) => node.nodeId === "assets");
    const originalPlan = assetsNode?.spendPlan;
    const scriptPath = String((interrupted.nodeRuns.find((node) => node.nodeId === "script")?.output as Record<string, unknown>)?.scriptPath);
    assert.ok(assetsNode);
    assert.ok(originalPlan);
    const oldOperationId = "terminal-operation-1";
    const oldAuthorizationId = "authorization-before-terminal-failure";
    interrupted.spendAuthorizations = [{
      id: oldAuthorizationId,
      nodeId: originalPlan.nodeId,
      inputVersionIds: originalPlan.inputVersionIds,
      providerId: originalPlan.providerId,
      modelId: originalPlan.modelId,
      maxCostCny: originalPlan.maxCostCny,
      maxAttempts: originalPlan.maxAttempts,
      approvedBy: "owner",
      approvedAt: "2026-08-24T08:00:00.000Z",
    }];
    assetsNode.status = "failed";
    assetsNode.operationRequestId = oldOperationId;
    assetsNode.spendAuthorizationId = oldAuthorizationId;
    assetsNode.outcomeUncertain = true;
    assetsNode.interrupted = true;
    assetsNode.error = "process exited after provider rejection";
    interrupted.status = "failed";
    interrupted.finishedAt = "2026-08-24T09:00:00.000Z";
    await writeFile(
      path.join(workspaceRoot, "runs", interrupted.id, "run.json"),
      `${JSON.stringify(interrupted, null, 2)}\n`,
      "utf8",
    );

    const sourceFingerprint = await pipeline.paidAssetSourceFingerprint([scriptPath]);
    const ledgerDirectory = path.join(workspaceRoot, "runs", interrupted.id, "nodes", "assets", ".generation-operations");
    await mkdir(ledgerDirectory, { recursive: true });
    const baseItem = {
      executorProviderId: "hailuo-video-v1",
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      sourceFingerprint,
      parameters: { mediaType: "video", durationSeconds: 5, ratio: "9:16" },
      estimatedCostCny: 2.4,
    };
    await writeFile(
      path.join(ledgerDirectory, `${createHash("sha256").update(oldOperationId).digest("hex")}.json`),
      `${JSON.stringify({
        version: "video-factory/paid-operation-v2",
        operationId: oldOperationId,
        completed: false,
        items: [
          { ...baseItem, itemRequestId: "materialized-scene-1", quoteItemId: "scene-1", inputFingerprint: "materialized-input-1", scenePosition: 1, state: "materialized" },
          { ...baseItem, itemRequestId: "terminal-scene-2", quoteItemId: "scene-2", inputFingerprint: "terminal-input-2", scenePosition: 2, state: "terminal_failed" },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const pendingReconciliation = await subject.inspectPaidNode(interrupted.id, "assets");
    assert.equal(pendingReconciliation.recommendedOutcome, "requote");

    const requoted = await subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "reconcile-terminal-operation-1",
      outcome: "requote",
    });

    const nextAssets = requoted.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(requoted.status, "awaiting_spend_approval");
    assert.notEqual(nextAssets?.operationRequestId, oldOperationId);
    assert.deepEqual(nextAssets?.spendPlan?.items?.map((item) => item.id), ["scene-2"]);
    assert.equal(worker.calls.filter((call) => call.capability === "asset.prepare").length, 0);
    assert.equal(requoted.spendAuthorizations?.[0]?.id, oldAuthorizationId);
  });

  it("records a trusted not-charged resolution and requotes only unfinished paid scenes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-not-charged-"));
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
    const interrupted = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });
    const assetsNode = interrupted.nodeRuns.find((node) => node.nodeId === "assets");
    const originalPlan = assetsNode?.spendPlan;
    const scriptPath = String((interrupted.nodeRuns.find((node) => node.nodeId === "script")?.output as Record<string, unknown>)?.scriptPath);
    assert.ok(assetsNode);
    assert.ok(originalPlan);
    const oldOperationId = "not-charged-operation-1";
    const oldAuthorizationId = "authorization-before-not-charged-resolution";
    interrupted.spendAuthorizations = [{
      id: oldAuthorizationId,
      nodeId: originalPlan.nodeId,
      inputVersionIds: originalPlan.inputVersionIds,
      providerId: originalPlan.providerId,
      modelId: originalPlan.modelId,
      maxCostCny: originalPlan.maxCostCny,
      maxAttempts: originalPlan.maxAttempts,
      approvedBy: "owner",
      approvedAt: "2026-08-24T08:00:00.000Z",
    }];
    assetsNode.status = "failed";
    assetsNode.operationRequestId = oldOperationId;
    assetsNode.spendAuthorizationId = oldAuthorizationId;
    assetsNode.outcomeUncertain = true;
    assetsNode.interrupted = true;
    assetsNode.error = "process exited before task acceptance was known";
    assetsNode.executionReceipt = {
      nodeId: "assets",
      capability: "asset.prepare",
      providerId: "hailuo-video-v1",
      providerLabel: "MiniMax 海螺关键镜头",
      modelId: "MiniMax-Hailuo-02",
      transport: "http_api",
      billing: "metered",
      status: "failed",
      spendAuthorizationId: oldAuthorizationId,
      authorizedCostCny: originalPlan.maxCostCny,
      estimatedCostCny: originalPlan.estimatedCostCny,
      actualCostCny: originalPlan.estimatedCostCny,
      actualCostSource: "configured_rate",
      meteredAttemptCount: 2,
      meteredFailedAttemptCount: 1,
      requestId: oldOperationId,
      startedAt: "2026-08-24T08:00:00.000Z",
      finishedAt: "2026-08-24T09:00:00.000Z",
    };
    (interrupted.executionReceipts ??= []).push(structuredClone(assetsNode.executionReceipt));
    interrupted.status = "failed";
    interrupted.finishedAt = "2026-08-24T09:00:00.000Z";
    await writeFile(path.join(workspaceRoot, "runs", interrupted.id, "run.json"), `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    const sourceFingerprint = await pipeline.paidAssetSourceFingerprint([scriptPath]);
    const ledgerDirectory = path.join(workspaceRoot, "runs", interrupted.id, "nodes", "assets", ".generation-operations");
    await mkdir(ledgerDirectory, { recursive: true });
    const baseItem = {
      executorProviderId: "hailuo-video-v1",
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      sourceFingerprint,
      parameters: { mediaType: "video", durationSeconds: 5, ratio: "9:16" },
      estimatedCostCny: 2.4,
    };
    await writeFile(
      path.join(ledgerDirectory, `${createHash("sha256").update(oldOperationId).digest("hex")}.json`),
      `${JSON.stringify({
        version: "video-factory/paid-operation-v2",
        operationId: oldOperationId,
        completed: false,
        items: [
          {
            ...baseItem,
            itemRequestId: "succeeded-scene-1",
            quoteItemId: "scene-1",
            inputFingerprint: "succeeded-input-1",
            scenePosition: 1,
            state: "provider_succeeded",
            taskId: "provider-task-scene-1",
            resultUrl: "https://provider.example/scene-1.mp4",
            actualCostCny: 2.4,
            actualCostSource: "configured_rate",
          },
          { ...baseItem, itemRequestId: "unknown-scene-2", quoteItemId: "scene-2", inputFingerprint: "unknown-input-2", scenePosition: 2, state: "unknown" },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const resolved = await subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "confirm-not-charged-operation-1",
      outcome: "confirmed_not_charged",
      actor: "owner",
      note: "Provider 后台确认该任务未受理，也未产生扣费。",
    });

    const nextAssets = resolved.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(resolved.status, "awaiting_spend_approval");
    assert.notEqual(nextAssets?.operationRequestId, oldOperationId);
    assert.deepEqual(nextAssets?.spendPlan?.items?.map((item) => item.id), ["scene-2"]);
    assert.deepEqual(resolved.consumedSpendAuthorizationIds, [oldAuthorizationId]);
    assert.equal(worker.calls.filter((call) => call.capability === "asset.prepare").length, 0);
    const settledReceipt = resolved.executionReceipts?.find((receipt) => receipt.requestId === oldOperationId);
    assert.equal(settledReceipt?.actualCostCny, 2.4);
    assert.equal(settledReceipt?.meteredAttemptCount, 1);
    assert.equal(settledReceipt?.meteredFailedAttemptCount, 0);
    const persistedLedger = JSON.parse(await readFile(
      path.join(ledgerDirectory, `${createHash("sha256").update(oldOperationId).digest("hex")}.json`),
      "utf8",
    )) as { items: Array<{ state: string }> };
    assert.deepEqual(persistedLedger.items.map((item) => item.state), ["provider_succeeded", "terminal_failed"]);
    const auditPath = path.join(
      workspaceRoot,
      "runs",
      interrupted.id,
      ".paid-reconciliations",
      `${createHash("sha256").update("confirm-not-charged-operation-1").digest("hex")}.json`,
    );
    const audit = JSON.parse(await readFile(auditPath, "utf8")) as Record<string, unknown>;
    assert.equal(audit.actor, "owner");
    assert.equal(audit.note, "Provider 后台确认该任务未受理，也未产生扣费。");
    assert.equal(audit.status, "completed");
    const replayed = await subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "confirm-not-charged-operation-1",
      outcome: "confirmed_not_charged",
      actor: "owner",
      note: "Provider 后台确认该任务未受理，也未产生扣费。",
    });
    assert.equal(replayed.revision, resolved.revision);
    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "confirm-not-charged-operation-1",
        outcome: "confirmed_not_charged",
        actor: "owner",
        note: "另一份相互冲突的核销说明。",
      }),
      /conflicts with its persisted request/,
    );

  });

  it("requires manual evidence when the original operation ledger is unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-no-ledger-"));
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
    const interrupted = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });
    const assetsNode = interrupted.nodeRuns.find((node) => node.nodeId === "assets");
    const originalPlan = assetsNode?.spendPlan;
    assert.ok(assetsNode);
    assert.ok(originalPlan);
    const oldAuthorizationId = "authorization-without-operation-ledger";
    interrupted.spendAuthorizations = [{
      id: oldAuthorizationId,
      nodeId: originalPlan.nodeId,
      inputVersionIds: originalPlan.inputVersionIds,
      providerId: originalPlan.providerId,
      modelId: originalPlan.modelId,
      maxCostCny: originalPlan.maxCostCny,
      maxAttempts: originalPlan.maxAttempts,
      approvedBy: "owner",
      approvedAt: "2026-08-24T08:00:00.000Z",
    }];
    assetsNode.status = "failed";
    assetsNode.operationRequestId = "operation-without-ledger";
    assetsNode.spendAuthorizationId = oldAuthorizationId;
    assetsNode.outcomeUncertain = true;
    assetsNode.interrupted = true;
    interrupted.status = "failed";
    await writeFile(path.join(workspaceRoot, "runs", interrupted.id, "run.json"), `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "cannot-forge-operation-from-task-id",
        outcome: "resume_original",
        taskId: "provider-task-without-ledger",
      }),
      pipeline.PaidOperationManualReconciliationError,
    );
    delete assetsNode.operationRequestId;
    await writeFile(path.join(workspaceRoot, "runs", interrupted.id, "run.json"), `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "cannot-forge-missing-operation-from-task-id",
        outcome: "resume_original",
        taskId: "provider-task-without-ledger",
      }),
      pipeline.PaidOperationManualReconciliationError,
    );
    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "missing-manual-note",
        outcome: "confirmed_not_charged",
        actor: "owner",
      }),
      /note must contain/,
    );

    const resolved = await subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "confirm-no-ledger-not-charged",
      outcome: "confirmed_not_charged",
      actor: "owner",
      note: "Provider 后台确认没有受理记录。",
    });

    const nextAssets = resolved.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(resolved.status, "awaiting_spend_approval");
    assert.deepEqual(nextAssets?.spendPlan?.items?.map((item) => item.id), ["scene-1", "scene-2"]);
    assert.deepEqual(resolved.consumedSpendAuthorizationIds, [oldAuthorizationId]);
    assert.equal(worker.calls.filter((call) => call.capability === "asset.prepare").length, 0);
  });

  it("records a confirmed charge without pretending a missing paid asset was materialized", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-paid-confirmed-charge-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      clock: () => "2026-08-24T10:00:00.000Z",
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
    const interrupted = await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "hailuo-video-v1" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });
    const assetsNode = interrupted.nodeRuns.find((node) => node.nodeId === "assets");
    const originalPlan = assetsNode?.spendPlan;
    assert.ok(assetsNode);
    assert.ok(originalPlan);
    const oldAuthorizationId = "authorization-before-confirmed-charge";
    interrupted.spendAuthorizations = [{
      id: oldAuthorizationId,
      nodeId: originalPlan.nodeId,
      inputVersionIds: originalPlan.inputVersionIds,
      providerId: originalPlan.providerId,
      modelId: originalPlan.modelId,
      maxCostCny: originalPlan.maxCostCny,
      maxAttempts: originalPlan.maxAttempts,
      approvedBy: "owner",
      approvedAt: "2026-08-24T08:00:00.000Z",
    }];
    assetsNode.status = "failed";
    delete assetsNode.operationRequestId;
    delete (assetsNode as { startedAt?: string }).startedAt;
    assetsNode.spendAuthorizationId = oldAuthorizationId;
    assetsNode.outcomeUncertain = true;
    assetsNode.interrupted = true;
    assetsNode.error = "process exited after provider accepted the request";
    interrupted.status = "failed";
    interrupted.finishedAt = "2026-08-24T09:00:00.000Z";
    (interrupted.executionReceipts ??= []).push({
      nodeId: "assets",
      capability: "asset.prepare",
      providerId: "hailuo-video-v1",
      providerLabel: "MiniMax 海螺关键镜头",
      modelId: "MiniMax-Hailuo-02",
      transport: "http_api",
      billing: "metered",
      status: "failed",
      estimatedCostCny: 0.25,
      actualCostCny: 0.25,
      actualCostSource: "provider_reported",
      meteredAttemptCount: 1,
      meteredFailedAttemptCount: 1,
      requestId: "older-unrelated-assets-operation",
      startedAt: "2026-08-23T08:00:00.000Z",
      finishedAt: "2026-08-23T08:01:00.000Z",
    });
    delete (interrupted.executionReceipts.at(-1) as { startedAt?: string }).startedAt;
    await writeFile(path.join(workspaceRoot, "runs", interrupted.id, "run.json"), `${JSON.stringify(interrupted, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "reject-invalid-confirmed-charge",
        outcome: "confirmed_charged",
        actor: "owner",
        note: "Provider 账单确认已扣费。",
        actualCostCny: Number.NaN,
      }),
      /finite non-negative amount/,
    );

    const resolved = await subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "confirm-charged-operation-without-ledger",
      outcome: "confirmed_charged",
      actor: "owner",
      note: "Provider 账单确认已扣费，但后台没有可下载产物。",
    });

    const resolvedNode = resolved.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(resolved.status, "failed");
    assert.equal(resolvedNode?.status, "failed");
    assert.equal(resolvedNode?.outcomeUncertain, undefined);
    assert.equal(resolvedNode?.interrupted, undefined);
    assert.equal(resolvedNode?.operationRequestId, undefined);
    assert.equal(resolvedNode?.spendAuthorizationId, undefined);
    assert.match(resolvedNode?.error ?? "", /已确认计费.*没有可恢复的素材/);
    assert.deepEqual(resolved.consumedSpendAuthorizationIds, [oldAuthorizationId]);
    assert.equal(resolvedNode?.executionReceipt?.actualCostCny, originalPlan.estimatedCostCny);
    assert.equal(resolvedNode?.executionReceipt?.actualCostSource, "configured_rate");
    assert.equal(resolvedNode?.executionReceipt?.requestId, undefined);
    assert.equal(resolvedNode?.executionReceipt?.startedAt, "2026-08-24T10:00:00.000Z");
    assert.equal(resolved.executionReceipts?.at(-1)?.actualCostCny, originalPlan.estimatedCostCny);
    assert.equal(resolved.executionReceipts?.some((receipt) => (
      receipt.requestId === "older-unrelated-assets-operation" && receipt.actualCostCny === 0.25
    )), true);
    assert.equal(worker.calls.filter((call) => call.capability === "asset.prepare").length, 0);
    assert.equal(resolved.artifacts.some((artifact) => artifact.producer?.nodeId === "assets"), false);

    const replayed = await subject.reconcilePaidNode(interrupted.id, {
      nodeId: "assets",
      expectedRunRevision: interrupted.revision,
      reconciliationId: "confirm-charged-operation-without-ledger",
      outcome: "confirmed_charged",
      actor: "owner",
      note: "Provider 账单确认已扣费，但后台没有可下载产物。",
    });
    assert.equal(replayed.revision, resolved.revision);
    assert.equal(replayed.executionReceipts?.length, resolved.executionReceipts?.length);
    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "confirm-charged-operation-without-ledger",
        outcome: "confirmed_charged",
        actor: "another-owner",
        note: "Provider 账单确认已扣费，但后台没有可下载产物。",
      }),
      /conflicts with its persisted request/,
    );
    await assert.rejects(
      () => subject.reconcilePaidNode(interrupted.id, {
        nodeId: "assets",
        expectedRunRevision: interrupted.revision,
        reconciliationId: "confirm-charged-operation-without-ledger",
        outcome: "confirmed_charged",
        actor: "owner",
        note: "Provider 账单确认已扣费，但后台没有可下载产物。",
        actualCostCny: 1.2,
      }),
      /conflicts with its persisted request/,
    );
  });

  it("allows manual not-charged reconciliation to unlock an uncertain automatic TTS call", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-tts-reconciliation-"));
    let voiceCalls = 0;
    class AmbiguousVoiceWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        const response = await super.run(request);
        if (request.capability === "voice.synthesize") {
          voiceCalls += 1;
          if (voiceCalls === 1) {
            return {
              ...response,
              status: "failed",
              error: { code: "WORKER_REQUEST_FAILED", message: "MiniMax request outcome is unknown" },
              artifacts: [],
            };
          }
        }
        return response;
      }
    }
    const worker = new AmbiguousVoiceWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: [{
        id: "minimax-tts-v1",
        label: "MiniMax 中文声音演员",
        modelId: "speech-2.8-turbo",
        transport: "http_api",
        billing: "metered",
        approvalPolicy: "automatic",
        estimatedCostCny: 0.1,
        maxAttempts: 1,
      }],
    });
    const failed = await subject.start({
      ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
    });
    const failedVoice = failed.nodeRuns.find((node) => node.nodeId === "voice");
    assert.equal(failedVoice?.outcomeUncertain, true, JSON.stringify({
      runStatus: failed.status,
      voiceCalls,
      nodes: failed.nodeRuns.map((node) => ({
        nodeId: node.nodeId,
        status: node.status,
        error: node.error,
        outcomeUncertain: node.outcomeUncertain,
        operationRequestId: node.operationRequestId,
        receipt: node.executionReceipt,
      })),
    }, null, 2));
    const operationId = failedVoice?.operationRequestId;
    assert.ok(operationId);
    const voiceNodeDirectory = path.join(workspaceRoot, "runs", failed.id, "nodes", "voice");
    const voiceLedgerDirectory = path.join(voiceNodeDirectory, ".voice-operations");
    const rawPath = path.join(voiceNodeDirectory, "attempt-1", "scene_01_raw.mp3");
    const rawBytes = Buffer.from("durable paid voice");
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, rawBytes);
    await mkdir(voiceLedgerDirectory, { recursive: true });
    const voiceLedgerPath = path.join(voiceLedgerDirectory, `${createHash("sha256").update(operationId).digest("hex")}.json`);
    const voiceLedgerBase = {
      sourceFingerprint: "voice-source-fingerprint",
      executorProviderId: "minimax-tts-v1",
      providerId: "minimax-tts-v1",
      modelId: "speech-2.8-turbo",
      parameters: { voice: "female-chengshu", rate: 190, pauseScale: 1 },
      stateHistory: ["prepared", "unknown"],
    };
    await writeFile(voiceLedgerPath, `${JSON.stringify({
      version: "video-factory/paid-operation-v2",
      operationId,
      completed: false,
      providerId: "minimax-tts-v1",
      modelId: "speech-2.8-turbo",
      estimatedCostCny: 0.1,
      actualCostCny: 0.1,
      actualCostSource: "configured_rate",
      items: [
        {
          ...voiceLedgerBase,
          itemRequestId: "voice-scene-1",
          quoteItemId: "scene-1",
          inputFingerprint: "voice-input-1",
          scenePosition: 1,
          state: "materialized",
          stateHistory: [...voiceLedgerBase.stateHistory, "materialized"],
          localPath: rawPath,
          sha256: createHash("sha256").update(rawBytes).digest("hex"),
          sizeBytes: rawBytes.length,
        },
        {
          ...voiceLedgerBase,
          itemRequestId: "voice-scene-2",
          quoteItemId: "scene-2",
          inputFingerprint: "voice-input-2",
          scenePosition: 2,
          state: "unknown",
        },
      ],
    }, null, 2)}\n`, "utf8");

    const pending = await subject.inspectPaidNode(failed.id, "voice");
    assert.equal(pending.requiresManualReconciliation, true);
    assert.equal(pending.operationId, operationId);

    const resolved = await subject.reconcilePaidNode(failed.id, {
      nodeId: "voice",
      expectedRunRevision: failed.revision,
      reconciliationId: "tts-confirmed-not-charged",
      outcome: "confirmed_not_charged",
      actor: "owner",
      note: "MiniMax 控制台确认该请求没有受理记录和扣费。",
    });

    assert.equal(resolved.status, "needs_human");
    assert.equal(resolved.nodeRuns.find((node) => node.nodeId === "voice")?.status, "succeeded");
    assert.equal(voiceCalls, 2);
    const voiceRequests = worker.calls.filter((call) => call.capability === "voice.synthesize");
    assert.equal(voiceRequests.at(-1)?.commandId, operationId);
    const reconciledLedger = JSON.parse(await readFile(voiceLedgerPath, "utf8")) as {
      items: Array<{ state: string }>;
    };
    assert.deepEqual(reconciledLedger.items.map((item) => item.state), ["materialized", "prepared"]);
    const receipts = resolved.executionReceipts?.filter((receipt) => receipt.requestId === operationId) ?? [];
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.actualCostCny, 0.1);
  });

  it("resumes fully materialized automatic TTS under the original operation id", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-tts-materialized-recovery-"));
    let voiceCalls = 0;
    class InterruptedVoiceWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        const response = await super.run(request);
        if (request.capability !== "voice.synthesize") return response;
        voiceCalls += 1;
        if (voiceCalls === 1) {
          return {
            ...response,
            status: "failed",
            error: { code: "WORKER_REQUEST_FAILED", message: "voice normalization response was lost" },
            artifacts: [],
          };
        }
        return response;
      }
    }
    const worker = new InterruptedVoiceWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      providerRuntimeMetadata: [{
        id: "minimax-tts-v1",
        label: "MiniMax 中文声音演员",
        modelId: "speech-2.8-turbo",
        transport: "http_api",
        billing: "metered",
        approvalPolicy: "automatic",
        estimatedCostCny: 0.1,
        maxAttempts: 1,
      }],
    });
    const failed = await subject.start({
      ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: { ...brief.voiceDirection, profileId: "minimax:female-chengshu" },
    });
    const failedVoice = failed.nodeRuns.find((node) => node.nodeId === "voice");
    const operationId = failedVoice?.operationRequestId;
    assert.ok(operationId);
    const voiceLedgerDirectory = path.join(workspaceRoot, "runs", failed.id, "nodes", "voice", ".voice-operations");
    await mkdir(voiceLedgerDirectory, { recursive: true });
    await writeFile(
      path.join(voiceLedgerDirectory, `${createHash("sha256").update(operationId).digest("hex")}.json`),
      `${JSON.stringify({
        version: "video-factory/paid-operation-v2",
        operationId,
        completed: true,
        providerId: "minimax-tts-v1",
        modelId: "speech-2.8-turbo",
        estimatedCostCny: 0.1,
        actualCostCny: 0.1,
        actualCostSource: "configured_rate",
        items: [1, 2].map((scenePosition) => ({
          itemRequestId: `voice-scene-${scenePosition}`,
          quoteItemId: `scene-${scenePosition}`,
          inputFingerprint: `voice-input-${scenePosition}`,
          sourceFingerprint: "voice-source-fingerprint",
          scenePosition,
          executorProviderId: "minimax-tts-v1",
          providerId: "minimax-tts-v1",
          modelId: "speech-2.8-turbo",
          parameters: { voice: "female-chengshu", rate: 190, pauseScale: 1 },
          state: "materialized",
          stateHistory: ["prepared", "unknown", "materialized"],
          localPath: `/tmp/voice-scene-${scenePosition}.mp3`,
          sha256: "a".repeat(64),
          sizeBytes: 10,
        })),
      }, null, 2)}\n`,
      "utf8",
    );

    const summary = await subject.inspectPaidNode(failed.id, "voice");
    assert.equal(summary.operationId, operationId);
    assert.equal(summary.requiresManualReconciliation, false);
    assert.equal(summary.recommendedOutcome, "resume_original");

    const resolved = await subject.reconcilePaidNode(failed.id, {
      nodeId: "voice",
      expectedRunRevision: failed.revision,
      reconciliationId: "resume-materialized-voice",
      outcome: "resume_original",
    });

    assert.equal(resolved.status, "needs_human");
    assert.equal(worker.calls.filter((call) => call.capability === "voice.synthesize").at(-1)?.commandId, operationId);
    assert.equal(voiceCalls, 2);
    const receipts = resolved.executionReceipts?.filter((receipt) => receipt.requestId === operationId) ?? [];
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.actualCostCny, 0.1);
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

  it("fences a stale resume owner before it persists or starts another provider", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const setup = new pipeline.ProductionPipeline({ workspaceRoot, worker: new FakeWorker() });
    const waiting = await setup.start(brief);
    const voiceNode = waiting.nodeRuns.find((node) => node.nodeId === "voice");
    const voiceInput = voiceNode?.inputState?.versions.find(
      (version) => version.id === voiceNode.inputState?.effectiveVersionId,
    )?.value;
    assert.ok(voiceInput);
    await setup.applyNodeInputOverride(waiting.id, {
      nodeId: "voice",
      actor: "producer",
      input: voiceInput,
    });

    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "voice.synthesize") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const worker = new BlockingWorker();
    const staleOwner = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      executionLeaseHeartbeatMs: 10,
    });
    const dispatchPromise = staleOwner.dispatchResumeStale(waiting.id);
    await entered;
    const dispatched = await dispatchPromise;

    const leasePath = path.join(workspaceRoot, "runs", waiting.id, ".execution-lease.json");
    const lockPath = `${leasePath}.lock`;
    const replacementToken = "replacement-owner-token";
    const originalLockStat = await stat(lockPath);
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
    await utimes(lockPath, originalLockStat.atime, originalLockStat.mtime);
    await writeFile(leasePath, `${JSON.stringify({
      version: 1,
      token: replacementToken,
      pid: 999_999,
      heartbeatAt: "2026-09-02T00:00:00.000Z",
    })}\n`, "utf8");

    releaseResolve();
    await assert.rejects(dispatched.completion, /lost its execution lease/);
    assert.deepEqual(worker.calls.map((call) => call.capability), ["voice.synthesize"]);
    assert.equal(JSON.parse(await readFile(leasePath, "utf8")).token, replacementToken);
    const replacementLockStat = await stat(lockPath);
    assert.equal(replacementLockStat.isDirectory(), true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal((await stat(lockPath)).mtimeMs, replacementLockStat.mtimeMs);
  });

  it("honors a pause request after the active node and resumes from the next node", async () => {
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
    const worker = new BlockingWorker();
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });
    const dispatched = await subject.dispatch(brief);
    await entered;

    await subject.requestPause(dispatched.runId);
    releaseResolve();
    const paused = await dispatched.completion;

    assert.equal(paused.status, "paused");
    assert.deepEqual(paused.nodeRuns.map((node) => node.nodeId), ["brief", "script"]);
    assert.equal(worker.calls.filter((call) => call.capability === "script.draft").length, 1);

    const completed = await subject.resumePaused(dispatched.runId);
    assert.equal(completed.status, "needs_human");
    assert.equal(worker.calls.filter((call) => call.capability === "script.draft").length, 1);
  });

  it("clears a pause request when the active node reaches a different terminal state", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    class BlockingRejectedWorker extends FakeWorker {
      constructor() { super("script.draft"); }
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (request.capability === "script.draft") {
          enteredResolve();
          await release;
        }
        return super.run(request);
      }
    }
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new BlockingRejectedWorker() });
    const dispatched = await subject.dispatch(brief);
    await entered;

    await subject.requestPause(dispatched.runId);
    releaseResolve();
    const rejected = await dispatched.completion;

    assert.equal(rejected.status, "rejected");
    assert.equal(await subject.pauseRequested(dispatched.runId), false);
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
      estimated: 4.8,
      max: 4.8,
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
    const paidCall = worker.calls.find((call) => call.capability === "asset.prepare");
    assert.ok(paidCall);
    assert.equal((paidCall.parameters as Record<string, unknown>).estimatedCostCny, 2.4);
    assert.equal((paidCall.parameters as Record<string, unknown>).maxCostCny, 4.8);
    assert.equal(resumed.nodeRuns.find((node) => node.nodeId === "assets")?.executionReceipt?.billing, "metered");
  });

  it("still requires a finite exact spend approval when the video has no user-configured ceiling", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-unlimited-production-"));
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
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.deepEqual(worker.calls.map((call) => call.capability), ["script.draft"]);
    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(plan);
    assert.equal(plan.estimatedCostCny, 4.8);
    assert.equal(plan.maxCostCny, 4.8);
    assert.equal(Number.isFinite(plan.maxCostCny) && plan.maxCostCny > 0, true);

    await subject.authorizeSpend(paused.id, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "owner",
    });

    const paidCall = worker.calls.find((call) => call.capability === "asset.prepare");
    assert.ok(paidCall);
    const parameters = paidCall.parameters as Record<string, unknown>;
    assert.equal(parameters.maxPaidShots, undefined);
    assert.equal(parameters.maxCostCny, 4.8);
  });

  it("invalidates an old approval and quotes only failed or unstarted paid scenes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-incremental-quote-"));
    class ThreeSceneWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        const response = await super.run(request);
        if (request.capability !== "script.draft") return response;
        const scriptPath = String(response.output?.scriptPath);
        const content = JSON.stringify({ scenes: [
          { position: 1, narration: "第一幕", duration: 5, visual_strategy: "generated", visual_prompt: "镜头一" },
          { position: 2, narration: "第二幕", duration: 5, visual_strategy: "generated", visual_prompt: "镜头二" },
          { position: 3, narration: "第三幕", duration: 5, visual_strategy: "generated", visual_prompt: "镜头三" },
        ] });
        await writeFile(scriptPath, content, "utf8");
        response.artifacts[0] = {
          ...response.artifacts[0]!,
          sha256: createHash("sha256").update(content).digest("hex"),
          sizeBytes: Buffer.byteLength(content),
        };
        return response;
      }
    }
    const worker = new ThreeSceneWorker();
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
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });
    const assetsNode = paused.nodeRuns.find((node) => node.nodeId === "assets");
    const originalPlan = assetsNode?.spendPlan;
    const scriptPath = String((paused.nodeRuns.find((node) => node.nodeId === "script")?.output as Record<string, unknown>)?.scriptPath);
    assert.ok(originalPlan);
    assert.deepEqual(originalPlan.items?.map((item) => item.id), ["scene-1", "scene-2", "scene-3"]);

    const sourceFingerprint = await pipeline.paidAssetSourceFingerprint([scriptPath]);
    const ledgerDirectory = path.join(workspaceRoot, "runs", paused.id, "nodes", "assets", ".generation-operations");
    await mkdir(ledgerDirectory, { recursive: true });
    const baseItem = {
      executorProviderId: "hailuo-video-v1",
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      sourceFingerprint,
      parameters: { mediaType: "video", durationSeconds: 5, ratio: "9:16" },
      estimatedCostCny: 2.4,
    };
    await writeFile(path.join(ledgerDirectory, "prior-operation.json"), `${JSON.stringify({
      version: "video-factory/paid-operation-v2",
      operationId: "prior-operation",
      completed: false,
      items: [
        { ...baseItem, itemRequestId: "paid-scene-1", quoteItemId: "scene-1", inputFingerprint: "input-1", scenePosition: 1, state: "materialized" },
        { ...baseItem, itemRequestId: "paid-scene-2", quoteItemId: "scene-2", inputFingerprint: "input-2", scenePosition: 2, state: "terminal_failed" },
        { ...baseItem, itemRequestId: "paid-scene-3", quoteItemId: "scene-3", inputFingerprint: "input-3", scenePosition: 3, state: "prepared" },
      ],
    }, null, 2)}\n`, "utf8");

    const invalidated = await subject.authorizeSpend(paused.id, {
      nodeId: originalPlan.nodeId,
      inputVersionIds: originalPlan.inputVersionIds,
      providerId: originalPlan.providerId,
      modelId: originalPlan.modelId,
      maxCostCny: originalPlan.maxCostCny,
      maxAttempts: originalPlan.maxAttempts,
      approvedBy: "owner",
    });

    const incrementalPlan = invalidated.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.equal(invalidated.status, "approval_invalidated");
    assert.equal(incrementalPlan?.estimatedCostCny, 4.8);
    assert.deepEqual(incrementalPlan?.items?.map((item) => item.id), ["scene-2", "scene-3"]);
    assert.deepEqual(worker.calls.map((call) => call.capability), ["script.draft"]);
  });

  it("quotes the exact paid shots selected by the AI shot router", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-unlimited-router-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: "auto",
          resolvedProfileId: "geometric-control",
          profileRationale: "解释型内容需要统一、可控的生成镜头。",
          visualBible: {
            narrativeApproach: "用具体动作解释每一步。",
            pacing: "均匀推进",
            composition: "稳定中近景",
            camera: "克制移动",
            color: "自然暖色",
            continuity: "保持同一时间与空间",
            sound: "环境声优先",
          },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: "seedance-video-v1",
            deliveryType: "generated_video",
            alternativeProviderIds: [],
            temporalBeats: [
              `[0s-${scene.duration / 2}s] 建立主体`,
              `[${scene.duration / 2}s-${scene.duration}s] 完成动作`,
            ],
            query: scene.visualPrompt,
            generationPrompt: scene.visualPrompt,
            rationale: "生成能力可以交付这个解释镜头。",
            continuityNote: "保持同一色温。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      },
      assetProviders: [{
        id: "seedance-video-v1",
        label: "Seedance",
        billing: "metered",
        modes: ["文生视频"],
        deliveryTypes: ["generated_video"],
        estimatedCnyPerClip: 2.4,
        generative: true,
      }],
      providerRuntimeMetadata: [{
        id: "seedance-video-v1",
        label: "Seedance",
        modelId: "seedance-v1",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 2.4,
        maxAttempts: 1,
      }],
    });

    const paused = await subject.start({
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.deepEqual(worker.calls.map((call) => call.capability), ["script.draft"]);
    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(plan);
    assert.equal(plan.estimatedCostCny, 4.8);
    assert.equal(plan.maxCostCny, 4.8);
    assert.deepEqual(plan.items, [
      { id: "scene-1", label: "镜头 1", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 2.4 },
      { id: "scene-2", label: "镜头 2", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 2.4 },
    ]);
    assert.equal(Number.isFinite(plan.maxCostCny) && plan.maxCostCny > 0, true);
  });

  it("quotes mixed generated images and videos before calling either paid adapter", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-mixed-asset-approval-"));
    class RoutedAssetBaselineWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        const response = await super.run(request);
        if (request.capability !== "asset.prepare") return response;
        const input = request.input as Record<string, unknown>;
        const script = JSON.parse(await readFile(String(input.scriptPath), "utf8")) as {
          scenes: Array<{ position: number; duration: number; visual_prompt: string }>;
        };
        const directorPlan = JSON.parse(await readFile(String(input.directorPlanPath), "utf8")) as {
          shots: Array<Record<string, unknown> & { scenePosition: number; preferredProviderId: string; deliveryType: string }>;
        };
        const shots = new Map(directorPlan.shots.map((shot) => [shot.scenePosition, shot]));
        const plan = JSON.stringify({
          scene_assets: script.scenes.map((scene) => {
            const shot = shots.get(scene.position)!;
            return {
              scene_position: scene.position,
              provider: shot.preferredProviderId,
              asset_id: `pending-${scene.position}`,
              media_type: shot.deliveryType === "generated_image" ? "image" : "video",
              width: 720,
              height: 1280,
              duration: scene.duration,
              local_path: "",
              source_url: `pending://scene-${scene.position}`,
              creator: "VideoFactory pending generation",
              license_note: "Generation pending.",
              query: scene.visual_prompt,
            };
          }),
          director_routing: directorPlan.shots.map((shot) => ({
            scene_position: shot.scenePosition,
            preferred_provider_id: shot.preferredProviderId,
            actual_provider_id: shot.preferredProviderId,
            actual_provider: shot.preferredProviderId,
            fallback_used: false,
            generation_pending: true,
            director_shot: shot,
          })),
        });
        const planPath = String(response.output?.assetPlanPath);
        await writeFile(planPath, plan, "utf8");
        response.artifacts[0] = {
          ...response.artifacts[0]!,
          sha256: createHash("sha256").update(plan).digest("hex"),
          sizeBytes: Buffer.byteLength(plan),
        };
        return response;
      }
    }

    const fallback = new RoutedAssetBaselineWorker();
    let imageCalls = 0;
    let videoCalls = 0;
    const worker = new pipeline.GenerativeAssetWorkerClient({
      fallback,
      imageAdapters: [{
        estimatedCnyPerImage: 0.25,
        adapter: {
          providerId: "seedream-image-v1",
          generate: async () => {
            imageCalls += 1;
            return {
              providerId: "seedream-image-v1",
              taskId: "image-task",
              imageUrl: "https://example.com/generated.png",
            };
          },
        },
      }],
      adapters: [{
        estimatedCnyPerClip: 2.4,
        defaultModelId: "seedance-v1",
        modelPrices: { "seedance-v1": 2.4 },
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            videoCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: "video-task",
              videoUrl: "https://example.com/generated.mp4",
            };
          },
        },
      }],
      resolveHost: async () => ["93.184.216.34"],
      fetch: async (input) => new Response(
        String(input).endsWith(".png") ? "generated-image" : "generated-video",
        { headers: { "content-type": String(input).endsWith(".png") ? "image/png" : "video/mp4" } },
      ),
    });
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: "auto",
          resolvedProfileId: "geometric-control",
          profileRationale: "图像负责结构，视频负责动作。",
          visualBible: {
            narrativeApproach: "先解释结构，再展示动作。",
            pacing: "均匀推进",
            composition: "稳定中近景",
            camera: "克制移动",
            color: "自然暖色",
            continuity: "保持相同主体与色温",
            sound: "环境声优先",
          },
          shots: input.scenes.map((scene, index) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: index === 0 ? "seedream-image-v1" : "seedance-video-v1",
            deliveryType: index === 0 ? "generated_image" : "generated_video",
            alternativeProviderIds: [],
            temporalBeats: [
              `[0s-${scene.duration / 2}s] 建立主体`,
              `[${scene.duration / 2}s-${scene.duration}s] 完成镜头意图`,
            ],
            query: scene.visualPrompt,
            generationPrompt: scene.visualPrompt,
            rationale: index === 0 ? "静态结构更适合关键图。" : "动作需要视频生成。",
            continuityNote: "保持相同主体与色温。",
            confidence: 0.9,
            estimatedCostCny: 0,
          })),
        }),
      },
      assetProviders: [
        {
          id: "seedream-image-v1",
          label: "Seedream",
          billing: "metered",
          modes: ["文生图"],
          deliveryTypes: ["generated_image"],
          estimatedCnyPerClip: 0.25,
          generative: true,
        },
        {
          id: "seedance-video-v1",
          label: "Seedance",
          billing: "metered",
          modes: ["文生视频"],
          deliveryTypes: ["generated_video"],
          estimatedCnyPerClip: 2.4,
          generative: true,
        },
      ],
      providerRuntimeMetadata: [
        {
          id: "seedream-image-v1",
          label: "Seedream",
          modelId: "seedream-v1",
          transport: "http_api",
          billing: "metered",
          estimatedCostCny: 0.25,
          maxAttempts: 1,
        },
        {
          id: "seedance-video-v1",
          label: "Seedance",
          modelId: "seedance-v1",
          transport: "http_api",
          billing: "metered",
          estimatedCostCny: 2.4,
          maxAttempts: 1,
        },
      ],
    });

    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["seedream-image-v1", "seedance-video-v1"] },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.deepEqual({ imageCalls, videoCalls }, { imageCalls: 0, videoCalls: 0 });
    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(plan);
    assert.deepEqual(plan.items, [
      { id: "scene-1", label: "镜头 1", providerId: "seedream-image-v1", modelId: "seedream-v1", estimatedCostCny: 0.25 },
      { id: "scene-2", label: "镜头 2", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 2.4 },
    ]);
    assert.equal(plan.maxCostCny, 2.65);

    const resumed = await subject.authorizeSpend(paused.id, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "owner",
    });

    assert.equal(resumed.status, "needs_human");
    assert.deepEqual({ imageCalls, videoCalls }, { imageCalls: 1, videoCalls: 1 });
    const assetPlanPath = String((resumed.nodeRuns.find((node) => node.nodeId === "assets")?.output as Record<string, unknown>).assetPlanPath);
    const assetPlan = JSON.parse(await readFile(assetPlanPath, "utf8")) as { scene_assets: Array<Record<string, unknown>> };
    assert.deepEqual(assetPlan.scene_assets.map((asset) => [asset.provider, asset.media_type]), [
      ["seedream-image-v1", "image"],
      ["seedance-video-v1", "video"],
    ]);
    assert.ok(assetPlan.scene_assets.every((asset) => typeof asset.local_path === "string" && asset.local_path.length > 0));
  });

  it("quotes a duration-priced video model with the same runtime price used for execution", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-duration-quote-"));
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new FakeWorker(),
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: "auto",
          resolvedProfileId: "geometric-control",
          profileRationale: "生成镜头需要统一视觉。",
          visualBible: {
            narrativeApproach: "用动作解释内容。",
            pacing: "均匀推进",
            composition: "稳定中近景",
            camera: "克制移动",
            color: "自然暖色",
            continuity: "保持同一时间与空间",
            sound: "环境声优先",
          },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: "hailuo-video-v1",
            deliveryType: "generated_video",
            alternativeProviderIds: [],
            temporalBeats: [
              `[0s-${scene.duration / 2}s] 建立主体`,
              `[${scene.duration / 2}s-${scene.duration}s] 完成动作`,
            ],
            query: scene.visualPrompt,
            generationPrompt: scene.visualPrompt,
            rationale: "生成能力可以交付。",
            continuityNote: "保持同一色温。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      },
      assetProviders: [{
        id: "hailuo-video-v1",
        label: "MiniMax H3 Max",
        billing: "metered",
        modes: ["文生视频"],
        deliveryTypes: ["generated_video"],
        estimatedCnyPerClip: 1.65,
        generative: true,
      }],
      providerRuntimeMetadata: [{
        id: "hailuo-video-v1",
        label: "MiniMax H3 Max",
        modelId: "MiniMax-H3-Max",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 1.65,
        maxAttempts: 1,
        modelProfiles: [{
          modelId: "MiniMax-H3-Max",
          estimatedCostCny: 1.65,
          taskTypes: ["text-to-video"],
          resolutions: ["480P", "768P"],
          minDurationSeconds: 5,
          maxDurationSeconds: 15,
          supportsAudio: true,
          estimatedCnyPerSecond: 0.33,
          estimatedCnyPerSecondByResolution: { "480P": 0.33, "768P": 0.5 },
        }],
      }],
    });

    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["hailuo-video-v1"] },
      models: { "hailuo-video-v1": "MiniMax-H3-Max" },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.equal(plan?.estimatedCostCny, 5, JSON.stringify({
      status: paused.status,
      nodes: paused.nodeRuns.map(({ nodeId, status, error }) => ({ nodeId, status, error })),
    }));
    assert.deepEqual(plan?.items?.map((item) => item.estimatedCostCny), [2.5, 2.5]);
  });

  it("excludes a REUSE_ONLY scene from the paid asset quote", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-reuse-quote-"));
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker: new FakeWorker(),
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: "auto",
          resolvedProfileId: "geometric-control",
          profileRationale: "第二镜复用第一镜母片。",
          visualBible: {
            narrativeApproach: "复用母片保持连续。",
            pacing: "均匀推进",
            composition: "稳定中近景",
            camera: "克制移动",
            color: "自然暖色",
            continuity: "复用同一母片",
            sound: "环境声优先",
          },
          shots: input.scenes.map((scene, index) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: "seedance-video-v1",
            deliveryType: "generated_video",
            alternativeProviderIds: [],
            temporalBeats: [
              `[0s-${scene.duration / 2}s] 建立主体`,
              `[${scene.duration / 2}s-${scene.duration}s] 完成动作`,
            ],
            query: index === 0 ? scene.visualPrompt : "REUSE_ONLY scene one",
            generationPrompt: scene.visualPrompt,
            rationale: index === 0 ? "生成母片。" : "复用已生成母片。",
            continuityNote: "保持同一色温。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      },
      assetProviders: [{
        id: "seedance-video-v1",
        label: "Seedance",
        billing: "metered",
        modes: ["文生视频"],
        deliveryTypes: ["generated_video"],
        estimatedCnyPerClip: 2.4,
        generative: true,
      }],
      providerRuntimeMetadata: [{
        id: "seedance-video-v1",
        label: "Seedance",
        modelId: "seedance-v1",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 2.4,
        maxAttempts: 1,
      }],
    });

    const paused = await subject.start({
      ...brief,
      providers: { ...brief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    const plan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.deepEqual(plan?.items?.map((item) => item.id), ["scene-1"]);
    assert.equal(plan?.estimatedCostCny, 2.4);
  });

  it("executes an all-free AI shot plan without asking for a zero-cost approval", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-free-router-"));
    const worker = new FakeWorker();
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: "auto",
          resolvedProfileId: "documentary-observer",
          profileRationale: "普通动作可由真实图库完整交付。",
          visualBible: {
            narrativeApproach: "用真实动作说明每一步。",
            pacing: "均匀推进",
            composition: "稳定中近景",
            camera: "克制移动",
            color: "自然暖色",
            continuity: "保持同一时间与空间",
            sound: "环境声优先",
          },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "解释",
            authenticityPolicy: "illustrative",
            preferredProviderId: "pexels-stock-v1",
            deliveryType: "stock_video",
            alternativeProviderIds: [],
            temporalBeats: [
              `[0s-${scene.duration / 2}s] 建立主体`,
              `[${scene.duration / 2}s-${scene.duration}s] 完成动作`,
            ],
            query: scene.visualPrompt,
            generationPrompt: scene.visualPrompt,
            rationale: "常见单一动作可由图库检索。",
            continuityNote: "保持同一色温。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      },
      assetProviders: [
        {
          id: "seedance-video-v1",
          label: "Seedance",
          billing: "metered",
          modes: ["文生视频"],
          deliveryTypes: ["generated_video"],
          estimatedCnyPerClip: 2.4,
          generative: true,
        },
        {
          id: "pexels-stock-v1",
          label: "Pexels",
          billing: "free",
          modes: ["图库视频"],
          deliveryTypes: ["stock_video"],
          estimatedCnyPerClip: 0,
        },
      ],
      providerRuntimeMetadata: [{
        id: "seedance-video-v1",
        label: "Seedance",
        modelId: "seedance-v1",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 2.4,
        maxAttempts: 1,
      }],
    });

    const completed = await subject.start({
      ...brief,
      providers: {
        ...brief.providers,
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1", "pexels-stock-v1"] },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });

    const assets = completed.nodeRuns.find((node) => node.nodeId === "assets");
    assert.notEqual(completed.status, "awaiting_spend_approval");
    assert.equal(assets?.status, "succeeded", JSON.stringify({ status: completed.status, nodes: completed.nodeRuns.map(({ nodeId, status, error }) => ({ nodeId, status, error })) }));
    assert.equal(assets?.spendPlan, undefined);
    assert.equal(assets?.executionReceipt?.billing, "free");
    assert.equal(worker.calls.filter((call) => call.capability === "asset.prepare").length, 1);
  });

  it("stores a rejected asset quote and waits for a manual director replan", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-cost-replan-"));
    const worker = new FakeWorker();
    const directorInputs: pipeline.VisualDirectorAgentInput[] = [];
    const historicalFeedback = Array.from({ length: 20 }, (_, index) => ({
      spendPlanId: `historical-plan-${index + 1}`,
      nodeId: "assets",
      reason: "other" as const,
      previousEstimatedCostCny: 4.8,
      note: `历史反馈 ${index + 1}`,
      rejectedBy: "owner",
      rejectedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
    }));
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => {
          directorInputs.push(input);
          const cheaperRevision = input.costFeedback?.[0]?.reason === "too_expensive";
          return {
            version: "video-factory/director-plan-v1",
            requestedProfileId: "auto",
            resolvedProfileId: "geometric-control",
            profileRationale: cheaperRevision ? "根据费用反馈减少付费生成镜头。" : "先使用两条生成镜头。",
            visualBible: {
              narrativeApproach: "用具体动作解释每一步。",
              pacing: "均匀推进",
              composition: "稳定中近景",
              camera: "克制移动",
              color: "自然暖色",
              continuity: "保持同一时间与空间",
              sound: "环境声优先",
            },
            shots: input.scenes.map((scene, index) => {
              const paid = !cheaperRevision || index === 0;
              return {
                scenePosition: scene.position,
                narrativeRole: "解释",
                authenticityPolicy: "illustrative",
                preferredProviderId: paid ? "seedance-video-v1" : "pexels-stock-v1",
                deliveryType: paid ? "generated_video" : "stock_video",
                alternativeProviderIds: [],
                temporalBeats: [`[0s-${scene.duration / 2}s] 建立主体`, `[${scene.duration / 2}s-${scene.duration}s] 完成动作`],
                query: scene.visualPrompt,
                generationPrompt: scene.visualPrompt,
                rationale: paid ? "生成能力可以交付这个解释镜头。" : "图库实拍可以满足这一镜并降低费用。",
                continuityNote: "保持同一色温。",
                confidence: 0.8,
                estimatedCostCny: 0,
              };
            }),
          };
        },
      },
      assetProviders: [
        {
          id: "seedance-video-v1",
          label: "Seedance",
          billing: "metered",
          modes: ["文生视频"],
          deliveryTypes: ["generated_video"],
          estimatedCnyPerClip: 2.4,
          generative: true,
        },
        {
          id: "pexels-stock-v1",
          label: "Pexels",
          billing: "free",
          modes: ["图库视频"],
          deliveryTypes: ["stock_video"],
          estimatedCnyPerClip: 0,
        },
      ],
      providerRuntimeMetadata: [{
        id: "seedance-video-v1",
        label: "Seedance",
        modelId: "seedance-v1",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 2.4,
        maxAttempts: 1,
      }],
    });
    const paused = await subject.start({
      ...brief,
      spendFeedback: historicalFeedback,
      providers: { ...brief.providers, director: "api-visual-director-v1", assets: "ai-shot-router-v1" },
      director: { profileId: "auto", assetProviderIds: ["seedance-video-v1", "pexels-stock-v1"] },
      economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    });
    const firstPlan = paused.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(firstPlan, JSON.stringify({ status: paused.status, nodes: paused.nodeRuns.map(({ nodeId, status, error }) => ({ nodeId, status, error })) }));
    assert.equal(firstPlan.estimatedCostCny, 4.8);

    const rejected = await subject.rejectSpend(paused.id, {
      nodeId: "assets",
      spendPlanId: firstPlan.id,
      reason: "too_expensive",
      targetEstimatedCostCny: 0,
      note: "第二镜优先使用真实图库。",
      rejectedBy: "owner",
    });

    assert.equal(directorInputs.length, 1, "rejecting a quote must not call the director");
    assert.equal(rejected.status, "stale");
    assert.equal(rejected.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan, undefined);
    assert.equal(rejected.initialInput.spendFeedback?.length, 20);
    assert.equal(rejected.initialInput.spendFeedback?.at(-1)?.targetEstimatedCostCny, 0);
    assert.equal(rejected.initialInput.spendFeedback?.[0]?.note, "历史反馈 2");

    const replanned = await subject.resumeStale(paused.id);
    const nextPlan = replanned.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.equal(replanned.status, "awaiting_spend_approval");
    assert.equal(directorInputs.length, 2);
    assert.equal(directorInputs[0]?.costFeedback?.length, 10);
    assert.deepEqual(directorInputs[0]?.costFeedback?.map((item) => item.note),
      historicalFeedback.slice(-10).reverse().map((item) => item.note));
    assert.deepEqual(directorInputs[1]?.costFeedback, [
      {
        reason: "too_expensive",
        targetEstimatedCostCny: 0,
        note: "第二镜优先使用真实图库。",
        previousEstimatedCostCny: 4.8,
      },
      ...historicalFeedback.slice(-9).reverse().map((item) => ({
        reason: item.reason,
        note: item.note,
        previousEstimatedCostCny: item.previousEstimatedCostCny,
      })),
    ]);
    assert.notEqual(nextPlan?.id, firstPlan.id);
    assert.equal(nextPlan?.estimatedCostCny, 2.4);
    assert.deepEqual(nextPlan?.items, [
      { id: "scene-1", label: "镜头 1", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 2.4 },
    ]);
    assert.deepEqual(worker.calls.map((call) => call.capability), ["script.draft"]);
    assert.equal(replanned.initialInput.spendFeedback?.length, 20);

    assert.ok(nextPlan);
    const persistedPath = path.join(workspaceRoot, "runs", paused.id, "run.json");
    const invalidRejections = [
      { reason: "invalid" },
      { reason: "other", note: " " },
      { reason: "other", note: "x".repeat(1_001) },
      { reason: "too_expensive", targetEstimatedCostCny: -1 },
      { reason: "too_expensive", targetEstimatedCostCny: Number.NaN },
      { reason: "too_expensive", targetEstimatedCostCny: 100_001 },
      { reason: "other", spendPlanId: firstPlan.id },
      { reason: "other", nodeId: "voice" },
    ];
    for (const invalid of invalidRejections) {
      const before = await readFile(persistedPath, "utf8");
      await assert.rejects(() => subject.rejectSpend(paused.id, {
        nodeId: "assets",
        spendPlanId: nextPlan.id,
        rejectedBy: "owner",
        ...invalid,
      } as never));
      assert.equal(await readFile(persistedPath, "utf8"), before);
    }
    assert.equal(directorInputs.length, 2);
    assert.deepEqual(worker.calls.map((call) => call.capability), ["script.draft"]);

    await subject.rejectSpend(paused.id, {
      nodeId: "assets",
      spendPlanId: nextPlan.id,
      reason: "plan_not_approved",
      rejectedBy: "owner",
    });
    const staleSnapshot = await readFile(persistedPath, "utf8");
    await assert.rejects(() => subject.rejectSpend(paused.id, {
      nodeId: "assets",
      spendPlanId: nextPlan.id,
      reason: "other",
      rejectedBy: "owner",
    }), /not waiting for spend approval/);
    assert.equal(await readFile(persistedPath, "utf8"), staleSnapshot);
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
    class SourceLeakWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        const response = await super.run(request);
        if (request.capability !== "asset.prepare") return response;
        const assetPlanPath = String(response.output?.assetPlanPath);
        const content = JSON.stringify({
          scene_assets: [{
            scene_position: 1,
            provider: "pexels-stock-v1",
            source_url: path.join(workspaceRoot, "private", "credential.txt"),
            creator: "fixture",
            license_note: "Fixture license.",
          }],
        });
        await writeFile(assetPlanPath, content, "utf8");
        response.artifacts[0]!.kind = "asset_plan";
        response.artifacts[0]!.sha256 = createHash("sha256").update(content).digest("hex");
        response.artifacts[0]!.sizeBytes = Buffer.byteLength(content);
        return response;
      }
    }
    const worker = new SourceLeakWorker();
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
    const packageBytes = await readFile(packageArtifact.uri, "utf8");
    const payload = JSON.parse(packageBytes) as { artifacts: Array<Omit<Artifact, "uri" | "data">> };
    const resourceManifestArtifact = approved.artifacts.find((artifact) => artifact.kind === "resource_manifest");
    assert.ok(resourceManifestArtifact?.uri);
    const resourceManifestBytes = await readFile(resourceManifestArtifact.uri, "utf8");
    assert.equal(new Set(payload.artifacts.map((artifact) => artifact.id)).size, payload.artifacts.length);
    assert.ok(payload.artifacts.some((artifact) => artifact.producer?.attempt === 2));
    assert.ok(payload.artifacts.every((artifact) => !("uri" in artifact) && !("data" in artifact)));
    assert.equal(packageBytes.includes(workspaceRoot), false);
    assert.equal(resourceManifestBytes.includes(workspaceRoot), false);
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

  it("indexes prepared scene media with reusable production metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-asset-index-"));
    class IndexedAssetWorker extends FakeWorker {
      override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        const response = await super.run(request);
        if (request.capability !== "asset.prepare") return response;
        const outputDir = String(request.outputDir);
        const mediaPath = path.join(outputDir, "scene_01.mp4");
        const media = Buffer.from("scene-video");
        await writeFile(mediaPath, media);
        const planPath = String(response.output?.assetPlanPath);
        const plan = JSON.stringify({
          scene_assets: [{
            scene_position: 1,
            provider: "pexels",
            asset_id: "42",
            media_type: "video",
            width: 1080,
            height: 1920,
            duration: 5,
            local_path: mediaPath,
            source_url: "https://www.pexels.com/video/42",
            creator: "Fixture Creator",
            license_note: "Pexels provider terms apply.",
            query: "night office close up",
          }],
        });
        await writeFile(planPath, plan);
        response.artifacts[0] = {
          ...response.artifacts[0]!,
          kind: "asset_plan",
          sha256: createHash("sha256").update(plan).digest("hex"),
          sizeBytes: Buffer.byteLength(plan),
          contentType: "application/json",
        };
        response.artifacts.push({
          kind: "media_asset",
          uri: mediaPath,
          sha256: createHash("sha256").update(media).digest("hex"),
          sizeBytes: media.length,
          contentType: "video/mp4",
          provenance: {
            providerId: "pexels-stock-v1",
            producerNodeId: String(request.nodeRunId),
            attempt: Number(request.attempt),
            licenseNote: "Pexels provider terms apply.",
            sourceUrl: "https://www.pexels.com/video/42",
            creator: "Fixture Creator",
          },
        });
        return response;
      }
    }
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker: new IndexedAssetWorker() });
    const waiting = await subject.start(brief);
    const finished = await subject.decide(waiting.id, {
      interventionId: waiting.interventions.at(-1)!.id,
      action: "approve",
      actor: "director",
    });
    const manifestArtifact = finished.artifacts.find((artifact) => artifact.kind === "resource_manifest");
    assert.ok(manifestArtifact?.uri);
    const manifest = JSON.parse(await readFile(manifestArtifact.uri, "utf8")) as { items: Array<Record<string, unknown>> };
    const scene = manifest.items.find((item) => item.id === "scene:1:pexels-stock-v1");

    assert.equal(scene?.providerId, "pexels-stock-v1");
    assert.equal(scene?.contentType, "video/mp4");
    assert.equal(scene?.width, 1080);
    assert.equal(scene?.height, 1920);
    assert.equal(scene?.durationSeconds, 5);
    assert.equal(scene?.query, "night office close up");
    assert.equal(scene?.selectedInFinal, true);
    assert.equal(manifest.items.filter((item) => item.sha256 === scene?.sha256).length, 1);
  });
});
