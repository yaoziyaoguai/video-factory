import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { WorkflowRun } from "@video-factory/workflow-core";
import type { ProductionBrief } from "@video-factory/production-pipeline";
import { ResourceGovernanceStudio } from "../src/server/resource-governance-studio.js";
import { StudioInputError } from "../src/shared/api.js";

describe("ResourceGovernanceStudio", () => {
  it("preserves Unsplash credits and CDN previews through the persisted manifest and asset index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-unsplash-rights-"));
    const manifestPath = path.join(root, "resource_manifest.json");
    const creatorUrl = "https://unsplash.com/@photographer?utm_source=videofactory&utm_medium=referral";
    const previewUrl = "https://images.unsplash.com/photo-1?w=400&ixid=view";
    await writeFile(manifestPath, JSON.stringify({ version: "video-factory/resource-manifest-v1", runId: "run-1", items: [{
      id: "scene:1:unsplash-stock-v1", category: "visual", kind: "stock_image", providerId: "unsplash-stock-v1",
      creator: "Photographer", creatorUrl, previewUrl, sourceUrl: "https://unsplash.com/photos/photo-1",
      sha256: "c".repeat(64), licenseNote: "Unsplash License; third-party rights require review.",
      commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "recorded",
    }] }));
    const studio = new ResourceGovernanceStudio(root, async () => [completedRun(manifestPath)]);
    const manifest = await studio.manifest();
    assert.equal(manifest.items[0]?.creatorUrl, creatorUrl);
    assert.equal(manifest.assetIndex.assets[0]?.previewUrl, previewUrl);
    assert.equal(manifest.assetIndex.assets[0]?.usages[0]?.creatorUrl, creatorUrl);
    assert.equal(manifest.assetIndex.assets[0]?.origin, "stock");
  });
  it("aggregates persisted resource manifests and evidence-based template scorecards", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-1",
      items: [{
        id: "scene:1:pexels-stock-v1",
        category: "visual",
        kind: "stock_video",
        providerId: "pexels-stock-v1",
        sourceUrl: "https://www.pexels.com/video/1",
        creator: "Creator",
        licenseNote: "Review provider terms.",
        contentType: "video/mp4",
        sha256: "b".repeat(64),
        scenePosition: 1,
        width: 1080,
        height: 1920,
        durationSeconds: 6,
        query: "Chinese office worker night",
        semanticTags: ["夜晚", "上班族"],
        selectedInFinal: true,
        commercialUse: "provider_terms",
        attributionRequirement: "provider_terms",
        reviewStatus: "recorded",
      }],
    }));
    const run = completedRun(manifestPath);
    let publishedTemplates = [
      { id: "knowledge-explainer", name: "知识解释" },
      { id: "custom-workflow", name: "自定义工作流" },
    ];
    const studio = new ResourceGovernanceStudio(
      workspaceRoot,
      async () => [run],
      () => new Date("2026-08-28T12:00:00.000Z"),
      undefined,
      async () => publishedTemplates,
    );

    const manifest = await studio.manifest();
    assert.equal(manifest.totalItems, 1);
    assert.equal(manifest.reconstructedRunCount, 0);
    assert.equal(manifest.unreadableManifestCount, 0);
    assert.equal(manifest.truncatedRunCount, 0);
    assert.equal(manifest.truncatedItemCount, 0);
    assert.equal(manifest.categories.visual, 1);
    assert.equal(manifest.items[0]?.runTitle, "知识解释样本");
    assert.equal(manifest.items[0]?.sourceUrl, "https://www.pexels.com/video/1");
    assert.equal(manifest.assetIndex.version, "video-factory/asset-index-v1");
    assert.equal(manifest.assetIndex.totalAssets, 1);
    assert.equal(manifest.assetIndex.reusableCount, 1);
    assert.equal(manifest.assetIndex.assets[0]?.key, `sha256:${"b".repeat(64)}`);
    assert.equal(manifest.assetIndex.assets[0]?.mediaKind, "video");
    assert.equal(manifest.assetIndex.assets[0]?.origin, "stock");
    assert.equal(manifest.assetIndex.assets[0]?.aspectRatio, "9:16");
    assert.equal(manifest.assetIndex.assets[0]?.usages[0]?.scenePosition, 1);
    assert.equal(manifest.assetIndex.assets[0]?.tags.includes("上班族"), true);
    assert.equal(manifest.assetIndex.assets[0]?.tags.includes("stock_video"), false);
    assert.equal(manifest.assetIndex.assets[0]?.tags.includes("pexels-stock-v1"), false);

    const scorecards = await studio.templateExperiments();
    assert.deepEqual(scorecards.map((item) => item.templateId), ["knowledge-explainer", "custom-workflow"]);
    const knowledge = scorecards.find((item) => item.templateId === "knowledge-explainer");
    assert.equal(knowledge?.sampleSize, 1);
    assert.equal(knowledge?.metrics.narrativeCompleteness, 100);
    assert.equal(knowledge?.metrics.visualMatch, 80);
    assert.equal(knowledge?.metrics.manualEditCount, 1);
    assert.equal(knowledge?.metrics.hookClarity, null);
    assert.equal(knowledge?.metrics.costEfficiency, null);
    assert.equal(knowledge?.metrics.finalApprovalRate, 100);
    assert.equal(scorecards.find((item) => item.templateId === "custom-workflow")?.sampleSize, 0);

    publishedTemplates = [{ id: "custom-workflow", name: "自定义工作流" }];
    assert.deepEqual((await studio.templateExperiments()).map((item) => item.templateId), ["custom-workflow"]);
  });

  it("persists revision-protected review decisions without changing the source manifest", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resource-reviews-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-1",
      items: [{ id: "asset-1", category: "visual", kind: "media_asset", providerId: "seedream-image-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" }],
    }));
    const run = completedRun(manifestPath);
    const first = new ResourceGovernanceStudio(workspaceRoot, async () => [run]);
    await assert.rejects(
      () => first.review({ runId: "run-1", itemId: "asset-1", expectedRevision: 0, action: "rejected" }, "owner"),
      (error: unknown) => error instanceof StudioInputError && /填写原因/.test(error.message),
    );
    const confirmed = await first.review({ runId: "run-1", itemId: "asset-1", expectedRevision: 0, action: "confirmed" }, "owner");
    assert.equal(confirmed.reviewRevision, 1);
    assert.equal(confirmed.needsReviewCount, 0);
    assert.equal(confirmed.items[0]?.reviewDecision?.action, "confirmed");
    assert.match(await readFile(manifestPath, "utf8"), /"reviewStatus":"needs_review"/);

    const restarted = new ResourceGovernanceStudio(workspaceRoot, async () => [run]);
    assert.equal((await restarted.manifest()).items[0]?.reviewStatus, "recorded");
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-1",
      items: [{ id: "asset-1", category: "visual", kind: "media_asset", providerId: "seedream-image-v1", licenseNote: "授权条件已变化", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" }],
    }));
    assert.equal((await restarted.manifest()).items[0]?.reviewStatus, "needs_review");
    assert.equal((await restarted.manifest()).items[0]?.reviewDecision, undefined);
    const attempts = await Promise.allSettled([
      restarted.review({ runId: "run-1", itemId: "asset-1", expectedRevision: 1, action: "rejected", note: "来源不满足商用要求" }, "owner-a"),
      new ResourceGovernanceStudio(workspaceRoot, async () => [run]).review({ runId: "run-1", itemId: "asset-1", expectedRevision: 1, action: "confirmed" }, "owner-b"),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  });

  it("keeps test runs out of production template learning", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-template-purpose-"));
    const production = completedRun(path.join(workspaceRoot, "production.json"), "run-production");
    const testRun = completedRun(path.join(workspaceRoot, "test.json"), "run-test", "自动化验收记录");
    testRun.initialInput.runPurpose = "test";
    const studio = new ResourceGovernanceStudio(
      workspaceRoot,
      async () => [production, testRun],
      undefined,
      undefined,
      async () => [{ id: "knowledge-explainer", name: "知识解释" }],
    );

    const scorecard = (await studio.templateExperiments())[0];

    assert.equal(scorecard?.sampleSize, 1);
    assert.equal(scorecard?.metrics.finalApprovalRate, 100);
  });

  it("deduplicates review work across reworks and inherits the latest matching decision", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resource-review-rework-"));
    const digest = "e".repeat(64);
    const runs = await Promise.all([1, 2, 3].map(async (number) => {
      const manifestPath = path.join(workspaceRoot, `resource_manifest_${number}.json`);
      await writeFile(manifestPath, JSON.stringify({
        version: "video-factory/resource-manifest-v1",
        runId: `run-${number}`,
        items: [{
          id: `scene:${number}:seedream-image-v1`,
          category: "visual",
          kind: "generated_image",
          providerId: "seedream-image-v1",
          sourceUrl: "https://provider.example/jobs/shared-asset",
          licenseNote: "Provider output terms apply.",
          contentType: "image/png",
          sha256: digest,
          scenePosition: number,
          commercialUse: "provider_terms",
          attributionRequirement: "provider_terms",
          reviewStatus: "needs_review",
        }],
      }));
      return completedRun(manifestPath, `run-${number}`, `返工作品 ${number}`);
    }));
    const studio = new ResourceGovernanceStudio(
      workspaceRoot,
      async () => runs,
      () => new Date("2026-09-07T10:00:00.000Z"),
    );

    const beforeReview = await studio.manifest();
    assert.equal(beforeReview.items.length, 3);
    assert.equal(beforeReview.needsReviewCount, 1);
    assert.deepEqual(beforeReview.needsReviewItems?.map((item) => item.runId), ["run-1"]);

    const rejected = await studio.review({
      runId: "run-1",
      itemId: "scene:1:seedream-image-v1",
      expectedRevision: 0,
      action: "rejected",
      note: "授权条件不满足发布要求",
    }, "owner-a");
    assert.equal(rejected.needsReviewCount, 0);
    assert.equal(rejected.needsReviewItems?.length, 0);
    assert.equal(rejected.assetIndex.needsReviewCount, 0);
    assert.equal(rejected.assetIndex.assets[0]?.reuseStatus, "not_reusable");
    assert.ok(rejected.items.every((item) => item.reviewDecision?.action === "rejected"));

    const confirmed = await new ResourceGovernanceStudio(
      workspaceRoot,
      async () => runs,
      () => new Date("2026-09-07T11:00:00.000Z"),
    ).review({
      runId: "run-2",
      itemId: "scene:2:seedream-image-v1",
      expectedRevision: 1,
      action: "confirmed",
    }, "owner-b");
    assert.equal(confirmed.needsReviewCount, 0);
    assert.equal(confirmed.items.find((item) => item.runId === "run-1")?.reviewDecision?.action, "rejected");
    assert.equal(confirmed.items.find((item) => item.runId === "run-2")?.reviewStatus, "recorded");
    assert.equal(confirmed.items.find((item) => item.runId === "run-3")?.reviewDecision?.reviewedBy, "owner-b");
  });

  it("holds the production lease while recording a resource rejection and exposes it to rework", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resource-review-lease-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-1",
      items: [{ id: "scene:2:seedream", category: "visual", kind: "generated_image", providerId: "seedream-image-v1", creator: "第二镜生成图", scenePosition: 2, commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" }],
    }));
    let leasedRunId: string | undefined;
    let leaseActive = false;
    let requireLease = true;
    const studio = new ResourceGovernanceStudio(
      workspaceRoot,
      async () => {
        if (requireLease) assert.equal(leaseActive, true);
        return [completedRun(manifestPath)];
      },
      () => new Date("2026-09-05T00:00:00.000Z"),
      async (runId, action) => {
        leasedRunId = runId;
        leaseActive = true;
        try { return await action(); } finally { leaseActive = false; }
      },
    );

    await studio.review({ runId: "run-1", itemId: "scene:2:seedream", expectedRevision: 0, action: "rejected", note: "人物肖像授权不明确" }, "owner");
    requireLease = false;
    const rejected = await studio.rejectedVisualItems("run-1");

    assert.equal(leasedRunId, "run-1");
    assert.deepEqual(rejected, [{ itemId: "scene:2:seedream", providerId: "seedream-image-v1", label: "第二镜生成图", note: "人物肖像授权不明确", scenePosition: 2 }]);
  });

  it("keeps every pending review reachable beyond the 500-item detail window", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resource-review-window-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    const items = Array.from({ length: 501 }, (_, index) => ({ id: `asset-${index}`, category: "visual", kind: "media_asset", providerId: "seedream-image-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" }));
    await writeFile(manifestPath, JSON.stringify({ version: "video-factory/resource-manifest-v1", runId: "run-1", items }));
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [completedRun(manifestPath)]);

    const manifest = await studio.manifest();
    assert.equal(manifest.items.length, 501);
    assert.equal(manifest.truncatedItemCount, 0);
    assert.equal(await studio.needsReviewCount("run-1"), 501);
    await studio.review({ runId: "run-1", itemId: "asset-500", expectedRevision: 0, action: "confirmed" }, "owner");
    assert.equal(await studio.needsReviewCount("run-1"), 500);
  });

  it("fails closed when a persisted review decision is malformed", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resource-review-invalid-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-1",
      items: [{ id: "asset-1", category: "visual", kind: "media_asset", providerId: "seedream-image-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" }],
    }));
    await mkdir(path.join(workspaceRoot, "resource-governance"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "resource-governance", "reviews.json"), JSON.stringify({
      version: 1,
      revision: 1,
      decisions: { "run-1\u0000asset-1": { action: "confirmed" } },
    }));
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [completedRun(manifestPath)]);

    await assert.rejects(() => studio.manifest(), /授权审核账本格式无效/);
  });

  it("does not count stale review evidence or an invalidated historical approval", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    await writeFile(manifestPath, JSON.stringify({ version: "video-factory/resource-manifest-v1", runId: "run-1", items: [] }));
    const run = completedRun(manifestPath);
    run.status = "stale";
    run.nodeRuns = run.nodeRuns.map((node) => node.nodeId === "visual-review"
      ? { ...node, status: "stale", outputState: { ...node.outputState!, stale: true } }
      : node.nodeId === "final-review" ? { ...node, status: "stale" } : node);
    const studio = new ResourceGovernanceStudio(
      workspaceRoot,
      async () => [run],
      undefined,
      undefined,
      async () => [{ id: "knowledge-explainer", name: "知识解释" }],
    );

    const scorecard = (await studio.templateExperiments()).find((item) => item.templateId === "knowledge-explainer");

    assert.equal(scorecard?.metrics.visualMatch, null);
    assert.equal(scorecard?.metrics.finalApprovalRate, null);
  });

  it("uses only decided final reviews as the final approval rate denominator", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-template-review-rate-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    await writeFile(manifestPath, JSON.stringify({ version: "video-factory/resource-manifest-v1", runId: "approved", items: [] }));
    const approved = completedRun(manifestPath, "approved");
    const rejected = completedRun(manifestPath, "rejected");
    rejected.status = "rejected";
    rejected.nodeRuns = rejected.nodeRuns.map((node) => node.nodeId === "final-review"
      ? { ...node, status: "rejected" }
      : node);
    rejected.decisions = rejected.decisions.map((decision) => ({ ...decision, action: "reject" }));
    const undecided = completedRun(manifestPath, "undecided");
    undecided.status = "running";
    undecided.nodeRuns = undecided.nodeRuns.map((node) => node.nodeId === "final-review"
      ? { ...node, status: "pending" }
      : node);
    undecided.interventions = [];
    undecided.decisions = [];
    const sourceRejected = completedRun(manifestPath, "source-rejected");
    const sourceIntervention = {
      id: "source-intervention",
      nodeId: "asset-source-review",
      reason: "来源不适合入片",
      requiredAction: "approve" as const,
      options: ["approve", "reject"] as Array<"approve" | "reject">,
      createdAt: "2026-08-28T10:00:20.000Z",
    };
    sourceRejected.status = "rejected";
    sourceRejected.nodeRuns = [{
      nodeId: "asset-source-review",
      status: "rejected",
      startedAt: sourceIntervention.createdAt,
      finishedAt: "2026-08-28T10:00:25.000Z",
      artifactIds: [],
      qualityGateResults: [],
      intervention: sourceIntervention,
    }];
    sourceRejected.interventions = [sourceIntervention];
    sourceRejected.decisions = [{
      id: "source-decision",
      interventionId: sourceIntervention.id,
      action: "reject",
      actor: "owner",
      createdAt: "2026-08-28T10:00:25.000Z",
    }];
    const studio = new ResourceGovernanceStudio(
      workspaceRoot,
      async () => [approved, rejected, undecided, sourceRejected],
      undefined,
      undefined,
      async () => [{ id: "knowledge-explainer", name: "知识解释" }],
    );

    const scorecard = (await studio.templateExperiments())[0];

    assert.equal(scorecard?.sampleSize, 4);
    assert.equal(scorecard?.metrics.finalApprovalRate, 50);
  });

  it("isolates an untrusted manifest without hiding healthy runs", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "video-factory-outside-"));
    const manifestPath = path.join(outsideRoot, "resource_manifest.json");
    await writeFile(manifestPath, JSON.stringify({ version: "video-factory/resource-manifest-v1", runId: "run-1", items: [] }));
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [completedRun(manifestPath)]);

    const manifest = await studio.manifest();
    assert.equal(manifest.totalItems, 0);
    assert.equal(manifest.unreadableManifestCount, 1);
  });

  it("isolates a corrupt in-workspace manifest", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest.json");
    await writeFile(manifestPath, "{truncated");
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [completedRun(manifestPath)]);

    const manifest = await studio.manifest();
    assert.equal(manifest.totalItems, 0);
    assert.equal(manifest.unreadableManifestCount, 1);
  });

  it("recovers rights evidence from a failed metered run without turning every artifact into review work", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const run = completedRun(path.join(workspaceRoot, "missing-manifest.json"));
    run.status = "failed";
    run.artifacts = [
      {
        id: "paid-video-1",
        kind: "media_asset",
        uri: path.join(workspaceRoot, "nodes", "assets", "attempt-1", "scene_07_seedance-video-v1.mp4"),
        createdAt: "2026-08-28T10:00:30.000Z",
        contentType: "video/mp4",
        sha256: "a".repeat(64),
        producer: { nodeId: "assets", attempt: 1 },
        provenance: { providerId: "seedance-video-v1", licenseNote: "Provider output terms apply." },
      },
      {
        id: "final-render",
        kind: "render",
        uri: path.join(workspaceRoot, "render.mp4"),
        createdAt: "2026-08-28T10:00:31.000Z",
        contentType: "video/mp4",
        sha256: "b".repeat(64),
        producer: { nodeId: "render", attempt: 1 },
        provenance: { providerId: "python-ffmpeg-v1" },
      },
      {
        id: "local-visual",
        kind: "media_asset",
        uri: path.join(workspaceRoot, "local.png"),
        createdAt: "2026-08-28T10:00:32.000Z",
        contentType: "image/png",
        sha256: "c".repeat(64),
        producer: { nodeId: "assets", attempt: 1 },
        provenance: { providerId: "local-editorial-v1" },
      },
      {
        id: "creator-reference",
        kind: "reference_video",
        uri: path.join(workspaceRoot, "reference.mp4"),
        createdAt: "2026-08-28T10:00:33.000Z",
        contentType: "video/mp4",
        sha256: "d".repeat(64),
        provenance: { providerId: "creator-upload", licenseNote: "Uploaded by creator." },
      },
      {
        id: "manual-replacement",
        kind: "human_media_revision",
        uri: path.join(workspaceRoot, "replacement.png"),
        createdAt: "2026-08-28T10:00:34.000Z",
        contentType: "image/png",
        sha256: "e".repeat(64),
        producer: { nodeId: "assets", attempt: 1 },
        provenance: { providerId: "human-editor", licenseNote: "Human-selected replacement." },
      },
      {
        id: "missing-evidence",
        kind: "media_asset",
        uri: path.join(workspaceRoot, "unknown.png"),
        createdAt: "2026-08-28T10:00:35.000Z",
        contentType: "image/png",
        sha256: "f".repeat(64),
        producer: { nodeId: "assets", attempt: 1 },
        provenance: { providerId: "unverified-media" },
      },
    ];
    run.executionReceipts = [{
      id: "receipt-paid-1",
      nodeId: "assets",
      capability: "asset.prepare",
      providerId: "seedance-video-v1",
      modelId: "doubao-seedance-2-5-260628",
      billing: "metered",
      status: "failed",
      startedAt: "2026-08-28T10:00:20.000Z",
      finishedAt: "2026-08-28T10:00:31.000Z",
      estimatedCostCny: 2.4,
      actualCostCny: 2.4,
      actualCostSource: "configured_rate",
    }];
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [run]);

    const manifest = await studio.manifest();

    assert.equal(manifest.reconstructedRunCount, 1);
    assert.equal(manifest.legacyRunsWithoutManifest, 0);
    assert.equal(manifest.totalItems, 6);
    assert.equal(manifest.needsReviewCount, 3);
    assert.deepEqual(manifest.needsReviewItems?.map((item) => item.id), [
      "reconstructed:creator-reference",
      "reconstructed:manual-replacement",
      "reconstructed:missing-evidence",
    ]);
    assert.equal(manifest.items.find((item) => item.id === "reconstructed:paid-video-1")?.reviewStatus, "recorded");
    assert.equal(manifest.items.find((item) => item.id === "reconstructed:final-render")?.commercialUse, "self_owned");
    assert.equal(manifest.items.find((item) => item.id === "reconstructed:local-visual")?.reviewStatus, "recorded");
    assert.equal(manifest.items.find((item) => item.id === "reconstructed:creator-reference")?.reviewStatus, "needs_review");
    assert.equal(manifest.items.find((item) => item.id === "reconstructed:manual-replacement")?.reviewStatus, "needs_review");
    assert.equal(manifest.items.find((item) => item.id === "reconstructed:missing-evidence")?.reviewStatus, "needs_review");
    assert.equal(manifest.items.find((item) => item.id === "reconstructed:paid-video-1")?.scenePosition, 7);
    assert.equal(manifest.assetIndex.assets.find((item) => item.sha256 === "a".repeat(64))?.usages[0]?.scenePosition, 7);
  });

  it("recovers a legacy manifest scene from its explicit item identity without numbering unrelated items", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const manifestPath = path.join(workspaceRoot, "legacy-resource-manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-legacy",
      items: [
        { id: "scene:6:pexels-stock-v1", category: "visual", kind: "scene_video", providerId: "pexels-stock-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" },
        { id: "artifact:unlocated", category: "visual", kind: "media_asset", providerId: "pexels-stock-v1", commercialUse: "provider_terms", attributionRequirement: "provider_terms", reviewStatus: "needs_review" },
      ],
    }));
    const studio = new ResourceGovernanceStudio(
      workspaceRoot,
      async () => [completedRun(manifestPath, "run-legacy", "旧制作")],
    );

    const manifest = await studio.manifest();

    assert.equal(manifest.items.find((item) => item.id.startsWith("scene:"))?.scenePosition, 6);
    assert.equal(manifest.items.find((item) => item.id === "artifact:unlocated")?.scenePosition, undefined);
  });

  it("deduplicates the same content across runs while retaining every usage", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const digest = "c".repeat(64);
    const manifests = await Promise.all([1, 2].map(async (number) => {
      const manifestPath = path.join(workspaceRoot, `resource_manifest_${number}.json`);
      await writeFile(manifestPath, JSON.stringify({
        version: "video-factory/resource-manifest-v1",
        runId: `run-${number}`,
        items: [{
          id: `scene:${number}:pexels-stock-v1`,
          category: "visual",
          kind: "scene_video",
          providerId: number === 1 ? "pexels-stock-v1" : "human-editor",
          ...(number === 1 ? { sourceUrl: "https://www.pexels.com/video/42" } : {}),
          contentType: "video/mp4",
          sha256: digest,
          scenePosition: number,
          selectedInFinal: true,
          commercialUse: number === 1 ? "provider_terms" : "review_required",
          attributionRequirement: number === 1 ? "provider_terms" : "unknown",
          reviewStatus: number === 1 ? "recorded" : "needs_review",
        }],
      }));
      return completedRun(manifestPath, `run-${number}`, `作品 ${number}`);
    }));
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => manifests);

    const manifest = await studio.manifest();

    assert.equal(manifest.totalItems, 2);
    assert.equal(manifest.assetIndex.totalAssets, 1);
    assert.equal(manifest.assetIndex.duplicateUses, 1);
    assert.equal(manifest.assetIndex.assets[0]?.useCount, 2);
    assert.equal(manifest.assetIndex.assets[0]?.providerId, "multiple");
    assert.equal(manifest.assetIndex.assets[0]?.commercialUse, "review_required");
    assert.equal(manifest.assetIndex.assets[0]?.attributionRequirement, "unknown");
    assert.equal(manifest.assetIndex.assets[0]?.reviewStatus, "needs_review");
    assert.equal(manifest.assetIndex.assets[0]?.reuseStatus, "review_required");
    assert.deepEqual(manifest.assetIndex.assets[0]?.usages.map((usage) => [usage.runTitle, usage.scenePosition]), [["作品 1", 1], ["作品 2", 2]]);
    assert.deepEqual(manifest.assetIndex.assets[0]?.usages.map((usage) => usage.providerId), ["pexels-stock-v1", "human-editor"]);
  });

  it("keeps a SHA provenance conflict permanent across later matching sources", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const digest = "d".repeat(64);
    const sources = ["https://source.example/a", "https://source.example/b", "https://source.example/a"];
    const runs = await Promise.all(sources.map(async (sourceUrl, index) => {
      const number = index + 1;
      const manifestPath = path.join(workspaceRoot, `conflict_${number}.json`);
      await writeFile(manifestPath, JSON.stringify({
        version: "video-factory/resource-manifest-v1",
        runId: `run-conflict-${number}`,
        items: [{
          id: `scene:${number}:stock`,
          category: "visual",
          kind: "scene_video",
          providerId: "stock-provider",
          sourceUrl,
          licenseNote: `License record ${number}`,
          contentType: "video/mp4",
          sha256: digest,
          scenePosition: number,
          selectedInFinal: true,
          commercialUse: "provider_terms",
          attributionRequirement: "provider_terms",
          reviewStatus: "recorded",
        }],
      }));
      return completedRun(manifestPath, `run-conflict-${number}`, `冲突作品 ${number}`);
    }));
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => runs);

    const asset = (await studio.manifest()).assetIndex.assets[0];

    assert.equal(asset?.provenanceConflict, true);
    assert.equal(asset?.sourceUrl, undefined);
    assert.equal(asset?.reviewStatus, "needs_review");
    assert.equal(asset?.reuseStatus, "review_required");
    assert.deepEqual(asset?.usages.map((usage) => usage.sourceUrl), sources);
    assert.deepEqual(asset?.usages.map((usage) => usage.licenseNote), ["License record 1", "License record 2", "License record 3"]);
  });

  it("builds the searchable index from all records even when the legacy detail list is truncated", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const manifestPath = path.join(workspaceRoot, "resource_manifest_large.json");
    await writeFile(manifestPath, JSON.stringify({
      version: "video-factory/resource-manifest-v1",
      runId: "run-large",
      items: Array.from({ length: 501 }, (_, index) => ({
        id: `scene:${index + 1}:pexels-stock-v1`,
        category: "visual",
        kind: "scene_video",
        providerId: "pexels-stock-v1",
        sourceUrl: `https://www.pexels.com/video/${index + 1}`,
        contentType: "video/mp4",
        sha256: index.toString(16).padStart(64, "0"),
        scenePosition: index + 1,
        commercialUse: "provider_terms",
        attributionRequirement: "provider_terms",
        reviewStatus: "recorded",
      })),
    }));
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [completedRun(manifestPath, "run-large")]);

    const manifest = await studio.manifest();

    assert.equal(manifest.totalItems, 501);
    assert.equal(manifest.items.length, 500);
    assert.equal(manifest.truncatedItemCount, 1);
    assert.equal(manifest.assetIndex.totalAssets, 501);
  });
});

function completedRun(manifestPath: string, runId = "run-1", title = "知识解释样本"): WorkflowRun<ProductionBrief> {
  return {
    id: runId,
    revision: 1,
    workflowId: "daily-production",
    workflowVersion: "1.4.0",
    status: "succeeded",
    startedAt: "2026-08-28T10:00:00.000Z",
    finishedAt: "2026-08-28T10:01:00.000Z",
    initialInput: {
      protocolVersion: "video-factory/brief-v1",
      title,
      angle: "解释一个问题",
      audience: "创作者",
      nicheSlug: "knowledge",
      durationSeconds: 24,
      platform: "douyin",
      reviewMode: "manual",
      providers: { script: "python-template-v1", assets: "local-editorial-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
      templateSnapshot: {
        templateId: "knowledge-explainer",
        templateVersion: 1,
        resolvedAt: "2026-08-28T10:00:00.000Z",
        resolvedBlueprint: {
          platform: "douyin", durationSeconds: 24, automationLevel: "assisted",
          storyStructure: [{ id: "hook", label: "开场", purpose: "抓住注意", required: true }],
          shotSlots: [{ id: "shot", beatId: "hook", purpose: "开场", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true }],
          visualSystem: { composition: "清晰", colorIntent: "自然", subtitleDensity: "medium", pacing: "measured" },
          soundSystem: { voiceIntent: "可信", pace: "medium", musicIntent: "克制" },
          qualityRules: [{ id: "facts", label: "事实", dimension: "factual", required: true, threshold: 80 }],
          capabilityRequirements: [{ capability: "script.draft", required: true }],
        },
        sourceLayers: [], fieldSources: {},
      },
      economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    },
    nodeRuns: [
      { nodeId: "render", status: "succeeded", startedAt: "2026-08-28T10:00:30.000Z", artifactIds: [], qualityGateResults: [] },
      { nodeId: "visual-review", status: "succeeded", startedAt: "2026-08-28T10:00:40.000Z", artifactIds: [], qualityGateResults: [], output: { scores: { composition: 85, continuity: 75 } }, outputState: { nodeId: "visual-review", generatedVersionId: "output-1", effectiveVersionId: "output-2", stale: false, versions: [{ id: "output-1", nodeId: "visual-review", source: "generated", artifactIds: [], inputVersionIds: [], createdAt: "2026-08-28T10:00:40.000Z", createdBy: "model", schemaVersion: "1" }, { id: "output-2", nodeId: "visual-review", source: "human", artifactIds: [], inputVersionIds: [], createdAt: "2026-08-28T10:00:45.000Z", createdBy: "owner", schemaVersion: "1" }] } },
      { nodeId: "final-review", status: "succeeded", startedAt: "2026-08-28T10:00:50.000Z", artifactIds: [], qualityGateResults: [] },
    ],
    artifacts: [{ id: "manifest-1", kind: "resource_manifest", uri: manifestPath, createdAt: "2026-08-28T10:01:00.000Z", provenance: { providerId: "video-factory-ts-v1" } }],
    interventions: [{ id: "intervention-1", nodeId: "final-review", reason: "请确认成片", requiredAction: "approve", options: ["approve", "reject"], createdAt: "2026-08-28T10:00:49.000Z" }],
    decisions: [{ id: "decision-1", interventionId: "intervention-1", action: "approve", actor: "owner", createdAt: "2026-08-28T10:00:50.000Z" }],
  };
}
