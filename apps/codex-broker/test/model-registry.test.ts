import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelRegistry } from "../src/model-registry.js";
import {
  MAINTENANCE_ADMISSION_PROTOCOL,
  MaintenanceCoordinator,
  runWithMaintenanceAdmission,
  transitionMaintenanceGate,
} from "@video-factory/production-pipeline/maintenance";
import { CodexBridgeClient, type CodexPreparedOperation } from "../../../packages/production-pipeline/src/codex-chat.js";
import { taskContractDescriptorFor } from "../src/task-definitions.js";

test("registry persists private credentials, uses separate durable model identities, and resumes after disable/restart", async () => {
  const directory = await mkdtemp("/tmp/vf-registry-");
  let calls = 0;
  const make = () => new ModelRegistry({ directory, socketDirectory: directory, timeoutMs: 2000,
    createExecutor: (entry) => ({
      identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["topic-ideas"] },
      modelCandidates: [entry.id],
      runTask: async (task) => {
        calls++;
        return { output: '{"ideas":[]}', trace: {
          providerId: entry.id, modelId: entry.id, taskKind: task.kind,
          promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
          contractDigest: taskContractDescriptorFor(task.kind).digest, prompt: "test",
        } };
      },
    }),
  });
  let registry = make();
  try {
    await registry.start();
    const input = { label: "我的模型", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "native/model", apiKey: "private-test-key", capabilities: ["text"], maxOutputTokens: 32768 };
    await registry.handle("POST", "/v1/models", input);
    await registry.handle("POST", "/v1/models", input);
    const models = registry.list();
    assert.equal(models.length, 2);
    assert.notEqual(models[0]!.id, models[1]!.id);
    assert.ok(!JSON.stringify(await registry.handle("GET", "/v1/models")).includes("private-test-key"));
    assert.equal((await stat(path.join(directory, "models.json"))).mode & 0o777, 0o600);
    assert.match(await readFile(path.join(directory, "models.json"), "utf8"), /private-test-key/);
    const model = models[0]!;
    const client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 5000 });
    let prepared: CodexPreparedOperation | undefined;
    const result = await client.runTaskDetailed("topic-ideas", { signals: [{ id: "one", platform: "douyin", rank: 1, title: "topic" }] }, "registry-test", undefined, {
      model: model.id, beforeSubmit: async (operation) => { prepared = operation; },
    });
    assert.deepEqual(result.output, { ideas: [] });
    assert.equal(result.trace?.modelId, model.id);
    await registry.handle("POST", `/v1/models/${model.id}/disable`);
    await registry.close();
    registry = make(); await registry.start();
    assert.equal(registry.list()[0]!.enabled, false);
    const recovered = await client.observePrepared(prepared!);
    assert.deepEqual(recovered.output, { ideas: [] });
    assert.equal(calls, 1);
    await assert.rejects(() => client.runTask("topic-ideas", { signals: [{ id: "two", platform: "douyin", rank: 1, title: "new" }] }, "disabled-task"));
    assert.equal(calls, 1);
    await registry.handle("POST", `/v1/models/${model.id}/enable`);
    assert.equal(registry.list()[0]!.enabled, true);
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("registry retains registered queued writes through draining and reports all disabled model instances", async () => {
  const directory = await mkdtemp("/tmp/vf-registry-queue-");
  const maintenanceDirectory = await mkdtemp("/tmp/vf-registry-queue-gate-");
  await transitionMaintenanceGate(maintenanceDirectory, "open", "setup");
  const app = new MaintenanceCoordinator({ directory: maintenanceDirectory, serviceId: "registry-app" });
  const parent = await app.admit("model-settings");
  const registry = new ModelRegistry({ directory, socketDirectory: directory, timeoutMs: 2000, maintenanceDirectory,
    createExecutor: (entry) => ({
      identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["topic-ideas"] },
      runTask: async () => { throw new Error("No model work expected."); },
    }),
  });
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => { resume = resolve; });
  const internals = registry as unknown as { writes: Promise<unknown> };
  try {
    await registry.start();
    internals.writes = blocked;
    const input = { label: "排队模型", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "native/model", apiKey: "private-test-key", capabilities: ["text"], maxOutputTokens: 32768 };
    const first = registry.handle("POST", "/v1/models", input);
    const second = registry.handle("POST", "/v1/models", input);
    const deadline = Date.now() + 2_000;
    for (;;) {
      const report = JSON.parse(await readFile(path.join(maintenanceDirectory, "holders.json"), "utf8")) as { holders: Array<{ kind: string }> };
      if (report.holders.filter((entry) => entry.kind === "model-registry-write").length === 2) break;
      if (Date.now() > deadline) throw new Error("Registry admission did not become ready.");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await transitionMaintenanceGate(maintenanceDirectory, "draining", "deploy-queue");
    const busy = await registry.maintenanceStatus();
    assert.equal(busy.quiescent, false);
    assert.equal(busy.detail.pendingWrites, 2);
    assert.equal(busy.protocol, MAINTENANCE_ADMISSION_PROTOCOL);
    assert.equal(JSON.stringify(busy).includes(parent.id), false);
    await assert.rejects(() => registry.handle("POST", "/v1/models", input), /Maintenance draining/);
    resume();
    await Promise.all([first, second]);
    assert.equal(registry.list().length, 2, "admitted queued writes complete after gate closes");
    const modelId = registry.list()[0]!.id;
    await runWithMaintenanceAdmission(parent, () => registry.handle("POST", `/v1/models/${modelId}/disable`));
    assert.equal(registry.list()[0]!.enabled, false);
    await app.release(parent);
    const idle = await registry.maintenanceStatus();
    assert.equal(idle.quiescent, true);
    assert.equal(idle.servers.length, 2, "disabled model remains in the aggregate");
    await writeFile(path.join(directory, "models.json"), "{truncated");
    assert.equal((await registry.maintenanceStatus()).quiescent, false);
    await writeFile(path.join(maintenanceDirectory, "gate.json"), "{bad-gate");
    await assert.rejects(() => registry.handle("POST", "/v1/models", input));
    assert.equal((await registry.maintenanceStatus()).integrity.complete, false);
  } finally {
    resume(); await app.release(parent); await registry.close();
    await rm(directory, { recursive: true, force: true }); await rm(maintenanceDirectory, { recursive: true, force: true });
  }
});

test("registry pauses registration writes under the maintenance gate and reports aggregate quiescence", async () => {
  const directory = await mkdtemp("/tmp/vf-registry-maintenance-");
  const maintenanceDirectory = await mkdtemp("/tmp/vf-registry-maintenance-gate-");
  await transitionMaintenanceGate(maintenanceDirectory, "open", "setup");
  const registry = new ModelRegistry({ directory, socketDirectory: directory, timeoutMs: 2000, maintenanceDirectory,
    createExecutor: (entry) => ({
      identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["topic-ideas"] },
      runTask: async () => ({ output: '{"ideas":[]}', trace: {
        providerId: entry.id, modelId: entry.id, taskKind: "topic-ideas",
        promptVersion: taskContractDescriptorFor("topic-ideas").promptVersion,
        contractDigest: taskContractDescriptorFor("topic-ideas").digest, prompt: "test",
      } }),
    }),
  });
  try {
    await registry.start();
    const input = { label: "我的模型", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "native/model", apiKey: "private-test-key", capabilities: ["text"], maxOutputTokens: 32768 };
    await registry.handle("POST", "/v1/models", input);
    const idle = await registry.maintenanceStatus();
    assert.equal(idle.quiescent, true);
    assert.equal(idle.servers.length, 1);

    // 门禁关闭：注册类写入拒绝，查询照常。
    await transitionMaintenanceGate(maintenanceDirectory, "draining", "deploy-1");
    await assert.rejects(() => registry.handle("POST", "/v1/models", input), /Maintenance draining/);
    await assert.rejects(() => registry.handle("POST", `/v1/models/${registry.list()[0]!.id}/disable`), /Maintenance draining/);
    const models = await registry.handle("GET", "/v1/models");
    assert.equal((models as { models: unknown[] }).models.length, 1);
    // 静止判定不受门禁状态本身影响：没有本地写者即静止。
    assert.equal((await registry.maintenanceStatus()).quiescent, true);
  } finally {
    await registry.close();
    await rm(directory, { recursive: true, force: true });
    await rm(maintenanceDirectory, { recursive: true, force: true });
  }
});
