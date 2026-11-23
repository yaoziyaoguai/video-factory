// 对同一份构建以原始字节和生产预压缩分别运行真实工作台，沿用已有采样器与棘轮。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const client = path.join(root, "apps/studio/dist/client");
const report = path.resolve(process.env.FRAME_PERF_REPORT ?? path.join(root, "perf/.local", `frame-${Date.now()}.json`));
const label = createHash("sha256").update(await readFile(path.join(client, "index.html"))).digest("hex").slice(0, 12);
await access(path.join(client, "index.html.br"));
const temporary = await mkdtemp(path.join(tmpdir(), "frame-perf-"));
let server;

async function listen(dist) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "apps/studio/src/server/agent/offline-main.ts"], {
    cwd: root, env: { ...process.env, AGENT_PORT: String(port), AGENT_UI_ORIGIN: origin,
      AGENT_DIST_DIR: dist, AGENT_DATA_DIR: path.join(temporary, "data") }, stdio: ["ignore", "pipe", "inherit"],
  });
  server = child;
  await new Promise((resolve, reject) => {
    let output = "";
    const exited = (code, signal) => reject(new Error(`离线工作台启动失败 ${code ?? signal}\n${output}`));
    child.once("error", reject);
    child.once("exit", exited);
    child.stdout.setEncoding("utf8").on("data", chunk => {
      output += chunk;
      if (output.includes('"agent-offline-listening"')) {
        child.off("exit", exited);
        child.stdout.removeAllListeners("data");
        child.stdout.resume();
        resolve();
      }
    });
  });
  return origin;
}

async function run(script, ...args) {
  const child = spawn(process.execPath, [...(script === "frame-history.mjs" ? ["--import", "tsx"] : []), path.join(root, "perf/bench", script), ...args], { cwd: root, stdio: "inherit" });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`${script} 退出 ${code ?? signal}。证据保存在 ${report}`);
}

try {
  await mkdir(path.dirname(report), { recursive: true });
  const serving = path.join(temporary, "client");
  await cp(client, path.join(temporary, "identity"), { recursive: true, filter: file => !/\.(br|gz)$/.test(file) });
  await symlink(client, path.join(temporary, "compressed"), "dir");
  await symlink("compressed", serving, "dir");
  const origin = await listen(serving);
  await run("frame-ratchet.mjs", "--selftest");
  await run("frame-measure.mjs", "--a", origin, "--b", origin, "--out", report, "--runs", "10", "--send-runs", "40", "--guards", "1",
    "--transfer-root", temporary,
    "--label-a", `identity-${label}`, "--label-b", `compressed-${label}`);
  await run("frame-ratchet.mjs", report);
  await run("frame-history.mjs", report + ".history.json");
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(temporary, { recursive: true, force: true });
}
