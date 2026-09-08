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
  VisualReviewFallbackError,
  runRoleAgentLoop,
  validateVisualReviewReport,
  type CodexTaskKind,
  type VisualReviewAgent,
  type VisualReviewAgentInput,
  type VisualReviewMediaPayload,
  type VisualReviewReport,
} from "../src/index.js";

const media: VisualReviewMediaPayload = {
  durationMs: 6_000,
  frames: [
    { timecodeMs: 0, sha256: "a".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
    { timecodeMs: 3_000, sha256: "b".repeat(64), jpegBase64: "/9j/2Q==", scenePosition: 1 },
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
    evidenceStatus: "failed",
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

const passingAudit = {
  version: "video-factory/role-audit-v1",
  verdict: "pass",
  score: 92,
  summary: "报告忠于关键帧证据并清楚声明证据边界。",
  issues: [],
  repairInstructions: [],
} as const;

describe("CodexVisualReviewAgent", () => {
  it("runs final Codex and GLM reviews independently over one immutable evidence snapshot", async () => {
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
      summary: "GLM 确认画面存在水印。",
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
      primary: reviewer("glm-visual-review-v1", "glm-5.3-flash", hardFailure),
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
    assert.deepEqual(new Set(calls), new Set(["glm-visual-review-v1", "codex-visual-review-v1"]));
    assert.equal(preparedInputs[0], preparedInputs[1]);
    assert.equal(execution.output.recommendation, "reject");
    assert.equal(execution.output.scores.legibility, 35);
    assert.equal(execution.output.findings.some((finding) => finding.description === "画面存在水印。"), true);
    assert.deepEqual(execution.independentReviews?.map(({ providerId, modelId }) => ({ providerId, modelId })), [
      { providerId: "glm-visual-review-v1", modelId: "glm-5.3-flash" },
      { providerId: "codex-visual-review-v1", modelId: "gpt-5.6-sol" },
    ]);
  });

  it("preserves more than fifty distinct findings across the two independent reviews", async () => {
    const findingsFor = (prefix: string) => Array.from({ length: 26 }, (_, index) => ({
      ...report.findings[0],
      evidenceStatus: "satisfied" as const,
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
      primary: reviewer("glm-visual-review-v1", "glm-5.3-flash", "GLM"),
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
      primary: reviewer("glm-visual-review-v1", "glm-5.3-flash", "warning"),
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
      { providerId: "glm-visual-review-v1", modelId: "glm-5.3-flash" },
      { providerId: "codex-visual-review-v1", modelId: "gpt-5.6-sol" },
    ]);
  });

  it("retries only the failed final-review branch after preserving the completed model result", async () => {
    const calls = { glm: 0, codex: 0 };
    const stored = new Map<string, unknown>();
    const cleanReport: VisualReviewReport = {
      ...report,
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 95 },
      findings: [],
      recommendation: "approve",
    };
    const subject = new IndependentDualVisualReviewAgent({
      primary: {
        id: "glm-visual-review-v1",
        modelId: "glm-5.3-flash",
        review: async () => {
          calls.glm += 1;
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
          providerId: "glm-visual-review-v1",
          modelId: "glm-5.3-flash",
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

    assert.deepEqual(calls, { glm: 1, codex: 2 });
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

  it("repairs a visual report against an independent audit for at most three semantic rounds", async () => {
    const calls: Array<{ kind: CodexTaskKind; payload: Record<string, unknown> }> = [];
    let producerCalls = 0;
    let auditCalls = 0;
    const repairedReport = {
      ...report,
      summary: "画面证据与评分一致，字幕密度问题定位明确。",
    };
    const agent = new CodexVisualReviewAgent({
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
            version: "video-factory/role-audit-v1",
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
      /同一人物、物件或空间.*Provider.*无法保证.*visual-direction 或 script.*replan_upstream/,
    );
    assert.match(
      JSON.stringify(calls[1]?.payload.context),
      /上游免责声明.*不能把不可执行方案变成可执行方案.*不得.*assets.*重复付费/,
    );
    assert.deepEqual(execution.output, repairedReport);
  });

  it("uses the OpenAI audit client when the visual producer only accepts ZAI review tasks", async () => {
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

  it("keeps stateless ZAI visual-review calls out of Codex sessions while preserving full repair context", async () => {
    const producerSessions: unknown[] = [];
    const producerPayloads: Array<Record<string, unknown>> = [];
    const auditSessions: unknown[] = [];
    let producerCalls = 0;
    let auditCalls = 0;
    const repairedReport = { ...report, summary: "修订后的视觉审片报告忠于抽样证据。" };
    const agent = new CodexVisualReviewAgent({
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
              version: "video-factory/role-audit-v1",
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
            version: "video-factory/role-audit-v1",
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
      id: "glm-visual-review-v1",
      modelId: "glm-5.3-flash",
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
      primaryProviderId: "zai-bigmodel-api",
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
    assert.equal(primaryInputs[0]?.agentLoopCheckpoint, checkpoints.get("glm-5.3-flash"));
    assert.equal(backupInputs[0]?.agentLoopCheckpoint, checkpoints.get("gpt-backup"));
    assert.match(String(backupInputs[0]?.requestId), /^backup-[a-f0-9]{64}$/);
    assert.notEqual(backupInputs[0]?.requestId, primaryInputs[0]?.requestId);
    assert.equal(execution.executedProviderId, "openai");
    assert.equal(execution.executedProviderLabel, "Codex 视觉审片");
    assert.equal(execution.executedModelId, "gpt-backup");
    assert.equal(execution.fallbackFromProviderId, "zai-bigmodel-api");
    assert.deepEqual(execution.attemptedModelIds, ["glm-5.3-flash", "gpt-backup"]);
    assert.deepEqual(execution.trace?.modelCandidateAttempts, [{
      modelId: "glm-5.3-flash",
      providerId: "zai-bigmodel-api",
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
      "Codex bridge returned HTTP 503. socket /private/run/zai.sock detail secret-primary",
      false,
      "uncertain",
      503,
    );
    const primary: VisualReviewAgent = {
      id: "glm-visual-review-v1",
      modelId: "glm-5.3-flash",
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
      primaryProviderId: "zai-bigmodel-api",
      backups: [{ agent: backup, label: "Codex 视觉审片", providerId: "openai" }],
    });

    await assert.rejects(
      () => agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run", requestId: "node-operation" }),
      (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error, uncertainFailure);
        assert.equal(error.stage, "uncertain");
        assert.equal(error.statusCode, 503);
        assert.equal(error.creatorMessage, "模型暂时不可用，请重试或选择其他模型。");
        assert.doesNotMatch(error.creatorMessage, /secret-primary|zai\.sock|\/private\/run/);
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
      modelId: "glm-backup",
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
                providerId: "zai-bigmodel-api",
                modelId: "glm-backup",
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
      backups: [{ agent: backup, providerId: "zai-bigmodel-api" }],
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
    assert.equal(candidateInputs[1]?.agentLoopCheckpoint?.key, "checkpoint-glm-backup");
    assert.ok(candidateInputs[1]?.agentLoopCheckpoint?.resumeFrom?.pendingCandidate);
    assert.equal(execution.agentLoop?.iterations[0]?.candidateTrace?.modelId, "gpt-primary");
    assert.equal(execution.agentLoop?.iterations[0]?.auditTrace?.modelId, "glm-backup");
    assert.equal(execution.executedProviderId, "zai-bigmodel-api");
    assert.equal(execution.executedModelId, "glm-backup");
    assert.deepEqual(execution.attemptedModelIds, ["gpt-primary", "glm-backup"]);
  });

  it("places the explicitly selected visual model first and can fall back in reverse provider order", async () => {
    const calls: string[] = [];
    const primary: VisualReviewAgent = {
      id: "glm-visual-review-v1",
      modelId: "glm-5.3-flash",
      review: async () => validateVisualReviewReport(report, media.durationMs),
      reviewDetailed: async () => {
        calls.push("glm-5.3-flash");
        return {
          output: validateVisualReviewReport(report, media.durationMs),
          trace: {
            taskKind: "visual-review",
            promptVersion: "visual-review-test-v1",
            prompt: "bounded test prompt",
            providerId: "zai-bigmodel-api",
            modelId: "glm-5.3-flash",
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
      primaryProviderId: "zai-bigmodel-api",
      backups: [{ agent: backup, providerId: "openai" }],
    });

    const execution = await agent.reviewDetailed({
      videoPath: "/run/final.mp4",
      runRoot: "/run",
      selectedModelId: "gpt-vision",
    });

    assert.deepEqual(calls, ["gpt-vision", "glm-5.3-flash"]);
    assert.equal(execution.executedModelId, "glm-5.3-flash");
    assert.equal(execution.executedProviderLabel, undefined);
    assert.equal(execution.fallbackFromProviderId, "openai");
    assert.deepEqual(execution.attemptedModelIds, ["gpt-vision", "glm-5.3-flash"]);
  });

  it("does not mask a valid semantic audit failure with the backup model", async () => {
    let backupCalls = 0;
    const primary: VisualReviewAgent = {
      id: "glm-visual-review-v1",
      modelId: "glm-5.3-flash",
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
      primaryProviderId: "zai-bigmodel-api",
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
      id: "glm-visual-review-v1",
      modelId: "glm-5.3-flash",
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
      primaryProviderId: "zai-bigmodel-api",
      backups: [{ agent: backup, providerId: "openai" }],
    });

    await assert.rejects(
      () => agent.reviewDetailed({ videoPath: "/run/final.mp4", runRoot: "/run" }),
      (error: unknown) => {
        assert.ok(error instanceof VisualReviewFallbackError);
        assert.match(error.message, /1\. glm-5\.3-flash 服务端错误（HTTP 503）/);
        assert.match(error.message, /2\. gpt-backup 请求过多/);
        assert.doesNotMatch(error.message, /secret-primary|secret-backup/);
        assert.deepEqual(error.attempts, [
          {
            modelId: "glm-5.3-flash",
            providerId: "zai-bigmodel-api",
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
      id: "glm-visual-review-v1",
      modelId: "glm-5.3-flash",
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
      findings: [{ ...report.findings[0], targetNodeId: "script", nextAction: "replan_upstream" }],
    }, 6_000);
    assert.equal(scriptFinding.findings[0]?.targetNodeId, "script");
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
        evidenceStatus: "not_observed",
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
});
