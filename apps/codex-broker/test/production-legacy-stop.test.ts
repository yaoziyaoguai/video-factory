import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";

const helperPath = path.resolve(import.meta.dirname, "../../../scripts/production-legacy-stop.mjs");
const helper = await import(new URL(`file://${helperPath}`).href) as {
  pid1Identity(procRoot: string): { startTime: string; bootId: string; cgroup: string };
  assertLegacyIdle(helperPid: number, procRoot: string, workspace: string): void;
  debugListeners(procRoot: string): { address: string; inode: string }[];
};
const BOOT = "01234567-89ab-cdef-0123-456789abcdef";
const run = promisify(execFile);
const docker = (...args: string[]) => run("docker", args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function procFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "vf-legacy-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = path.join(root, "proc");
  const workspace = path.join(root, "workspace");
  for (const target of ["1/task/1", "1/fd", "1/net", "42", "sys/kernel/random"]) await mkdir(path.join(proc, target), { recursive: true });
  await mkdir(path.join(workspace, "runs"), { recursive: true });
  await writeFile(path.join(proc, "1/stat"), `1 (node) S 0 ${Array<string>(17).fill("0").join(" ")} 1234 0\n`);
  await writeFile(path.join(proc, "1/cmdline"), "node\0apps/studio/dist/server/server/main.js\0");
  await writeFile(path.join(proc, "1/cgroup"), "0::/docker/fixture\n");
  await writeFile(path.join(proc, "1/task/1/children"), "");
  await writeFile(path.join(proc, "sys/kernel/random/boot_id"), `${BOOT}\n`);
  await symlink("/app", path.join(proc, "1/cwd"));
  await symlink("/usr/local/bin/node", path.join(proc, "1/exe"));
  for (const name of ["tcp", "tcp6"]) await writeFile(path.join(proc, `1/net/${name}`), "header\n");
  return { proc, workspace };
}

describe("bounded legacy stop process proofs", () => {
  it("binds PID1 start/boot/cgroup and rejects another entrypoint", async (t) => {
    const f = await procFixture(t);
    assert.deepEqual(helper.pid1Identity(f.proc), { startTime: "1234", bootId: BOOT, cgroup: "0::/docker/fixture\n" });
    await writeFile(path.join(f.proc, "1/cmdline"), "node\0unrelated.js\0");
    assert.throws(() => helper.pid1Identity(f.proc), /entrypoint/);
  });
  it("requires empty runs, no other process, no children on any thread, and no workspace descriptors", async (t) => {
    const f = await procFixture(t);
    helper.assertLegacyIdle(42, f.proc, f.workspace);
    const runFile = path.join(f.workspace, "runs", "completed.json");
    await writeFile(runFile, "{}");
    assert.throws(() => helper.assertLegacyIdle(42, f.proc, f.workspace), /empty runs/);
    await rm(runFile);
    await mkdir(path.join(f.proc, "99"));
    assert.throws(() => helper.assertLegacyIdle(42, f.proc, f.workspace), /another process/);
    await rm(path.join(f.proc, "99"), { recursive: true });
    await mkdir(path.join(f.proc, "1/task/7"));
    await writeFile(path.join(f.proc, "1/task/7/children"), "99 ");
    assert.throws(() => helper.assertLegacyIdle(42, f.proc, f.workspace), /children/);
    await writeFile(path.join(f.proc, "1/task/7/children"), "");
    await symlink(path.join(f.workspace, "settings.json"), path.join(f.proc, "1/fd/19"));
    assert.throws(() => helper.assertLegacyIdle(42, f.proc, f.workspace), /workspace file/);
  });
  it("detects a debugger bound to any address, including IPv6", async (t) => {
    const f = await procFixture(t);
    assert.deepEqual(helper.debugListeners(f.proc), []);
    const row = (address: string) => `0: ${address}:240D 00000000:0000 0A 0:0 00:0 0 1001 0 999\n`;
    await writeFile(path.join(f.proc, "1/net/tcp"), `header\n${row("00000000")}`);
    await writeFile(path.join(f.proc, "1/net/tcp6"), `header\n${row("00000000000000000000000001000000")}`);
    assert.equal(helper.debugListeners(f.proc).length, 2);
  });
});

const fixtureSource = `
const http = require('node:http');
const fs = require('node:fs');
const inspector = require('node:inspector');
const { spawn } = require('node:child_process');
const mode = process.env.FIXTURE_MODE;
const server = http.createServer((req, res) => res.end('ok'));
let child, extra;
if (mode === 'child') child = spawn('node', ['-e', 'setTimeout(()=>{},20000)']);
if (mode === 'debug') inspector.open(9229, '127.0.0.1');
if (mode === 'debug-other') inspector.open(9333, '127.0.0.1');
if (mode === 'extra') extra = http.createServer((q,r)=>r.end('extra')).listen(4318);
if (mode === 'runtime') process.env.VIDEO_FACTORY_WORKSPACE = '/different';
if (mode === 'native') process.once('SIGTERM', () => server.close());
server.listen(4317, '0.0.0.0', () => console.log('ready'));
// 失败测试也自然退出，便于清理本地 fixture，不用 SIGKILL。
setTimeout(() => { inspector.close(); server.close(); extra?.close(); child?.kill('SIGTERM'); }, 20000).unref();
`;

async function dockerFixture(t: TestContext, mode = "legacy") {
  const artifacts = path.resolve(import.meta.dirname, "../../../.local/legacy-stop-tests");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, "legacy-pid1-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "app/apps/studio/dist/server/server");
  const workspace = path.join(root, "workspace");
  await mkdir(entry, { recursive: true, mode: 0o755 });
  await mkdir(path.join(workspace, "runs"), { recursive: true, mode: 0o777 });
  await chmod(root, 0o755);
  await chmod(workspace, 0o777);
  await chmod(path.join(workspace, "runs"), 0o777);
  await writeFile(path.join(entry, "main.js"), fixtureSource, { mode: 0o644 });
  if (mode === "runs") await writeFile(path.join(workspace, "runs/previous.json"), "{}");
  const network = `vf-legacy-stop-${path.basename(root).toLowerCase()}`;
  await docker("network", "create", "--internal", network);
  const { stdout } = await docker("run", "-d", "--network", network, "--restart", "unless-stopped", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1001:1001",
    "--mount", `type=bind,src=${path.join(root, "app")},dst=/app,readonly`, "--mount", `type=bind,src=${workspace},dst=/data/factory`,
    "-w", "/app", "-e", "VIDEO_FACTORY_WORKSPACE=/data/factory", "-e", `FIXTURE_MODE=${mode}`, "node:22-alpine", "node", "apps/studio/dist/server/server/main.js");
  const id = stdout.trim();
  const controllers: ReturnType<typeof spawn>[] = [];
  const startStop = () => {
    const cli = spawn("docker", ["stop", "--time", "-1", id], { stdio: "ignore" });
    controllers.push(cli);
    return cli;
  };
  t.after(async () => {
    // 原 fixture 的计时器关闭所有资源；stop 同时阻止 restart policy 再拉起。
    startStop();
    await run("docker", ["wait", id], { timeout: 25_000 });
    await docker("rm", id);
    await docker("network", "rm", network);
    for (const cli of controllers) if (cli.exitCode === null) cli.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 40; i++) {
    if ((await docker("logs", id)).stdout.includes("ready")) break;
    await wait(50);
  }
  assert.match((await docker("logs", id)).stdout, /ready/);
  const inspect = async () => JSON.parse((await docker("inspect", id)).stdout)[0] as {
    State: { Running: boolean; ExitCode: number; Pid: number }; RestartCount: number;
  };
  const proof = async () => JSON.parse((await docker("exec", id, "node", "-e", `const f=require('node:fs'); const s=f.readFileSync('/proc/1/stat','utf8'); console.log(JSON.stringify({startTime:s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/)[19],bootId:f.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}))`)).stdout) as { startTime: string; bootId: string };
  const arm = async (expected?: { startTime: string; bootId: string }) => {
    expected ??= await proof();
    const source = await readFile(helperPath, "utf8");
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const cli = spawn("docker", ["exec", "-i", id, "node", "--input-type=module", "-", JSON.stringify(expected)]);
      let stdout = "", stderr = "";
      const timeout = setTimeout(() => { cli.kill("SIGTERM"); reject(new Error("legacy helper timeout")); }, 15_000);
      cli.stdout.on("data", (data: Buffer) => { stdout += data; });
      cli.stderr.on("data", (data: Buffer) => { stderr += data; });
      cli.on("error", reject);
      cli.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      cli.stdin.end(source);
    });
  };
  const debuggerOpen = async () => (await docker("exec", id, "node", "-e", `const h=require('node:http'); h.get('http://127.0.0.1:9229/json/list',r=>{r.resume();console.log('open')}).on('error',()=>console.log('closed'))`)).stdout.trim() === "open";
  const term = async () => {
    const hostPid = (await inspect()).State.Pid;
    // 从宿主 PID namespace 发信号；容器内临时 exec 信号进程会正确触发“额外进程”拒绝。
    await docker("run", "--rm", "--network", "none", "--pid", "host", "--user", "1001:1001", "--cap-drop", "ALL", "node:22-alpine", "node", "-e", `process.kill(${hostPid}, 'SIGTERM')`);
  };
  return { id, arm, proof, inspect, startStop, debuggerOpen, workspace, term };
}

describe("Linux Docker Node PID1 legacy stop", { skip: process.env.VF_LEGACY_STOP_DOCKER !== "1", concurrency: false }, () => {
  it("unblocks an existing stop RPC, closes debugger before SIGTERM, exits0 and does not restart", async (t) => {
    const f = await dockerFixture(t);
    const before = await f.inspect();
    f.startStop();
    await wait(300);
    assert.equal((await f.inspect()).State.Running, true, "unhandled PID1 must survive normal Docker stop");
    f.startStop();
    const result = await f.arm();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).mode, "legacy-once");
    assert.equal(await f.debuggerOpen(), false);
    assert.equal((await f.inspect()).State.Running, true, "arming must not close the server");
    const repeated = await f.arm();
    assert.notEqual(repeated.code, 0, "compatibility listener is one-time per PID1");
    assert.equal(await f.debuggerOpen(), false);
    await f.term();
    assert.equal((await docker("wait", f.id)).stdout.trim(), "0");
    await wait(300);
    const after = await f.inspect();
    assert.equal(after.State.Running, false);
    assert.equal(after.State.ExitCode, 0);
    assert.equal(after.RestartCount, before.RestartCount);
  });
  for (const mode of ["runs", "child", "debug", "debug-other", "extra", "runtime"]) {
    it(`refuses ${mode} without closing the app or taking an unrelated debugger`, async (t) => {
      const f = await dockerFixture(t, mode);
      const result = await f.arm();
      assert.notEqual(result.code, 0);
      assert.equal((await f.inspect()).State.Running, true);
      assert.equal(await f.debuggerOpen(), mode === "debug");
    });
  }
  it("refuses a changed PID1 identity before opening the debugger", async (t) => {
    const f = await dockerFixture(t);
    const proof = await f.proof();
    const result = await f.arm({ ...proof, startTime: String(Number(proof.startTime) + 1) });
    assert.notEqual(result.code, 0);
    assert.equal((await f.inspect()).State.Running, true);
    assert.equal(await f.debuggerOpen(), false);
  });
  it("preserves an existing JS signal handler without adding a compatibility handler", async (t) => {
    const f = await dockerFixture(t, "native");
    const result = await f.arm();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, "native-handler");
    assert.equal(await f.debuggerOpen(), false);
    f.startStop();
    assert.equal((await docker("wait", f.id)).stdout.trim(), "0");
  });
  it("expires an unused compatibility listener without closing the server or leaving debug open", async (t) => {
    const f = await dockerFixture(t);
    const result = await f.arm();
    assert.equal(result.code, 0, result.stderr);
    await wait(15_100);
    assert.equal(await f.debuggerOpen(), false);
    await f.term();
    await wait(100);
    assert.equal((await f.inspect()).State.Running, true, "expired helper must no longer react to SIGTERM");
  });
  it("rechecks empty runs at SIGTERM and refuses work appearing after arming", async (t) => {
    const f = await dockerFixture(t);
    const result = await f.arm();
    assert.equal(result.code, 0, result.stderr);
    await writeFile(path.join(f.workspace, "runs/new-run.json"), "{}");
    await f.term();
    await wait(100);
    assert.equal((await f.inspect()).State.Running, true);
    assert.equal(await f.debuggerOpen(), false);
  });
});
