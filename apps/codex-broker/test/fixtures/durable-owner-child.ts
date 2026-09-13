import { CodexBrokerServer } from "../../src/broker-server.js";
import { CodexExecutor, type CodexExecutionOptions, type CodexExecutionResult, type ValidatedTask } from "../../src/codex-executor.js";
import { taskContractDescriptorFor } from "../../src/task-definitions.js";

const [socketPath, idempotencyDirectory, mode = "probe"] = process.argv.slice(2);
if (!socketPath || !idempotencyDirectory) process.exit(2);

class OwnerFixtureExecutor extends CodexExecutor {
  constructor() {
    super({ workspaceRoot: "/nonexistent-owner-fixture" });
  }

  async runTask(task: ValidatedTask, _options?: CodexExecutionOptions): Promise<CodexExecutionResult> {
    return {
      output: "{\"ideas\":[]}",
      trace: {
        taskKind: task.kind,
        promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
        ...(task.expectedContractDigest ? { contractDigest: task.expectedContractDigest } : {}),
        prompt: "owner fixture",
        providerId: this.identity.providerId,
        modelId: this.identity.modelId,
      },
    };
  }
}

const server = new CodexBrokerServer({
  socketPath,
  idempotencyDirectory,
  executor: new OwnerFixtureExecutor(),
});

try {
  await server.start();
  process.stdout.write(`${JSON.stringify({ state: "ready", ...server.healthReport() })}\n`);
  if (mode === "hold") {
    await new Promise<void>((resolve) => {
      const close = (): void => {
        void server.close().then(resolve);
      };
      process.once("SIGTERM", close);
      process.once("SIGINT", close);
    });
  } else {
    await server.close();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 23;
}
