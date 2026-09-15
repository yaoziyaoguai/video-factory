// 只运行隔离审计：真实 Broker/client + 临时目录 + 受控 executor，不调用模型或媒体。
// 断言目标是应有行为；初始审计预期失败。执行端需把修复对应测试纳入正式套件。
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexBrokerServer } from '../../../apps/codex-broker/src/broker-server.ts';
import { CodexBridgeClient, CodexBridgeError } from '../../../packages/production-pipeline/src/codex-chat.ts';
import { taskContractDescriptorFor } from '../../../apps/codex-broker/src/task-definitions.ts';
import { isModelProviderFailure } from '../../../packages/production-pipeline/src/model-fallback.ts';
import { formatTopicStrategy } from '../../../apps/studio/src/server/topic-ideas-payload.ts';

const thread = '11111111-2222-3333-4444-555555555555';
const contract = taskContractDescriptorFor('topic-ideas');
const payload = { signals: [{ id: 'audit-signal', platform: 'test', rank: 1, title: '审计输入' }] };
const digestPath = (dir, id) => path.join(dir, createHash('sha256').update(id).digest('hex') + '.json');

function request(socketPath, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const wire = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, method, path: url, agent: false,
      signal: AbortSignal.timeout(3000),
      headers: { ...headers, ...(wire ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) } : {}) },
    }, res => {
      const parts = [];
      res.on('data', p => parts.push(p));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(wire);
  });
}

async function setup(t, run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vf-audit-'));
  const socket = path.join(dir, 'b.sock');
  const records = path.join(dir, 'records');
  const sessions = path.join(dir, 'sessions');
  const calls = [];
  const executor = {
    identity: { profileId: 'audit', providerId: 'openai', modelId: 'audit-test', taskKinds: ['topic-ideas'] },
    async runTask(task, options) {
      calls.push({ task, sessionId: options?.sessionId });
      if (run) return run(task, options);
      await delay(15);
      return { output: '{"ideas":[]}', sessionId: thread,
        trace: { taskKind: task.kind, promptVersion: contract.promptVersion,
          contractDigest: contract.digest, prompt: 'audit fixture', providerId: 'openai', modelId: 'audit-test' } };
    },
  };
  const broker = new CodexBrokerServer({ socketPath: socket, executor,
    idempotencyDirectory: records, sessionDirectory: sessions, concurrency: 16, maxBacklog: 32 });
  await broker.start();
  t.after(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
  const client = new CodexBridgeClient({ socketPath: socket, timeoutMs: 1500, pollIntervalMs: 10, maxAttempts: 1 });
  const post = (id, extra = {}) => request(socket, 'POST', '/v1/tasks', {
    protocolVersion: 'video-factory/codex-bridge-v2', requestId: id, kind: 'topic-ideas',
    payload, expectedContractDigest: contract.digest, ...extra,
  });
  const get = (id, binding) => request(socket, 'GET', '/v1/tasks/' + id, undefined,
    binding ? bindingHeaders(binding) : {});
  const complete = async accepted => {
    const { requestId, binding } = accepted.body;
    for (let i = 0; i < 150; i++) {
      const reply = await get(requestId, binding);
      if (reply.body.state === 'completed_success' || reply.body.state === 'completed_failure') return reply;
      await delay(10);
    }
    throw new Error('Fixture completion deadline exceeded');
  };
  return { dir, socket, records, sessions, client, broker, calls, post, get, complete };
}

test('P01: poll completion preserves the producer session handle', async t => {
  const b = await setup(t);
  const result = await b.client.runTaskDetailed('topic-ideas', payload, 'audit-session', { key: 'producer-key' });
  const record = JSON.parse(await readFile(digestPath(b.records, 'audit-session'), 'utf8'));
  assert.match(record.outcome.sessionHandle, /^vfs_/);
  assert.equal(result.session?.handle, record.outcome.sessionHandle);
});

test('P02: concurrent identical POSTs execute exactly once', async t => {
  const b = await setup(t);
  const accepted = await Promise.all(Array.from({ length: 12 }, () => b.post('audit-concurrent')));
  await b.complete(accepted[0]);
  // 等待这一批已进入 executor 的调用结清后再计数，不在预检时采样。
  await delay(30);
  assert.equal(b.calls.length, 1, 'same physical request must not execute twice');
});

test('P03: query without immutable binding does not disclose a completed outcome', async t => {
  const b = await setup(t);
  const accepted = await b.post('audit-binding');
  await b.complete(accepted);
  const observation = await b.get('audit-binding');
  assert.ok(observation.status >= 400 && observation.status < 500,
    'requestId-only query must require original binding, not return someone else\'s outcome');
});

test('P04: an orphan accepted record is unknown, not eternally running', async t => {
  const b = await setup(t);
  await mkdir(b.records, { recursive: true });
  await writeFile(digestPath(b.records, 'audit-orphan'), JSON.stringify({ version: 1,
    requestId: 'audit-orphan', digest: 'a'.repeat(64), state: 'accepted' }));
  const prepared = await b.client.prepareTask('topic-ideas', payload, 'audit-orphan');
  await assert.rejects(() => b.client.observePrepared(prepared, { timeoutMs: 50 }),
    error => error instanceof CodexBridgeError && error.stage === 'uncertain');
  assert.equal(b.calls.length, 0);
});

test('P05: observation connection loss after accepted must not become not_accepted', async t => {
  const b = await setup(t);
  const observerSocket = path.join(b.dir, 'observer.sock');
  let postCount = 0;
  const proxy = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { req.socket.destroy(); return; }
    postCount++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const posted = await request(b.socket, 'POST', '/v1/tasks', JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(posted.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(posted.body));
    proxy.close(); // 仅关闭测试观察入口，真实 Broker 继续执行原任务。
  });
  await new Promise(resolve => proxy.listen(observerSocket, resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const client = new CodexBridgeClient({ socketPath: observerSocket, timeoutMs: 300, pollIntervalMs: 10, maxAttempts: 1 });
  let caught;
  try { await client.runTaskDetailed('topic-ideas', payload, 'audit-observe-down'); }
  catch (e) { caught = e; }
  assert.equal(postCount, 1);
  assert.equal(b.calls.length, 1);
  assert.ok(caught instanceof CodexBridgeError);
  assert.equal(caught.stage, 'uncertain', 'failed observation is not evidence that the accepted task never ran');
});

test('P06: persisted terminal failure stays completed_failure even with HTTP 500 outcome', async t => {
  const b = await setup(t, async () => { throw new Error('executor terminal failure fixture'); });
  let caught;
  try { await b.client.runTaskDetailed('topic-ideas', payload, 'audit-terminal'); }
  catch (e) { caught = e; }
  const record = JSON.parse(await readFile(digestPath(b.records, 'audit-terminal'), 'utf8'));
  assert.equal(record.state, 'completed');
  assert.equal(record.outcome.ok, false);
  assert.equal(caught?.stage, 'completed_failure');
});

test('P07: GET restores missing derived session registry from completed evidence', async t => {
  const b = await setup(t);
  const accepted = await b.post('audit-session-restore', { sessionKey: 'restore-key' });
  await b.complete(accepted);
  await delay(20);
  const record = JSON.parse(await readFile(digestPath(b.records, 'audit-session-restore'), 'utf8'));
  const sessionPath = digestPath(b.sessions, record.sessionRecord.handle);
  await rm(sessionPath); // 仅删除 mkdtemp 创建的测试记录。
  await b.get('audit-session-restore', accepted.body.binding);
  assert.equal(b.calls.length, 1);
  await access(sessionPath);
});

test('P08: rejected/conflict stages cannot fall back based on generic network details', () => {
  for (const stage of ['rejected', 'conflict']) {
    const e = new CodexBridgeError('fixture failure', false, stage, stage === 'rejected' ? 400 : 409,
      undefined, { category: 'network', reasonCode: 'fixture', providerId: 'openai', modelId: 'test' });
    assert.equal(isModelProviderFailure(e), false, `${stage} must be terminal before category heuristics`);
  }
});

test('P09: a valid long preference retains positioning and audience', () => {
  const text = formatTopicStrategy({ positioning: '产品定位：摄影入门', targetAudience: '目标人群：新手',
    preferredDirections: '', excludedDirections: '', sourcePolicy: 'primary_or_two_independent',
    customInstruction: '条'.repeat(1990) });
  assert.equal(text.includes('产品定位：摄影入门'), true, 'accepted positioning must reach the model');
  assert.equal(text.includes('目标人群：新手'), true, 'accepted audience must reach the model');
});

test('P10: lost acceptance response reconciles the original task before returning', async t => {
  const b = await setup(t);
  const socket = path.join(b.dir, 'drop.sock');
  let posts = 0;
  let queries = 0;
  const proxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const forwarded = await request(b.socket, req.method, req.url, body,
      Object.fromEntries(Object.entries(req.headers).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])));
    if (req.method === 'POST') { posts++; res.destroy(); return; }
    queries++;
    res.writeHead(forwarded.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(forwarded.body));
  });
  await new Promise(resolve => proxy.listen(socket, resolve));
  t.after(() => new Promise(resolve => proxy.close(() => resolve())));
  const client = new CodexBridgeClient({ socketPath: socket, timeoutMs: 500, pollIntervalMs: 10 });
  let result;
  try { result = await client.runTaskDetailed('topic-ideas', payload, 'audit-lost-accept'); } catch {}
  assert.equal(posts, 1);
  assert.equal(b.calls.length, 1);
  assert.ok(queries > 0, 'the accepted original task must be observed after loss of POST response');
  assert.deepEqual(result?.output, { ideas: [] });
});

test('P11: completed response for a different requestId is rejected', async t => {
  const b = await setup(t);
  const socket = path.join(b.dir, 'wrong.sock');
  const proxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const forwarded = await request(b.socket, req.method, req.url, body,
      Object.fromEntries(Object.entries(req.headers).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])));
    if (forwarded.body.state === 'completed_success') forwarded.body.requestId = 'unrelated-request';
    res.writeHead(forwarded.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(forwarded.body));
  });
  await new Promise(resolve => proxy.listen(socket, resolve));
  t.after(() => new Promise(resolve => proxy.close(() => resolve())));
  const client = new CodexBridgeClient({ socketPath: socket, timeoutMs: 500, pollIntervalMs: 10 });
  await assert.rejects(() => client.runTaskDetailed('topic-ideas', payload, 'audit-right-id'),
    error => error instanceof CodexBridgeError && error.stage === 'conflict');
});

function bindingHeaders(binding) {
  return {
    'x-video-factory-binding-version': String(binding.version),
    'x-video-factory-store-id': String(binding.storeId),
    'x-video-factory-provider-id': String(binding.providerId),
    'x-video-factory-model-id': String(binding.modelId),
    'x-video-factory-request-digest': String(binding.requestDigest),
    'x-video-factory-task-kind': String(binding.kind),
    'x-video-factory-contract-digest': binding.contractDigest === null ? 'none' : String(binding.contractDigest),
    'x-video-factory-session-digest': String(binding.sessionDigest),
  };
}

test('P12: background completion persistence failure does not crash the broker process', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vf-audit-child-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const childPath = fileURLToPath(new URL('./completion-failure-child.mjs', import.meta.url));
  const outcome = await new Promise(resolve => execFile(process.execPath, ['--import', 'tsx', childPath, dir],
    { timeout: 4000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(outcome.code, 0, outcome.stderr);
});
