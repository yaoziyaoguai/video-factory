import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// 仅在隔离 socket/store 中验证正式边界；唯一外部传输由本地函数替代，不读取真实凭据。
const layer = process.env.VF_REVIEW_DIST === '1' ? 'dist' : 'src';
const ext = layer === 'dist' ? 'js' : 'ts';
const root = new URL('../../../', import.meta.url);
const load = (p) => import(new URL(p, root));
const { CodexBrokerServer } = await load(`apps/codex-broker/${layer}/broker-server.${ext}`);
const { codexExecutorProfileFor } = await load(`apps/codex-broker/${layer}/codex-executor.${ext}`);
const { BROKER_TASK_KINDS, taskContractDescriptorFor } = await load(`apps/codex-broker/${layer}/task-definitions.${ext}`);
const { ZaiCodePlanExecutor } = await load(`apps/codex-broker/${layer}/zai-code-plan-executor.${ext}`);
const { CodexBridgeClient, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } = await load(`packages/production-pipeline/${layer}/codex-chat.${ext}`);
const { CodexPublishCopyWriter } = await load(`packages/production-pipeline/${layer}/codex-publish-copy.${ext}`);
const { CodexAssetSemanticRanker } = await load(`packages/production-pipeline/${layer}/asset-semantic-ranker.${ext}`);
const { readCodexProviderSettings, readZaiCodexProviderSettings } = await load(`apps/studio/${layer === 'dist' ? 'dist/server/server' : 'src/server'}/codex-provider-settings.${ext}`);

async function withBroker(executor, check) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vf-r6-contract-review-'));
  const socketPath = path.join(directory, 'worker.sock');
  const server = new CodexBrokerServer({
    socketPath, executor,
    idempotencyDirectory: path.join(directory, 'durable'),
    sessionDirectory: path.join(directory, 'sessions'),
  });
  try {
    await server.start();
    await check(server, socketPath);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const passAudit = { version: 'video-factory/role-audit-v1', verdict: 'pass', score: 90, summary: '证据与报告一致。', issues: [], repairInstructions: [], planningDisposition: null };
for (const variant of ['text-audit', 'image-audit', 'rank-without-thumbnail']) {
  test(`${layer}: actual execution model equals immutable model binding (${variant})`, async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
    const kind = variant === 'rank-without-thumbnail' ? 'asset-rank' : 'role-audit';
    let selectedModel, calls = 0, prepared;
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: 'isolated-test-only-not-a-credential' },
      fetchFn: async (_url, init) => {
        calls++;
        selectedModel = JSON.parse(init.body).model;
        const output = kind === 'role-audit' ? passAudit : {version:'video-factory/asset-ranking-v1', source:'model', providerId:'zai-bigmodel-api', modelId:selectedModel, summary:'没有候选，不能据此采用素材。', scenes:[]};
        return new Response(JSON.stringify({choices:[{finish_reason:'stop', message:{content:JSON.stringify(output)}}]}), {status:200});
      },
    });
    await withBroker(executor, async (_server, socketPath) => {
      const client = new CodexBridgeClient({socketPath, timeoutMs:4000, maxAttempts:1, pollIntervalMs:10});
      const payload = kind === 'asset-rank' ? {version:'video-factory/asset-candidates-v1', scenes:[], thumbnails:[]} : {
        role:'审片报告复核', iteration:1, criteria:['以原始画面证据评价报告'], context:{}, candidate:{summary:'待复核报告'},
        ...(variant === 'image-audit' ? {images:[{imageIndex:1, sha256:createHash('sha256').update(jpeg).digest('hex'), jpegBase64:jpeg.toString('base64')}]} : {}),
      };
      const result = await client.runTaskDetailed(kind, payload, undefined, undefined, {beforeSubmit:async op => {prepared=structuredClone(op);}});
      console.log(JSON.stringify({layer, variant, calls, boundModel:prepared.binding.modelId, actualModel:selectedModel, traceModel:result.trace.modelId, returned:'success'}));
      assert.equal(calls,1);
      assert.equal(result.trace.modelId, selectedModel);
      assert.equal(prepared.binding.modelId, selectedModel, 'accepted identity must match the model that really executed');
    });
  });
}

test(`${layer}: formal ranking adapter persists accepted operation before it can time out`, async () => {
  let release, stored, calls=0;
  const gate = new Promise(resolve => {release=resolve;});
  const executor = {
    identity:codexExecutorProfileFor('openai').identity,
    async runTask(task) {
      calls++;
      await gate;
      return {output:JSON.stringify({version:'video-factory/asset-ranking-v1', source:'model', providerId:'openai', modelId:'codex-default', summary:'没有候选', scenes:[]}), trace:{taskKind:task.kind, promptVersion:'isolated-test', prompt:'isolated-test', providerId:'openai', modelId:'codex-default', contractDigest:taskContractDescriptorFor(task.kind).digest}};
    },
  };
  try {
    await withBroker(executor, async (server,socketPath) => {
      try {
        const ranker = new CodexAssetSemanticRanker({client:new CodexBridgeClient({socketPath, timeoutMs:200, maxAttempts:1, pollIntervalMs:10})});
        await assert.rejects(() => ranker.rankDetailed({version:'video-factory/asset-candidates-v1', scenes:[]}, {
          key:'isolated-ranking', load:async()=>stored, save:async value => {stored=structuredClone(value);},
        }));
        console.log(JSON.stringify({layer, probe:'ranking-checkpoint', calls, active:server.healthReport().active, pendingOperation:stored?.pendingOperation ?? null, attempts:stored?.attemptedRequestIds.length}));
        assert.equal(calls,1);
        assert.ok(stored?.pendingOperation?.operation, 'accepted ranking must have a restorable request snapshot');
      } finally {release();}
    });
  } finally {release();}
});

test('all ten canonical descriptors match pipeline pins', () => {
  assert.deepEqual(Object.keys(REQUIRED_CODEX_TASK_CONTRACT_DIGESTS).sort(), [...BROKER_TASK_KINDS].sort());
  for (const kind of BROKER_TASK_KINDS) {
    assert.equal(taskContractDescriptorFor(kind).digest, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS[kind]);
  }
});

for (const profile of ['openai', 'zai']) {
  for (const subset of [false, true]) {
    test(`${layer}: formal ${profile} health is accepted by Studio (${subset ? 'subset' : 'all tasks'})`, async () => {
      let executions = 0;
      const identity = codexExecutorProfileFor(profile).identity;
      if (subset) identity.taskKinds = ['script-draft', 'role-audit'];
      await withBroker({ identity, async runTask() { executions++; throw new Error('health must not execute'); } }, async (server, socketPath) => {
        const health = server.healthReport();
        const probe = profile === 'openai' ? readCodexProviderSettings : readZaiCodexProviderSettings;
        const settings = await probe({
          VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath,
          VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH: socketPath,
        });
        const missing = health.taskKinds.filter(kind => health.taskContracts[kind] !== REQUIRED_CODEX_TASK_CONTRACT_DIGESTS[kind]);
        console.log(JSON.stringify({layer, profile, subset, tasks: health.taskKinds.length, digests: Object.keys(health.taskContracts).length, missing, available: settings.available, reason: settings.reason, executions}));
        assert.equal(executions, 0);
        assert.equal(settings.available, true, 'formal Broker health must satisfy formal Studio probe');
        assert.deepEqual(Object.keys(health.taskContracts).sort(), [...health.taskKinds].sort());
      });
    });
  }
}

for (const platform of ['douyin', 'shipinhao', 'kuaishou', 'xiaohongshu', 'bilibili', 'unknown-platform']) {
  test(`${layer}: publish-copy ${platform} survives real writer/client/parser/executor/result binding`, async () => {
    let transportCalls = 0;
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: 'isolated-test-only-not-a-credential' },
      fetchFn: async () => {
        transportCalls++;
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          title: '观察光线的方向', description: '同一物体在不同方向光线下的可见变化。', hashtags: ['光线', '观察', '影像'],
        }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await withBroker(executor, async (_server, socketPath) => {
      const writer = new CodexPublishCopyWriter({ client: new CodexBridgeClient({socketPath, timeoutMs: 4000, maxAttempts: 1}) });
      let output, failure;
      try {
        output = await writer.write({ platform, brief: { title: '光线观察', angle: '观察光线方向', audience: '初学者', nicheSlug: 'visual-learning' }, narrations: ['观察光线照射方向。', '比较同一物体的可见变化。', '总结观察到的区别。'] });
      } catch (error) { failure = error; }
      console.log(JSON.stringify({layer, platform, transportCalls, canonicalDigest: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS['publish-copy'], executionDigest: taskContractDescriptorFor('publish-copy', platform).digest, error: failure?.message, stage: failure?.stage}));
      assert.equal(transportCalls, 1);
      assert.equal(failure, undefined, 'a valid platform-specific output must not fail contract binding');
      assert.equal(output.title, '观察光线的方向');
    });
  });
}
