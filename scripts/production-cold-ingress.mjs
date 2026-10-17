#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const COLD_INGRESS_PROTOCOL = 'video-factory/cold-ingress-v1';
export const BARRIER_HEADER = 'x-videofactory-cold-ingress';
const exec = promisify(execFile);
const phases = ['prepared', 'installing', 'installed', 'reloading', 'barrier-active', 'draining', 'closed',
  'restoring', 'restored-file', 'restore-reloading', 'restore-active', 'restore-draining', 'restored'];
const fail = (message) => { throw new IngressError(message); };
class IngressError extends Error {}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const sameProcess = (a, b) => a && b && a.pid === b.pid && a.startTime === b.startTime && a.bootId === b.bootId;
const processKey = (p) => `${p.bootId}:${p.pid}:${p.startTime}`;
const mergeWorkers = (...groups) => [...new Map(groups.flat().map((p) => [processKey(p), p])).values()];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicSite(value) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid public health URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || url.pathname !== '/api/health' || url.search || url.hash
    || !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(url.hostname)
    || url.hostname.includes('..')) fail('Expected an HTTP(S) hostname and exact /api/health on the default port.');
  return { hostname: url.hostname, url: url.href };
}

// 只识别站点文件所需的词法边界；未知目标指令拒绝，不尝试重写通用 Nginx 配置。
function parseConfig(text) {
  if (text.includes('\0')) fail('Unsupported Nginx configuration.');
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    const start = i;
    if ('{};'.includes(text[i])) { tokens.push({ value: text[i++], start, end: i, punctuation: true }); continue; }
    let value = '';
    let quote = '';
    while (i < text.length) {
      const ch = text[i];
      if (!quote && (/\s/.test(ch) || '{};#'.includes(ch))) break;
      i++;
      if (ch === '\\') {
        if (i === text.length) fail('Unsupported Nginx escape.');
        value += text[i++];
      } else if (quote) {
        if (ch === quote) quote = ''; else value += ch;
      } else if (ch === '"' || ch === "'") quote = ch;
      else value += ch;
    }
    if (quote || i === start) fail('Unsupported Nginx quoting.');
    tokens.push({ value, start, end: i });
  }
  let cursor = 0;
  const block = (nested = false) => {
    const nodes = [];
    while (cursor < tokens.length) {
      if (tokens[cursor].punctuation && tokens[cursor].value === '}') {
        if (!nested) fail('Unbalanced Nginx configuration.');
        cursor++;
        return nodes;
      }
      const words = [];
      while (cursor < tokens.length && !tokens[cursor].punctuation) words.push(tokens[cursor++].value);
      const delimiter = tokens[cursor++];
      if (!words.length || !delimiter || ![';', '{'].includes(delimiter.value)) fail('Unsupported Nginx directive.');
      nodes.push({ words, open: delimiter.end, children: delimiter.value === '{' ? block(true) : undefined });
    }
    if (nested) fail('Unbalanced Nginx configuration.');
    return nodes;
  };
  return block();
}

function hostNames(server) {
  return server.children.filter((node) => node.words[0] === 'server_name').flatMap((node) => node.words.slice(1));
}
function couldMatch(name, hostname) {
  name = name.toLowerCase();
  if (name.startsWith('~') || name.includes('$')) fail('Dynamic enabled server names cannot be verified.');
  if (name === hostname) return true;
  if (name.startsWith('*.')) return hostname.endsWith(name.slice(1));
  if (name.startsWith('.')) return hostname === name.slice(1) || hostname.endsWith(name);
  if (name.endsWith('.*')) return hostname.startsWith(name.slice(0, -1));
  return false;
}

function listenEndpoint(words) {
  const match = /^(?:(\[::\]|\[::1\]|127\.0\.0\.1|0\.0\.0\.0):)?(80|443)$/.exec(words[1] ?? '');
  const options = words.slice(2);
  if (!match || options.some((word) => !['ssl', 'ipv6only=on'].includes(word))
    || (match[2] === '443') !== options.includes('ssl')
    || (options.includes('ipv6only=on') && match[1] !== '[::]')) fail('Unsupported target listen directive.');
  return { address: match[1]?.startsWith('[') ? '::1' : '127.0.0.1', port: Number(match[2]), tls: options.includes('ssl') };
}

const serverDirectives = new Set(['listen', 'server_name', 'client_max_body_size', 'add_header',
  'ssl_certificate', 'ssl_certificate_key', 'ssl_dhparam', 'include', 'return', 'if', 'location']);
const proxyDirectives = new Set(['proxy_pass', 'proxy_http_version', 'proxy_set_header', 'proxy_buffering',
  'proxy_read_timeout', 'proxy_send_timeout']);
const tlsDirectives = new Set(['ssl_session_cache', 'ssl_session_timeout', 'ssl_session_tickets',
  'ssl_protocols', 'ssl_prefer_server_ciphers', 'ssl_ciphers', 'ssl_ecdh_curve']);
const TLS_OPTIONS = '/etc/letsencrypt/options-ssl-nginx.conf';

export function buildBarrier(original, hostname, token) {
  if (!/^[a-f0-9]{32}$/.test(token)) fail('Invalid transaction token.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(original); } catch { fail('Site configuration is not UTF-8.'); }
  if (/vf_cold_ingress|X-VideoFactory-Cold-Ingress/i.test(text)) fail('The site already contains a cold ingress restriction.');
  const nodes = parseConfig(text);
  if (nodes.some((node) => node.words.length !== 1 || node.words[0] !== 'server' || !node.children)) {
    fail('Only explicit server blocks are supported in the target site file.');
  }
  const targets = nodes.filter((node) => hostNames(node).some((name) => couldMatch(name, hostname)));
  if (!targets.length) fail('Target hostname is missing.');
  const endpoints = [];
  const includes = new Set();
  let proxied = false;
  for (const server of targets) {
    if (hostNames(server).length !== 1 || hostNames(server)[0] !== hostname) fail('Target server must have exactly the public hostname.');
    let listens = 0;
    for (const node of server.children) {
      const [directive, ...args] = node.words;
      if (!serverDirectives.has(directive)) fail('Unsupported directive in target server.');
      if (directive === 'listen') { endpoints.push(listenEndpoint(node.words)); listens++; }
      if (directive === 'include') {
        if (args.length !== 1 || args[0] !== TLS_OPTIONS) fail('Only the known Certbot TLS options include is supported.');
        includes.add(args[0]);
      }
      if (directive === 'if' && (args.join(' ') !== `($host = ${hostname})` || node.children?.length !== 1
        || node.children[0].words.join(' ') !== 'return 301 https://$host$request_uri' || node.children[0].children)) {
        fail('Only the Certbot HTTP redirect condition is supported.');
      }
      if (directive === 'return' && !['404', '301 https://$host$request_uri'].includes(args.join(' '))) {
        fail('Unsupported target return directive.');
      }
      if (directive === 'location') {
        if (args.join(' ') !== '/' || !node.children?.length) fail('Only the existing root proxy location is supported.');
        const proxy = node.children.filter((entry) => entry.words[0] === 'proxy_pass');
        if (proxy.length !== 1 || proxy[0].words.join(' ') !== 'proxy_pass http://127.0.0.1:4317'
          || node.children.some((entry) => entry.children || !proxyDirectives.has(entry.words[0]))) {
          fail('Target location must be the known local VideoFactory proxy.');
        }
        proxied = true;
      } else if (directive !== 'if' && node.children) fail('Unsupported nested target directive.');
    }
    if (!listens) fail('Every target server requires explicit listeners.');
  }
  if (!proxied) fail('The target site has no VideoFactory proxy.');
  const keys = endpoints.map((endpoint) => JSON.stringify(endpoint));
  if (new Set(keys).size !== keys.length) fail('Duplicate target listeners are ambiguous.');
  const insertion = `\n    # vf_cold_ingress ${token}: owned by the private deployment transaction\n`
    + `    set $vf_cold_ingress_request "$request_method:$request_uri";\n`
    + `    if ($vf_cold_ingress_request !~ "^(GET|HEAD):/api/health$") { return 503; }\n`
    + `    recursive_error_pages off;\n    error_page 503 =503 @vf_cold_ingress_${token};\n`
    + `    location @vf_cold_ingress_${token} {\n`
    + `        internal;\n        add_header X-VideoFactory-Cold-Ingress "${token}" always;\n`
    + `        add_header Retry-After "120" always;\n        return 503;\n    }\n`;
  for (const server of [...targets].sort((a, b) => b.open - a.open)) text = text.slice(0, server.open) + insertion + text.slice(server.open);
  return { replacement: Buffer.from(text), endpoints, includes: [...includes] };
}

async function command(program, args, timeoutMs) {
  try { return (await exec(program, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })).stdout; }
  catch { fail(`Host command failed (${program === 'nginx' ? 'Nginx validation' : 'Nginx service control'}).`); }
}

export function nginxProcesses({ runCommand = command, procRoot = '/proc', readProcFile = readFile } = {}) {
  const boot = async () => {
    const id = (await readProcFile(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8')).trim();
    if (!/^[a-f0-9-]{36}$/.test(id)) fail('Unknown host boot identity.');
    return id;
  };
  const read = async (pid) => {
    const bootId = await boot();
    let text;
    // Linux 在打开 /proc 文件后进程退出时返回 ESRCH；路径先消失则返回 ENOENT。
    try { text = await readProcFile(path.join(procRoot, String(pid), 'stat'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
    const end = text.lastIndexOf(')');
    const fields = text.slice(end + 2).trim().split(/\s+/);
    if (!text.startsWith(`${pid} (`) || end < 0 || !/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[1] ?? '')) {
      fail('Unknown Nginx process identity.');
    }
    return { pid, startTime: fields[19], bootId, ppid: Number(fields[1]) };
  };
  const title = async (pid) => (await readProcFile(path.join(procRoot, String(pid), 'cmdline'), 'utf8')).replace(/\0/g, ' ').trim();
  const children = async (pid) => {
    const value = (await readProcFile(path.join(procRoot, String(pid), 'task', String(pid), 'children'), 'utf8')).trim();
    if (!/^\d+(?:\s+\d+)*$/.test(value)) fail('Nginx worker list is empty or unknown.');
    return value.split(/\s+/).map(Number);
  };
  return {
    identity: read,
    async snapshot(timeoutMs) {
      const value = (await runCommand('systemctl', ['show', 'nginx', '--property=MainPID', '--value'], timeoutMs)).trim();
      if (!/^[1-9]\d*$/.test(value)) fail('Nginx has no verified systemd master.');
      const pid = Number(value);
      const observationDeadline = Date.now() + timeoutMs;
      for (let attempt = 0; attempt < 10; attempt++) {
        const master = await read(pid);
        const masterTitle = await title(pid);
        if (!master || !/^nginx: master process (?:\S*\/)?nginx(?: -g (?:daemon (?:on|off);\s*(?:master_process on;)?)\s*)?$/.test(masterTitle)) {
          fail('Unknown Nginx master process or nonstandard configuration arguments.');
        }
        const before = await children(pid);
        const workers = [];
        let unknownChild = false;
        for (const child of before) {
          const worker = await read(child);
          if (!worker) continue;
          let name;
          try { name = await title(child); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
          const after = await read(child);
          if (!sameProcess(worker, after)) continue;
          if (worker.ppid !== pid) fail('Unknown Nginx child parent.');
          if (!/^nginx: worker process(?: is shutting down)?$/.test(name)) unknownChild = true;
          else workers.push(worker);
        }
        const after = await children(pid);
        if (!sameProcess(master, await read(pid))) fail('Nginx master changed during observation.');
        if (!unknownChild && after.every((child) => before.includes(child)) && workers.length) return { master, workers };
        // fork 后标题尚未更新、退出待回收时 cmdline 为空；只重读，不把未知子进程算作已退出。
        if (attempt === 9 || Date.now() + 25 >= observationDeadline) fail('Unknown Nginx child process or unstable worker topology.');
        await pause(25);
      }
      fail('Nginx worker topology did not stabilize.');
    },
  };
}

// 直连监听地址，Host/SNI 仍使用真实域名；不使用环境代理、不跟随重定向、不提交写请求。
export function probeSite({ hostname, endpoint, token, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = endpoint.tls ? https : http;
    const req = transport.request({ hostname: endpoint.address, port: endpoint.port, servername: hostname,
      path: `/.vf-cold-ingress/${token}`, method: 'GET', agent: false,
      headers: { Host: hostname, Connection: 'close', 'Cache-Control': 'no-cache' } }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, marker: response.headers[BARRIER_HEADER] }));
      response.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Site probe timed out.')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
function privateFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('Transaction file must be owner-private and regular.');
}
async function readPrivate(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { privateFile(await handle.stat()); return await handle.readFile('utf8'); } finally { await handle.close(); }
}
async function writeDurable(file, bytes, exclusive = false) {
  const temporary = exclusive ? file : `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

async function withHostLock(file, operation) {
  if (process.platform !== 'linux') fail('Cold ingress requires a Linux host with systemd, /proc and flock.');
  const handle = await open(`${file}.lock`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    privateFile(await handle.stat());
    // flock 锁属于继承的 open-file-description；子进程退出后由本进程 fd 持有，崩溃自动释放。
    await new Promise((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      child.on('error', () => reject(new IngressError('Unable to acquire transaction flock.')));
      child.on('exit', (code) => code === 0 ? resolve() : reject(new IngressError('Transaction is already in use or flock failed.')));
    });
    return await operation();
  } finally { await handle.close(); }
}

/** 生产默认值只执行真实 OS 操作；注入项用于隔离测试，不提供失败后伪成功路径。 */
export function coldIngressControl({ sitesEnabled = '/etc/nginx/sites-enabled', runCommand = command,
  processes = nginxProcesses({ runCommand }), probe = probeSite, withLock = withHostLock,
  now = Date.now, sleep = pause, timeoutMs = 120_000, readInclude = (file) => readFile(file) } = {}) {
  const available = path.join(path.dirname(sitesEnabled), 'sites-available');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('Timeout must be positive.');

  const discover = async (hostname) => {
    if (await realpath(sitesEnabled) !== sitesEnabled || await realpath(available) !== available) fail('Nginx directories must be canonical.');
    const matches = [];
    for (const name of (await readdir(sitesEnabled)).sort()) {
      const enabled = path.join(sitesEnabled, name);
      const linkStat = await lstat(enabled);
      const target = await realpath(enabled);
      const bytes = await readFile(target);
      const nodes = parseConfig(bytes.toString('utf8'));
      if (nodes.some((node) => node.words[0] === 'include')) fail('Indirect enabled sites cannot be verified.');
      const servers = nodes.filter((node) => node.words[0] === 'server' && node.children);
      if (!servers.some((node) => hostNames(node).some((host) => couldMatch(host, hostname)))) continue;
      if (!linkStat.isSymbolicLink() || path.dirname(target) !== available) fail('The target must be a sites-enabled symlink to sites-available.');
      const stat = await lstat(target);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022)) fail('Target configuration ownership or type is unsafe.');
      matches.push({ enabled, target, link: await readlink(enabled), linkIdentity: identity(linkStat),
        originalIdentity: identity(stat), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid, bytes });
    }
    if (matches.length !== 1) fail('Expected exactly one enabled site for the public hostname.');
    return matches[0];
  };

  const transaction = async (file, action) => {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || await realpath(path.dirname(file)) !== path.dirname(file)) fail('Transaction path must be absolute and canonical.');
    const directory = await lstat(path.dirname(file));
    if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077)) fail('Transaction directory must be owner-private.');
    return withLock(file, async () => {
      const deadline = now() + timeoutMs;
      const remaining = () => {
        const ms = deadline - now();
        if (ms <= 0) fail('Cold ingress timed out; transaction evidence and current configuration are retained.');
        return ms;
      };
      let state;
      let raw;
      try { raw = await readPrivate(file); state = JSON.parse(raw); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const save = async (patch = {}) => {
        Object.assign(state, patch, { updatedAt: new Date().toISOString() });
        if (raw !== undefined && await readPrivate(file) !== raw) fail('Transaction evidence changed externally.');
        const next = `${JSON.stringify(state)}\n`;
        await writeDurable(file, next, raw === undefined);
        raw = next;
      };
      const validate = () => {
        if (state?.protocol !== COLD_INGRESS_PROTOCOL || !phases.includes(state.phase) || !/^[a-f0-9]{32}$/.test(state.token)
          || state.hostname !== publicSite(state.publicHealthUrl).hostname
          || path.dirname(state.site?.enabled ?? '') !== sitesEnabled || path.dirname(state.site?.target ?? '') !== available
          || !Array.isArray(state.oldWorkers) || state.oldWorkers.length === 0 || !state.master
          || !Array.isArray(state.includes) || !Array.isArray(state.endpoints) || !state.site.linkIdentity || !state.site.originalIdentity
          || typeof state.original !== 'string' || !/^[a-f0-9]{64}$/.test(state.originalHash)
          || !/^[a-f0-9]{64}$/.test(state.replacementHash)
          || ![state.master, ...state.oldWorkers, ...(state.restoreWorkers ?? [])].every((p) => Number.isSafeInteger(p.pid)
            && p.pid > 0 && /^\d+$/.test(p.startTime) && /^[a-f0-9-]{36}$/.test(p.bootId))) fail('Invalid cold ingress transaction evidence.');
        const original = Buffer.from(state.original, 'base64');
        const plan = buildBarrier(original, state.hostname, state.token);
        if (hash(original) !== state.originalHash || hash(plan.replacement) !== state.replacementHash
          || JSON.stringify(plan.endpoints) !== JSON.stringify(state.endpoints)
          || JSON.stringify(plan.includes) !== JSON.stringify(state.includes.map((include) => include.path))
          || state.includes.some((include) => !/^[a-f0-9]{64}$/.test(include.hash))) fail('Transaction configuration evidence is inconsistent.');
        return { original, ...plan };
      };
      const current = async () => {
        const site = await discover(state.hostname);
        if (site.enabled !== state.site.enabled || site.target !== state.site.target || site.link !== state.site.link
          || !sameFile(site.linkIdentity, state.site.linkIdentity) || site.mode !== state.site.mode
          || site.uid !== state.site.uid || site.gid !== state.site.gid) fail('Enabled site identity or metadata changed.');
        for (const include of state.includes) {
          if (hash(await readInclude(include.path)) !== include.hash) fail('Target TLS options changed.');
        }
        const digest = hash(site.bytes);
        if (digest === state.replacementHash && sameFile(site.originalIdentity, state.replacementIdentity)) return 'replacement';
        if (digest === state.originalHash && (sameFile(site.originalIdentity, state.site.originalIdentity)
          || sameFile(site.originalIdentity, state.restoredIdentity))) return 'original';
        fail('Site configuration changed; refusing to overwrite another owner.');
      };
      const replace = async (bytes, expected, restoring) => {
        if (await current() !== expected) fail('Unexpected site configuration phase.');
        const temporary = path.join(available, `.vf-cold-ingress-${state.token}-${randomBytes(8).toString('hex')}`);
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.chown(state.site.uid, state.site.gid);
          await handle.chmod(state.site.mode);
          await handle.sync();
          const written = identity(await handle.stat());
          await save(restoring ? { phase: 'restoring', restoredIdentity: written } : { phase: 'installing', replacementIdentity: written });
          if (await current() !== expected) fail('Site changed before atomic replacement.');
          await rename(temporary, state.site.target);
          await syncDirectory(available);
        } finally {
          await handle.close();
          await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
        await save({ phase: restoring ? 'restored-file' : 'installed' });
      };
      const runtime = async (target, hostname = state?.hostname) => {
        const dump = await runCommand('nginx', ['-T'], Math.min(remaining(), 15_000));
        if (!dump.includes(`# configuration file ${target}:\n`)) fail('Target site is absent from the effective Nginx configuration.');
        const expectedServers = parseConfig(await readFile(target, 'utf8')).filter((node) => node.words[0] === 'server'
          && node.children && hostNames(node).some((name) => couldMatch(name, hostname))).length;
        let matchingServers = 0;
        let enabledInclude = false;
        const visit = (nodes) => {
          for (const node of nodes) {
            if (node.words[0] === 'worker_shutdown_timeout' && (node.children || node.words.length !== 2
              || !/^0(?:ms|s|m|h|d|w|M|y)?$/.test(node.words[1]))) fail('Finite Nginx worker_shutdown_timeout prevents a natural request drain.');
            if (node.words.join(' ') === `include ${sitesEnabled}/*`) enabledInclude = true;
            if (node.words[0] === 'server' && node.children
              && hostNames(node).some((name) => couldMatch(name, hostname))) matchingServers++;
            if (node.children) visit(node.children);
          }
        };
        visit(parseConfig(dump));
        if (!enabledInclude) fail('Nginx does not include the expected sites-enabled directory.');
        if (!expectedServers || matchingServers !== expectedServers) fail('The effective Nginx configuration contains ambiguous target servers.');
      };
      const snapshot = async (master) => {
        const result = await processes.snapshot(Math.min(remaining(), 15_000));
        if (!result.workers?.length || (master && !sameProcess(result.master, master))) fail('Nginx master changed or workers are unknown.');
        return result;
      };
      const reload = async (expected, master, phase) => {
        if (await current() !== expected) fail('Site configuration phase changed before reload.');
        await snapshot(master);
        await runtime(state.site.enabled);
        await runCommand('nginx', ['-t'], Math.min(remaining(), 15_000));
        if (await current() !== expected) fail('Site changed during Nginx validation.');
        await save({ phase });
        await runCommand('systemctl', ['reload', 'nginx'], Math.min(remaining(), 15_000));
      };
      const observe = async (closed) => {
        for (const endpoint of state.endpoints) {
          let response;
          try { response = await probe({ hostname: state.hostname, endpoint, token: state.token, timeoutMs: Math.min(remaining(), 3000) }); }
          catch { return false; }
          if (closed ? response.status !== 503 || response.marker !== state.token
            : !Number.isInteger(response.status) || response.status < 200 || response.status >= 600 || response.marker !== undefined) return false;
        }
        return true;
      };
      const awaitObservation = async (closed, master) => {
        for (;;) {
          remaining();
          await snapshot(master);
          if (await observe(closed)) return;
          await sleep(Math.min(250, remaining()));
        }
      };
      const drained = async (workers) => {
        for (const worker of workers) if (sameProcess(worker, await processes.identity(worker.pid))) return false;
        return true;
      };
      const awaitDrain = async (workers, master) => {
        for (;;) {
          remaining();
          await snapshot(master);
          if (await drained(workers)) return;
          await sleep(Math.min(250, remaining()));
        }
      };
      const summary = () => ({ protocol: COLD_INGRESS_PROTOCOL, phase: state.phase, closed: state.closed, drained: state.drained });
      return action({ get state() { return state; }, setState(value) { state = value; }, save, validate, current,
        replace, runtime, snapshot, reload, observe, awaitObservation, drained, awaitDrain, summary });
    });
  };

  return {
    async enter(file, healthUrl) {
      const siteUrl = publicSite(healthUrl);
      return transaction(file, async (tx) => {
        if (!tx.state) {
          const site = await discover(siteUrl.hostname);
          const token = randomBytes(16).toString('hex');
          const plan = buildBarrier(site.bytes, siteUrl.hostname, token);
          if (!plan.endpoints.some((endpoint) => endpoint.tls === (new URL(siteUrl.url).protocol === 'https:'))) fail('Public URL has no matching site listener.');
          const includes = [];
          for (const file of plan.includes) {
            const bytes = await readInclude(file);
            if (parseConfig(bytes.toString('utf8')).some((node) => node.children || !tlsDirectives.has(node.words[0]))) fail('Unknown directives in Certbot TLS options.');
            includes.push({ path: file, hash: hash(bytes) });
          }
          await tx.runtime(site.enabled, siteUrl.hostname);
          const processes = await tx.snapshot();
          const { bytes, ...reference } = site;
          tx.setState({ protocol: COLD_INGRESS_PROTOCOL, token, publicHealthUrl: siteUrl.url, hostname: siteUrl.hostname,
            phase: 'prepared', closed: false, drained: false, site: reference, original: bytes.toString('base64'),
            originalHash: hash(bytes), replacementHash: hash(plan.replacement), endpoints: plan.endpoints, includes,
            master: processes.master, oldWorkers: processes.workers, startedAt: new Date().toISOString() });
          await tx.save();
        }
        const state = tx.state;
        const plan = tx.validate();
        if (state.publicHealthUrl !== siteUrl.url || state.phase.startsWith('restor')) fail('Transaction cannot be reused for a different URL or after restore.');
        await tx.save({ closed: false, drained: false });
        const source = await tx.current();
        await tx.snapshot(state.master);
        if (source === 'original') {
          if (!['prepared', 'installing'].includes(state.phase)) fail('Unexpected original configuration during enter.');
          await tx.replace(plan.replacement, 'original', false);
        }
        await tx.reload('replacement', state.master, 'reloading');
        await tx.awaitObservation(true, state.master);
        // 首次标记证明 master 已载入屏障；再捕获并重载，涵盖首次快照后新生的旧配置 worker。
        const active = await tx.snapshot(state.master);
        await tx.save({ phase: 'barrier-active', oldWorkers: mergeWorkers(state.oldWorkers, active.workers) });
        await tx.reload('replacement', state.master, 'draining');
        await tx.awaitDrain(state.oldWorkers, state.master);
        if (await tx.current() !== 'replacement' || !await tx.observe(true)) fail('Barrier verification changed after worker drain.');
        await tx.save({ phase: 'closed', closed: true, drained: true, closedAt: new Date().toISOString() });
        return tx.summary();
      });
    },
    async status(file) {
      return transaction(file, async (tx) => {
        tx.validate();
        const state = tx.state;
        if (state.phase !== 'closed' || !state.closed || !state.drained) fail('Ingress has no completed closure proof.');
        await tx.runtime(state.site.enabled);
        await tx.snapshot(state.master);
        if (await tx.current() !== 'replacement' || !await tx.drained(state.oldWorkers) || !await tx.observe(true)) fail('Ingress closure proof is no longer valid.');
        return tx.summary();
      });
    },
    async restore(file) {
      return transaction(file, async (tx) => {
        const plan = tx.validate();
        const state = tx.state;
        const source = await tx.current();
        if (state.phase === 'restored') {
          if (source !== 'original' || !await tx.observe(false)) fail('Restored ingress no longer matches its evidence.');
          return tx.summary();
        }
        if (source === 'original' && ['prepared', 'installing'].includes(state.phase)) {
          await tx.save({ phase: 'restored', closed: false, drained: false, restoredAt: new Date().toISOString() });
          return tx.summary();
        }
        if (source === 'original' && !state.phase.startsWith('restor')) fail('Original bytes were not restored by this transaction.');
        const active = await tx.snapshot();
        await tx.save({ closed: false, drained: false, phase: 'restoring', restoreMaster: active.master,
          restoreWorkers: mergeWorkers(state.restoreWorkers ?? [], active.workers) });
        if (source === 'replacement') await tx.replace(plan.original, 'replacement', true);
        await tx.reload('original', active.master, 'restore-reloading');
        await tx.awaitObservation(false, active.master);
        const loaded = await tx.snapshot(active.master);
        await tx.save({ phase: 'restore-active', restoreWorkers: mergeWorkers(state.restoreWorkers, loaded.workers) });
        await tx.reload('original', active.master, 'restore-draining');
        await tx.awaitDrain(state.restoreWorkers, active.master);
        if (await tx.current() !== 'original' || !await tx.observe(false)) fail('Restored ingress verification changed.');
        await tx.save({ phase: 'restored', closed: false, drained: false, restoredAt: new Date().toISOString() });
        return tx.summary();
      });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let timeoutMs = 120_000;
    const option = args.indexOf('--timeout');
    if (option >= 0) {
      if (option !== args.length - 2 || !/^[1-9]\d*$/.test(args[option + 1])) fail('Use --timeout SECONDS at the end of the command.');
      timeoutMs = Number(args[option + 1]) * 1000;
      args.splice(option);
    }
    const [action, file, url] = args;
    if (!['enter', 'restore', 'status'].includes(action) || args.length !== (action === 'enter' ? 3 : 2)) {
      fail('Usage: production-cold-ingress.mjs enter STATE PUBLIC_HEALTH_URL [--timeout SECONDS] | restore STATE [--timeout SECONDS] | status STATE [--timeout SECONDS]');
    }
    const control = coldIngressControl({ timeoutMs });
    process.stdout.write(`${JSON.stringify(await control[action](file, url))}\n`);
  } catch (error) {
    // 不回显命令输出、配置内容、请求响应或环境；详细阶段保留在私有事务文件。
    process.stderr.write(`Cold ingress failed: ${error instanceof IngressError ? error.message : 'Host observation or durable transaction I/O failed.'}\n`);
    process.exitCode = 1;
  }
}
