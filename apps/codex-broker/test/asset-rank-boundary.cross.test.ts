import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexAssetSemanticRanker, deterministicAssetRanking, type AssetCandidateReport } from "../../../packages/production-pipeline/src/asset-semantic-ranker.js";
import { buildTaskPrompt, validateTaskPayload } from "../src/codex-executor.js";
import { taskPromptFor } from "../src/task-definitions.js";

const audit = { version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v3",
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
  const result = await new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
    client: { runTask: async () => ({}), runTaskDetailed: async () => { calls++; throw new Error("must not reach Broker"); } },
  }).rankDetailed(input);
  assert.equal(calls, 0);
  assert.equal(result.output.visualEvidence?.stopReason, "payload_limit");
  assert.equal(result.output.source, "fallback");
  assert.equal(result.agentLoop?.status, "awaiting_user");
  assert.deepEqual(result.output.scenes.map(scene => scene.candidates.length), [12, 12]);
  assert.deepEqual(result.output.visualEvidence?.reviewed, []);
});

it("shares director context for ten scenes and preserves all 114 candidates through both Broker boundaries", async () => {
  const input = { ...report(), planningIntent: { rankingIntent: {
    planContract: { visualBible: ["保持创作者已确认的自然光与色调。".repeat(200)] },
    shots: Array.from({ length: 10 }, (_, index) => ({ scenePosition: index + 1,
      visibleAction: `第${index + 1}镜：${"保留画面中物体运动的完整过程。".repeat(80)}`,
      sourceInSeconds: 0, temporalBeats: [{ startSeconds: 0, endSeconds: 6, action: "自然移动" }],
      successCriteria: ["保持当前镜头主体与动作"],
    })),
  } } };
  input.scenes = Array.from({ length: 10 }, (_, index) => ({ ...report().scenes[0]!, scenePosition: index + 1,
    candidates: report().scenes[0]!.candidates.slice(0, index === 5 ? 6 : 12),
  }));
  const before = structuredClone(input);
  const calls: string[] = [];
  const ranker = new CodexAssetSemanticRanker({ fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]),
    client: { runTask: async () => { throw new Error("unaudited path"); }, runTaskDetailed: async (kind, payload) => {
      const task = validateTaskPayload(kind, payload);
      const parsed = task.payload;
      calls.push(kind);
      const wire = parsed as unknown as { scenes?: AssetCandidateReport["scenes"];
        rankingContext?: { director: typeof input.planningIntent.rankingIntent };
        context?: { upstreamFacts: { scenes: AssetCandidateReport["scenes"];
          rankingContext: { director: typeof input.planningIntent.rankingIntent } } } };
      const facts = kind === "asset-rank" ? wire : wire.context!.upstreamFacts;
      assert.deepEqual(facts.rankingContext?.director, input.planningIntent.rankingIntent);
      const modelData = JSON.parse(buildTaskPrompt(task).split("<<<TASK_DATA\n")[1]!.split("\nTASK_DATA>>>")[0]!);
      assert.deepEqual((kind === "asset-rank" ? modelData : modelData.context.upstreamFacts).rankingContext.director,
        input.planningIntent.rankingIntent, "共享要求必须实际进入模型提示词，不能只通过接口校验");
      assert.deepEqual(facts.scenes!.flatMap(scene => scene.candidates), input.scenes.flatMap(scene => scene.candidates));
      assert.ok(Buffer.byteLength(JSON.stringify(kind === "asset-rank" ? facts.scenes : wire.context)) <= 192 * 1024);
      assert.equal(JSON.stringify(payload).split(input.planningIntent.rankingIntent.planContract.visualBible[0]!).length, 2);
      if (kind === "role-audit") return { output: audit };
      const output = deterministicAssetRanking(input);
      const thumbnails = (payload as { thumbnails: Array<{ scenePosition: number; assetId: string }> }).thumbnails;
      for (const scene of output.scenes) for (const candidate of scene.candidates) {
        candidate.semanticScore = thumbnails.some(image => image.scenePosition === scene.scenePosition && image.assetId === candidate.assetId) ? 80 : 0;
      }
      return { output: { ...output, source: "model" } };
    } },
  });
  const result = await ranker.rankDetailed(input);
  assert.deepEqual(calls, ["asset-rank", "role-audit"]);
  assert.equal(result.output.scenes.flatMap(scene => scene.candidates).length, 114);
  assert.deepEqual(input, before);
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
