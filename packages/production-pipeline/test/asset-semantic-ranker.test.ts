import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexAssetSemanticRanker,
  deterministicAssetRanking,
  parseAssetCandidateReport,
  validateAssetSemanticRanking,
} from "../src/index.js";

const rawReport = {
  version: "video-factory/asset-candidates-v1",
  scene_candidates: [{
    scene_position: 1,
    intent: { subject: "早餐摊", visible_action: "蒸汽上升" },
    query: "Chinese breakfast steam",
    candidates: [
      candidate("pexels", "first", 80, 1080, 1920),
      candidate("pixabay", "second", 90, 720, 1280),
    ],
  }],
};

describe("asset semantic ranking", () => {
  it("parses bounded public candidate metadata and never requires download URLs", () => {
    const report = parseAssetCandidateReport(rawReport);
    assert.equal(report.scenes[0]?.candidates[0]?.assetId, "first");
    assert.equal(Object.hasOwn(report.scenes[0]?.candidates[0] ?? {}, "downloadUrl"), false);
  });

  it("provides a deterministic inspectable fallback", () => {
    const report = parseAssetCandidateReport(rawReport);
    const ranking = deterministicAssetRanking(report, "test fallback");
    assert.equal(ranking.source, "fallback");
    assert.deepEqual(ranking.scenes[0]?.candidates.map((item) => item.assetId), ["second", "first"]);
    assert.equal(ranking.fallbackReason, "test fallback");
  });

  it("rejects model output that silently removes a candidate", () => {
    const report = parseAssetCandidateReport(rawReport);
    assert.throws(() => validateAssetSemanticRanking({
      version: "video-factory/asset-ranking-v1",
      source: "model",
      providerId: "codex-asset-ranker-v1",
      modelId: "codex-default",
      summary: "ranked",
      scenes: [{
        scenePosition: 1,
        summary: "only one",
        candidates: [{
          provider: "pexels", assetId: "first", originalRank: 1, rank: 1,
          semanticScore: 80, rationale: "matches", locked: false,
        }],
      }],
    }, report), /cover every candidate/);
  });

  it("reserves candidate locks for human overrides and preserves original ranks", () => {
    const report = parseAssetCandidateReport(rawReport);
    const ranking = deterministicAssetRanking(report);
    ranking.scenes[0]!.candidates[0]!.locked = true;

    assert.throws(() => validateAssetSemanticRanking(ranking, report), /cannot lock candidates/);
    assert.equal(validateAssetSemanticRanking(ranking, report, { allowLocks: true }).scenes[0]?.candidates[0]?.locked, true);
    ranking.scenes[0]!.candidates[0]!.originalRank = 1;
    assert.throws(() => validateAssetSemanticRanking(ranking, report, { allowLocks: true }), /invalid originalRank/);
  });

  it("pins provider and model evidence to the configured ranker", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const ranker = new CodexAssetSemanticRanker({
      providerId: "codex-asset-ranker-v1",
      modelId: "configured-codex",
      client: {
        runTask: async () => ({
          version: "video-factory/asset-ranking-v1",
          source: "model",
          providerId: "codex-asset-ranker-v1",
          modelId: "configured-codex",
          summary: "语义排序完成",
          scenes: [{
            scenePosition: 1,
            summary: "第二项动作更明确",
            candidates: [
              { provider: "pixabay", assetId: "second", originalRank: 2, rank: 1, semanticScore: 86, rationale: "动作匹配", locked: false },
              { provider: "pexels", assetId: "first", originalRank: 1, rank: 2, semanticScore: 62, rationale: "信息不足", locked: false },
            ],
          }],
        }),
      },
      fetchThumbnail: async () => undefined,
    });
    const ranking = await ranker.rank(report);
    assert.equal(ranking.modelId, "configured-codex");
    assert.equal(ranking.scenes[0]?.candidates[0]?.assetId, "second");
  });

  it("sends bounded candidate thumbnails with an explicit scene and asset mapping", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const seen: unknown[] = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
    const ranker = new CodexAssetSemanticRanker({
      client: {
        runTask: async (_kind, payload) => {
          seen.push(payload);
          return deterministicAssetRanking(report);
        },
      },
      fetchThumbnail: async () => jpeg,
    });
    await ranker.rank(report);
    const payload = seen[0] as { thumbnails: Array<Record<string, unknown>> };
    assert.equal(payload.thumbnails.length, 2);
    assert.deepEqual(
      payload.thumbnails.map((item) => [item.scenePosition, item.provider, item.assetId]),
      [[1, "pexels", "first"], [1, "pixabay", "second"]],
    );
    assert.equal(typeof payload.thumbnails[0]?.jpegBase64, "string");
  });
});

function candidate(provider: string, assetId: string, score: number, width: number, height: number) {
  return {
    provider,
    provider_id: `${provider}-stock-v1`,
    asset_id: assetId,
    media_type: "video",
    width,
    height,
    duration: 5,
    preview_url: `https://images.${provider}.com/${assetId}.jpg`,
    source_url: `https://www.${provider}.com/${assetId}`,
    creator: "Creator",
    license_note: "Free stock license",
    query: "Chinese breakfast steam",
    score,
  };
}
