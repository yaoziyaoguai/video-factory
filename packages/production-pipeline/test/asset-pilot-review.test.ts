import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { SourceAssetPilotReviewer, type AssetPilotReviewInput } from "../src/asset-pilot-review.js";
import type { VisualReviewAgentInput } from "../src/codex-visual-review.js";

it("binds pilot approval to media, plan and reviewer, preserves scene identity and keeps traces private", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-pilot-cache-"));
  const requests: VisualReviewAgentInput[] = [];
  const reviewer = new SourceAssetPilotReviewer([{
    id: "reviewer", modelId: "model-a",
    review: async () => { throw new Error("must use detailed review"); },
    reviewDetailed: async (input) => {
      requests.push(input);
      await input.agentLoopCheckpoint!.save({ checkpoint: "saved" });
      return { output: {
        version: "video-factory/visual-review-v1", summary: "当前试片符合方案",
        scores: { composition: 95, continuity: 95, pacing: 95, legibility: 95, safety: 95 },
        findings: [], recommendation: "approve", confidence: 0.95,
      }, inspectedDurationMs: 4000 };
    },
  }]);
  const input: AssetPilotReviewInput = {
    runRoot: root, outputDir: root, scriptPath: path.join(root, "script.json"),
    assetPlanPath: path.join(root, "asset_plan.json"), directorPlanPath: path.join(root, "director.json"),
    scenePosition: 3, inputFingerprint: "plan-a", mediaSha256: "a".repeat(64),
    reviewProviderId: "reviewer", reviewModelId: "model-a",
  };
  const first = await reviewer.review(input);
  await reviewer.review(input);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.scenePositions, [3]);
  assert.equal(requests[0]!.reviewStage, "source_assets");
  assert.equal(first.execution.output.reviewScope?.reviewStage, "source_assets");
  assert.deepEqual(first.execution.output.reviewScope?.scenePositions, [3]);
  assert.equal(first.execution.output.reviewScope?.evidenceId, "a".repeat(64));
  assert.deepEqual(first.execution.output.reviewScope?.actualModels, [{ providerId: "reviewer", modelId: "model-a" }]);
  assert.deepEqual(await requests[0]!.agentLoopCheckpoint!.load(), { checkpoint: "saved" });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(first.reportPath, "utf8")), "execution"), false);
  await reviewer.review({ ...input, inputFingerprint: "plan-b" });
  await reviewer.review({ ...input, mediaSha256: "b".repeat(64) });
  await reviewer.review({ ...input, reviewModelId: "model-b" });
  assert.equal(requests.length, 4);
});

it("rejects findings outside the pilot before caching and can recover with a corrected report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-pilot-scope-"));
  let calls = 0;
  const reviewer = new SourceAssetPilotReviewer([{
    id: "reviewer", modelId: "model-a",
    review: async () => {
      calls += 1;
      return {
        version: "video-factory/visual-review-v1", summary: "试片需修改",
        scores: { composition: 70, continuity: 70, pacing: 70, legibility: 70, safety: 90 },
        findings: [{ timecodeMs: 100, startTimecodeMs: 100, endTimecodeMs: 100,
          scenePosition: calls === 1 ? 2 : 3, targetNodeId: "assets", evidenceStatus: "failed",
          evidenceFrameSha256: null, nextAction: "rework_asset",
          category: "continuity", severity: "warning", description: "灯位变化不连续", suggestion: "修改灯位移动过程" }],
        recommendation: "revise", confidence: 0.9,
      };
    },
  }]);
  const input: AssetPilotReviewInput = { runRoot: root, outputDir: root, scriptPath: "script.json",
    assetPlanPath: "assets.json", scenePosition: 3, inputFingerprint: "plan", mediaSha256: "a".repeat(64) };
  await assert.rejects(() => reviewer.review(input), /未检查镜头/);
  const [key] = await readdir(path.join(root, "asset-pilot-reviews"));
  await assert.rejects(() => readFile(path.join(root, "asset-pilot-reviews", key!, "review.json")), { code: "ENOENT" });
  const corrected = await reviewer.review(input);
  assert.equal(corrected.execution.output.findings[0]?.scenePosition, 3);
  await reviewer.review(input);
  assert.equal(calls, 2);
});
