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
        { id: "receipt-2", nodeId: "assets", capability: "asset.generate.video", providerId: "minimax-video", modelId: "MiniMax-Hailuo", billing: "metered", status: "succeeded", spendAuthorizationId: "spend-1", startedAt: "2026-08-27T10:01:00.000Z", finishedAt: "2026-08-27T10:03:00.000Z", estimatedCostCny: 5, actualCostCny: 4.2, actualCostSource: "configured_rate", meteredAttemptCount: 1, meteredFailedAttemptCount: 0 },
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
    assert.equal(dashboard.totals.meteredCalls, 0);
    assert.equal(dashboard.totals.failedMeteredCalls, 0);
  });

  it("keeps an interrupted authorized provider request visible while its actual cost is unknown", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-uncertain-paid",
      initialInput: { title: "中断的付费生成" },
      nodeRuns: [{
        nodeId: "assets",
        role: "素材导演",
        status: "failed",
        startedAt: "2026-08-27T11:00:00.000Z",
        outcomeUncertain: true,
        operationRequestId: "provider-operation-1",
        spendAuthorizationId: "authorization-uncertain",
        spendPlan: {
          providerId: "minimax-video",
          modelId: "MiniMax-Hailuo",
          estimatedCostCny: 2.4,
        },
      }],
      executionReceipts: [],
      spendAuthorizations: [{
        id: "authorization-uncertain",
        nodeId: "assets",
        providerId: "minimax-video",
        modelId: "MiniMax-Hailuo",
        maxCostCny: 3,
      }],
    }]));

    const detail = await studio.runDetail("run-uncertain-paid");

    assert.equal(detail?.lines.length, 1);
    assert.equal(detail?.totals.authorizedCostCny, 3);
    assert.equal(detail?.totals.actualCostCny, 0);
    assert.equal(detail?.totals.actualPendingCount, 1);
    assert.equal(detail?.totals.meteredCalls, 1);
    assert.equal(detail?.lines[0]?.status, "unknown");
    assert.equal(detail?.lines[0]?.actualPending, true);
  });

  it("counts every producer and auditor call in an agent loop", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-agent-loop",
      executionReceipts: [{
        id: "script-loop",
        nodeId: "script",
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        billing: "subscription",
        status: "succeeded",
        startedAt: "2026-08-27T11:00:00.000Z",
        parameters: { agentLoopIterations: 3, modelCallCount: 6 },
      }],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-agent-loop");

    assert.equal(detail?.totals.subscriptionCalls, 6);
    assert.equal(detail?.lines[0]?.subscriptionCallCount, 6);
    assert.equal((await studio.dashboard()).byProvider[0]?.calls, 6);
  });

  it("infers legacy metered attempts only from accepted-request evidence", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-legacy-evidence",
      executionReceipts: [
        { id: "actual-cost", nodeId: "image", providerId: "provider-a", modelId: "image-a", billing: "metered", status: "succeeded", startedAt: "2026-08-27T11:01:00.000Z", estimatedCostCny: 1, actualCostCny: 0.8 },
        { id: "accepted-request", nodeId: "video", providerId: "provider-b", modelId: "video-b", billing: "metered", status: "unknown", requestId: "request-123", startedAt: "2026-08-27T11:02:00.000Z", estimatedCostCny: 3 },
        { id: "estimate-only", nodeId: "voice", providerId: "provider-c", modelId: "voice-c", billing: "metered", status: "succeeded", startedAt: "2026-08-27T11:03:00.000Z", estimatedCostCny: 0.2 },
      ],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-legacy-evidence");

    assert.equal(detail?.totals.meteredCalls, 2);
    assert.equal(detail?.totals.actualCostCny, 0.8);
    assert.equal(detail?.totals.actualPendingCount, 2);
    assert.equal(detail?.lines.find((line) => line.id === "estimate-only")?.meteredAttemptCount, undefined);
  });

  it("keeps historical retries while deduplicating the current node receipt", async () => {
    const first = { nodeId: "assets", capability: "asset.prepare", providerId: "hailuo-video-v1", modelId: "MiniMax-Hailuo", billing: "metered", startedAt: "2026-08-27T11:00:00.000Z", estimatedCostCny: 3, meteredAttemptCount: 1, meteredFailedAttemptCount: 0 };
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

  it("counts an interrupted operation only once when its original provider task is resumed", async () => {
    const first = {
      id: "interrupted-attempt",
      nodeId: "assets",
      capability: "asset.prepare",
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo",
      billing: "metered",
      status: "failed",
      requestId: "stable-operation-1",
      startedAt: "2026-08-27T11:00:00.000Z",
      estimatedCostCny: 2.4,
      actualCostCny: 2.4,
      meteredAttemptCount: 1,
      meteredFailedAttemptCount: 1,
    };
    const resumed = {
      ...first,
      id: "resumed-attempt",
      status: "succeeded",
      startedAt: "2026-08-27T11:05:00.000Z",
      meteredFailedAttemptCount: 0,
    };
    const studio = new CostStudio(async () => ([{
      id: "run-resumed-operation",
      nodeRuns: [{ nodeId: "assets", status: "succeeded", executionReceipt: resumed }],
      executionReceipts: [first, resumed],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-resumed-operation");

    assert.equal(detail?.lines.length, 1);
    assert.equal(detail?.lines[0]?.status, "succeeded");
    assert.equal(detail?.totals.actualCostCny, 2.4);
    assert.equal(detail?.totals.meteredCalls, 1);
    assert.equal(detail?.totals.failedMeteredCalls, 0);
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
    assert.equal(detail?.totals.meteredCalls, 0);
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
        { id: "attempt-1", nodeId: "assets", providerId: "minimax", modelId: "video", billing: "metered", status: "succeeded", spendAuthorizationId: "authorization-1", startedAt: "2026-08-27T12:00:00.000Z", estimatedCostCny: 2, actualCostCny: 1.8, meteredAttemptCount: 1, meteredFailedAttemptCount: 0 },
        { id: "attempt-2", nodeId: "assets", providerId: "minimax", modelId: "video", billing: "metered", status: "failed", spendAuthorizationId: "authorization-1", startedAt: "2026-08-27T12:01:00.000Z", estimatedCostCny: 2, meteredAttemptCount: 1, meteredFailedAttemptCount: 1 },
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

  it("keeps a resumed operation pending when part of its actual cost is already known", async () => {
    const studio = new CostStudio(async () => ([{
      id: "run-partial-voice",
      nodeRuns: [{
        nodeId: "voice",
        status: "failed",
        outcomeUncertain: true,
        operationRequestId: "voice-operation-1",
        executionReceipt: {
          id: "voice-operation-1",
          nodeId: "voice",
          providerId: "minimax-tts-v1",
          modelId: "speech-2.8-hd",
          billing: "metered",
          status: "failed",
          requestId: "voice-operation-1",
          startedAt: "2026-08-27T14:00:00.000Z",
          actualCostCny: 0.1,
          actualCostSource: "configured_rate",
          meteredAttemptCount: 1,
        },
      }],
      executionReceipts: [],
      spendAuthorizations: [],
    }]));

    const detail = await studio.runDetail("run-partial-voice");
    assert.equal(detail?.totals.actualCostCny, 0.1);
    assert.equal(detail?.totals.actualPendingCount, 1);
    assert.equal(detail?.lines[0]?.actualPending, true);
  });
});
