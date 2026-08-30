import { CodexBrokerServer } from "./broker-server.js";
import path from "node:path";
import { createBrokerExecutor } from "./executor-factory.js";
import { brokerRuntimeConfigFromEnv } from "./runtime-config.js";

// 只信启动环境，不接受任何来自 HTTP payload 的执行参数；无 host/port 概念，只走 Unix socket。
try {
  const config = brokerRuntimeConfigFromEnv(process.env);

  const server = new CodexBrokerServer({
    socketPath: config.socketPath,
    executor: createBrokerExecutor(config, process.env),
    concurrency: config.concurrency,
    maxBacklog: config.maxBacklog,
    idempotencyDirectory: path.join(config.workspaceRoot, ".video-factory", "codex-idempotency", config.profile.identity.profileId),
  });
  await server.start();
  process.stdout.write(
    [
      `codex-broker listening on ${config.socketPath}`,
      `profileId=${config.profile.identity.profileId}`,
      `providerId=${config.profile.identity.providerId}`,
      `modelId=${config.profile.identity.modelId}`,
      `engine=${config.profile.identity.profileId === "zai" ? "chat-completions" : "codex-cli"}`,
      `workspace=${config.workspaceRoot}`,
      `codexBin=${config.codexBin}`,
      `effort=${config.effort}`,
      `concurrency=${config.concurrency}`,
      `backlog=${config.maxBacklog}`,
      `timeoutMs=${config.timeoutMs}`,
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
