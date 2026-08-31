import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CodexVisualReviewAgent,
  validateVisualReviewReport,
  type CodexTaskKind,
  type VisualReviewMediaPayload,
} from "../src/index.js";

const media: VisualReviewMediaPayload = {
  durationMs: 6_000,
  frames: [
    { timecodeMs: 0, sha256: "a".repeat(64), jpegBase64: "/9j/2Q==" },
    { timecodeMs: 3_000, sha256: "b".repeat(64), jpegBase64: "/9j/2Q==" },
  ],
};

const report = {
  version: "video-factory/visual-review-v1",
  summary: "画面整体稳定，第二镜字幕略密。",
  scores: { composition: 84, continuity: 82, pacing: 78, legibility: 72, safety: 96 },
  findings: [{
    timecodeMs: 3_000,
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

  it("keeps a stateless ZAI producer out of Codex sessions while preserving full repair context", async () => {
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
    assert.equal((auditSessions[0] as { handle?: string }).handle, undefined);
    assert.equal((auditSessions[1] as { handle?: string }).handle, `vfs_${"a".repeat(32)}`);
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
      /produce model-call limit of 1/,
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

  it("fails closed when model recommendation conflicts with scores, findings, or confidence", () => {
    assert.equal(validateVisualReviewReport({
      ...report,
      scores: { ...report.scores, pacing: 59 },
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
