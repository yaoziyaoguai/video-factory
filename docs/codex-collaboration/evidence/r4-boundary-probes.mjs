import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRoleAgentLoop } from '../../../packages/production-pipeline/src/role-agent-loop.ts';
import { CodexBridgeError } from '../../../packages/production-pipeline/src/codex-chat.ts';

const pass = () => ({ version: 'video-factory/role-audit-v1', verdict: 'pass', score: 92, summary: '旧准则通过', issues: [], repairInstructions: [] });
const snapshot = (op, kind) => ({
  version: 'video-factory/codex-prepared-operation-v1', requestId: op.requestId,
  kind, envelope: { payload: { old: true } }, serializedEnvelope: '{"payload":{"old":true}}',
  binding: { requestDigest: 'a'.repeat(64) }, brokerBinding: {}, route: { socketPath: '/tmp/not-connected.sock' },
  taskFact: 'accepted_unknown',
});

async function auditUpgrade(change) {
  let stored;
  let first = true;
  let observed = 0;
  let newAudits = 0;
  let produced = 0;
  const run = (version) => runRoleAgentLoop({
    role: '编剧', contractVersion: version, criteria: version === 'v1' ? ['标题具体'] : ['标题具体', '全部事实有明确来源'], maxIterations: 3,
    checkpoint: { key: 'same-accepted-input', load: async () => stored, save: async v => { stored = structuredClone(v); } },
    produce: async () => { produced++; return { output: { title: '原候选' } }; },
    audit: async op => {
      if (op.preparedOperation) { observed++; return { output: pass() }; }
      if (first) {
        first = false;
        await op.requestOptions.beforeSubmit(snapshot(op, 'role-audit'));
        throw new CodexBridgeError('accepted audit, reply lost', false, 'uncertain');
      }
      newAudits++;
      return { output: pass() };
    },
    validate: v => v,
  });
  await assert.rejects(() => run('v1'));
  assert.equal(stored.pendingOperation.phase, 'audit');
  const result = await run(change ? 'v2' : 'v1');
  console.log(JSON.stringify({probe: 'audit-upgrade', change, observed, newAudits, produced, status: result.agentLoop.status, resultContract: result.agentLoop.contractVersion}));
  assert.equal(observed, 1, '必须结清原 audit');
  if (change) assert.ok(result.agentLoop.status !== 'passed' || newAudits > 0, '不能将只按旧准则审过的 pass 标成新合同通过');
  else assert.equal(newAudits, 0, '相同合同只取回旧 audit，不重审');
}
test('control: same-contract pending audit is reused', () => auditUpgrade(false));
test('R4-F02: old pending audit cannot certify new criteria', () => auditUpgrade(true));

async function transientRetry(resume) {
  let stored;
  let setup = true;
  let observations = 0;
  const submissions = [];
  const run = () => runRoleAgentLoop({
    role: '编剧', contractVersion: 'v1', criteria: ['标题具体'], maxIterations: 3,
    checkpoint: { key: 'retry-input', resumeCompletedFailure: !setup && resume, load: async () => stored, save: async v => { stored = structuredClone(v); } },
    produce: async (_, op) => {
      if (setup) {
        await op.requestOptions.beforeSubmit(snapshot(op, 'script-draft'));
        throw new CodexBridgeError('accepted produce, reply lost', false, 'uncertain');
      }
      if (op.preparedOperation) observations++;
      else {
        submissions.push(op.requestId);
        // 测试自身保险丝，防止产品 while(true) 持续执行；不是产品上限。
        if (submissions.length >= 4) throw new Error('TEST_SAFETY_FUSE');
        await op.requestOptions.beforeSubmit(snapshot(op, 'script-draft'));
      }
      throw new CodexBridgeError('provider transient', false, 'completed_failure', 502, 'model_provider_transient');
    },
    audit: async () => ({output: pass()}), validate: v => v,
  });
  await assert.rejects(run);
  setup = false;
  await assert.rejects(run);
  console.log(JSON.stringify({probe: 'one-human-retry', resume, observations, submissions, iterations: stored.completed.length}));
  assert.equal(observations, 1);
  assert.equal(submissions.length, resume ? 1 : 0, '一次人工重试只能越过已确认的原失败，新的失败必须再次停止');
}
test('control: automatic recovery stops at known completed_failure', () => transientRetry(false));
test('R4-F01: manual retry must not silently retry every new failure', () => transientRetry(true));
