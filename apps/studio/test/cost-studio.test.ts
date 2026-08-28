import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CostStudio } from "../src/server/cost-studio.js";

describe("CostStudio", () => {
  it("separates estimated, authorized, and actual spend across billing types", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-1",
      initialInput: { title: "第一条付费成片" },
      nodeRuns: [
        { nodeId: "script", role: "编剧", status: "succeeded" },
        { nodeId: "assets", role: "素材导演", status: "succeeded" },
        { nodeId: "render", role: "剪辑师", status: "succeeded" },
      ],
      executionReceipts: [
        { id: "receipt-1", nodeId: "script", capability: "script.draft", providerId: "openai-codex", modelId: "codex", billing: "subscription", status: "succeeded", startedAt: "2026-08-27T10:00:00.000Z", finishedAt: "2026-08-27T10:00:02.000Z", estimatedCostCny: 0 },
        { id: "receipt-2", nodeId: "assets", capability: "asset.generate.video", providerId: "minimax-video", modelId: "MiniMax-Hailuo", billing: "metered", status: "succeeded", spendAuthorizationId: "spend-1", startedAt: "2026-08-27T10:01:00.000Z", finishedAt: "2026-08-27T10:03:00.000Z", estimatedCostCny: 5, actualCostCny: 4.2, actualCostSource: "configured_rate" },
        { id: "receipt-3", nodeId: "render", capability: "video.render", providerId: "python-ffmpeg-v1", modelId: "ffmpeg", billing: "free", status: "succeeded", startedAt: "2026-08-27T10:04:00.000Z", finishedAt: "2026-08-27T10:04:10.000Z", estimatedCostCny: 0 },
      ],
      spendAuthorizations: [
        { id: "spend-1", nodeId: "assets", providerId: "minimax-video", modelId: "MiniMax-Hailuo", maxCostCny: 6, maxAttempts: 1, approvedAt: "2026-08-27T10:00:50.000Z" },
      ],
    }]));

    const dashboard = await studio.dashboard();
    assert.deepEqual(dashboard.totals, {
      estimatedCostCny: 5,
      authorizedCostCny: 6,
      actualCostCny: 4.2,
      actualPendingCount: 0,
      meteredCalls: 1,
      subscriptionCalls: 1,
      freeCalls: 1,
      failedMeteredCalls: 0,
    });
    assert.equal(dashboard.byProvider.find((item) => item.providerId === "minimax-video")?.actualCostCny, 4.2);
    assert.equal(dashboard.runs[0]?.title, "第一条付费成片");
    assert.equal((await studio.runDetail("run-1"))?.lines[1]?.authorizedCostCny, 6);
    assert.equal((await studio.runDetail("run-1"))?.lines[1]?.actualCostSource, "configured_rate");
  });

  it("keeps unknown actual spend pending and counts failed metered retries", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-2",
      initialInput: { title: "失败重试" },
      nodeRuns: [{ nodeId: "assets", role: "素材导演", status: "failed" }],
      executionReceipts: [
        { id: "receipt-4", nodeId: "assets", capability: "asset.generate.video", providerId: "provider-x", modelId: "video-x", billing: "metered", startedAt: "2026-08-27T11:00:00.000Z", finishedAt: "2026-08-27T11:00:01.000Z", estimatedCostCny: 3, status: "failed" },
      ],
      spendAuthorizations: [],
    }]));

    const dashboard = await studio.dashboard();
    assert.equal(dashboard.totals.actualCostCny, 0);
    assert.equal(dashboard.totals.actualPendingCount, 1);
    assert.equal(dashboard.totals.failedMeteredCalls, 1);
  });

  it("keeps historical retries while deduplicating the current node receipt", async () => {
    const first = { nodeId: "assets", capability: "asset.prepare", providerId: "hailuo-video-v1", modelId: "MiniMax-Hailuo", billing: "metered", startedAt: "2026-08-27T11:00:00.000Z", estimatedCostCny: 3 };
    const second = { ...first, startedAt: "2026-08-27T11:05:00.000Z" };
    const studio = new CostStudio(async () => ([{
      id: "run-3",
      nodeRuns: [{ nodeId: "assets", status: "succeeded", executionReceipt: second }],
      executionReceipts: [first, second],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-3");
    assert.equal(detail?.lines.length, 2);
    assert.equal(detail?.totals.meteredCalls, 2);
    assert.equal(detail?.totals.estimatedCostCny, 6);
  });

  it("keeps the authorized baseline after a paid node is replaced by a human version", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-human-revision",
      nodeRuns: [{ nodeId: "assets", role: "素材导演", status: "succeeded" }],
      executionReceipts: [{
        id: "paid-attempt",
        nodeId: "assets",
        providerId: "minimax",
        modelId: "video",
        billing: "metered",
        status: "succeeded",
        startedAt: "2026-08-27T11:00:00.000Z",
        estimatedCostCny: 2.1,
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-human-revision");
    assert.equal(detail?.totals.authorizedCostCny, 2.1);
    assert.equal(detail?.totals.meteredCalls, 1);
  });

  it("prefers the immutable receipt authorization over mutable run state", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-receipt-authorization",
      executionReceipts: [{
        id: "paid-attempt",
        nodeId: "assets",
        providerId: "minimax",
        modelId: "video",
        billing: "metered",
        status: "succeeded",
        spendAuthorizationId: "authorization-retired",
        authorizedCostCny: 3,
        startedAt: "2026-08-27T11:00:00.000Z",
        estimatedCostCny: 2.1,
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-receipt-authorization");
    assert.equal(detail?.totals.authorizedCostCny, 3);
    assert.equal(detail?.lines[0]?.spendAuthorizationId, "authorization-retired");
  });

  it("counts one authorization across retries and trusts receipt status over the current node", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-4",
      nodeRuns: [{ nodeId: "assets", role: "素材导演", status: "failed" }],
      executionReceipts: [
        { id: "attempt-1", nodeId: "assets", providerId: "minimax", modelId: "video", billing: "metered", status: "succeeded", spendAuthorizationId: "authorization-1", startedAt: "2026-08-27T12:00:00.000Z", estimatedCostCny: 2, actualCostCny: 1.8 },
        { id: "attempt-2", nodeId: "assets", providerId: "minimax", modelId: "video", billing: "metered", status: "failed", spendAuthorizationId: "authorization-1", startedAt: "2026-08-27T12:01:00.000Z", estimatedCostCny: 2 },
      ],
      spendAuthorizations: [{ id: "authorization-1", nodeId: "assets", providerId: "minimax", modelId: "video", maxCostCny: 5 }],
    }]));

    const detail = await studio.runDetail("run-4");
    assert.equal(detail?.totals.authorizedCostCny, 5);
    assert.deepEqual(detail?.lines.map((line) => line.status), ["succeeded", "failed"]);
    assert.equal(detail?.totals.failedMeteredCalls, 1);
  });

  it("counts nested metered attempts even when the asset node succeeds through a free fallback", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-fallback",
      executionReceipts: [{
        id: "asset-router",
        nodeId: "assets",
        providerId: "ai-shot-router-v1",
        modelId: "seedance",
        billing: "metered",
        status: "succeeded",
        startedAt: "2026-08-28T11:00:00.000Z",
        estimatedCostCny: 8,
        actualCostCny: 8,
        actualCostSource: "configured_rate",
        meteredAttemptCount: 1,
        meteredFailedAttemptCount: 1,
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-fallback");
    assert.equal(detail?.totals.actualCostCny, 8);
    assert.equal(detail?.totals.meteredCalls, 1);
    assert.equal(detail?.totals.failedMeteredCalls, 1);
    assert.equal(detail?.lines[0]?.meteredFailedAttemptCount, 1);
  });

  it("does not infer a historical receipt failure from the node's latest status", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-5",
      nodeRuns: [{
        nodeId: "assets",
        status: "failed",
        executionReceipt: { providerId: "minimax", modelId: "video", billing: "metered", startedAt: "2026-08-27T13:00:00.000Z" },
      }],
      executionReceipts: [],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-5");
    assert.equal(detail?.lines[0]?.status, "unknown");
    assert.equal(detail?.totals.failedMeteredCalls, 0);
  });
});
