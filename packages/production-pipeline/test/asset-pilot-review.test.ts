import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { SourceAssetPilotReviewer, type AssetPilotReviewInput } from "../src/asset-pilot-review.js";
import { CodexVisualReviewAgent, type VisualReviewAgentInput, type VisualReviewMediaPayload } from "../src/codex-visual-review.js";

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
          scenePosition: calls === 1 ? 2 : 3, targetNodeId: "assets", claimType: "static", evidenceStatus: "failed",
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

// 试片是"要不要继续为同方案其余镜头付费"的闸门，所以它自己采的帧必须真的参与判定：
// 采样帧够不够判一条主张，规则与成片终审同源；否则模型可以把"我的采样不够"写成
// "作品不成立"，操作员照着重做一次付费素材。
it("judges a pilot claim against the frames the pilot itself sampled", async () => {
  const motionFailed = (description: string) => ({
    version: "video-factory/visual-review-v1", summary: description,
    scores: { composition: 60, continuity: 60, pacing: 60, legibility: 60, safety: 90 },
    findings: [{
      timecodeMs: 1_000, startTimecodeMs: 1_000, endTimecodeMs: 1_500,
      scenePosition: 3, targetNodeId: "assets", claimType: "motion",
      evidenceStatus: "failed", evidenceFrameSha256: null, nextAction: "rework_asset",
      category: "continuity", severity: "warning",
      description, suggestion: "重做这一镜的运动。",
    }],
    recommendation: "revise", confidence: 0.9,
  });
  const audit = {
    version: "video-factory/role-audit-v2",
    rubricVersion: "video-factory/role-quality-rubric-v1",
    assessments: [{
      targetPath: "",
      dimensions: [
        { dimension: "evidence", score: 92, evidence: "结论都指向试片自身采样的帧。" },
        { dimension: "coverage", score: 92, evidence: "覆盖了本轮要求的镜头范围。" },
        { dimension: "consistency", score: 92, evidence: "评分与 findings 一致。" },
        { dimension: "actionability", score: 92, evidence: "下一步指明补拍哪一镜。" },
      ],
    }],
    verdict: "pass", score: 92,
    summary: "结论与证据边界一致。", issues: [], repairInstructions: [],
  };
  const pilotInput: AssetPilotReviewInput = {
    runRoot: "", outputDir: "", scriptPath: "", assetPlanPath: "",
    scenePosition: 3, inputFingerprint: "plan", mediaSha256: "a".repeat(64),
  };
  const root = await mkdtemp(path.join(tmpdir(), "vf-pilot-evidence-"));
  const scriptPath = path.join(root, "script.json");
  const assetPlanPath = path.join(root, "asset_plan.json");
  await writeFile(scriptPath, JSON.stringify({ scenes: [{ scene_position: 3, narration: "第三镜" }] }));
  await writeFile(assetPlanPath, JSON.stringify({ scene_assets: [{ scene_position: 3, provider: "pexels", query: "city" }] }));
  const request = { ...pilotInput, runRoot: root, outputDir: root, scriptPath, assetPlanPath };

  const pilot = (media: VisualReviewMediaPayload) => new SourceAssetPilotReviewer([
    new CodexVisualReviewAgent({
      media: { prepare: async () => media },
      client: {
        runTask: async () => motionFailed("运动不成立。"),
        runTaskDetailed: async (kind) => ({ output: kind === "visual-review" ? motionFailed("运动不成立。") : audit }),
      },
      maxReviewIterations: 1,
    }),
  ]);

  // 一帧静帧证明不了运动：这条 failed 必须是 not_observed。
  await assert.rejects(
    () => pilot({ durationMs: 4_000, frames: [
      { timecodeMs: 1_000, sha256: "b".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 3 },
    ] }).review(request),
    /cannot fail a motion claim/,
  );

  // 采样窗口内逐字节相同是静帧唯一能证成的运动结论：同一份报告在这里成立。
  const accepted = await pilot({ durationMs: 4_000, frames: [
    { timecodeMs: 1_000, sha256: "c".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 3 },
    { timecodeMs: 2_000, sha256: "c".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 3 },
  ] }).review(request);
  assert.equal(accepted.execution.output.findings[0]?.evidenceStatus, "failed");
});
