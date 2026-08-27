import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("package entrypoint", () => {
  it("is importable from the workspace package name after build", async () => {
    const mod = await import("@video-factory/workflow-core");

    assert.equal(typeof mod.WorkflowRunner, "function");
    assert.equal(typeof mod.ProviderRegistry, "function");
    assert.equal(typeof mod.scoreTopicCandidate, "function");
  });
});
