import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, type TestContext } from "node:test";

interface ProcessIdentity { pid: number; startTime: string; bootId: string; ppid?: number }
interface Snapshot { master: ProcessIdentity; workers: ProcessIdentity[] }
interface Endpoint { address: string; port: number; tls: boolean }
interface Summary { protocol: string; phase: string; closed: boolean; drained: boolean }
interface State extends Summary {
  token: string;
  oldWorkers: ProcessIdentity[];
  original: string;
  replacementHash: string;
  master: ProcessIdentity;
  site: { target: string; enabled: string };
}
interface Options {
  sitesEnabled: string;
  timeoutMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  withLock: (file: string, operation: () => Promise<unknown>) => Promise<unknown>;
  runCommand: (program: string, args: string[], timeoutMs: number) => Promise<string>;
  processes: { snapshot: () => Promise<Snapshot>; identity: (pid: number) => Promise<ProcessIdentity | null> };
  probe: (request: { endpoint: Endpoint; hostname: string; token: string; timeoutMs: number }) => Promise<{ status: number; marker?: string }>;
  readInclude: (file: string) => Promise<Buffer>;
}
interface Control {
  enter(file: string, url: string): Promise<Summary>;
  restore(file: string): Promise<Summary>;
  status(file: string): Promise<Summary>;
}
const helperUrl = new URL("../../../scripts/production-cold-ingress.mjs", import.meta.url).href;
const { coldIngressControl, buildBarrier, nginxProcesses } = await import(helperUrl) as {
  coldIngressControl(options: Options): Control;
  buildBarrier(bytes: Buffer, hostname: string, token: string): { replacement: Buffer; endpoints: Endpoint[] };
  nginxProcesses(options: { procRoot: string; runCommand: (program: string, args: string[]) => Promise<string> }): {
    snapshot(timeoutMs: number): Promise<Snapshot>; identity(pid: number): Promise<ProcessIdentity | null>;
  };
};
const HOST = "video.wangjinkun333.me";
const HEALTH = `https://${HOST}/api/health`;
const BOOT = "01234567-89ab-cdef-0123-456789abcdef";
const processId = (pid: number, startTime = String(pid)): ProcessIdentity => ({ pid, startTime, bootId: BOOT });
const ORIGINAL = Buffer.from(`server {
    server_name ${HOST};
    client_max_body_size 256m;
    add_header Content-Security-Policy "default-src 'self'; frame-ancestors 'none'" always;
    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1200s;
        proxy_send_timeout 1200s;
    }
    listen [::]:443 ssl ipv6only=on;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/${HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${HOST}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
server {
    if ($host = ${HOST}) { return 301 https://$host$request_uri; }
    listen 80;
    listen [::]:80;
    server_name ${HOST};
    return 404;
}
`);
const OTHER = "server { listen 80; server_name other.example.com; location / { return 200 'other'; } }\n";

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "vf-cold-ingress-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const available = path.join(directory, "sites-available");
  const enabled = path.join(directory, "sites-enabled");
  const transaction = path.join(directory, "deployment");
  await Promise.all([mkdir(available), mkdir(enabled), mkdir(transaction, { mode: 0o700 })]);
  const target = path.join(available, HOST);
  const link = path.join(enabled, HOST);
  const other = path.join(available, "other");
  const stateFile = path.join(transaction, "ingress.json");
  await writeFile(target, ORIGINAL, { mode: 0o644 });
  await writeFile(other, OTHER);
  await symlink(`../sites-available/${HOST}`, link);
  await symlink("../sites-available/other", path.join(enabled, "other"));
  let timestamp = 1000;
  let master = processId(100);
  let workers = [processId(200), processId(201)];
  const live = new Map(workers.map((worker) => [worker.pid, worker]));
  const held = new Set<number>();
  const commands: string[] = [];
  const probes: Endpoint[] = [];
  let commandHook: ((program: string, args: string[]) => Promise<void>) | undefined;
  let probeHook: ((endpoint: Endpoint, token: string) => Promise<{ status: number; marker?: string } | undefined>) | undefined;
  let identityHook: ((pid: number) => Promise<void>) | undefined;
  let sleepHook: (() => Promise<void>) | undefined;
  let snapshotHook: (() => Promise<void>) | undefined;
  let effectiveExtra = "";
  let nextPid = 300;
  let reloads = 0;
  let loaded = ORIGINAL.toString();
  let tlsOptions = Buffer.from("ssl_session_timeout 1440m; ssl_protocols TLSv1.2 TLSv1.3; ssl_session_tickets off;\n");
  const options: Options = {
    sitesEnabled: enabled, timeoutMs: 1500, now: () => timestamp,
    sleep: async (ms) => { timestamp += ms; await sleepHook?.(); },
    withLock: async (_file, operation) => operation(),
    readInclude: async () => tlsOptions,
    runCommand: async (program, args) => {
      commands.push(`${program} ${args.join(" ")}`);
      await commandHook?.(program, args);
      if (program === "nginx" && args[0] === "-T") {
        return `${effectiveExtra}\nhttp { include ${enabled}/*; }\n# configuration file ${link}:\n${await readFile(target, "utf8")}`;
      }
      if (program === "systemctl") {
        reloads++;
        const record = await readState();
        assert.ok(["reloading", "draining", "restore-reloading", "restore-draining"].includes(record.phase));
        assert.equal(record.closed, false);
        assert.equal(record.drained, false);
        loaded = await readFile(target, "utf8");
        for (const worker of workers) if (!held.has(worker.pid)) live.delete(worker.pid);
        workers = [processId(nextPid++), processId(nextPid++)];
        for (const worker of workers) live.set(worker.pid, worker);
      }
      return "";
    },
    processes: {
      snapshot: async () => { await snapshotHook?.(); return { master, workers: [...live.values()] }; },
      identity: async (pid) => { await identityHook?.(pid); return live.get(pid) ?? null; },
    },
    probe: async ({ endpoint, hostname, token }) => {
      assert.equal(hostname, HOST);
      assert.ok(token.match(/^[a-f0-9]{32}$/));
      probes.push(endpoint);
      const override = await probeHook?.(endpoint, token);
      return override ?? (loaded.includes(token) ? { status: 503, marker: token } : { status: 404 });
    },
  };
  async function readState(): Promise<State> { return JSON.parse(await readFile(stateFile, "utf8")) as State; }
  return {
    directory, available, enabled, transaction, target, link, other, stateFile, commands, probes, live, held, options,
    readState, control: coldIngressControl(options), fresh: () => coldIngressControl(options),
    setCommandHook(fn?: typeof commandHook) { commandHook = fn; },
    setProbeHook(fn?: typeof probeHook) { probeHook = fn; },
    setIdentityHook(fn?: typeof identityHook) { identityHook = fn; },
    setSleepHook(fn?: typeof sleepHook) { sleepHook = fn; },
    setSnapshotHook(fn?: typeof snapshotHook) { snapshotHook = fn; },
    setMaster(value: ProcessIdentity) { master = value; },
    setLoaded(value: string) { loaded = value; },
    setEffective(value: string) { effectiveExtra = value; },
    setTlsOptions(value: string) { tlsOptions = Buffer.from(value); },
    get reloads() { return reloads; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function closedBytes(f: Fixture) {
  const bytes = await readFile(f.target);
  assert.notDeepEqual(bytes, ORIGINAL);
  assert.ok(bytes.toString().includes("X-VideoFactory-Cold-Ingress"));
  return bytes;
}

describe("production cold ingress transaction", () => {
  it("closes both protocols, proves old worker exit, and restores exact bytes and metadata without touching other sites", async (t) => {
    const f = await fixture(t);
    const otherStat = await lstat(f.other);
    const originalStat = await lstat(f.target);
    const linkStat = await lstat(f.link);
    const result = await f.control.enter(f.stateFile, HEALTH);
    assert.equal(result.phase, "closed");
    assert.equal(result.closed, true);
    assert.equal(result.drained, true);
    assert.equal(f.reloads, 2);
    assert.deepEqual(new Set(f.probes.map((entry) => `${entry.address}:${entry.port}:${entry.tls}`)), new Set([
      "127.0.0.1:80:false", "::1:80:false", "127.0.0.1:443:true", "::1:443:true",
    ]));
    const state = await f.readState();
    assert.equal((await lstat(f.stateFile)).mode & 0o777, 0o600);
    assert.deepEqual(Buffer.from(state.original, "base64"), ORIGINAL);
    assert.ok(state.oldWorkers.some((worker) => worker.pid === 200));
    assert.ok(state.oldWorkers.some((worker) => worker.pid === 300));
    const barrier = await closedBytes(f);
    assert.equal((barrier.toString().match(/if \(\$vf_cold_ingress_request/g) ?? []).length, 2);
    assert.ok(barrier.toString().includes('"^(GET|HEAD):/api/health$"'));
    assert.ok(barrier.toString().indexOf("if ($vf_cold_ingress_request") < barrier.toString().indexOf("if ($host"));
    assert.equal((await f.control.status(f.stateFile)).phase, "closed");
    assert.equal((await f.fresh().restore(f.stateFile)).phase, "restored");
    assert.deepEqual(await readFile(f.target), ORIGINAL);
    assert.equal((await lstat(f.target)).mode, originalStat.mode);
    assert.equal((await lstat(f.target)).uid, originalStat.uid);
    assert.equal((await lstat(f.target)).gid, originalStat.gid);
    assert.equal((await lstat(f.link)).ino, linkStat.ino);
    assert.equal(await readlink(f.link), `../sites-available/${HOST}`);
    assert.equal(await readFile(f.other, "utf8"), OTHER);
    assert.equal((await lstat(f.other)).ino, otherStat.ino);
    assert.equal((await f.readState()).phase, "restored");
    const reloads = f.reloads;
    await f.fresh().restore(f.stateFile);
    assert.equal(f.reloads, reloads);
    await assert.rejects(() => f.control.enter(f.stateFile, HEALTH), /after restore/);
  });

  it("preserves unrelated server blocks in the selected file byte-for-byte", () => {
    const combined = Buffer.concat([ORIGINAL, Buffer.from(OTHER)]);
    const plan = buildBarrier(combined, HOST, "a".repeat(32));
    assert.ok(plan.replacement.toString().endsWith(OTHER));
    assert.equal((plan.replacement.toString().match(/X-VideoFactory-Cold-Ingress/g) ?? []).length, 2);
  });

  it("supports a single HTTP proxy server without HTTPS", async (t) => {
    const f = await fixture(t);
    const bytes = Buffer.from(`server { listen 80; server_name ${HOST}; location / { proxy_pass http://127.0.0.1:4317; } }`);
    await writeFile(f.target, bytes);
    await f.control.enter(f.stateFile, `http://${HOST}/api/health`);
    assert.ok(f.probes.every((endpoint) => !endpoint.tls));
    await f.control.restore(f.stateFile);
    assert.deepEqual(await readFile(f.target), bytes);
  });

  it("keeps the barrier and durable phase on worker timeout, then resumes in a new controller", async (t) => {
    const f = await fixture(t);
    f.held.add(200);
    await assert.rejects(() => f.control.enter(f.stateFile, HEALTH), /timed out/);
    const state = await f.readState();
    assert.equal(state.phase, "draining");
    assert.equal(state.closed, false);
    assert.equal(state.drained, false);
    const bytes = await closedBytes(f);
    assert.equal(f.commands.some((entry) => /kill|stop|restart/.test(entry)), false);
    assert.ok(f.live.has(200));
    f.live.delete(200);
    f.held.delete(200);
    assert.equal((await f.fresh().enter(f.stateFile, HEALTH)).phase, "closed");
    assert.deepEqual(await readFile(f.target), bytes);
  });

  it("waits while an accepted request's worker lives even after all new probes return503", async (t) => {
    const f = await fixture(t);
    f.held.add(200);
    let sleeps = 0;
    f.setSleepHook(async () => {
      assert.ok(f.probes.length >= 4);
      assert.equal((await f.readState()).closed, false);
      if (++sleeps === 3) f.live.delete(200);
    });
    assert.equal((await f.control.enter(f.stateFile, HEALTH)).phase, "closed");
    assert.equal(sleeps, 3);
  });

  it("uses boot and /proc start identity rather than mere PID existence", async (t) => {
    const f = await fixture(t);
    f.held.add(200);
    f.setIdentityHook(async (pid) => { if (pid === 200) f.live.set(200, processId(200, "999999")); });
    assert.equal((await f.control.enter(f.stateFile, HEALTH)).phase, "closed");
    assert.ok(f.live.has(200));
  });

  it("captures workers created between the first snapshot and first reload", async (t) => {
    const f = await fixture(t);
    f.setCommandHook(async (program) => {
      if (program === "systemctl" && f.reloads === 0) {
        f.live.set(250, processId(250));
        f.held.add(250);
      }
    });
    await assert.rejects(() => f.control.enter(f.stateFile, HEALTH), /timed out/);
    assert.ok((await f.readState()).oldWorkers.some((worker) => worker.pid === 250));
    await closedBytes(f);
  });

  for (const failure of ["nginx-test", "reload", "probe", "unmarked503", "master", "proc-read"] as const) {
    it(`fails closed on ${failure} and retains recoverable evidence`, async (t) => {
      const f = await fixture(t);
      f.setCommandHook(async (program, args) => {
        if ((failure === "nginx-test" && program === "nginx" && args[0] === "-t")
          || (failure === "reload" && program === "systemctl")) throw new Error("injected failure");
      });
      if (failure === "probe") f.setProbeHook(async () => { throw new Error("connection refused"); });
      if (failure === "unmarked503") f.setProbeHook(async () => ({ status: 503 }));
      if (failure === "master") f.setProbeHook(async () => { f.setMaster(processId(100, "999")); return undefined; });
      if (failure === "proc-read") f.setIdentityHook(async () => { throw new Error("EACCES"); });
      await assert.rejects(() => f.control.enter(f.stateFile, HEALTH));
      await closedBytes(f);
      assert.equal((await f.readState()).closed, false);
      assert.equal((await f.readState()).drained, false);
      if (failure === "nginx-test") assert.equal(f.reloads, 0);
      f.setCommandHook(); f.setProbeHook(); f.setIdentityHook();
      await f.fresh().restore(f.stateFile);
      assert.deepEqual(await readFile(f.target), ORIGINAL);
    });
  }

  for (const change of ["bytes", "same-bytes-new-inode", "link", "mode", "include"] as const) {
    it(`refuses restore and status after external ${change} change`, async (t) => {
      const f = await fixture(t);
      await f.control.enter(f.stateFile, HEALTH);
      if (change === "bytes") await writeFile(f.target, `${await readFile(f.target, "utf8")}\n# operator changed\n`);
      if (change === "same-bytes-new-inode") {
        const temporary = `${f.target}.operator`;
        await writeFile(temporary, await readFile(f.target), { mode: 0o644 });
        await rename(temporary, f.target);
      }
      if (change === "link") { await rm(f.link); await symlink(f.target, f.link); }
      if (change === "mode") await chmod(f.target, 0o600);
      if (change === "include") f.setTlsOptions("ssl_protocols TLSv1.3;");
      const current = await readFile(f.target);
      await assert.rejects(() => f.control.status(f.stateFile));
      await assert.rejects(() => f.control.restore(f.stateFile));
      assert.deepEqual(await readFile(f.target), current);
    });
  }

  it("requires a fresh live marker for status even when persisted proof is closed", async (t) => {
    const f = await fixture(t);
    await f.control.enter(f.stateFile, HEALTH);
    f.setLoaded(ORIGINAL.toString());
    await assert.rejects(() => f.control.status(f.stateFile), /no longer valid/);
    assert.equal((await f.readState()).phase, "closed");
  });

  for (const failure of ["test", "reload", "probe", "drain"] as const) {
    it(`resumes restore after ${failure} failure without losing the original bytes`, async (t) => {
      const f = await fixture(t);
      await f.control.enter(f.stateFile, HEALTH);
      f.setCommandHook(async (program, args) => {
        if ((failure === "test" && args[0] === "-t") || (failure === "reload" && program === "systemctl")) throw new Error("restore failure");
      });
      if (failure === "probe") f.setProbeHook(async (_endpoint, token) => ({ status: 503, marker: token }));
      if (failure === "drain") for (const pid of f.live.keys()) f.held.add(pid);
      await assert.rejects(() => f.control.restore(f.stateFile));
      assert.deepEqual(await readFile(f.target), ORIGINAL);
      assert.ok((await f.readState()).phase.startsWith("restor"));
      assert.equal((await f.readState()).closed, false);
      f.setCommandHook(); f.setProbeHook();
      for (const pid of f.held) f.live.delete(pid);
      f.held.clear();
      await f.fresh().restore(f.stateFile);
      assert.deepEqual(await readFile(f.target), ORIGINAL);
      assert.equal((await f.readState()).phase, "restored");
    });
  }

  it("restores a durable prepared transaction without replacing or reloading anything", async (t) => {
    const f = await fixture(t);
    let snapshots = 0;
    f.setSnapshotHook(async () => { if (++snapshots === 2) throw new Error("crash before config mutation"); });
    await assert.rejects(() => f.control.enter(f.stateFile, HEALTH));
    assert.equal((await f.readState()).phase, "prepared");
    assert.deepEqual(await readFile(f.target), ORIGINAL);
    f.setSnapshotHook();
    const stat = await lstat(f.target);
    await f.fresh().restore(f.stateFile);
    assert.equal((await lstat(f.target)).ino, stat.ino);
    assert.equal(f.reloads, 0);
  });

  it("refuses a preexisting invalid transaction, symlink state and public state directory", async (t) => {
    const f = await fixture(t);
    await writeFile(f.stateFile, "{invalid", { mode: 0o600 });
    await assert.rejects(() => f.control.enter(f.stateFile, HEALTH));
    assert.equal(await readFile(f.stateFile, "utf8"), "{invalid");
    await rm(f.stateFile);
    await symlink(f.other, f.stateFile);
    await assert.rejects(() => f.control.enter(f.stateFile, HEALTH));
    await rm(f.stateFile);
    await chmod(f.transaction, 0o755);
    await assert.rejects(() => f.control.enter(f.stateFile, HEALTH), /owner-private/);
    assert.deepEqual(await readFile(f.target), ORIGINAL);
  });

  for (const change of ["duplicate", "alias", "wildcard", "regex-other", "proxy", "error-page", "rewrite", "location", "tls-include", "shutdown-timeout", "missing-effective", "effective-alias"] as const) {
    it(`rejects unknown or ambiguous ${change} before any configuration change`, async (t) => {
      const f = await fixture(t);
      if (change === "duplicate") await symlink(f.target, path.join(f.enabled, "duplicate"));
      if (change === "alias") await writeFile(f.target, ORIGINAL.toString().replace(`server_name ${HOST};`, `server_name ${HOST} alias.example.com;`));
      if (change === "wildcard") await writeFile(f.other, "server { listen 80; server_name *.wangjinkun333.me; }");
      if (change === "regex-other") await writeFile(f.other, "server { listen 80; server_name ~^other; }");
      if (change === "proxy") await writeFile(f.target, ORIGINAL.toString().replace(":4317", ":4318"));
      if (change === "error-page") await writeFile(f.target, ORIGINAL.toString().replace("client_max_body_size 256m;", "error_page 503 /fallback;"));
      if (change === "rewrite") await writeFile(f.target, ORIGINAL.toString().replace("client_max_body_size 256m;", "rewrite ^ /api/write;"));
      if (change === "location") await writeFile(f.target, ORIGINAL.toString().replace("location / {", "location = /api/health {"));
      if (change === "tls-include") f.setTlsOptions("rewrite ^ /unsafe;");
      if (change === "shutdown-timeout") f.setEffective("worker_shutdown_timeout 10s;");
      if (change === "effective-alias") f.setEffective(`server { listen 8080; server_name ${HOST}; }`);
      if (change === "missing-effective") f.options.runCommand = async () => "http {}";
      const bytes = await readFile(f.target);
      await assert.rejects(() => f.fresh().enter(f.stateFile, HEALTH));
      assert.deepEqual(await readFile(f.target), bytes);
      await assert.rejects(() => f.readState(), { code: "ENOENT" });
      assert.equal(f.reloads, 0);
    });
  }

  it("accepts explicit zero worker shutdown timeout", async (t) => {
    const f = await fixture(t);
    f.setEffective("worker_shutdown_timeout 0s;");
    assert.equal((await f.control.enter(f.stateFile, HEALTH)).phase, "closed");
  });

  for (const url of [`https://${HOST}/`, `https://${HOST}/api/health?x=1`, `https://${HOST}:8443/api/health`,
    `https://user:secret@${HOST}/api/health`, `file:///api/health`, `https://127.0.0.1/api/health`]) {
    it(`rejects an unsupported public health URL (${url.replace(/user:secret@/, "credentials@")})`, async (t) => {
      const f = await fixture(t);
      await assert.rejects(() => f.control.enter(f.stateFile, url));
      assert.deepEqual(await readFile(f.target), ORIGINAL);
      assert.equal(f.commands.length, 0);
    });
  }
});

describe("Linux Nginx process observations", () => {
  it("reads PID/starttime/boot identity, checks the master and refuses unknown children", async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-nginx-proc-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, "sys/kernel/random"), { recursive: true });
    await writeFile(path.join(directory, "sys/kernel/random/boot_id"), `${BOOT}\n`);
    async function proc(pid: number, ppid: number, title: string, start: string) {
      const root = path.join(directory, String(pid));
      await mkdir(path.join(root, "task", String(pid)), { recursive: true });
      const fields = ["S", String(ppid), ...Array<string>(17).fill("0"), start, "0"];
      await writeFile(path.join(root, "stat"), `${pid} (nginx) ${fields.join(" ")}\n`);
      await writeFile(path.join(root, "cmdline"), `${title}\0`);
    }
    await proc(100, 1, "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", "300");
    await proc(200, 100, "nginx: worker process", "400");
    await proc(201, 100, "nginx: worker process is shutting down", "450");
    await writeFile(path.join(directory, "100/task/100/children"), "200 201 ");
    const calls: string[][] = [];
    const processes = nginxProcesses({ procRoot: directory, runCommand: async (program, args) => {
      assert.equal(program, "systemctl"); calls.push(args); return "100\n";
    } });
    const snapshot = await processes.snapshot(1000);
    assert.equal(snapshot.master.startTime, "300");
    assert.deepEqual(snapshot.workers.map((worker) => worker.startTime), ["400", "450"]);
    assert.equal(snapshot.workers[0]?.bootId, BOOT);
    assert.deepEqual(calls[0], ["show", "nginx", "--property=MainPID", "--value"]);
    await rm(path.join(directory, "200"), { recursive: true });
    assert.equal(await processes.identity(200), null);
    await proc(200, 100, "", "600");
    const stable = new Promise<void>((resolve, reject) => {
      setTimeout(() => { writeFile(path.join(directory, "200/cmdline"), "nginx: worker process\0").then(resolve, reject); }, 40);
    });
    assert.equal((await processes.snapshot(1000)).workers.length, 2);
    await stable;
    await proc(200, 100, "nginx: cache manager process", "600");
    await assert.rejects(() => processes.snapshot(1000), /Unknown Nginx child/);
    await proc(200, 100, "nginx: worker process", "600");
    await proc(100, 1, "nginx: master process /usr/sbin/nginx -c /unverified/nginx.conf", "300");
    await assert.rejects(() => processes.snapshot(1000), /nonstandard/);
    await rm(path.join(directory, "sys/kernel/random/boot_id"));
    await assert.rejects(() => processes.identity(200), { code: "ENOENT" });
  });
});
