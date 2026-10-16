#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { readFile, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 部署只通过共享模块切门禁；网络观察发生在锁外，冻结证明在同锁内复核。 */
export function maintenanceControl(shared, directory, readHealth = localHealth) {
  const { MAINTENANCE_ADMISSION_PROTOCOL: protocol, withMaintenanceLock, readMaintenanceGate,
    readMaintenanceHolders, transitionMaintenanceGateLocked } = shared;
  const lock = (operation) => withMaintenanceLock(directory, operation);
  const recordPath = (owner) => {
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(owner)) throw new Error('Invalid deployment owner.');
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
    const results = await Promise.allSettled(endpoints.map(async (endpoint) => {
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
    // 失败也必须等所有观察结束，避免返回后仍有服务报告写入与恢复操作并发。
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const health = results.map((result) => result.value);
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
    if (!isRecord(record) || record.protocol !== protocol || record.owner !== owner || !Array.isArray(record.previous)
      || !Array.isArray(record.serviceIds) || record.serviceIds.some((id) => typeof id !== 'string')) {
      throw new Error('Deployment recovery record is invalid.');
    }
    if (record.kind === 'cold-upgrade') {
      validateColdEvidence(record.cold, 'cold-upgrade');
      if (record.bootstrap !== false || record.previous.length !== 0 || record.serviceIds.length !== 0
        || (record.retryOf !== undefined && typeof record.retryOf !== 'string')) {
        throw new Error('Cold deployment recovery record is invalid.');
      }
    } else if (record.kind !== undefined || (record.previous.length === 0 && record.bootstrap !== true)) {
      throw new Error('Deployment recovery record is invalid.');
    }
    return record;
  };
  const abortPath = (owner) => {
    recordPath(owner);
    return path.join(directory, `deployment-cold-abort-${owner}.json`);
  };
  const abortRecord = async (owner, original) => {
    const record = JSON.parse(await readFile(abortPath(owner), 'utf8'));
    if (!isRecord(record) || record.protocol !== protocol || record.kind !== 'cold-abort' || record.owner !== owner
      || record.frozenGate?.state !== 'frozen' || record.frozenGate.owner !== owner
      || !Number.isSafeInteger(record.frozenGate.generation) || record.frozenGate.generation < 2
      || !Array.isArray(record.serviceReports)
      || record.serviceReports.some((item) => !isRecord(item) || !isText(item.name)
        || path.basename(item.name) !== item.name || !item.name.endsWith('.json') || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ''))
      || new Set(record.serviceReports.map((item) => item.name)).size !== record.serviceReports.length) {
      throw new Error('Cold abort recovery record is invalid.');
    }
    validateColdEvidence(record.cold, 'cold-abort');
    bindColdAbort(record.cold, original.cold);
    return record;
  };
  const coldHistory = async (owner) => {
    const entries = [];
    const seen = new Set();
    while (owner !== undefined) {
      if (seen.has(owner)) throw new Error('Cold retry recovery history is cyclic.');
      seen.add(owner);
      const record = await deploymentRecord(owner);
      if (record.kind !== 'cold-upgrade') throw new Error('Existing deployment is not a cold upgrade.');
      if (entries.length && !sameColdSource(entries.at(-1).record.cold, record.cold)) {
        throw new Error('Cold retry source differs from its recovery history.');
      }
      entries.push({ record, aborted: await abortRecord(owner, record) });
      owner = record.retryOf;
    }
    return entries;
  };
  const checkColdFiles = async (history, currentOwner) => {
    const allowed = new Set(['.admission.lock', 'gate.json', 'holders.json', 'services']);
    for (const { record } of history) {
      allowed.add(path.basename(recordPath(record.owner)));
      allowed.add(path.basename(abortPath(record.owner)));
    }
    if (currentOwner !== undefined) allowed.add(path.basename(recordPath(currentOwner)));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!allowed.has(entry.name) || (['.admission.lock', 'services'].includes(entry.name) ? !entry.isDirectory() : !entry.isFile())) {
        throw new Error('Existing maintenance state is outside the cold recovery history.');
      }
    }
  };
  const serviceFiles = async () => {
    const names = await readdir(path.join(directory, 'services'), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const reports = [];
    for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error('Unexpected cold service report file.');
      const bytes = await readFile(path.join(directory, 'services', entry.name));
      reports.push({ name: entry.name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes });
    }
    return reports;
  };
  const coldEligibility = async (owner, identity) => {
    recordPath(owner);
    const entries = (await readdir(directory)).filter((entry) => entry !== '.admission.lock');
    if (entries.length === 0) return undefined;
    if (entries.includes(path.basename(recordPath(owner))) || entries.includes(path.basename(abortPath(owner)))) {
      throw new Error('Cold deployment owner already has recovery evidence; use a new owner.');
    }
    const gate = await readMaintenanceGate(directory);
    if (gate.state !== 'open' || gate.owner === owner) {
      throw new Error('Existing maintenance requires its own explicit recovery and a new cold owner.');
    }
    await empty();
    const history = await coldHistory(gate.owner);
    const { record, aborted } = history[0];
    if (!sameColdSource(identity, record.cold)
      || !sameGate(gate, { ...aborted.frozenGate, state: 'open', generation: aborted.frozenGate.generation + 1 })) {
      throw new Error('Cold retry source or gate differs from the aborted deployment.');
    }
    await checkColdFiles(history);
    const reports = await serviceFiles();
    const known = new Map(aborted.serviceReports.map((item) => [item.name, item.sha256]));
    if (reports.length !== known.size || reports.some((item) => known.get(item.name) !== item.sha256)) {
      throw new Error('Cold-aborted service reports changed; explicit recovery is required.');
    }
    return gate.owner;
  };
  const bindCandidate = (record, endpoints, release) => {
    if (record.kind !== 'cold-upgrade') return;
    if (release !== record.cold.candidateRelease) throw new Error('Cold candidate release does not match its evidence.');
    if (!Array.isArray(endpoints) || endpoints.length !== record.cold.candidateEndpoints.length
      || new Set(endpoints).size !== endpoints.length
      || endpoints.some((endpoint) => !record.cold.candidateEndpoints.includes(endpoint))) {
      throw new Error('Cold candidate endpoints must match every recorded app and broker endpoint.');
    }
  };
  return {
    async coldPreflight(owner, identity) {
      const snapshot = structuredClone(identity);
      validateColdIdentity(snapshot, true);
      return lock(async () => { await coldEligibility(owner, snapshot); });
    },
    async coldEnter(owner, evidence) {
      const file = recordPath(owner);
      const cold = structuredClone(evidence);
      validateColdEvidence(cold, 'cold-upgrade');
      freshColdEvidence(cold);
      return lock(async () => {
        const retryOf = await coldEligibility(owner, cold);
        freshColdEvidence(cold);
        await writeRecord(file, { protocol, owner, kind: 'cold-upgrade', bootstrap: false, previous: [], serviceIds: [],
          cold, ...(retryOf === undefined ? {} : { retryOf }), startedAt: new Date().toISOString() });
        // 旧进程已由宿主停止；共享锁覆盖完整初始化，v2 写者不能观察中间的 OPEN。
        if (retryOf === undefined) await transitionMaintenanceGateLocked(directory, 'open', owner);
        await transitionMaintenanceGateLocked(directory, 'draining', owner);
        return transitionMaintenanceGateLocked(directory, 'frozen', owner);
      });
    },
    async coldAbort(owner, evidence) {
      const file = abortPath(owner);
      const cold = structuredClone(evidence);
      validateColdEvidence(cold, 'cold-abort');
      freshColdEvidence(cold);
      return lock(async () => {
        const gate = await gateFor(owner, ['frozen']);
        const record = await deploymentRecord(owner);
        if (record.kind !== 'cold-upgrade') throw new Error('Cold abort requires a cold upgrade record.');
        bindColdAbort(cold, record.cold);
        await empty();
        const history = await coldHistory(record.retryOf);
        if (history.length && !sameColdSource(record.cold, history[0].record.cold)) {
          throw new Error('Cold retry source differs from its recovery history.');
        }
        await checkColdFiles(history, owner);
        const known = new Map((history[0]?.aborted.serviceReports ?? []).map((item) => [item.name, item.sha256]));
        const reports = await serviceFiles();
        for (const item of reports) {
          if (known.get(item.name) === item.sha256) continue;
          const report = JSON.parse(item.bytes.toString('utf8'));
          if (!isRecord(report) || report.protocol !== protocol || !isText(report.serviceId)
            || item.name !== `${encodeURIComponent(report.serviceId)}.json` || !sameGate(report.gateView, gate)
            || !isTimestamp(report.updatedAt) || report.ownCount !== 0 || report.globalCount !== 0
            || !Array.isArray(report.inflight) || report.inflight.length !== 0
            || !Array.isArray(report.holders) || report.holders.length !== 0) {
            throw new Error('Cold abort service report is active or has unknown provenance.');
          }
        }
        freshColdEvidence(cold);
        // 先持久化中止证明再开门；失败保留 FROZEN，不能将未完成中止当作可重试的 OPEN。
        await writeRecord(file, { protocol, owner, kind: 'cold-abort', cold, frozenGate: gate,
          serviceReports: reports.map(({ name, sha256 }) => ({ name, sha256 })), abortedAt: new Date().toISOString() });
        return transitionMaintenanceGateLocked(directory, 'open', owner);
      });
    },
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
      if (record.kind === 'cold-upgrade') throw new Error('Cold upgrade must freeze as part of cold-enter.');
      if (JSON.stringify([...endpoints].sort()) !== JSON.stringify(record.previous.map((item) => item.endpoint).sort())) {
        throw new Error('Freeze must inspect every original live endpoint.');
      }
      return settle(owner, endpoints, ['draining'], 'frozen', record.previous);
    },
    async verify(owner, endpoints, release) {
      const record = await deploymentRecord(owner);
      bindCandidate(record, endpoints, release);
      if (endpoints.length === 0) throw new Error('Verification requires the candidate live services.');
      return settle(owner, endpoints, ['frozen'], 'frozen', endpoints.map((endpoint) => ({ endpoint, release })));
    },
    async reopen(owner, endpoints, release) {
      const record = await deploymentRecord(owner);
      bindCandidate(record, endpoints, release);
      if (endpoints.length === 0) throw new Error('Reopening requires the candidate live services.');
      const expected = endpoints.map((endpoint) => ({ endpoint, release }));
      return settle(owner, endpoints, ['frozen'], 'open', expected);
    },
    async recover(owner) {
      const record = await deploymentRecord(owner);
      if (record.kind === 'cold-upgrade') throw new Error('Cold upgrade requires explicit cold-abort evidence; maintenance remains closed.');
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isAbsolutePath(value) {
  return isText(value) && path.isAbsolute(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateColdIdentity(identity, requireEndpoints) {
  if (!isRecord(identity) || typeof identity.previousRelease !== 'string' || !/^[a-f0-9]{40}$/.test(identity.previousRelease)
    || typeof identity.candidateRelease !== 'string' || !/^[a-f0-9]{40}$/.test(identity.candidateRelease)
    || identity.previousRelease === identity.candidateRelease || !isRecord(identity.container)
    || typeof identity.container.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(identity.container.image)
    || !isAbsolutePath(identity.brokerRelease)) {
    throw new Error('Cold deployment source and candidate identities are invalid.');
  }
  if (requireEndpoints) {
    const endpoints = identity.candidateEndpoints;
    if (!Array.isArray(endpoints) || endpoints.length !== 2 || new Set(endpoints).size !== 2
      || !endpoints.includes('http://127.0.0.1:4317/api/health')
      || !endpoints.some((endpoint) => typeof endpoint === 'string' && endpoint.startsWith('unix:') && isAbsolutePath(endpoint.slice(5)))) {
      throw new Error('Cold candidate endpoints require the exact app health URL and an absolute broker socket.');
    }
  }
}

function validateColdEvidence(evidence, kind) {
  validateColdIdentity(evidence, kind === 'cold-upgrade');
  if (evidence.kind !== kind || !isText(evidence.container.id)
    || !isRecord(evidence.ingress) || evidence.ingress.closed !== true || evidence.ingress.drained !== true
    || !isAbsolutePath(evidence.ingress.statePath) || !isRecord(evidence.integrity)
    || evidence.integrity.complete !== true || evidence.integrity.quiescent !== true || !isTimestamp(evidence.observedAt)
    || (kind === 'cold-upgrade' ? evidence.bootstrap !== false || evidence.writersStopped !== true
      : evidence.writersRestored !== true || evidence.candidateWritersStopped !== true
        || (evidence.bootstrap !== undefined && evidence.bootstrap !== false))) {
    throw new Error(`Invalid ${kind} host evidence.`);
  }
}

function freshColdEvidence(evidence) {
  const age = Date.now() - Date.parse(evidence.observedAt);
  if (age < 0 || age > 120_000) throw new Error('Cold host evidence is stale or from the future.');
}

function sameColdSource(left, right) {
  return left.previousRelease === right.previousRelease && left.container.image === right.container.image
    && left.brokerRelease === right.brokerRelease;
}

function bindColdAbort(aborted, original) {
  if (!sameColdSource(aborted, original) || aborted.candidateRelease !== original.candidateRelease
    || aborted.ingress.statePath !== original.ingress.statePath || Date.parse(aborted.observedAt) < Date.parse(original.observedAt)) {
    throw new Error('Cold abort evidence does not match the original deployment bindings.');
  }
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
    if (['cold-preflight', 'cold-enter', 'cold-abort'].includes(command)) {
      if (args.length !== 1) throw new Error(`${command} requires exactly one host evidence JSON path.`);
      const evidence = JSON.parse(await readFile(args[0], 'utf8'));
      const operation = { 'cold-preflight': 'coldPreflight', 'cold-enter': 'coldEnter', 'cold-abort': 'coldAbort' }[command];
      result = await control[operation](owner, evidence);
    }
    else if (command === 'status') result = await control.status();
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
