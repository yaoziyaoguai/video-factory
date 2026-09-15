import assert from 'node:assert/strict';
import { runRoleAgentLoop } from '../../../packages/production-pipeline/src/role-agent-loop.ts';
import { assessTreatmentReadiness } from '../../../packages/production-pipeline/src/treatment-readiness.ts';
import { parseCreativeTreatment } from '../../../packages/production-pipeline/src/creative-treatment.ts';
import { summarizeProductionCapabilities } from '../../../packages/production-pipeline/src/production-capabilities.ts';
import { validateVisualDirectorPlan } from '../../../packages/production-pipeline/src/visual-director.ts';
import { defaultAvailabilityReviewer } from '../../../packages/production-pipeline/src/creative-planning.ts';

const capabilities = summarizeProductionCapabilities([{ id: 'generated-provider', deliveryTypes: ['generated_video'], strengths: [], constraints: [] }], 'macos-say-v1');
const candidate = {
  version: 'video-factory/creative-treatment-v2', viewerPromise: '以生成艺术隐喻感受压力释放，不声称真实实验证据',
  hook: { narrationIntent: '提出情绪体验', visualIntent: '形态由密至疏' },
  progression: [{ beatId: 'expression', purpose: '压力释放', viewerGain: '感受变化' }],
  payoff: '感受松弛', visualPrinciples: ['统一色彩'], soundPrinciples: ['自然旁白'], feasibilityQuestions: [],
  evidenceRequirements: [{ beatId: 'expression', claim: '以形态表达压力释放', requirement: 'factual_support', critical: true, acquisition: 'external_required', retrievalProviderId: null, suppliedSourceIds: [] }],
};
const repaired = { ...candidate, evidenceRequirements: [{ ...candidate.evidenceRequirements[0], requirement: 'illustration_only', acquisition: 'not_needed' }] };
let revisionCapture;
let callCount = 0;
await runRoleAgentLoop({
  role: '导演前期构思', planningRole: true, contractVersion: 'isolated-review', criteria: ['遵守明确创作意图'], maxIterations: 2,
  produce: async (revision) => {
    callCount += 1;
    if (revision) revisionCapture = structuredClone(revision);
    return { output: callCount === 1 ? candidate : repaired };
  },
  validate: value => parseCreativeTreatment(value, []),
  assessPlanningReadiness: value => assessTreatmentReadiness(value, [], capabilities),
  audit: async ({ iteration }) => ({ output: iteration === 1 ? {
    version: 'video-factory/role-audit-v1', verdict: 'repair', score: 90, summary: '候选误读用户明确的非实证艺术表达',
    issues: [{ severity: 'blocking', criterion: '用户明确要求', evidence: '用户要求是生成艺术隐喻，不是真实实验；candidate.evidenceRequirements错误分类为factual_support/external_required', repairInstruction: '保留原用户承诺，将误分类改为 illustration_only/not_needed，不要求补材料或改变承诺。' }],
    repairInstructions: ['保留原用户承诺，将误分类改为 illustration_only/not_needed，不要求补材料或改变承诺。'],
    planningDisposition: { action: 'revise_here', issueIndexes: [0] }, hostReadinessReview: { misclassifiedIssueIds: ['treatment-readiness-1'] },
  } : {
    version: 'video-factory/role-audit-v1', verdict: 'pass', score: 94, summary: '表达路线可行', issues: [], repairInstructions: [], planningDisposition: null, hostReadinessReview: { misclassifiedIssueIds: [] },
  }}),
});
assert.equal(callCount, 2);
assert(revisionCapture.audit.repairInstructions.includes('请补充所需的专属材料，或明确调整本片承诺。'));
console.log('PROBE_1 confirmed: real host readiness injects the explicitly refuted source-upload instruction back into revision', JSON.stringify(revisionCapture.audit, null, 2));

const generatedShot = {
  scenePosition: 1, narrativeRole: '情绪表达', authenticityPolicy: 'illustrative', preferredProviderId: 'generated-provider', deliveryType: 'generated_video', alternativeProviderIds: [],
  query: 'abstract shapes', generationPrompt: 'Abstract geometric shapes drift apart; no text', rationale: '无需真实举证的示意表达', continuityNote: '独立镜头', confidence: 0.9, estimatedCostCny: 1,
};
const plan = {
  version: 'video-factory/director-plan-v1', requestedProfileId: 'auto', resolvedProfileId: 'documentary-observer', profileRationale: '清晰呈现形态变化',
  visualBible: { narrativeApproach: '以形态表达感受', pacing: '自然', composition: '中心', camera: '静止', color: '蓝色', continuity: '统一风格', sound: '旁白' }, shots: [generatedShot],
};
const validation = {
  scenePositions: [1], sceneVisualStrategies: { 1: 'stock' }, allowedProviderIds: ['stock-provider', 'generated-provider'], generativeProviderIds: ['generated-provider'],
  providerDeliveryTypes: { 'stock-provider': ['stock_video'], 'generated-provider': ['generated_video'] }, estimatedCnyPerClip: { 'generated-provider': 1 }, economics: { allowMeteredProviders: true },
};
const problems = defaultAvailabilityReviewer({
  script: { scenes: [{ position: 1, purpose: '情绪表达', visual_strategy: 'stock' }] },
  directorPlan: { ...plan, shots: [{ ...generatedShot, preferredProviderId: 'stock-provider', deliveryType: 'stock_video' }] },
  ranking: { artifactId: 'ranking-1', output: { scenes: [{ scenePosition: 1, candidates: [] }] } },
});
assert.equal(problems[0].target, 'director');
assert.match(problems[0].requiredChange, /生成/);
assert.throws(() => validateVisualDirectorPlan(plan, validation), /requires real stock footage and cannot be changed to generated media/);
validateVisualDirectorPlan(plan, { ...validation, sceneVisualStrategies: { 1: 'generated' } });
console.log('PROBE_2 confirmed: availability reviewer requests director to switch illustrative stock to allowed generated route, but production director validator rejects solely because script visual_strategy=stock');
