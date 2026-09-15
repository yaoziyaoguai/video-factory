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
  let holdRunning = false;
  let releaseRunning;
  let markRunningHeld;
  let runningHeld = new Promise(resolve => { markRunningHeld = resolve; });
  let runningRelease = new Promise(resolve => { releaseRunning = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify({ protocolVersion: 'video-factory/codex-bridge-v2', taskBindingVersion: 'video-factory/task-binding-v1',
        storeId: `vfs_store_${'c'.repeat(32)}`, providerId: 'openai', modelId: 'fixture', taskKinds: ['script-draft'],
        taskContracts: { 'script-draft': REQUIRED_CODEX_TASK_CONTRACT_DIGESTS['script-draft'] } }));
      return;
    }
    if (req.method === 'POST') { posts++; res.writeHead(500); res.end(); return; }
    const responseState = queryState;
    if (holdRunning && responseState === 'running') {
      holdRunning = false;
      markRunningHeld();
      await runningRelease;
    }
    if (responseState === 'query_failure') { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({ state: responseState, requestId: operation.requestId, binding: operation.binding,
      ...(responseState === 'completed_failure' ? { outcome: { stage: 'execute', message: 'Provider unavailable', reason: 'model_provider_transient' } } : {}) }));
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
  return {
    workspace,
    run,
    studio,
    setState: state => { queryState = state; },
    holdNextRunning: () => {
      holdRunning = true;
      runningHeld = new Promise(resolve => { markRunningHeld = resolve; });
      runningRelease = new Promise(resolve => { releaseRunning = resolve; });
    },
    waitUntilRunningHeld: () => runningHeld,
    releaseHeldRunning: () => releaseRunning(),
    receiptPath: path.join(directory, '..', 'text-task-recovery.json'),
    get posts() { return posts; },
  };
}

import {fork} from 'node:child_process';
function worker(t) {
  const child=fork(new URL('./r4-receipt-child.mjs', import.meta.url),[],{cwd:process.cwd(),stdio:['ignore','ignore','inherit','ipc']});
  t.after(()=>{if(child.connected)child.kill();});
  const buffered = new Map();
  const waiting = new Map();
  child.on('message',m=>{const resolve=waiting.get(m.type);if(resolve){waiting.delete(m.type);resolve(m);}else buffered.set(m.type,m);});
  return {child,wait:type=>buffered.has(type)?Promise.resolve(buffered.get(type)):new Promise(resolve=>waiting.set(type,resolve))};
}
test('R4-F03: concurrent processes must not overwrite terminal receipt with stale running', {timeout:10000}, async t=>{
  const f=await fixture(t);
  f.holdNextRunning();
  const old=worker(t);
  old.child.send({workspace:f.workspace,run:f.run});
  await f.waitUntilRunningHeld();
  f.setState('completed_failure');
  const next=worker(t);
  next.child.send({workspace:f.workspace,run:f.run});
  const terminal=await next.wait('done');
  assert.equal(terminal.error,undefined);
  assert.equal(terminal.state,'completed_failure');
  f.releaseHeldRunning();
  const stale=await old.wait('done');
  assert.equal(stale.error,undefined);
  const persisted=JSON.parse(await readFile(f.receiptPath,'utf8'));
  console.log(JSON.stringify({probe:'receipt-race',terminal,stale,persistedState:persisted.taskState,posts:f.posts}));
  assert.equal(f.posts,0);
  assert.equal(persisted.taskState,'completed_failure','旧 running 在 read/merge 后延迟落盘，不得覆盖另一个进程已经写入的终态');
});
