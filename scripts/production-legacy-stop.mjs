#!/usr/bin/env node
// 仅由 cold-upgrade 对已锁定的旧镜像执行；不提供表达式、PID 或调试地址参数。
import fs from 'node:fs';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const MAIN = 'apps/studio/dist/server/server/main.js';
const WORKSPACE = '/data/factory';
const DEBUG_PORT = 9229;
const LEASE_MS = 15_000;

function fail(message) { throw new Error(message); }

export function pid1Identity(procRoot = '/proc') {
  const stat = fs.readFileSync(`${procRoot}/1/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!/^1 \(node\) /.test(stat) || fields[1] !== '0' || !/^\d+$/.test(fields[19] ?? '')) fail('Expected Node PID1.');
  const argv = fs.readFileSync(`${procRoot}/1/cmdline`, 'utf8').split('\0').filter(Boolean);
  if (argv.length !== 2 || !['node', '/usr/local/bin/node'].includes(argv[0]) || argv[1] !== MAIN
    || fs.readlinkSync(`${procRoot}/1/cwd`) !== '/app'
    || fs.readlinkSync(`${procRoot}/1/exe`) !== '/usr/local/bin/node') fail('Unexpected legacy app entrypoint.');
  return {
    startTime: fields[19], bootId: fs.readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim(),
    cgroup: fs.readFileSync(`${procRoot}/1/cgroup`, 'utf8'),
  };
}

export function assertLegacyIdle(helperPid, procRoot = '/proc', workspace = WORKSPACE) {
  if (!Number.isInteger(helperPid) || helperPid <= 1) fail('Invalid helper identity.');
  const runs = fs.lstatSync(`${workspace}/runs`);
  if (!runs.isDirectory() || runs.isSymbolicLink() || fs.readdirSync(`${workspace}/runs`).length) fail('Legacy stop requires an empty runs directory.');
  const others = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name) && ![1, helperPid].includes(Number(name)));
  if (others.length) fail('Legacy app has another process or child.');
  for (const tid of fs.readdirSync(`${procRoot}/1/task`)) {
    if (fs.readFileSync(`${procRoot}/1/task/${tid}/children`, 'utf8').trim()) fail('Legacy app has children.');
  }
  for (const fd of fs.readdirSync(`${procRoot}/1/fd`)) {
    let target;
    try { target = fs.readlinkSync(`${procRoot}/1/fd/${fd}`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (target === workspace || target.startsWith(`${workspace}/`)) fail('Legacy app has an open workspace file.');
  }
}

function tcpListeners(procRoot = '/proc') {
  const listeners = [];
  for (const name of ['tcp', 'tcp6']) {
    for (const line of fs.readFileSync(`${procRoot}/1/net/${name}`, 'utf8').trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, port] = fields[1].split(':');
      if (fields[3] === '0A') listeners.push({ address, port: parseInt(port, 16), inode: fields[9] });
    }
  }
  return listeners;
}

export function debugListeners(procRoot = '/proc') {
  return tcpListeners(procRoot).filter((listener) => listener.port === DEBUG_PORT);
}

function pid1Descriptors() {
  return fs.readdirSync('/proc/1/fd').flatMap((fd) => {
    try { return [fs.readlinkSync(`/proc/1/fd/${fd}`)]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
}

function ownedDebugger() {
  const listeners = debugListeners();
  const inodes = pid1Descriptors();
  if (listeners.length !== 1 || listeners[0].address !== '0100007F'
    || !inodes.includes(`socket:[${listeners[0].inode}]`)) fail('Debugger is not exclusively owned by Node PID1 on loopback.');
}

// 函数源码作为固定 Runtime.evaluate 载荷；只允许一次有期限的 SIGTERM 回调。
// 旧 onClose 只清理 unref 恢复计时器；空 runs 和无本地执行是跳过该 hook 的必要前提。
export function installLegacyListener(expected) {
  const fs = process.getBuiltinModule('node:fs');
  const http = process.getBuiltinModule('node:http');
  const inspector = process.getBuiltinModule('node:inspector');
  // 无论后续核验成功与否都关闭本次调试口；客户端先断开，避免 close 等待自身会话。
  setTimeout(() => inspector.close(), 250).unref();
  const reject = (message) => { throw new Error(message); };
  const identity = () => {
    const stat = fs.readFileSync('/proc/1/stat', 'utf8');
    return {
      startTime: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19],
      bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      cgroup: fs.readFileSync('/proc/1/cgroup', 'utf8'),
    };
  };
  if (process.pid !== 1 || process.debugPort !== 9229 || process.cwd() !== '/app'
    || process.argv.length !== 2 || process.argv[1] !== '/app/apps/studio/dist/server/server/main.js'
    || process.env.VIDEO_FACTORY_WORKSPACE !== '/data/factory'
    || JSON.stringify(identity()) !== JSON.stringify(expected.identity)) reject('Legacy PID1 identity changed.');
  const key = Symbol.for('video-factory.cold-legacy-stop-once');
  if (process[key]) reject('Legacy stop has already been armed for this PID1.');
  if (process.listenerCount('SIGTERM') > 0) return { mode: 'native-handler' };
  const assertIdle = () => {
    if (JSON.stringify(identity()) !== JSON.stringify(expected.identity)) reject('Legacy PID1 identity changed.');
    const runs = fs.lstatSync('/data/factory/runs');
    if (!runs.isDirectory() || runs.isSymbolicLink() || fs.readdirSync('/data/factory/runs').length) reject('Legacy runs are not empty.');
    if (fs.readdirSync('/proc').some((name) => /^\d+$/.test(name) && ![1, expected.helperPid].includes(Number(name)))) reject('Legacy app has another process.');
    for (const tid of fs.readdirSync('/proc/1/task')) {
      if (fs.readFileSync(`/proc/1/task/${tid}/children`, 'utf8').trim()) reject('Legacy app has children.');
    }
    for (const fd of fs.readdirSync('/proc/1/fd')) {
      let target;
      try { target = fs.readlinkSync(`/proc/1/fd/${fd}`); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (target === '/data/factory' || target.startsWith('/data/factory/')) reject('Legacy workspace file is open.');
    }
    if (process._getActiveRequests().length) reject('Legacy app has an active I/O request.');
    const handles = process._getActiveHandles();
    const servers = handles.filter((handle) => typeof handle.listen === 'function' && handle.listening);
    if (servers.length !== 1 || !(servers[0] instanceof http.Server) || servers[0].address()?.port !== 4317) reject('Expected sole HTTP server on 4317.');
    const server = servers[0];
    for (const handle of handles) {
      if (handle === server) continue;
      if (handle.server === server || handle._server === server) {
        if (handle._httpMessage && !handle._httpMessage.writableFinished) reject('Legacy HTTP request is still active.');
      } else if (![0, 1, 2].includes(handle._handle?.fd) || handle.remoteAddress || handle.connecting) {
        reject('Legacy app has an unaccounted active handle.');
      }
    }
    return server;
  };
  const server = assertIdle();
  let lease;
  const onTerm = () => {
    clearTimeout(lease);
    try {
      if (assertIdle() !== server) reject('Legacy HTTP server changed.');
      server.close();
      server.closeIdleConnections();
    } catch {
      process.stderr.write('Cold legacy stop refused: app no longer idle.\n');
    }
  };
  Object.defineProperty(process, key, { value: true });
  process.once('SIGTERM', onTerm);
  lease = setTimeout(() => process.removeListener('SIGTERM', onTerm), 15_000);
  lease.unref();
  return { mode: 'legacy-once' };
}

function listTargets(timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: DEBUG_PORT, path: '/json/list', timeout: timeoutMs, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16_384) request.destroy(new Error('Debugger response too large.'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const targets = JSON.parse(body);
          if (response.statusCode !== 200 || !Array.isArray(targets) || targets.length !== 1) fail('Ambiguous debugger target.');
          const url = new URL(targets[0].webSocketDebuggerUrl);
          if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== String(DEBUG_PORT)
            || url.username || url.password || url.search || !/^\/[a-f0-9-]+$/.test(url.pathname)) fail('Unexpected debugger address.');
          resolve(url.href);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Debugger HTTP timeout.')));
    request.on('error', reject);
  });
}

async function evaluate(url, expression, timeoutMs) {
  if (typeof WebSocket !== 'function') fail('Legacy stop requires Node built-in WebSocket.');
  const client = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Debugger evaluation timeout.')), timeoutMs);
      const finish = (error, result) => { clearTimeout(timer); error ? reject(error) : resolve(result); };
      client.addEventListener('error', () => finish(new Error('Debugger connection failed.')), { once: true });
      client.addEventListener('close', () => finish(new Error('Debugger disconnected before response.')), { once: true });
      client.addEventListener('open', () => client.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, timeout: timeoutMs } })), { once: true });
      client.addEventListener('message', (event) => {
        try {
          const result = JSON.parse(String(event.data));
          if (result.id !== 1) return;
          if (result.error || result.result?.exceptionDetails) return finish(new Error('Legacy runtime validation refused.'));
          finish(null, result.result?.result?.value);
        } catch (error) { finish(error); }
      });
    });
  } finally {
    if (client.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) => client.addEventListener('close', resolve, { once: true }));
      client.close();
      await Promise.race([closed, sleep(500)]);
    }
  }
}

export async function armLegacyStop(expected) {
  if (process.platform !== 'linux' || process.pid === 1 || typeof WebSocket !== 'function') fail('Requires a separate Linux Node helper.');
  const identity = pid1Identity();
  if (identity.startTime !== expected.startTime || identity.bootId !== expected.bootId) fail('Legacy PID1 identity changed.');
  assertLegacyIdle(process.pid);
  if (debugListeners().length) fail('Refusing preexisting debugger.');
  const listeners = tcpListeners();
  // Docker 内置 DNS 可在 loopback 上另有监听；只接受不属于 PID1 的平台 socket。
  const owned = pid1Descriptors();
  const appListeners = listeners.filter((listener) => owned.includes(`socket:[${listener.inode}]`));
  if (appListeners.length !== 1 || appListeners[0].port !== 4317) fail('Refusing another app listener or preexisting debugger on a different port.');
  const end = Date.now() + 8_000;
  let enabled = false;
  let result;
  let failure;
  try {
    process.kill(1, 'SIGUSR1');
    enabled = true;
    while (!debugListeners().length) {
      if (Date.now() >= end) fail('Debugger activation timeout.');
      await sleep(50);
    }
    ownedDebugger();
    if (JSON.stringify(pid1Identity()) !== JSON.stringify(identity)) fail('Legacy PID1 identity changed.');
    const url = await listTargets(1_000);
    result = await evaluate(url, `(${installLegacyListener.toString()})(${JSON.stringify({ identity, helperPid: process.pid })})`, 2_000);
    if (!['legacy-once', 'native-handler'].includes(result?.mode)) fail('Invalid legacy stop result.');
  } catch (error) {
    failure = error;
  } finally {
    if (enabled) {
      // 首次 evaluate 已安排自清理；若连接失败则仅重试关闭本次精确进程的调试口。
      await sleep(350);
      if (debugListeners().length) {
        ownedDebugger();
        if (JSON.stringify(pid1Identity()) !== JSON.stringify(identity)) fail('Cannot clean changed debugger identity.');
        try {
          await evaluate(await listTargets(1_000), 'setTimeout(() => process.getBuiltinModule("node:inspector").close(), 100).unref(); true', 1_000);
        } catch { /* 下方必须观察实际端口消失，清理错误不能冒充成功。 */ }
      }
      const cleanupEnd = Date.now() + 2_000;
      while (debugListeners().length) {
        if (Date.now() >= cleanupEnd) fail('Owned debugger cleanup unverified; retain ingress barrier.');
        await sleep(50);
      }
    }
  }
  if (failure) throw failure;
  return { ...result, debuggerClosed: true, startTime: identity.startTime, bootId: identity.bootId, leaseMs: LEASE_MS };
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  try {
    const expected = JSON.parse(process.argv[2]);
    if (!/^\d+$/.test(expected.startTime ?? '') || !/^[a-f0-9-]{36}$/.test(expected.bootId ?? '')) fail('Invalid process proof.');
    console.log(JSON.stringify(await armLegacyStop(expected)));
  } catch (error) {
    console.error(`Cold legacy stop failed: ${error.message}`);
    process.exitCode = 1;
  }
}
