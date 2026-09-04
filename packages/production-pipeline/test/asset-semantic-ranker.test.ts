import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexAssetSemanticRanker,
  deterministicAssetRanking,
  parseAssetCandidateReport,
  type CodexTaskExecution,
  type CodexTaskKind,
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
  it("repairs a semantic ranking after independent contract audit", async () => {
    const report = parseAssetCandidateReport(rawReport);
    const calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];
    let rankAttempt = 0;
    const client = {
      runTask: async () => deterministicAssetRanking(report),
      runTaskDetailed: async (kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> => {
        calls.push({ kind, payload });
        if (kind === "asset-rank") {
          rankAttempt += 1;
          const ranking = deterministicAssetRanking(report);
          ranking.source = "model";
          ranking.providerId = "codex-asset-ranker-v1";
          ranking.modelId = "codex-default";
          ranking.scenes[0]!.candidates[0]!.rationale = rankAttempt === 1
            ? "这个素材 ID 看起来更合适。"
            : "缩略图显示蒸汽动作清楚，且竖屏主体完整。";
          return { output: ranking };
        }
        return { output: {
          version: "video-factory/role-audit-v1",
          verdict: rankAttempt === 1 ? "repair" : "pass",
          score: rankAttempt === 1 ? 55 : 90,
          summary: rankAttempt === 1 ? "首选理由依赖素材 ID 臆测。" : "排序理由诚实反映证据边界。",
          issues: rankAttempt === 1 ? [{
            severity: "blocking",
            criterion: "不得根据素材 ID 臆测",
            evidence: "理由写明‘素材 ID 看起来更合适’。",
            repairInstruction: "删除 ID 推断并明确缩略图证据缺失。",
          }] : [],
          repairInstructions: rankAttempt === 1 ? ["按可见证据重写理由。"] : [],
        } };
      },
    };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
    const ranker = new CodexAssetSemanticRanker({ client, fetchThumbnail: async () => jpeg, maxReviewIterations: 2 });

    const execution = await ranker.rankDetailed(report);

    assert.equal(execution.agentLoop?.iterations.length, 2);
    assert.match(execution.output.scenes[0]!.candidates[0]!.rationale, /缩略图/);
    assert.deepEqual(calls.map((call) => call.kind), ["asset-rank", "role-audit", "asset-rank", "role-audit"]);
    assert.equal("revision" in (calls[2]!.payload as Record<string, unknown>), true);
    const auditImages = (calls[1]!.payload as { images: Array<Record<string, unknown>> }).images;
    const auditCriteria = (calls[1]!.payload as { criteria: string[] }).criteria;
    assert.match(auditCriteria.join("\n"), /核心主体、物体和动作.*不得通过审计/);
    assert.equal(auditImages.length, 2);
    assert.deepEqual(auditImages.map((image) => [image.imageIndex, image.provider, image.assetId]), [[1, "pexels", "first"], [2, "pixabay", "second"]]);
    assert.equal(typeof auditImages[0]?.jpegBase64, "string");
  });

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
