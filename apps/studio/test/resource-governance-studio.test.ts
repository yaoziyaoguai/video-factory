import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { WorkflowRun } from "@video-factory/workflow-core";
import type { ProductionBrief } from "@video-factory/production-pipeline";
import { ResourceGovernanceStudio } from "../src/server/resource-governance-studio.js";

describe("ResourceGovernanceStudio", () => {
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
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [run], () => new Date("2026-08-28T12:00:00.000Z"));

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
    const knowledge = scorecards.find((item) => item.templateId === "knowledge-explainer");
    assert.equal(knowledge?.sampleSize, 1);
    assert.equal(knowledge?.metrics.narrativeCompleteness, 100);
    assert.equal(knowledge?.metrics.visualMatch, 80);
    assert.equal(knowledge?.metrics.manualEditCount, 1);
    assert.equal(knowledge?.metrics.hookClarity, null);
    assert.equal(knowledge?.metrics.costEfficiency, null);
    assert.equal(knowledge?.metrics.finalApprovalRate, 100);
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
    const studio = new ResourceGovernanceStudio(workspaceRoot, async () => [run]);

    const scorecard = (await studio.templateExperiments()).find((item) => item.templateId === "knowledge-explainer");

    assert.equal(scorecard?.metrics.visualMatch, null);
    assert.equal(scorecard?.metrics.finalApprovalRate, 0);
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

  it("conservatively recovers visible resources from a failed metered run without a manifest", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-resources-"));
    const run = completedRun(path.join(workspaceRoot, "missing-manifest.json"));
    run.status = "failed";
    run.artifacts = [{
      id: "paid-video-1",
      kind: "media_asset",
      createdAt: "2026-08-28T10:00:30.000Z",
      contentType: "video/mp4",
      sha256: "a".repeat(64),
      producer: { nodeId: "assets", attempt: 1 },
      provenance: { providerId: "seedance-video-v1", licenseNote: "Provider output terms apply." },
    }];
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
    assert.equal(manifest.totalItems, 1);
    assert.equal(manifest.items[0]?.providerId, "seedance-video-v1");
    assert.equal(manifest.items[0]?.reviewStatus, "needs_review");
    assert.equal(manifest.items[0]?.commercialUse, "review_required");
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
