import assert from "node:assert/strict";
import { it } from "node:test";
import { advanceSceneCandidateRanking } from "../src/production-pipeline.js";

// ---------------------------------------------------------------------------
// 「重取这一镜素材」的取舍逻辑。这条路径不去重新检索：候选清单与语义排序是那次规划的证据
// 快照，它只把这一镜的下一名**合格**候选提到首位，让素材节点重跑时改取它。
//
// 这里守的是三件事：
// 1. 换上来的人必须本来就过素材节点那一关——改选不能把不合格候选塞进成片；
// 2. 只动这一镜的排序，别的镜头逐字不动（已付费分镜靠输入指纹复用，动一下就变成重买）；
// 3. 没有第二个合格候选时明确失败，而不是硬取一个次品。
// ---------------------------------------------------------------------------

function rankingOf(source: string, scenePosition: number, candidates: Record<string, unknown>[]): Record<string, unknown> {
  return { version: "video-factory/asset-ranking-v1", source, scenes: [{ scenePosition, candidates }] };
}
const CURRENT = { provider: "pexels", assetId: "7577435" };

const MODEL_SCENE_4 = rankingOf("model", 4, [
  { provider: "pexels", assetId: "7577435", rank: 1, semanticScore: 72, locked: false },
  { provider: "pexels", assetId: "7236863", rank: 2, semanticScore: 65, locked: false },
  { provider: "pexels", assetId: "13736645", rank: 3, semanticScore: 38, locked: false },
]);

it("prefers another recommended candidate before a low-score accepted fallback", () => {
  const ranking = { ...rankingOf("model", 4, [
    { provider: "pexels", assetId: "current", rank: 1, semanticScore: 70 },
    { provider: "pexels", assetId: "weak", rank: 2, semanticScore: 10 },
    { provider: "pexels", assetId: "recommended", rank: 3, semanticScore: 80 },
  ]), deliveryAcceptance: { policyVersion: "playable-first-v1", scenePositions: [4] } };
  const next = advanceSceneCandidateRanking(ranking, 4, { provider: "pexels", assetId: "current" });
  assert.equal(next.replacement.assetId, "recommended");
  const fallback = advanceSceneCandidateRanking(next.ranking, 4, next.replacement);
  assert.equal(fallback.replacement.assetId, "weak");
  assert.throws(() => advanceSceneCandidateRanking(fallback.ranking, 4, fallback.replacement), /no second qualified candidate/);
});

it("switches from the actual adopted candidate and never rotates back to a discarded one", () => {
  const ranking = rankingOf("model", 4, ["a", "b", "c", "d"].map((assetId, index) => ({ provider: "pexels", assetId, rank: index + 1, semanticScore: 70, locked: false })));
  const first = advanceSceneCandidateRanking(ranking, 4, { provider: "pexels", assetId: "c" });
  assert.equal(first.replaced.assetId, "c");
  assert.equal(first.replacement.assetId, "d");
  const second = advanceSceneCandidateRanking(first.ranking, 4, first.replacement);
  assert.notEqual(second.replacement.assetId, "c");
  assert.deepEqual((second.ranking.scenes as Array<{ attemptedCandidateIds: unknown }>)[0]!.attemptedCandidateIds,
    [{ provider: "pexels", assetId: "c" }, { provider: "pexels", assetId: "d" }]);
});

it("promotes the next qualified candidate and demotes the replaced one behind it", () => {
  const advance = advanceSceneCandidateRanking(MODEL_SCENE_4, 4, CURRENT);
  assert.deepEqual(advance.replaced, { provider: "pexels", assetId: "7577435" });
  assert.deepEqual(advance.replacement, { provider: "pexels", assetId: "7236863" });

  const candidates = (advance.ranking.scenes as Record<string, unknown>[])[0]!.candidates as Record<string, unknown>[];
  const rankOf = (assetId: string) => candidates.find((item) => item.assetId === assetId)!.rank;
  assert.equal(rankOf("7236863"), 1);
  assert.equal(rankOf("7577435"), 2);
  // 名次必须是互不相同的整数：素材节点只按名次取舍，重复名次等于没换。
  assert.deepEqual(new Set(candidates.map((item) => item.rank)).size, candidates.length);
});

it("never promotes a candidate the asset node would reject anyway", () => {
  // 第 3 名语义分 38，低于素材节点的合格线。它不该被选中，被换上的只能是第 2 名。
  const advance = advanceSceneCandidateRanking(MODEL_SCENE_4, 4, CURRENT);
  assert.equal(advance.replacement.assetId, "7236863");
});

it("fails closed when the scene has no second qualified candidate", () => {
  const onlyOneQualified = rankingOf("model", 4, [
    { provider: "pexels", assetId: "7577435", rank: 1, semanticScore: 72, locked: false },
    { provider: "pexels", assetId: "13736645", rank: 2, semanticScore: 38, locked: false },
    { provider: "pexels", assetId: "6206442", rank: 3, semanticScore: 12, locked: false },
  ]);
  assert.throws(() => advanceSceneCandidateRanking(onlyOneQualified, 4, CURRENT), /no second qualified candidate/);
});

it("does not silently override a human-locked candidate", () => {
  // 排序不是模型产物时语义分一律按 0 计，此时只有锁定候选算合格——与素材节点同一套判据。
  const manual = rankingOf("manual", 4, [
    { provider: "pexels", assetId: "a", rank: 1, semanticScore: 90, locked: false },
    { provider: "pexels", assetId: "b", rank: 2, semanticScore: 0, locked: true },
  ]);
  assert.throws(() => advanceSceneCandidateRanking(manual, 4, { provider: "pexels", assetId: "b" }), /locked candidate/);

  const twoLocked = rankingOf("manual", 4, [
    { provider: "pexels", assetId: "a", rank: 1, semanticScore: 0, locked: true },
    { provider: "pexels", assetId: "b", rank: 2, semanticScore: 0, locked: true },
  ]);
  assert.throws(() => advanceSceneCandidateRanking(twoLocked, 4, { provider: "pexels", assetId: "a" }), /locked candidate/);
});

it("leaves every other scene byte-identical", () => {
  const ranking = {
    version: "video-factory/asset-ranking-v1",
    source: "model",
    summary: "两镜均有候选",
    scenes: [
      { scenePosition: 4, candidates: [{ provider: "pexels", assetId: "7577435", rank: 1, semanticScore: 72 }] },
      { scenePosition: 5, candidates: [{ provider: "pexels", assetId: "6666665", rank: 1, semanticScore: 79 }] },
    ],
  };
  // 第 4 镜只有一个合格候选：换不动，必须失败，而不是顺手去动第 5 镜。
  assert.throws(() => advanceSceneCandidateRanking(ranking, 4, CURRENT), /no second qualified candidate/);

  const scene5Before = JSON.stringify(ranking.scenes[1]);
  const twoQualified = {
    ...ranking,
    scenes: [
      {
        scenePosition: 4,
        candidates: [
          { provider: "pexels", assetId: "7577435", rank: 1, semanticScore: 72 },
          { provider: "pexels", assetId: "7236863", rank: 2, semanticScore: 65 },
        ],
      },
      ranking.scenes[1]!,
    ],
  };
  const advance = advanceSceneCandidateRanking(twoQualified, 4, CURRENT);
  assert.equal(JSON.stringify((advance.ranking.scenes as unknown[])[1]), scene5Before);
  assert.equal(advance.ranking.summary, ranking.summary);
});

it("rejects a scene the ranking does not describe", () => {
  assert.throws(() => advanceSceneCandidateRanking(MODEL_SCENE_4, 6, CURRENT), /no entry for scene 6/);
});
