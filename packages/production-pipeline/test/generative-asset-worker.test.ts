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

describe("GenerativeAssetWorkerClient", () => {
  it("keeps a local baseline and replaces only budgeted key shots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({
      scenes: [
        { position: 1, duration: 5, visual_strategy: "stock", visual_prompt: "雨夜地铁里的疲惫上班族" },
        { position: 2, duration: 5, visual_strategy: "local", visual_prompt: "编辑清单卡片" },
      ],
    }));
    const fallback = new LocalAssetWorker();
    const generated: string[] = [];
    const adapter: VideoGenerationAdapter = {
      providerId: "seedance-video-v1",
      generate: async (request, onProgress) => {
        generated.push(request.prompt);
        await onProgress?.({ providerId: "seedance-video-v1", taskId: "task-1", status: "submitted" });
        await onProgress?.({
          providerId: "seedance-video-v1",
          taskId: "task-1",
          status: "succeeded",
          videoUrl: "https://example.com/generated.mp4",
        });
        return {
          providerId: "seedance-video-v1",
          taskId: "task-1",
          videoUrl: "https://example.com/generated.mp4",
        };
      },
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback,
      adapters: [{ adapter, estimatedCnyPerClip: 3.5 }],
      fetch: async () => new Response("generated-video-bytes", {
        headers: { "content-type": "video/mp4" },
      }),
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 4));

    assert.equal(response.status, "succeeded");
    assert.equal(fallback.calls.length, 1);
    assert.equal((fallback.calls[0]?.parameters as Record<string, unknown>).provider, "local");
    assert.deepEqual(generated, ["雨夜地铁里的疲惫上班族"]);
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    assert.equal(plan.scene_assets[0].provider, "seedance-video-v1");
    assert.equal(plan.scene_assets[0].asset_id, "task-1");
    assert.equal(plan.scene_assets[1].provider, "local");
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
      videoUrl: "https://example.com/generated.mp4",
    });
    assert.equal(response.artifacts.some((artifact) => artifact.kind === "generation_jobs"), true);
    assert.equal(response.artifacts.some((artifact) => artifact.kind === "media_asset"), true);
  });

  it("refuses a generation request before external calls when its estimate exceeds the budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [] }));
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
      /estimated cost.*7.*budget.*5/i,
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
      fetch: async () => new Response("short-video", { headers: { "content-type": "video/mp4" } }),
    });

    await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 3));

    assert.equal(durationSeconds, 12);
  });

  it("records a failed paid shot and continues with the local baseline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-assets-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({
      scenes: [
        { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "清晨城市的第一班地铁" },
      ],
    }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 3.5,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            await onProgress?.({ providerId: "seedance-video-v1", taskId: "task-failed", status: "submitted" });
            throw new Error("provider capacity exhausted");
          },
        },
      }],
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 4));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(response.status, "succeeded");
    assert.equal(plan.scene_assets[0].provider, "local");
    assert.equal(jobs.jobs[0].status, "failed");
    assert.equal(jobs.jobs[0].error, "provider capacity exhausted");
    assert.equal(response.diagnostics?.attemptedScenes, 1);
    assert.equal(response.diagnostics?.generatedScenes, 0);
    assert.equal(response.diagnostics?.fallbackScenes, 1);
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
    assert.equal(plan.generation.estimatedCostCny, 3.5);
    assert.equal(plan.generation.actualCostCny, 3.5);
    assert.equal(plan.generation.actualCostSource, "configured_rate");
    assert.equal(plan.generation.meteredAttemptCount, 1);
    assert.equal(plan.generation.meteredFailedAttemptCount, 0);
    assert.deepEqual(plan.generation.actualModelIds, ["seedance-video-v1"]);
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
      /estimated cost.*7.*budget.*6/i,
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

  it("uses the first configured alternative selected by the director", async () => {
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
      fetch: async () => new Response("alternative-video", { headers: { "content-type": "video/mp4" } }),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 1, 4));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));

    assert.equal(generated, true);
    assert.equal(plan.scene_assets[0].provider, "seedance-video-v1");
  });

  it("preserves the free fallback and records a stale selected model without making a paid call", async () => {
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

    const response = await subject.run(request);
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    const jobs = JSON.parse(await readFile(String(response.output?.generationJobsPath), "utf8"));

    assert.equal(response.status, "succeeded");
    assert.equal(paidCalls, 0);
    assert.notEqual(plan.scene_assets[0].provider, "seedance-video-v1");
    assert.equal(plan.generation.fallbackScenes, 1);
    assert.equal(plan.generation.actualCostCny, 0);
    assert.match(plan.generation.skippedRoutes[0].reason, /does not expose model 'removed-model'/);
    assert.deepEqual(jobs.jobs, []);
    assert.equal(response.diagnostics?.actualModelIds, undefined);
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

  it("accepts a runtime-declared free provider without changing the router core", async () => {
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

    const response = await subject.run(request);

    assert.equal(response.status, "succeeded");
    assert.equal(response.output?.generationJobsPath, undefined);
    assert.equal(response.diagnostics?.estimatedCostCny, 0);
    assert.equal(response.diagnostics?.actualCostCny, 0);
    assert.equal(response.diagnostics?.meteredAttemptCount, 0);
    assert.equal(response.diagnostics?.meteredFailedAttemptCount, 0);
    assert.equal(response.diagnostics?.actualModelIds, undefined);
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
    const scene1 = path.join(assetsDir, "scene_01.png");
    const scene2 = path.join(assetsDir, "scene_02.png");
    await writeFile(scene1, "local-1");
    await writeFile(scene2, "local-2");
    const planPath = path.join(assetsDir, "asset_plan.json");
    const routed = (request.parameters as Record<string, unknown>).provider === "ai-router";
    await writeFile(planPath, JSON.stringify({
      job_id: 1,
      scene_assets: [
        routed ? { ...localAsset(1, scene1), provider: "pexels" } : localAsset(1, scene1),
        localAsset(2, scene2),
      ],
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
