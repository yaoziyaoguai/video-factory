import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderRegistry,
  WorkflowRunner,
  type NodeDefinition,
  type WorkflowDefinition,
} from "../src/index.js";

const clock = (): string => "2026-09-22T12:00:00.000Z";

function oversizedParameters(): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`diagnosticField${index + 1}`, `value-${index + 1}`]),
  );
}

describe("receipt parameter boundary", () => {
  it("keeps a successful node successful when diagnostic parameters exceed the receipt boundary", async () => {
    let executions = 0;
    const node: NodeDefinition = {
      id: "creative-planning",
      label: "Creative planning",
      capability: "creative.planning",
      mode: "automatic",
      execute: () => {
        executions += 1;
        return {
          output: { planPath: "/tmp/plan.json" },
          receipt: {
            providerId: "deepseek-broker",
            providerLabel: "DeepSeek broker",
            modelId: "deepseek-v3",
            transport: "unix_socket",
            billing: "subscription",
            requestId: "request-creative-planning-1",
            estimatedCostCny: 0,
            parameters: {
              promptPack: "video-factory/creative-planning-v1",
              producerRequestDigest: "digest-1",
              ...oversizedParameters(),
            },
          },
        };
      },
    };
    const definition: WorkflowDefinition = {
      id: "receipt-boundary-success",
      name: "Receipt boundary success",
      version: "1.0.0",
      nodes: [node],
    };

    const run = await new WorkflowRunner({
      clock,
      providers: new ProviderRegistry(),
    }).run(definition, {});

    const nodeRun = run.nodeRuns[0];
    assert.equal(executions, 1, "receipt projection must not trigger a second provider execution");
    assert.equal(run.status, "succeeded");
    assert.equal(nodeRun?.status, "succeeded");
    assert.deepEqual(nodeRun?.output, { planPath: "/tmp/plan.json" });
    assert.equal(nodeRun?.executionReceipt?.requestId, "request-creative-planning-1");
    assert.equal(nodeRun?.executionReceipt?.estimatedCostCny, 0);
    assert.equal(nodeRun?.executionReceipt?.parametersTruncated, true);
    assert.ok(Object.keys(nodeRun?.executionReceipt?.parameters ?? {}).length <= 32);
    assert.equal(nodeRun?.error, undefined);
  });

  it("keeps the original business failure and metering evidence when its receipt is oversized", async () => {
    const node: NodeDefinition = {
      id: "creative-planning",
      label: "Creative planning",
      capability: "creative.planning",
      mode: "automatic",
      execute: () => ({
        status: "failed" as const,
        error: "provider returned an incomplete planning response",
        providerOutcomeKnown: true,
        receipt: {
          providerId: "deepseek-broker",
          providerLabel: "DeepSeek broker",
          modelId: "deepseek-v3",
          transport: "unix_socket" as const,
          billing: "subscription" as const,
          requestId: "request-creative-planning-2",
          actualCostCny: 0,
          parameters: oversizedParameters(),
        },
      }),
    };
    const definition: WorkflowDefinition = {
      id: "receipt-boundary-failure",
      name: "Receipt boundary failure",
      version: "1.0.0",
      nodes: [node],
    };

    const run = await new WorkflowRunner({
      clock,
      providers: new ProviderRegistry(),
    }).run(definition, {});

    const nodeRun = run.nodeRuns[0];
    assert.equal(run.status, "failed");
    assert.equal(nodeRun?.status, "failed");
    assert.equal(nodeRun?.error, "provider returned an incomplete planning response");
    assert.equal(nodeRun?.executionReceipt?.requestId, "request-creative-planning-2");
    assert.equal(nodeRun?.executionReceipt?.actualCostCny, 0);
    assert.equal(nodeRun?.executionReceipt?.parametersTruncated, true);
    assert.ok(Object.keys(nodeRun?.executionReceipt?.parameters ?? {}).length <= 32);
  });
});
