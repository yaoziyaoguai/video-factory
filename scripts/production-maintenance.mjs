#!/usr/bin/env node
import { request } from 'node:http';
import { readFile, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 部署只通过共享模块切门禁；网络观察发生在锁外，冻结证明在同锁内复核。 */
export function maintenanceControl(shared, directory, readHealth = localHealth) {
  const { MAINTENANCE_ADMISSION_PROTOCOL: protocol, withMaintenanceLock, readMaintenanceGate,
    readMaintenanceHolders, transitionMaintenanceGate, transitionMaintenanceGateLocked } = shared;
  const lock = (operation) => withMaintenanceLock(directory, operation);
  const recordPath = (owner) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(owner)) throw new Error('Invalid deployment owner.');
    return path.join(directory, `deployment-${owner}.json`);
  };
  const gateFor = async (owner, states) => {
    const gate = await readMaintenanceGate(directory);
    if (gate.owner !== owner || !states.includes(gate.state)) throw new Error('Maintenance owner or phase changed.');
    return gate;
  };
  const empty = async () => {
    if ((await readMaintenanceHolders(directory)).length !== 0) throw new Error('Maintenance still has active holders.');
  };
  const live = async (endpoints, expectedGate, requireIdle) => {
    if (!Array.isArray(endpoints) || endpoints.some((endpoint) => typeof endpoint !== 'string')
      || new Set(endpoints).size !== endpoints.length) throw new Error('Maintenance endpoints are invalid or duplicated.');
    const reports = [];
    const health = await Promise.all(endpoints.map(async (endpoint) => {
      const value = await readHealth(endpoint);
      if (!value || typeof value !== 'object' || (value.status !== undefined && value.status !== 'ok')) throw new Error('Health response is invalid or degraded.');
      const visit = (status) => {
        if (!status || status.protocol !== protocol || typeof status.serviceId !== 'string'
          || !status.serviceId || !Number.isFinite(Date.parse(status.updatedAt))) {
          throw new Error('Live service does not support the current maintenance protocol.');
        }
        const gate = status.gate ?? status.gateView;
        if (expectedGate && !sameGate(gate, expectedGate)) throw new Error('Live service observes a different maintenance gate.');
        if (requireIdle && (status.quiescent !== true || status.integrity?.complete !== true
          || status.inflightCount !== 0 || status.holderCount !== 0)) throw new Error('Live service is not completely drained.');
        reports.push(status);
        if (status.detail?.aggregate) visit(status.detail.aggregate);
        for (const child of status.servers ?? status.detail?.servers ?? []) visit(child);
      };
      visit(value.maintenance);
      return { endpoint, release: value.release ?? null, serviceId: value.maintenance.serviceId };
    }));
    if (new Set(reports.map((item) => item.serviceId)).size !== reports.length) {
      throw new Error('Live services report duplicate identities.');
    }
    return { health, reports };
  };
  const checkLocalReports = async (reports, gate) => {
    for (const observed of reports) {
      const file = path.join(directory, 'services', `${encodeURIComponent(observed.serviceId)}.json`);
      const report = JSON.parse(await readFile(file, 'utf8'));
      if (report.protocol !== protocol || report.serviceId !== observed.serviceId
        || report.updatedAt !== observed.updatedAt || !sameGate(report.gateView, gate)
        || report.integrity?.complete !== true || report.quiescent !== true
        || report.ownCount !== 0 || report.globalCount !== 0
        || !Array.isArray(report.inflight) || report.inflight.length !== 0
        || !Array.isArray(report.holders) || report.holders.length !== 0) {
        throw new Error('Live service report is missing, changed or incomplete.');
      }
    }
  };
  const verifyVersions = (health, expected) => {
    const releases = new Map(expected.map((item) => [item.endpoint, item.release]));
    if (health.length !== expected.length || releases.size !== expected.length || health.some((item) =>
      !/^[a-f0-9]{40}$/.test(item.release ?? '') || item.release !== releases.get(item.endpoint))) {
      throw new Error('Live service release does not match the deployment record.');
    }
  };
  const settle = async (owner, endpoints, states, nextState, expected) => {
    // DRAINING 下第一次同锁空集合是屏障：此后没有父 holder 可派生，新 root 又被拒绝。
    const before = await lock(async () => { const gate = await gateFor(owner, states); await empty(); return gate; });
    const observation = await live(endpoints, before, true);
    if (expected) verifyVersions(observation.health, expected);
    return lock(async () => {
      const current = await gateFor(owner, states);
      if (!sameGate(current, before)) throw new Error('Maintenance generation changed during verification.');
      await empty();
      await checkLocalReports(observation.reports, current);
      return transitionMaintenanceGateLocked(directory, nextState, owner);
    });
  };
  const deploymentRecord = async (owner) => {
    const record = JSON.parse(await readFile(recordPath(owner), 'utf8'));
    if (record.protocol !== protocol || record.owner !== owner || !Array.isArray(record.previous)
      || !Array.isArray(record.serviceIds) || record.serviceIds.some((id) => typeof id !== 'string')
      || (record.previous.length === 0 && record.bootstrap !== true)) throw new Error('Deployment recovery record is invalid.');
    return record;
  };
  return {
    async initialize(owner) {
      return lock(async () => {
        try { await readMaintenanceGate(directory); }
        catch (error) {
          if (error.code === 'ENOENT') return transitionMaintenanceGateLocked(directory, 'open', owner);
          throw error;
        }
        throw new Error('Maintenance is already initialized.');
      });
    },
    async status() { return lock(async () => ({ gate: await readMaintenanceGate(directory), holderCount: (await readMaintenanceHolders(directory)).length })); },
    async preflight(endpoints) { return live(endpoints, undefined, false); },
    async drain(owner, endpoints) {
      const observation = await live(endpoints, undefined, false);
      // 留下原版本和实际观察入口；恢复只认这份本轮记录，不猜测或接管旧 owner。
      if (observation.health.some((item) => !/^[a-f0-9]{40}$/.test(item.release ?? ''))) {
        throw new Error('Running service does not report an exact release; cold maintenance is required.');
      }
      return lock(async () => {
        const gate = await readMaintenanceGate(directory);
        if (gate.state !== 'open') throw new Error('A previous maintenance owner must be recovered explicitly.');
        const bootstrap = endpoints.length === 0;
        if (bootstrap) {
          if (gate.owner !== owner || gate.generation !== 0) throw new Error('Existing deployment requires its live services.');
          await empty();
          const services = await readdir(path.join(directory, 'services')).catch((error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          if (services.length > 0) throw new Error('Existing service reports cannot be treated as a first installation.');
        }
        await writeRecord(recordPath(owner), { protocol, owner, previous: observation.health,
          serviceIds: observation.reports.map((report) => report.serviceId), bootstrap, startedAt: new Date().toISOString() });
        return transitionMaintenanceGateLocked(directory, 'draining', owner);
      });
    },
    async freeze(owner, endpoints) {
      const record = await deploymentRecord(owner);
      if (JSON.stringify([...endpoints].sort()) !== JSON.stringify(record.previous.map((item) => item.endpoint).sort())) {
        throw new Error('Freeze must inspect every original live endpoint.');
      }
      return settle(owner, endpoints, ['draining'], 'frozen', record.previous);
    },
    async verify(owner, endpoints, release) {
      await deploymentRecord(owner);
      if (endpoints.length === 0) throw new Error('Verification requires the candidate live services.');
      return settle(owner, endpoints, ['frozen'], 'frozen', endpoints.map((endpoint) => ({ endpoint, release })));
    },
    async reopen(owner, endpoints, release) {
      await deploymentRecord(owner);
      if (endpoints.length === 0) throw new Error('Reopening requires the candidate live services.');
      const expected = endpoints.map((endpoint) => ({ endpoint, release }));
      return settle(owner, endpoints, ['frozen'], 'open', expected);
    },
    async recover(owner) {
      const record = await deploymentRecord(owner);
      const before = await lock(() => gateFor(owner, ['draining', 'frozen']));
      if (record.bootstrap && before.state === 'frozen') {
        throw new Error('Failed first installation has no prior services to verify; maintenance remains closed.');
      }
      const endpoints = record.previous.map((item) => item.endpoint);
      if (before.state === 'frozen') return settle(owner, endpoints, ['frozen'], 'open', record.previous);
      // 尚未冻结时取消维护不取消原长任务；仍须核实原服务与版本，不能替另一 owner 开门。
      const observation = await live(endpoints, before, false);
      verifyVersions(observation.health, record.previous);
      const liveIds = new Set(observation.reports.map((report) => report.serviceId));
      if (record.serviceIds.some((id) => !liveIds.has(id))) {
        throw new Error('Original service restarted while draining; verify and freeze before recovery.');
      }
      return lock(async () => {
        const current = await gateFor(owner, ['draining']);
        if (!sameGate(current, before)) throw new Error('Maintenance generation changed during recovery.');
        return transitionMaintenanceGateLocked(directory, 'open', owner);
      });
    },
  };
}

function sameGate(left, right) {
  return left && right && left.state === right.state && left.owner === right.owner && left.generation === right.generation;
}

async function writeRecord(file, record) {
  // owner 唯一；已有部署证据不能被新一轮覆盖。
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

export function localHealth(endpoint) {
  let options;
  if (endpoint.startsWith('unix:')) {
    const socketPath = endpoint.slice(5);
    if (!path.isAbsolute(socketPath)) throw new Error('Broker health requires an absolute socket path.');
    options = { socketPath, path: '/health', method: 'GET' };
  } else {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('Maintenance health is restricted to local services.');
    options = { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' };
  }
  return new Promise((resolve, reject) => {
    const req = request(options, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(new Error('Maintenance health response is too large.'));
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('Local health is unavailable.');
          resolve(JSON.parse(body));
        } catch { reject(new Error('Local health is unavailable or invalid.')); }
      });
      response.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Local health timed out.')));
    req.on('error', reject);
    req.end();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modulePath, directory, command, owner, ...args] = process.argv.slice(2);
  try {
    if (!modulePath || !directory) throw new Error('Maintenance module and directory are required.');
    const shared = await import(pathToFileURL(path.resolve(modulePath)).href);
    const control = maintenanceControl(shared, directory);
    let result;
    if (command === 'status') result = await control.status();
    else if (command === 'initialize') result = await control.initialize(owner);
    else if (command === 'preflight') result = await control.preflight(args);
    else if (command === 'drain') result = await control.drain(owner, args);
    else if (command === 'freeze') result = await control.freeze(owner, args);
    else if (command === 'verify') result = await control.verify(owner, args.slice(1), args[0]);
    else if (command === 'reopen') result = await control.reopen(owner, args.slice(1), args[0]);
    else if (command === 'recover') result = await control.recover(owner);
    else throw new Error('Unsupported maintenance command.');
    // 不输出服务报告及内部 holder；部署只需要成功退出与门禁身份。
    if (result?.state) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (command === 'status') process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Maintenance control failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
