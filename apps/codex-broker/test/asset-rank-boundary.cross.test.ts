import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexAssetSemanticRanker, deterministicAssetRanking, type AssetCandidateReport } from "../../../packages/production-pipeline/src/asset-semantic-ranker.js";
import { validateTaskPayload } from "../src/codex-executor.js";
import { taskPromptFor } from "../src/task-definitions.js";

const audit = { version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1",
  verdict: "pass", score: 92, summary: "有据可查", issues: [], repairInstructions: [],
  assessments: [{ targetPath: "", dimensions: ["evidence", "coverage", "consistency", "actionability"]
    .map(dimension => ({ dimension, score: 92, evidence: "根据实际缩略图" })) }],
};
function report(): AssetCandidateReport {
  return { version: "video-factory/asset-candidates-v1", scenes: [1, 2].map(scenePosition => ({
    scenePosition, intent: { subject: "sea" }, query: "sea", candidates: Array.from({ length: 12 }, (_, i) => ({
      provider: "pexels", assetId: `${scenePosition}-${i}`, mediaType: "video", width: 1080, height: 1920,
      duration: 5, previewUrl: `https://images.pexels.com/${i}.jpg`, sourceUrl: `https://pexels.com/${i}`,
      creator: "fixture", licenseNote: "fixture", query: "sea", qualityScore: 80,
    })),
  })) };
}

it("delivers duration, source offset and action requirements to both ranking and independent audit", async () => {
  const input = report();
  input.scenes = [input.scenes[0]!];
  input.scenes[0]!.candidates = input.scenes[0]!.candidates.slice(0, 2);
  input.scenes[0]!.intent = { scene_duration_seconds: "6", source_in_seconds: "2",
    visible_action: "从拿起到放下的完整过程", success_criteria: '["起止动作都可见"]',
    temporal_beats: '[{"startSeconds":0,"endSeconds":6,"action":"完整移动"}]' };
  const observed: string[] = [];
  const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
    client: { runTask: async () => { throw new Error("unaudited path"); }, runTaskDetailed: async (kind, payload) => {
      const parsed = validateTaskPayload(kind, payload);
      observed.push(kind);
      const wire = parsed.payload as unknown as { scenes?: AssetCandidateReport["scenes"]; context?: {
        upstreamFacts: AssetCandidateReport; currentRoleContract: { temporalEvidencePolicy?: string } } };
      const scene = (wire.scenes ?? wire.context!.upstreamFacts.scenes)[0]!;
      for (const [key, value] of Object.entries(input.scenes[0]!.intent)) assert.equal(scene.intent[key], value);
      assert.equal(scene.candidates[0]!.duration, 5);
      if (kind === "role-audit") assert.match(wire.context!.currentRoleContract.temporalEvidencePolicy ?? "", /source_in_seconds/);
      else assert.match(taskPromptFor("asset-rank").directive, /scene_duration_seconds/);
      return { output: kind === "role-audit" ? audit : { ...deterministicAssetRanking(input), source: "model" } };
    } },
  });
  const result = await ranker.rankDetailed(input);
  assert.deepEqual(observed, ["asset-rank", "role-audit"]);
  assert.equal(result.output.scenes[0]!.candidates.length, 2, "不足与待核只形成意见，不删除候选或篡改选择");
});

it("passes actual primary and multi-scene supplementary requests through the production Broker parser", async () => {
  const requests: string[] = [];
  const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
    client: { runTask: async () => { throw new Error("unaudited path"); }, runTaskDetailed: async (kind, payload) => {
      assert.doesNotThrow(() => validateTaskPayload(kind, payload));
      requests.push(kind);
      return { output: kind === "role-audit" ? audit : { ...deterministicAssetRanking(payload as AssetCandidateReport), source: "model" } };
    } },
  });
  const result = await ranker.rankDetailed(report());
  assert.deepEqual(requests, ["asset-rank", "role-audit", "asset-rank", "role-audit"]);
  assert.equal(result.output.visualEvidence?.reviewed.length, 24);
  assert.deepEqual(result.output.scenes.map(scene => scene.candidates.length), [12, 12]);
});

it("preflights the audit context with the same byte boundary as the Broker", async () => {
  const input = report();
  const intent = input.scenes[0]!.intent;
  while (Buffer.byteLength(JSON.stringify(input.scenes)) < 194000) intent[`padding${Object.keys(intent).length}`] = "x".repeat(1900);
  intent.last = "";
  intent.last = "x".repeat(196480 - Buffer.byteLength(JSON.stringify(input.scenes)));
  let calls = 0;
  await assert.rejects(new CodexAssetSemanticRanker({ fetchThumbnail: async () => undefined,
    client: { runTask: async () => ({}), runTaskDetailed: async () => { calls++; throw new Error("must not reach Broker"); } },
  }).rankDetailed(input), /context/);
  assert.equal(calls, 0);
});

it("ranks reused candidates against the current director timing instead of cached search intent", async () => {
  const input = { ...report(), planningIntent: { rankingIntent: { shots: [{ scenePosition: 1, sourceInSeconds: 1.5,
    visibleAction: "缓慢移动到终点", successCriteria: ["完成整个动作"],
    temporalBeats: [{ startSeconds: 0, endSeconds: 9, action: "完整移动" }] }] } } };
  input.scenes = [input.scenes[0]!];
  input.scenes[0]!.candidates = input.scenes[0]!.candidates.slice(0, 2);
  input.scenes[0]!.intent = { scene_duration_seconds: "6", source_in_seconds: "0", visible_action: "旧动作" };
  const before = structuredClone(input);
  let calls = 0;
  const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
    client: { runTask: async () => { throw new Error("unaudited"); }, runTaskDetailed: async (kind, payload) => {
      validateTaskPayload(kind, payload);
      calls++;
      const wire = payload as { scenes?: AssetCandidateReport["scenes"]; context?: { upstreamFacts: AssetCandidateReport } };
      const scene = (wire.scenes ?? wire.context!.upstreamFacts.scenes)[0]!;
      assert.equal(scene.intent.scene_duration_seconds, "9");
      assert.equal(scene.intent.source_in_seconds, "1.5");
      assert.equal(scene.intent.visible_action, "缓慢移动到终点");
      assert.deepEqual(JSON.parse(scene.intent.success_criteria!), ["完成整个动作"]);
      return { output: kind === "role-audit" ? audit : { ...deterministicAssetRanking(input), source: "model" } };
    } },
  });
  await ranker.rankDetailed(input);
  assert.equal(calls, 2);
  assert.deepEqual(input, before, "当前投影不能改写已保存的候选/旧请求身份");
});
