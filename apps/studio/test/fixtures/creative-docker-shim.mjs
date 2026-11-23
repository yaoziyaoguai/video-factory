// 假 Docker CLI：让 creative-runner-host 的池化/GC/跳过逻辑无需真实 daemon 即可密封测试。
// 通过 PATH 注入；状态（卷）与调用日志落在测试临时目录。宿主侧 spawn 的 env 只带 PATH
// 与 DOCKER_CONFIG，因此配置必须烘焙进每个测试生成的 docker 包装脚本里。
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";

const dockerTime = at => {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000000 +00:00 UTC`;
};

export async function main({ state, log, delay, holdMs }) {
  const argv = process.argv.slice(2);
  const args = argv[0] === "--host" ? argv.slice(2) : argv;
  const record = () => appendFile(log, `${JSON.stringify({ argv: args })}\n`);
  const loadState = async () => {
    try { return JSON.parse(await readFile(state, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { volumes: {} }; throw error; }
  };
  const saveState = async current => {
    // 宿主和测试在独立进程读状态。原子替换让读者只看见完整的一版 JSON。
    const temporary = `${state}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(current));
    await rename(temporary, state);
  };
  const subcommand = args[0];
  if (subcommand === "image" && args[1] === "inspect") {
    await record();
    process.stdout.write(`sha256:${"a".repeat(64)}\n`);
    return;
  }
  if (subcommand === "volume" && args[1] === "ls") {
    await record();
    // 可选拖住宿主启动后的第一轮 GC 卷枚举（按命名空间前缀过滤，过滤值以 “-” 结尾；其余枚举不算）：
    // 模拟高负载下 docker 迟迟不返回，供 GC 单飞回归测试制造与 close() 重叠的清扫。
    if (holdMs && (await readFile(log, "utf8")).split("\n").filter(line => /"name=[^"]+-"/.test(line)).length === 1)
      await new Promise(resolve => setTimeout(resolve, holdMs));
    const filter = args[args.indexOf("--filter") + 1] ?? "";
    const prefix = filter.replace(/^name=/, "");
    const current = await loadState();
    process.stdout.write(Object.keys(current.volumes).filter(name => name.startsWith(prefix)).sort().join("\n") + "\n");
    return;
  }
  if (subcommand === "volume" && args[1] === "inspect") {
    await record();
    const current = await loadState();
    const volume = current.volumes[args.at(-1)];
    process.stdout.write(dockerTime(volume?.createdAt ?? Date.now()) + "\n");
    return;
  }
  if (subcommand === "volume" && args[1] === "rm") {
    await record();
    const current = await loadState();
    delete current.volumes[args.at(-1)];
    await saveState(current);
    return;
  }
  if (subcommand === "rm") {
    await record();
    return;
  }
  if (subcommand === "run") {
    await record();
    // 可选延迟：模拟 run 已受理但容器尚未挂载/创建卷的窗口，供 GC 竞态回归测试使用。
    if (delay && args.some((arg, index) => arg === "--mount" && args[index + 1]?.includes(`src=${delay.volume},`))) {
      await new Promise(resolve => setTimeout(resolve, delay.ms));
    }
    // 与真实 Docker 一致：run 时隐式创建挂载的命名卷。
    const current = await loadState();
    for (let index = args.indexOf("--mount"); index !== -1; index = args.indexOf("--mount", index + 1)) {
      const source = /(?:^|,)src=([^,]+)/.exec(args[index + 1] ?? "")?.[1];
      if (source) current.volumes[source] ??= { createdAt: Date.now() };
    }
    await saveState(current);
    const name = args[args.indexOf("--name") + 1];
    if (name.startsWith("frame-creative-init-")) {
      const initialization = JSON.parse(args.at(-1));
      if (initialization.action !== "initialize" || args.includes("--interactive")) throw new Error("卷初始化应是一次性动作");
      process.stdout.write("{}\n");
      return;
    }
    if (args.at(-1) === "/opt/frame/creative-operations.py") {
      // 循环 helper 协议：每行一个请求，逐行立即回复；EOF 退出（与真实 helper 一致）。
      let buffer = "";
      const handle = request => {
        if (typeof request.path === "string" && request.path.includes("fail-path")) return { error: "boom" };
        // skills 的失败走 stdout 错误帧且退出码为 0（helper 按请求隔离），验证宿主必须解析确认。
        if (request.action === "skills" && Array.isArray(request.files)
          && request.files.some(file => typeof file?.path === "string" && file.path.includes("fail-path"))) {
          return { error: "[Errno 28] 模拟磁盘满" };
        }
        if (request.action === "read") return { data: Buffer.from(`from:${name}:${request.path}`).toString("base64") };
        if (request.action === "list") return { files: [] };
        if (request.action === "image_type") return { mimeType: null };
        return {};
      };
      process.stdin.setEncoding("utf8");
      const replyLine = line => {
        let reply;
        try { reply = handle(JSON.parse(line)); } catch (error) { reply = { error: error?.message ?? String(error) }; }
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      };
      process.stdin.on("data", chunk => {
        buffer += chunk;
        for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (line.trim()) replyLine(line);
        }
      });
      // 与真实 helper 的 `for line in sys.stdin` 一致：EOF 时最后的未换行行也算一个请求。
      process.stdin.on("end", () => { if (buffer.trim()) replyLine(buffer); });
      return; // stdin 打开期间保持存活，模拟长驻温热容器。
    }
    process.stdout.write(`fake-exec:${args.at(-1)}\n`);
    return;
  }
  process.stderr.write(`fake-docker: 未模拟的子命令 ${subcommand ?? "(空)"}\n`);
  process.exitCode = 1;
}
