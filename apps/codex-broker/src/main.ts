import { CodexBrokerServer } from "./broker-server.js";
import { CodexExecutor } from "./codex-executor.js";

// 只信启动环境，不接受任何来自 HTTP payload 的执行参数；无 host/port 概念，只走 Unix socket。
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const DEFAULT_SOCKET_PATH = "/run/video-factory-codex/worker.sock";
const DEFAULT_WORKSPACE_ROOT = "/home/vf-codex/.local/state/video-factory/tasks";

try {
  const socketPath = optionalText("VIDEO_FACTORY_CODEX_SOCKET_PATH") ?? DEFAULT_SOCKET_PATH;
  const workspaceRoot = optionalText("VIDEO_FACTORY_CODEX_WORKSPACE_ROOT") ?? DEFAULT_WORKSPACE_ROOT;
  const codexBin = optionalText("CODEX_BIN") ?? "codex";
  const model = optionalText("VIDEO_FACTORY_CODEX_MODEL");
  const effort = optionalText("VIDEO_FACTORY_CODEX_EFFORT") ?? "high";
  if (!ALLOWED_EFFORTS.has(effort)) {
    throw new Error("VIDEO_FACTORY_CODEX_EFFORT must be one of low|medium|high|xhigh.");
  }
  // 默认 300s，略短于容器侧 director client 的 deadline，让错误优先带上下文地从 broker 冒出。
  const timeoutMs = readInteger("VIDEO_FACTORY_CODEX_TIMEOUT_MS", 300_000, 1_000, 3_600_000);
  const concurrency = readInteger("VIDEO_FACTORY_CODEX_CONCURRENCY", 1, 1, 8);
  const maxBacklog = readInteger("VIDEO_FACTORY_CODEX_MAX_BACKLOG", 20, 1, 1_000);

  const server = new CodexBrokerServer({
    socketPath,
    executor: new CodexExecutor({
      workspaceRoot,
      codexBin,
      ...(model !== undefined ? { model } : {}),
      effort,
      timeoutMs,
    }),
    concurrency,
    maxBacklog,
  });
  await server.start();
  process.stdout.write(
    [
      `codex-broker listening on ${socketPath}`,
      `workspace=${workspaceRoot}`,
      `codexBin=${codexBin}`,
      `model=${model ?? "(codex default)"}`,
      `effort=${effort}`,
      `concurrency=${concurrency}`,
      `backlog=${maxBacklog}`,
      `timeoutMs=${timeoutMs}`,
    ].join(" "),
  );
  process.stdout.write("\n");

  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void server.close().then(() => process.exit(0)).catch((error: unknown) => {
        process.stderr.write(`codex-broker shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    });
  }
} catch (error) {
  process.stderr.write(`codex-broker failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function optionalText(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
