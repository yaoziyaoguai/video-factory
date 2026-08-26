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
            { position: 1, narration: "第一幕", duration: 5, visual_strategy: "stock", visual_prompt: "城市早餐摊" },
            { position: 2, narration: "第二幕", duration: 5, visual_strategy: "stock", visual_prompt: "食物制作特写" },
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
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });

    await subject.start({
      ...brief,
      providers: { ...brief.providers, assets: "seedance-video-v1" },
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 4,
      },
    });

    const parameters = worker.calls.find((call) => call.capability === "asset.prepare")?.parameters as Record<string, unknown>;
    assert.equal(parameters.provider, "seedance");
    assert.equal(parameters.maxPaidShots, 1);
    assert.equal(parameters.maxCostCny, 4);
  });

  it("runs an AI director before assets and passes its per-shot plan to the router", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-production-"));
    const worker = new FakeWorker();
    const directorAgent: pipeline.VisualDirectorAgent = {
      id: "api-visual-director-v1",
      plan: async (input) => ({
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
          alternativeProviderIds: ["local-editorial-v1"],
          query: scene.visualPrompt,
          generationPrompt: scene.visualPrompt,
          rationale: "逐镜选择，与经济策略无固定对应。",
          continuityNote: "保持同一时间和暖色调。",
          confidence: 0.8,
          estimatedCostCny: 0,
        })),
      }),
    };
    const subject = new pipeline.ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent,
      assetProviders: [
        { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"] },
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"] },
      ],
    });

    const run = await subject.start({
      ...brief,
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
    const subject = new pipeline.ProductionPipeline({ workspaceRoot, worker });

    await subject.start({
      ...brief,
      providers: { ...brief.providers, voice: "minimax-tts-v1" },
      voiceDirection: {
        profileId: "minimax:Chinese (Mandarin)_News_Anchor",
        rate: 190,
        pauseScale: 1,
        masteringPreset: "natural",
      },
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
