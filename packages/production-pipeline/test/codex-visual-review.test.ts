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
