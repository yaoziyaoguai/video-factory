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
    assert.equal(manifest.categories.visual, 1);
    assert.equal(manifest.items[0]?.runTitle, "知识解释样本");
    assert.equal(manifest.items[0]?.sourceUrl, "https://www.pexels.com/video/1");

    const scorecards = await studio.templateExperiments();
    const knowledge = scorecards.find((item) => item.templateId === "knowledge-explainer");
    assert.equal(knowledge?.sampleSize, 1);
    assert.equal(knowledge?.metrics.narrativeCompleteness, 100);
    assert.equal(knowledge?.metrics.visualMatch, 80);
    assert.equal(knowledge?.metrics.manualEditCount, 1);
    assert.equal(knowledge?.metrics.hookClarity, null);
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
});

function completedRun(manifestPath: string): WorkflowRun<ProductionBrief> {
  return {
    id: "run-1",
    revision: 1,
    workflowId: "daily-production",
    workflowVersion: "1.4.0",
    status: "succeeded",
    startedAt: "2026-08-28T10:00:00.000Z",
    finishedAt: "2026-08-28T10:01:00.000Z",
    initialInput: {
      protocolVersion: "video-factory/brief-v1",
      title: "知识解释样本",
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
          costPolicy: { currency: "CNY", maxCost: 0, maxPaidShots: 0 },
        },
        sourceLayers: [], fieldSources: {},
      },
      economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    },
    nodeRuns: [
      { nodeId: "render", status: "succeeded", startedAt: "2026-08-28T10:00:30.000Z", artifactIds: [], qualityGateResults: [] },
      { nodeId: "visual-review", status: "succeeded", startedAt: "2026-08-28T10:00:40.000Z", artifactIds: [], qualityGateResults: [], output: { scores: { composition: 85, continuity: 75 } }, outputState: { nodeId: "visual-review", generatedVersionId: "output-1", effectiveVersionId: "output-2", stale: false, versions: [{ id: "output-1", nodeId: "visual-review", source: "generated", artifactIds: [], inputVersionIds: [], createdAt: "2026-08-28T10:00:40.000Z", createdBy: "model", schemaVersion: "1" }, { id: "output-2", nodeId: "visual-review", source: "human", artifactIds: [], inputVersionIds: [], createdAt: "2026-08-28T10:00:45.000Z", createdBy: "owner", schemaVersion: "1" }] } },
    ],
    artifacts: [{ id: "manifest-1", kind: "resource_manifest", uri: manifestPath, createdAt: "2026-08-28T10:01:00.000Z", provenance: { providerId: "video-factory-ts-v1" } }],
    interventions: [],
    decisions: [{ id: "decision-1", interventionId: "intervention-1", action: "approve", actor: "owner", createdAt: "2026-08-28T10:00:50.000Z" }],
  };
}
