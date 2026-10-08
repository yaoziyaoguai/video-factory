import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CodexBrokerServer } from "../../codex-broker/src/broker-server.js";
import { ModelRegistry } from "../../codex-broker/src/model-registry.js";
import { codexExecutorProfileFor } from "../../codex-broker/src/codex-executor.js";
import { ModelConnections } from "../src/server/model-connections.js";
import { includeRegisteredModels } from "../src/server/registered-model-catalog.js";
import { buildRoleAgentAssembly } from "../src/server/role-agent-assembly.js";
import { CapabilityStudio } from "../src/server/capability-studio.js";

test("Studio management reaches the broker registry and refreshes the real selectable role catalog", async () => {
  const directory = await mkdtemp("/tmp/vf-model-api-");
  const identity = codexExecutorProfileFor("deepseek").identity;
  let executions = 0;
  const executor = { identity, runTask: async () => { executions++; throw new Error("saving must not call a model"); } };
  const registry = new ModelRegistry({ directory, socketDirectory: directory, timeoutMs: 1000, createExecutor: () => executor });
  const socket = path.join(directory, "root.sock");
  const server = new CodexBrokerServer({ socketPath: socket, executor, modelManagement: (method, url, body) => registry.handle(method, url, body) });
  try {
    await registry.start(); await server.start();
    const manager = new ModelConnections(socket);
    let changes = 0;
    manager.onChange = () => { changes++; };
    assert.deepEqual(await manager.refresh(), []);
    const models = await manager.add({ label: "独立模型", protocol: "anthropic-messages", modelId: "vendor/model", baseUrl: "https://example.com/v1", apiKey: "private-test", capabilities: ["text", "image"], maxOutputTokens: 32000 });
    assert.equal(models.length, 1);
    assert.ok(!JSON.stringify(models).includes("private-test"));
    const id = models[0]!.id;
    const client = manager.connections[0]!.client;
    const catalog = includeRegisteredModels([{ id: "codex-screenwriter-v1", label: "编剧", capability: "script.draft", kind: "external", available: false, billing: "subscription", latency: "seconds", modes: [], description: "" }], models, { python: true, ffmpeg: true, ffprobe: true });
    assert.equal(catalog[0]!.available, true);
    assert.equal(catalog[0]!.modelProfiles?.[0]?.id, id);
    const assembly = buildRoleAgentAssembly({ connectedModels: manager.connections, environment: {}, deepseekCodexSettings: { available: false, reason: "测试无默认", socketPath: socket, modelId: "unused", taskKinds: [] }, reviewMedia: { prepare: async () => { throw new Error("unused"); } } });
    assert.equal(assembly.screenwriterAgent?.modelId, id);
    assert.equal(assembly.directorAgent?.modelId, id);
    assert.equal(assembly.visualReviewAgents.length, 1);
    await manager.disable(id);
    assert.equal(manager.connections[0]!.model.enabled, false);
    assert.equal(manager.connections[0]!.client, client, "keep original client for accepted task recovery");
    await manager.enable(id);
    assert.equal(manager.connections[0]!.model.enabled, true);
    assert.equal(changes, 4);
    assert.equal(executions, 0);
  } finally { await server.close(); await registry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a registered director makes the shot router available without a legacy default broker", async () => {
  const capabilities = new CapabilityStudio({
    repositoryRoot: process.cwd(), workspaceRoot: "/unused-model-catalog", environment: {},
    commandAvailable: async () => true,
    codexAvailability: { available: false, reason: "not configured", taskKinds: [] },
    deepseekCodexAvailability: { available: false, reason: "not configured", taskKinds: [] },
    registeredModels: () => [{ id: "m-0123456789ab", enabled: true, socketName: "m-0123456789ab.sock",
      label: "Registered director", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1",
      modelId: "test-model", capabilities: ["text", "image"], maxOutputTokens: 4096, credentialConfigured: true }],
  });
  const catalog = await capabilities.listProviders();
  assert.equal(catalog.find(provider => provider.id === "api-visual-director-v1")?.available, true);
  assert.equal(catalog.find(provider => provider.id === "ai-shot-router-v1")?.available, true,
    "a usable director must not be rejected solely because the old broker is absent");
});

test("shot routing still requires Python and an enabled text-capable director", async () => {
  for (const scenario of ["no-python", "disabled", "image-only", "no-connection"] as const) {
    const capabilities = new CapabilityStudio({
      repositoryRoot: process.cwd(), workspaceRoot: "/unused-model-catalog", environment: {},
      commandAvailable: async command => scenario !== "no-python" || command !== "python3",
      codexAvailability: { available: false, reason: "not configured", taskKinds: [] },
      deepseekCodexAvailability: { available: false, reason: "not configured", taskKinds: [] },
      registeredModels: () => scenario === "no-connection" ? [] : [{ id: "m-0123456789ab", enabled: scenario !== "disabled",
        socketName: "m-0123456789ab.sock", label: "Registered model", protocol: "openai-chat-completions",
        baseUrl: "https://example.com/v1", modelId: "test-model", capabilities: scenario === "image-only" ? ["image"] : ["text", "image"],
        maxOutputTokens: 4096, credentialConfigured: true }],
    });
    const catalog = await capabilities.listProviders();
    assert.equal(catalog.find(provider => provider.id === "ai-shot-router-v1")?.available, false, scenario);
  }
});
