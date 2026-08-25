import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { WorkflowRun } from "@video-factory/workflow-core";
import { runCli } from "../src/index.js";

describe("factory CLI", () => {
  it("runs a brief and approves the active intervention without requiring its internal id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-cli-"));
    const briefPath = path.join(root, "brief.json");
    const brief = {
      protocolVersion: "video-factory/brief-v1",
      title: "做决定前，先避开这 3 个坑",
      angle: "低风险、可收藏的生活清单",
      audience: "有决策压力的普通上班族",
      nicheSlug: "life-avoidance",
      durationSeconds: 30,
      platform: "douyin",
      reviewMode: "manual",
      providers: {
        script: "python-template-v1",
        assets: "local-editorial-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
    };
    await writeFile(briefPath, JSON.stringify(brief), "utf8");
    const decisions: unknown[] = [];
    const fakePipeline = {
      start: async (input: unknown) => {
        assert.deepEqual(input, brief);
        return waitingRun();
      },
      show: async () => waitingRun(),
      decide: async (_runId: string, decision: unknown) => {
        decisions.push(decision);
        return { ...waitingRun(), status: "succeeded" as const, revision: 1 };
      },
    };
    const output: string[] = [];

    const runExit = await runCli(["run", briefPath, "--workspace", root], {
      createPipeline: () => fakePipeline,
      stdout: (text) => output.push(text),
    });
    const approveExit = await runCli([
      "approve",
      "run-1",
      "--actor",
      "director",
      "--note",
      "Ready to publish",
      "--workspace",
      root,
    ], {
      createPipeline: () => fakePipeline,
      stdout: (text) => output.push(text),
    });

    assert.equal(runExit, 0);
    assert.equal(approveExit, 0);
    assert.deepEqual(decisions, [
      {
        interventionId: "intervention-1",
        action: "approve",
        actor: "director",
        note: "Ready to publish",
      },
    ]);
    assert.equal(JSON.parse(output[0]!).status, "needs_human");
    assert.equal(JSON.parse(output[1]!).status, "succeeded");
  });

  it("requires an actor for a human decision", async () => {
    await assert.rejects(
      () => runCli(["approve", "run-1"], {
        createPipeline: () => { throw new Error("must not create pipeline"); },
        stdout: (_text: string) => undefined,
      }),
      /--actor/,
    );
  });
});

function waitingRun(): WorkflowRun {
  return {
    id: "run-1",
    revision: 0,
    workflowId: "daily-production",
    workflowVersion: "1.0.0",
    status: "needs_human",
    initialInput: {},
    startedAt: "2026-08-21T10:00:00.000Z",
    finishedAt: "2026-08-21T10:05:00.000Z",
    nodeRuns: [],
    artifacts: [],
    interventions: [{
      id: "intervention-1",
      nodeId: "final-review",
      createdAt: "2026-08-21T10:05:00.000Z",
      reason: "Watch the final video.",
      requiredAction: "approve",
    }],
    decisions: [],
  };
}
