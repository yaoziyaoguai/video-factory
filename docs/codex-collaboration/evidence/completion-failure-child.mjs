// 子进程故障注入，只写调用者提供的 mkdtemp 目录，不读取任何真实工作区数据。
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexBrokerServer } from '../../../apps/codex-broker/src/broker-server.ts';
import { taskContractDescriptorFor } from '../../../apps/codex-broker/src/task-definitions.ts';
const dir = process.argv[2];
const socket = path.join(dir, 'child.sock');
const records = path.join(dir, 'records');
const contract = taskContractDescriptorFor('topic-ideas');
let release;
const gate = new Promise(resolve => { release = resolve; });
const executor = {
  identity: { profileId: 'audit', providerId: 'openai', modelId: 'test', taskKinds: ['topic-ideas'] },
  async runTask(task) {
    await gate;
    return { output: '{"ideas":[]}', trace: { taskKind: task.kind, promptVersion: contract.promptVersion,
      contractDigest: contract.digest, prompt: 'fixture', providerId: 'openai', modelId: 'test' } };
  },
};
const server = new CodexBrokerServer({ socketPath: socket, executor, idempotencyDirectory: records });
await server.start();
const body = JSON.stringify({ protocolVersion: 'video-factory/codex-bridge-v2', requestId: 'commit-failure',
  kind: 'topic-ideas', payload: { signals: [] }, expectedContractDigest: contract.digest });
const status = await new Promise((resolve, reject) => {
  const req = http.request({ socketPath: socket, path: '/v1/tasks', method: 'POST', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
    res.resume(); res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject); req.end(body);
});
if (status !== 202) throw new Error('Fixture must receive accepted before injecting persistence failure');
const record = path.join(records, createHash('sha256').update('commit-failure').digest('hex') + '.json');
await rm(record);
await mkdir(record); // 让 completed rename 失败，模拟磁盘/权限写入失败的受控等价边界。
release();
await delay(150);
await server.close();
process.stdout.write('Broker survived completion persistence fault\n');
