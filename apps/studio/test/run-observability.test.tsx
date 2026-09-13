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

  it("explains a director contract failure with the affected scene and a concrete recovery", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:03:00.000Z",
      now: "2026-08-30T10:03:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("visual-direction", "导演方案", "failed", {
          role: "导演",
          error: "导演连续两次返回了无法使用的结果；本轮质量审计尚未消耗，可从已保存进度继续。shots[6].temporalBeats must contain at least two timed beats.",
        }),
        node("asset-candidates", "素材候选", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "visual-direction",
      summary: "导演方案中第 7 镜的时间描述没有通过结构校验",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual([
      "重试导演方案；已完成的脚本不会重新生成",
      "若同一镜头再次失败，在导演方案中检查该镜的动作与时长",
    ]);
  });

  it("surfaces the final director audit reason and routes an unfulfillable promise upstream", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:10:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("visual-direction", "导演方案", "failed", {
          role: "导演",
          error: "导演经过 2 轮修改后仍未通过独立审计。核心承诺要求同机位连续实验，但当前图库镜头无法兑现。",
        }),
        node("assets", "画面", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure?.summary).toContain("核心承诺要求同机位连续实验，但当前图库镜头无法兑现");
    expect(result.failure?.recoveryActions).toEqual([
      "调整视频承诺，确保现有画面能力能够真实兑现",
      "或准备连续实拍/自有素材后重新规划；脚本不会自动重跑",
    ]);
  });

  it("treats a repeated real-source availability stop as a manual gate instead of a retryable failure", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:16:00.000Z",
      nodes: [
        node("creative-planning", "创作规划", "failed", {
          role: "创作团队",
          error: "Joint creative planning stopped (needs_source): 连续两轮仍缺少可自动采用的真实图库素材，自动规划已停止。上传或实拍可追溯的真实素材；若不再主张实证，可改为非实证概念表达；也可以停止本次制作。AI 生成画面不能冒充真实实验证据。 不回退旧规划流程。",
        }),
        node("assets", "画面", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "creative-planning",
      retryable: false,
      summary: "真实素材目前不可得，自动规划已停下等待人工选择",
    });
    expect(result.failure?.recoveryActions).toEqual([
      "上传或实拍可追溯的真实素材后重新规划",
      "将内容改为不主张实验事实的概念表达后重新规划",
      "停止本次制作",
    ]);
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

  it("explains a source-asset visual gate failure as a review failure with an editable recovery", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("assets", "画面", "failed", { error: "源素材视觉预检服务暂时不可用。已保留生成结果，请重试素材步骤或更换视觉审片模型。" }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "assets",
      summary: "生成画面的视觉预检没有完成，已保留本轮画面结果",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toContain("在画面步骤切换视觉审片服务或模型后重试");
  });

  it("projects an automated source-asset rejection as a recoverable failure, not a human final decision", () => {
    const result = buildRunObservability({
      status: "rejected",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("assets", "画面", "succeeded"),
        node("asset-source-review", "生成画面预检", "rejected", {
          error: "源素材视觉预检未通过。镜头 2：主体动作与导演方案不一致。请调整导演方案后重新生成。",
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "asset-source-review",
      summary: "画面审查已完成并发现问题，已保留素材与修改建议",
      retryable: true,
    });
    expect(result.failure?.impact).toContain("配音尚未开始");
    expect(result.failure?.recoveryActions.join(" ")).not.toContain("切换视觉审片服务");
  });

  it("projects an in-node pilot rejection instead of hiding it behind the rejected run status", () => {
    const result = buildRunObservability({
      status: "rejected",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("assets", "画面", "rejected", {
          error: "镜头 2 试片未通过，已停止后续付费生成。已保留试片与审查报告。人物动作与旁白相反。",
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "assets",
      summary: "画面审查已完成并发现问题，已保留素材与修改建议",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual([
      "查看具体镜头的问题与修改建议",
      "先调整导演方案或替换已有素材；只有确需新生成时才重新报价",
    ]);
  });

  it("explains that an interrupted pilot review can continue without buying the generated shot again", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("assets", "画面", "failed", {
          error: "镜头 2 已生成，但试片审查暂未完成，后续付费生成已停止。重试时会复用该镜头并恢复审查。连接超时。",
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "assets",
      summary: "试片审查没有完成，已生成画面仍会保留",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual([
      "继续未完成的试片审查",
      "重试会复用已生成画面，不会重新购买成功素材",
    ]);
  });

  it("explains a partial final dual review as one remaining subscription review branch", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:05:00.000Z",
      now: "2026-08-30T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("visual-review", "视觉审片", "failed", {
          error: "最终双模型审片尚未完成：gpt-5.6-sol 暂时不可用。已完成分支保留，重试只继续未完成分支。",
        }),
        node("final-review", "人工终审", "pending"),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "visual-review",
      summary: "最终双模型审片只完成了一部分，已保留完成结果",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual(["重试未完成的审片模型分支"]);
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
