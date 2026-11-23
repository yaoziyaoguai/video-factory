import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CREATIVE_IMAGE = "frame-creative:pi-1.5-v1";
export const CREATIVE_LIMITS = { memory: "1g", cpus: "2", pids: "128", tmpfs: "256m" };
const actions = {
  skills: ["revision", "files", "probe"], read: ["path", "skillsRevision"], write: ["path", "data", "skillsRevision"],
  access: ["path", "mode", "skillsRevision"], image_type: ["path", "skillsRevision"], mkdir: ["path", "skillsRevision"],
  image: [], list: ["skillsRevision"], execute: ["command", "argv", "timeout", "skillsRevision", "inputAliases"],
  dependencies: ["dependencies"], import_file: ["path", "ticket"], export_file: ["path", "ticket"], destroy: [],
};
const hashPattern = /^[a-f0-9]{64}$/;
// 嵌套重复组会在实际字体大小的有效输入上爆栈；长度与平铺字符规则共同保持原base64边界。
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
const validBase64 = value => typeof value === "string" && value.length % 4 === 0 && base64Pattern.test(value);
const relative = value => typeof value === "string" && value.length > 0 && value.length < 1000 && !value.includes("\\") && !value.includes("\0")
  && !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== "..");
// 温热容器默认 60 秒空闲销毁；命名卷默认 7 天未用回收；GC 每小时扫一次。
const WARM_IDLE_MS = 60_000;
const VOLUME_IDLE_MS = 7 * 24 * 60 * 60_000;
const GC_INTERVAL_MS = 60 * 60_000;

// 这两个固定程序只接触当前工程和本次挂载。数据从不经过宿主的 JSON/stdout。
const transferFile = `
import os, shutil, sys, tempfile
from pathlib import Path
root = Path("/workspace")
target = Path(sys.argv[2]).resolve()
if root not in target.parents:
    raise ValueError("工程文件路径超出工作区")
incoming = sys.argv[1] == "import_file"
source = Path("/transfer/payload") if incoming else target
if not source.is_file() or source.stat().st_size > 512 * 1024 * 1024:
    raise ValueError("工程文件不存在、不是普通文件或超过 512 MiB")
destination = target if incoming else Path("/transfer/payload")
destination.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as out:
    try:
        with source.open("rb") as src:
            shutil.copyfileobj(src, out, 256 * 1024)
        out.flush()
        os.fsync(out.fileno())
        os.replace(out.name, destination)
    finally:
        Path(out.name).unlink(missing_ok=True)
`;
const launchWithInputs = `
import json, os, sys
from pathlib import Path
root = Path("/workspace")
folder = root / "inputs"
folder.mkdir(exist_ok=True)
if folder.resolve() != folder:
    raise ValueError("输入目录必须位于工程内")
for alias in json.loads(sys.argv[1]):
    (folder / alias).symlink_to(Path("/inputs") / alias)
os.execvp(sys.argv[2], sys.argv[2:])
`;

/** 唯一宿主边界：固定镜像、固定身份映射和固定动作，不接收 raw Docker 配置。 */
export async function createCreativeRunnerHost({
  socketPath, workspaceRoot, dockerSocket = "/var/run/docker.sock", uid = process.getuid(), gid = process.getgid(),
  transferRoot, dataVolume, maxPoolSize = Number(process.env.FRAME_CREATIVE_MAX_POOL ?? 4), warmIdleMs = WARM_IDLE_MS, volumeIdleMs = VOLUME_IDLE_MS, gcIntervalMs = GC_INTERVAL_MS, nowMs = () => Date.now(),
}) {
  if (![socketPath, workspaceRoot, dockerSocket].every(value => typeof value === "string" && path.isAbsolute(value))) {
    throw new Error("socket、workspace 和 Docker socket 必须是明确的宿主绝对路径。");
  }
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("需要固定执行 UID/GID。");
  if (!Number.isSafeInteger(maxPoolSize) || maxPoolSize < 1) throw new Error("FRAME_CREATIVE_MAX_POOL 必须为正整数。");
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  workspaceRoot = await realpath(workspaceRoot);
  // 不假定 Mac 路径已共享到 Colima；工程和 Skill 副本留在 daemon 管理的固定命名卷。
  const volumeNamespace = `frame-creative-${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12)}`;
  if (transferRoot && (!path.isAbsolute(transferRoot) || transferRoot.includes(","))) throw new Error("传递目录必须是明确的本地绝对路径。");
  if (dataVolume && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(dataVolume)) throw new Error("数据卷名称无效。");
  const transferMount = (leaf, target, readOnly) => {
    const mode = readOnly ? ",readonly" : "";
    if (transferRoot) return `type=bind,src=${path.join(transferRoot, leaf)},dst=${target}${mode}`;
    if (dataVolume) return `type=volume,src=${dataVolume},volume-subpath=agent/creative-transfer/${leaf},dst=${target},volume-nocopy${mode}`;
    throw new Error("宿主尚未配置创作文件传递目录或数据卷。");
  };
  const runtimeDir = path.dirname(socketPath);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const dockerConfig = path.join(runtimeDir, "docker-client");
  await mkdir(dockerConfig, { recursive: true, mode: 0o700 });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", DOCKER_CONFIG: dockerConfig };
  const docker = args => spawn("docker", ["--host", `unix://${dockerSocket}`, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const collect = (args, input = "") => new Promise((resolve, reject) => {
    const child = docker(args); const stdout = []; const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Docker 退出 ${code}`)));
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(input);
  });
  // GC 需要时才删卷；失败（如占用中）按跳过处理，不中断扫尾。
  const quietly = promise => promise.catch(() => undefined);
  const imageId = (await collect(["image", "inspect", "--format", "{{.Id}}", CREATIVE_IMAGE])).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("固定创作镜像尚未构建。");
  const runArgs = (name, mounts, { initialize = false, media = false, interactive = true, reap = !initialize } = {}) => ["run", "--rm", ...(interactive ? ["--interactive"] : []), "--pull=never", ...(reap ? ["--init"] : []), "--name", name,
    "--network=none", "--read-only", "--cap-drop=ALL", ...(initialize ? ["--cap-add=CHOWN"] : []), "--security-opt=no-new-privileges:true",
    "--user", initialize ? "0:0" : `${uid}:${gid}`, "--memory", CREATIVE_LIMITS.memory, "--memory-swap", CREATIVE_LIMITS.memory,
    "--cpus", CREATIVE_LIMITS.cpus, "--pids-limit", CREATIVE_LIMITS.pids, "--ulimit", media ? "fsize=536870912:536870912" : "fsize=134217728:134217728",
    "--tmpfs", `/tmp:rw,nosuid,nodev,size=${CREATIVE_LIMITS.tmpfs},mode=1777`, ...mounts.flatMap(mount => ["--mount", mount]),
    "--workdir", "/workspace", "--entrypoint", "/usr/bin/env", imageId, "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"];
  const initialized = new Set();
  // helper 按请求隔离失败：错误帧写 stdout、退出码仍为 0，必须解析最后一条回执帧确认。
  const lastReplyFrame = output => {
    const lines = output.split("\n").map(line => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]); } catch { /* 跳过无法解析的行。 */ }
    }
    return null;
  };
  const initializedVolumeExists = async volume => {
    if (!initialized.has(volume)) return false;
    // Docker 禁止移除仍被挂载的卷。冷卷重用前读取 daemon 的事实，避免误用旧的初始化记录。
    if (pool.some(entry => !entry.closed && entry.volumes.includes(volume))) return true;
    const names = await collect(["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${volume}`]);
    if (names.trim().split("\n").includes(volume)) return true;
    initialized.delete(volume);
    syncedSkills.delete(volume);
    return false;
  };
  const initializeVolume = async (volume, target, execution = false) => {
    if (await initializedVolumeExists(volume)) return;
    if (execution) await collect(["volume", "create", "--label", "frame.scope=execution", "--label", `frame.namespace=${volumeNamespace}`, volume]);
    // 固定可信 helper 只交还卷根目录的所有权，不执行用户文件，也不递归读取工程。
    const output = await collect([...runArgs(`frame-creative-init-${randomUUID()}`, [`type=volume,src=${volume},dst=${target},volume-nocopy`], { initialize: true, interactive: false }),
      "/usr/bin/python3", "-I", "-c", 'import io,runpy,sys; sys.stdin=io.StringIO(sys.argv[1]); runpy.run_path("/opt/frame/creative-operations.py")', JSON.stringify({ action: "initialize", root: target, uid, gid })]);
    const frame = lastReplyFrame(output);
    if (!frame || frame.error !== undefined) throw new Error(frame?.error ?? "卷初始化未返回确认。");
    initialized.add(volume);
  };

  // —— 卷生命周期：宿主是唯一回收方 ——
  // lastUsed 跨进程持久化（runtimeDir 与部署同生命周期），重启后仍能区分近期用过的卷；
  // syncedSkills 记录已确认写入内容的 Skill 卷（命名卷内容持久，跳过重复同步容器）。
  // 在途请求的卷保护：从解析出工作区起保留到响应结束，覆盖容器挂载前的窗口；
  // 一次性容器运行中 Docker 本身拒删其挂载卷，温热池另有 pool 挂载检查。
  const volumeReservations = new Map();
  const reserveVolumes = names => {
    for (const name of names) volumeReservations.set(name, (volumeReservations.get(name) ?? 0) + 1);
    return () => {
      for (const name of names) {
        const remaining = (volumeReservations.get(name) ?? 1) - 1;
        if (remaining > 0) volumeReservations.set(name, remaining); else volumeReservations.delete(name);
      }
    };
  };
  const usageFile = path.join(runtimeDir, "creative-volume-usage.json");
  const lastUsed = new Map();
  try { for (const [name, at] of Object.entries(JSON.parse(await readFile(usageFile, "utf8")))) if (typeof at === "number") lastUsed.set(name, at); } catch { /* 无历史记录时全部待领养；绝不按创建年龄猜删。 */ }
  const syncedSkills = new Set();
  const persistUsage = async () => {
    // 原子替换：进程中断留下的半截文件不应让全部使用记录失效（那会让存量卷被误当无记录处理）。
    // 暂存名带随机后缀：每次写入独占一个暂存文件，改名时不会带走另一笔写入尚未写完的内容。
    const staged = `${usageFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, JSON.stringify(Object.fromEntries(lastUsed)), { mode: 0o600 });
      await rename(staged, usageFile);
    } catch { /* 记录失败只影响下次回收时点的精度。 */ }
  };
  const touchVolumes = names => { const at = nowMs(); for (const name of names) lastUsed.set(name, at); };
  const destroyExecutions = async workspaceId => {
    const prefix = volumeNamespace + "-x-";
    const list = await collect(["volume", "ls", "--format", "{{.Name}}", "--filter", "label=frame.scope=execution", "--filter", `label=frame.namespace=${volumeNamespace}`]);
    for (const name of list.split("\n")) {
      if (!name.startsWith(prefix) || !hashPattern.test(name.slice(prefix.length)) || (workspaceId && name !== prefix + workspaceId)) continue;
      const ids = (await collect(["ps", "-aq", "--filter", `volume=${name}`])).trim().split(/\s+/).filter(Boolean);
      for (const id of ids) await quietly(collect(["rm", "--force", id]));
      // Docker 仍有挂载者会拒删，错误必须返回给调用方。
      await collect(["volume", "rm", name]);
      initialized.delete(name);
      lastUsed.delete(name);
    }
  };
  // 宿主独占自己的 socket 与命名空间。先处理上次异常退出的执行卷，再接受新任务。
  await destroyExecutions();
  const sweepVolumes = async () => {
    const prefix = `${volumeNamespace}-`;
    const names = (await collect(["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${prefix}`])).split("\n").map(name => name.trim()).filter(name => name.startsWith(prefix));
    const at = nowMs();
    for (const name of names) {
      // TTL 回收只针对 `-s-` Skill 卷（可从修订重建）。`-p-` 工程卷承载可继续编辑的文件，
      // 闲置时长不构成删除依据——旧实现连它一起按七天回收，超龄工程直接丢失。
      if (!name.slice(prefix.length).startsWith("s-")) continue;
      if (pool.some(entry => entry.volumes.includes(name))) continue; // 温热容器正挂着
      if (volumeReservations.has(name)) continue; // 在途请求：从受理到响应结束都受保护
      const used = lastUsed.get(name);
      if (used === undefined) {
        // 本进程从未见过（升级首启或使用记录损坏）：创建年龄不等于最后使用时间，
        // 按年龄删会丢掉近期真实用过的卷；先领养为当前时间，闲置满一个完整窗口后才回收。
        lastUsed.set(name, at);
        continue;
      }
      if (at - used < volumeIdleMs) continue;
      const removed = await quietly(collect(["volume", "rm", name]));
      if (removed !== undefined) {
        lastUsed.delete(name); syncedSkills.delete(name); initialized.delete(name);
      }
    }
    await persistUsage();
  };
  // 单飞：清扫要拉起 docker 子进程，上一轮未返回前定时器不再叠加新一轮。否则在途引用被逐轮覆盖，
  // close() 只等得到最后一轮，其余轮次在宿主关闭后继续写使用记录。
  let closing = false;
  let sweeping = null;
  const runSweep = () => {
    if (sweeping || closing) return;
    sweeping = sweepVolumes().catch(() => undefined).finally(() => { sweeping = null; });
  };
  const gcTimer = setInterval(runSweep, gcIntervalMs);
  gcTimer.unref();

  // —— 温热容器池：文件动作复用同一长驻进程（每行一个请求），60 秒空闲销毁 ——
  const pool = [];
  const creating = new Set();
  const waiting = [];
  const startWarm = (projectVolume, skillsVolume) => {
    const name = `frame-creative-${randomUUID()}`;
    // 与一次性容器完全相同的加固参数；stdin 保持打开，容器进程按行循环服务。
    const args = runArgs(name, [`type=volume,src=${projectVolume},dst=/workspace,volume-nocopy`,
      `type=volume,src=${skillsVolume},dst=/skills,volume-nocopy,readonly`]);
    args.push("/usr/bin/python3", "-I", "/opt/frame/creative-operations.py");
    const child = docker(args);
    const entry = { name, child, projectVolume, skillsVolume, volumes: [projectVolume, skillsVolume],
      chain: Promise.resolve(), idleTimer: null, closed: false, buffer: "", waker: null, pending: null, inFlight: 0 };
    pool.push(entry);
    entry.used = nowMs();
    const exited = new Promise(resolve => child.once("close", resolve));
    entry.shutdown = () => {
      if (entry.closed) return entry.removed;
      entry.closed = true;
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      const pending = entry.pending; entry.pending = null;
      if (pending) pending.reject(new Error("温热创作容器已关闭。"));
      // 先 EOF 让 helper 循环自然退出，再强制兜底清理容器。
      try { entry.child.stdin.end(); } catch { /* 进程已退出时无需处理。 */ }
      entry.removed = Promise.all([exited, quietly(collect(["rm", "--force", name]))]).then(() => {
        pool.splice(pool.indexOf(entry), 1);
        scheduleWarm();
      });
      return entry.removed;
    };
    entry.resetIdle = () => {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => entry.shutdown(), warmIdleMs);
      entry.idleTimer.unref();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      entry.buffer += chunk;
      if (entry.waker) entry.waker();
    });
    child.stderr.on("data", () => { /* 请求级错误经由 stdout 的 error 帧返回；stderr 仅供诊断。 */ });
    child.on("close", () => entry.shutdown());
    // 容器进程崩溃或 docker 启动失败：唤醒挂起请求并让下一个请求走新容器。
    child.on("error", error => {
      process.stderr.write(`creative warm container: ${error.message}\n`);
      entry.shutdown();
    });
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") process.stderr.write(`creative warm stdin: ${error.message}\n`);
      entry.shutdown();
    });
    entry.resetIdle();
    touchVolumes(entry.volumes);
    return entry;
  };
  const callWarm = (entry, input) => {
    // R10：请求入队即暂停空闲回收——静默传输（如慢卷挂载、大文件读取）期间没有 stdout
    // 续期信号；只有全部已受理请求完成或失败后才重新起算空闲计时。
    entry.used = nowMs();
    touchVolumes(entry.volumes);
    entry.inFlight += 1;
    if (entry.idleTimer !== null) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    const run = entry.chain.then(() => new Promise((resolve, reject) => {
      if (entry.closed) { reject(new Error("温热创作容器已关闭。")); return; }
      const waitFor = () => {
        const newline = entry.buffer.indexOf("\n");
        if (newline === -1) { entry.waker = waitFor; return; }
        const line = entry.buffer.slice(0, newline); entry.buffer = entry.buffer.slice(newline + 1);
        entry.waker = null; entry.pending = null;
        try { resolve(JSON.parse(line)); } catch { reject(new Error("创作容器返回了无效结果。")); }
      };
      entry.pending = { resolve, reject };
      entry.waker = waitFor;
      try { entry.child.stdin.write(JSON.stringify(input) + "\n"); } catch (error) { entry.shutdown(); reject(error instanceof Error ? error : new Error(String(error))); }
      waitFor(); // 唤醒注册前已完整到达的行（如上一请求失败遗留）。
    }));
    const task = run.finally(() => {
      entry.inFlight -= 1;
      if (entry.inFlight === 0 && !entry.closed) { entry.used = nowMs(); entry.resetIdle(); scheduleWarm(); }
    });
    entry.chain = task.catch(() => {});
    return task;
  };

  function scheduleWarm() {
    while (!closing && waiting.length) {
      const next = waiting[0];
      const { projectVolume, skillsVolume } = next;
      if (next.response.destroyed) { waiting.shift(); next.reject(new Error("创作请求已断开。")); continue; }
      const existing = pool.find(entry => !entry.closed && entry.projectVolume === projectVolume && entry.skillsVolume === skillsVolume);
      if (existing) { waiting.shift(); callWarm(existing, next.input).then(next.resolve, next.reject); continue; }
      const key = projectVolume + ":" + skillsVolume;
      if (creating.has(key)) return;
      if (pool.length + creating.size >= maxPoolSize) {
        if (!pool.some(entry => entry.closed)) {
          const idle = pool.filter(entry => entry.inFlight === 0).sort((a, b) => a.used - b.used)[0];
          if (idle) idle.shutdown();
        }
        return;
      }
      waiting.shift();
      creating.add(key);
      void (async () => {
        try {
          await initializeVolume(projectVolume, "/workspace");
          await initializeVolume(skillsVolume, "/skills");
          if (closing || next.response.destroyed) throw new Error("创作请求已关闭。");
          const entry = startWarm(projectVolume, skillsVolume);
          callWarm(entry, next.input).then(next.resolve, next.reject);
        } catch (error) { next.reject(error); }
        finally { creating.delete(key); scheduleWarm(); }
      })();
    }
  }
  const queueWarm = (projectVolume, skillsVolume, input, response) => new Promise((resolve, reject) => {
    if (closing || waiting.length >= maxPoolSize * 8) { reject(new Error("创作工作区繁忙，请稍后重试。")); return; }
    waiting.push({ projectVolume, skillsVolume, input, response, resolve, reject });
    scheduleWarm();
  });

  const active = new Set();
  const server = http.createServer(async (request, response) => {
    const reply = value => { if (!response.destroyed) response.end(JSON.stringify(value) + "\n"); };
    try {
      if (request.method !== "POST" || request.url !== "/") throw new Error("仅接受固定创作动作。");
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length; if (size > 128 * 1024 * 1024) throw new Error("创作输入超过 128 MiB。");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || typeof input !== "object" || typeof input.workspaceId !== "string" || !hashPattern.test(input.workspaceId) || !Object.hasOwn(actions, input.action)) throw new Error("创作动作或工作区身份无效。");
      const allowed = new Set(["workspaceId", "scope", "action", ...actions[input.action]]);
      const execution = input.scope === "execution";
      if ((input.scope !== undefined && !execution) || (execution && !["image", "destroy", "execute", "import_file", "export_file"].includes(input.action))
        || (input.action === "destroy" && !execution)) throw new Error("工作区生命周期与动作不符。");
      if (input.inputAliases !== undefined && (!execution || !input.argv || !Array.isArray(input.inputAliases)
        || !input.inputAliases.every(alias => typeof alias === "string" && /^\d+\.(?:png|jpe?g|webp|mp4|webm|mp3|wav)$/.test(alias)))) throw new Error("执行输入别名无效。");
      if (["import_file", "export_file"].includes(input.action) && (typeof input.path !== "string" || !input.path.startsWith("/workspace/")
        || !relative(input.path.slice(11)) || typeof input.ticket !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.ticket))) throw new Error("工程传递文件或票号无效。");
      if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("创作入口不接受镜像、宿主路径、挂载或额外配置。");
      if (input.skillsRevision !== undefined && (typeof input.skillsRevision !== "string" || !hashPattern.test(input.skillsRevision))) throw new Error("Skill 副本身份无效。");
      if (input.action === "execute" && !((input.command === undefined) !== (input.argv === undefined))) throw new Error("execute 需要 command 或 argv 之一。");
      if (input.action === "execute" && input.command !== undefined && (typeof input.command !== "string" || !input.command || input.command.length > 1024 * 1024)) throw new Error("执行命令无效。");
      if (input.action === "execute" && input.argv !== undefined && (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 64
        || input.argv.some(token => typeof token !== "string" || !token || token.length > 1024 || token.includes("\0")))) throw new Error("执行 argv 无效。");
      if (input.action === "execute" && input.timeout !== undefined && (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0)) throw new Error("显式超时无效。");
      if (["read", "write", "access", "image_type", "mkdir"].includes(input.action) && (typeof input.path !== "string" || input.path.includes("\0")
        || !(input.path === "/workspace" || input.path.startsWith("/workspace/") || input.path.startsWith("/skills/")))) throw new Error("文件路径必须位于容器工程区或只读 Skill 区。");
      if (input.action === "access" && !["read", "write"].includes(input.mode)) throw new Error("访问模式无效。");
      if (input.action === "write" && !validBase64(input.data)) throw new Error("文件内容必须为 base64。");
      if (input.action === "skills") {
        if (input.probe !== true) {
          if (typeof input.revision !== "string" || !hashPattern.test(input.revision) || !Array.isArray(input.files)
            || createHash("sha256").update(JSON.stringify(input.files)).digest("hex") !== input.revision) throw new Error("Skill 副本摘要不匹配。");
          const seen = new Set();
          for (const file of input.files) {
            if (!file || Object.keys(file).some(key => !["path", "data"].includes(key)) || !relative(file.path) || seen.has(file.path)
              || !validBase64(file.data)) throw new Error("Skill 副本路径或内容无效。");
            seen.add(file.path);
          }
        } else if (typeof input.revision !== "string" || !hashPattern.test(input.revision) || typeof input.probe !== "boolean") {
          throw new Error("Skill 副本探测身份无效。");
        }
      }
      response.setHeader("content-type", "application/x-ndjson");
      if (input.action === "image") { reply({ imageId }); return; }
      if (input.action === "dependencies") {
        const names = input.dependencies;
        if (!Array.isArray(names) || names.length > 6400 || !names.every(name => typeof name === "string" && /^(?:bin:[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}|python:[A-Za-z_][A-Za-z0-9_]{0,99})$/.test(name))) throw new Error("运行依赖声明无效。");
        const probe = 'import importlib.util,json,shutil,sys; deps=json.load(sys.stdin); print(json.dumps([d for d in deps if not (shutil.which(d[4:]) if d.startswith("bin:") else importlib.util.find_spec(d[7:]))]))';
        const args = runArgs(`frame-creative-deps-${randomUUID()}`, [], { reap: false });
        const output = await collect([...args, "/usr/bin/python3", "-I", "-c", probe], JSON.stringify(names));
        reply({ missing: JSON.parse(output) }); return;
      }
      if (input.action === "destroy") { await destroyExecutions(input.workspaceId); reply({}); return; }
      const projectVolume = `${volumeNamespace}-${execution ? "x" : "p"}-${input.workspaceId}`;
      const skillsVolume = `${volumeNamespace}-s-${input.workspaceId}-${input.action === "skills" ? input.revision : input.skillsRevision ?? "empty"}`;
      // R11 探测：只带工作区身份与修订，宿主按现有卷身份和成功集合答复是否需要正文；
      // 不生成正文、不挂卷、不起容器。缓存归属与失效始终以宿主状态为准。
      if (input.action === "skills" && input.probe === true) { reply({ needed: !(syncedSkills.has(skillsVolume) && await initializedVolumeExists(skillsVolume)) }); return; }
      // 从这里起两个卷都可能被本请求挂载：到响应结束（含早退路径）都禁止 GC 回收。
      response.on("close", reserveVolumes([projectVolume, skillsVolume]));
      // 同一摘要的 Skill 副本持久在命名卷里：已确认同步过就不再拉容器重传整份内容。
      if (input.action === "skills" && syncedSkills.has(skillsVolume) && await initializedVolumeExists(skillsVolume)) { reply({}); return; }
      if (["read", "write", "access", "image_type", "mkdir", "list"].includes(input.action)) {
        reply(await queueWarm(projectVolume, skillsVolume, input, response)); return;
      }
      await initializeVolume(projectVolume, "/workspace", execution);
      if (!execution) await initializeVolume(skillsVolume, "/skills");
      if (response.destroyed) return;
      if (input.action === "import_file" || input.action === "export_file") {
        const mount = transferMount(input.workspaceId + "-" + input.ticket, "/transfer", input.action === "import_file");
        await collect([...runArgs(`frame-creative-file-${randomUUID()}`, [`type=volume,src=${projectVolume},dst=/workspace,volume-nocopy`, mount], { media: true, interactive: false }),
          "/usr/bin/python3", "-I", "-c", transferFile, input.action, input.path]);
        reply({}); return;
      }
      if (input.action === "skills") {
        // 同步容器需要 Skill 卷可写，一次性运行；成功后本摘要不再同步。
        const name = `frame-creative-${randomUUID()}`;
        const args = runArgs(name, [`type=volume,src=${projectVolume},dst=/workspace,volume-nocopy`,
          `type=volume,src=${skillsVolume},dst=/skills,volume-nocopy`]);
        args.push("/usr/bin/python3", "-I", "/opt/frame/creative-operations.py");
        const child = docker(args);
        const errors = [];
        let output = "";
        const stopSync = () => { if (!child.killed) child.kill(); };
        active.add(stopSync);
        response.on("close", () => { if (!response.writableEnded) stopSync(); });
        child.stderr.on("data", data => errors.push(data));
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => { output += chunk; });
        child.stdin.on("error", error => { if (error.code !== "EPIPE") child.emit("error", error); });
        child.stdin.end(JSON.stringify(input));
        child.on("error", error => { active.delete(stopSync); reply({ error: error.message }); });
        child.on("close", code => {
          active.delete(stopSync);
          touchVolumes([projectVolume, skillsVolume]);
          if (code === 0) {
            // helper 按请求隔离失败且退出码为 0：必须看到成功帧才算同步完成，
            // 否则把失败卷记入 syncedSkills 会让该摘要永久跳过重传。
            const frame = lastReplyFrame(output);
            if (frame && frame.error === undefined) { syncedSkills.add(skillsVolume); reply({}); return; }
            reply({ error: frame?.error ?? "Skill 同步容器未返回确认。" });
            return;
          }
          reply({ error: Buffer.concat(errors).toString("utf8").trim() || `创作容器退出 ${code}` });
        });
        return;
      }
      if (input.action === "execute") {
        const name = `frame-creative-${randomUUID()}`;
        // 禁止空卷 copy-up 覆盖初始化后的 UID/GID。
        const mounts = [`type=volume,src=${projectVolume},dst=/workspace,volume-nocopy`];
        if (!execution) mounts.push(`type=volume,src=${skillsVolume},dst=/skills,volume-nocopy,readonly`);
        if (input.inputAliases?.length) mounts.push(transferMount(input.workspaceId + "-inputs", "/inputs", true));
        const args = runArgs(name, mounts, { media: execution, interactive: false });
        if (input.inputAliases?.length) args.push("/usr/bin/python3", "-I", "-c", launchWithInputs, JSON.stringify(input.inputAliases));
        args.push(...(input.argv ?? ["/bin/bash", "--noprofile", "--norc", "-c", input.command]));
        const child = docker(args);
        let cancelled = false; let timeout;
        const stop = () => {
          if (cancelled) return; cancelled = true;
          const cleanup = docker(["rm", "--force", name]);
          cleanup.on("error", error => process.stderr.write(`creative cleanup: ${error.message}\n`));
          cleanup.stderr.resume(); cleanup.stdout.resume(); cleanup.stdin.end();
        };
        active.add(stop);
        response.on("close", () => { if (!response.writableEnded) stop(); });
        if (input.timeout !== undefined) timeout = setTimeout(stop, input.timeout * 1000);
        child.stdout.on("data", data => { if (!response.destroyed) response.write(JSON.stringify({ output: data.toString("base64") }) + "\n"); });
        child.stderr.on("data", data => { if (!response.destroyed) response.write(JSON.stringify({ output: data.toString("base64") }) + "\n"); });
        child.stdin.on("error", error => { if (error.code !== "EPIPE") child.emit("error", error); });
        child.stdin.end("");
        child.on("error", error => { clearTimeout(timeout); active.delete(stop); reply({ error: error.message }); });
        child.on("close", code => {
          clearTimeout(timeout); active.delete(stop);
          touchVolumes([projectVolume, skillsVolume]);
          if (cancelled) { reply({ error: input.timeout === undefined ? "aborted" : `timeout:${input.timeout}` }); return; }
          reply({ exitCode: code });
        });
        return;
      }
    } catch (error) {
      if (!response.headersSent) response.statusCode = 400;
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return {
    imageId, socketPath, workspaceRoot, volumeNamespace, uid, gid, limits: CREATIVE_LIMITS,
    /** 池与卷状态的只读快照：测试与运维诊断用，不构成新的控制面。 */
    debugState() {
      return { warmContainers: pool.map(entry => ({ name: entry.name, projectVolume: entry.projectVolume, skillsVolume: entry.skillsVolume })),
        syncedSkills: [...syncedSkills], trackedVolumes: [...lastUsed.keys()], reservedVolumes: [...volumeReservations.keys()] };
    },
    async close() {
      clearInterval(gcTimer);
      await (sweeping ?? null); // 等在途扫尾收束，避免关闭后仍有 docker 调用漂出。
      for (const stop of active) stop();
      closing = true;
      for (const next of waiting.splice(0)) next.reject(new Error("创作宿主已关闭。"));
      await Promise.all(pool.map(entry => entry.shutdown()));
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await persistUsage();
      await rm(socketPath, { force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const index = arg.indexOf("="); if (!arg.startsWith("--") || index < 3) throw new Error("参数格式为 --name=value。");
    return [arg.slice(2, index), arg.slice(index + 1)];
  }));
  if (Object.keys(args).some(key => !["socket", "workspace-root", "docker-socket", "data-volume", "transfer-root", "uid", "gid"].includes(key))) throw new Error("宿主入口参数无效。");
  const host = await createCreativeRunnerHost({ socketPath: args.socket, workspaceRoot: args["workspace-root"], dockerSocket: args["docker-socket"], dataVolume: args["data-volume"], transferRoot: args["transfer-root"],
    ...(args.uid === undefined ? {} : { uid: Number(args.uid) }), ...(args.gid === undefined ? {} : { gid: Number(args.gid) }) });
  process.stdout.write(JSON.stringify({ ready: true, ...host }) + "\n");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await host.close(); process.exit(0); });
}
