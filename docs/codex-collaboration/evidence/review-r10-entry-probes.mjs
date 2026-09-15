import assert from 'node:assert/strict';
import { decideEditorialFormat } from '../../../apps/studio/src/server/editorial-decision.ts';
import { resolveOpportunityVisualPlan } from '../../../apps/studio/src/shared/visual-plan.ts';

// 诊断探针确认当前缺陷；exit 0 表示缺陷复现，不表示产品验收通过。
const base = {
  origin: 'trend', providerId: 'api-topic-editor-v1',
  title: '把回家的路拍成写给未来的信', track: 'visual-story',
  audience: '想用影像记录生活的独居年轻人',
  painPoint: '熟悉的归途总被忽略，想重新感受生活中安静的陪伴',
  hook: '把回家的路，拍成一封寄给未来的信',
  category: 'local-culture', freshness: 'evergreen', risk: 'low',
  verification: { status: 'ready', independentSources: 2, requiredSources: 2, reasons: [] },
  score: { audienceReach: 90, visualFeasibility: 90, productionCostEfficiency: 90,
    novelty: 90, monetization: 50, seriesPotential: 90, complianceRisk: 0, final: 90 },
  visualPlan: { strategy: '用沿途光影的呼应表达归属感，生成示意，不宣称真实记录。', beats: [] },
};
const normal = decideEditorialFormat(base, []);
const punctuated = decideEditorialFormat({ ...base, hook: base.hook + '？' }, []);
const numeral = decideEditorialFormat({ ...base, hook: base.hook.replace('一封', '1封') }, []);
assert.equal(normal.verdict, 'skip');
assert.equal(punctuated.verdict, 'produce_video');
assert.equal(numeral.verdict, 'produce_video');
console.log(JSON.stringify({ normal, punctuated, numeral }, null, 2));

const userInput = { title: '构图中的视觉重心', hook: '只是构图示意，不做实验或实测', category: 'education' };
const fallback = resolveOpportunityVisualPlan(userInput);
assert.match(fallback.strategy, /受控实证/);
assert.equal(fallback.beats.length, 3);
console.log(JSON.stringify({ userInput, fallback }, null, 2));
