import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProviderRegistry,
  WorkflowRunner,
  type WorkflowDefinition,
} from "@video-factory/workflow-core";
import {
  GenerativeAssetWorkerClient,
  SourceAssetPilotReviewer,
  ProviderRequestRejectedError,
  WORKER_PROTOCOL_VERSION,
  type VideoGenerationAdapter,
  type ImageGenerationAdapter,
  type WorkerResponse,
  type VisualReviewAgent,
  type VisualReviewReport,
} from "../src/index.js";
import {
  estimateVideoGenerationCostCny,
  normalizeVideoGenerationDurationSeconds,
  reworkAffectedScenePositions,
} from "../src/generative-asset-worker.js";

const resolvePublicHost = async (): Promise<string[]> => ["93.184.216.34"];

describe("GenerativeAssetWorkerClient", () => {
  for (const routed of [false, true]) {
    it(`stops after a rejected pilot, preserves paid media and routes findings to rework (${routed ? "director" : "direct"})`, async () => {
      const harness = await pilotHarness(routed, "revise");
      const result = await harness.worker.run(harness.request);
      assert.equal(result.status, "rejected");
      assert.deepEqual(harness.events, ["generate-1", "review-1"]);
      assert.equal(result.diagnostics?.actualCostCny, 2);
      assert.equal(result.diagnostics?.generatedScenes, 1);
      assert.equal(result.diagnostics?.meteredAttemptCount, 1);
      assert.equal(result.diagnostics?.meteredFailedAttemptCount, 0);
      assert.equal(result.diagnostics?.providerOutcomeKnown, true);
      assert.equal((result.output?.sourceVisualReview as VisualReviewReport).findings[0]?.scenePosition, 1);
      assert.ok(result.artifacts.some((artifact) => artifact.kind === "media_asset"));
      assert.ok(result.artifacts.some((artifact) => artifact.kind === "review_report"));

      const repeated = await harness.worker.run({ ...harness.request, outputDir: path.join(harness.root, "attempt-2") });
      assert.equal(repeated.status, "rejected");
      assert.deepEqual(harness.events, ["generate-1", "review-1"]);
      assert.equal(repeated.diagnostics?.actualCostCny, 0);
      assert.equal(repeated.diagnostics?.providerOutcomeKnown, true);
    });

    it(`reviews one pilot before the remaining same-model clips and uses it in the final plan (${routed ? "director" : "direct"})`, async () => {
      const harness = await pilotHarness(routed, "approve");
      const result = await harness.worker.run(harness.request);
      assert.equal(result.status, "succeeded");
      assert.deepEqual(harness.events, ["generate-1", "review-1", "generate-2", "generate-3"]);
      assert.equal(result.diagnostics?.actualCostCny, 6);
      const plan = JSON.parse(await readFile(String(result.output?.assetPlanPath), "utf8"));
      assert.deepEqual(plan.scene_assets.map((asset: { asset_id: string }) => asset.asset_id), ["task-1", "task-2", "task-3"]);
    });
  }

  it("retains the materialized pilot when review is unavailable and resumes without buying it again", async () => {
    const harness = await pilotHarness(false, "unavailable");
    const result = await harness.worker.run(harness.request);
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics?.providerOutcomeKnown, true);
    assert.equal(result.diagnostics?.generatedScenes, 1);
    assert.deepEqual(harness.events, ["generate-1", "review-1"]);
    harness.setVerdict("approve");
    const resumed = await harness.worker.run({ ...harness.request,
      commandId: "new-authorized-operation",
      outputDir: path.join(harness.root, "attempt-2"),
      parameters: { ...harness.request.parameters, maxCostCny: 4 },
    });
    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.diagnostics?.actualCostCny, 4);
    assert.deepEqual(harness.events, ["generate-1", "review-1", "review-1", "generate-2", "generate-3"]);
  });

  it("rechecks a materialized rejected pilot and quotes only the remaining scenes", async () => {
    const harness = await pilotHarness(true, "revise");
    const rejected = await harness.worker.run(harness.request);
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(harness.events, ["generate-1", "review-1"]);

    harness.setVerdict("approve");
    await rm(path.join(harness.root, "asset-pilot-reviews"), { recursive: true, force: true });
    const resumed = await harness.worker.run({
      ...harness.request,
      commandId: "pilot-recheck-operation",
      outputDir: path.join(harness.root, "attempt-2"),
      parameters: { ...harness.request.parameters, maxCostCny: 4 },
    });

    assert.equal(resumed.status, "succeeded");
    assert.equal(resumed.diagnostics?.estimatedCostCny, 4);
    assert.equal(resumed.diagnostics?.actualCostCny, 4);
    assert.deepEqual(harness.events, ["generate-1", "review-1", "review-1", "generate-2", "generate-3"]);
  });

  it("fails before spending when the production pilot reviewer is unavailable", async () => {
    const harness = await pilotHarness(false, "approve", true);
    const response = await harness.worker.run(harness.request);
    assert.equal(response.status, "failed");
    assert.match(response.error?.message ?? "", /试片审查服务尚未连接/);
    assert.equal(response.diagnostics?.providerOutcomeKnown, true);
    assert.equal(response.diagnostics?.meteredAttemptCount, 0);
    assert.deepEqual(harness.events, []);
  });

  it("requires an independent pilot for a different generated media route", async () => {
    const harness = await pilotHarness(true, "approve", false, true);
    const result = await harness.worker.run(harness.request);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(harness.events, ["generate-1", "review-1", "generate-2", "review-2", "generate-3"]);
  });

  it("tests the most demanding independent director shot before simpler paid shots", async () => {
    const harness = await pilotHarness(true, "revise");
    const directorPath = String((harness.request.input as Record<string, unknown>).directorPlanPath);
    const plan = JSON.parse(await readFile(directorPath, "utf8"));
    plan.shots[2].temporalBeats = ["[0s-1s] establish", "[1s-3s] move", "[3s-4s] hold"];
    await writeFile(directorPath, JSON.stringify(plan));
    const response = await harness.worker.run(harness.request);
    assert.equal(response.status, "rejected");
    assert.deepEqual(harness.events, ["generate-1", "review-3"]);
    assert.equal((response.output?.sourceVisualReview as VisualReviewReport).findings[0]?.scenePosition, 3);
  });

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

  it("rejects a routed stock shot whose asset provider id reveals an unauthorized local card", async () => {
    await assert.rejects(
      () => runCraftedAssetPlan({ asset: { provider_id: "local-editorial-v1" } }),
      /local card without explicit editorial_card authorization/i,
    );
  });

  it("rejects a routed stock shot whose actual route provider reveals an unauthorized local card", async () => {
    await assert.rejects(
      () => runCraftedAssetPlan({ route: { actual_provider_id: "local-editorial-v1" } }),
      /local card without explicit editorial_card authorization/i,
    );
  });

  it("rejects a routed stock shot whose source URL is an unauthorized local-card subpath", async () => {
    await assert.rejects(
      () => runCraftedAssetPlan({ asset: { source_url: "local://video-factory/card/scene-01" } }),
      /local card without explicit editorial_card authorization/i,
    );
  });

  it("allows a local card only when the director explicitly selects editorial_card delivery", async () => {
    const response = await runCraftedAssetPlan({
      directorShot: {
        preferredProviderId: "local-editorial-v1",
        deliveryType: "editorial_card",
      },
      asset: {
        provider: "local",
        provider_id: "local-editorial-v1",
        source_url: "local://video-factory/card/scene-01",
      },
      route: {
        preferred_provider_id: "local-editorial-v1",
        actual_provider_id: "local-editorial-v1",
        actual_provider: "local",
      },
    });

    assert.equal(response.status, "succeeded");
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
    assert.equal(generated.length, 2);
    assert.match(generated[0]!, /^雨夜地铁里的疲惫上班族\n/);
    assert.match(generated[1]!, /^清晨站台上的列车进站\n/);
    for (const prompt of generated) {
      assert.match(prompt, /不得出现任何可读文字.*乱码.*内部制作术语/);
    }
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

  it("reports zero metered attempts when free stock preflight fails before paid generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-free-stock-preflight-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "stock", visual_prompt: "社区早餐摊" },
      { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "蒸汽升起的早餐特写" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [{
      scenePosition: 1,
      preferredProviderId: "pexels-stock-v1",
      deliveryType: "stock_video",
      query: "community breakfast stall",
    }, {
      scenePosition: 2,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      generationPrompt: "蒸汽升起的早餐特写",
    }] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: {
        run: async (request) => ({
          protocolVersion: WORKER_PROTOCOL_VERSION,
          commandId: String(request.commandId),
          status: "failed",
          artifacts: [],
          error: { code: "STOCK_PREFLIGHT_FAILED", message: "Pexels credentials are unavailable." },
        }),
      },
      adapters: [{
        estimatedCnyPerClip: 3.5,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            paidCalls += 1;
            return { providerId: "seedance-video-v1", taskId: "must-not-run", videoUrl: "https://example.com/no.mp4" };
          },
        },
      }],
    });

    const response = await subject.run(routedWorkerRequest(
      scriptPath,
      directorPlanPath,
      path.join(root, "attempt-1"),
      1,
      4,
    ));

    assert.equal(response.status, "failed");
    assert.equal(paidCalls, 0);
    assert.equal(response.diagnostics?.actualCostCny, 0);
    assert.equal(response.diagnostics?.meteredAttemptCount, 0);
    assert.equal(response.diagnostics?.meteredFailedAttemptCount, 0);
  });

  it("adds the no-rendered-text constraint for a direct image provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-direct-image-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "宣纸上的水墨山峰" },
    ] }));
    let generatedPrompt = "";
    const imageAdapter: ImageGenerationAdapter = {
      providerId: "seedream-image-v1",
      generate: async (request) => {
        generatedPrompt = request.prompt;
        return {
          providerId: "seedream-image-v1",
          taskId: "direct-image-task",
          imageUrl: "https://example.com/direct-image.png",
        };
      },
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{ adapter: imageAdapter, estimatedCnyPerImage: 0.25 }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("generated-image", { headers: { "content-type": "image/png" } }),
    });
    const request = workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1);
    request.parameters.providerId = "seedream-image-v1";
    request.parameters.provider = "seedream";

    const response = await subject.run(request);
    const ledgerName = (await readdir(path.join(root, ".generation-operations")))[0]!;
    const ledger = JSON.parse(await readFile(path.join(root, ".generation-operations", ledgerName), "utf8"));

    assert.equal(response.status, "succeeded");
    assert.match(generatedPrompt, /^宣纸上的水墨山峰\n/);
    assert.match(generatedPrompt, /不得出现任何可读文字.*乱码.*内部制作术语/);
    assert.equal(
      ledger.items[0].parameters.compiledPromptSha256,
      createHash("sha256").update(generatedPrompt).digest("hex"),
    );
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

  it("creates a newly quoted asset when a previous materialized file is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-missing-materialized-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "丢失母片后重新生成" },
    ] }));
    let createCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            createCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: `missing-materialized-${createCalls}`,
              videoUrl: `https://example.com/missing-materialized-${createCalls}.mp4`,
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response(`video-${createCalls}`, { headers: { "content-type": "video/mp4" } }),
    });

    const original = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(original.status, "succeeded");
    const originalPlan = JSON.parse(await readFile(String(original.output?.assetPlanPath), "utf8"));
    await rm(originalPlan.scene_assets[0].local_path);

    const regenerated = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 1),
      commandId: "command-2",
      attempt: 2,
    });

    assert.equal(regenerated.status, "succeeded");
    assert.equal(createCalls, 2);
    const regeneratedPlan = JSON.parse(await readFile(String(regenerated.output?.assetPlanPath), "utf8"));
    assert.equal(await readFile(regeneratedPlan.scene_assets[0].local_path, "utf8"), "video-2");
  });

  it("does not carry forward a zero-byte materialized asset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-zero-master-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "零字节母片不能复用" },
    ] }));
    let createCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            createCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: `zero-master-${createCalls}`,
              videoUrl: `https://example.com/zero-master-${createCalls}.mp4`,
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response(`video-${createCalls}`, { headers: { "content-type": "video/mp4" } }),
    });

    const original = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(original.status, "succeeded");
    const originalPlan = JSON.parse(await readFile(String(original.output?.assetPlanPath), "utf8"));
    await writeFile(originalPlan.scene_assets[0].local_path, "");
    const ledgerPath = path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.items[0].sha256 = createHash("sha256").update("").digest("hex");
    ledger.items[0].sizeBytes = 0;
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const regenerated = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 1),
      commandId: "command-2",
      attempt: 2,
    });

    assert.equal(regenerated.status, "succeeded");
    assert.equal(createCalls, 2);
    const regeneratedPlan = JSON.parse(await readFile(String(regenerated.output?.assetPlanPath), "utf8"));
    assert.equal(await readFile(regeneratedPlan.scene_assets[0].local_path, "utf8"), "video-2");
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

  it("refreshes an expired accepted result URL by task id before downloading it again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-refresh-url-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "刷新已过期的下载地址" },
    ] }));
    const expiredUrl = "https://example.com/expired.mp4";
    const refreshedUrl = "https://example.com/refreshed.mp4";
    let createCalls = 0;
    let reconcileCalls = 0;
    const downloadedUrls: string[] = [];
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            createCalls += 1;
            await onProgress?.({
              providerId: "seedance-video-v1",
              taskId: "accepted-task-with-expired-url",
              status: "succeeded",
              videoUrl: expiredUrl,
            });
            return {
              providerId: "seedance-video-v1",
              taskId: "accepted-task-with-expired-url",
              videoUrl: expiredUrl,
            };
          },
          reconcile: async (taskId) => {
            reconcileCalls += 1;
            assert.equal(taskId, "accepted-task-with-expired-url");
            return { providerId: "seedance-video-v1", taskId, videoUrl: refreshedUrl };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async (input) => {
        const url = String(input);
        downloadedUrls.push(url);
        return url === refreshedUrl
          ? new Response("refreshed-video", { headers: { "content-type": "video/mp4" } })
          : new Response("expired", { status: 403 });
      },
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(first.status, "failed");
    const recovered = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0),
      attempt: 2,
    });

    assert.equal(recovered.status, "succeeded");
    assert.equal(createCalls, 1);
    assert.equal(reconcileCalls, 1);
    assert.deepEqual(downloadedUrls, [expiredUrl, refreshedUrl]);
    const plan = JSON.parse(await readFile(String(recovered.output?.assetPlanPath), "utf8"));
    assert.equal(await readFile(plan.scene_assets[0].local_path, "utf8"), "refreshed-video");
    const ledger = JSON.parse(await readFile(path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    ), "utf8"));
    assert.equal(ledger.items[0].resultUrl, refreshedUrl);
    assert.equal(ledger.items[0].state, "materialized");
  });

  it("keeps an unmaterialized provider success uncertain and never creates it again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-expired-requote-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "无法续查时重新生成" },
    ] }));
    let createCalls = 0;
    const staleUrl = "https://example.com/stale-result.mp4";
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            createCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: `paid-task-${createCalls}`,
              videoUrl: createCalls === 1 ? staleUrl : "https://example.com/fresh-result.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async (input) => String(input) === staleUrl
        ? new Response("expired", { status: 403 })
        : new Response("fresh-video", { headers: { "content-type": "video/mp4" } }),
    });

    assert.equal((await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1))).status, "failed");
    const recovery = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0),
      attempt: 2,
    });
    assert.equal(recovery.status, "failed");
    assert.equal(recovery.diagnostics?.providerOutcomeKnown, false);
    const firstLedger = JSON.parse(await readFile(path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    ), "utf8"));
    assert.equal(firstLedger.items[0].state, "provider_succeeded");
    // 永久下载失败（403）：保留 taskId/resultUrl/费用与错误证据，但标记逐项人工核账可操作。
    assert.equal(firstLedger.items[0].manualReconciliationRequired, true);
    assert.equal(firstLedger.items[0].taskId, "paid-task-1");
    assert.equal(firstLedger.items[0].resultUrl, staleUrl);
    assert.match(firstLedger.items[0].error ?? "", /403|expired/i);
    assert.notEqual(firstLedger.items[0].estimatedCostCny, undefined);

    const nextOperation = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-3"), 1, 1),
      commandId: "command-2",
      attempt: 3,
    });
    assert.equal(nextOperation.status, "failed");
    assert.equal(nextOperation.diagnostics?.providerOutcomeKnown, false);
    assert.equal(createCalls, 1);
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
    // 暂时失败（503）不标记人工核账：同任务恢复仍是首选路径。
    const transientLedger = JSON.parse(await readFile(path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    ), "utf8"));
    assert.equal(transientLedger.items[0].state, "provider_succeeded");
    assert.equal("manualReconciliationRequired" in transientLedger.items[0], false);

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

  it("does not resurrect a provider success superseded by a terminal lineage leaf", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-terminal-leaf-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "关闭旧任务后重新生成" },
    ] }));
    let createCalls = 0;
    let downloadCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            createCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: `lineage-task-${createCalls}`,
              videoUrl: `https://example.com/lineage-${createCalls}.mp4`,
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => {
        downloadCalls += 1;
        return downloadCalls === 1
          ? new Response("temporary failure", { status: 503 })
          : new Response(`video-${createCalls}`, { headers: { "content-type": "video/mp4" } });
      },
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(first.status, "failed");
    const operationDirectory = path.join(root, ".generation-operations");
    const firstLedgerPath = path.join(
      operationDirectory,
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    );
    const firstLedger = JSON.parse(await readFile(firstLedgerPath, "utf8"));
    const ancestor = firstLedger.items[0];
    await writeFile(path.join(operationDirectory, "terminal-descendant.json"), `${JSON.stringify({
      version: "video-factory/paid-operation-v2",
      operationId: "terminal-descendant-operation",
      completed: false,
      items: [{
        ...ancestor,
        itemRequestId: "terminal-descendant-item",
        state: "terminal_failed",
        carriedForwardFromItemRequestId: ancestor.itemRequestId,
        error: "Manual reconciliation confirmed that the accepted result cannot be recovered.",
      }],
    }, null, 2)}\n`);

    const regenerated = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 1),
      commandId: "command-2",
      attempt: 2,
    });

    assert.equal(regenerated.status, "succeeded");
    assert.equal(createCalls, 2);
    const plan = JSON.parse(await readFile(String(regenerated.output?.assetPlanPath), "utf8"));
    assert.equal(plan.scene_assets[0].asset_id, "lineage-task-2");
  });

  it("queries a provider-succeeded task with no result URL by taskId instead of creating it again", async () => {
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
    const ledgerPath = path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.items[0].state = "provider_succeeded";
    delete ledger.items[0].resultUrl;
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const second = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 1),
      attempt: 2,
    });

    assert.equal(second.status, "succeeded");
    assert.equal(createCalls, 1);
    assert.equal(queryCalls, 1);
    assert.equal(second.diagnostics?.actualCostCny, 0);
    assert.equal(second.diagnostics?.meteredAttemptCount, 0);
  });

  it("keeps a submitted task uncertain when its accepted result cannot be materialized", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-empty-recovery-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "续查后返回空文件" },
    ] }));
    let createCalls = 0;
    let reconcileCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            createCalls += 1;
            if (createCalls === 1) {
              await onProgress?.({
                providerId: "seedance-video-v1",
                taskId: "submitted-empty-task",
                status: "submitted",
              });
              throw new Error("polling connection lost");
            }
            return {
              providerId: "seedance-video-v1",
              taskId: "replacement-task",
              videoUrl: "https://example.com/replacement.mp4",
            };
          },
          reconcile: async (taskId) => {
            reconcileCalls += 1;
            assert.equal(taskId, "submitted-empty-task");
            return {
              providerId: "seedance-video-v1",
              taskId,
              videoUrl: "https://example.com/empty.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async (input) => new Response(
        String(input).endsWith("empty.mp4") ? "" : "replacement-video",
        { headers: { "content-type": "video/mp4" } },
      ),
    });

    assert.equal((await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1))).status, "failed");
    const recovery = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0),
      attempt: 2,
    });
    assert.equal(recovery.status, "failed");
    assert.equal(recovery.diagnostics?.providerOutcomeKnown, false);
    assert.equal(createCalls, 1);
    assert.equal(reconcileCalls, 1);
    const ledgerPath = path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.items[0].state, "provider_succeeded");
    assert.match(ledger.items[0].error, /empty body/i);

    const regenerated = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-3"), 1, 1),
      commandId: "command-2",
      attempt: 3,
    });
    assert.equal(regenerated.status, "failed");
    assert.equal(regenerated.diagnostics?.providerOutcomeKnown, false);
    assert.equal(createCalls, 1);
    assert.equal(reconcileCalls, 2);
  });

  it("keeps a create request without a returned task id uncertain and never submits it twice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-create-reset-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "连接中断的付费画面" },
    ] }));
    let createCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            createCalls += 1;
            throw Object.assign(new Error("connection reset before task id"), { code: "ECONNRESET" });
          },
        },
      }],
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));

    assert.equal(first.status, "failed");
    assert.equal(first.diagnostics?.providerOutcomeKnown, false);
    assert.equal(first.diagnostics?.meteredAttemptCount, 1);
    assert.equal(createCalls, 1);
    const ledgerPath = path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { items: Array<{ state: string; taskId?: string }> };
    assert.deepEqual(ledger.items.map((item) => [item.state, item.taskId]), [["unknown", undefined]]);

    const second = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 1, 1),
      attempt: 2,
    });

    assert.equal(second.status, "failed");
    assert.equal(second.diagnostics?.providerOutcomeKnown, false);
    assert.equal(createCalls, 1);
  });

  it("does not count a failed reconciliation query as a new metered attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reconcile-timeout-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "继续查询已付费任务" },
    ] }));
    let createCalls = 0;
    let queryCalls = 0;
    const adapter: VideoGenerationAdapter = {
      providerId: "seedance-video-v1",
      generate: async (_request, onProgress) => {
        createCalls += 1;
        await onProgress?.({ providerId: "seedance-video-v1", taskId: "submitted-task-timeout", status: "submitted" });
        await onProgress?.({
          providerId: "seedance-video-v1",
          taskId: "submitted-task-timeout",
          status: "unknown",
          error: "initial polling timeout",
        });
        throw new Error("initial polling timeout");
      },
      reconcile: async (taskId, _request, onProgress) => {
        queryCalls += 1;
        await onProgress?.({ providerId: "seedance-video-v1", taskId, status: "running" });
        await onProgress?.({
          providerId: "seedance-video-v1",
          taskId,
          status: "unknown",
          error: "reconciliation polling timeout",
        });
        throw new Error("reconciliation polling timeout");
      },
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{ adapter, estimatedCnyPerClip: 1 }],
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1));
    assert.equal(first.status, "failed");
    assert.equal(first.diagnostics?.meteredAttemptCount, 1);
    const second = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0),
      attempt: 2,
    });

    assert.equal(second.status, "failed");
    assert.equal(createCalls, 1);
    assert.equal(queryCalls, 1);
    assert.equal(second.diagnostics?.actualCostCny, 0);
    assert.equal(second.diagnostics?.meteredAttemptCount, 0);
    assert.equal(second.diagnostics?.meteredFailedAttemptCount, 0);
    const jobs = JSON.parse(await readFile(String(second.output?.generationJobsPath), "utf8"));
    assert.equal(jobs.jobs[0].carriedForward, true);
    assert.equal(jobs.jobs[0].actualCostCny, undefined);
    assert.equal(jobs.jobs[0].actualCostSource, undefined);
  });

  it("marks a definitively rejected task lookup for manual reconciliation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reconcile-rejected-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "查询已提交任务" },
    ] }));
    let createCalls = 0;
    let reconcileCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            createCalls += 1;
            await onProgress?.({ providerId: "seedance-video-v1", taskId: "missing-task", status: "submitted" });
            throw new Error("initial polling connection lost");
          },
          reconcile: async () => {
            reconcileCalls += 1;
            throw new ProviderRequestRejectedError("Provider lookup returned 404 for missing-task.");
          },
        },
      }],
    });

    assert.equal((await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1))).status, "failed");
    const resumed = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0),
      attempt: 2,
    });

    assert.equal(resumed.status, "failed");
    assert.equal(createCalls, 1);
    assert.equal(reconcileCalls, 1);
    assert.equal(resumed.diagnostics?.meteredAttemptCount, 0);
    const ledgerPath = path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.items[0].state, "submitted");
    assert.equal(ledger.items[0].taskId, "missing-task");
    assert.equal(ledger.items[0].manualReconciliationRequired, true);
  });

  it("reconciles later submitted tasks after an earlier item was manually closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-mixed-reconcile-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "镜头一" },
      { position: 2, duration: 5, visual_strategy: "generated", visual_prompt: "镜头二" },
    ] }));
    let createCalls = 0;
    let reconcileCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            createCalls += 1;
            const taskId = `created-task-${createCalls}`;
            const videoUrl = `https://example.com/${taskId}.mp4`;
            await onProgress?.({ providerId: "seedance-video-v1", taskId, status: "succeeded", videoUrl });
            return { providerId: "seedance-video-v1", taskId, videoUrl };
          },
          reconcile: async (taskId) => {
            reconcileCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId,
              status: "succeeded",
              videoUrl: `https://example.com/${taskId}-reconciled.mp4`,
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("video", { headers: { "content-type": "video/mp4" } }),
    });

    const first = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 2, 2));
    assert.equal(first.status, "succeeded");
    const ledgerPath = path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-1").digest("hex")}.json`,
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    Object.assign(ledger.items[0], {
      state: "terminal_failed",
      error: "Manual reconciliation 'manual-not-charged' confirmed that this provider task was not charged.",
    });
    delete ledger.items[0].taskId;
    delete ledger.items[0].resultUrl;
    delete ledger.items[0].localPath;
    delete ledger.items[0].sha256;
    delete ledger.items[0].sizeBytes;
    delete ledger.items[0].actualCostCny;
    delete ledger.items[0].actualCostSource;
    ledger.items[1].state = "submitted";
    delete ledger.items[1].resultUrl;
    delete ledger.items[1].localPath;
    delete ledger.items[1].sha256;
    delete ledger.items[1].sizeBytes;
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

    const resumed = await subject.run({
      ...workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0),
      attempt: 2,
    });

    assert.equal(resumed.status, "failed");
    assert.equal(resumed.diagnostics?.providerOutcomeKnown, true);
    assert.equal(resumed.diagnostics?.meteredAttemptCount, 0);
    assert.equal(createCalls, 2);
    assert.equal(reconcileCalls, 1);
    const recoveredLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(recoveredLedger.items[0].state, "terminal_failed");
    assert.match(recoveredLedger.items[0].error, /^Manual reconciliation '/);
    assert.equal(recoveredLedger.items[1].state, "materialized");
  });

  it("completes an existing paid task through WorkflowRunner as a zero-cost recovery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-runner-reconcile-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "恢复原付费任务" },
    ] }));
    const operationId = "existing-paid-operation";
    let createCalls = 0;
    let reconcileCalls = 0;
    const adapter = {
      providerId: "seedance-video-v1",
      generate: async (_request: Parameters<VideoGenerationAdapter["generate"]>[0], onProgress?: Parameters<VideoGenerationAdapter["generate"]>[1]) => {
        createCalls += 1;
        await onProgress?.({ providerId: "seedance-video-v1", taskId: "existing-paid-task", status: "submitted" });
        await onProgress?.({ providerId: "seedance-video-v1", taskId: "existing-paid-task", status: "unknown", error: "polling connection lost" });
        throw new Error("polling connection lost");
      },
      reconcile: async (taskId: string) => {
        reconcileCalls += 1;
        assert.equal(taskId, "existing-paid-task");
        return {
          providerId: "seedance-video-v1",
          taskId,
          status: "succeeded" as const,
          videoUrl: "https://example.com/existing-paid-task.mp4",
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
    const worker = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{ adapter, estimatedCnyPerClip: 1 }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("recovered-video", { headers: { "content-type": "video/mp4" } }),
    });
    const firstRequest = workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 1);
    firstRequest.commandId = operationId;
    const first = await worker.run(firstRequest);
    assert.equal(first.status, "failed");

    const providers = new ProviderRegistry();
    providers.register({
      id: "seedance-video-v1",
      label: "Seedance",
      modelId: "seedance-video-v1",
      capability: "asset.prepare",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 1,
      maxCostCny: 1,
      maxAttempts: 1,
      quoteSpend: () => ({ estimatedCostCny: 0, maxCostCny: 0, requiresAuthorization: false }),
      run: () => { throw new Error("The custom node executor must own the worker call."); },
    });
    const definition: WorkflowDefinition = {
      id: "recover-existing-paid-task",
      name: "Recover existing paid task",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "seedance-video-v1",
        mode: "automatic",
        execute: async (_input, context) => {
          const request = workerRequest(scriptPath, path.join(root, "attempt-2"), 0, 0);
          request.commandId = String(context.operationRequestId);
          request.runId = context.runId;
          request.attempt = 2;
          const response = await worker.run(request);
          assert.equal(response.status, "succeeded");
          return {
            status: "succeeded" as const,
            output: response.output,
            receipt: {
              providerId: "seedance-video-v1",
              providerLabel: "Seedance",
              modelId: "seedance-video-v1",
              transport: "http_api" as const,
              billing: "metered" as const,
              estimatedCostCny: Number(response.diagnostics?.estimatedCostCny ?? 0),
              actualCostCny: Number(response.diagnostics?.actualCostCny ?? 0),
              actualCostSource: "configured_rate" as const,
              meteredAttemptCount: Number(response.diagnostics?.meteredAttemptCount ?? 0),
              meteredFailedAttemptCount: Number(response.diagnostics?.meteredFailedAttemptCount ?? 0),
            },
          };
        },
      }],
    };
    let nextId = 0;
    const runner = new WorkflowRunner({
      providers,
      idFactory: (prefix) => prefix.endsWith("-operation") ? operationId : `${prefix}-${++nextId}`,
    });

    const completed = await runner.run(definition, {});

    assert.equal(completed.status, "succeeded");
    assert.equal(createCalls, 1);
    assert.equal(reconcileCalls, 1);
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.billing, "free");
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.actualCostCny, 0);
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.meteredAttemptCount, 0);
    const recoveredLedger = JSON.parse(await readFile(
      path.join(root, ".generation-operations", `${createHash("sha256").update(operationId).digest("hex")}.json`),
      "utf8",
    ));
    assert.equal(recoveredLedger.items[0].state, "materialized");
    assert.equal(recoveredLedger.items[0].taskId, "existing-paid-task");
    assert.equal(recoveredLedger.items[0].actualCostCny, 1);
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
            const scenePrompt = request.prompt.split("\n", 1)[0]!;
            const count = (calls.get(scenePrompt) ?? 0) + 1;
            calls.set(scenePrompt, count);
            const taskId = `${scenePrompt}-task-${count}`;
            if (scenePrompt === "镜头二" && count === 1) {
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
    assert.equal(path.dirname(secondPlan.scene_assets[0].local_path), path.join(root, "attempt-2"));
    assert.notEqual(secondPlan.scene_assets[0].local_path, firstScenePath);
    assert.equal(createHash("sha256").update(await readFile(secondPlan.scene_assets[0].local_path)).digest("hex"), firstSceneSha);
    assert.equal(second.diagnostics?.actualCostCny, 2);
    assert.equal(second.diagnostics?.meteredAttemptCount, 2);
  });

  it("carries unchanged independent images into a scoped rework without another paid call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-rework-carry-"));
    const runsRoot = path.join(root, "runs");
    const sourceRunId = "run-source";
    const currentRunId = "run-current";
    const sourceOutputDir = path.join(runsRoot, sourceRunId, "nodes", "assets", "attempt-1");
    const currentOutputDir = path.join(runsRoot, currentRunId, "nodes", "assets", "attempt-1");
    await mkdir(sourceOutputDir, { recursive: true });
    const script = { scenes: [1, 2].map((position) => ({
      position,
      duration: 4,
      visual_strategy: "generated",
      visual_prompt: `scene ${position}`,
    })) };
    const previousDirectorPlan = { shots: [
      { scenePosition: 1, preferredProviderId: "seedream-image-v1", deliveryType: "generated_image", generationPrompt: "keep scene one" },
      { scenePosition: 2, preferredProviderId: "seedream-image-v1", deliveryType: "generated_image", generationPrompt: "replace scene two" },
    ] };
    const currentDirectorPlan = structuredClone(previousDirectorPlan);
    currentDirectorPlan.shots[1]!.generationPrompt = "fixed scene two";
    const sourceScriptPath = path.join(root, "source-script.json");
    const currentScriptPath = path.join(root, "current-script.json");
    const sourceDirectorPath = path.join(root, "source-director.json");
    const currentDirectorPath = path.join(root, "current-director.json");
    await writeFile(sourceScriptPath, JSON.stringify(script));
    await writeFile(currentScriptPath, JSON.stringify(script));
    await writeFile(sourceDirectorPath, JSON.stringify(previousDirectorPlan));
    await writeFile(currentDirectorPath, JSON.stringify(currentDirectorPlan));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{
        estimatedCnyPerImage: 0.25,
        adapter: {
          providerId: "seedream-image-v1",
          modelId: "doubao-seedream-4-0-250828",
          generate: async () => {
            paidCalls += 1;
            return {
              providerId: "seedream-image-v1",
              taskId: `image-${paidCalls}`,
              imageUrl: `https://example.com/image-${paidCalls}.png`,
            };
          },
        },
      }],
      runsRoot,
      resolveHost: resolvePublicHost,
      fetch: async (url) => new Response(`bytes:${String(url)}`, { headers: { "content-type": "image/png" } }),
    });

    const firstRequest = routedWorkerRequest(sourceScriptPath, sourceDirectorPath, sourceOutputDir, 2, 0.5);
    firstRequest.commandId = "source-operation";
    firstRequest.runId = sourceRunId;
    const first = await subject.run(firstRequest);
    assert.equal(first.status, "succeeded");
    assert.equal(paidCalls, 2);
    const firstPlan = JSON.parse(await readFile(String(first.output?.assetPlanPath), "utf8"));
    const sourceSceneOneBytes = await readFile(firstPlan.scene_assets[0].local_path);
    await writeFile(path.join(runsRoot, sourceRunId, "run.json"), JSON.stringify({
      revision: 1,
      nodeRuns: [{
        nodeId: "assets",
        status: "succeeded",
        operationRequestId: "source-operation",
        outputState: {
          generatedVersionId: "source-assets-v1",
          effectiveVersionId: "source-assets-v1",
          stale: false,
        },
      }],
    }));
    const operationDirectory = path.join(runsRoot, sourceRunId, "nodes", "assets", ".generation-operations");
    const sourceLedger = JSON.parse(await readFile(path.join(
      operationDirectory,
      `${createHash("sha256").update("source-operation").digest("hex")}.json`,
    ), "utf8"));
    const stalePath = path.join(sourceOutputDir, "stale-scene-1.png");
    const staleBytes = Buffer.from("stale-scene-one");
    await writeFile(stalePath, staleBytes);
    sourceLedger.operationId = "obsolete-operation";
    sourceLedger.items[0].localPath = stalePath;
    sourceLedger.items[0].sha256 = createHash("sha256").update(staleBytes).digest("hex");
    sourceLedger.items[0].sizeBytes = staleBytes.byteLength;
    await writeFile(path.join(operationDirectory, "000-obsolete.json"), JSON.stringify(sourceLedger));

    const secondRequest = routedWorkerRequest(currentScriptPath, currentDirectorPath, currentOutputDir, 1, 0.25);
    secondRequest.commandId = "rework-operation";
    secondRequest.runId = currentRunId;
    const secondInput = secondRequest.input as Record<string, unknown>;
    secondInput.rework = {
      sourceRunId,
      sourceRunRevision: 1,
      instruction: "严格执行修订后的逐镜路由；保留未受影响母片，只替换镜头 2。",
      findings: [],
      affectedScenePositions: [2],
      previousScript: script,
      previousDirectorPlan,
    };
    const second = await subject.run(secondRequest);

    assert.equal(second.status, "succeeded");
    assert.equal(paidCalls, 3);
    assert.equal(second.diagnostics?.actualCostCny, 0.25);
    assert.equal(second.diagnostics?.meteredAttemptCount, 1);
    const jobs = JSON.parse(await readFile(path.join(currentOutputDir, "generation_jobs.json"), "utf8"));
    assert.equal(jobs.jobs[0].scenePosition, 1);
    assert.equal(jobs.jobs[0].carriedForward, true);
    assert.equal(jobs.jobs[1].scenePosition, 2);
    assert.equal(jobs.jobs[1].carriedForward, undefined);
    const secondPlan = JSON.parse(await readFile(String(second.output?.assetPlanPath), "utf8"));
    assert.equal(path.dirname(secondPlan.scene_assets[0].local_path), currentOutputDir);
    assert.deepEqual(await readFile(secondPlan.scene_assets[0].local_path), sourceSceneOneBytes);

    const advancedSourceRun = JSON.parse(await readFile(path.join(runsRoot, sourceRunId, "run.json"), "utf8"));
    advancedSourceRun.revision = 2;
    await writeFile(path.join(runsRoot, sourceRunId, "run.json"), JSON.stringify(advancedSourceRun));
    const staleRevisionOutputDir = path.join(runsRoot, "run-stale-rework", "nodes", "assets", "attempt-1");
    const staleRevisionRequest = routedWorkerRequest(
      currentScriptPath,
      currentDirectorPath,
      staleRevisionOutputDir,
      2,
      0.5,
    );
    staleRevisionRequest.commandId = "stale-revision-rework-operation";
    staleRevisionRequest.runId = "run-stale-rework";
    (staleRevisionRequest.input as Record<string, unknown>).rework = {
      ...secondInput.rework as Record<string, unknown>,
      sourceRunRevision: 1,
    };

    const staleRevision = await subject.run(staleRevisionRequest);

    assert.equal(staleRevision.status, "succeeded");
    assert.equal(paidCalls, 5);
    const staleJobs = JSON.parse(await readFile(path.join(staleRevisionOutputDir, "generation_jobs.json"), "utf8"));
    assert.deepEqual(staleJobs.jobs.map((job: { carriedForward?: boolean }) => job.carriedForward), [undefined, undefined]);
  });

  it("carries materialized scenes from a partially failed source run and requotes only the failed scene", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-partial-failure-carry-"));
    const runsRoot = path.join(root, "runs");
    const sourceRunId = "run-source";
    const currentRunId = "run-current";
    const sourceOutputDir = path.join(runsRoot, sourceRunId, "nodes", "assets", "attempt-1");
    const currentOutputDir = path.join(runsRoot, currentRunId, "nodes", "assets", "attempt-1");
    await mkdir(sourceOutputDir, { recursive: true });
    const script = { scenes: [1, 2, 3].map((position) => ({
      position,
      duration: 4,
      visual_strategy: "generated",
      visual_prompt: `scene ${position}`,
    })) };
    const directorPlan = { shots: [1, 2, 3].map((position) => ({
      scenePosition: position,
      preferredProviderId: "seedream-image-v1",
      deliveryType: "generated_image",
      generationPrompt: `scene ${position}`,
    })) };
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify(script));
    await writeFile(directorPlanPath, JSON.stringify(directorPlan));
    const generatePrompts: string[] = [];
    let paidCalls = 0;
    const adapter: ImageGenerationAdapter = {
      providerId: "seedream-image-v1",
      modelId: "doubao-seedream-4-0-250828",
      generate: async (request) => {
        paidCalls += 1;
        if (paidCalls === 3) {
          // 源 run 的第三镜在提交前被 Provider 拒绝：terminal_failed，无不确定结果。
          throw new ProviderRequestRejectedError("provider rejected scene 3 before submission");
        }
        generatePrompts.push(request.prompt);
        return {
          providerId: "seedream-image-v1",
          taskId: `image-${paidCalls}`,
          imageUrl: `https://example.com/image-${paidCalls}.png`,
        };
      },
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{ estimatedCnyPerImage: 0.25, adapter }],
      runsRoot,
      resolveHost: resolvePublicHost,
      fetch: async (url) => new Response(`bytes:${String(url)}`, { headers: { "content-type": "image/png" } }),
    });

    const firstRequest = routedWorkerRequest(scriptPath, directorPlanPath, sourceOutputDir, 3, 0.75);
    firstRequest.commandId = "source-operation";
    firstRequest.runId = sourceRunId;
    const first = await subject.run(firstRequest);
    assert.equal(first.status, "failed");
    assert.equal(paidCalls, 3);
    // 源 run：assets 节点 failed 但结果确定，不存在 outcomeUncertain。
    await writeFile(path.join(runsRoot, sourceRunId, "run.json"), JSON.stringify({
      revision: 1,
      nodeRuns: [{
        nodeId: "assets",
        status: "failed",
        operationRequestId: "source-operation",
      }],
    }));
    const sourceLedger = JSON.parse(await readFile(path.join(
      runsRoot,
      sourceRunId,
      "nodes",
      "assets",
      ".generation-operations",
      `${createHash("sha256").update("source-operation").digest("hex")}.json`,
    ), "utf8")) as { items: Array<{ scenePosition: number; state: string }> };
    assert.deepEqual(sourceLedger.items.map((item) => [item.scenePosition, item.state]), [
      [1, "materialized"],
      [2, "materialized"],
      [3, "terminal_failed"],
    ]);

    const promptsAfterSource = generatePrompts.length;
    const secondRequest = routedWorkerRequest(scriptPath, directorPlanPath, currentOutputDir, 1, 0.25);
    secondRequest.commandId = "rework-operation";
    secondRequest.runId = currentRunId;
    (secondRequest.input as Record<string, unknown>).rework = {
      sourceRunId,
      sourceRunRevision: 1,
      instruction: "只重做镜头 3。",
      findings: [],
      affectedScenePositions: [3],
      previousScript: script,
      previousDirectorPlan: directorPlan,
    };
    const second = await subject.run(secondRequest);

    assert.equal(second.status, "succeeded");
    assert.equal(paidCalls, 4);
    // 新报价仅含镜头 3：授权上限只有一张图的价钱，两镜被继承后不会超出。
    assert.equal(second.diagnostics?.estimatedCostCny, 0.25);
    assert.equal(second.diagnostics?.actualCostCny, 0.25);
    assert.equal(second.diagnostics?.meteredAttemptCount, 1);
    // Provider 只收到镜头 3 的重新生成请求。
    const reworkPrompts = generatePrompts.slice(promptsAfterSource);
    assert.equal(reworkPrompts.length, 1);
    assert.match(reworkPrompts[0]!, /scene 3/);
    const jobs = JSON.parse(await readFile(path.join(currentOutputDir, "generation_jobs.json"), "utf8"));
    assert.deepEqual(jobs.jobs.map((job: { scenePosition: number; carriedForward?: boolean }) => (
      [job.scenePosition, job.carriedForward === true]
    )), [
      [1, true],
      [2, true],
      [3, false],
    ]);
    const secondPlan = JSON.parse(await readFile(String(second.output?.assetPlanPath), "utf8"));
    assert.equal(secondPlan.scene_assets.length, 3);
  });

  it("carries a shot whose only change is the current pricing rate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-rate-only-rework-"));
    const runsRoot = path.join(root, "runs");
    const sourceRunId = "run-source";
    const currentRunId = "run-current";
    const sourceOutputDir = path.join(runsRoot, sourceRunId, "nodes", "assets", "attempt-1");
    const currentOutputDir = path.join(runsRoot, currentRunId, "nodes", "assets", "attempt-1");
    await mkdir(sourceOutputDir, { recursive: true });
    const script = { scenes: [1, 2].map((position) => ({
      position,
      duration: 4,
      visual_strategy: "generated",
      visual_prompt: `scene ${position}`,
    })) };
    const previousDirectorPlan = { shots: [
      {
        scenePosition: 1,
        preferredProviderId: "seedream-image-v1",
        deliveryType: "generated_image",
        generationPrompt: "keep scene one",
        estimatedCostCny: 1,
        confidence: 0.7,
        rationale: "旧费率下的理由。",
      },
      {
        scenePosition: 2,
        preferredProviderId: "seedream-image-v1",
        deliveryType: "generated_image",
        generationPrompt: "replace scene two",
        estimatedCostCny: 1,
        confidence: 0.7,
        rationale: "旧费率下的理由。",
      },
    ] };
    // 当前费率翻倍：镜头 1 的唯一变化是服务端重算的 estimatedCostCny。镜头 2 才真正重做。
    const currentDirectorPlan = structuredClone(previousDirectorPlan);
    currentDirectorPlan.shots[0]!.estimatedCostCny = 2;
    currentDirectorPlan.shots[1]!.estimatedCostCny = 2;
    currentDirectorPlan.shots[1]!.generationPrompt = "fixed scene two";
    const sourceScriptPath = path.join(root, "source-script.json");
    const currentScriptPath = path.join(root, "current-script.json");
    const sourceDirectorPath = path.join(root, "source-director.json");
    const currentDirectorPath = path.join(root, "current-director.json");
    await writeFile(sourceScriptPath, JSON.stringify(script));
    await writeFile(currentScriptPath, JSON.stringify(script));
    await writeFile(sourceDirectorPath, JSON.stringify(previousDirectorPlan));
    await writeFile(currentDirectorPath, JSON.stringify(currentDirectorPlan));
    let paidCalls = 0;
    const adapter: ImageGenerationAdapter = {
      providerId: "seedream-image-v1",
      modelId: "doubao-seedream-4-0-250828",
      generate: async () => {
        paidCalls += 1;
        return {
          providerId: "seedream-image-v1",
          taskId: `image-${paidCalls}`,
          imageUrl: `https://example.com/image-${paidCalls}.png`,
        };
      },
    };
    const makeClient = (estimatedCnyPerImage: number) => new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{ estimatedCnyPerImage, adapter }],
      runsRoot,
      resolveHost: resolvePublicHost,
      fetch: async (url) => new Response(`bytes:${String(url)}`, { headers: { "content-type": "image/png" } }),
    });
    const sourceSubject = makeClient(1);

    const firstRequest = routedWorkerRequest(sourceScriptPath, sourceDirectorPath, sourceOutputDir, 2, 2);
    firstRequest.commandId = "source-operation";
    firstRequest.runId = sourceRunId;
    const first = await sourceSubject.run(firstRequest);
    assert.equal(first.status, "succeeded");
    assert.equal(paidCalls, 2);
    await writeFile(path.join(runsRoot, sourceRunId, "run.json"), JSON.stringify({
      revision: 1,
      nodeRuns: [{
        nodeId: "assets",
        status: "succeeded",
        operationRequestId: "source-operation",
        outputState: {
          generatedVersionId: "source-assets-v1",
          effectiveVersionId: "source-assets-v1",
          stale: false,
        },
      }],
    }));

    // 费率从 ¥1 调整为 ¥2 后的返工：镜头 1 的执行语义未变，不得重复生成。
    const reworkSubject = makeClient(2);
    const secondRequest = routedWorkerRequest(currentScriptPath, currentDirectorPath, currentOutputDir, 1, 2);
    secondRequest.commandId = "rework-operation";
    secondRequest.runId = currentRunId;
    (secondRequest.input as Record<string, unknown>).rework = {
      sourceRunId,
      sourceRunRevision: 1,
      instruction: "只重做镜头 2。",
      findings: [],
      affectedScenePositions: [2],
      previousScript: script,
      previousDirectorPlan,
    };
    const second = await reworkSubject.run(secondRequest);

    assert.equal(second.status, "succeeded");
    assert.equal(paidCalls, 3);
    // 镜头 1 不进入新报价：授权上限只覆盖一张新费率的图。
    assert.equal(second.diagnostics?.estimatedCostCny, 2);
    assert.equal(second.diagnostics?.actualCostCny, 2);
    assert.equal(second.diagnostics?.meteredAttemptCount, 1);
    const jobs = JSON.parse(await readFile(path.join(currentOutputDir, "generation_jobs.json"), "utf8"));
    assert.deepEqual(jobs.jobs.map((job: { scenePosition: number; carriedForward?: boolean }) => (
      [job.scenePosition, job.carriedForward === true]
    )), [
      [1, true],
      [2, false],
    ]);
  });

  // 四镜源 run：镜头 1 独立图片、镜头 2 参考镜头 1 再生成、镜头 3 参考镜头 2 再生成、镜头 4 独立图片；
  // 为返工继承测试提供真实物化的多级引用链源 ledger，避免复制多套完整账本。
  async function setupReferenceReworkSourceRun() {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reference-carry-"));
    const runsRoot = path.join(root, "runs");
    const sourceRunId = "run-source";
    const sourceOutputDir = path.join(runsRoot, sourceRunId, "nodes", "assets", "attempt-1");
    await mkdir(sourceOutputDir, { recursive: true });
    const script = { scenes: [1, 2, 3, 4].map((position) => ({
      position,
      duration: 4,
      visual_strategy: "generated",
      visual_prompt: `scene ${position}`,
    })) };
    const directorPlan = { shots: [
      { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "master one" },
      { scenePosition: 2, preferredProviderId: "seedream-image-v1", referenceFromScenePosition: 1, generationPrompt: "reference master one" },
      { scenePosition: 3, preferredProviderId: "seedream-image-v1", referenceFromScenePosition: 2, generationPrompt: "reference master two" },
      { scenePosition: 4, preferredProviderId: "seedream-image-v1", generationPrompt: "independent four" },
    ] };
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify(script));
    await writeFile(directorPlanPath, JSON.stringify(directorPlan));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{
        estimatedCnyPerImage: 0.25,
        adapter: {
          providerId: "seedream-image-v1",
          modelId: "doubao-seedream-4-0-250828",
          supportsReferenceImage: true,
          generate: async () => {
            paidCalls += 1;
            return {
              providerId: "seedream-image-v1",
              taskId: `image-${paidCalls}`,
              imageUrl: `https://example.com/image-${paidCalls}.png`,
            };
          },
        },
      }],
      runsRoot,
      resolveHost: resolvePublicHost,
      fetch: async (input) => new Response(`image:${String(input)}`, { headers: { "content-type": "image/png" } }),
    });
    const firstRequest = routedWorkerRequest(scriptPath, directorPlanPath, sourceOutputDir, 4, 1);
    firstRequest.commandId = "source-operation";
    firstRequest.runId = sourceRunId;
    const first = await subject.run(firstRequest);
    assert.equal(first.status, "succeeded");
    assert.equal(paidCalls, 4);
    await writeFile(path.join(runsRoot, sourceRunId, "run.json"), JSON.stringify({
      revision: 1,
      nodeRuns: [{
        nodeId: "assets",
        status: "succeeded",
        operationRequestId: "source-operation",
        outputState: {
          generatedVersionId: "source-assets-v1",
          effectiveVersionId: "source-assets-v1",
          stale: false,
        },
      }],
    }));
    const sourceLedgerPath = path.join(
      runsRoot,
      sourceRunId,
      "nodes",
      "assets",
      ".generation-operations",
      `${createHash("sha256").update("source-operation").digest("hex")}.json`,
    );
    return {
      root,
      subject,
      getPaidCalls: () => paidCalls,
      reworkRequest: (attempt: number, affectedScenePositions: number[]) => {
        const outputDir = path.join(root, `rework-${attempt}`, "attempt-1");
        const request = routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 4, 1);
        request.commandId = `rework-operation-${attempt}`;
        request.runId = "run-current";
        (request.input as Record<string, unknown>).rework = {
          sourceRunId,
          sourceRunRevision: 1,
          nodeInstructions: { visualDirection: "保留未受影响镜头。", assets: "只重做受影响镜头，其余保留母片。" },
          findings: [],
          affectedScenePositions,
          previousScript: script,
          previousDirectorPlan: directorPlan,
        };
        return { request, outputDir };
      },
      readSourceLedger: async () => JSON.parse(await readFile(sourceLedgerPath, "utf8")),
      overwriteSourceLedger: async (ledger: unknown) => {
        await writeFile(sourceLedgerPath, JSON.stringify(ledger));
      },
    };
  }

  it("carries every unchanged paid scene when the creator selects an explicit empty rework scope", async () => {
    const { subject, getPaidCalls, reworkRequest } = await setupReferenceReworkSourceRun();
    const { request, outputDir } = reworkRequest(0, []);

    const response = await subject.run(request);

    assert.equal(response.status, "succeeded");
    assert.equal(getPaidCalls(), 4);
    assert.equal(response.diagnostics?.estimatedCostCny, 0);
    assert.equal(response.diagnostics?.actualCostCny, 0);
    assert.equal(response.diagnostics?.meteredAttemptCount, 0);
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));
    assert.deepEqual(jobs.jobs.map((job: { scenePosition: number; carriedForward?: boolean }) => (
      [job.scenePosition, job.carriedForward === true]
    )), [
      [1, true],
      [2, true],
      [3, true],
      [4, true],
    ]);
  });

  it("carries an unaffected multi-level reference chain across runs with one new paid call", async () => {
    const { root, subject, getPaidCalls, reworkRequest, readSourceLedger } = await setupReferenceReworkSourceRun();
    const { request, outputDir } = reworkRequest(1, [4]);

    const response = await subject.run(request);

    assert.equal(response.status, "succeeded");
    assert.equal(getPaidCalls(), 5);
    assert.equal(response.diagnostics?.estimatedCostCny, 0.25);
    assert.equal(response.diagnostics?.actualCostCny, 0.25);
    assert.equal(response.diagnostics?.meteredAttemptCount, 1);
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 1)?.carriedForward, true);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 2)?.carriedForward, true);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 3)?.carriedForward, true);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 4)?.carriedForward, undefined);
    const ledger = JSON.parse(await readFile(path.join(
      path.dirname(outputDir),
      ".generation-operations",
      `${createHash("sha256").update(String(request.commandId)).digest("hex")}.json`,
    ), "utf8"));
    const sourceLedger = await readSourceLedger();
    for (const position of [1, 2, 3]) {
      const carried = ledger.items.find((item: { scenePosition: number }) => item.scenePosition === position);
      const source = sourceLedger.items.find((item: { scenePosition: number }) => item.scenePosition === position);
      assert.equal(carried.carriedForwardFromItemRequestId, source.itemRequestId);
      assert.equal(carried.sha256, source.sha256);
      assert.equal(carried.sizeBytes, source.sizeBytes);
      assert.equal(carried.actualCostCny, source.actualCostCny);
    }
    const regenerated = ledger.items.find((item: { scenePosition: number }) => item.scenePosition === 4);
    assert.equal(regenerated.carriedForwardFromItemRequestId, undefined);
    void root;
  });

  it("regenerates reference dependents when their reference source joins the affected closure", async () => {
    const { subject, getPaidCalls, reworkRequest } = await setupReferenceReworkSourceRun();
    const { request, outputDir } = reworkRequest(2, [1]);

    const response = await subject.run(request);

    assert.equal(response.status, "succeeded");
    assert.equal(getPaidCalls(), 7);
    assert.equal(response.diagnostics?.actualCostCny, 0.75);
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 1)?.carriedForward, undefined);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 2)?.carriedForward, undefined);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 3)?.carriedForward, undefined);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 4)?.carriedForward, true);
  });

  it("refuses to inherit a reference-derived master whose reference SHA cannot be proven", async () => {
    const { subject, getPaidCalls, reworkRequest, readSourceLedger, overwriteSourceLedger } = await setupReferenceReworkSourceRun();
    const sourceLedger = await readSourceLedger();
    const tampered = sourceLedger.items.find((item: { scenePosition: number }) => item.scenePosition === 2);
    tampered.parameters.referenceImageSha256 = "0".repeat(64);
    await overwriteSourceLedger(sourceLedger);
    const { request, outputDir } = reworkRequest(3, [4]);

    const response = await subject.run(request);

    assert.equal(response.status, "succeeded");
    assert.equal(getPaidCalls(), 7);
    assert.equal(response.diagnostics?.actualCostCny, 0.75);
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 1)?.carriedForward, true);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 2)?.carriedForward, undefined);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 3)?.carriedForward, undefined);
    assert.equal(jobs.jobs.find((job: { scenePosition: number }) => job.scenePosition === 4)?.carriedForward, undefined);
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
    const ledgerName = (await readdir(path.join(root, ".generation-operations")))[0]!;
    const ledger = JSON.parse(await readFile(path.join(root, ".generation-operations", ledgerName), "utf8"));

    assert.deepEqual(receivedModels, ["doubao-seedance-2-5-260628"]);
    assert.deepEqual(receivedDurations, [4]);
    assert.deepEqual(receivedResolutions, ["720p"]);
    assert.equal(jobs.jobs[0].modelId, "doubao-seedance-2-5-260628");
    assert.equal(jobs.jobs[0].estimatedCostCny, 2.4);
    assert.equal(response.diagnostics?.estimatedCostCny, 2.4);
    assert.equal(response.diagnostics?.actualCostCny, 2.4);
    assert.equal(response.diagnostics?.actualCostSource, "configured_rate");
    assert.deepEqual(response.diagnostics?.actualModelIds, ["doubao-seedance-2-5-260628"]);
    assert.equal(ledger.items[0].parameters.durationSeconds, receivedDurations[0]);
    assert.equal(ledger.items[0].parameters.resolution, receivedResolutions[0]);
    assert.equal(ledger.items[0].parameters.generateAudio, false);
    assert.match(ledger.items[0].parameters.executionDigest, /^[a-f0-9]{64}$/);
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

  it("uses Hailuo 2.3 discrete duration and resolution prices for quotes and execution", () => {
    const profile = {
      taskTypes: ["text-to-video" as const],
      resolutions: ["768P", "1080P"],
      minDurationSeconds: 6,
      maxDurationSeconds: 10,
      allowedDurationsSeconds: [6, 10],
      supportsAudio: false,
      estimatedCnyByResolutionAndDuration: {
        "768P": { "6": 2, "10": 4 },
        "1080P": { "6": 3.5 },
      },
    };

    assert.equal(normalizeVideoGenerationDurationSeconds(4, profile), 6);
    assert.equal(normalizeVideoGenerationDurationSeconds(7, profile), 10);
    assert.equal(estimateVideoGenerationCostCny(4, 2, profile), 2);
    assert.equal(estimateVideoGenerationCostCny(7, 2, profile), 4);
  });

  it("rejects a selected video model that cannot deliver the required portrait ratio before spending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-ratio-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 6, visual_strategy: "generated", visual_prompt: "窗边水杯" },
    ] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 2,
        defaultModelId: "MiniMax-Hailuo-2.3",
        modelPrices: { "MiniMax-Hailuo-2.3": 2 },
        modelProfiles: {
          "MiniMax-Hailuo-2.3": {
            taskTypes: ["text-to-video"], resolutions: ["768P"], aspectRatios: ["16:9"],
            minDurationSeconds: 6, maxDurationSeconds: 10, allowedDurationsSeconds: [6, 10], supportsAudio: false,
          },
        },
        adapter: {
          providerId: "hailuo-video-v1",
          generate: async () => {
            paidCalls += 1;
            return { providerId: "hailuo-video-v1", taskId: "must-not-run", videoUrl: "https://example.com/no.mp4" };
          },
        },
      }],
    });

    const request = workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 2);
    (request.parameters as Record<string, unknown>).providerId = "hailuo-video-v1";
    (request.parameters as Record<string, unknown>).modelSelections = { "hailuo-video-v1": "MiniMax-Hailuo-2.3" };
    await assert.rejects(
      () => subject.run(request),
      /does not support.*9:16/i,
    );
    assert.equal(paidCalls, 0);
  });

  it("records probed generated-video metadata instead of declared placeholder dimensions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-probe-"));
    const scriptPath = path.join(root, "script.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "雨后街道" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 2,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1", taskId: "portrait-task", videoUrl: "https://example.com/portrait.mp4",
          }),
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("portrait-video", { headers: { "content-type": "video/mp4" } }),
      probeGeneratedMedia: async () => ({ width: 1080, height: 1920, durationSeconds: 5.875 }),
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 2));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    assert.deepEqual(
      { width: plan.scene_assets[0].width, height: plan.scene_assets[0].height, duration: plan.scene_assets[0].duration },
      { width: 1080, height: 1920, duration: 5.875 },
    );
  });

  it("stops before downstream spending when a generated video is shorter than its planned use", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-short-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 3, visual_strategy: "generated", visual_prompt: "雨后街道" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 2,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1", taskId: "short-task", videoUrl: "https://example.com/short.mp4",
          }),
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("short-video", { headers: { "content-type": "video/mp4" } }),
      probeGeneratedMedia: async () => ({ width: 720, height: 1280, durationSeconds: 0.5 }),
    });

    const response = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 2));

    assert.equal(response.status, "failed");
    assert.match(response.error?.message ?? "", /0\.5s.*planned 3s/);
    assert.equal(response.diagnostics?.providerOutcomeKnown, true);
  });

  it("fails a paid asset before rendering when the downloaded video is not portrait", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-probe-"));
    const scriptPath = path.join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "雨后街道" },
    ] }));
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 2,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => ({
            providerId: "seedance-video-v1", taskId: "landscape-task", videoUrl: "https://example.com/landscape.mp4",
          }),
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("landscape-video", { headers: { "content-type": "video/mp4" } }),
      probeGeneratedMedia: async () => ({ width: 1366, height: 768, durationSeconds: 5.875 }),
    });

    const response = await subject.run(workerRequest(scriptPath, path.join(root, "attempt-1"), 1, 2));
    assert.equal(response.status, "failed");
    assert.match(response.error?.message ?? "", /1366x768.*9:16/);
    assert.equal(response.diagnostics?.providerOutcomeKnown, true);
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
            throw new ProviderRequestRejectedError("model has not been activated");
          },
        },
      }],
    });

    const response = await subject.run(workerRequest(scriptPath, outputDir, 1, 8));
    const plan = JSON.parse(await readFile(String(response.output?.assetPlanPath), "utf8"));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(jobs.jobs[0].taskId, undefined);
    assert.equal(jobs.jobs[0].status, "failed");
    const ledgers = await readdir(path.join(root, ".generation-operations"));
    const ledger = JSON.parse(await readFile(path.join(root, ".generation-operations", ledgers[0]!), "utf8"));
    assert.equal(ledger.items[0].state, "terminal_failed");
    assert.equal(ledger.items[0].actualCostCny, undefined);
    assert.equal(response.diagnostics?.actualCostCny, 0);
    assert.equal(response.diagnostics?.meteredAttemptCount, 0);
    assert.equal(response.diagnostics?.meteredFailedAttemptCount, 0);
    assert.equal(response.diagnostics?.actualModelIds, undefined);
    assert.equal(plan.generation.meteredAttemptCount, 0);
    assert.equal(plan.generation.meteredFailedAttemptCount, 0);
    assert.equal(plan.generation.actualModelIds, undefined);
  });

  it("keeps an AI-routed task recoverable after a transient reconciled-result download failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-routed-transient-recovery-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "恢复导演路由的付费镜头" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({
      version: "video-factory/director-plan-v1",
      shots: [{
        scenePosition: 1,
        preferredProviderId: "seedance-video-v1",
        deliveryType: "generated_video",
        generationPrompt: "恢复导演路由的付费镜头",
      }],
    }));
    let createCalls = 0;
    let reconcileCalls = 0;
    let downloadCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async (_request, onProgress) => {
            createCalls += 1;
            await onProgress?.({
              providerId: "seedance-video-v1",
              taskId: "routed-existing-task",
              status: "unknown",
              error: "initial polling connection lost",
            });
            throw new Error("initial polling connection lost");
          },
          reconcile: async (taskId) => {
            reconcileCalls += 1;
            assert.equal(taskId, "routed-existing-task");
            return {
              providerId: "seedance-video-v1",
              taskId,
              videoUrl: "https://example.com/routed-recovered.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => {
        downloadCalls += 1;
        return downloadCalls === 1
          ? new Response("temporary CDN failure", { status: 503 })
          : new Response("routed-recovered-video", { headers: { "content-type": "video/mp4" } });
      },
    });

    assert.equal((await subject.run(routedWorkerRequest(
      scriptPath,
      directorPlanPath,
      path.join(root, "attempt-1"),
      1,
      1,
    ))).status, "failed");
    const secondRequest = routedWorkerRequest(
      scriptPath,
      directorPlanPath,
      path.join(root, "attempt-2"),
      0,
      0,
    );
    secondRequest.attempt = 2;
    assert.equal((await subject.run(secondRequest)).status, "failed");
    const ledgerPath = path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-routed").digest("hex")}.json`,
    );
    const recoveringLedger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(recoveringLedger.items[0].state, "provider_succeeded");
    assert.equal(recoveringLedger.items[0].taskId, "routed-existing-task");
    assert.equal(recoveringLedger.items[0].resultUrl, "https://example.com/routed-recovered.mp4");

    const thirdRequest = routedWorkerRequest(
      scriptPath,
      directorPlanPath,
      path.join(root, "attempt-3"),
      0,
      0,
    );
    thirdRequest.attempt = 3;
    const recovered = await subject.run(thirdRequest);

    assert.equal(recovered.status, "succeeded");
    assert.equal(createCalls, 1);
    assert.equal(reconcileCalls, 2);
    assert.equal(downloadCalls, 2);
    assert.equal(recovered.diagnostics?.meteredAttemptCount, 0);
  });

  it("flags an AI-routed result whose download fails permanently for item-level reconciliation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-routed-permanent-download-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 5, visual_strategy: "generated", visual_prompt: "路由任务永久下载失败" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({
      version: "video-factory/director-plan-v1",
      shots: [{
        scenePosition: 1,
        preferredProviderId: "seedance-video-v1",
        deliveryType: "generated_video",
        generationPrompt: "路由任务永久下载失败",
      }],
    }));
    let createCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [{
        estimatedCnyPerClip: 1,
        adapter: {
          providerId: "seedance-video-v1",
          generate: async () => {
            createCalls += 1;
            return {
              providerId: "seedance-video-v1",
              taskId: "routed-permanent-404",
              videoUrl: "https://example.com/routed-gone.mp4",
            };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("gone", { status: 404 }),
    });

    assert.equal((await subject.run(routedWorkerRequest(
      scriptPath,
      directorPlanPath,
      path.join(root, "attempt-1"),
      1,
      1,
    ))).status, "failed");
    const recoveryRequest = routedWorkerRequest(
      scriptPath,
      directorPlanPath,
      path.join(root, "attempt-2"),
      0,
      0,
    );
    recoveryRequest.attempt = 2;
    const recovery = await subject.run(recoveryRequest);

    assert.equal(recovery.status, "failed");
    assert.equal(recovery.diagnostics?.providerOutcomeKnown, false);
    const ledger = JSON.parse(await readFile(path.join(
      root,
      ".generation-operations",
      `${createHash("sha256").update("command-routed").digest("hex")}.json`,
    ), "utf8"));
    // 404 是永久失败：保留任务、URL、费用与错误证据，标记逐项人工核账，且绝不重建任务。
    assert.equal(ledger.items[0].state, "provider_succeeded");
    assert.equal(ledger.items[0].manualReconciliationRequired, true);
    assert.equal(ledger.items[0].taskId, "routed-permanent-404");
    assert.equal(ledger.items[0].resultUrl, "https://example.com/routed-gone.mp4");
    assert.match(ledger.items[0].error ?? "", /404/i);
    assert.equal(createCalls, 1);
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
          successCriteria: [
            "蒸汽持续可见",
            "食物主体不变形",
            "成片中 Seedream 素材的 AIGC 标识清晰可见且未被裁切、遮挡或移除",
            "所有生成式镜头保留清晰可见的 AI 内容声明标识",
          ],
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
    assert.match(generated[0]!, /不得出现任何可读文字.*乱码.*内部制作术语/);
    assert.doesNotMatch(generated[0]!, /预算|审批|版权|工作流/);
    assert.doesNotMatch(generated[0]!, /Seedream|AIGC|标识|裁切|遮挡|移除/);
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

  it("generates referenced images in scene order without persisting the reference data URL", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-image-reference-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [
      { position: 1, duration: 4, visual_strategy: "generated", visual_prompt: "固定主角与厨房环境" },
      { position: 2, duration: 4, visual_strategy: "generated", visual_prompt: "同一主角切开苹果" },
    ] }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "主角站在厨房案板前" },
      {
        scenePosition: 2,
        preferredProviderId: "seedream-image-v1",
        referenceFromScenePosition: 1,
        generationPrompt: "保持同一主角与厨房，切开苹果",
      },
    ] }));
    const requests: Array<{ prompt: string; referenceImages?: [string, ...string[]] }> = [];
    const imageAdapter: ImageGenerationAdapter = {
      providerId: "seedream-image-v1",
      modelId: "doubao-seedream-4-0-250828",
      supportsReferenceImage: true,
      generate: async (request) => {
        requests.push(request);
        const index = requests.length;
        return {
          providerId: "seedream-image-v1",
          taskId: `image-reference-${index}`,
          imageUrl: `https://example.com/reference-${index}.png`,
        };
      },
    };
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{ adapter: imageAdapter, estimatedCnyPerImage: 0.25 }],
      resolveHost: resolvePublicHost,
      fetch: async (input) => new Response(
        String(input).endsWith("reference-1.png") ? "source-image" : "referenced-image",
        { headers: { "content-type": "image/png" } },
      ),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 2, 0.5));

    assert.equal(response.status, "succeeded");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.referenceImages, undefined);
    assert.deepEqual(requests[1]?.referenceImages, [
      `data:image/png;base64,${Buffer.from("source-image").toString("base64")}`,
    ]);
    const jobsText = await readFile(path.join(outputDir, "generation_jobs.json"), "utf8");
    const jobs = JSON.parse(jobsText);
    assert.deepEqual(
      jobs.jobs.map((job: { modelId: string }) => job.modelId),
      ["doubao-seedream-4-0-250828", "doubao-seedream-4-0-250828"],
    );
    assert.equal(jobsText.includes("data:image"), false);
    const ledgerName = (await readdir(path.join(root, ".generation-operations")))[0]!;
    const ledgerText = await readFile(path.join(root, ".generation-operations", ledgerName), "utf8");
    const ledger = JSON.parse(ledgerText);
    assert.equal(ledgerText.includes("data:image"), false);
    assert.equal(ledger.items[1].modelId, "doubao-seedream-4-0-250828");
    assert.equal(ledger.items[1].parameters.referenceFromScenePosition, 1);
    assert.equal(
      ledger.items[1].parameters.referenceImageSha256,
      createHash("sha256").update("source-image").digest("hex"),
    );
    assert.equal(ledger.items[1].inputFingerprint.length, 64);
    assert.equal(response.diagnostics?.estimatedCostCny, 0.5);
    assert.equal(response.diagnostics?.actualCostCny, 0.5);
    assert.deepEqual(response.diagnostics?.actualModelIds, ["doubao-seedream-4-0-250828"]);

    const retryRequest = routedWorkerRequest(
      scriptPath,
      directorPlanPath,
      path.join(root, "attempt-2"),
      0,
      0,
    );
    retryRequest.commandId = "command-routed-reference-retry";
    const retried = await subject.run(retryRequest);
    assert.equal(retried.status, "succeeded");
    assert.equal(requests.length, 2);
    assert.equal(retried.diagnostics?.estimatedCostCny, 0);
    assert.equal(retried.diagnostics?.actualCostCny, 0);
  });

  it("redacts a reference data URL echoed by an image provider before persisting diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reference-redaction-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [1, 2].map((position) => ({
      position,
      duration: 4,
      visual_strategy: "generated",
      visual_prompt: `scene ${position}`,
    })) }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "first" },
      { scenePosition: 2, preferredProviderId: "seedream-image-v1", referenceFromScenePosition: 1, generationPrompt: "second" },
    ] }));
    let calls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{
        estimatedCnyPerImage: 0.25,
        adapter: {
          providerId: "seedream-image-v1",
          supportsReferenceImage: true,
          generate: async () => {
            calls += 1;
            if (calls === 1) {
              return {
                providerId: "seedream-image-v1",
                taskId: "source-image",
                imageUrl: "https://example.com/source.png",
              };
            }
            throw new ProviderRequestRejectedError("bad reference data:image/png;base64,UElJ");
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("source-image", { headers: { "content-type": "image/png" } }),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 2, 0.5));
    const jobsText = await readFile(path.join(outputDir, "generation_jobs.json"), "utf8");
    const ledgerName = (await readdir(path.join(root, ".generation-operations")))[0]!;
    const ledgerText = await readFile(path.join(root, ".generation-operations", ledgerName), "utf8");

    assert.equal(response.status, "failed");
    assert.equal(calls, 2);
    assert.match(response.error?.message ?? "", /\[redacted image data\]/);
    for (const persisted of [jobsText, ledgerText]) {
      assert.match(persisted, /\[redacted image data\]/);
      assert.doesNotMatch(persisted, /data:image|UElJ/);
    }
  });

  it("rejects invalid reference-image routes before fallback or paid provider calls", async () => {
    const cases = [
      {
        name: "missing generated image source",
        shots: [
          { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "first" },
          { scenePosition: 2, preferredProviderId: "seedream-image-v1", referenceFromScenePosition: 9, generationPrompt: "second" },
        ],
        expected: /must reference an earlier generated image scene/i,
      },
      {
        name: "reuse and reference conflict",
        shots: [
          { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "first" },
          {
            scenePosition: 2,
            preferredProviderId: "pexels-stock-v1",
            reuseFromScenePosition: 1,
            referenceFromScenePosition: 1,
            generationPrompt: "second",
          },
        ],
        expected: /cannot both reuse and reference/i,
      },
      {
        name: "reference source is itself reused",
        shots: [
          { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "first" },
          { scenePosition: 2, preferredProviderId: "pexels-stock-v1", reuseFromScenePosition: 1, generationPrompt: "reuse" },
          { scenePosition: 3, preferredProviderId: "seedream-image-v1", referenceFromScenePosition: 2, generationPrompt: "third" },
        ],
        expected: /must reference an earlier generated image scene/i,
      },
      {
        name: "image adapter does not implement reference generation",
        shots: [
          { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "first" },
          { scenePosition: 2, preferredProviderId: "seedream-image-v1", referenceFromScenePosition: 1, generationPrompt: "second" },
        ],
        supportsReferenceImage: false,
        expected: /does not support reference images/i,
      },
    ];
    for (const testCase of cases) {
      const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-invalid-reference-"));
      const scriptPath = path.join(root, "script.json");
      const directorPlanPath = path.join(root, "director_plan.json");
      await writeFile(scriptPath, JSON.stringify({ scenes: testCase.shots.map((_shot, index) => ({
        position: index + 1,
        duration: 4,
        visual_strategy: "generated",
        visual_prompt: `scene ${index + 1}`,
      })) }));
      await writeFile(directorPlanPath, JSON.stringify({ shots: testCase.shots }));
      const fallback = new LocalAssetWorker();
      let paidCalls = 0;
      const subject = new GenerativeAssetWorkerClient({
        fallback,
        adapters: [],
        imageAdapters: [{
          estimatedCnyPerImage: 0.25,
          adapter: {
            providerId: "seedream-image-v1",
            supportsReferenceImage: testCase.supportsReferenceImage ?? true,
            generate: async () => {
              paidCalls += 1;
              return { providerId: "seedream-image-v1", taskId: "must-not-run", imageUrl: "https://example.com/no.png" };
            },
          },
        }],
      });

      await assert.rejects(
        () => subject.run(routedWorkerRequest(scriptPath, directorPlanPath, path.join(root, "attempt-1"), 2, 0.5)),
        testCase.expected,
        testCase.name,
      );
      assert.equal(fallback.calls.length, 0, testCase.name);
      assert.equal(paidCalls, 0, testCase.name);
    }
  });

  it("stops referenced generation when the source image cannot be materialized", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-reference-failure-"));
    const scriptPath = path.join(root, "script.json");
    const directorPlanPath = path.join(root, "director_plan.json");
    const outputDir = path.join(root, "attempt-1");
    await writeFile(scriptPath, JSON.stringify({ scenes: [1, 2].map((position) => ({
      position,
      duration: 4,
      visual_strategy: "generated",
      visual_prompt: `scene ${position}`,
    })) }));
    await writeFile(directorPlanPath, JSON.stringify({ shots: [
      { scenePosition: 1, preferredProviderId: "seedream-image-v1", generationPrompt: "first" },
      { scenePosition: 2, preferredProviderId: "seedream-image-v1", referenceFromScenePosition: 1, generationPrompt: "second" },
    ] }));
    let paidCalls = 0;
    const subject = new GenerativeAssetWorkerClient({
      fallback: new LocalAssetWorker(),
      adapters: [],
      imageAdapters: [{
        estimatedCnyPerImage: 0.25,
        adapter: {
          providerId: "seedream-image-v1",
          supportsReferenceImage: true,
          generate: async () => {
            paidCalls += 1;
            return { providerId: "seedream-image-v1", taskId: "source", imageUrl: "https://example.com/source.png" };
          },
        },
      }],
      resolveHost: resolvePublicHost,
      fetch: async () => new Response("download failed", { status: 502 }),
    });

    const response = await subject.run(routedWorkerRequest(scriptPath, directorPlanPath, outputDir, 2, 0.5));
    const jobs = JSON.parse(await readFile(path.join(outputDir, "generation_jobs.json"), "utf8"));

    assert.equal(response.status, "failed");
    assert.equal(paidCalls, 1);
    assert.equal(jobs.jobs.length, 1);
    assert.match(response.error?.message ?? "", /download failed with status 502/i);
    assert.equal(response.artifacts.some((artifact) => artifact.kind === "media_asset"), false);
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

async function pilotHarness(routed: boolean, initialVerdict: "approve" | "revise" | "unavailable", unavailable = false, mixed = false) {
  const root = await mkdtemp(path.join(tmpdir(), "vf-pilot-"));
  const scriptPath = path.join(root, "script.json");
  const directorPlanPath = path.join(root, "director.json");
  const events: string[] = [];
  let verdict = initialVerdict;
  const scenes = [1, 2, 3].map((position) => ({
    position, duration: 4, visual_strategy: "generated", visual_prompt: `scene ${position}`,
  }));
  await writeFile(scriptPath, JSON.stringify({ scenes }));
  await writeFile(directorPlanPath, JSON.stringify({ shots: scenes.map((scene) => ({
    scenePosition: scene.position,
    preferredProviderId: mixed && scene.position > 1 ? "seedream-image-v1" : "seedance-video-v1",
    deliveryType: mixed && scene.position > 1 ? "generated_image" : "generated_video",
    alternativeProviderIds: [], query: scene.visual_prompt, generationPrompt: scene.visual_prompt,
  })) }));
  const agent: VisualReviewAgent = {
    id: "reviewer", modelId: "test-review-model",
    review: async (input) => {
      const position = input.scenePositions![0]!;
      events.push(`review-${position}`);
      const plan = JSON.parse(await readFile(input.assetPlanPath!, "utf8"));
      assert.ok(plan.scene_assets.find((asset: { scene_position: number }) => asset.scene_position === position).local_path);
      if (verdict === "unavailable") throw new Error("review service unavailable");
      return {
        version: "video-factory/visual-review-v1", summary: "试片结果",
        scores: { composition: 94, continuity: 94, pacing: 94, legibility: 94, safety: 94 },
        confidence: 0.95, recommendation: verdict,
        findings: verdict === "approve" ? [] : [{
          timecodeMs: 0, startTimecodeMs: 0, endTimecodeMs: 0,
          scenePosition: position, targetNodeId: "assets", evidenceStatus: "failed",
          evidenceFrameSha256: null, nextAction: "rework_asset", category: "legibility", severity: "critical",
          description: "生成了水印", suggestion: "移除画面水印后重做此镜头",
        }],
      };
    },
  };
  let count = 0;
  const worker = new GenerativeAssetWorkerClient({
    fallback: new LocalAssetWorker(),
    pilotReviewer: new SourceAssetPilotReviewer(unavailable ? [] : [agent]),
    adapters: [{ estimatedCnyPerClip: 2, adapter: {
      providerId: "seedance-video-v1",
      generate: async () => {
        count += 1;
        events.push(`generate-${count}`);
        return { providerId: "seedance-video-v1", taskId: `task-${count}`, videoUrl: `https://example.com/clip-${count}.mp4` };
      },
    } }],
    imageAdapters: [{ estimatedCnyPerImage: 2, adapter: {
      providerId: "seedream-image-v1",
      generate: async () => {
        count += 1;
        events.push(`generate-${count}`);
        return { providerId: "seedream-image-v1", taskId: `task-${count}`, imageUrl: `https://example.com/clip-${count}.png` };
      },
    } }],
    resolveHost: resolvePublicHost,
    fetch: async (url) => new Response("media-bytes", { headers: { "content-type": String(url).endsWith(".png") ? "image/png" : "video/mp4" } }),
  });
  const request = workerRequest(scriptPath, path.join(root, "attempt-1"), 3, 6);
  if (routed) {
    Object.assign(request.input, { directorPlanPath });
    Object.assign(request.parameters, { providerId: "ai-shot-router-v1", provider: "ai-router" });
  }
  return { root, worker, request, events, setVerdict: (value: typeof verdict) => { verdict = value; } };
}

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

async function runCraftedAssetPlan({
  asset = {},
  route = {},
  directorShot = {},
}: {
  asset?: Record<string, unknown>;
  route?: Record<string, unknown>;
  directorShot?: Record<string, unknown>;
}): Promise<WorkerResponse> {
  const root = await mkdtemp(path.join(tmpdir(), "video-factory-generative-card-guard-"));
  const scriptPath = path.join(root, "script.json");
  const directorPlanPath = path.join(root, "director_plan.json");
  const mediaPath = path.join(root, "scene_01.png");
  const planPath = path.join(root, "asset_plan.json");
  await writeFile(scriptPath, JSON.stringify({ scenes: [
    { position: 1, duration: 4, visual_strategy: "stock", visual_prompt: "必须使用真实图库画面" },
  ] }));
  await writeFile(directorPlanPath, JSON.stringify({ shots: [{
    scenePosition: 1,
    preferredProviderId: "pexels-stock-v1",
    deliveryType: "stock_video",
    query: "real stock footage",
    ...directorShot,
  }] }));
  await writeFile(mediaPath, "asset bytes");
  await writeFile(planPath, JSON.stringify({
    scene_assets: [{
      ...localAsset(1, mediaPath),
      provider: "pexels",
      source_url: "https://pexels.example/asset",
      ...asset,
    }],
    director_routing: [{
      scene_position: 1,
      preferred_provider_id: "pexels-stock-v1",
      actual_provider_id: "pexels-stock-v1",
      actual_provider: "pexels",
      generation_pending: false,
      ...route,
    }],
  }));
  const subject = new GenerativeAssetWorkerClient({
    fallback: {
      run: async (): Promise<WorkerResponse> => ({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        commandId: "command-routed",
        status: "succeeded",
        output: { assetPlanPath: planPath },
        artifacts: [],
      }),
    },
    adapters: [],
  });
  return subject.run(routedWorkerRequest(scriptPath, directorPlanPath, path.join(root, "attempt-1"), 0, 0));
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

describe("reworkAffectedScenePositions", () => {
  const scene = (position: number, narration = `第${position}幕`) => ({
    position,
    narration,
    duration: 4,
    visual_strategy: "generated",
    visual_prompt: `scene ${position}`,
  });
  const finding = (scenePosition: number | undefined, targetNodeIds: string[] = ["visual-direction", "assets"]) => ({
    findingId: `vf_${String(scenePosition ?? 0).padStart(24, "0")}`.slice(0, 27),
    timecodeMs: 1_000,
    ...(scenePosition === undefined ? {} : { scenePosition }),
    category: "continuity",
    description: "画面问题。",
    suggestion: "修复。",
    targetNodeIds,
  });

  it("expands reference and REUSE_ONLY dependents into the director-facing affected closure", () => {
    const positions = reworkAffectedScenePositions({
      findings: [finding(1)],
      previousScenes: [scene(1), scene(2), scene(3)],
      previousShots: [
        { scenePosition: 1 },
        { scenePosition: 2, referenceFromScenePosition: 1 },
        { scenePosition: 3, query: "REUSE_ONLY scene 2" },
      ],
      currentScenes: [scene(1), scene(2), scene(3)],
      affectedScenePositions: [1],
    });
    assert.deepEqual(positions, [1, 2, 3]);
  });

  it("merges visual findings with script-only scene changes before the director runs", () => {
    const positions = reworkAffectedScenePositions({
      findings: [finding(2, ["visual-direction"])],
      previousScenes: [scene(1), scene(2), scene(3), scene(4)],
      currentScenes: [scene(1), scene(2), scene(3), scene(4, "重写后的第四幕")],
      affectedScenePositions: [],
    });
    assert.deepEqual(positions, [2, 4]);
  });

  it("falls back to every current scene when a visual or asset finding cannot be located", () => {
    const positions = reworkAffectedScenePositions({
      findings: [finding(undefined)],
      previousScenes: [scene(1), scene(2)],
      currentScenes: [scene(1), scene(2)],
      affectedScenePositions: [],
    });
    assert.deepEqual(positions, [1, 2]);
  });

  it("falls back to every current scene when a legacy run lacks a structured scope", () => {
    const scenes = Array.from({ length: 8 }, (_, index) => scene(index + 1));
    const positions = reworkAffectedScenePositions({
      findings: [],
      previousScenes: scenes,
      currentScenes: scenes.map((entry) => structuredClone(entry)),
    });
    assert.deepEqual(positions, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("keeps Studio-generated technical-failure instructions inside their structured scene scope", () => {
    const scenes = [scene(1), scene(2), scene(3), scene(4)];
    const positions = reworkAffectedScenePositions({
      findings: [],
      previousScenes: scenes,
      currentScenes: scenes.map((entry) => structuredClone(entry)),
      affectedScenePositions: [3],
    });
    assert.deepEqual(positions, [3]);
  });

  it("treats an explicit scene selection as authoritative while preserving canonical safety expansion", () => {
    const scenes = [scene(1), scene(2), scene(3), scene(4)];
    const selected = (affectedScenePositions: number[], overrides: Record<string, unknown> = {}) => (
      reworkAffectedScenePositions({
        findings: [],
        previousScenes: scenes,
        currentScenes: scenes.map((entry) => structuredClone(entry)),
        affectedScenePositions,
        ...overrides,
      })
    );

    assert.deepEqual(selected([4]), [4]);
    assert.deepEqual(selected([]), []);
    assert.deepEqual(selected([4], { findings: [finding(2)] }), [2, 4]);
    assert.deepEqual(selected([4], { findings: [finding(undefined)] }), [1, 2, 3, 4]);
    assert.deepEqual(selected([4], {
      currentScenes: [scene(1), scene(2), scene(3, "重写后的第三幕"), scene(4)],
    }), [3, 4]);
    assert.deepEqual(selected([1], {
      currentShots: [
        { scenePosition: 1 },
        { scenePosition: 2, referenceFromScenePosition: 1 },
        { scenePosition: 3, query: "REUSE_ONLY scene 2" },
        { scenePosition: 4 },
      ],
    }), [1, 2, 3]);
  });

});
