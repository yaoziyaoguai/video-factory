import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateVisualDirectorPlan } from '../../../packages/production-pipeline/src/visual-director.ts';

// 审查探针：仅调用纯校验器；不读取 workspace、不调用模型、不制作媒体。
function sample(deliveryType, beats) {
  const provider = deliveryType === 'generated_video' ? 'generated-fixture' : 'stock-fixture';
  return {
    value: {
      version: 'video-factory/director-plan-v1',
      requestedProfileId: 'auto', resolvedProfileId: 'documentary-observer',
      profileRationale: '稳定画面用于观察空间关系。',
      visualBible: {
        narrativeApproach: '观察构图关系', pacing: '有意停留', composition: '固定全景',
        camera: '固定机位', color: '统一色温', continuity: '保持视觉关系', sound: '克制旁白',
      },
      shots: [{
        scenePosition: 1, narrativeRole: '展示一个持续状态', authenticityPolicy: 'illustrative',
        preferredProviderId: provider, deliveryType, alternativeProviderIds: [],
        visibleAction: '固定机位连续呈现同一空间关系，没有状态切换。',
        temporalBeats: beats, sourceInSeconds: 0,
        query: '固定机位 空间关系', generationPrompt: '固定机位连续呈现空间关系。',
        rationale: '清楚展示空间关系。', continuityNote: '保持主体位置。',
        confidence: 0.9, estimatedCostCny: 0,
      }],
    },
    options: {
      scenePositions: [1], sceneDurations: { 1: 5 }, allowedProviderIds: [provider],
      generativeProviderIds: deliveryType === 'generated_video' ? [provider] : [],
      providerDeliveryTypes: { [provider]: [deliveryType] }, estimatedCnyPerClip: { [provider]: 0 },
      economics: { allowMeteredProviders: true },
    },
  };
}

for (const delivery of ['stock_video', 'generated_video']) {
  test(`R9-C01: ${delivery} permits one continuous five-second state`, () => {
    const { value, options } = sample(delivery, [{ startSeconds: 0, endSeconds: 5, action: '固定机位持续观察空间关系。' }]);
    assert.doesNotThrow(() => validateVisualDirectorPlan(value, options));
  });
}

test('R9-C02: two beats do not excuse an uncovered final second', () => {
  const { value, options } = sample('stock_video', [
    { startSeconds: 0, endSeconds: 2, action: '呈现主体。' },
    { startSeconds: 2, endSeconds: 4, action: '保持观察。' },
  ]);
  assert.throws(() => validateVisualDirectorPlan(value, options));
});

test('R9-C03: a gap remains invalid', () => {
  const { value, options } = sample('stock_video', [
    { startSeconds: 0, endSeconds: 2, action: '呈现主体。' },
    { startSeconds: 3, endSeconds: 5, action: '保持观察。' },
  ]);
  assert.throws(() => validateVisualDirectorPlan(value, options), /continuous without gaps/);
});

test('R9-C04: ordinary complete multi-beat footage remains valid', () => {
  const { value, options } = sample('stock_video', [
    { startSeconds: 0, endSeconds: 2, action: '呈现主体。' },
    { startSeconds: 2, endSeconds: 5, action: '保持观察。' },
  ]);
  assert.doesNotThrow(() => validateVisualDirectorPlan(value, options));
});
