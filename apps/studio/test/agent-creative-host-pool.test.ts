import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 温热池/skills 跳过/命名卷 GC 的密封测试：以假 docker CLI 注入 PATH，无需真实 daemon。
// 真实容器行为仍由 FRAME_CREATIVE_DOCKER_SOCKET 门控的 agent-creative-runner.test.ts 覆盖。
const root = fileURLToPath(new URL("../../../", import.meta.url));
const hex = (character: string): string => character.repeat(64);
const workspaceA = hex("a");
const workspaceB = hex("b");

interface PoolDebugState { warmContainers: { name: string; projectVolume: string; skillsVolume: string }[]; syncedSkills: string[]; trackedVolumes: string[]; reservedVolumes: string[] }
interface HostHandle { socketPath: string; volumeNamespace: string; close(): Promise<void>; debugState(): PoolDebugState }

async function call(socketPath: string, input: unknown): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: "/", method: "POST" }, reply => {
      let text = "";
      reply.setEncoding("utf8");
      reply.on("data", chunk => { text += chunk; });
      reply.on("end", () => resolve({ status: reply.statusCode, body: text }));
      reply.on("error", reject);
    });
    request.on("error", reject);
    request.end(JSON.stringify(input));
  });
}

interface CreateHostExtras {
  /** 宿主启动前置钩子：预写卷状态或跨进程使用记录（使用记录在宿主创建时读取，必须提前落盘）；
   * 可返回 run 延迟配置——卷名只有在钩子内才能算出，而延迟要烘焙进假 docker 包装脚本。 */
  prepare?: (paths: { directory: string; runtimeDir: string; workspaceRoot: string; state: string }) =>
    Promise<{ shimDelay?: { volume: string; ms: number } } | void>;
}

async function createHost(options: Record<string, unknown>, extras: CreateHostExtras = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "creative-host-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin, { recursive: true });
  const state = path.join(directory, "volumes.json");
  const log = path.join(directory, "docker-calls.log");
  const runtimeDir = path.join(directory, "runtime");
  const workspaceRoot = path.join(directory, "workspaces");
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const prepared = extras.prepare ? await extras.prepare({ directory, runtimeDir, workspaceRoot, state }) : undefined;
  const fixture = new URL("fixtures/creative-docker-shim.mjs", import.meta.url).href;
  const delay = prepared?.shimDelay ? `, delay: ${JSON.stringify(prepared.shimDelay)}` : "";
  const script = `#!/usr/bin/env node\nimport(${JSON.stringify(fixture)}).then(module => module.main({ state: ${JSON.stringify(state)}, log: ${JSON.stringify(log)}${delay} }));\n`;
  await writeFile(path.join(bin, "docker"), script, { mode: 0o755 });
  const { createCreativeRunnerHost } = await import(new URL("../../../scripts/creative-runner-host.mjs", import.meta.url).href) as {
    createCreativeRunnerHost: (options: Record<string, unknown>) => Promise<HostHandle>;
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  const host = await createCreativeRunnerHost({ socketPath: path.join(runtimeDir, "s"), workspaceRoot, dockerSocket: "/nonexistent.sock", ...options });
  const readLog = async (): Promise<string[][]> => (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => (JSON.parse(line) as { argv: string[] }).argv);
  return {
    host, state, readLog,
    cleanup: async () => {
      await host.close();
      // 关闭时在途的 rm/清理 docker 调用可能仍需数毫秒收束，先等它落地再删目录。
      await new Promise(resolve => setTimeout(resolve, 50));
      process.env.PATH = originalPath;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const helperArgv = (argv: string[]): boolean => argv.at(-1) === "/opt/frame/creative-operations.py";
const hasReadonlyMount = (argv: string[]): boolean => argv.some(arg => arg.startsWith("type=volume,") && arg.endsWith(",readonly"));
const isInit = (argv: string[]): boolean => helperArgv(argv) && argv.includes("0:0");
const isWarm = (argv: string[]): boolean => helperArgv(argv) && hasReadonlyMount(argv);
const isSync = (argv: string[]): boolean => helperArgv(argv) && !hasReadonlyMount(argv) && !isInit(argv);
const readData = (body: string): string => Buffer.from((JSON.parse(body) as { data: string }).data, "base64").toString("utf8");
const waitFor = async (probe: () => boolean | Promise<boolean>, milliseconds = 4000): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (!(await probe())) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
};
// 与宿主同式的卷命名空间：预置使用记录时在宿主启动前计算卷名（使用记录创建时即被读取）。
const namespaceOf = async (workspaceRoot: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  const { realpath } = await import("node:fs/promises");
  return `frame-creative-${createHash("sha256").update(await realpath(workspaceRoot)).digest("hex").slice(0, 12)}`;
};

test("温热池复用同一容器，错误按请求隔离，跨工作区分池", async t => {
  const { host, readLog, cleanup } = await createHost({});
  t.after(cleanup);
  const image = await call(host.socketPath, { workspaceId: workspaceA, action: "image" });
  assert.equal(JSON.parse(image.body).imageId, `sha256:${"a".repeat(64)}`);

  const first = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/a.txt" });
  assert.match(readData(first.body), /^from:frame-creative-[0-9a-f-]+:\/workspace\/a\.txt$/);
  const containerA = readData(first.body).split(":")[1];

  const second = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/b.txt" });
  assert.equal(readData(second.body).split(":")[1], containerA);
  const afterReuse = await readLog();
  assert.equal(afterReuse.filter(isInit).length, 2, "工程卷与 Skill 卷各初始化一次");
  assert.equal(afterReuse.filter(isWarm).length, 1, "第二次读取不新增容器");
  assert.equal(afterReuse.filter(isSync).length, 0);

  const concurrent = await Promise.all([0, 1, 2].map(index => call(host.socketPath, { workspaceId: workspaceA, action: "read", path: `/workspace/c${index}.txt` })));
  for (const reply of concurrent) assert.equal(readData(reply.body).split(":")[1], containerA);

  const failed = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/fail-path.bin" });
  assert.equal(JSON.parse(failed.body).error, "boom");
  const recovered = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/after.txt" });
  assert.equal(readData(recovered.body).split(":")[1], containerA, "单请求失败后温热容器继续服务");
  assert.equal((await readLog()).filter(isWarm).length, 1, "错误恢复不触发冷启动");

  const other = await call(host.socketPath, { workspaceId: workspaceB, action: "read", path: "/workspace/x.txt" });
  const containerB = readData(other.body).split(":")[1];
  assert.notEqual(containerB, containerA);
  const logs = await readLog();
  assert.equal(logs.filter(isWarm).length, 2);
  assert.equal(logs.filter(isInit).length, 4, "新工作区各自初始化卷");
  assert.equal(host.debugState().warmContainers.length, 2);

  const badBase64 = await call(host.socketPath, { workspaceId: workspaceA, action: "write", path: "/workspace/x.bin", data: "AA=A" });
  assert.equal(badBase64.status, 400); assert.match(badBase64.body, /base64/);
  const extra = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/x", image: "arbitrary" });
  assert.equal(extra.status, 400); assert.match(extra.body, /不接受/);
});

test("同摘要 Skill 副本只在首次同步时拉起容器", async t => {
  const { host, readLog, cleanup } = await createHost({});
  t.after(cleanup);
  const files = [{ path: "native-fixture/SKILL.md", data: Buffer.from("---\nname: native-fixture\n---\n正文\n").toString("base64") }];
  const { createHash } = await import("node:crypto");
  const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const input = { workspaceId: workspaceA, action: "skills", revision, files };
  const first = await call(host.socketPath, input);
  assert.equal(first.body.trim(), "{}");
  const second = await call(host.socketPath, input);
  assert.equal(second.body.trim(), "{}");
  const logs = await readLog();
  assert.equal(logs.filter(isSync).length, 1, "第二次同步走跳过集，不再起容器");
  assert.equal(logs.filter(isWarm).length, 0);
  assert.equal(host.debugState().syncedSkills.length, 1);
});

test("R11 探测答复跟随宿主成功集合：未同步 needed，确认后不再需要", async t => {
  // 探测请求只携带工作区身份与修订摘要，不携带 files；宿主不起容器、不挂卷。
  const { host, readLog, cleanup } = await createHost({});
  t.after(cleanup);
  const files = [{ path: "native-fixture/SKILL.md", data: Buffer.from("---\nname: native-fixture\n---\n正文\n").toString("base64") }];
  const { createHash } = await import("node:crypto");
  const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const probeInput = { workspaceId: workspaceA, action: "skills", revision, probe: true };

  const beforeSync = await call(host.socketPath, probeInput);
  assert.equal(beforeSync.body.trim(), '{"needed":true}', "未同步过的修订应答复需要正文");
  assert.ok((await readLog()).every(argv => argv[0] === "image" && argv[1] === "inspect"), "探测不起容器、不动卷（仅宿主启动的镜像检查）");

  const synced = await call(host.socketPath, { workspaceId: workspaceA, action: "skills", revision, files });
  assert.equal(synced.body.trim(), "{}");
  const afterSync = await call(host.socketPath, probeInput);
  assert.equal(afterSync.body.trim(), '{"needed":false}', "宿主确认同步后探测答复不再需要");
  assert.equal((await readLog()).filter(isSync).length, 1, "全程只有一次正文同步容器");

  const badProbe = await call(host.socketPath, { workspaceId: workspaceA, action: "skills", revision: "not-a-hash", probe: true });
  assert.equal(badProbe.status, 400);
});

test("空闲超过阈值的温热容器被销毁，随后冷重启可用", async t => {
  const { host, readLog, cleanup } = await createHost({ warmIdleMs: 120 });
  t.after(cleanup);
  const first = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/a.txt" });
  const containerA = readData(first.body).split(":")[1]!;
  assert.ok(await waitFor(() => host.debugState().warmContainers.length === 0), "空闲容器应在超时后销毁");
  assert.ok(await waitFor(async () => (await readLog()).some(argv => argv[0] === "rm" && argv[1] === "--force" && argv.includes(containerA))), "销毁时强制移除容器");
  const second = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/a.txt" });
  const containerB = readData(second.body).split(":")[1]!;
  assert.notEqual(containerB, containerA);
  assert.equal((await readLog()).filter(isInit).length, 2, "重启不重复初始化卷");
});

test("命名卷 GC：超龄 Skill 卷回收，近期使用的卷与工程卷保留", async t => {
  // 近期卷的余量必须远大于整测时长：GC 无重入门闸，相邻周期的清扫会并发进行。
  const { host, state, readLog, cleanup } = await createHost({ gcIntervalMs: 50, volumeIdleMs: 5000 }, {
    prepare: async ({ runtimeDir, workspaceRoot, state }) => {
      const namespace = await namespaceOf(workspaceRoot);
      const oldVolume = `${namespace}-s-${hex("9")}-empty`;
      const recentVolume = `${namespace}-s-${hex("8")}-empty`;
      const oldProjectVolume = `${namespace}-p-${hex("7")}`;
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(runtimeDir, "creative-volume-usage.json"), JSON.stringify({
        [oldVolume]: Date.now() - 30 * 86400_000, [recentVolume]: Date.now() - 50,
        [oldProjectVolume]: Date.now() - 30 * 86400_000,
      }));
      await writeFile(state, JSON.stringify({ volumes: {
        [oldVolume]: { createdAt: Date.now() - 30 * 86400_000 },
        [recentVolume]: { createdAt: Date.now() - 29 * 86400_000 },
        [oldProjectVolume]: { createdAt: Date.now() - 30 * 86400_000 },
      } }));
    },
  });
  t.after(cleanup);
  const namespace = host.volumeNamespace;
  const oldVolume = `${namespace}-s-${hex("9")}-empty`;
  const recentVolume = `${namespace}-s-${hex("8")}-empty`;
  const oldProjectVolume = `${namespace}-p-${hex("7")}`;
  assert.ok(await waitFor(async () => {
    const volumes = (JSON.parse(await readFile(state, "utf8")) as { volumes: Record<string, unknown> }).volumes;
    return !Object.hasOwn(volumes, oldVolume);
  }), "使用记录超龄的 Skill 卷应被回收");
  const volumes = (JSON.parse(await readFile(state, "utf8")) as { volumes: Record<string, unknown> }).volumes;
  assert.ok(Object.hasOwn(volumes, recentVolume), "近期使用的卷应保留");
  // 工程卷承载可继续编辑的文件：即便使用记录超龄也不得回收（R3）。
  assert.ok(Object.hasOwn(volumes, oldProjectVolume), "超龄工程卷必须保留");
  const logs = await readLog();
  assert.ok(logs.some(argv => argv[0] === "volume" && argv[1] === "rm" && argv.at(-1) === oldVolume));
  assert.ok(!logs.some(argv => argv[0] === "volume" && argv[1] === "rm" && argv.at(-1) === recentVolume));
  assert.ok(!logs.some(argv => argv[0] === "volume" && argv[1] === "rm" && argv.at(-1) === oldProjectVolume), "工程卷绝不进入 rm");
});

test("无使用记录的卷先领养，绝不按创建年龄立即删除", async t => {
  // 升级首启/使用记录损坏场景：卷创建已久但可能是近期真实用过的，创建年龄不是最后使用时间。
  const { host, state, readLog, cleanup } = await createHost({ gcIntervalMs: 50, volumeIdleMs: 5000 }, {
    prepare: async ({ workspaceRoot, state }) => {
      const namespace = await namespaceOf(workspaceRoot);
      await writeFile(state, JSON.stringify({ volumes: {
        [`${namespace}-s-${hex("7")}-empty`]: { createdAt: Date.now() - 30 * 86400_000 },
      } }));
    },
  });
  t.after(cleanup);
  const volume = `${host.volumeNamespace}-s-${hex("7")}-empty`;
  assert.ok(await waitFor(() => host.debugState().trackedVolumes.includes(volume)), "无记录的卷应被领养进跟踪表");
  await new Promise(resolve => setTimeout(resolve, 300)); // 足够多轮 GC 周期。
  const volumes = (JSON.parse(await readFile(state, "utf8")) as { volumes: Record<string, unknown> }).volumes;
  assert.ok(Object.hasOwn(volumes, volume), "领养后未满完整闲置窗口的卷不得删除");
  assert.ok(!(await readLog()).some(argv => argv[0] === "volume" && argv[1] === "rm" && argv.at(-1) === volume));
});

test("在途请求的卷受保护：挂载前的 GC 窗口不回收，响应结束后照常回收", async t => {
  const { host, state, readLog, cleanup } = await createHost({ gcIntervalMs: 20, volumeIdleMs: 60, warmIdleMs: 600 }, {
    prepare: async ({ runtimeDir, workspaceRoot, state }) => {
      const namespace = await namespaceOf(workspaceRoot);
      const volume = `${namespace}-s-${workspaceA}-empty`;
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(runtimeDir, "creative-volume-usage.json"), JSON.stringify({ [volume]: Date.now() - 3600_000 }));
      await writeFile(state, JSON.stringify({ volumes: { [volume]: { createdAt: Date.now() - 86400_000 } } }));
      return { shimDelay: { volume, ms: 300 } };
    },
  });
  t.after(cleanup);
  const first = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/a.txt" });
  assert.match(readData(first.body), /^from:frame-creative-[0-9a-f-]+:\/workspace\/a\.txt$/, "延迟窗口内请求仍应成功");
  const afterReply = (await readLog()).filter(argv => argv[0] === "volume" && argv[1] === "rm");
  assert.equal(afterReply.length, 0, "请求在途（含挂载前窗口）期间不得回收其卷");
  const volume = `${host.volumeNamespace}-s-${workspaceA}-empty`;
  assert.ok(await waitFor(async () => {
    const volumes = (JSON.parse(await readFile(state, "utf8")) as { volumes: Record<string, unknown> }).volumes;
    return !Object.hasOwn(volumes, volume);
  }), "响应结束后闲置卷照常回收");
  assert.equal(host.debugState().reservedVolumes.length, 0, "响应结束后不应残留保护记录");
});

test("静默在途读取不触发空闲回收：全部请求结束后才重新计空闲", async t => {
  // R10 复现参数：读取 850ms 无 stdout 输出，空闲阈值 200ms——修复前计时器会关闭容器、
  // 请求收到“温热创作容器已关闭”。修复后入队即暂停回收，读回原内容，之后才真正闲置回收。
  const { host, readLog, cleanup } = await createHost({ warmIdleMs: 200, gcIntervalMs: 60_000 }, {
    prepare: async ({ workspaceRoot }) => ({
      shimDelay: { volume: `${await namespaceOf(workspaceRoot)}-p-${workspaceA}`, ms: 850 },
    }),
  });
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 300)); await cleanup(); });
  const delayed = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/read-fixture.txt" });
  const frame = JSON.parse(delayed.body) as { error?: string; data?: string };
  assert.ok(!frame.error, `延迟读取必须成功，而非 ${frame.error}`);
  assert.match(readData(delayed.body), /^from:frame-creative-[0-9a-f-]+:\/workspace\/read-fixture\.txt$/);
  const again = await call(host.socketPath, { workspaceId: workspaceA, action: "read", path: "/workspace/read-fixture.txt" });
  assert.match(readData(again.body), /^from:frame-creative-[0-9a-f-]+:\/workspace\/read-fixture\.txt$/, "后续读取照常复用同一容器");
  assert.equal((await readLog()).filter(isWarm).length, 1, "两次读取不新增容器");
  // 真正闲置满一个窗口后，容器照常回收。
  assert.ok(await waitFor(() => host.debugState().warmContainers.length === 0), "真正闲置后容器应回收");
  assert.ok(await waitFor(async () => (await readLog()).some(argv => argv[0] === "rm" && argv[1] === "--force")), "回收时强制移除容器");
});

test("skills 同步失败走 stdout 错误帧时不得标记跳过，重试会重新同步", async t => {
  const { host, readLog, cleanup } = await createHost({});
  t.after(cleanup);
  const files = [{ path: "native-fixture/fail-path.md", data: Buffer.from("内容\n").toString("base64") }];
  const { createHash } = await import("node:crypto");
  const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const first = await call(host.socketPath, { workspaceId: workspaceA, action: "skills", revision, files });
  assert.equal(JSON.parse(first.body).error, "[Errno 28] 模拟磁盘满");
  assert.equal(host.debugState().syncedSkills.length, 0, "失败帧不得进入跳过集");
  const second = await call(host.socketPath, { workspaceId: workspaceA, action: "skills", revision, files });
  assert.equal(JSON.parse(second.body).error, "[Errno 28] 模拟磁盘满");
  assert.equal((await readLog()).filter(isSync).length, 2, "未确认成功前每次都重新拉起同步容器");
});

test("真实 helper 循环协议：逐行请求、错误隔离、EOF 退出", async t => {
  const child = spawn("python3", ["-I", path.join(root, "docker/creative-operations.py")], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; });
  const closed = new Promise<number | null>(resolve => child.on("close", resolve));
  child.on("error", error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") t.skip("python3 不可用"); });
  child.stdin.write(`${JSON.stringify({ action: "nope", path: "/workspace/x" })}\n`);
  child.stdin.write("this-is-not-json\n");
  child.stdin.end();
  const code = await closed;
  const lines = output.trim().split("\n");
  assert.equal(code, 0);
  assert.equal(lines.length, 2, "两个请求各回复一行");
  assert.equal(JSON.parse(lines[0]!).error, "未支持的固定文件动作。");
  assert.match(JSON.parse(lines[1]!).error, /Expecting value/);
});
