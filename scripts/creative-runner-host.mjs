import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CREATIVE_IMAGE = "frame-creative:pi-1.4-v1";
export const CREATIVE_LIMITS = { memory: "1g", cpus: "2", pids: "128", tmpfs: "256m" };
const actions = {
  skills: ["revision", "files"], read: ["path", "skillsRevision"], write: ["path", "data", "skillsRevision"],
  access: ["path", "mode", "skillsRevision"], image_type: ["path", "skillsRevision"], mkdir: ["path", "skillsRevision"],
  image: [], list: ["skillsRevision"], execute: ["command", "argv", "timeout", "skillsRevision"],
};
const hashPattern = /^[a-f0-9]{64}$/;
// 嵌套重复组会在实际字体大小的有效输入上爆栈；长度与平铺字符规则共同保持原base64边界。
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
const validBase64 = value => typeof value === "string" && value.length % 4 === 0 && base64Pattern.test(value);
const relative = value => typeof value === "string" && value.length > 0 && value.length < 1000 && !value.includes("\\") && !value.includes("\0")
  && !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== "..");

/** 唯一宿主边界：固定镜像、固定身份映射和固定动作，不接收 raw Docker 配置。 */
export async function createCreativeRunnerHost({ socketPath, workspaceRoot, dockerSocket = "/var/run/docker.sock", uid = process.getuid(), gid = process.getgid() }) {
  if (![socketPath, workspaceRoot, dockerSocket].every(value => typeof value === "string" && path.isAbsolute(value))) {
    throw new Error("socket、workspace 和 Docker socket 必须是明确的宿主绝对路径。");
  }
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("需要固定执行 UID/GID。");
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  workspaceRoot = await realpath(workspaceRoot);
  // 不假定 Mac 路径已共享到 Colima；工程和 Skill 副本留在 daemon 管理的固定命名卷。
  const volumeNamespace = `frame-creative-${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12)}`;
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
  const imageId = (await collect(["image", "inspect", "--format", "{{.Id}}", CREATIVE_IMAGE])).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("固定创作镜像尚未构建。");
  const runArgs = (name, mounts, initialize = false) => ["run", "--rm", "--interactive", "--pull=never", "--init", "--name", name,
    "--network=none", "--read-only", "--cap-drop=ALL", ...(initialize ? ["--cap-add=CHOWN"] : []), "--security-opt=no-new-privileges:true",
    "--user", initialize ? "0:0" : `${uid}:${gid}`, "--memory", CREATIVE_LIMITS.memory, "--memory-swap", CREATIVE_LIMITS.memory,
    "--cpus", CREATIVE_LIMITS.cpus, "--pids-limit", CREATIVE_LIMITS.pids, "--ulimit", "fsize=134217728:134217728",
    "--tmpfs", `/tmp:rw,nosuid,nodev,size=${CREATIVE_LIMITS.tmpfs},mode=1777`, ...mounts.flatMap(mount => ["--mount", mount]),
    "--workdir", "/workspace", "--entrypoint", "/usr/bin/env", imageId, "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"];
  const initialized = new Set();
  const initializeVolume = async (volume, target) => {
    if (initialized.has(volume)) return;
    // 固定可信 helper 只交还卷根目录的所有权，不执行用户文件，也不递归读取工程。
    await collect([...runArgs(`frame-creative-init-${randomUUID()}`, [`type=volume,src=${volume},dst=${target},volume-nocopy`], true),
      "/usr/bin/python3", "-I", "/opt/frame/creative-operations.py"], JSON.stringify({ action: "initialize", root: target, uid, gid }));
    initialized.add(volume);
  };
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
      const allowed = new Set(["workspaceId", "action", ...actions[input.action]]);
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
        if (typeof input.revision !== "string" || !hashPattern.test(input.revision) || !Array.isArray(input.files)
          || createHash("sha256").update(JSON.stringify(input.files)).digest("hex") !== input.revision) throw new Error("Skill 副本摘要不匹配。");
        const seen = new Set();
        for (const file of input.files) {
          if (!file || Object.keys(file).some(key => !["path", "data"].includes(key)) || !relative(file.path) || seen.has(file.path)
            || !validBase64(file.data)) throw new Error("Skill 副本路径或内容无效。");
          seen.add(file.path);
        }
      }
      response.setHeader("content-type", "application/x-ndjson");
      if (input.action === "image") { reply({ imageId }); return; }
      const projectVolume = `${volumeNamespace}-p-${input.workspaceId}`;
      const skillsVolume = `${volumeNamespace}-s-${input.workspaceId}-${input.action === "skills" ? input.revision : input.skillsRevision ?? "empty"}`;
      await initializeVolume(projectVolume, "/workspace");
      await initializeVolume(skillsVolume, "/skills");
      if (response.destroyed) return;
      const name = `frame-creative-${randomUUID()}`;
      // 禁止空卷 copy-up 覆盖初始化后的 UID/GID。
      const args = runArgs(name, [`type=volume,src=${projectVolume},dst=/workspace,volume-nocopy`,
        `type=volume,src=${skillsVolume},dst=/skills,volume-nocopy${input.action === "skills" ? "" : ",readonly"}`]);
      // bash -c 只服务原生调试命令；冻结工程走 argv 逐项直传，不经 shell 重新解释。
      if (input.action === "execute") args.push(...(input.argv ?? ["/bin/bash", "--noprofile", "--norc", "-c", input.command]));
      else args.push("/usr/bin/python3", "-I", "/opt/frame/creative-operations.py");
      const child = docker(args);
      const output = []; const errors = []; let cancelled = false; let timeout;
      const stop = () => {
        if (cancelled) return; cancelled = true;
        const cleanup = docker(["rm", "--force", name]);
        cleanup.on("error", error => process.stderr.write(`creative cleanup: ${error.message}\n`));
        cleanup.stderr.resume(); cleanup.stdout.resume(); cleanup.stdin.end();
      };
      active.add(stop);
      response.on("close", () => { if (!response.writableEnded) stop(); });
      if (input.timeout !== undefined) timeout = setTimeout(stop, input.timeout * 1000);
      child.stdout.on("data", data => {
        if (input.action === "execute") { if (!response.destroyed) response.write(JSON.stringify({ output: data.toString("base64") }) + "\n"); }
        else output.push(data);
      });
      child.stderr.on("data", data => {
        if (input.action === "execute") { if (!response.destroyed) response.write(JSON.stringify({ output: data.toString("base64") }) + "\n"); }
        else errors.push(data);
      });
      child.stdin.on("error", error => { if (error.code !== "EPIPE") child.emit("error", error); });
      child.stdin.end(input.action === "execute" ? "" : JSON.stringify(input));
      child.on("error", error => { clearTimeout(timeout); active.delete(stop); reply({ error: error.message }); });
      child.on("close", code => {
        clearTimeout(timeout); active.delete(stop);
        if (cancelled) { reply({ error: input.timeout === undefined ? "aborted" : `timeout:${input.timeout}` }); return; }
        if (input.action === "execute") { reply({ exitCode: code }); return; }
        if (code !== 0) { reply({ error: Buffer.concat(errors).toString("utf8").trim() || `创作容器退出 ${code}` }); return; }
        try { reply(JSON.parse(Buffer.concat(output).toString("utf8"))); }
        catch { reply({ error: "创作容器返回了无效结果。" }); }
      });
    } catch (error) {
      if (!response.headersSent) response.statusCode = 400;
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  return {
    imageId, socketPath, workspaceRoot, volumeNamespace, uid, gid, limits: CREATIVE_LIMITS,
    async close() {
      for (const stop of active) stop();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const index = arg.indexOf("="); if (!arg.startsWith("--") || index < 3) throw new Error("参数格式为 --name=value。");
    return [arg.slice(2, index), arg.slice(index + 1)];
  }));
  if (Object.keys(args).some(key => !["socket", "workspace-root", "docker-socket", "uid", "gid"].includes(key))) throw new Error("宿主入口参数无效。");
  const host = await createCreativeRunnerHost({ socketPath: args.socket, workspaceRoot: args["workspace-root"], dockerSocket: args["docker-socket"],
    ...(args.uid === undefined ? {} : { uid: Number(args.uid) }), ...(args.gid === undefined ? {} : { gid: Number(args.gid) }) });
  process.stdout.write(JSON.stringify({ ready: true, ...host }) + "\n");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await host.close(); process.exit(0); });
}
