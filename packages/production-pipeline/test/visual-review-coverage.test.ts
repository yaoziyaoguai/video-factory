import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexVisualReviewAgent, IndependentDualVisualReviewAgent, validateAggregatedVisualReviewReport, validateVisualReviewReport, visualReviewBlocksContinuation, type VisualReviewFinding, type VisualReviewReport } from "../src/codex-visual-review.js";
import { visualReviewRequirements } from "../src/visual-review-coverage.js";

const frames = [0, 1000, 2000, 3000].map((timecodeMs, i) => ({ timecodeMs, scenePosition: 1, sha256: String(i + 1).repeat(64), jpegBase64: "/9j/2Q==" }));
const media = { durationMs: 4000, frames };
const clean: VisualReviewReport = { version: "video-factory/visual-review-v1", summary: "抽样检查", scores: { composition: 80, continuity: 80, pacing: 80, legibility: 80, safety: 80 }, findings: [], confidence: 0.9, recommendation: "approve" };
const finding: VisualReviewFinding = { timecodeMs: 0, startTimecodeMs: 0, endTimecodeMs: 1000, scenePosition: 1, targetNodeId: "assets", claimType: "static", evidenceStatus: "satisfied", evidenceFrameSha256: frames[0]!.sha256, nextAction: "none", category: "composition", severity: "info", description: "采样时刻可见杯子。", suggestion: "无" };
const context = { reviewStage: "source_assets", directorPlan: { shots: [{ scenePosition: 1, successCriteria: ["杯子可见", "光斑变亮"] }, { scenePosition: 2, successCriteria: ["钥匙可见"] }] } };
const requirements = visualReviewRequirements(context, [1]);

describe("visual review host evidence and coverage", () => {
  it("keeps valid single-frame static checks and legitimate empty reports", () => {
    assert.equal(validateVisualReviewReport({ ...clean, findings: [finding] }, 4000, [1], frames).recommendation, "approve");
    assert.deepEqual(validateVisualReviewReport(clean, 4000, [1], frames, []), clean);
  });

  it("downgrades unsupported positive claims without rewriting the model observation or requesting rework", () => {
    for (const claimType of ["motion", "non_visual"] as const) {
      for (const samples of [frames.slice(0, 3), frames, frames.map((frame) => ({ ...frame, sha256: frames[0]!.sha256 }))]) {
        const result = validateVisualReviewReport({ ...clean, findings: [{ ...finding, claimType }] }, 4000, [1], samples);
        assert.equal(result.recommendation, "revise");
        assert.equal(result.findings[0]!.evidenceStatus, "not_observed");
        assert.equal(result.findings[0]!.reportedEvidenceStatus, "satisfied");
        assert.equal(result.findings[0]!.description, finding.description);
        assert.equal(result.findings[0]!.nextAction, "inspect_existing_media");
        assert.equal(visualReviewBlocksContinuation(result), false);
        assert.deepEqual(validateVisualReviewReport(JSON.parse(JSON.stringify(result)), 4000), result);
      }
    }
  });

  it("compares only two cited same-scene sampled states, not frame counts or continuous motion", () => {
    const stateChange = { ...finding, claimType: "state_change", endEvidenceFrameSha256: frames[1]!.sha256 };
    assert.equal(validateVisualReviewReport({ ...clean, findings: [stateChange] }, 4000, [1], frames).recommendation, "approve");
    for (const unsupported of [
      { ...finding, evidenceFrameSha256: null },
      { ...stateChange, endEvidenceFrameSha256: null },
      { ...stateChange, endTimecodeMs: 0, endEvidenceFrameSha256: frames[0]!.sha256 },
    ]) assert.equal(validateVisualReviewReport({ ...clean, findings: [unsupported] }, 4000, [1], frames).recommendation, "revise");
    const identical = frames.map((frame) => ({ ...frame, sha256: frames[0]!.sha256 }));
    assert.equal(validateVisualReviewReport({ ...clean, findings: [{ ...stateChange, endEvidenceFrameSha256: frames[0]!.sha256 }] }, 4000, [1], identical).recommendation, "revise");
    assert.throws(() => validateVisualReviewReport({ ...clean, findings: [stateChange] }, 4000, [1], frames.map((frame, i) => i === 1 ? { ...frame, scenePosition: 2 } : frame)), /end evidence frame is invalid/);
    assert.throws(() => validateVisualReviewReport({ ...clean, findings: [{ ...finding, evidenceFrameSha256: "f".repeat(64) }] }, 4000, [1], frames), /evidence frame is invalid/);
  });

  it("keeps missing adopted checks unconfirmed with host provenance and does not block advisory continuation", () => {
    const report = validateVisualReviewReport({ ...clean, findings: [{ ...finding, requirementId: requirements[0]!.id }] }, 4000, [1], frames, requirements);
    assert.equal(report.findings.length, 1, "宿主不能补出模型从未观察过的 finding");
    assert.deepEqual(report.coverage?.requirements.map((item) => item.status), ["confirmed", "unconfirmed"]);
    assert.equal(report.coverage?.source, "host");
    assert.equal(report.recommendation, "revise");
    assert.equal(visualReviewBlocksContinuation(report), false);
    assert.deepEqual(validateVisualReviewReport(JSON.parse(JSON.stringify(report)), 4000), report);
    assert.equal(validateVisualReviewReport(clean, 4000, [1], frames, requirements).coverage?.requirements.length, 2);
    assert.throws(() => validateVisualReviewReport({ ...clean, findings: [{ ...finding, requirementId: "foreign" }] }, 4000, [1], frames, requirements), /unknown or out-of-scope/);
  });

  it("uses only current explicit conditions and respects source-assets and pilot scope", () => {
    const withScript = { ...context, script: { scenes: [{ position: 1, success_criteria: ["后期字幕出现"] }] } };
    assert.deepEqual(visualReviewRequirements(withScript, [1]), requirements);
    const rendered = visualReviewRequirements({ ...withScript, reviewStage: "rendered_video" }, [1]);
    assert.equal(rendered.length, 3);
    assert.equal(rendered.at(-1)!.text, "后期字幕出现");
    assert.deepEqual(visualReviewRequirements({ concept: "要有吸引点", script: { scenes: [{ position: 1, visible_action: "看窗外" }] } }), []);
    assert.equal(visualReviewRequirements({ ...context, pilotScenePositions: [2] }).length, 1);
    assert.notEqual(visualReviewRequirements({ directorPlan: { shots: [{ scenePosition: 1, successCriteria: ["采用了新的内容"] }] } })[0]!.id, requirements[0]!.id);
  });

  it("can represent every condition in a maximum-size adopted plan without truncation", () => {
    const positions = Array.from({ length: 24 }, (_, index) => index + 1);
    const maximum = visualReviewRequirements({
      reviewStage: "rendered_video",
      directorPlan: { shots: positions.map((scenePosition) => ({ scenePosition, successCriteria: Array.from({ length: 8 }, (_, i) => `导演条件 ${i}`) })) },
      script: { scenes: positions.map((position) => ({ position, success_criteria: Array.from({ length: 6 }, (_, i) => `脚本条件 ${i}`) })) },
    });
    const samples = positions.map((scenePosition) => ({ ...frames[0]!, scenePosition, timecodeMs: scenePosition }));
    const findings = maximum.map((requirement) => ({ ...finding, requirementId: requirement.id, scenePosition: requirement.scenePosition,
      timecodeMs: requirement.scenePosition, startTimecodeMs: requirement.scenePosition }));
    const checked = validateVisualReviewReport({ ...clean, findings }, 4000, positions, samples, maximum);
    assert.equal(checked.findings.length, 336);
    assert.equal(checked.coverage?.requirements.filter((item) => item.status === "confirmed").length, 336);
    assert.equal(checked.recommendation, "approve");
  });

  it("passes host-derived current requirement ids to the producer and uses them for omission checking", async () => {
    let submitted: unknown;
    const agent = new CodexVisualReviewAgent({ client: { runTask: async (_kind, payload) => { submitted = payload; return clean; } }, media: { prepare: async () => ({ ...media, reviewContext: context }) } });
    const result = await agent.review({ runRoot: "/unused", scenePositions: [1], reviewStage: "source_assets" });
    assert.deepEqual((submitted as { reviewContext: { requirements: unknown } }).reviewContext.requirements, requirements);
    assert.equal(result.coverage?.requirements.length, 2);
    assert.equal(result.recommendation, "revise");
  });

  it("does not inherit an old pilot subset when the host requests the whole film", async () => {
    const preparedMedia = { ...media, reviewContext: { ...context, pilotScenePositions: [1] } };
    const agent = new CodexVisualReviewAgent({ client: { runTask: async () => clean }, media: { prepare: async () => preparedMedia } });
    const report = await agent.review({ runRoot: "/unused", reviewStage: "rendered_video" });
    assert.deepEqual(report.coverage?.requirements.map((item) => item.scenePosition), [1, 1, 2]);
  });

  it("does not lose a missing independent branch check in aggregation or saved-report normalization", async () => {
    const contextWithOne = { reviewStage: "rendered_video", directorPlan: { shots: [{ scenePosition: 1, successCriteria: ["杯子可见"] }] } };
    const required = visualReviewRequirements(contextWithOne);
    const primaryReport = validateVisualReviewReport({ ...clean, findings: [{ ...finding, requirementId: required[0]!.id }] }, 4000, [1], frames, required);
    const secondaryReport = validateVisualReviewReport(clean, 4000, [1], frames, required);
    const branch = (id: string, report: VisualReviewReport) => ({ id, modelId: id, independentRoleAudit: true, review: async () => report });
    const agent = new IndependentDualVisualReviewAgent({ primary: branch("one", primaryReport), secondary: branch("two", secondaryReport), media: { prepare: async () => ({ ...media, reviewContext: contextWithOne }) } });
    const output = (await agent.reviewDetailed({ runRoot: "/unused", scenePositions: [1] })).output;
    assert.equal(output.coverage?.requirements[0]!.status, "unconfirmed");
    const persisted = { ...output, reviewScope: { actualModels: [{ modelId: "one" }, { modelId: "two" }] }, independentReviews: [{ providerId: "one", modelId: "one", report: primaryReport }, { providerId: "two", modelId: "two", report: secondaryReport }] };
    assert.equal(validateAggregatedVisualReviewReport(persisted, 4000).coverage?.requirements[0]!.status, "unconfirmed");
  });
});
