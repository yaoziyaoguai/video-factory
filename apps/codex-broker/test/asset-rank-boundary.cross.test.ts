import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexAssetSemanticRanker, deterministicAssetRanking, type AssetCandidateReport } from "../../../packages/production-pipeline/src/asset-semantic-ranker.js";
import { validateTaskPayload } from "../src/codex-executor.js";

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
