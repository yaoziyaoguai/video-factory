// 独立服务层探针：隔离 Unix socket 和临时工作区，绝不连接真实服务。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ProductionStudio } from '../../../apps/studio/src/server/production-studio.ts';
import { CodexBridgeClient, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } from '../../../packages/production-pipeline/src/codex-chat.ts';
import { productionWorkflowVersion } from '../../../packages/production-pipeline/src/production-pipeline.ts';

async function fixture(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vf-r3-service-probe-'));
  const socketPath = path.join(workspace, 'broker.sock');
  let operation;
  let queryState = 'running';
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify({ protocolVersion: 'video-factory/codex-bridge-v2', taskBindingVersion: 'video-factory/task-binding-v1',
        storeId: `vfs_store_${'c'.repeat(32)}`, providerId: 'openai', modelId: 'fixture', taskKinds: ['script-draft'],
        taskContracts: { 'script-draft': REQUIRED_CODEX_TASK_CONTRACT_DIGESTS['script-draft'] } }));
      return;
    }
    if (req.method === 'POST') { posts++; res.writeHead(500); res.end(); return; }
    if (queryState === 'query_failure') { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({ state: queryState, requestId: operation.requestId, binding: operation.binding,
      ...(queryState === 'completed_failure' ? { outcome: { stage: 'execute', message: 'Provider unavailable', reason: 'model_provider_transient' } } : {}) }));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(workspace, { recursive: true, force: true }); });
  operation = await new CodexBridgeClient({ socketPath }).prepareTask('script-draft', { brief: { title: '隔离验证' } }, 'original-task');
  const directory = path.join(workspace, 'runs', 'review-run', 'nodes', 'creative-planning', 'agent-loop-checkpoints');
  await mkdir(directory, { recursive: true });
  const key = 'd'.repeat(64);
  await writeFile(path.join(directory, `${key}.json`), JSON.stringify({
    version: 'video-factory/agent-loop-checkpoint-v8', key, contractDigest: 'fixture', role: '编剧', maxIterations: 3,
    cycle: 0, status: 'failed', completed: [], operationGenerations: { '0:1:produce': 0 }, phaseAttempts: { produce: 1, audit: 0 },
    recoveryOwner: { runId: 'review-run', nodeId: 'creative-planning', workflowOperationRequestId: 'current-operation' },
    pendingOperation: { phase: 'produce', iteration: 1, operationKey: '0:1:produce', generation: 0, operation },
  }));
  const run = { id: 'review-run', revision: 1, workflowId: 'daily-production', workflowVersion: '1.0.0', status: 'failed',
    startedAt: '2026-09-12T10:00:00.000Z', finishedAt: '2026-09-12T10:01:00.000Z',
    initialInput: { protocolVersion: 'video-factory/brief-v1', title: '隔离验证', angle: '说明流程', audience: '创作者', nicheSlug: 'life', platform: 'douyin',
      durationSeconds: 24, reviewMode: 'manual', runPurpose: 'test', economics: { recipeId: 'economy-daily', allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
      durationRange: { minSeconds: 20, maxSeconds: 34 }, workflowFeatures: { creativePlanning: 'joint-v1', executablePlan: true, assetSemanticRank: false, referenceGrammar: false },
      director: { profileId: 'auto', assetProviderIds: ['local-editorial-v1'] },
      providers: { script: 'codex-screenwriter-v1', director: 'api-visual-director-v1', assets: 'ai-shot-router-v1', voice: 'macos-say-v1', render: 'python-ffmpeg-v1', technicalReview: 'python-technical-review-v1' } },
    nodeRuns: [{ nodeId: 'creative-planning', status: 'failed', artifactIds: [], qualityGateResults: [], operationRequestId: 'current-operation', error: '模型任务结果未知' }],
    artifacts: [], interventions: [], decisions: [],
  };
  run.workflowVersion = productionWorkflowVersion(run.initialInput);
  const pipeline = { show: async () => structuredClone(run), loadPersisted: async () => structuredClone(run), list: async () => [structuredClone(run)], pauseRequested: async () => false };
  const studio = new ProductionStudio({ workspaceRoot: workspace, pipeline, archiveStore: { list: async () => ({}) }, listProviders: async () => [] });
  return { studio, setState: state => { queryState = state; }, receiptPath: path.join(directory, '..', 'text-task-recovery.json'), get posts() { return posts; } };
}

test('R3-F03: a completed-failure query must expose a way out of query-only dead end', async t => {
  const f = await fixture(t);
  f.setState('completed_failure');
  const result = await f.studio.queryOriginalTextTask('review-run');
  console.log(JSON.stringify({ probe: 'terminal-failure', recovery: result.taskRecovery }));
  assert.equal(result.taskRecovery.taskState, 'completed_failure');
  await assert.rejects(() => f.studio.retryFailedNode('review-run', 'creative-planning'), /请先查询原任务/);
  await assert.rejects(() => f.studio.retrieveOriginalTextTask('review-run'), /请先查询原任务/);
  assert.equal(f.posts, 0);
  assert.ok(result.taskRecovery.allowedActions.some(action => action !== 'query_original_task'), '已确证失败却只允许重复查询，重试和取回均被拒绝');
});

test('R3-F04: failed observation must not replace the last verified time with now', async t => {
  const f = await fixture(t);
  const first = await f.studio.queryOriginalTextTask('review-run');
  assert.equal(first.taskRecovery.taskState, 'running');
  const prior = JSON.parse(await readFile(f.receiptPath, 'utf8'));
  await delay(20);
  f.setState('query_failure');
  const second = await f.studio.queryOriginalTextTask('review-run');
  const after = JSON.parse(await readFile(f.receiptPath, 'utf8'));
  assert.equal(second.taskRecovery.taskState, 'running');
  assert.ok(second.taskRecovery.observationError);
  console.log(JSON.stringify({ probe: 'last-verified-time', before: prior, after, dto: second.taskRecovery }));
  assert.equal(after.lastVerifiedAt ?? after.observedAt, prior.lastVerifiedAt ?? prior.observedAt, '查询失败不能刷新历史 running 的可信时间');
});
