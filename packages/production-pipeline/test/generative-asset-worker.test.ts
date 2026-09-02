import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  GenerativeAssetWorkerClient,
  WORKER_PROTOCOL_VERSION,
  type VideoGenerationAdapter,
  type ImageGenerationAdapter,
  type WorkerResponse,
} from "../src/index.js";

const resolvePublicHost = async (): Promise<string[]> => ["93.184.216.34"];

describe("GenerativeAssetWorkerClient", () => {
  it("rejects a direct local-card scene before fallback or paid provider calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-direct-local-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "付费生成镜头" },
      { position: 2, duration: 4, visual_strategy: "local", visual_prompt: "未经过导演授权的说明卡" },
    ] }));
    const fallback = new LocalAssetWorker();
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback,
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            paidCalls += 1;
            return { providerId: "seedance-video-v1", taskId: "must-not-run", videoUrl: "https://example.com/no.mp4" };
          },
        },
      }],
    });

    await assert.rejects(
      () => subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1)),
      /local.*director.*editorial_card/i,
    );
    assert.equal(fallback.calls.length, 0);
    assert.equal(paidCalls, 0);
  });

  it("rejects a successful direct local-card response without director authorization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-direct-card-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "不能被说明卡代替" },
    ] }));
    const fallback = new LocalAssetWorker();
    const subject = new GenerativeAssetWorkerClient({ fallback, adapters: [] });
    const request = workerRequest(scriptPath, path.join(root, "attempt-1"), 0, 0);
    request.parameters = {
      providerId: "local-editorial-v1",
      provider: "local",
      maxPaidShots: 0,
      maxCostCny: 0,
    };

    await assert.rejects(
      () => subject.run(request),
      /local card without explicit editorial_card authorization/i,
    );
  });

  it("uses a pending scaffold instead of a local-card baseline for direct generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({
      scenes: [
        { position: 1, duration: 5, visual_strategy: "stock", visual_prompt: "雨夜地铁里的疲惫上班族" },
        { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "清晨站台上的列车进站" },
      ],
    }));
    const fallback = new LocalAssetWorker();
    const generated: string[] = [];
    let taskNumber = 0;
    const adapter: VideoGenerationAdapter = {
      providerId: "seedance-video-v1",
      generate: async (request, onProgress) => {
        taskNumber += 1;
        const taskId = `task-${taskNumber}`;
        generated.push(request.prompt);
        await onProgress?.({ providerId: "seedance-video-v1", taskId, status: "submitted" });
        await onProgress?.({
          providerId: "seedance-video-v1",
          taskId,
          status: "succeeded",
          videoUrl: `https://example.com/generated-${taskNumber}.mp4`,
        });
        return {
          providerId: "seedance-video-v1",
          taskId,
          videoUrl: `https://example.com/generated-${taskNumber}.mp4`,
        };
      },
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback,
      adapters: [{ adapter, estimatedCnyPerClip: 3.5 }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("generated-video-bytes", {
        headers: { "content-type": "video/mp4" },
      }),
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 8));

    assert.equal(response.status, "succeeded");
    assert.equal(fallback.calls.length, 1);
    assert.equal((fallback.calls[0]?.parameters as Record<string, unknown>).provider, "ai-router");
    assert.equal(typeof (fallback.calls[0]?.input as Record<string, unknown>).directorPlanPath, "string");
    assert.deepEqual(generated, ["雨夜地铁里的疲惫上班族", "清晨站台上的列车进站"]);
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    assert.equal(plan.scene_assets[0].provider, "seedance-video-v1");
    assert.equal(plan.scene_assets[0].asset_id, "task-1");
    assert.equal(Object.hasOwn(plan.scene_assets[0], "source_url"), false);
    assert.equal(plan.scene_assets[1].provider, "seedance-video-v1");
    assert.equal(plan.scene_assets[1].asset_id, "task-2");
    assert.equal(await readFile(plan.scene_assets[0].local_path, "utf8"), "generated-video-bytes");
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));
    assert.deepEqual(jobs.jobs[0], {
      scenePosition: 1,
      providerId: "seedance-video-v1",
      taskId: "task-1",
      status: "succeeded",
      estimatedCostCny: 3.5,
      actualCostCny: 3.5,
      actualCostSource: "configured_rate",
      mediaType: "video",
      videoUrl: "https://example.com/generated-1.mp4",
    });
    assert.equal(response.artifacts.some((artifact) => artifact.provenance.sourceUrl === "local://video-factory/card"), false);
    assert.equal(response.artifacts.some((artifact) => artifact.kind === "generation_jobs"), true);
    assert.equal(response.artifacts.some((artifact) => artifact.kind === "media_asset"), true);
  });

  it("refuses direct paid shots without a current spend authorization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-direct-unlimited-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "第一条生成镜头" },
      { position: 2, duration: 4, visual_strategy: "generated", visual_prompt: "第二条生成镜头" },
    ] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            paidCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: `direct-unlimited-${paidCalls}`,
              videoUrl: `https://example.com/direct-unlimited-${paidCalls}.mp4`,
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("generated-video", { headers: { "content-type": "video/mp4" } }),
    });

    await assert.rejects(
      () => subject.run(workerRequest(scriptPath, outputDir, 0, 0)),
      /requires a positive spend authorization/i,
    );
    assert.equal(paidCalls, 0);
  });

  it("does not resubmit a materialized paid item across retries or new operation ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "跨重启幂等测试" },
    ] }));
    let providerCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            providerCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: `paid-task-${providerCalls}`,
              videoUrl: "https://example.com/generated.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("video", { headers: { "content-type": "video/mp4" } }),
    });

    await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 2));
    const reconciled = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 2),
      attempt: 2,
    });
    assert.equal(reconciled.status, "succeeded");
    assert.equal(providerCalls, 1);

    await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-3"), 1, 2),
      commandId: "command-2",
      attempt: 2,
    });
    assert.equal(providerCalls, 1);
  });

  it("redownloads an accepted paid task without creating it again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reconcile-download-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "只重下已完成任务" },
    ] }));
    let providerCalls = 0;
    let downloadCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            providerCalls += 1;
            await onProgress?.({
              providerId: "seedance-video-v1",
              taskId: "accepted-task-1",
              status: "succeeded",
              videoUrl: "https://example.com/accepted.mp4",
            });
            return {
              providerId: "seedance-video-v1",
              taskId: "accepted-task-1",
              videoUrl: "https://example.com/accepted.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => {
        downloadCalls += 1;
        return downloadCalls === 1
          ? new Response("temporary failure", { status: 503 })
          : new Response("recovered-video", { headers: { "content-type": "video/mp4" } });
      },
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(first.status, "failed");

    const second = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 1),
      attempt: 2,
    });

    assert.equal(second.status, "succeeded");
    assert.equal(providerCalls, 1);
    assert.equal(downloadCalls, 2);
    assert.equal(second.diagnostics?.actualCostCny, 0);
    assert.equal(second.diagnostics?.meteredAttemptCount, 0);
    const plan = JSON.parse(await readFile(String(second.output?.assetPlanPath), "utf8"));
    assert.equal(plan.scene_assets[0].asset_id, "accepted-task-1");
    assert.equal(await readFile(plan.scene_assets[0].local_path, "utf8"), "recovered-video");
  });

  it("carries an accepted paid task into a new authorized operation without creating it again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-carry-accepted-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "跨核销继续下载" },
    ] }));
    let providerCalls = 0;
    let downloadCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            providerCalls += 1;
            await onProgress?.({
              providerId: "seedance-video-v1",
              taskId: "accepted-task-across-operation",
              status: "succeeded",
              videoUrl: "https://example.com/accepted-across-operation.mp4",
            });
            return {
              providerId: "seedance-video-v1",
              taskId: "accepted-task-across-operation",
              videoUrl: "https://example.com/accepted-across-operation.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => {
        downloadCalls += 1;
        return downloadCalls === 1
          ? new Response("temporary failure", { status: 503 })
          : new Response("recovered-video", { headers: { "content-type": "video/mp4" } });
      },
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(first.status, "failed");

    const second = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0),
      commandId: "command-2",
      attempt: 2,
    });

    assert.equal(second.status, "succeeded");
    assert.equal(providerCalls, 1);
    assert.equal(downloadCalls, 2);
    assert.equal(second.diagnostics?.actualCostCny, 0);
    assert.equal(second.diagnostics?.meteredAttemptCount, 0);
  });

  it("queries a timed-out submitted task by taskId instead of creating it again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reconcile-query-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "按任务号续查" },
    ] }));
    let createCalls = 0;
    let queryCalls = 0;
    const adapter = {
      providerId: "seedance-video-v1",
      generate: async (_request: Parameters<VideoGenerationAdapter["generate"]>[0], onProgress?: Parameters<VideoGenerationAdapter["generate"]>[1]) => {
        createCalls += 1;
        await onProgress?.({ providerId: "seedance-video-v1", taskId: "submitted-task-1", status: "submitted" });
        await onProgress?.({ providerId: "seedance-video-v1", taskId: "submitted-task-1", status: "unknown", error: "local polling timeout" });
        throw new Error("worker lost connection while polling");
      },
      reconcile: async (taskId: string) => {
        queryCalls += 1;
        assert.equal(taskId, "submitted-task-1");
        return {
          providerId: "seedance-video-v1",
          taskId,
          status: "succeeded" as const,
          videoUrl: "https://example.com/reconciled.mp4",
        };
      },
    } as VideoGenerationAdapter & {
      reconcile(taskId: string): Promise<{
        providerId: string;
        taskId: string;
        status: "succeeded";
        videoUrl: string;
      }>;
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{ adapter, estimatedCnyPerClip: 1 }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("queried-video", { headers: { "content-type": "video/mp4" } }),
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(first.status, "failed");
    const second = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 1),
      attempt: 2,
    });

    assert.equal(second.status, "succeeded");
    assert.equal(createCalls, 1);
    assert.equal(queryCalls, 1);
  });

  it("preserves successful paid items and creates only failed or unstarted items under a new operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-incremental-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "镜头一" },
      { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "镜头二" },
      { position: 3, duration: 5, visual_strategy: "generated", visual_prompt: "镜头三" },
    ] }));
    const calls = new Map<string, number>();
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (request, onProgress) => {
            const count = (calls.get(request.prompt) ?? 0) + 1;
            calls.set(request.prompt, count);
            const taskId = `${request.prompt}-task-${count}`;
            if (request.prompt === "镜头二" && count === 1) {
              await onProgress?.({
                providerId: "seedance-video-v1",
                taskId,
                status: "failed",
                error: "provider confirmed failure",
              });
              throw new Error("provider confirmed failure");
            }
            await onProgress?.({
              providerId: "seedance-video-v1",
              taskId,
              status: "succeeded",
              videoUrl: `https://example.com/${encodeURIComponent(taskId)}.mp4`,
            });
            return {
              providerId: "seedance-video-v1",
              taskId,
              videoUrl: `https://example.com/${encodeURIComponent(taskId)}.mp4`,
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async (url) => new Response(`bytes:${String(url)}`, { headers: { "content-type": "video/mp4" } }),
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 3, 3));
    assert.equal(first.status, "failed");
    const firstPlan = JSON.parse(await readFile(String(first.output?.assetPlanPath), "utf8"));
    const firstScenePath = firstPlan.scene_assets[0].local_path as string;
    const firstSceneBytes = await readFile(firstScenePath);
    const firstSceneSha = createHash("sha256").update(firstSceneBytes).digest("hex");

    const second = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 2, 2),
      commandId: "command-2",
      attempt: 2,
    });

    assert.equal(second.status, "succeeded");
    assert.deepEqual(Object.fromEntries(calls), { "镜头一": 1, "镜头二": 2, "镜头三": 1 });
    const secondPlan = JSON.parse(await readFile(String(second.output?.assetPlanPath), "utf8"));
    assert.equal(secondPlan.scene_assets[0].asset_id, "镜头一-task-1");
    assert.equal(secondPlan.scene_assets[0].local_path, firstScenePath);
    assert.equal(createHash("sha256").update(await readFile(secondPlan.scene_assets[0].local_path)).digest("hex"), firstSceneSha);
    assert.equal(second.diagnostics?.actualCostCny, 2);
    assert.equal(second.diagnostics?.meteredAttemptCount, 2);
  });

  it("refuses a generation request before external calls when its estimate exceeds the budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "第一条付费镜头" },
      { position: 2, duration: 4, visual_strategy: "generated", visual_prompt: "第二条付费镜头" },
    ] }));
    let called = false;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            called = true;
            throw new Error("must not run");
          },
        },
      }],
    });

    await assert.rejects(
      () => subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 2, 5)),
      /estimated cost.*7.*authorized maximum.*5/i,
    );
    assert.equal(called, false);
  });

  it("routes an allowlisted run model to the adapter and records its model-specific estimate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "清晨街边早餐摊" },
    ] }));
    const receivedModels: Array<string | undefined> = [];
    const receivedDurations: number[] = [];
    const receivedResolutions: Array<string | undefined> = [];
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        defaultModelId: "doubao-seedance-2-5-260628",
        modelPrices: { "doubao-seedance-2-5-260628": 2.4 },
        modelProfiles: {
          "doubao-seedance-2-5-260628": {
            taskTypes: ["text-to-video", "image-to-video"],
            resolutions: ["480p", "720p", "1080p"],
            minDurationSeconds: 4,
            maxDurationSeconds: 15,
            supportsAudio: true,
          },
        },
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (request) => {
            receivedModels.push(request.modelId);
            receivedDurations.push(request.durationSeconds);
            receivedResolutions.push(request.resolution);
            assert.equal(request.generateAudio, false);
            return { providerId: "seedance-video-v1", taskId: "model-task", videoUrl: "https://example.com/model.mp4" };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("model-video", { headers: { "content-type": "video/mp4" } }),
    });
    const request = workerRequest(scriptPath, outputDir, 1, 3);
    (request.parameters as Record<string, unknown>).modelSelections = { "seedance-video-v1": "doubao-seedance-2-5-260628" };

    const response = await subject.run(request);
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.deepEqual(receivedModels, ["doubao-seedance-2-5-260628"]);
    assert.deepEqual(receivedDurations, [4]);
    assert.deepEqual(receivedResolutions, ["720p"]);
    assert.equal(jobs.jobs[0].modelId, "doubao-seedance-2-5-260628");
    assert.equal(jobs.jobs[0].estimatedCostCny, 2.4);
    assert.equal(response.diagnostics?.estimatedCostCny, 2.4);
    assert.equal(response.diagnostics?.actualCostCny, 2.4);
    assert.equal(response.diagnostics?.actualCostSource, "configured_rate");
    assert.deepEqual(response.diagnostics?.actualModelIds, ["doubao-seedance-2-5-260628"]);
  });

  it("rejects invalid model-specific prices during configuration", () => {
    assert.throws(() => new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        modelPrices: { "doubao-seedance-2-5-260628": Number.NaN },
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({ providerId: "seedance-video-v1", taskId: "never", videoUrl: "https://example.com/never.mp4" }),
        },
      }],
    }), /invalid price/);
  });

  it("prices a video model by the resolution actually selected for generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "雨夜城市街道" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1.65,
        defaultModelId: "MiniMax-H3-Max",
        modelPrices: { "MiniMax-H3-Max": 1.65 },
        modelProfiles: {
          "MiniMax-H3-Max": {
            taskTypes: ["text-to-video"],
            resolutions: ["480P", "768P"],
            minDurationSeconds: 5,
            maxDurationSeconds: 15,
            supportsAudio: true,
            estimatedCnyPerSecond: 0.33,
            estimatedCnyPerSecondByResolution: { "480P": 0.33, "768P": 0.5 },
          },
        },
        adapter: {
          providerId: "hailuo-video-v1",
          generate: async (request) => {
            assert.equal(request.resolution, "768P");
            return { providerId: "hailuo-video-v1", taskId: "h3-max-task", videoUrl: "https://example.com/h3.mp4" };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("h3-video", { headers: { "content-type": "video/mp4" } }),
    });

    const request = workerRequest(scriptPath, outputDir, 1, 3);
    (request.parameters as Record<string, unknown>).providerId = "hailuo-video-v1";
    (request.parameters as Record<string, unknown>).modelSelections = { "hailuo-video-v1": "MiniMax-H3-Max" };
    const response = await subject.run(request);

    assert.equal(response.diagnostics?.estimatedCostCny, 2.5);
    assert.equal(response.diagnostics?.actualCostCny, 2.5);
  });

  it("clamps paid requests to the selected model runtime boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 15, visual_strategy: "generated", visual_prompt: "城市延时" },
    ] }));
    let durationSeconds = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 2,
        defaultModelId: "short-model",
        modelPrices: { "short-model": 2 },
        modelProfiles: {
          "short-model": {
            taskTypes: ["text-to-video"],
            resolutions: ["480p"],
            minDurationSeconds: 4,
            maxDurationSeconds: 12,
            supportsAudio: false,
          },
        },
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (request) => {
            durationSeconds = request.durationSeconds;
            return { providerId: "seedance-video-v1", taskId: "short-task", videoUrl: "https://example.com/short.mp4" };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("short-video", { headers: { "content-type": "video/mp4" } }),
    });

    await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 3));

    assert.equal(durationSeconds, 12);
  });

  it("fails the node after a paid shot fails instead of returning a local baseline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({
      scenes: [
        { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "清晨城市的第一班地铁" },
        { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "不应继续提交的第二个镜头" },
      ],
    }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            paidCalls += 1;
            await onProgress?.({ providerId: "seedance-video-v1", taskId: "task-failed", status: "submitted" });
            throw new Error("provider capacity exhausted");
          },
        },
      }],
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 8));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(response.status, "failed");
    assert.equal(paidCalls, 1);
    assert.equal(response.error?.code, "ASSET_GENERATION_FAILED");
    assert.match(response.error?.message ?? "", /provider capacity exhausted/);
    assert.equal(plan.scene_assets[0].provider, "seedance-video-v1");
    assert.equal(plan.scene_assets[0].local_path, "");
    assert.equal(jobs.jobs[0].status, "failed");
    assert.equal(jobs.jobs[0].error, "provider capacity exhausted");
    assert.equal(response.diagnostics?.attemptedScenes, 1);
    assert.equal(response.diagnostics?.generatedScenes, 0);
    assert.equal(response.diagnostics?.fallbackScenes, 0);
    assert.equal(response.diagnostics?.actualCostCny, 3.5);
    assert.equal(response.diagnostics?.actualCostSource, "configured_rate");
    assert.equal(response.diagnostics?.meteredAttemptCount, 1);
    assert.equal(response.diagnostics?.meteredFailedAttemptCount, 1);
    assert.equal(jobs.jobs[0].actualCostCny, 3.5);
    assert.equal(jobs.jobs[0].actualCostSource, "configured_rate");
    assert.equal(plan.generation.actualCostCny, 3.5);
    assert.equal(plan.generation.meteredAttemptCount, 1);
    assert.equal(plan.generation.meteredFailedAttemptCount, 1);
    assert.equal(response.artifacts.some((artifact) => artifact.kind === "media_asset"), false);
  });

  it("does not count a provider rejection before task submission as a metered attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "宣纸上的水墨山峰" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 8,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            throw new Error("model has not been activated");
          },
        },
      }],
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 8));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(jobs.jobs[0].taskId, undefined);
    assert.equal(jobs.jobs[0].status, "failed");
    assert.equal(response.diagnostics?.actualCostCny, 0);
    assert.equal(response.diagnostics?.meteredAttemptCount, 0);
    assert.equal(response.diagnostics?.meteredFailedAttemptCount, 0);
    assert.equal(response.diagnostics?.actualModelIds, undefined);
    assert.equal(plan.generation.meteredAttemptCount, 0);
    assert.equal(plan.generation.meteredFailedAttemptCount, 0);
    assert.equal(plan.generation.actualModelIds, undefined);
  });

  it("executes the AI director route instead of deriving a fixed material mix from the recipe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({
      scenes: [
        { position: 1, duration: 5, visual_strategy: "stock", visual_prompt: "城市早餐摊" },
        { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "热气升起的食物特写" },
      ],
    }));
    await writeFile(directorPlanPath, JSON.stringify({
      version: "video-factory/director-plan-v1",
      shots: [
        {
          scenePosition: 1,
          preferredProviderId: "pexels-stock-v1",
          alternativeProviderIds: ["local-editorial-v1"],
          query: "Chinese breakfast street food vertical",
          generationPrompt: "",
          rationale: "真实食物环境镜头",
        },
        {
          scenePosition: 2,
          preferredProviderId: "seedance-video-v1",
          alternativeProviderIds: ["local-editorial-v1"],
          query: "",
          generationPrompt: "中式早餐特写；预算已经审批；版权需要人工确认",
          subject: "刚出锅的中式早餐",
          environment: "清晨街边摊位",
          visibleAction: "白色蒸汽从食物表面持续上升",
          temporalBeats: ["[0s-2s] 镜头贴近食物表面", "[2s-5s] 蒸汽上升并掠过侧逆光"],
          shotSize: "微距特写",
          camera: "缓慢推进后保持稳定",
          lighting: "暖色自然侧逆光",
          negativeConstraints: ["不出现文字水印"],
          successCriteria: ["蒸汽持续可见", "食物主体不变形"],
          rationale: "付费只用于无法精准检索的核心特写",
        },
      ],
    }));
    const fallback = new LocalAssetWorker();
    const generated: string[] = [];
    const subject = new GenerativeAssetWorkerClient({
      fallback,
      adapters: [{
        estimatedCnyPerClip: 3.5,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (request) => {
            generated.push(request.prompt);
            return {
              providerId: "seedance-video-v1",
              taskId: "task-routed",
              videoUrl: "https://example.com/routed.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("routed-video", { headers: { "content-type": "video/mp4" } }),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 1, 4));

    assert.equal(response.status, "succeeded");
    assert.equal((fallback.calls[0]?.parameters as Record<string, unknown>).provider, "ai-router");
    assert.equal((fallback.calls[0]?.input as Record<string, unknown>).directorPlanPath, directorPlanPath);
    assert.equal(generated.length, 1);
    assert.match(generated[0]!, /导演执行描述：中式早餐特写/);
    assert.match(generated[0]!, /\[0s-2s\]/);
    assert.match(generated[0]!, /可见动作：白色蒸汽/);
    assert.match(generated[0]!, /必须实现：蒸汽持续可见/);
    assert.doesNotMatch(generated[0]!, /预算|审批|版权|工作流/);
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    assert.equal(plan.scene_assets[0].provider, "pexels");
    assert.equal(plan.scene_assets[1].provider, "seedance-video-v1");
    assert.equal(plan.director_routing[1].actual_provider_id, "seedance-video-v1");
    assert.equal(plan.director_routing[1].actual_provider, "seedance-video-v1");
    assert.equal(plan.director_routing[1].generation_pending, false);
    assert.equal(plan.director_routing[1].fallback_used, false);
    assert.equal(plan.generation.estimatedCostCny, 3.5);
    assert.equal(plan.generation.actualCostCny, 3.5);
    assert.equal(plan.generation.actualCostSource, "configured_rate");
    assert.equal(plan.generation.meteredAttemptCount, 1);
    assert.equal(plan.generation.meteredFailedAttemptCount, 0);
    assert.deepEqual(plan.generation.actualModelIds, ["seedance-video-v1"]);
  });

  it("rejects a successful asset plan that does not exactly cover the script scenes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-incomplete-plan-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    const planPath = path.join(root, "asset_plan.json");
    const mediaPath = path.join(root, "scene_01.png");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "local", visual_prompt: "第一张说明卡" },
      { position: 2, duration: 4, visual_strategy: "local", visual_prompt: "第二张说明卡" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [1, 2].map((scenePosition) => ({
      scenePosition,
      preferredProviderId: "local-editorial-v1",
      deliveryType: "editorial_card",
      query: `card ${scenePosition}`,
    })) }));
    await writeFile(mediaPath, "card");
    await writeFile(planPath, JSON.stringify({
      scene_assets: [localAsset(1, mediaPath)],
      director_routing: [{
        scene_position: 1,
        preferred_provider_id: "local-editorial-v1",
        actual_provider_id: "local-editorial-v1",
        actual_provider: "local",
        generation_pending: false,
      }],
    }));
    const fallback = {
      run: async (): Promise<WorkerResponse> => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        commandId: "command-routed",
        status: "succeeded",
        output: { assetPlanPath: planPath },
        artifacts: [],
      }),
    };
    const subject = new GenerativeAssetWorkerClient({ fallback, adapters: [] });

    await assert.rejects(
      () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 0, 0)),
      /exactly cover every script scene/i,
    );
  });

  it("rejects an obsolete local-card artifact that is not referenced by the final plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-stale-card-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const planPath = path.join(root, "asset_plan.json");
    const finalPath = path.join(root, "stock.mp4");
    const staleCardPath = path.join(root, "old-card.png");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "stock", visual_prompt: "真实图库镜头" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [{
      scenePosition: 1,
      preferredProviderId: "pexels-stock-v1",
      deliveryType: "stock_video",
      query: "stock shot",
    }] }));
    await writeFile(finalPath, "stock");
    await writeFile(staleCardPath, "old card");
    await writeFile(planPath, JSON.stringify({
      scene_assets: [{ ...localAsset(1, finalPath), provider: "pexels", source_url: "https://pexels.example/1" }],
      director_routing: [{
        scene_position: 1,
        preferred_provider_id: "pexels-stock-v1",
        actual_provider_id: "pexels-stock-v1",
        actual_provider: "pexels",
        generation_pending: false,
      }],
    }));
    const staleBytes = await readFile(staleCardPath);
    const fallback = {
      run: async (): Promise<WorkerResponse> => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        commandId: "command-routed",
        status: "succeeded",
        output: { assetPlanPath: planPath },
        artifacts: [{
          kind: "media_asset",
          uri: staleCardPath,
          sha256: createHash("sha256").update(staleBytes).digest("hex"),
          sizeBytes: staleBytes.byteLength,
          contentType: "image/png",
          provenance: {
            providerId: "local-editorial-v1",
            producerNodeId: "assets",
            attempt: 1,
            licenseNote: "Obsolete local card.",
            sourceUrl: "local://video-factory/card",
          },
        }],
      }),
    };
    const subject = new GenerativeAssetWorkerClient({ fallback, adapters: [] });

    await assert.rejects(
      () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, path.join(root, "attempt-1"), 0, 0)),
      /obsolete media artifact/i,
    );
  });

  it("refuses paid director shots without a current spend authorization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-unlimited-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "第一条生成镜头" },
      { position: 2, duration: 4, visual_strategy: "generated", visual_prompt: "第二条生成镜头" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      { scenePosition: 1, preferredProviderId: "seedance-video-v1", deliveryType: "generated_video", generationPrompt: "第一条生成镜头" },
      { scenePosition: 2, preferredProviderId: "seedance-video-v1", deliveryType: "generated_video", generationPrompt: "第二条生成镜头" },
    ] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            paidCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: `unlimited-task-${paidCalls}`,
              videoUrl: `https://example.com/unlimited-${paidCalls}.mp4`,
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("generated-video", { headers: { "content-type": "video/mp4" } }),
    });

    await assert.rejects(
      () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 0, 0)),
      /requires a positive spend authorization/i,
    );
    assert.equal(paidCalls, 0);
  });

  it("executes every shot in a large director plan once its exact quote is authorized", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-safety-boundary-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const scenes = Array.from({ length: 21 }, (_, index) => ({
      position: index + 1,
      duration: 4,
      visual_strategy: "generated",
      visual_prompt: `生成镜头 ${index + 1}`,
    }));
    await writeFile(scriptPath, JSON.stringify({ scenes }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: scenes.map((scene) => ({
      scenePosition: scene.position,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      generationPrompt: scene.visual_prompt,
    })) }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            paidCalls += 1;
            return { providerId: "seedance-video-v1", taskId: `approved-${paidCalls}`, videoUrl: `https://example.com/approved-${paidCalls}.mp4` };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("generated-video", { headers: { "content-type": "video/mp4" } }),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, path.join(root, "attempt-1"), 0, 21));
    assert.equal(response.status, "succeeded");
    assert.equal(paidCalls, 21);
  });

  it("propagates a generated master asset through direct and indirect REUSE_ONLY routes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reuse-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "窗边水杯与移动的杯影" },
      { position: 2, duration: 4, visual_strategy: "stock", visual_prompt: "复用同一母片近裁杯底亮斑" },
      { position: 3, duration: 4, visual_strategy: "stock", visual_prompt: "再次复用相同母片" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      {
        scenePosition: 1,
        preferredProviderId: "hailuo-video-v1",
        alternativeProviderIds: ["local-editorial-v1"],
        query: "glass water sunlight shadow windowsill timelapse",
        generationPrompt: "固定机位拍摄窗边水杯与移动的杯影。",
      },
      {
        scenePosition: 2,
        preferredProviderId: "pexels-stock-v1",
        alternativeProviderIds: ["local-editorial-v1"],
        query: "REUSE_ONLY scene one locked master crop",
        generationPrompt: "复用第一镜母片并近裁杯底亮斑。",
      },
      {
        scenePosition: 3,
        preferredProviderId: "pexels-stock-v1",
        alternativeProviderIds: ["local-editorial-v1"],
        reuseFromScenePosition: 2,
        query: "REUSE_ONLY scene 2 locked master crop",
        generationPrompt: "复用第二镜所引用的同一母片。",
      },
    ] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 2,
        adapter: {
          providerId: "hailuo-video-v1",
          generate: async () => {
            paidCalls += 1;
            return { providerId: "hailuo-video-v1", taskId: "master-task", videoUrl: "https://example.com/master.mp4" };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("master-video", { headers: { "content-type": "video/mp4" } }),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 1, 2));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));

    assert.equal(paidCalls, 1);
    assert.equal(plan.scene_assets[0].provider, "hailuo-video-v1");
    assert.equal(plan.scene_assets[1].provider, "hailuo-video-v1");
    assert.equal(plan.scene_assets[2].provider, "hailuo-video-v1");
    assert.equal(plan.scene_assets[1].local_path, plan.scene_assets[0].local_path);
    assert.equal(plan.scene_assets[2].local_path, plan.scene_assets[0].local_path);
    assert.equal(plan.director_routing[1].actual_provider_id, "hailuo-video-v1");
    assert.equal(plan.director_routing[1].generation_pending, false);
    assert.equal(plan.director_routing[1].fallback_used, false);
    assert.equal(plan.director_routing[2].actual_provider_id, "hailuo-video-v1");
    assert.equal(plan.director_routing[2].generation_pending, false);
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));
    assert.equal(jobs.jobs.length, 1);
  });

  it("keeps direct and indirect REUSE_ONLY dependents failed when their master generation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reuse-failure-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [1, 2, 3].map((position) => ({
      position, duration: 4, visual_strategy: "generated", visual_prompt: `scene ${position}`,
    })) }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      { scenePosition: 1, preferredProviderId: "hailuo-video-v1", query: "master", generationPrompt: "master" },
      { scenePosition: 2, preferredProviderId: "pexels-stock-v1", query: "REUSE_ONLY scene 1", generationPrompt: "reuse 1" },
      { scenePosition: 3, preferredProviderId: "pexels-stock-v1", reuseFromScenePosition: 2, query: "REUSE_ONLY scene 2", generationPrompt: "reuse 2" },
    ] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 2,
        adapter: {
          providerId: "hailuo-video-v1",
          generate: async (_request, onProgress) => {
            paidCalls += 1;
            await onProgress?.({ providerId: "hailuo-video-v1", taskId: "failed-master", status: "submitted" });
            throw new Error("master generation failed");
          },
        },
      }],
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 1, 2));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(response.status, "failed");
    assert.equal(paidCalls, 1);
    assert.equal(jobs.jobs.length, 1);
    assert.equal(jobs.jobs[0].status, "failed");
    assert.deepEqual(plan.scene_assets.map((asset: { local_path: string }) => asset.local_path), ["", "", ""]);
    assert.deepEqual(plan.director_routing.map((route: { generation_pending: boolean }) => route.generation_pending), [true, true, true]);
    assert.equal(response.artifacts.some((artifact) => artifact.kind === "media_asset"), false);
  });

  it("rejects invalid REUSE_ONLY graphs before any paid call or local-card baseline", async () => {
    const cases = [
      { name: "missing source", sources: { 2: 9 } },
      { name: "self reference", sources: { 2: 2 } },
      { name: "forward reference", sources: { 1: 2 } },
      { name: "invalid indirect chain", sources: { 2: 1, 3: 4 } },
    ] as const;

    for (const testCase of cases) {
      const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-invalid-reuse-"));
      const scriptPath = path.join(root, "script.json");
      const directorPlanPath = path.join(root, "director_plan.json");
      const outputDir = path.join(root, "attempt-1");
      await writeFile(scriptPath, JSON.stringify({ scenes: [1, 2, 3].map((position) => ({
        position,
        duration: 4,
        visual_strategy: "generated",
        visual_prompt: `scene ${position}`,
      })) }));
      await writeFile(directorPlanPath, JSON.stringify({ shots: [1, 2, 3].map((scenePosition) => {
        const source = testCase.sources[scenePosition as keyof typeof testCase.sources];
        return source === undefined
          ? { scenePosition, preferredProviderId: "hailuo-video-v1", query: `master ${scenePosition}`, generationPrompt: `master ${scenePosition}` }
          : { scenePosition, preferredProviderId: "pexels-stock-v1", reuseFromScenePosition: source, query: `REUSE_ONLY scene ${source}`, generationPrompt: `reuse ${source}` };
      }) }));
      const fallback = new LocalAssetWorker();
      let paidCalls = 0;
      const subject = new GenerativeAssetWorkerClient({
        fallback,
        adapters: [{
          estimatedCnyPerClip: 2,
          adapter: {
            providerId: "hailuo-video-v1",
            generate: async () => {
              paidCalls += 1;
              return { providerId: "hailuo-video-v1", taskId: "must-not-run", videoUrl: "https://example.com/no.mp4" };
            },
          },
        }],
      });

      await assert.rejects(
        () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 3, 6)),
        /must reuse an earlier director scene/,
        testCase.name,
      );
      assert.equal(paidCalls, 0, testCase.name);
      assert.equal(fallback.calls.length, 0, testCase.name);
    }
  });

  it("uses server adapter prices to reject an AI route that exceeds its budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "镜头一" },
      { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "镜头二" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      { scenePosition: 1, preferredProviderId: "seedance-video-v1", generationPrompt: "镜头一" },
      { scenePosition: 2, preferredProviderId: "seedance-video-v1", generationPrompt: "镜头二" },
    ] }));
    let called = false;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            called = true;
            throw new Error("must not run");
          },
        },
      }],
    });

    await assert.rejects(
      () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, path.join(root, "attempt-1"), 2, 6)),
      /estimated cost.*7.*authorized maximum.*6/i,
    );
    assert.equal(called, false);
  });

  it("lets the director mix generated images and videos per shot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "食物成分剖面" },
      { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "蒸汽升起的早餐" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "中式早餐食材剖面，编辑摄影" },
      { scenePosition: 2, preferredProviderId: "seedance-video-v1", generationPrompt: "早餐蒸汽缓慢上升，微距镜头" },
    ] }));
    const imageAdapter: ImageGenerationAdapter = {
      providerId: "seedream-image-v1",
      generate: async () => ({
        providerId: "seedream-image-v1",
        taskId: "image-task",
        imageUrl: "https://example.com/generated.png",
      }),
    };
    const videoAdapter: VideoGenerationAdapter = {
      providerId: "seedance-video-v1",
      generate: async () => ({
        providerId: "seedance-video-v1",
        taskId: "video-task",
        videoUrl: "https://example.com/generated.mp4",
      }),
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{ adapter: videoAdapter, estimatedCnyPerClip: 3.5 }],
      imageAdapters: [{ adapter: imageAdapter, estimatedCnyPerImage: 0.25 }],
      resolveHost: resolvePublicHost,
      fetch: async (input) => new Response(
        String(input).endsWith(".png") ? "generated-image" : "generated-video",
        { headers: { "content-type": String(input).endsWith(".png") ? "image/png" : "video/mp4" } },
      ),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 2, 4));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(plan.scene_assets[0].provider, "seedream-image-v1");
    assert.equal(plan.scene_assets[0].media_type, "image");
    assert.match(plan.scene_assets[0].local_path, /seedream-image-v1\.png$/);
    assert.equal(plan.scene_assets[1].provider, "seedance-video-v1");
    assert.equal(plan.scene_assets[1].media_type, "video");
    assert.deepEqual(jobs.jobs.map((job: { mediaType: string }) => job.mediaType), ["image", "video"]);
    assert.equal(plan.generation.estimatedCostCny, 3.75);
    assert.equal(response.diagnostics?.actualCostCny, 3.75);
    assert.equal(response.diagnostics?.actualCostSource, "configured_rate");
    assert.deepEqual(response.diagnostics?.actualModelIds, ["seedream-image-v1", "seedance-video-v1"]);
  });

  it("requires an explicit retry when the director's selected paid provider is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "城市雨夜" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      {
        scenePosition: 1,
        preferredProviderId: "hailuo-video-v1",
        alternativeProviderIds: ["seedance-video-v1", "local-editorial-v1"],
        generationPrompt: "雨夜城市，纪实电影镜头",
      },
    ] }));
    let generated = false;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            generated = true;
            return { providerId: "seedance-video-v1", taskId: "alternative-task", videoUrl: "https://example.com/alternative.mp4" };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("alternative-video", { headers: { "content-type": "video/mp4" } }),
    });

    await assert.rejects(
      () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 1, 4)),
      /Provider 'hailuo-video-v1' is not configured/,
    );
    assert.equal(generated, false);
  });

  it("rejects a stale selected model before producing a local fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "清晨早餐摊" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [{
      scenePosition: 1,
      preferredProviderId: "seedance-video-v1",
      alternativeProviderIds: ["local-editorial-v1"],
      generationPrompt: "清晨侧逆光中的早餐摊",
    }] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        defaultModelId: "reviewed-model",
        modelPrices: { "reviewed-model": 2.4 },
        modelProfiles: {
          "reviewed-model": {
            taskTypes: ["text-to-video"], resolutions: ["720p"],
            minDurationSeconds: 4, maxDurationSeconds: 10, supportsAudio: false,
          },
        },
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            paidCalls += 1;
            throw new Error("must not call");
          },
        },
      }],
    });
    const request = routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 1, 4);
    (request.parameters as Record<string, unknown>).modelSelections = { "seedance-video-v1": "removed-model" };

    await assert.rejects(() => subject.run(request), /does not expose model 'removed-model'/);
    assert.equal(paidCalls, 0);
  });

  it("rejects an edited director route that contains only unknown asset providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "清晨早餐摊" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [{
      scenePosition: 1,
      preferredProviderId: "seednace-typo-v1",
      alternativeProviderIds: [],
      generationPrompt: "清晨早餐摊",
    }] }));
    const subject = new GenerativeAssetWorkerClient({ fallback: new LocalAssetWorker(), adapters: [] });

    await assert.rejects(
      () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, path.join(root, "attempt-1"), 1, 4)),
      /not a recognized asset source/,
    );
  });

  it("rejects an unimplemented free provider instead of silently substituting a local card", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "stock", visual_prompt: "社区早餐摊" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [{
      scenePosition: 1,
      preferredProviderId: "community-library-v1",
      alternativeProviderIds: [],
      query: "社区早餐摊",
    }] }));
    const subject = new GenerativeAssetWorkerClient({ fallback: new LocalAssetWorker(), adapters: [] });
    const request = routedWorkerRequest(scriptPath, directorPlanPath, path.join(root, "attempt-1"), 0, 0);
    (request.parameters as Record<string, unknown>).freeProviderIds = ["community-library-v1"];

    await assert.rejects(() => subject.run(request), /not a recognized asset source/);
  });

  it("blocks private media URLs before any download request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "私网测试" },
    ] }));
    let downloads = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({ providerId: "seedance-video-v1", taskId: "private-task", videoUrl: "http://127.0.0.1/private.mp4" }),
        },
      }],
      fetch: async () => {
        downloads += 1;
        return new Response("must-not-download");
      },
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(downloads, 0);
    assert.match(jobs.jobs[0].error, /private or unsafe/);
    assert.equal(jobs.jobs[0].videoUrl, undefined);
    assert.equal(jobs.jobs[0].imageUrl, undefined);
    assert.equal(jobs.jobs[0].actualCostCny, 1);
    assert.equal(response.diagnostics?.actualCostCny, 1);
    assert.equal(response.diagnostics?.meteredAttemptCount, 1);
    assert.equal(response.diagnostics?.meteredFailedAttemptCount, 1);
  });

  it("blocks IPv4-mapped private IPv6 media URLs before any download request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "映射私网测试" },
    ] }));
    let downloads = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1",
            taskId: "mapped-private-task",
            videoUrl: "http://[::ffff:192.168.1.1]/private.mp4",
          }),
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => {
        downloads += 1;
        return new Response("must-not-download");
      },
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(downloads, 0);
    assert.match(jobs.jobs[0].error, /private or unsafe/);
  });

  it("blocks NAT64 media URLs before any download request", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "NAT64 私网测试" },
    ] }));
    let downloads = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1",
            taskId: "nat64-private-task",
            videoUrl: "http://[64:ff9b::c0a8:101]/private.mp4",
          }),
        },
      }],
      fetch: async () => {
        downloads += 1;
        return new Response("must-not-download");
      },
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(downloads, 0);
    assert.match(jobs.jobs[0].error, /private or unsafe/);
  });

  it("blocks reserved documentation ranges returned by DNS", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "保留地址测试" },
    ] }));
    let fetched = false;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({ providerId: "seedance-video-v1", taskId: "reserved-task", videoUrl: "https://media.example/generated.mp4" }),
        },
      }],
      resolveHost: async () => ["198.51.100.20"],
      fetch: async () => {
        fetched = true;
        return new Response("must not fetch");
      },
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(fetched, false);
    assert.match(jobs.jobs[0].error, /private or unsafe network destination/);
  });

  it("blocks media hostnames that resolve to private addresses before downloading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "DNS 私网测试" },
    ] }));
    let downloads = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1",
            taskId: "dns-private-task",
            videoUrl: "https://media.example/private.mp4",
          }),
        },
      }],
      resolveHost: async () => ["100.100.100.200"],
      fetch: async () => {
        downloads += 1;
        return new Response("must-not-download");
      },
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(downloads, 0);
    assert.match(jobs.jobs[0].error, /private or unsafe/);
  });

  it("revalidates every generated-media redirect before following it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "重定向测试" },
    ] }));
    let requests = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1",
            taskId: "redirect-task",
            videoUrl: "https://media.example/public.mp4",
          }),
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.mp4" } });
      },
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(requests, 1);
    assert.match(jobs.jobs[0].error, /private or unsafe/);
  });

  it("stops a generated-media download when the overall timeout expires", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "超时测试" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1",
            taskId: "timeout-task",
            videoUrl: "https://media.example/slow.mp4",
          }),
        },
      }],
      resolveHost: resolvePublicHost,
      downloadTimeoutMs: 10,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.match(jobs.jobs[0].error, /timed out after 10ms/);
  });

  it("rejects non-media responses before consuming their body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "MIME 测试" },
    ] }));
    let bodyCancelled = false;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1",
            taskId: "html-task",
            videoUrl: "https://media.example/not-video.mp4",
          }),
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response(new ReadableStream({
        cancel: () => { bodyCancelled = true; },
      }), { headers: { "content-type": "text/html" } }),
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(bodyCancelled, true);
    assert.match(jobs.jobs[0].error, /unsupported content type 'text\/html'/);
  });

  it("accepts provider MP4 MIME aliases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "MIME 测试" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({ providerId: "seedance-video-v1", taskId: "mime-task", videoUrl: "https://example.com/mime.mp4" }),
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("mp4", { headers: { "content-type": "application/mp4" } }),
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(response.status, "succeeded");
    assert.equal(jobs.jobs[0].status, "succeeded");
  });

  it("stops streaming generated media as soon as the byte limit is exceeded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "大小测试" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({ providerId: "seedance-video-v1", taskId: "large-task", videoUrl: "https://example.com/large.mp4" }),
        },
      }],
      resolveHost: resolvePublicHost,
      maxDownloadBytes: 5,
      fetch: async () => new Response("123456789", { headers: { "content-type": "video/mp4" } }),
    });

    await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.match(jobs.jobs[0].error, /5-byte download limit/);
  });
});

class LocalAssetWorker {
  readonly calls: Array<Record<string, unknown>> = [];

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    this.calls.push(request);
    const outputDir = String(request.outputDir);
    const assetsDir = path.join(outputDir, "assets", "job-1");
    await mkdir(assetsDir, { recursive: true });
    const planPath = path.join(assetsDir, "asset_plan.json");
    const routed = (request.parameters as Record<string, unknown>).provider === "ai-router";
    const scriptPath = String((request.input as Record<string, unknown>).scriptPath);
    const script = JSON.parse(await readFile(scriptPath, "utf8")) as { scenes: Array<{ position: number; duration?: number }> };
    const directorPlanPath = (request.input as Record<string, unknown>).directorPlanPath;
    const directorPlan = routed && typeof directorPlanPath === "string"
      ? JSON.parse(await readFile(directorPlanPath, "utf8"))
      : undefined;
    const shotsByScene = new Map<number, { scenePosition: number; preferredProviderId: string; deliveryType?: string; query?: string; reuseFromScenePosition?: number }>(
      directorPlan?.shots.map((shot: { scenePosition: number; preferredProviderId: string; deliveryType?: string; query?: string; reuseFromScenePosition?: number }) => [shot.scenePosition, shot]) ?? [],
    );
    const sceneAssets: Array<Record<string, unknown>> = [];
    const directorRouting: Array<Record<string, unknown>> = [];
    for (const scene of script.scenes) {
      const shot = shotsByScene.get(scene.position);
      const generated = routed && shot && ["seedream-image-v1", "seedance-video-v1", "hailuo-video-v1", "wan-video-v1"].includes(shot.preferredProviderId);
      const reuseFrom = shot ? reuseSourceForTest(shot) : undefined;
      const reusedAsset = reuseFrom === undefined
        ? undefined
        : sceneAssets.find((asset) => Number(asset.scene_position) === reuseFrom);
      const reusedRoute = reuseFrom === undefined
        ? undefined
        : directorRouting.find((route) => Number(route.scene_position) === reuseFrom);
      if (reuseFrom !== undefined) {
        if (!reusedAsset || !reusedRoute) throw new Error(`Test fallback cannot resolve reused scene ${reuseFrom}.`);
        sceneAssets.push({
          ...reusedAsset,
          scene_position: scene.position,
          duration: scene.duration ?? 5,
          query: shot?.query ?? "",
        });
      } else if (generated) {
        sceneAssets.push({
          scene_position: scene.position,
          provider: shot.preferredProviderId,
          asset_id: `pending-${scene.position}`,
          media_type: shot.deliveryType === "generated_image" ? "image" : "video",
          width: 720,
          height: 1280,
          duration: scene.duration ?? 5,
          local_path: "",
          source_url: `pending://scene-${scene.position}`,
          creator: "VideoFactory pending generation",
          license_note: "Generation pending.",
          query: shot.query ?? "",
        });
      } else {
        const extension = shot?.deliveryType === "stock_video" ? "mp4" : "png";
        const mediaPath = path.join(assetsDir, `scene_${String(scene.position).padStart(2, "0")}.${extension}`);
        await writeFile(mediaPath, `asset-${scene.position}`);
        sceneAssets.push({
          ...localAsset(scene.position, mediaPath),
          provider: routed && shot?.preferredProviderId === "pexels-stock-v1" ? "pexels" : "local",
          media_type: extension === "mp4" ? "video" : "image",
          duration: scene.duration ?? 5,
          source_url: routed && shot?.preferredProviderId === "pexels-stock-v1"
            ? "https://pexels.example/asset"
            : "local://video-factory/card",
        });
      }
      if (routed && shot) {
        directorRouting.push({
          scene_position: shot.scenePosition,
          preferred_provider_id: shot.preferredProviderId,
          actual_provider_id: reusedRoute?.actual_provider_id ?? (generated ? shot.preferredProviderId : shot.preferredProviderId === "pexels-stock-v1" ? "pexels-stock-v1" : "local-editorial-v1"),
          actual_provider: reusedRoute?.actual_provider ?? (generated ? shot.preferredProviderId : shot.preferredProviderId === "pexels-stock-v1" ? "pexels" : "local"),
          fallback_used: false,
          generation_pending: reusedRoute?.generation_pending ?? Boolean(generated),
          ...(reuseFrom ? { reuse_from_scene_position: reuseFrom } : {}),
          director_shot: shot,
        });
      }
    }
    await writeFile(planPath, JSON.stringify({
      job_id: 1,
      scene_assets: sceneAssets,
      ...(directorPlan ? { director_routing: directorRouting } : {}),
    }));
    const bytes = await readFile(planPath);
    return {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      commandId: String(request.commandId),
      status: "succeeded",
      output: { assetPlanPath: planPath },
      artifacts: [{
        kind: "asset_plan",
        uri: planPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        contentType: "application/json",
        provenance: {
          providerId: "local-editorial-v1",
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Local baseline.",
        },
      }],
    };
  }
}

function routedWorkerRequest(
  scriptPath: string,
  directorPlanPath: string,
  outputDir: string,
  maxPaidShots: number,
  maxCostCny: number,
) {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    commandId: "command-routed",
    runId: "run-routed",
    nodeRunId: "assets",
    attempt: 1,
    capability: "asset.prepare",
    input: { scriptPath, directorPlanPath },
    parameters: {
      providerId: "ai-shot-router-v1",
      provider: "ai-router",
      maxPaidShots,
      maxCostCny,
    },
    outputDir,
  };
}

function workerRequest(scriptPath: string, outputDir: string, maxPaidShots: number, maxCostCny: number) {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    commandId: "command-1",
    runId: "run-1",
    nodeRunId: "assets",
    attempt: 1,
    capability: "asset.prepare",
    input: { scriptPath },
    parameters: {
      providerId: "seedance-video-v1",
      provider: "seedance",
      maxPaidShots,
      maxCostCny,
    },
    outputDir,
  };
}

function localAsset(scenePosition: number, localPath: string) {
  return {
    scene_position: scenePosition,
    provider: "local",
    asset_id: `local-${scenePosition}`,
    media_type: "image",
    width: 1080,
    height: 1920,
    duration: 5,
    local_path: localPath,
    source_url: "local://video-factory/card",
    creator: "VideoFactory",
    license_note: "Owner-generated local graphic card.",
    query: "local card",
  };
}

function reuseSourceForTest(shot: { query?: string; reuseFromScenePosition?: number }): number | undefined {
  if (shot.reuseFromScenePosition !== undefined) return shot.reuseFromScenePosition;
  const match = /^REUSE_ONLY\s+scene\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(shot.query ?? "");
  if (!match) return undefined;
  const token = match[1]!.toLowerCase();
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  return /^\d+$/.test(token) ? Number(token) : words[token];
}
