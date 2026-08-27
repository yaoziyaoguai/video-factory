import { CodexBrokerServer } from "./broker-server.js";
import { CodexExecutor } from "./codex-executor.js";
import { brokerRuntimeConfigFromEnv } from "./runtime-config.js";

// 只信启动环境，不接受任何来自 HTTP payload 的执行参数；无 host/port 概念，只走 Unix socket。
try {
  const config = brokerRuntimeConfigFromEnv(process.env);

  const server = new CodexBrokerServer({
    socketPath: config.socketPath,
    executor: new CodexExecutor({
      workspaceRoot: config.workspaceRoot,
      codexBin: config.codexBin,
      profile: config.profile,
      effort: config.effort,
      timeoutMs: config.timeoutMs,
    }),
    concurrency: config.concurrency,
    maxBacklog: config.maxBacklog,
  });
  await server.start();
  process.stdout.write(
    [
      `codex-broker listening on ${config.socketPath}`,
      `profileId=${config.profile.identity.profileId}`,
      `providerId=${config.profile.identity.providerId}`,
      `modelId=${config.profile.identity.modelId}`,
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
