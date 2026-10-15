import { CodexBrokerServer } from "./broker-server.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createBrokerExecutor } from "./executor-factory.js";
import { brokerRuntimeConfigFromEnv } from "./runtime-config.js";
import { ModelRegistry } from "./model-registry.js";

// 只信启动环境，不接受任何来自 HTTP payload 的执行参数；无 host/port 概念，只走 Unix socket。
try {
  const config = brokerRuntimeConfigFromEnv(process.env);
  let releaseSha: string | undefined;
  try {
    releaseSha = (await readFile(new URL("../release-sha", import.meta.url), "utf8")).trim();
    if (!/^[a-f0-9]{40}$/.test(releaseSha)) throw new Error("Broker release identity is invalid.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const maintenanceDirectory = process.env.VIDEO_FACTORY_MAINTENANCE_DIR?.trim() || undefined;
  const models = new ModelRegistry({
    directory: path.join(config.workspaceRoot, ".video-factory", "models"),
    socketDirectory: path.dirname(config.socketPath),
    timeoutMs: config.timeoutMs,
    ...(maintenanceDirectory ? { maintenanceDirectory } : {}),
  });
  await models.start();

  const server = new CodexBrokerServer({
    socketPath: config.socketPath,
    executor: createBrokerExecutor(config, process.env),
    ...(releaseSha ? { releaseSha } : {}),
    concurrency: config.concurrency,
    maxBacklog: config.maxBacklog,
    idempotencyDirectory: path.join(config.workspaceRoot, ".video-factory", "codex-idempotency", config.profile.identity.profileId),
    sessionDirectory: path.join(config.workspaceRoot, ".video-factory", "codex-sessions", config.profile.identity.profileId),
    modelManagement: (method, url, body) => models.handle(method, url, body),
    ...(maintenanceDirectory
      ? {
          maintenanceDirectory,
          // /health 汇总默认与全部注册（含停用）模型实例的静止判定，供部署排空轮询。
          maintenanceAggregate: async () => {
            const status = await models.maintenanceStatus();
            return { quiescent: status.quiescent, detail: { ...status } };
          },
        }
      : {}),
  });
  await server.start();
  process.stdout.write(
    [
      `codex-broker listening on ${config.socketPath}`,
      `profileId=${config.profile.identity.profileId}`,
      `providerId=${config.profile.identity.providerId}`,
      `modelId=${config.profile.identity.modelId}`,
      `engine=${config.profile.identity.profileId === "openai" ? "codex-cli" : "chat-completions"}`,
      `workspace=${config.workspaceRoot}`,
      `codexBin=${config.codexBin}`,
      `auditModel=${config.auditModel ?? "same-as-production"}`,
      `effort=${config.effort}`,
      `auditEffort=${config.auditEffort}`,
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
      void Promise.all([server.close(), models.close()]).then(() => process.exit(0)).catch((error: unknown) => {
        process.stderr.write(`codex-broker shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    });
  }
} catch (error) {
  process.stderr.write(`codex-broker failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
