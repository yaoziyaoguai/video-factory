// 独立复审：只使用内存 checkpoint 和临时 SQLite，不调用模型/媒体。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runRoleAgentLoop } from '../../../packages/production-pipeline/src/role-agent-loop.ts';
import { CodexBridgeError } from '../../../packages/production-pipeline/src/codex-chat.ts';
import { createCreativePlanningGraph, runCreativePlanning, executablePlanCompilePort } from '../../../packages/production-pipeline/src/creative-planning.ts';
import { CreativePlanningStore, planningThreadId } from '../../../packages/production-pipeline/src/creative-planning-store.ts';

const passingAudit = () => ({ version: 'video-factory/role-audit-v1', verdict: 'pass', score: 92, summary: '符合要求', issues: [], repairInstructions: [] });

async function exercisePendingResume(changeContract) {
  let stored;
  let interrupted = true;
  const submitted = [];
  const observed = [];
  const execute = contractVersion => runRoleAgentLoop({
    role: '编剧', contractVersion, criteria: ['标题具体'], maxIterations: 3,
    checkpoint: { key: 'unchanged-accepted-input', load: async () => stored, save: async value => { stored = structuredClone(value); } },
    produce: async (_revision, operation) => {
      if (operation.preparedOperation) {
        observed.push(operation.preparedOperation.requestId);
        return { output: { title: '原成果' } };
      }
      submitted.push(operation.requestId);
      await operation.requestOptions.beforeSubmit({
        version: 'video-factory/codex-prepared-operation-v1', requestId: operation.requestId,
        kind: 'script-draft', envelope: { payload: { title: '原输入' } }, serializedEnvelope: '{"payload":{"title":"原输入"}}',
        binding: { requestDigest: 'a'.repeat(64) }, brokerBinding: {}, route: { socketPath: '/tmp/not-connected.sock' },
        taskFact: 'accepted_unknown',
      });
      if (interrupted) {
        interrupted = false;
        throw new CodexBridgeError('Accepted but observation interrupted', false, 'uncertain');
      }
      return { output: { title: '新调用的成果' } };
    },
    audit: async () => ({ output: passingAudit() }),
    validate: value => value,
  });
  await assert.rejects(() => execute('old-contract'), /结果未知/);
  assert.ok(stored.pendingOperation, '前置：旧请求快照已经落盘且结果未知');
  const originalId = stored.pendingOperation.operation.requestId;
  await execute(changeContract ? 'new-contract' : 'old-contract').catch(() => {});
  console.log(JSON.stringify({ probe: 'pending-contract', changeContract, submitted, observed, originalId }));
  assert.equal(submitted.length, 1, '未知原任务尚未结清，部署升级合同不得新增生成请求');
  if (!changeContract) assert.deepEqual(observed, [originalId]);
}

test('control: same-contract pending resume observes original task', () => exercisePendingResume(false));
test('R3-F01: contract upgrade must not discard an accepted unknown pending task', () => exercisePendingResume(true));

const script = {
  viewerPromise: '了解主体动作', narrativeArc: '提出问题到兑现', canonFacts: [],
  scenes: [1, 2, 3].map(position => ({ position, purpose: `第${position}段`, narration: '旁白内容', duration: 8,
    visual_strategy: 'stock', visual_prompt: '观察现场动作', search_terms: ['动作'] })),
};
const treatment = {
  version: 'video-factory/creative-treatment-v1', viewerPromise: '了解主体动作',
  hook: { narrationIntent: '提出问题', visualIntent: '动作开场' },
  progression: [1, 2, 3].map(n => ({ beatId: `beat-${n}`, purpose: '推进内容', viewerGain: '理解动作' })),
  payoff: '理解动作', visualPrinciples: ['自然'], soundPrinciples: ['环境声'], evidenceRequirements: [], feasibilityQuestions: [],
};
function directorPlan(call, paraphrase) {
  return {
    version: 'video-factory/director-plan-v1', requestedProfileId: 'documentary-observer', resolvedProfileId: 'documentary-observer', profileRationale: '观察',
    visualBible: { narrativeApproach: '观察', pacing: '自然', composition: '中景', camera: '稳定', color: '自然', continuity: '连续', sound: '环境' },
    shots: [1, 2, 3].map(scenePosition => ({ scenePosition,
      narrativeRole: scenePosition === 2 ? '关键证据' : '主镜头', authenticityPolicy: 'illustrative',
      preferredProviderId: 'stock-free', deliveryType: 'stock_video', alternativeProviderIds: [],
      query: `subject-action-${scenePosition}-${call}`, generationPrompt: '动作', rationale: '观察', continuityNote: '稳定',
      subject: '手部', visibleAction: '缓慢旋转物体',
      successCriteria: [paraphrase && scenePosition === 2 ? ['完整展示旋转动作', '旋转动作完整可见', '应看到完整的旋转过程'][call - 1] : '完整展示旋转动作'],
      confidence: .8, estimatedCostCny: 0, temporalBeats: [{ startSeconds: 0, endSeconds: 8, action: '观察动作' }],
    })),
  };
}
async function exerciseAvailability(paraphrase) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vf-r3-availability-review-'));
  const store = CreativePlanningStore.open(workspace);
  let directorCalls = 0;
  let rankCalls = 0;
  const ports = {
    treatment: async () => ({ artifactId: 'treatment-1', output: treatment }),
    screenwriter: async () => ({ artifactId: 'script-1', output: script }),
    director: async () => ({ artifactId: `director-${++directorCalls}`, output: directorPlan(directorCalls, paraphrase) }),
    searchCandidates: async context => ({ artifactId: `candidates-${directorCalls}`, output: {
      version: 'video-factory/asset-candidates-v1', scenes: context.directorPlan.output.shots.map(shot => ({
        scenePosition: shot.scenePosition, intent: { narrativeRole: shot.narrativeRole }, query: shot.query,
        candidates: [{ provider: 'stock-free', assetId: `asset-${shot.scenePosition}`, mediaType: 'video',
          width: 1920, height: 1080, duration: 10, previewUrl: 'https://example.test/image', sourceUrl: 'https://example.test/source',
          creator: 'fixture', licenseNote: 'fixture', query: shot.query, qualityScore: 70 }],
      })),
    } }),
    rank: async context => ({ artifactId: `ranking-${++rankCalls}`, output: {
      version: 'video-factory/asset-ranking-v1', source: 'model', providerId: 'fixture', modelId: 'fixture', summary: '真实候选未改善',
      scenes: context.candidates.output.scenes.map(scene => ({ scenePosition: scene.scenePosition, summary: '排序',
        candidates: scene.candidates.map(c => ({ provider: c.provider, assetId: c.assetId, originalRank: 1, rank: 1,
          semanticScore: scene.scenePosition === 2 ? 20 : 80, rationale: '观察', locked: false })),
      })),
    } }),
    integrateDirector: async context => context.directorPlan,
    compile: executablePlanCompilePort,
  };
  try {
    const input = { runId: 'review-availability', inputDigest: 'unchanged-input', durationRange: { minSeconds: 20, maxSeconds: 34 } };
    const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
    const outcome = await runCreativePlanning(graph, { input, threadId: planningThreadId(input.runId, input.inputDigest) });
    console.log(JSON.stringify({ probe: 'availability', paraphrase, directorCalls, rankCalls, halt: outcome.halt }));
    assert.equal(directorCalls, 2, '候选完全不变，只改成功条件的等义措辞，应在第二轮停止');
    assert.equal(outcome.halt.reason, 'needs_source');
  } finally { store.close(); await rm(workspace, { recursive: true, force: true }); }
}
test('control: query-only revision stops at second failed availability review', () => exerciseAvailability(false));
test('R3-F02: equivalent success-criterion wording must not renew availability retries', () => exerciseAvailability(true));
