import { describe, expect, it } from "vitest";
import type { StudioNode } from "../src/shared/api.js";
import { buildRunObservability } from "../src/server/run-observability.js";

function node(
  id: string,
  label: string,
  status: StudioNode["status"],
  overrides: Partial<StudioNode> = {},
): StudioNode {
  return {
    id,
    label,
    status,
    artifactIds: [],
    qualityGateResults: [],
    ...overrides,
  };
}

describe("run observability", () => {
  it("groups the production line into five creator-facing phases and reports truthful progress", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded", { startedAt: "2026-08-30T10:00:00.000Z", finishedAt: "2026-08-30T10:00:10.000Z" }),
        node("script", "脚本", "succeeded", { startedAt: "2026-08-30T10:00:10.000Z", finishedAt: "2026-08-30T10:01:00.000Z" }),
        node("assets", "画面", "running", { startedAt: "2026-08-30T10:01:00.000Z", role: "素材导演" }),
        node("voice", "配音", "pending"),
        node("render", "渲染", "pending"),
        node("technical-review", "机器质检", "pending"),
        node("publish-package", "发布包", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.phases.map((phase) => phase.label)).toEqual([
      "策划定稿",
      "素材筹备",
      "声音与剪辑",
      "审片质检",
      "交付发布",
    ]);
    expect(result.progress).toMatchObject({
      completedNodes: 2,
      totalNodes: 7,
      percentage: 29,
      elapsedSeconds: 120,
      currentNodeElapsedSeconds: 60,
      etaUnavailableReason: "insufficient_history",
    });
    expect(result.currentAction).toMatchObject({
      nodeId: "assets",
      role: "素材导演",
      label: "正在组织逐镜画面并核对素材来源",
    });
  });

  it("excludes human waiting and stale historical timestamps from processing time", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-31T10:00:20.000Z",
      nodes: [
        node("script", "脚本", "succeeded", {
          startedAt: "2026-08-30T10:00:00.000Z",
          finishedAt: "2026-08-30T10:00:40.000Z",
        }),
        node("visual-direction", "导演方案", "running", {
          startedAt: "2026-08-31T10:00:00.000Z",
        }),
        node("final-review", "人工终审", "pending", {
          startedAt: "2026-08-30T10:05:00.000Z",
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.progress.elapsedSeconds).toBe(60);
    expect(result.progress.currentNodeElapsedSeconds).toBe(20);
    expect(result.progress.lastUpdatedAt).toBe("2026-08-31T10:00:00.000Z");
    expect(result.currentAction?.nodeId).toBe("visual-direction");
  });

  it("describes the script node as a producer and independent-auditor loop", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:01:00.000Z",
      nodes: [node("script", "脚本", "running", {
        role: "编剧",
        plannedExecution: {
          providerId: "codex-screenwriter-v1",
          providerLabel: "Codex 编剧",
          modelId: "gpt-5.6-sol",
          transport: "unix_socket",
          billing: "subscription",
          snapshotSource: "created",
        },
      })],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.currentAction?.label).toBe("编剧正在根据独立复核意见修改脚本，最多 3 轮");
  });

  it("does not claim an Agent audit for the local template script provider", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:01:00.000Z",
      nodes: [node("script", "脚本", "running", {
        role: "编剧",
        plannedExecution: {
          providerId: "python-template-v1",
          providerLabel: "模板脚本",
          modelId: "rule-template",
          transport: "local_process",
          billing: "free",
          snapshotSource: "created",
        },
      })],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.currentAction?.label).toBe("编剧正在生成结构化脚本");
  });

  it("only exposes an ETA range when every remaining node has enough historical evidence", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:00:30.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded", { finishedAt: "2026-08-30T10:00:10.000Z" }),
        node("voice", "配音", "running", { startedAt: "2026-08-30T10:00:10.000Z" }),
        node("render", "渲染", "pending"),
      ],
      historicalNodeDurations: {
        voice: [40, 50, 60],
        render: [90, 100, 110],
      },
      manualReview: false,
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.progress.eta).toEqual({ lowSeconds: 104, highSeconds: 156, sampleSize: 6 });
    expect(result.progress.etaUnavailableReason).toBeUndefined();
  });

  it("does not estimate across a future human review gate", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:00:10.000Z",
      nodes: [
        node("render", "渲染", "running", { startedAt: "2026-08-30T10:00:00.000Z" }),
        node("final-review", "人工终审", "pending"),
      ],
      historicalNodeDurations: { render: [20, 30, 40], "final-review": [5, 5, 5] },
      manualReview: true,
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.progress.eta).toBeUndefined();
    expect(result.progress.etaUnavailableReason).toBe("future_human_gate");
  });

  it("turns a provider failure into cause, impact, preserved work, and a safe recovery route", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:03:00.000Z",
      now: "2026-08-30T10:04:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("voice", "配音", "failed", {
          role: "声音导演",
          error: "HTTP 429 rate limit exceeded",
          executionReceipt: {
            providerId: "minimax-speech-v1",
            providerLabel: "MiniMax Speech",
            modelId: "speech-02-hd",
            transport: "http_api",
            billing: "metered",
            status: "failed",
            startedAt: "2026-08-30T10:02:00.000Z",
            finishedAt: "2026-08-30T10:03:00.000Z",
            meteredAttemptCount: 1,
          },
        }),
        node("render", "渲染", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "voice",
      category: "provider_capacity",
      retryable: true,
      savedNodeCount: 1,
      summary: "MiniMax Speech 当前请求过多，配音没有生成完成",
    });
    expect(result.failure?.impact).toContain("渲染尚未开始");
    expect(result.failure?.recoveryActions).toContain("稍后重试配音");
  });

  it("marks a preserved render as a usable partial result when a later review fails", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:05:00.000Z",
      now: "2026-08-30T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("technical-review", "机器质检", "failed", { error: "audio loudness check failed" }),
        node("final-review", "人工终审", "pending"),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });

    expect(result.resultAvailability).toMatchObject({
      kind: "draft_video",
      usable: false,
      label: "成片需修复",
    });
    expect(result.failure?.impact).toContain("成片已保留");
  });

  it("does not ask for billing reconciliation when a zero-attempt receipt proves rejection before submission", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:01:00.000Z",
      now: "2026-08-30T10:01:00.000Z",
      nodes: [
        node("assets", "画面", "failed", {
          role: "素材导演",
          outcomeUncertain: true,
          error: "The input text may contain sensitive information.",
          executionReceipt: {
            providerId: "seedream-image-v1",
            providerLabel: "Seedream 关键画面",
            modelId: "doubao-seedream-test",
            transport: "http_api",
            billing: "metered",
            status: "failed",
            actualCostCny: 0,
            actualCostSource: "configured_rate",
            meteredAttemptCount: 0,
            meteredFailedAttemptCount: 0,
            startedAt: "2026-08-30T10:00:00.000Z",
            finishedAt: "2026-08-30T10:01:00.000Z",
          },
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure?.recoveryActions).not.toContain("先到服务商控制台核对任务状态与账单");
    expect(result.failure).toMatchObject({
      category: "content_policy",
      summary: "Seedream 关键画面没有通过内容安全检查",
    });
    expect(result.failure?.recoveryActions).toContain("修改该节点的输入内容");
  });

  it("keeps an explicit human rejection separate from a system failure", () => {
    const result = buildRunObservability({
      status: "rejected",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:05:00.000Z",
      now: "2026-08-30T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("final-review", "人工终审", "rejected", { error: "开场节奏需要更紧" }),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });

    expect(result.failure).toBeUndefined();
    expect(result.resultAvailability).toMatchObject({ kind: "draft_video", usable: false });
  });
});
