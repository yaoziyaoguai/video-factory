import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ProductionPipeline, type WorkerResponse } from "@video-factory/production-pipeline";
import { ProductionStudio } from "../src/server/production-studio.js";
import { StudioService } from "../src/server/studio-service.js";
import { buildStudioApp } from "../src/server/app.js";

// R2-03：恢复动作的暂停解除必须发生在执行租约内、最新业务校验通过之后；
// 旧暂停请求不能跨执行轮次作用于后一次操作。真实 pipeline + 真实持久化，
// 只在模型/worker 边界使用受控替身与确定性 barrier。

const brief = {
  protocolVersion: "video-factory/brief-v1",
  title: "做决定前，先避开这 3 个坑",
  angle: "低风险、可收藏的生活清单",
  audience: "有决策压力的普通上班族",
  nicheSlug: "life-avoidance",
  durationSeconds: 30,
  platform: "douyin",
  reviewMode: "manual",
  runPurpose: "test",
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
    if (capability === "voice.synthesize") await writeFile(String(output.trackPath), "controlled audio fixture");
    if (capability === "video.render") {
      await writeFile(String(output.renderManifestPath), JSON.stringify({
        duration_target: 10,
        slides: [
          { position: 1, duration: 5 },
          { position: 2, duration: 5 },
        ],
      }), "utf8");
    }
    const providerId = String((request.parameters as Record<string, unknown>).providerId);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: capability === this.rejectedCapability ? "rejected" : "succeeded",
      output,
      artifacts: await Promise.all(Object.values(output).filter(value => typeof value === "string").map(async uri => {
        const bytes = await readFile(String(uri));
        return {
          kind: capability.replace(".", "_"),
          uri: String(uri),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
          contentType: uri === output.videoPath ? "video/mp4" : uri === output.trackPath ? "audio/mp4" : "application/json",
          provenance: {
            providerId,
            producerNodeId: String(request.nodeRunId),
            attempt: Number(request.attempt),
            licenseNote: "Fake worker artifact for integration testing.",
          },
        };
      })),
    };
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

class SequenceWorker extends FakeWorker {
  stages = [
    { entered: gate(), released: gate(), fail: false },
    { entered: gate(), released: gate(), fail: false },
  ];
  n = 0;

  override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    if (request.capability === "script.draft") {
      const stage = this.stages[this.n++]!;
      stage.entered.resolve();
      await stage.released.promise;
      if (stage.fail) throw new Error("controlled script failure");
    }
    return super.run(request);
  }
}

/** 首次到达目标 capability 时用确定性 barrier 停住，用于在同轮推进途中发起暂停。 */
class GatedCapabilityWorker extends FakeWorker {
  readonly entered = gate();
  readonly release = gate();
  private consumed = false;

  constructor(private readonly target: string) {
    super();
  }

  override async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    if (String(request.capability) === this.target && !this.consumed) {
      this.consumed = true;
      this.entered.resolve();
      await this.release.promise;
    }
    return super.run(request);
  }
}

describe("pause request scoping and recovery release ordering", () => {
  it("keeps the pause marker when recovery is rejected by current run state (validate before release)", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-preflight-"));
    const worker = new SequenceWorker();
    worker.stages[0]!.fail = true;
    const subject = new ProductionPipeline({
      workspaceRoot,
      worker,
      directorAgent: { id: "api-visual-director-v1", plan: async () => { throw new Error("not expected"); } },
    });
    const supportedBrief = {
      ...brief,
      durationRange: { minSeconds: 20, maxSeconds: 40 },
      providers: { ...brief.providers, director: "api-visual-director-v1" },
      director: { assetProviderIds: ["local-editorial-v1"] },
      workflowFeatures: { executablePlan: true, assetSemanticRank: false, referenceGrammar: false },
    };
    try {
      const dispatch = await subject.dispatch(supportedBrief);
      await worker.stages[0]!.entered.promise;
      await subject.requestPause(dispatch.runId);
      worker.stages[0]!.released.resolve();
      const paused = await dispatch.completion;
      assert.equal(paused.status, "failed");
      const marker = (await subject.readPauseRequest(dispatch.runId))!;
      assert.ok(marker, "失败后暂停标记保留");
      const workerCallsBefore = worker.calls.length;

      const studio = new ProductionStudio({
        workspaceRoot,
        pipeline: subject,
        archiveStore: { list: async () => ({}) } as never,
        listProviders: async () => [],
      });
      // Studio 预检通过后、dispatcher 取得租约前，另一合法操作把 run 改成 stale。
      const original = subject.dispatchRetryFailedNode.bind(subject);
      let editedStatus = "";
      subject.dispatchRetryFailedNode = async (runId, nodeId, listener, options) => {
        const changed = await subject.applyNodeExecutionConfiguration(
          runId, "script", { ...supportedBrief, title: "concurrent edit" }, "peer", paused.revision,
        );
        editedStatus = changed.status;
        return original(runId, nodeId, listener, options);
      };
      let error = "";
      try {
        await studio.retryFailedNode(dispatch.runId, "script", undefined, marker.pauseRequestId);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      // 最新业务校验拒绝（is not failed / stale）：标记必须原样保留，worker 不得再次执行。
      assert.match(error, /not failed|不能重试|刷新/);
      assert.equal(editedStatus, "stale");
      assert.equal(await subject.pauseRequested(dispatch.runId), true, "恢复被拒后暂停标记不能被提前删除");
      const retained = (await subject.readPauseRequest(dispatch.runId))!;
      assert.equal(retained.pauseRequestId, marker.pauseRequestId, "保留的仍是用户所见 token");
      assert.equal(worker.calls.length, workerCallsBefore, "没有为被拒恢复启动新的执行");
    } finally {
      worker.stages.forEach(stage => stage.released.resolve());
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns typed HTTP 409 for a delayed pause that targets a superseded execution round", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-old-round-"));
    const worker = new SequenceWorker();
    worker.stages[0]!.fail = true;
    const subject = new ProductionPipeline({ workspaceRoot, worker });
    const app = buildStudioApp({ service: new StudioService({
      workspaceRoot, repositoryRoot: process.cwd(), pipeline: subject, environment: {}, commandAvailable: async () => false,
    }) });
    const late = gate();
    const entered = gate();
    const original = (subject as unknown as {
      withPauseControlLock: <T>(runId: string, action: () => Promise<T>) => Promise<T>;
    }).withPauseControlLock.bind(subject);
    let first = true;
    (subject as unknown as { withPauseControlLock: <T>(runId: string, action: () => Promise<T>) => Promise<T> })
      .withPauseControlLock = async (runId: string, action: () => Promise<unknown>) => {
        if (first) {
          first = false;
          entered.resolve();
          await late.promise;
        }
        return original(runId, action as () => Promise<never>);
      };
    try {
      const firstDispatch = await subject.dispatch(brief);
      await worker.stages[0]!.entered.promise;
      const firstRun = await subject.loadPersisted(firstDispatch.runId);
      const operationA = firstRun.nodeRuns.find(node => node.nodeId === "script")!.operationRequestId;
      const pendingPause = app.inject({ method: "POST", url: `/api/runs/${firstDispatch.runId}/pause`,
        headers: { "x-video-factory-request": "studio" } }).then(response => response);
      await entered.promise;
      worker.stages[0]!.released.resolve();
      const failed = await firstDispatch.completion;
      assert.equal(failed.status, "failed");

      // A 失败后重试开始新的 operation B（revision 递增）；旧暂停随后才进入短锁。
      const retry = await subject.dispatchRetryFailedNode(firstDispatch.runId, "script");
      await worker.stages[1]!.entered.promise;
      const secondRun = await subject.loadPersisted(firstDispatch.runId);
      const operationB = secondRun.nodeRuns.find(node => node.nodeId === "script")!.operationRequestId;
      assert.notEqual(operationA, operationB);

      late.resolve();
      // 旧暂停针对的执行轮次已被取代：必须拒绝，而不是把 B 的新执行暂停。
      const response = await pendingPause;
      assert.equal(response.statusCode, 409);
      assert.match(response.json().error, /新的操作轮次.*刷新/);
      assert.notEqual(response.json().error, "Internal server error.");
      assert.equal(await subject.pauseRequested(firstDispatch.runId), false, "旧轮次暂停不得写入标记");

      worker.stages[1]!.released.resolve();
      const stopped = await retry.completion;
      assert.notEqual(stopped.status, "paused", "后一次操作不能被旧暂停拦下");
    } finally {
      late.resolve();
      worker.stages.forEach(stage => stage.released.resolve());
      await app.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("still accepts a pause requested during same-round node progression", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-pause-same-round-"));
    const worker = new GatedCapabilityWorker("asset.prepare");
    const subject = new ProductionPipeline({ workspaceRoot, worker });
    try {
      const dispatch = await subject.dispatch(brief);
      // script 已完成、assets 正在执行（同一执行轮次，revision 不递增）。
      await worker.entered.promise;
      await subject.requestPause(dispatch.runId);
      assert.equal(await subject.pauseRequested(dispatch.runId), true);
      worker.release.resolve();
      const settled = await dispatch.completion;
      assert.equal(settled.status, "paused", "同轮推进中的暂停在安全边界正常生效");
    } finally {
      worker.release.resolve();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
