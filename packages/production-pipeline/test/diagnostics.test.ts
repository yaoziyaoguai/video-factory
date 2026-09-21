import assert from "node:assert/strict";
import { it } from "node:test";
import { diagnosticEvent } from "../src/diagnostics.js";

it("logs only bounded diagnostic facts, never payloads or signed URLs", () => {
  const lines: string[] = [];
  diagnosticEvent("worker.finished", { runId: "run-1", elapsedMs: 30, status: "failed",
    prompt: "private", apiKey: "secret", providerId: "https://host/?token=secret", output: "private" }, line => lines.push(line));
  const result = JSON.parse(lines[0]!);
  assert.equal(result.runId, "run-1");
  assert.equal(result.elapsedMs, 30);
  assert.equal(result.status, "failed");
  assert.doesNotMatch(lines[0]!, /private|secret|token|https/);
});

it("does not let a failed log sink change business execution", () => {
  assert.doesNotThrow(() => diagnosticEvent("worker.started", {}, () => { throw new Error("broken sink"); }));
});
