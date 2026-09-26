import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CodexBridgeError,
  CodexVisualReviewAgent,
  FallbackVisualReviewAgent,
  IndependentDualVisualReviewAgent,
  IndependentVisualReviewError,
  RoleAgentLoopError,
  VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
  VisualReviewFallbackError,
  assertCurrentVisualReviewContract,
  claimEvidenceSufficient,
  runRoleAgentLoop,
  validateAggregatedVisualReviewReport,
  validateVisualReviewReport,
  type CodexPreparedOperation,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexTaskRequestOptions,
  type VisualReviewAgent,
  type VisualReviewAgentInput,
  type VisualReviewMediaPayload,
  type VisualReviewReport,
  visualReviewBlocksContinuation,
} from "../src/index.js";

const media: VisualReviewMediaPayload = {
  durationMs: 6_000,
  frames: [
    { timecodeMs: 0, sha256: "a".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
    { timecodeMs: 3_000, sha256: "b".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
  ],
};

const sourceRangeMedia: VisualReviewMediaPayload = {
  durationMs: 6_000,
  frames: [
    { ...media.frames[0]!, sourceTimecodeMs: 4_000 },
    { ...media.frames[1]!, sourceTimecodeMs: 7_000 },
  ],
};

// 同一批镜头重新出帧后的证据：时长与镜位不变，帧内容与哈希已更新。
const regeneratedMedia: VisualReviewMediaPayload = {
  durationMs: 6_000,
  frames: [
    { ...media.frames[0]!, sha256: "c".repeat(64) },
    media.frames[1]!,
  ],
};

const report = {
  version: "video-factory/visual-review-v1",
  summary: "画面整体稳定，第二镜字幕略密。",
  scores: { composition: 84, continuity: 82, pacing: 78, legibility: 72, safety: 96 },
  findings: [{
    timecodeMs: 3_000,
    startTimecodeMs: 2_500,
    endTimecodeMs: 3_500,
    scenePosition: 1,
    targetNodeId: "assets",
    claimType: "static", evidenceStatus: "failed",
    evidenceFrameSha256: "b".repeat(64),
    nextAction: "rework_asset",
    category: "legibility",
    severity: "warning",
    description: "字幕行数偏多。",
    suggestion: "缩短为两行并延长停留时间。",
  }],
  confidence: 0.86,
  recommendation: "revise",
} as const;

/** report 是 as const 的只读夹具；需要传可变报告的用例用它的副本。 */
const mutableReport: VisualReviewReport = { ...report, findings: report.findings.map((finding) => ({ ...finding })) };

const passingAudit = {
  version: "video-factory/role-audit-v2",
  rubricVersion: "video-factory/role-quality-rubric-v1",
  assessments: [{
    targetPath: "",
    dimensions: [
      { dimension: "evidence", score: 92, evidence: "每条结论都能对应到已提供的抽帧。" },
      { dimension: "coverage", score: 92, evidence: "覆盖了本轮要求审看的镜头范围。" },
      { dimension: "consistency", score: 92, evidence: "评分与 findings 的严重度一致。" },
      { dimension: "actionability", score: 92, evidence: "下一步动作指向已有素材的具体返修。" },
    ],
  }],
  verdict: "pass",
  score: 92,
  summary: "报告忠于关键帧证据并清楚声明证据边界。",
  issues: [],
  repairInstructions: [],
} as const;

const advisoryAudit = {
  ...passingAudit,
  verdict: "repair",
  score: 76,
  assessments: passingAudit.assessments.map((assessment) => ({
    ...assessment,
    dimensions: assessment.dimensions.map((dimension) => ({ ...dimension, score: 76 })),
  })),
  summary: "建议补充第三镜的构图观察，当前报告和原评分保留供用户判断。",
  issues: [{
    severity: "advisory",
    criterion: "构图观察完整",
    evidence: "报告没有明确第三镜水平线的位置。",
    repairInstruction: "补充第三镜的水平线位置。",
  }],
  repairInstructions: ["补充第三镜的水平线位置。"],
};

describe("CodexVisualReviewAgent", () => {
  for (const reviewStage of ["source_assets", "rendered_video"] as const) {
    it(`returns the first ${reviewStage} report and audit without automatic report revision`, async () => {
      let stored: unknown;
      const calls: CodexTaskKind[] = [];
      const checkpoint = {
        key: `single-review-${reviewStage}`,
        load: async () => stored,
        save: async (value: unknown) => { stored = structuredClone(value); },
      };
      const agent = new CodexVisualReviewAgent({
        media: { prepare: async () => media },
        client: {
          runTask: async () => report,
          runTaskDetailed: async (kind) => {
            calls.push(kind);
            return { output: kind === "visual-review" ? report : advisoryAudit };
          },
        },
      });
      const input = { runRoot: "/run", reviewStage, agentLoopCheckpoint: checkpoint };
      const execution = await agent.reviewDetailed(input);
      assert.deepEqual(calls, ["visual-review", "role-audit"]);
      assert.deepEqual(execution.output, report, "不为凑分改写原始审片报告");
      assert.equal(execution.agentLoop?.status, "awaiting_user");
      assert.equal(execution.agentLoop?.iterations.length, 1);
      assert.equal(execution.agentLoop?.iterations[0]?.audit.score, 76);
      assert.equal(execution.agentLoop?.iterations[0]?.audit.issues[0]?.repairInstruction, "补充第三镜的水平线位置。");
      assert.equal(execution.agentLoop?.producerModelCallCount, 1);
      assert.equal(execution.agentLoop?.auditModelCallCount, 1);

      const replay = await agent.reviewDetailed(input);
      assert.deepEqual(replay.output, execution.output);
      assert.equal(replay.agentLoop?.status, "awaiting_user");
      assert.deepEqual(calls, ["visual-review", "role-audit"], "重启/重入复用已审结果，不重发模型");
    });
  }

  it("includes source timecodes in the image context and evidence snapshot identity", async () => {
    const calls: Array<{ kind: CodexTaskKind; payload: Record<string, unknown> }> = [];
    const subject = new CodexVisualReviewAgent({
      media: { prepare: async () => sourceRangeMedia },
      client: {
        runTask: async () => report,
        runTaskDetailed: async (kind, payload) => {
          calls.push({ kind, payload: payload as Record<string, unknown> });
          return { output: kind === "visual-review" ? report : passingAudit };
        },
      },
      maxReviewIterations: 1,
    });

    const first = await subject.reviewDetailed({ runRoot: "/run", preparedMedia: sourceRangeMedia });
    const second = await subject.reviewDetailed({
      runRoot: "/run",
      preparedMedia: {
        ...sourceRangeMedia,
        frames: sourceRangeMedia.frames.map((frame, index) => (
          index === 0 ? { ...frame, sourceTimecodeMs: 5_500 } : frame
        )),
      },
    });

    const auditCalls = calls.filter((call) => call.kind === "role-audit");
    assert.equal(
      (auditCalls[0]?.payload.images as Array<Record<string, unknown>> | undefined)?.[0]?.sourceTimecodeMs,
      4_000,
    );
    assert.notEqual(first.evidenceSnapshotId, second.evidenceSnapshotId);
  });
  it("runs final Codex and DeepSeek reviews independently over one immutable evidence snapshot", async () => {
    let prepareCalls = 0;
    const preparedInputs: VisualReviewMediaPayload[] = [];
    const calls: string[] = [];
    const reviewer = (id: string, modelId: string, output: VisualReviewReport): VisualReviewAgent => ({
      id,
      modelId,
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async (input) => {
        calls.push(id);
        assert.ok(input.preparedMedia);
        preparedInputs.push(input.preparedMedia);
        assert.equal(Object.hasOwn(input, "independentReviews"), false);
        return { output, executedProviderId: id, executedModelId: modelId };
      },
    });
    const hardFailure = {
      ...report,
      summary: "DeepSeek 确认画面存在水印。",
      scores: { ...report.scores, legibility: 35 },
      findings: [{ ...report.findings[0], severity: "critical" as const, description: "画面存在水印。" }],
      recommendation: "reject" as const,
    };
    const codexPass = {
      ...report,
      summary: "Codex 未发现阻断问题。",
      scores: { composition: 92, continuity: 90, pacing: 88, legibility: 91, safety: 96 },
      findings: [],
      confidence: 0.92,
      recommendation: "approve" as const,
    };
    const subject = new IndependentDualVisualReviewAgent({
      primary: reviewer("deepseek-visual-review-v1", "deepseek-flash", hardFailure),
      secondary: reviewer("codex-visual-review-v1", "gpt-5.6-sol", codexPass),
      media: {
        prepare: async () => {
          prepareCalls += 1;
          return media;
        },
      },
    });

    const execution = await subject.reviewDetailed({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      reviewStage: "rendered_video",
    });

    assert.equal(prepareCalls, 1);
    assert.deepEqual(new Set(calls), new Set(["deepseek-visual-review-v1", "codex-visual-review-v1"]));
    // BG-08：两分支收到共同快照的独立深拷贝（同内容、不同引用——分支改写互不可见）。
    assert.deepEqual(preparedInputs[0], preparedInputs[1]);
    assert.notEqual(preparedInputs[0], preparedInputs[1]);
    assert.equal(execution.output.recommendation, "reject");
    assert.equal(execution.output.scores.legibility, 35);
    assert.equal(execution.output.findings.some((finding) => finding.description === "画面存在水印。"), true);
    assert.deepEqual(execution.independentReviews?.map(({ providerId, modelId }) => ({ providerId, modelId })), [
      { providerId: "deepseek-visual-review-v1", modelId: "deepseek-flash" },
      { providerId: "codex-visual-review-v1", modelId: "gpt-5.6-sol" },
    ]);
  });

  it("reviews a paid pilot with both independent models instead of one", async () => {
    const calls: string[] = [];
    const reviewer = (id: string, modelId: string, output: VisualReviewReport): VisualReviewAgent => ({
      id,
      modelId,
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async (input) => {
        calls.push(id);
        assert.equal(input.reviewStage, "source_assets");
        assert.equal(Object.hasOwn(input, "preparedMedia"), false);
        return { output, executedProviderId: id, executedModelId: modelId };
      },
    });
    const lenientPilot: VisualReviewReport = {
      ...mutableReport,
      summary: "Codex 认为试片可用。",
      scores: { composition: 92, continuity: 90, pacing: 88, legibility: 91, safety: 96 },
      findings: [],
      confidence: 0.93,
      recommendation: "approve",
    };
    const strictPilot: VisualReviewReport = {
      ...mutableReport,
      summary: "DeepSeek 认为试片灯位不连续。",
      scores: { ...mutableReport.scores, continuity: 60 },
    };
    const subject = new IndependentDualVisualReviewAgent({
      primary: reviewer("deepseek-visual-review-v1", "deepseek-flash", lenientPilot),
      secondary: reviewer("codex-visual-review-v1", "gpt-5.6-sol", strictPilot),
      media: { prepare: async () => { throw new Error("A pilot review has no sampled sequence to prepare."); } },
    });

    const execution = await subject.reviewDetailed({
      runRoot: "/run",
      assetPlanPath: "/run/assets.json",
      reviewStage: "source_assets",
      scenePositions: [3],
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(new Set(calls), new Set(["deepseek-visual-review-v1", "codex-visual-review-v1"]));
    // 闸门取保守侧：一个模型说不可以用，试片就不为后续付费放行。
    assert.equal(execution.output.scores.continuity, 60);
    assert.equal(visualReviewBlocksContinuation(execution.output), true);
    assert.equal(execution.output.findings.some((finding) => finding.description === "字幕行数偏多。"), true);
    assert.deepEqual(execution.independentReviews?.map(({ providerId, modelId }) => ({ providerId, modelId })), [
      { providerId: "deepseek-visual-review-v1", modelId: "deepseek-flash" },
      { providerId: "codex-visual-review-v1", modelId: "gpt-5.6-sol" },
    ]);
  });

  it("refuses to clear a paid pilot when only one of the two branches reported", async () => {
    const subject = new IndependentDualVisualReviewAgent({
      primary: {
        id: "deepseek-visual-review-v1",
        modelId: "deepseek-flash",
        review: async () => mutableReport,
      },
      secondary: {
        id: "codex-visual-review-v1",
        modelId: "gpt-5.6-sol",
        review: async () => { throw new Error("Codex 审片暂不可用。"); },
      },
      media: { prepare: async () => media },
    });

    await assert.rejects(
      () => subject.reviewDetailed({ runRoot: "/run", reviewStage: "source_assets", scenePositions: [3] }),
      (error: unknown) => {
        assert.ok(error instanceof IndependentVisualReviewError);
        // 失败分支要指名道姓，且已跑完的那一支必须带着结果留下——重试时它不该被再跑一遍。
        assert.equal(error.completedReviews.length, 1);
        assert.equal(error.completedReviews[0]?.modelId, "deepseek-flash");
        assert.equal(error.failures.length, 1);
        assert.equal(error.failures[0]?.modelId, "gpt-5.6-sol");
        assert.match(String((error.failures[0]?.error as Error).message), /Codex 审片暂不可用/);
        return /试片双模型复审尚未完成.*gpt-5\.6-sol/.test(error.message);
      },
    );
  });

  it("refuses a pilot cleared by two nominal branches of the same actual model", async () => {
    // 两个分支各自按自己的名义身份回话，但落到同一个实际模型。
    const sameIdentity = new IndependentDualVisualReviewAgent({
      primary: {
        id: "deepseek-visual-review-v1",
        modelId: "deepseek-flash",
        review: async () => mutableReport,
        reviewDetailed: async () => ({ output: mutableReport, executedProviderId: "deepseek-visual-review-v1", executedModelId: "deepseek-flash" }),
      },
      secondary: {
        id: "codex-visual-review-v1",
        modelId: "gpt-5.6-sol",
        review: async () => mutableReport,
        reviewDetailed: async () => ({ output: mutableReport, executedProviderId: "deepseek-visual-review-v1", executedModelId: "deepseek-flash" }),
      },
      media: { prepare: async () => media },
    });

    await assert.rejects(
      () => sameIdentity.reviewDetailed({ runRoot: "/run", reviewStage: "source_assets", scenePositions: [3] }),
      /不能作为独立复审/,
    );
  });

  it("preserves more than fifty distinct findings across the two independent reviews", async () => {
    const findingsFor = (prefix: string) => Array.from({ length: 26 }, (_, index) => ({
      ...report.findings[0],
      claimType: "static" as const, evidenceStatus: "satisfied" as const,
      nextAction: "none" as const,
      severity: "info" as const,
      description: `${prefix} 独立发现 ${index + 1}`,
      suggestion: `${prefix} 建议 ${index + 1}`,
    }));
    const reviewer = (id: string, modelId: string, prefix: string): VisualReviewAgent => ({
      id,
      modelId,
      review: async () => ({
        ...report,
        scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 95 },
        findings: findingsFor(prefix),
        recommendation: "approve",
      }),
    });
    const subject = new IndependentDualVisualReviewAgent({
      primary: reviewer("deepseek-visual-review-v1", "deepseek-flash", "DeepSeek"),
      secondary: reviewer("codex-visual-review-v1", "gpt-5.6-sol", "Codex"),
      media: { prepare: async () => media },
    });

    const execution = await subject.reviewDetailed({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      reviewStage: "rendered_video",
    });

    assert.equal(execution.output.findings.length, 52);
    assert.equal(execution.output.findings.filter((finding) => finding.reviewSources?.length === 1).length, 52);
  });

  it("merges the same finding from both reviewers and keeps the strongest severity and both sources", async () => {
    const reviewer = (id: string, modelId: string, severity: "warning" | "critical"): VisualReviewAgent => ({
      id,
      modelId,
      review: async () => ({
        ...report,
        scores: { ...report.scores, legibility: severity === "critical" ? 35 : 68 },
        findings: [{ ...report.findings[0], severity }],
        recommendation: severity === "critical" ? "reject" : "revise",
      }),
    });
    const subject = new IndependentDualVisualReviewAgent({
      primary: reviewer("deepseek-visual-review-v1", "deepseek-flash", "warning"),
      secondary: reviewer("codex-visual-review-v1", "gpt-5.6-sol", "critical"),
      media: { prepare: async () => media },
    });

    const execution = await subject.reviewDetailed({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      reviewStage: "rendered_video",
    });

    assert.equal(execution.output.findings.length, 1);
    assert.equal(execution.output.findings[0]?.severity, "critical");
    assert.deepEqual(execution.output.findings[0]?.reviewSources, [
      { providerId: "deepseek-visual-review-v1", modelId: "deepseek-flash" },
      { providerId: "codex-visual-review-v1", modelId: "gpt-5.6-sol" },
    ]);
  });

  it("retries only the failed final-review branch after preserving the completed model result", async () => {
    const calls = { deepseek: 0, codex: 0 };
    const stored = new Map<string, unknown>();
    const cleanReport: VisualReviewReport = {
      ...report,
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 95 },
      findings: [],
      recommendation: "approve",
    };
    const subject = new IndependentDualVisualReviewAgent({
      primary: {
        id: "deepseek-visual-review-v1",
        modelId: "deepseek-flash",
        review: async () => {
          calls.deepseek += 1;
          return cleanReport;
        },
      },
      secondary: {
        id: "codex-visual-review-v1",
        modelId: "gpt-5.6-sol",
        review: async () => {
          calls.codex += 1;
          if (calls.codex === 1) throw new Error("Codex review temporarily unavailable");
          return cleanReport;
        },
      },
      media: { prepare: async () => media },
    });
    const input: VisualReviewAgentInput = {
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      reviewStage: "rendered_video",
      independentReviewCheckpointForModel: (modelId) => ({
        key: modelId,
        load: async () => stored.get(modelId),
        save: async (value) => { stored.set(modelId, structuredClone(value)); },
      }),
    };

    await assert.rejects(
      () => subject.reviewDetailed(input),
      (error: unknown) => {
        assert.ok(error instanceof IndependentVisualReviewError);
        assert.deepEqual(error.completedReviews.map(({ providerId, modelId }) => ({ providerId, modelId })), [{
          providerId: "deepseek-visual-review-v1",
          modelId: "deepseek-flash",
        }]);
        assert.deepEqual(error.failures.map(({ providerId, modelId }) => ({ providerId, modelId })), [{
          providerId: "codex-visual-review-v1",
          modelId: "gpt-5.6-sol",
        }]);
        assert.match(error.message, /gpt-5\.6-sol 暂时不可用/);
        return true;
      },
    );
    const recovered = await subject.reviewDetailed(input);

    assert.deepEqual(calls, { deepseek: 1, codex: 2 });
    assert.equal(recovered.independentReviews?.length, 2);
    assert.equal(recovered.output.recommendation, "approve");
  });

  it("rejects a finding outside the requested pilot before completing the review", async () => {
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => media },
      client: { runTask: async () => report },
    });
    await assert.rejects(() => agent.review({ runRoot: "/run", scenePositions: [3] }), /未检查镜头/);
  });

  it("rejects a stale selected model before preprocessing media for a single configured agent", async () => {
    let mediaCalls = 0;
    const agent = new CodexVisualReviewAgent({
      modelId: "gpt-current",
      media: { prepare: async () => {
        mediaCalls += 1;
        return media;
      } },
      client: { runTask: async () => report },
    });

    await assert.rejects(
      () => agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run", selectedModelId: "gpt-offline" }),
      /is not available for visual review/,
    );
    assert.equal(mediaCalls, 0);
  });

  it("reviews frames against the editable script, director intent, and render timeline", async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), "video-factory-review-context-"));
    const scriptPath = path.join(runRoot, "script.json");
    const directorPlanPath = path.join(runRoot, "director_plan.json");
    const renderManifestPath = path.join(runRoot, "render_manifest.json");
    await writeFile(scriptPath, JSON.stringify({
      viewerPromise: "看见窗边光线变化",
      scenes: [{ position: 1, visible_action: "手拉开窗帘", success_criteria: ["杯沿变亮"] }],
    }));
    await writeFile(directorPlanPath, JSON.stringify({
      visualBible: { motif: "杯沿高光" },
      shots: [{ scenePosition: 1, temporalBeats: ["[0s-2s] 拉开窗帘"], successCriteria: ["杯沿变亮"] }],
    }));
    await writeFile(renderManifestPath, JSON.stringify({ duration_target: 6, slides: [{ scene_position: 1, duration: 6 }] }));
    let payload: unknown;
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => media },
      client: { runTask: async (_kind, input) => {
        payload = input;
        return report;
      } },
    });

    await agent.review({
      videoPath: path.join(runRoot, "final.mp4"),
      runRoot,
      scriptPath,
      directorPlanPath,
      renderManifestPath,
    });

    const reviewContext = (payload as { reviewContext: Record<string, unknown> }).reviewContext;
    assert.equal((reviewContext.script as Record<string, unknown>).viewerPromise, "看见窗边光线变化");
    assert.deepEqual((reviewContext.directorPlan as Record<string, unknown>).shots, [{ scenePosition: 1, temporalBeats: ["[0s-2s] 拉开窗帘"], successCriteria: ["杯沿变亮"] }]);
    assert.deepEqual((reviewContext.renderManifest as Record<string, unknown>).slides, [{ scene_position: 1, duration: 6 }]);
  });

  it("preserves prepared source identity while authoritative run fields override stale namesakes", async () => {
    let payload: unknown;
    const sourceAwareMedia: VisualReviewMediaPayload = {
      ...media,
      reviewContext: {
        reviewStage: "stale-stage",
        pilotScenePositions: [99],
        sourceIdentity: [{ scenePosition: 1, providerId: "pexels-stock-v1", assetId: "asset-1", license: "Pexels" }],
      },
    };
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => sourceAwareMedia },
      client: { runTask: async (_kind, input) => {
        payload = input;
        return report;
      } },
    });

    await agent.review({ reviewStage: "source_assets", scenePositions: [1], runRoot: "/run" });

    const reviewContext = (payload as { reviewContext: Record<string, unknown> }).reviewContext;
    assert.equal(reviewContext.reviewStage, "source_assets");
    assert.deepEqual(reviewContext.pilotScenePositions, [1]);
    assert.deepEqual(reviewContext.sourceIdentity, [{
      scenePosition: 1,
      providerId: "pexels-stock-v1",
      assetId: "asset-1",
      license: "Pexels",
    }]);
  });

  it("describes dense pilot frames as ordered sequence evidence instead of sparse midpoints", async () => {
    let payload: unknown;
    const sequenceMedia: VisualReviewMediaPayload = {
      durationMs: 5_000,
      frames: [
        { timecodeMs: 100, sha256: "a".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 6, phase: "opening" },
        { timecodeMs: 2_500, sha256: "b".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 6, phase: "middle" },
        { timecodeMs: 4_900, sha256: "c".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 6, phase: "closing" },
      ],
      sampling: {
        mode: "scene_sequence",
        sceneCount: 8,
        coveredScenePositions: [6],
        missingScenePositions: [1, 2, 3, 4, 5, 7, 8],
      },
    };
    const approved = {
      ...report,
      summary: "高密度时间序列支持当前试片的可见状态推进。",
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 95 },
      findings: [],
      recommendation: "approve" as const,
    };
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => sequenceMedia },
      client: { runTask: async (_kind, input) => {
        payload = input;
        return approved;
      } },
    });

    await agent.review({ reviewStage: "source_assets", scenePositions: [6], runRoot: "/run" });

    const reviewContext = (payload as { reviewContext: Record<string, unknown> }).reviewContext;
    const sampling = reviewContext.sampling as Record<string, unknown>;
    assert.equal(sampling.mode, "scene_sequence");
    assert.deepEqual(sampling.phases, ["opening", "middle", "closing"]);
    assert.match(String(sampling.evidenceBoundary), /Dense ordered samples.*approximate hold timing/);
    assert.deepEqual(reviewContext.renderConform, {
      policy: "scale_to_fill_center_crop",
      outputAspectRatio: "9:16",
      reviewRule: "A minor source aspect-ratio difference is normalized before render and is not itself an asset defect. Only require asset rework when the deterministic center crop would remove a required subject, action, or text-safe area.",
    });
  });

  it("identifies director-approved editorial cards while keeping undeclared text blocked and private paths hidden", async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), "video-factory-source-review-context-"));
    const assetPlanPath = path.join(runRoot, "asset_plan.json");
    await writeFile(assetPlanPath, JSON.stringify({
      scene_assets: [{
        scene_position: 1,
        provider: "seedream",
        asset_id: "asset-1",
        media_type: "image",
        duration: 4,
        query: "cold drink condensation",
        preferred_provider_id: "local-editorial-v1",
        director_shot: {
          scenePosition: 1,
          preferredProviderId: "local-editorial-v1",
          deliveryType: "editorial_card",
          internalPrompt: "must not leak",
        },
        local_path: "/private/secret/generated.png",
        source_url: "https://signed.example/secret-token",
      }, {
        scene_position: 2,
        provider: "local",
        asset_id: "undeclared-text-card",
        media_type: "image",
        duration: 4,
        query: "local text card without director approval",
      }],
    }));
    let payload: unknown;
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => media },
      client: { runTask: async (_kind, input) => {
        payload = input;
        return report;
      } },
    });

    await agent.review({ assetPlanPath, reviewStage: "source_assets", scenePositions: [1], runRoot });

    const serialized = JSON.stringify(payload);
    const reviewContext = (payload as { reviewContext: Record<string, unknown> }).reviewContext;
    assert.equal(reviewContext.reviewStage, "source_assets");
    assert.deepEqual(reviewContext.pilotScenePositions, [1]);
    assert.match(serialized, /cold drink condensation/);
    assert.match(serialized, /editorial_card/);
    assert.match(serialized, /undeclared-text-card/);
    assert.doesNotMatch(serialized, /private\/secret|secret-token|signed\.example|must not leak/);
  });

  it("sends only the bounded preprocessed frame payload and validates the report", async () => {
    const calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];
    const mediaInputs: unknown[] = [];
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async (input) => {
        mediaInputs.push(input);
        return media;
      } },
      client: { runTask: async (kind, payload) => {
        calls.push({ kind, payload });
        return report;
      } },
    });

    const result = await agent.review({ videoPath: "/run/final.mp4", runRoot: "/run" });

    assert.deepEqual(result, report);
    assert.deepEqual(calls, [{ kind: "visual-review", payload: media }]);
    assert.deepEqual(mediaInputs, [{ videoPath: "/run/final.mp4", runRoot: "/run" }]);
    assert.equal(agent.id, "codex-visual-review-v1");
    assert.equal(agent.modelId, "codex-default");
  });

  it("uses a stable broker request id for an interrupted visual review operation", async () => {
    const requestIds: Array<string | undefined> = [];
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => media },
      client: {
        runTask: async () => report,
        runTaskDetailed: async (kind, _payload, requestId) => {
          requestIds.push(requestId);
          return { output: kind === "role-audit" ? passingAudit : report };
        },
      },
    });

    const first = await agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run", requestId: "persisted-operation" });
    const second = await agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run", requestId: "persisted-operation" });

    assert.match(first.requestId ?? "", /^visual-[a-f0-9]{64}$/);
    assert.equal(first.requestId, second.requestId);
    assert.equal(requestIds.length, 4);
    assert.equal(requestIds[0], requestIds[2]);
    assert.equal(requestIds[1], requestIds[3]);
    assert.notEqual(requestIds[0], requestIds[1]);
  });

  it("preserves explicitly requested legacy report-repair rounds", async () => {
    const calls: Array<{ kind: CodexTaskKind; payload: Record<string, unknown> }> = [];
    let producerCalls = 0;
    let auditCalls = 0;
    const repairedReport = {
      ...report,
      summary: "画面证据与评分一致，字幕密度问题定位明确。",
    };
    const agent = new CodexVisualReviewAgent({
      maxReviewIterations: 3,
      media: { prepare: async () => media },
      client: {
        runTask: async () => report,
        runTaskDetailed: async (kind, payload) => {
          calls.push({ kind, payload: payload as Record<string, unknown> });
          if (kind === "visual-review") {
            producerCalls += 1;
            return { output: producerCalls === 1 ? report : repairedReport };
          }
          auditCalls += 1;
          return { output: auditCalls === 1 ? {
            version: "video-factory/role-audit-v2",
            rubricVersion: "video-factory/role-quality-rubric-v1",
            assessments: [{
              targetPath: "",
              dimensions: [
                { dimension: "evidence", score: 72, evidence: "摘要未把评分回溯到抽帧证据。" },
                { dimension: "coverage", score: 72, evidence: "评分依据的镜头范围未说明。" },
                { dimension: "consistency", score: 72, evidence: "摘要与 findings 的严重度相互矛盾。" },
                { dimension: "actionability", score: 72, evidence: "返修方向没有落到具体镜头。" },
              ],
            }],
            verdict: "repair",
            score: 72,
            summary: "摘要没有解释评分与问题的关系。",
            issues: [{
              severity: "blocking",
              criterion: "评分与 findings 自洽",
              evidence: "摘要只说整体稳定，没有说明可读性 72 分的原因。",
              repairInstruction: "在摘要中明确字幕密度问题及其对应评分。",
            }],
            repairInstructions: ["在摘要中明确字幕密度问题及其对应评分。"],
          } : passingAudit };
        },
      },
    });

    const execution = await agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" });

    assert.equal(execution.agentLoop?.status, "passed");
    assert.equal(execution.agentLoop?.iterations.length, 2);
    assert.deepEqual(calls.map((call) => call.kind), ["visual-review", "role-audit", "visual-review", "role-audit"]);
    assert.equal(calls[2]?.payload.revision !== undefined, true);
    assert.match((calls[1]?.payload.criteria as string[]).join("\n"), /核心主体、物体或动作对象.*必须判定返修/);
    assert.match((calls[1]?.payload.criteria as string[]).join("\n"), /真实来源原生文字.*生成伪标签\/乱码\/水印\/内部术语/);
    assert.match(
      (calls[1]?.payload.criteria as string[]).join("\n"),
      /同一人物、物件或空间.*Provider.*无法保证.*creative-planning.*planningStageId.*replan_upstream/,
    );
    assert.match(
      (calls[1]?.payload.criteria as string[]).join("\n"),
      /约、建议或参考时间.*不是硬下限.*明确的最迟、至少、不得或用户锁定要求/,
    );
    assert.match(
      JSON.stringify(calls[1]?.payload.context),
      /上游免责声明.*不能把不可执行方案变成可执行方案.*不得.*assets.*重复付费/,
    );
    assert.deepEqual(execution.output, repairedReport);
  });

  it("uses the OpenAI audit client when the visual producer only accepts DeepSeek review tasks", async () => {
    const producerKinds: CodexTaskKind[] = [];
    const auditKinds: CodexTaskKind[] = [];
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => media },
      client: {
        runTask: async () => report,
        runTaskDetailed: async (kind) => {
          producerKinds.push(kind);
          return { output: report };
        },
      },
      auditClient: {
        runTaskDetailed: async (kind) => {
          auditKinds.push(kind);
          return { output: passingAudit };
        },
      },
    });

    const execution = await agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" });

    assert.deepEqual(producerKinds, ["visual-review"]);
    assert.deepEqual(auditKinds, ["role-audit"]);
    assert.equal(execution.agentLoop?.iterations.length, 1);
  });

  it("keeps stateless DeepSeek visual-review calls out of Codex sessions while preserving full repair context", async () => {
    const producerSessions: unknown[] = [];
    const producerPayloads: Array<Record<string, unknown>> = [];
    const auditSessions: unknown[] = [];
    let producerCalls = 0;
    let auditCalls = 0;
    const repairedReport = { ...report, summary: "修订后的视觉审片报告忠于抽样证据。" };
    const agent = new CodexVisualReviewAgent({
      maxReviewIterations: 3,
      media: { prepare: async () => media },
      producerSessionMode: "stateless",
      client: {
        runTask: async () => report,
        runTaskDetailed: async (_kind, payload, _requestId, session) => {
          producerSessions.push(session);
          producerPayloads.push(payload as Record<string, unknown>);
          producerCalls += 1;
          return { output: producerCalls === 1 ? report : repairedReport };
        },
      },
      auditClient: {
        runTaskDetailed: async (_kind, _payload, _requestId, session) => {
          auditSessions.push(structuredClone(session));
          auditCalls += 1;
          return {
            output: auditCalls === 1 ? {
              version: "video-factory/role-audit-v2",
              rubricVersion: "video-factory/role-quality-rubric-v1",
              assessments: [{
                targetPath: "",
                dimensions: [
                  { dimension: "evidence", score: 74, evidence: "摘要把抽样帧观察写成了连续事实。" },
                  { dimension: "coverage", score: 74, evidence: "抽样边界与报告覆盖范围不符。" },
                  { dimension: "consistency", score: 74, evidence: "证据边界声明与结论强度不一致。" },
                  { dimension: "actionability", score: 74, evidence: "返修要求没有限定结论范围。" },
                ],
              }],
              verdict: "repair",
              score: 74,
              summary: "摘要没有说明抽样证据边界。",
              issues: [{
                severity: "blocking",
                criterion: "明确证据边界",
                evidence: "摘要把关键帧观察写成了连续运动事实。",
                repairInstruction: "将结论限定为抽样帧可见范围。",
              }],
              repairInstructions: ["将结论限定为抽样帧可见范围。"],
            } : passingAudit,
            ...(session ? { session: { key: session.key, handle: `vfs_${"a".repeat(32)}` } } : {}),
          };
        },
      },
    });

    const execution = await agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" });

    assert.deepEqual(producerSessions, [undefined, undefined]);
    assert.equal((producerPayloads[1]?.revision as { mode?: string }).mode, "repair-bootstrap");
    assert.deepEqual(auditSessions, [undefined, undefined]);
    assert.deepEqual(execution.output, repairedReport);
    assert.equal(execution.agentLoop?.producerModelCallCount, 2);
    assert.equal(execution.agentLoop?.auditModelCallCount, 2);
  });

  it("never exceeds the configured paid visual-producer call budget", async () => {
    let producerCalls = 0;
    const agent = new CodexVisualReviewAgent({
      maxReviewIterations: 3,
      media: { prepare: async () => media },
      maxProducerCalls: 1,
      client: {
        runTask: async () => report,
        runTaskDetailed: async () => {
          producerCalls += 1;
          return { output: report };
        },
      },
      auditClient: {
        runTaskDetailed: async () => ({
          output: {
            version: "video-factory/role-audit-v2",
            rubricVersion: "video-factory/role-quality-rubric-v1",
            assessments: [{
              targetPath: "",
              dimensions: [
                { dimension: "evidence", score: 70, evidence: "摘要越过了关键帧证据能支撑的范围。" },
                { dimension: "coverage", score: 70, evidence: "未说明结论覆盖到哪些镜头。" },
                { dimension: "consistency", score: 70, evidence: "结论强度与 findings 不一致。" },
                { dimension: "actionability", score: 70, evidence: "返修指令无法直接执行。" },
              ],
            }],
            verdict: "repair",
            score: 70,
            summary: "需要再修一轮。",
            issues: [{
              severity: "blocking",
              criterion: "结论与证据一致",
              evidence: "摘要越过了关键帧证据边界。",
              repairInstruction: "收窄摘要结论。",
            }],
            repairInstructions: ["收窄摘要结论。"],
          },
        }),
      },
    });

    await assert.rejects(
      () => agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" }),
      /内容生成调用已达到本轮上限 1 次/,
    );
    assert.equal(producerCalls, 1);
  });

  it("forwards the render manifest to media preprocessing", async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), "video-factory-review-forward-"));
    const renderManifestPath = path.join(runRoot, "render", "render_manifest.json");
    await mkdir(path.dirname(renderManifestPath), { recursive: true });
    await writeFile(renderManifestPath, JSON.stringify({ slides: [{ duration: 6 }] }));
    const mediaInputs: unknown[] = [];
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async (input) => {
        mediaInputs.push(input);
        return media;
      } },
      client: { runTask: async () => report },
    });

    await agent.review({
      videoPath: path.join(runRoot, "final.mp4"),
      runRoot,
      renderManifestPath,
    });

    assert.deepEqual(mediaInputs, [{
      videoPath: path.join(runRoot, "final.mp4"),
      runRoot,
      renderManifestPath,
    }]);
  });

  it("forwards the executable plan to source-asset media preprocessing", async () => {
    const runRoot = await mkdtemp(path.join(tmpdir(), "video-factory-source-review-forward-"));
    const assetPlanPath = path.join(runRoot, "assets", "asset_plan.json");
    const executablePlanPath = path.join(runRoot, "production-preflight", "executable_plan.json");
    await mkdir(path.dirname(assetPlanPath), { recursive: true });
    await mkdir(path.dirname(executablePlanPath), { recursive: true });
    await writeFile(assetPlanPath, JSON.stringify({ scene_assets: [] }));
    await writeFile(executablePlanPath, JSON.stringify({ version: "video-factory/executable-plan-v1" }));
    const mediaInputs: VisualReviewAgentInput[] = [];
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async (input) => {
        mediaInputs.push(input);
        return media;
      } },
      client: { runTask: async () => report },
    });
    const input: VisualReviewAgentInput = {
      assetPlanPath,
      executablePlanPath,
      reviewStage: "source_assets",
      runRoot,
    };

    await agent.review(input);

    assert.deepEqual(mediaInputs, [input]);
  });

  it("returns the inspected media duration with detailed review evidence", async () => {
    const agent = new CodexVisualReviewAgent({
      media: { prepare: async () => media },
      client: { runTask: async () => report },
    });

    const execution = await agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" });

    assert.equal(execution.inspectedDurationMs, media.durationMs);
  });

  it("records an explicitly configured provider and model identity", () => {
    const agent = new CodexVisualReviewAgent({
      providerId: "future-visual-review-v1",
      modelId: "future-vision-model",
      media: { prepare: async () => media },
      client: { runTask: async () => report },
    });

    assert.equal(agent.id, "future-visual-review-v1");
    assert.equal(agent.modelId, "future-vision-model");
  });

  it("uses an isolated backup model only after an eligible provider failure", async () => {
    const primaryInputs: VisualReviewAgentInput[] = [];
    const backupInputs: VisualReviewAgentInput[] = [];
    const primary: VisualReviewAgent = {
      id: "deepseek-visual-review-v1",
      modelId: "deepseek-flash",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async (input) => {
        primaryInputs.push(input);
        // 只有确证发生在受理之前（stage=not_accepted 的 503 队列拒绝）才允许切换候选；
        // stage=uncertain 的 503 可能在 durable broker 侧仍在执行，禁止启动 backup。
        throw new CodexBridgeError("Codex bridge returned HTTP 503.", true, "not_accepted", 503);
      },
    };
    const backup: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "gpt-backup",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async (input) => {
        backupInputs.push(input);
        return {
          output: validateVisualReviewReport(report, media.durationMs),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          trace: {
            taskKind: "visual-review",
            promptVersion: "visual-review-test-v1",
            prompt: "bounded test prompt",
            providerId: "openai",
            modelId: "gpt-backup",
          },
        };
      },
    };
    const checkpoints = new Map<string, unknown>();
    const checkpointFactory = (modelId: string) => {
      const checkpoint = { key: `checkpoint-${modelId}`, load: async () => undefined, save: async () => undefined };
      checkpoints.set(modelId, checkpoint);
      return checkpoint;
    };
    const agent = new FallbackVisualReviewAgent({
      primary,
      primaryProviderId: "deepseek",
      backups: [{ agent: backup, label: "Codex 视觉审片", providerId: "openai" }],
    });

    const execution = await agent.reviewDetailed({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      requestId: "node-operation",
      agentLoopCheckpointForModel: checkpointFactory,
    });

    assert.equal(primaryInputs.length, 1);
    assert.equal(backupInputs.length, 1);
    assert.equal(primaryInputs[0]?.agentLoopCheckpoint, checkpoints.get("deepseek-flash"));
    assert.equal(backupInputs[0]?.agentLoopCheckpoint, checkpoints.get("gpt-backup"));
    assert.match(String(backupInputs[0]?.requestId), /^backup-[a-f0-9]{64}$/);
    assert.notEqual(backupInputs[0]?.requestId, primaryInputs[0]?.requestId);
    assert.equal(execution.executedProviderId, "openai");
    assert.equal(execution.executedProviderLabel, "Codex 视觉审片");
    assert.equal(execution.executedModelId, "gpt-backup");
    assert.equal(execution.fallbackFromProviderId, "deepseek");
    assert.deepEqual(execution.attemptedModelIds, ["deepseek-flash", "gpt-backup"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts, [{
      modelId: "deepseek-flash",
      providerId: "deepseek",
      outcome: "failed",
      failureStage: "not_accepted",
      failureReason: "服务端错误（HTTP 503）",
    }, {
      modelId: "gpt-backup",
      providerId: "openai",
      outcome: "succeeded",
    }]);
  });

  it("rethrows an uncertain provider failure without ever invoking the visual backup", async () => {
    let backupCalls = 0;
    // stage=uncertain 表示原请求可能已被 durable broker 受理并仍在执行；
    // 此时启动 backup 会造成原任务与 backup 双跑，必须原样上抛且不得伪造 backup 成功。
    const uncertainFailure = new CodexBridgeError(
      "Codex bridge returned HTTP 503. socket /private/run/deepseek.sock detail secret-primary",
      false,
      "uncertain",
      503,
    );
    const primary: VisualReviewAgent = {
      id: "deepseek-visual-review-v1",
      modelId: "deepseek-flash",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async () => { throw uncertainFailure; },
    };
    const backup: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "gpt-backup",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async () => {
        backupCalls += 1;
        return {
          output: validateVisualReviewReport(report, media.durationMs),
          trace: {
            taskKind: "visual-review",
            promptVersion: "visual-review-test-v1",
            prompt: "bounded test prompt",
            providerId: "openai",
            modelId: "gpt-backup",
          },
        };
      },
    };
    const agent = new FallbackVisualReviewAgent({
      primary,
      primaryProviderId: "deepseek",
      backups: [{ agent: backup, label: "Codex 视觉审片", providerId: "openai" }],
    });

    await assert.rejects(
      () => agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run", requestId: "node-operation" }),
      (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error, uncertainFailure);
        assert.equal(error.stage, "uncertain");
        assert.equal(error.statusCode, 503);
        // C5/CG-08：uncertain 结果的文案必须引导核对原请求，不得建议重试或换模型。
        assert.equal(error.creatorMessage, "与模型服务的连接中断，结果未知：这次请求可能已经被模型受理。当前进度已保留，请先核对原有任务的结果，不要重新发起同样的请求。");
        assert.doesNotMatch(error.creatorMessage, /secret-primary|deepseek.sock|\/private\/run/);
        return true;
      },
    );
    assert.equal(backupCalls, 0);
  });

  it("keeps a produced visual report and switches only the independent audit after a transient failure", async () => {
    let primaryProducerCalls = 0;
    let primaryAuditCalls = 0;
    let backupProducerCalls = 0;
    let backupAuditCalls = 0;
    const candidateInputs: VisualReviewAgentInput[] = [];
    const checkpointState = new Map<string, unknown>();
    const checkpointFactory = (modelId: string) => ({
      key: `checkpoint-${modelId}`,
      load: async () => checkpointState.get(modelId),
      save: async (value: unknown) => { checkpointState.set(modelId, structuredClone(value)); },
    });
    const primary: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "gpt-primary",
      review: async () => validateVisualReviewReport(report, media.durationMs),
      reviewDetailed: async (input) => {
        candidateInputs.push(input);
        return runRoleAgentLoop({
          role: "视觉审片员",
          contractVersion: "visual-review-test-v1",
          criteria: ["忠于画面证据"],
          maxIterations: 1,
          produce: async () => {
            primaryProducerCalls += 1;
            return {
              output: report,
              trace: {
                taskKind: "visual-review",
                promptVersion: "visual-review-test-v1",
                prompt: "bounded review prompt",
                providerId: "openai",
                modelId: "gpt-primary",
              },
            };
          },
          audit: async () => {
            primaryAuditCalls += 1;
            throw new CodexBridgeError("Visual review audit returned HTTP 503.", true, "not_accepted", 503);
          },
          validate: (value) => validateVisualReviewReport(value, media.durationMs),
          ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
        });
      },
    };
    const backup: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "deepseek-backup",
      review: async () => validateVisualReviewReport(report, media.durationMs),
      reviewDetailed: async (input) => {
        candidateInputs.push(input);
        return runRoleAgentLoop({
          role: "视觉审片员",
          contractVersion: "visual-review-test-v1",
          criteria: ["忠于画面证据"],
          maxIterations: 1,
          produce: async () => {
            backupProducerCalls += 1;
            throw new Error("backup producer must not run");
          },
          audit: async () => {
            backupAuditCalls += 1;
            return {
              output: passingAudit,
              trace: {
                taskKind: "role-audit",
                promptVersion: "visual-review-test-v1",
                prompt: "bounded audit prompt",
                providerId: "deepseek",
                modelId: "deepseek-backup",
              },
            };
          },
          validate: (value) => validateVisualReviewReport(value, media.durationMs),
          ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
        });
      },
    };
    const fallback = new FallbackVisualReviewAgent({
      primary,
      primaryProviderId: "openai",
      backups: [{ agent: backup, providerId: "deepseek" }],
    });

    const execution = await fallback.reviewDetailed({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      requestId: "visual-review-operation",
      agentLoopCheckpointForModel: checkpointFactory,
    });

    assert.deepEqual(execution.output, report);
    assert.equal(primaryProducerCalls, 1);
    assert.equal(primaryAuditCalls, 1);
    assert.equal(backupProducerCalls, 0);
    assert.equal(backupAuditCalls, 1);
    assert.notEqual(candidateInputs[0]?.requestId, candidateInputs[1]?.requestId);
    assert.equal(candidateInputs[1]?.agentLoopCheckpoint?.key, "checkpoint-deepseek-backup");
    assert.ok(candidateInputs[1]?.agentLoopCheckpoint?.resumeFrom?.pendingCandidate);
    assert.equal(execution.agentLoop?.iterations[0]?.candidateTrace?.modelId, "gpt-primary");
    assert.equal(execution.agentLoop?.iterations[0]?.auditTrace?.modelId, "deepseek-backup");
    assert.equal(execution.executedProviderId, "deepseek");
    assert.equal(execution.executedModelId, "deepseek-backup");
    assert.deepEqual(execution.attemptedModelIds, ["gpt-primary", "deepseek-backup"]);
  });

  it("places the explicitly selected visual model first and can fall back in reverse provider order", async () => {
    const calls: string[] = [];
    const primary: VisualReviewAgent = {
      id: "deepseek-visual-review-v1",
      modelId: "deepseek-flash",
      review: async () => validateVisualReviewReport(report, media.durationMs),
      reviewDetailed: async () => {
        calls.push("deepseek-flash");
        return {
          output: validateVisualReviewReport(report, media.durationMs),
          trace: {
            taskKind: "visual-review",
            promptVersion: "visual-review-test-v1",
            prompt: "bounded test prompt",
            providerId: "deepseek",
            modelId: "deepseek-flash",
          },
        };
      },
    };
    const backup: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "gpt-vision",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async () => {
        calls.push("gpt-vision");
        throw new CodexBridgeError("Codex bridge returned HTTP 429.", false, "not_accepted", 429);
      },
    };
    const agent = new FallbackVisualReviewAgent({
      primary,
      primaryProviderId: "deepseek",
      backups: [{ agent: backup, providerId: "openai" }],
    });

    const execution = await agent.reviewDetailed({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      selectedModelId: "gpt-vision",
    });

    assert.deepEqual(calls, ["gpt-vision", "deepseek-flash"]);
    assert.equal(execution.executedModelId, "deepseek-flash");
    assert.equal(execution.executedProviderLabel, undefined);
    assert.equal(execution.fallbackFromProviderId, "openai");
    assert.deepEqual(execution.attemptedModelIds, ["gpt-vision", "deepseek-flash"]);
  });

  it("does not mask a valid semantic audit failure with the backup model", async () => {
    let backupCalls = 0;
    const primary: VisualReviewAgent = {
      id: "deepseek-visual-review-v1",
      modelId: "deepseek-flash",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async () => {
        throw new RoleAgentLoopError("Visual report did not pass its audit.", {
          version: "video-factory/agent-loop-v1",
          role: "视觉审片员",
          contractVersion: "visual-review-test-v1",
          criteria: ["忠于画面证据"],
          status: "failed",
          maxIterations: 3,
          iterations: [],
        });
      },
    };
    const backup: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "gpt-backup",
      review: async () => {
        backupCalls += 1;
        return validateVisualReviewReport(report, media.durationMs);
      },
    };
    const agent = new FallbackVisualReviewAgent({
      primary,
      primaryProviderId: "deepseek",
      backups: [{ agent: backup, providerId: "openai" }],
    });

    await assert.rejects(
      () => agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" }),
      /did not pass its audit/,
    );
    assert.equal(backupCalls, 0);
  });

  it("reports both provider failures without leaking their raw diagnostics", async () => {
    const primary: VisualReviewAgent = {
      id: "deepseek-visual-review-v1",
      modelId: "deepseek-flash",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async () => {
        // 两个候选都必须确证未受理（not_accepted），耗尽错误才有权聚合全部失败；
        // uncertain 失败会在切换发生前原样上抛，永远不会进入该聚合。
        throw new CodexBridgeError("Codex bridge returned HTTP 503. secret-primary", true, "not_accepted", 503);
      },
    };
    const backup: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "gpt-backup",
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async () => {
        throw new CodexBridgeError("Codex bridge returned HTTP 429. secret-backup", false, "not_accepted", 429);
      },
    };
    const agent = new FallbackVisualReviewAgent({
      primary,
      primaryProviderId: "deepseek",
      backups: [{ agent: backup, providerId: "openai" }],
    });

    await assert.rejects(
      () => agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" }),
      (error: unknown) => {
        assert.ok(error instanceof VisualReviewFallbackError);
        assert.match(error.message, /1\. deepseek-flash 服务端错误（HTTP 503）/);
        assert.match(error.message, /2\. gpt-backup 请求过多/);
        assert.doesNotMatch(error.message, /secret-primary|secret-backup/);
        assert.deepEqual(error.attempts, [
          {
            modelId: "deepseek-flash",
            providerId: "deepseek",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "服务端错误（HTTP 503）",
          },
          {
            modelId: "gpt-backup",
            providerId: "openai",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "请求过多",
          },
        ]);
        return true;
      },
    );
  });

  it("continues through multiple visual candidates until one succeeds", async () => {
    const calls: string[] = [];
    const failing = (modelId: string): VisualReviewAgent => ({
      id: `${modelId}-reviewer`,
      modelId,
      review: async () => { throw new Error("Detailed review must be used."); },
      reviewDetailed: async () => {
        calls.push(modelId);
        throw new CodexBridgeError(`Codex bridge returned HTTP 503 for ${modelId}.`, true, "not_accepted", 503);
      },
    });
    const final: VisualReviewAgent = {
      id: "final-reviewer",
      modelId: "vision-third",
      review: async () => validateVisualReviewReport(report, media.durationMs),
      reviewDetailed: async () => {
        calls.push("vision-third");
        return {
          output: validateVisualReviewReport(report, media.durationMs),
          trace: {
            taskKind: "visual-review",
            promptVersion: "visual-review-test-v1",
            prompt: "bounded test prompt",
            providerId: "third-provider",
            modelId: "vision-third",
          },
        };
      },
    };
    const fallback = new FallbackVisualReviewAgent({
      primary: failing("vision-first"),
      primaryProviderId: "provider-first",
      backups: [
        { agent: failing("vision-second"), providerId: "provider-second" },
        { agent: final, providerId: "third-provider" },
      ],
    });

    const execution = await fallback.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" });

    assert.deepEqual(calls, ["vision-first", "vision-second", "vision-third"]);
    assert.equal(execution.executedModelId, "vision-third");
    assert.deepEqual(execution.attemptedModelIds, ["vision-first", "vision-second", "vision-third"]);
  });

  it("rejects visual candidates without explicit broker provider identities", () => {
    const primary: VisualReviewAgent = {
      id: "deepseek-visual-review-v1",
      modelId: "deepseek-flash",
      review: async () => validateVisualReviewReport(report, media.durationMs),
    };
    const backup: VisualReviewAgent = {
      id: "codex-visual-review-v1",
      modelId: "gpt-backup",
      review: async () => validateVisualReviewReport(report, media.durationMs),
    };

    assert.throws(
      () => new FallbackVisualReviewAgent({
        primary,
        primaryProviderId: "",
        backups: [{ agent: backup, providerId: "openai" }],
      }),
      /broker provider id/i,
    );
  });

  it("rejects findings outside the inspected video and malformed scores", () => {
    assert.throws(
      () => validateVisualReviewReport({ ...report, findings: [{ ...report.findings[0], timecodeMs: 6_001 }] }, 6_000),
      /timecode is invalid/,
    );
    assert.throws(
      () => validateVisualReviewReport({ ...report, scores: { ...report.scores, pacing: 101 } }, 6_000),
      /pacing score is invalid/,
    );
  });

  it("preserves validated scene and repair ownership on each localized finding", () => {
    const localized = validateVisualReviewReport({
      ...report,
      findings: [{ ...report.findings[0], scenePosition: 2, targetNodeId: "assets" }],
    }, 6_000);

    assert.equal(localized.findings[0]?.scenePosition, 2);
    assert.equal(localized.findings[0]?.targetNodeId, "assets");
    const scriptFinding = validateVisualReviewReport({
      ...report,
      findings: [{ ...report.findings[0], targetNodeId: "creative-planning", planningStageId: "script", nextAction: "replan_upstream" }],
    }, 6_000);
    assert.equal(scriptFinding.findings[0]?.targetNodeId, "creative-planning");
    // 要重做哪一段是意见自己说的话，宿主不能替它猜：猜宽了会把没被点名的段落连同素材一起重做。
    assert.equal(scriptFinding.findings[0]?.planningStageId, "script");
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], targetNodeId: "creative-planning", nextAction: "replan_upstream" }],
      }, 6_000),
      /必须指明要重做哪一段/,
    );
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], targetNodeId: "assets", planningStageId: "director" }],
      }, 6_000),
      /不能带 planningStageId/,
    );
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], scenePosition: 0 }],
      }, 6_000),
      /scene position is invalid/,
    );
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], scenePosition: undefined }],
      }, 6_000),
      /scene position is invalid/,
    );
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], targetNodeId: undefined }],
      }, 6_000),
      /targetNodeId is invalid/,
    );
  });

  it("validates evidence ranges and frame references, and keeps not-observed work out of paid rework", () => {
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], startTimecodeMs: 3_500, endTimecodeMs: 2_500 }],
      }, 6_000, [1], media.frames),
      /time range is invalid/,
    );
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], evidenceFrameSha256: "c".repeat(64) }],
      }, 6_000, [1], media.frames),
      /evidence frame is invalid/,
    );
    const duplicateShaFrames = [
      { ...media.frames[0]!, timecodeMs: 1_000, sha256: "b".repeat(64) },
      media.frames[1]!,
    ];
    assert.doesNotThrow(() => validateVisualReviewReport(report, 6_000, [1], duplicateShaFrames));
    assert.throws(
      () => validateVisualReviewReport({
        ...report,
        findings: [{ ...report.findings[0], timecodeMs: 2_900 }],
      }, 6_000, [1], duplicateShaFrames),
      /evidence frame is invalid/,
    );
    const notObserved = validateVisualReviewReport({
      ...report,
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 },
      findings: [{
        ...report.findings[0],
        severity: "info",
        claimType: "static", evidenceStatus: "not_observed",
        evidenceFrameSha256: null,
        nextAction: "inspect_existing_media",
        description: "稀疏抽帧没有覆盖动作结果。",
        suggestion: "先补抽已有素材，不重新生成。",
      }],
      recommendation: "approve",
    }, 6_000, [1], media.frames);
    assert.equal(notObserved.recommendation, "revise");
    assert.equal(notObserved.findings[0]?.nextAction, "inspect_existing_media");
  });

  it("fails closed when model recommendation conflicts with scores, findings, or confidence", () => {
    assert.equal(validateVisualReviewReport({
      ...report,
      scores: { ...report.scores, pacing: 74 },
      findings: [],
      recommendation: "approve",
    }, 6_000).recommendation, "revise");
    assert.equal(validateVisualReviewReport({
      ...report,
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 },
      findings: [{ ...report.findings[0], severity: "critical" }],
      recommendation: "approve",
    }, 6_000).recommendation, "reject");
    assert.equal(validateVisualReviewReport({
      ...report,
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 },
      findings: [],
      confidence: 0.6,
      recommendation: "approve",
    }, 6_000).recommendation, "revise");
    assert.equal(validateVisualReviewReport({
      ...report,
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 },
      findings: [],
      confidence: 0.9,
      recommendation: "approve",
    }, 6_000).recommendation, "approve");
  });

  // 证据能力规则按主张类型分派，不按题材分派：静帧只能判定某一刻的画面状态，
  // 与片子是口播、教程还是分镜叙事无关。这里逐类核对边界，并确认规则不会反过来误伤 static。
  it("bounds failed claims by what the sampled evidence can actually settle", () => {
    const sparseFrames = media.frames;
    const frozenFrames = [
      { timecodeMs: 2_000, sha256: "d".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
      { timecodeMs: 2_500, sha256: "d".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
      { timecodeMs: 3_000, sha256: "d".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
    ];
    const sequenceFrames = [
      { timecodeMs: 2_000, sha256: "e".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
      { timecodeMs: 2_500, sha256: "f".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
      { timecodeMs: 3_000, sha256: "b".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
      { timecodeMs: 3_500, sha256: "1".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
    ];
    const failing = (overrides: Record<string, unknown>, sha: string) => ({
      ...report,
      findings: [{ ...report.findings[0], evidenceFrameSha256: sha, ...overrides }],
    });

    assert.equal(claimEvidenceSufficient("static", ["a", "b"]), true);
    assert.equal(claimEvidenceSufficient("motion", ["a", "b"]), false);
    assert.equal(claimEvidenceSufficient("motion", ["d", "d", "d"]), true);
    assert.equal(claimEvidenceSufficient("motion", ["e", "f", "b", "1"]), true);
    assert.equal(claimEvidenceSufficient("non_visual", ["e", "f", "b", "1"]), false);

    assert.throws(
      () => validateVisualReviewReport(
        failing({ claimType: "motion", evidenceStatus: "failed", severity: "warning", nextAction: "rework_asset" }, "b".repeat(64)),
        6_000, [1], sparseFrames,
      ),
      /cannot fail a motion claim/,
    );
    assert.doesNotThrow(() => validateVisualReviewReport(
      failing({ claimType: "motion", evidenceStatus: "failed", severity: "warning", nextAction: "rework_asset" }, "d".repeat(64)),
      6_000, [1], frozenFrames,
    ));
    assert.doesNotThrow(() => validateVisualReviewReport(
      failing({ claimType: "motion", evidenceStatus: "failed", severity: "warning", nextAction: "rework_asset" }, "b".repeat(64)),
      6_000, [1], sequenceFrames,
    ));
    // 采多少帧都采不到声音，所以 non_visual 的 failed 不因帧数增加而变得合法。
    assert.throws(
      () => validateVisualReviewReport(
        failing({ claimType: "non_visual", evidenceStatus: "failed", severity: "warning", nextAction: "rework_asset" }, "b".repeat(64)),
        6_000, [1], sequenceFrames,
      ),
      /cannot fail a non_visual claim/,
    );
    const unobserved = validateVisualReviewReport(
      failing({ claimType: "non_visual", evidenceStatus: "not_observed", severity: "info", nextAction: "inspect_existing_media", evidenceFrameSha256: null }, "b".repeat(64)),
      6_000, [1], sparseFrames,
    );
    assert.equal(unobserved.findings[0]?.claimType, "non_visual");
    assert.equal(unobserved.findings[0]?.nextAction, "inspect_existing_media");
    assert.doesNotThrow(() => validateVisualReviewReport(
      failing({ claimType: "static", evidenceStatus: "failed", severity: "warning", nextAction: "rework_asset" }, "b".repeat(64)),
      6_000, [1], sparseFrames,
    ));
  });

  // 下游"是否继续"闸门（试片付费、源素材预检）的放行判据。
  // 关键区分：归一化会把 not_observed 降为 revise，但它是证据合同规定的咨询项
  // （info + inspect_existing_media = 先查看已有素材，不是返工），不得阻断下游；
  // 而真正的缺陷与未达门槛的评分/置信度必须继续阻断。
  describe("visualReviewBlocksContinuation", () => {
    const clean = {
      ...report,
      scores: { composition: 94, continuity: 94, pacing: 94, legibility: 94, safety: 94 },
      findings: [],
      confidence: 0.95,
      recommendation: "approve",
    } satisfies VisualReviewReport;

    const advisory = validateVisualReviewReport({
      ...report,
      scores: { composition: 94, continuity: 94, pacing: 94, legibility: 94, safety: 94 },
      findings: [{
        timecodeMs: 0, startTimecodeMs: 0, endTimecodeMs: 0,
        scenePosition: 1, targetNodeId: "assets", claimType: "static", evidenceStatus: "not_observed",
        evidenceFrameSha256: null, nextAction: "inspect_existing_media", category: "continuity", severity: "info",
        description: "稀疏抽帧没有覆盖动作结果。", suggestion: "先查看已有素材，不据此重做此镜头。",
      }],
      confidence: 0.95,
      recommendation: "approve",
    }, 6_000, [1], media.frames);

    it("does not block on a clean approval or on an advisory not_observed finding", () => {
      assert.equal(visualReviewBlocksContinuation(clean), false);
      assert.equal(advisory.recommendation, "revise", "归一化仍按 fail-closed 把 not_observed 降为 revise");
      assert.equal(visualReviewBlocksContinuation(advisory), false,
        "咨询项不是缺陷，不得阻断下游继续（这正是试片闸门此前的死锁）");
    });

    it("still blocks on defects, rejection, and scores or confidence below the pass bar", () => {
      assert.equal(visualReviewBlocksContinuation({ ...clean, recommendation: "reject" }), true,
        "模型明确否决时必须阻断");
      assert.equal(visualReviewBlocksContinuation({
        ...clean,
        findings: [...report.findings],
        recommendation: "revise",
      }), true, "需要返工的缺陷（warning 级 failed 证据）必须阻断");
      assert.equal(visualReviewBlocksContinuation({
        ...clean,
        scores: { ...clean.scores, pacing: 74 },
        recommendation: "revise",
      }), true, "单项评分跌破 75 必须阻断");
      assert.equal(visualReviewBlocksContinuation({ ...clean, confidence: 0.6, recommendation: "revise" }), true,
        "confidence 跌破 0.7 必须阻断");
    });
  });

  it("settles an already accepted legacy second review before stopping, without another submission", async () => {
    let stored: unknown;
    let producerCalls = 0;
    let auditCalls = 0;
    let mediaCalls = 0;
    let acceptedRequestId: string | undefined;
    const observed: string[] = [];
    const secondReport = { ...report, summary: "旧版本已受理的第二份报告，保留真实结果和剩余建议。" };
    const checkpoint = {
      key: "visual-legacy-second-review",
      load: async () => stored,
      save: async (value: unknown) => { stored = structuredClone(value); },
    };
    const client = {
      runTask: async () => report,
      runTaskDetailed: async (kind: CodexTaskKind, payload: unknown, requestId?: string,
        _session?: unknown, requestOptions?: CodexTaskRequestOptions): Promise<CodexTaskExecution> => {
        if (kind === "visual-review") {
          producerCalls++;
          if (producerCalls === 2) {
            acceptedRequestId = requestId;
            await requestOptions?.beforeSubmit?.(preparedOperation(kind, payload, requestId!));
            throw new CodexBridgeError("legacy second review response lost", false, "uncertain");
          }
          return { output: report };
        }
        auditCalls++;
        return { output: advisoryAudit };
      },
      observePrepared: async (operation: CodexPreparedOperation): Promise<CodexTaskExecution> => {
        observed.push(operation.requestId);
        return { output: secondReport };
      },
    };
    const reviewMedia = { prepare: async () => { mediaCalls++; return media; } };
    const input = { runRoot: "/run", agentLoopCheckpoint: checkpoint };
    const legacy = new CodexVisualReviewAgent({ client, media: reviewMedia, maxReviewIterations: 3 });
    await assert.rejects(() => legacy.reviewDetailed(input), (error: unknown) => {
      assert.ok(error instanceof RoleAgentLoopError);
      assert.equal(error.agentLoop.failure?.stage, "uncertain");
      assert.ok(error.sourceError instanceof Error);
      assert.equal(error.sourceError.message, "legacy second review response lost");
      return true;
    });

    const current = new CodexVisualReviewAgent({ client, media: reviewMedia });
    const result = await current.reviewDetailed(input);
    assert.deepEqual(observed, [acceptedRequestId]);
    assert.equal(producerCalls, 2, "既不重交第二轮，也不开第三轮");
    assert.equal(auditCalls, 2, "只补齐已受理第二轮的独立复核");
    assert.equal(mediaCalls, 1, "从原请求恢复相同媒体证据");
    assert.deepEqual(result.output, secondReport);
    assert.equal(result.agentLoop?.status, "awaiting_user");
    assert.equal(result.agentLoop?.iterations.length, 2);
    await current.reviewDetailed(input);
    assert.equal(producerCalls, 2);
    assert.equal(auditCalls, 2);
    assert.equal(observed.length, 1);
  });

  it("resumes a saved visual-review request without preprocessing the same media again", async () => {
    let stored: unknown;
    let interruptProducer = true;
    let mediaCalls = 0;
    let producerCalls = 0;
    const observed: string[] = [];
    const checkpoint = {
      key: "visual-review-recovery",
      load: async () => stored,
      save: async (value: unknown) => { stored = structuredClone(value); },
    };
    const client = {
      runTask: async () => report,
      runTaskDetailed: async (
        kind: CodexTaskKind,
        payload: unknown,
        requestId?: string,
        _session?: unknown,
        requestOptions?: CodexTaskRequestOptions,
      ): Promise<CodexTaskExecution> => {
        if (kind === "visual-review") {
          producerCalls += 1;
          if (interruptProducer) {
            await requestOptions?.beforeSubmit?.(preparedOperation(kind, payload, requestId!));
            throw new Error("visual response interrupted");
          }
          return { output: report };
        }
        return { output: passingAudit };
      },
      observePrepared: async (operation: CodexPreparedOperation): Promise<CodexTaskExecution> => {
        observed.push(operation.requestId);
        return { output: report };
      },
    };
    const agent = new CodexVisualReviewAgent({
      client,
      media: {
        prepare: async () => {
          mediaCalls += 1;
          return media;
        },
      },
    });
    const input = { videoPath: "/run/final.mp4", runRoot: "/run", agentLoopCheckpoint: checkpoint };

    await assert.rejects(() => agent.reviewDetailed(input), /visual response interrupted/);
    interruptProducer = false;
    const execution = await agent.reviewDetailed(input);

    assert.equal(execution.agentLoop?.status, "passed");
    assert.equal(producerCalls, 1);
    assert.equal(observed.length, 1);
    assert.equal(mediaCalls, 1);
    assert.match(execution.evidenceSnapshotId ?? "", /^[a-f0-9]{64}$/);
  });

  it("reviews regenerated evidence under a new identity instead of reusing the previous one", async () => {
    let stored: unknown;
    let mediaVersion = 0;
    const requestIds: string[] = [];
    const checkpoint = {
      key: "visual-review-evidence",
      load: async () => stored,
      save: async (value: unknown) => { stored = structuredClone(value); },
    };
    const client = {
      runTask: async () => report,
      runTaskDetailed: async (kind: CodexTaskKind, _payload: unknown, requestId?: string): Promise<CodexTaskExecution> => {
        if (kind === "visual-review") {
          requestIds.push(requestId!);
          return { output: report };
        }
        return { output: passingAudit };
      },
    };
    const agent = new CodexVisualReviewAgent({
      client,
      // 帧被重新生成：证据快照变化，但节点声明的输入路径完全不变。
      media: { prepare: async () => (mediaVersion === 0 ? media : regeneratedMedia) },
    });
    const input = { videoPath: "/run/final.mp4", runRoot: "/run", agentLoopCheckpoint: checkpoint };

    const first = await agent.reviewDetailed(input);
    mediaVersion = 1;
    const second = await agent.reviewDetailed(input);
    const third = await agent.reviewDetailed(input);

    assert.equal(first.agentLoop?.status, "passed");
    assert.equal(second.agentLoop?.status, "passed");
    // 合同锁定当次证据快照，否则证据换了身份不换，物理请求会与历史任务撞 binding_conflict。
    assert.ok(first.agentLoop?.contractVersion.endsWith(`|evidence:${first.evidenceSnapshotId}`));
    assert.notEqual(second.evidenceSnapshotId, first.evidenceSnapshotId);
    assert.equal(requestIds.length, 2);
    assert.notEqual(requestIds[1], requestIds[0]);
    // 证据未变时必须回放已通过的结论，不能每次都重开身份造成重复付费。
    assert.equal(third.agentLoop?.status, "passed");
    assert.equal(requestIds.length, 2);
  });
});

// 报告是制品，会跨构建存活。升级收紧审片合同之后，旧运行里那份报告仍是"当前有效
// 版本"，但它的结论是按旧要求下的。此处保证消费方拿到的是"原因 + 动作"，而不是一条
// 操作员无法据以行动的字段校验错误。
describe("assertCurrentVisualReviewContract", () => {
  const stamped = (reviewContractVersion?: string) => ({
    version: "video-factory/visual-review-v1",
    findings: [],
    reviewScope: {
      reviewStage: "rendered_video",
      ...(reviewContractVersion === undefined ? {} : { reviewContractVersion }),
    },
  });

  it("accepts a report produced under the current contract", () => {
    assert.doesNotThrow(() => assertCurrentVisualReviewContract(stamped(VISUAL_REVIEW_AGENT_CONTRACT_VERSION)));
  });

  it("refuses an older report with the reason and the action", () => {
    for (const value of [stamped(), stamped("visual-review-v15|claim-evidence-capability-v0")]) {
      assert.throws(
        () => assertCurrentVisualReviewContract(value),
        (error: unknown) => error instanceof Error
          && /更早的审片合同裁出来的/.test(error.message)
          && error.message.includes(VISUAL_REVIEW_AGENT_CONTRACT_VERSION)
          && /请先补查成片/.test(error.message),
      );
    }
    // 没有标记的报告要能被认出是"早于合同标记"，而不是被当成某一份具体合同。
    assert.throws(() => assertCurrentVisualReviewContract(stamped()), /早于合同标记/);
    // 有标记但不是当前合同的，要报出它自己那一版，便于判断升级跨度。
    assert.throws(
      () => assertCurrentVisualReviewContract(stamped("visual-review-v15|claim-evidence-capability-v0")),
      /claim-evidence-capability-v0/,
    );
  });

  it("refuses a report whose scope is missing or malformed instead of reading it as current", () => {
    for (const value of [undefined, null, "report", [], {}, { reviewScope: null }, { reviewScope: 7 }]) {
      assert.throws(() => assertCurrentVisualReviewContract(value), /更早的审片合同裁出来的/);
    }
  });
});

describe("validateAggregatedVisualReviewReport", () => {
  it("accepts one complete current single-review report without inventing a second branch", () => {
    const singleReview = {
      ...mutableReport,
      reviewScope: {
        reviewStage: "rendered_video" as const,
        evidenceId: "c".repeat(64),
        sourceNodeIds: ["render", "technical-review"],
        sourceArtifactIds: ["render-artifact", "technical-review-artifact"],
        scenePositions: [1],
        timelineDurationMs: media.durationMs,
        actualModels: [{
          providerId: "deepseek-visual-review-v1",
          modelId: "deepseek-visual",
        }],
        reviewContractVersion: VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
      },
    };

    assert.doesNotThrow(() => validateAggregatedVisualReviewReport(singleReview, media.durationMs));
  });
});

function preparedOperation(kind: CodexTaskKind, payload: unknown, requestId: string): CodexPreparedOperation {
  const envelope = { protocolVersion: "video-factory/codex-bridge-v2", requestId, kind, payload };
  const brokerBinding = {
    version: "video-factory/task-binding-v1" as const,
    storeId: `vfs_store_${"1".repeat(32)}`,
    providerId: "openai",
    modelId: "codex-default",
  };
  return {
    version: "video-factory/codex-prepared-operation-v1",
    requestId,
    kind,
    envelope,
    serializedEnvelope: JSON.stringify(envelope),
    binding: {
      ...brokerBinding,
      requestDigest: "2".repeat(64),
      kind,
      contractDigest: "3".repeat(64),
      sessionDigest: "4".repeat(64),
    },
    brokerBinding,
    route: { socketPath: "/tmp/visual-review.sock" },
    taskFact: "not_submitted",
  };
}
