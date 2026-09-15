// 隔离复审探针：不接正式 Studio，不调用真实模型或媒体，不改用户运行数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { RunWorkbench } from '../../../apps/studio/src/client/components/RunWorkbench.tsx';
import { CodexBrokerServer } from '../../../apps/codex-broker/src/broker-server.ts';
import { taskContractDescriptorFor } from '../../../apps/codex-broker/src/task-definitions.ts';
import { CodexBridgeClient } from '../../../packages/production-pipeline/src/codex-chat.ts';
import { requiresUnsupportedGeneratedIdentity } from '../../../packages/production-pipeline/src/visual-evidence-boundary.ts';

globalThis.React = React;

test('R3-UI: running tasks expose the server-authorized original-task query', () => {
  const run = {
    id: 'isolated-running-recovery', title: '恢复测试', status: 'running',
    platform: 'douyin', durationSeconds: 30, startedAt: '2026-09-12T10:00:00Z',
    currentNodeId: 'creative-planning', revision: 4, angle: '原任务恢复', audience: '创作者',
    nicheSlug: 'recovery', reviewMode: 'manual',
    nodes: [{ id: 'creative-planning', label: '制作方案', status: 'running', artifactIds: [], qualityGateResults: [] }],
    artifacts: [], decisions: [],
    taskRecovery: { nodeId: 'creative-planning', phase: 'produce', taskState: 'accepted_unknown',
      summary: '请查询原任务', resultAvailable: false, allowedActions: ['query_original_task'] },
  };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, null,
    React.createElement(RunWorkbench, { run, decisionPending: false,
      onDecision: async () => {}, onQueryOriginalTextTask: async () => {} })));
  assert.match(html, /查询原任务/, 'running 状态不能隐藏服务端允许的恢复动作');
});

test('R3-OBSERVE: a healthy running task is not described as a broken connection', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vf-r3-review-'));
  const socketPath = path.join(directory, 'broker.sock');
  const contract = taskContractDescriptorFor('topic-ideas');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let prepared;
  let calls = 0;
  const server = new CodexBrokerServer({ socketPath,
    idempotencyDirectory: path.join(directory, 'records'),
    executor: {
      identity: { profileId: 'openai', providerId: 'openai', modelId: 'isolated-review', taskKinds: ['topic-ideas'] },
      async runTask() {
        calls++;
        await gate;
        return { output: '{"ideas":[]}', trace: { taskKind: 'topic-ideas', prompt: 'fixture',
          promptVersion: contract.promptVersion, contractDigest: contract.digest,
          providerId: 'openai', modelId: 'isolated-review' } };
      },
    },
  });
  let submission;
  t.after(async () => {
    release();
    await submission;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await server.start();
  const client = new CodexBridgeClient({ socketPath, timeoutMs: 1000, pollIntervalMs: 10 });
  submission = client.runTaskDetailed('topic-ideas', { signals: [] }, 'running-observation', undefined,
    { beforeSubmit: async operation => { prepared = operation; } }).catch(error => error);
  for (let i = 0; i < 100 && calls === 0; i++) await delay(2);
  assert.equal(calls, 1, '前置条件：任务已经实际执行，网络没有断开');
  let error;
  try { await client.observePrepared(prepared, { timeoutMs: 40 }); }
  catch (caught) { error = caught; }
  assert.ok(error, '短观察期限结束，但原模型仍等待屏障');
  assert.doesNotMatch(error.creatorMessage, /连接中断/, '观察期限结束不得编造连接故障');
});

test('R3-SEMANTIC: explicit non-identity statements are not identity requirements', () => {
  const independentStatements = [
    '独立生成仅承诺母题一致而非精确同一人物',
    '只延续色彩母题，并非同一人物',
    '无需同一人物，各段独立表达',
  ];
  const rejected = independentStatements.filter(text => requiresUnsupportedGeneratedIdentity([text]));
  assert.deepEqual(rejected, [], '否定关系不能按人物关键词硬拒绝');
  assert.equal(requiresUnsupportedGeneratedIdentity(['每段必须保持同一人物']), true,
    '修正否定误判不能放行真正的身份要求');
});
