import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import {
  CREATIVE_REVIEW_FEATURE,
  candidateSearchFingerprint,
  contentSha256,
  createCreativePlanningGraph,
  executablePlanCompilePort,
  RoleAgentLoopError,
  runCreativePlanning,
  type CreativePlanningPorts,
  type CreativeReviewGate,
} from "../src/index.js";
import { planningThreadId } from "../src/creative-planning-store.js";
import { initialCreativeReviewState, publishCreativeDraft, recordCreativeDiscussion, applyCreativeReviewDeterministicCommand, recordCreativeReviewCheck, confirmCreativeDraft } from "../src/creative-review.js";

// 构思、脚本、导演方案都是创作交付：宿主规定的评估对象是当前完整候选（根路径 ""），
// 维度固定为 attention/progression/payoff/expression。全部分数取同一个值，
// 好让 score 恰好等于最低维度分这个归约成立。
const CREATIVE_AUDIT_DIMENSIONS = ["attention", "progression", "payoff", "expression"] as const;

function auditAssessments(score: number) {
  return [{
    targetPath: "",
    dimensions: CREATIVE_AUDIT_DIMENSIONS.map((dimension) => ({ dimension, score, evidence: "本轮维度依据已核对。" })),
  }];
}

const treatment = {
  version: "video-factory/creative-treatment-v2" as const,
  viewerPromise: "看懂一个判断方法",
  hook: { narrationIntent: "先给冲突", visualIntent: "展示差异" },
  progression: [{ beatId: "beat-1", purpose: "解释", viewerGain: "会判断" }],
  payoff: "给出检查表",
  visualPrinciples: ["可见差异"],
  soundPrinciples: ["自然口语"],
  evidenceRequirements: [],
  feasibilityQuestions: [],
};

const script = {
  version: "1.0" as const,
  title: "判断方法",
  angle: "用差异解释",
  audience: "普通观众",
  tone: "自然",
  language: "zh-CN",
  platform: "douyin",
  duration_seconds: 24,
  viewerPromise: "看懂一个判断方法",
  narrativeArc: "问题到答案",
  sourcePolicy: "不虚构",
  canonFacts: [],
  scenes: [{
    id: "scene-1", position: 1, duration: 24, purpose: "解释方法", narration: "先看差异，再做判断。",
    visual_strategy: "generated" as const, visual_prompt: "两个不同结果的清楚示意", visible_action: "结果由左到右变化",
    success_criteria: ["差异清楚"], failure_conditions: ["差异不可见"], search_terms: [],
    on_screen_text: "", sound_cue: "自然口播", source_ids: [],
  }],
};

const director = {
  version: "video-factory/director-plan-v1" as const,
  requestedProfileId: "auto" as const,
  resolvedProfileId: "documentary-observer" as const,
  profileRationale: "清楚解释",
  visualBible: {
    narrativeApproach: "简洁示意",
    pacing: "单镜完整展示变化",
    composition: "主体居中且差异清楚",
    camera: "固定机位",
    color: "中性色",
    continuity: "单镜内方向一致",
    sound: "自然口播",
  },
  shots: [{
    scenePosition: 1, deliveryType: "generated_video" as const, preferredProviderId: "provider-1",
    alternativeProviderIds: [], query: "", generationPrompt: "两个结果发生清楚变化",
    subject: "两个结果", environment: "简洁背景", visibleAction: "由左到右变化", authenticityPolicy: "illustrative" as const,
    shotSize: "medium", cameraMovement: "static", lighting: "soft", continuityRequirements: [], negativeConstraints: ["无字"],
    sourceInSeconds: 0, temporalBeats: [{ startSeconds: 0, endSeconds: 24, action: "展示变化" }],
    successCriteria: ["差异清楚"], rationale: "服务解释", narrativeRole: "payoff",
    continuityNote: "单镜无需跨镜连续",
    confidence: 0.9,
    estimatedCostCny: 1,
  }],
};

function resume(gate: CreativeReviewGate, commandId: string) {
  return {
    action: "confirm" as const,
    stage: gate.stage,
    commandId,
    actor: "creator",
    baseDraftSha256: gate.draft.sha256,
    expectedReviewRevision: gate.reviewRevision,
    checkIdentity: contentSha256({ stage: gate.stage, draft: gate.draft.sha256 }),
    confirmedAt: "2026-09-14T00:00:00.000Z",
  };
}

describe("three-stage creative review gates", () => {
  it("restores revision instructions with the draft across persistence and keeps discussion history", () => {
    let review = publishCreativeDraft(initialCreativeReviewState(), "treatment", "treatment", treatment, "input");
    review = recordCreativeReviewCheck(review, "treatment", {
      draftSha256: review.stages.treatment.currentDraft!.sha256, checkIdentity: contentSha256("checked-treatment"),
      verdict: "pass", score: 90, summary: "可继续", issues: [],
    });
    review = confirmCreativeDraft(review, {
      action: "confirm", stage: "treatment", commandId: "confirm-treatment", actor: "creator",
      baseDraftSha256: review.stages.treatment.currentDraft!.sha256,
      expectedReviewRevision: review.reviewRevision, checkIdentity: contentSha256("checked-treatment"), confirmedAt: "2026-09-14T00:00:00.000Z",
    });
    review = publishCreativeDraft(review, "script", "original", script, "input");
    const command = (id: string) => ({
      stage: "script" as const, commandId: id, actor: "creator",
      baseDraftSha256: review.stages.script.currentDraft!.sha256,
      expectedReviewRevision: review.reviewRevision,
    });
    const edited = { ...script, tone: "更克制" };
    review = recordCreativeDiscussion(review, { ...command("revision"), action: "discuss", message: "只调整语气，保留其它内容" }, {
      stage: "script", intent: "revise", reply: "已调整语气", changeSummary: ["语气更克制"],
      treatment: null, script: edited, director: null, upstreamRequest: null,
    });
    review = JSON.parse(JSON.stringify(review));
    review = applyCreativeReviewDeterministicCommand(review, { ...command("undo"), action: "undo_draft" });
    assert.deepEqual(review.stages.script.currentDocument, script);
    assert.deepEqual(review.stages.script.effectiveUserInstructions, []);
    assert.equal(review.stages.script.messages.length, 2, "history is retained but is not an active constraint");
    review = recordCreativeDiscussion(review, { ...command("explain"), action: "discuss", message: "解释当前方案" }, {
      stage: "script", intent: "explain", reply: "当前是原语气", changeSummary: [],
      treatment: null, script: null, director: null, upstreamRequest: null,
    });
    review = applyCreativeReviewDeterministicCommand(review, { ...command("restore"), action: "undo_draft" });
    assert.deepEqual(review.stages.script.currentDocument, edited);
    assert.deepEqual(review.stages.script.effectiveUserInstructions.map((entry) => entry.commandId), ["revision"]);
    assert.equal(review.stages.script.messages.length, 4);
    delete review.stages.script.previousEffectiveUserInstructions;
    assert.throws(() => applyCreativeReviewDeterministicCommand(review, { ...command("legacy"), action: "undo_draft" }), /缺少对应的要求记录/);
    assert.deepEqual(review.stages.script.currentDocument, edited);
  });
  it("treats the independent check as advice: repair blocks by default but can be explicitly acknowledged", () => {
    let review = publishCreativeDraft(initialCreativeReviewState(), "treatment", "treatment", treatment, "input");
    const draftSha256 = review.stages.treatment.currentDraft!.sha256;
    const checkIdentity = contentSha256("checked-treatment");
    review = recordCreativeReviewCheck(review, "treatment", {
      draftSha256, checkIdentity,
      verdict: "repair", score: 76, summary: "声音原则与上游冲突",
      issues: [{ severity: "blocking", criterion: "与已声明能力相容", evidence: "上游 visualPlan 采用同期环境声", repairInstruction: "二选一" }],
    });
    const command = {
      action: "confirm" as const, stage: "treatment" as const, commandId: "confirm-repair", actor: "creator",
      baseDraftSha256: draftSha256, expectedReviewRevision: review.reviewRevision,
      checkIdentity, confirmedAt: "2026-09-14T00:00:00.000Z",
    };
    // 默认仍然 fail-closed：不给显式确认就推不动，复核的提示不会被人无感跳过。
    assert.throws(() => confirmCreativeDraft(review, command), /requires a passing independent check/);
    // 显式承担后可以继续，并把被接受的意见留痕，供事后核查是谁在什么结论下放行的。
    const confirmed = confirmCreativeDraft(review, { ...command, acknowledgeRepair: true });
    assert.equal(confirmed.stages.treatment.phase, "confirmed");
    assert.deepEqual(confirmed.stages.treatment.confirmation?.acknowledgedRepair, {
      verdict: "repair", score: 76, issueCount: 1,
    });
    // 放宽只针对裁决本身，身份对不上仍然拒绝。
    assert.throws(
      () => confirmCreativeDraft(review, { ...command, acknowledgeRepair: true, baseDraftSha256: "0".repeat(64) }),
      /stale/,
    );
    assert.throws(
      () => confirmCreativeDraft(review, { ...command, acknowledgeRepair: true, checkIdentity: contentSha256("other") }),
      /requires an independent check/,
    );
  });
  it("waits without side effects and resumes exactly one confirmed stage at a time", async () => {
    const calls = { treatment: 0, script: 0, director: 0, audit: 0, compile: 0 };
    const rolePort = <T>(stage: "treatment" | "script" | "director", artifactId: string, output: T) =>
      async (context: Parameters<CreativePlanningPorts["treatment"]>[0]) => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.audit += 1;
          return {
            artifactId,
            output,
            reviewCheck: {
              audit: {
                version: "video-factory/role-audit-v2" as const,
                rubricVersion: "video-factory/role-quality-rubric-v1" as const,
                assessments: auditAssessments(92),
                verdict: "pass" as const,
                score: 92,
                summary: `${stage}可以继续`,
                issues: [],
                repairInstructions: [],
                planningDisposition: null,
                hostReadinessReview: null,
              },
              checkIdentity: contentSha256({ stage, output }),
            },
          };
        }
        calls[stage] += 1;
        return { artifactId, output };
      };
    const ports: CreativePlanningPorts = {
      treatment: rolePort("treatment", "treatment-1", treatment),
      screenwriter: rolePort("script", "script-1", script),
      director: rolePort("director", "director-1", director),
      compile: async (context) => {
        calls.compile += 1;
        return executablePlanCompilePort(context);
      },
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-review",
      inputDigest: "digest-review",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);

    const first = await runCreativePlanning(graph, { input, threadId });
    assert.equal(first.status, "waiting_user");
    if (first.status !== "waiting_user") return;
    assert.equal(first.gate.stage, "treatment");
    assert.deepEqual(calls, { treatment: 1, script: 0, director: 0, audit: 0, compile: 0 });

    const observed = await runCreativePlanning(graph, { input, threadId });
    assert.equal(observed.status, "waiting_user");
    assert.deepEqual(calls, { treatment: 1, script: 0, director: 0, audit: 0, compile: 0 });

    const second = await runCreativePlanning(graph, { input, threadId, resume: resume(first.gate, "confirm-treatment") });
    assert.equal(second.status, "waiting_user");
    if (second.status !== "waiting_user") return;
    assert.equal(second.gate.stage, "script");
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 0, audit: 1, compile: 0 });

    const third = await runCreativePlanning(graph, { input, threadId, resume: resume(second.gate, "confirm-script") });
    assert.equal(third.status, "waiting_user");
    if (third.status !== "waiting_user") return;
    assert.equal(third.gate.stage, "director");
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, audit: 2, compile: 0 });

    const completed = await runCreativePlanning(graph, { input, threadId, resume: resume(third.gate, "confirm-director") });
    assert.equal(completed.status, "completed");
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, audit: 3, compile: 1 });
  });

  it("records an explanation at the current gate without changing the draft or starting the next role", async () => {
    const calls = { treatment: 0, script: 0, discuss: 0 };
    const ports: CreativePlanningPorts = {
      treatment: async () => { calls.treatment += 1; return { artifactId: "treatment-discuss", output: treatment }; },
      screenwriter: async () => { calls.script += 1; return { artifactId: "script-unused", output: script }; },
      director: async () => ({ artifactId: "director-unused", output: director }),
      discuss: async (input) => {
        calls.discuss += 1;
        assert.equal(input.stage, "treatment");
        assert.equal(input.message, "为什么这样开场？");
        assert.deepEqual(input.currentDocument, treatment);
        return {
          stage: "treatment",
          intent: "explain",
          reply: "因为先展示差异，观众能立刻知道后面要解决什么。",
          changeSummary: [],
          treatment: null,
          script: null,
          director: null,
          upstreamRequest: null,
        };
      },
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-discuss",
      inputDigest: "digest-discuss",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const first = await runCreativePlanning(graph, { input, threadId });
    assert.equal(first.status, "waiting_user");
    if (first.status !== "waiting_user") return;

    const result = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "discuss",
        stage: "treatment",
        commandId: "discuss-treatment-1",
        actor: "creator",
        baseDraftSha256: first.gate.draft.sha256,
        expectedReviewRevision: first.gate.reviewRevision,
        message: "为什么这样开场？",
      },
    });

    assert.equal(result.status, "waiting_user");
    if (result.status !== "waiting_user") return;
    assert.equal(result.gate.draft.sha256, first.gate.draft.sha256);
    assert.deepEqual(calls, { treatment: 1, script: 0, discuss: 1 });
    assert.deepEqual(
      result.state.creativeReview?.stages.treatment.messages.map((message) => [message.role, message.text]),
      [
        ["user", "为什么这样开场？"],
        ["assistant", "因为先展示差异，观众能立刻知道后面要解决什么。"],
      ],
    );
  });

  it("keeps the same draft waiting when its confirmation check requests repair", async () => {
    const calls = { treatment: 0, audit: 0, script: 0 };
    const repairingAudit = {
      version: "video-factory/role-audit-v2" as const,
      rubricVersion: "video-factory/role-quality-rubric-v1" as const,
      assessments: auditAssessments(64),
      verdict: "repair" as const,
      score: 64,
      summary: "开头尚未兑现观众收益。",
      issues: [{
        severity: "blocking" as const,
        criterion: "前两秒有具体吸引点",
        evidence: "当前开头只有抽象提问。",
        repairInstruction: "把观众能立即看到的差异放到开头。",
      }],
      repairInstructions: ["把观众能立即看到的差异放到开头。"],
      planningDisposition: null,
      hostReadinessReview: null,
    };
    const ports: CreativePlanningPorts = {
      treatment: async (context) => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.audit += 1;
          throw new RoleAgentLoopError("当前方案需要修改。", {
            version: "video-factory/agent-loop-v1",
            role: "导演前期构思",
            contractVersion: "fixture-v1",
            criteria: ["前两秒有具体吸引点"],
            status: "failed",
            maxIterations: 1,
            iterations: [{
              iteration: 1,
              candidate: treatment,
              candidateHash: contentSha256(treatment),
              audit: repairingAudit,
            }],
          });
        }
        calls.treatment += 1;
        return { artifactId: "treatment-repair", output: treatment };
      },
      screenwriter: async () => {
        calls.script += 1;
        return { artifactId: "script-unused", output: script };
      },
      director: async () => ({ artifactId: "director-unused", output: director }),
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-repair-check",
      inputDigest: "digest-repair-check",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const first = await runCreativePlanning(graph, { input, threadId });
    assert.equal(first.status, "waiting_user");
    if (first.status !== "waiting_user") return;

    const checked = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(first.gate, "confirm-needs-repair"),
    });
    assert.equal(checked.status, "waiting_user");
    if (checked.status !== "waiting_user") return;
    assert.equal(checked.gate.stage, "treatment");
    assert.equal(checked.gate.draft.sha256, first.gate.draft.sha256);
    assert.equal(checked.gate.reviewRevision, first.gate.reviewRevision + 1);
    assert.deepEqual(calls, { treatment: 1, audit: 1, script: 0 });
    assert.equal(checked.state.creativeReview?.stages.treatment.checkResult?.verdict, "repair");
    assert.equal(checked.state.creativeReview?.stages.treatment.checkResult?.issues.length, 1);
  });

  it("keeps proposals separate, adopts without another model call, and can undo the adopted draft", async () => {
    const proposed = { ...treatment, payoff: "给出三步判断清单" };
    let discussCalls = 0;
    const ports: CreativePlanningPorts = {
      treatment: async () => ({ artifactId: "treatment-original", output: treatment }),
      screenwriter: async () => ({ artifactId: "script-unused", output: script }),
      director: async () => ({ artifactId: "director-unused", output: director }),
      discuss: async () => {
        discussCalls += 1;
        return {
          stage: "treatment",
          intent: "propose",
          reply: "我准备了一个更具体的结尾备选，当前方案还没有被替换。",
          changeSummary: ["结尾改为三步判断清单"],
          treatment: proposed,
          script: null,
          director: null,
          upstreamRequest: null,
        };
      },
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-proposal",
      inputDigest: "digest-proposal",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const first = await runCreativePlanning(graph, { input, threadId });
    assert.equal(first.status, "waiting_user");
    if (first.status !== "waiting_user") return;
    const proposalResult = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "discuss",
        stage: "treatment",
        commandId: "proposal-1",
        actor: "creator",
        baseDraftSha256: first.gate.draft.sha256,
        expectedReviewRevision: first.gate.reviewRevision,
        message: "给我一个更具体的结尾备选，但先不要替换。",
      },
    });
    assert.equal(proposalResult.status, "waiting_user");
    if (proposalResult.status !== "waiting_user") return;
    assert.equal(proposalResult.gate.draft.sha256, first.gate.draft.sha256);
    assert.equal(proposalResult.state.creativeReview?.stages.treatment.proposals.length, 1);

    const adopted = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "adopt_proposal",
        stage: "treatment",
        commandId: "adopt-1",
        actor: "creator",
        baseDraftSha256: proposalResult.gate.draft.sha256,
        expectedReviewRevision: proposalResult.gate.reviewRevision,
        proposalId: "proposal:proposal-1",
      },
    });
    assert.equal(adopted.status, "waiting_user");
    if (adopted.status !== "waiting_user") return;
    assert.equal(adopted.gate.draft.sha256, contentSha256(proposed));
    assert.equal(discussCalls, 1);

    const undone = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "undo_draft",
        stage: "treatment",
        commandId: "undo-1",
        actor: "creator",
        baseDraftSha256: adopted.gate.draft.sha256,
        expectedReviewRevision: adopted.gate.reviewRevision,
      },
    });
    assert.equal(undone.status, "waiting_user");
    if (undone.status !== "waiting_user") return;
    assert.equal(undone.gate.draft.sha256, first.gate.draft.sha256);
    assert.equal(discussCalls, 1);
    assert.deepEqual(undone.state.creativeReview?.stages.treatment.effectiveUserInstructions, []);
    const restored = await runCreativePlanning(graph, {
      input, threadId,
      resume: {
        action: "undo_draft", stage: "treatment", commandId: "restore-1", actor: "creator",
        baseDraftSha256: undone.gate.draft.sha256,
        expectedReviewRevision: undone.gate.reviewRevision,
      },
    });
    assert.equal(restored.status, "waiting_user");
    if (restored.status !== "waiting_user") return;
    assert.equal(restored.gate.draft.sha256, adopted.gate.draft.sha256);
    assert.deepEqual(restored.state.creativeReview?.stages.treatment.effectiveUserInstructions,
      adopted.state.creativeReview?.stages.treatment.effectiveUserInstructions);
    assert.equal(discussCalls, 1);
  });

  it("returns from director to the persisted script without a model call and regenerates only downstream after reconfirmation", async () => {
    const calls = { treatment: 0, script: 0, director: 0, checks: 0 };
    const rolePort = <T>(stage: "treatment" | "script" | "director", artifactId: string, output: T) =>
      async (context: Parameters<CreativePlanningPorts["treatment"]>[0]) => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.checks += 1;
          return {
            artifactId,
            output,
            reviewCheck: {
              audit: {
                version: "video-factory/role-audit-v2" as const,
                rubricVersion: "video-factory/role-quality-rubric-v1" as const,
                assessments: auditAssessments(95),
                verdict: "pass" as const,
                score: 95,
                summary: "可以继续",
                issues: [],
                repairInstructions: [],
                planningDisposition: null,
                hostReadinessReview: null,
              },
              checkIdentity: contentSha256({ stage, output }),
            },
          };
        }
        calls[stage] += 1;
        return { artifactId: `${artifactId}-${calls[stage]}`, output };
      };
    const graph = createCreativePlanningGraph({
      ports: {
        treatment: rolePort("treatment", "treatment", treatment),
        screenwriter: rolePort("script", "script", script),
        director: rolePort("director", "director", director),
        compile: executablePlanCompilePort,
      },
      checkpointer: new MemorySaver(),
    });
    const input = {
      runId: "run-return-script",
      inputDigest: "digest-return-script",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate.gate, "confirm-treatment-return") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate.gate, "confirm-script-return") });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, checks: 2 });

    const returned = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "return_to_stage",
        stage: "director",
        targetStage: "script",
        acknowledgeImpact: true,
        commandId: "return-to-script",
        actor: "creator",
        baseDraftSha256: directorGate.gate.draft.sha256,
        expectedReviewRevision: directorGate.gate.reviewRevision,
      },
    });
    assert.equal(returned.status, "waiting_user");
    if (returned.status !== "waiting_user") return;
    assert.equal(returned.gate.stage, "script");
    assert.equal(returned.gate.draft.sha256, scriptGate.gate.draft.sha256);
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, checks: 2 });
    assert.equal(returned.state.creativeReview?.stages.treatment.confirmation !== null, true);
    assert.equal(returned.state.creativeReview?.stages.script.confirmation, null);
    assert.equal(returned.state.creativeReview?.stages.director.confirmation, null);

    const regeneratedDirector = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(returned.gate, "reconfirm-script"),
    });
    assert.equal(regeneratedDirector.status, "waiting_user");
    if (regeneratedDirector.status !== "waiting_user") return;
    assert.equal(regeneratedDirector.gate.stage, "director");
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 2, checks: 3 });
  });

  it("carries the complete previous director plan and only the newly affected scenes through successive availability revisions", async () => {
    const fiveSceneScript = {
      ...script,
      duration_seconds: 25,
      scenes: Array.from({ length: 5 }, (_, index) => ({
        ...script.scenes[0]!,
        id: `scene-${index + 1}`,
        position: index + 1,
        duration: 5,
        purpose: `第${index + 1}段`,
        narration: `第${index + 1}段旁白`,
        visual_prompt: `第${index + 1}段画面`,
      })),
    };
    const plan = (generatedScenes: number[]) => ({
      ...director,
      shots: Array.from({ length: 5 }, (_, index) => ({
        ...director.shots[0]!,
        scenePosition: index + 1,
        deliveryType: generatedScenes.includes(index + 1) ? "generated_video" as const : "stock_video" as const,
        query: generatedScenes.includes(index + 1) ? "" : `stock scene ${index + 1}`,
        generationPrompt: `第${index + 1}镜画面`,
        temporalBeats: [{ startSeconds: 0, endSeconds: 5, action: `第${index + 1}镜动作` }],
      })),
    });
    const plans = [plan([]), plan([1, 2]), plan([1, 2, 4])];
    const directorContexts: Array<Parameters<CreativePlanningPorts["director"]>[0]> = [];
    let directorDraftCall = 0;
    const passingCheck = (stage: string, output: unknown) => ({
      audit: {
        version: "video-factory/role-audit-v2" as const,
        rubricVersion: "video-factory/role-quality-rubric-v1" as const,
        assessments: auditAssessments(92),
        verdict: "pass" as const,
        score: 92,
        summary: `${stage}可以继续`,
        issues: [],
        repairInstructions: [],
        planningDisposition: null,
        hostReadinessReview: null,
      },
      checkIdentity: contentSha256({ stage, output }),
    });
    const ports: CreativePlanningPorts = {
      treatment: async (context) => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "treatment", output: treatment, reviewCheck: passingCheck("treatment", treatment) }
        : { artifactId: "treatment", output: treatment },
      screenwriter: async (context) => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "script", output: fiveSceneScript, reviewCheck: passingCheck("script", fiveSceneScript) }
        : { artifactId: "script", output: fiveSceneScript },
      director: async (context) => {
        directorContexts.push(context);
        if (context.creativeReviewExecution?.mode === "check") {
          const output = context.integratedPlan?.output ?? context.directorPlan?.output;
          assert.ok(output, "director review must check the persisted current draft");
          return { artifactId: "director-checked", output, reviewCheck: passingCheck("director", output) };
        }
        const output = plans[Math.min(directorDraftCall, plans.length - 1)]!;
        directorDraftCall += 1;
        return { artifactId: `director-${directorDraftCall}`, output };
      },
      searchCandidates: async (context) => ({
        artifactId: `candidates-${directorDraftCall}`,
        output: {
          version: "video-factory/asset-candidates-v1" as const,
          scenes: context.directorPlan!.output.shots
            .filter((shot) => shot.deliveryType === "stock_video")
            .map((shot) => ({
              scenePosition: shot.scenePosition,
              intent: { narrativeRole: shot.narrativeRole },
              query: shot.query,
              candidates: [{
                provider: "provider-1", assetId: `asset-${shot.scenePosition}`, mediaType: "video" as const,
                width: 1920, height: 1080, duration: 8, previewUrl: "https://example.test/preview.jpg",
                sourceUrl: "https://example.test/source", creator: "fixture", licenseNote: "fixture",
                query: shot.query, qualityScore: 80,
              }],
            })),
        },
      }),
      rank: async (context) => ({
        artifactId: `ranking-${directorDraftCall}`,
        output: {
          version: "video-factory/asset-ranking-v1" as const,
          source: "model" as const,
          providerId: "ranker",
          modelId: "ranker-model",
          summary: "逐镜排序",
          scenes: context.candidates!.output.scenes.map((scene) => {
            const currentPlan = context.directorPlan!.output;
            const lowScoreScenes = currentPlan.shots[0]!.deliveryType === "stock_video"
              ? [1, 2]
              : currentPlan.shots[3]!.deliveryType === "stock_video" ? [4] : [];
            return {
            scenePosition: scene.scenePosition,
            summary: "可用",
            candidates: scene.candidates.map((candidate, index) => ({
              provider: candidate.provider, assetId: candidate.assetId, originalRank: index + 1, rank: index + 1,
              semanticScore: lowScoreScenes.includes(scene.scenePosition) ? 20 : 80, rationale: "匹配", locked: false,
            })),
            };
          }),
        },
      }),
      integrateDirector: async (context) => ({
        artifactId: "director-integrated",
        output: structuredClone(context.directorPlan!.output),
      }),
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-successive-availability",
      inputDigest: "digest-successive-availability",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate.gate, "confirm-treatment-availability") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate.gate, "confirm-script-availability") });

    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;
    assert.equal(directorGate.gate.stage, "director");
    const draftContexts = directorContexts.filter((context) => context.creativeReviewExecution?.mode !== "check");
    assert.equal(draftContexts.length, 3);
    assert.deepEqual(draftContexts[1]!.issues.flatMap((issue) => issue.scenePositions), [1, 2]);
    assert.deepEqual(draftContexts[2]!.issues.flatMap((issue) => issue.scenePositions), [4]);
    assert.deepEqual(draftContexts[1]!.directorPlan?.output, plans[0]);
    assert.deepEqual(draftContexts[2]!.directorPlan?.output, plans[1]);
    assert.equal(draftContexts[2]!.availabilityHistory.some((entry) => entry.scenePositions?.includes(1)), true);
    assert.equal(draftContexts[2]!.availabilityHistory.some((entry) => entry.scenePositions?.includes(4)), true);
    assert.equal(directorGate.state.creativeReview?.stages.director.currentDocument !== null, true);
  });

  it("rebuilds library evidence when director discussion changes a generated shot to stock", async () => {
    const stockDirector = {
      ...director,
      shots: [{
        ...director.shots[0]!,
        deliveryType: "stock_video" as const,
        query: "person comparing two visible results",
        generationPrompt: "",
      }],
    };
    const calls = { treatment: 0, script: 0, director: 0, check: 0, discuss: 0, candidates: 0, rank: 0, integrate: 0, compile: 0 };
    const passingCheck = (stage: string, output: unknown) => ({
      audit: {
        version: "video-factory/role-audit-v2" as const,
        rubricVersion: "video-factory/role-quality-rubric-v1" as const,
        assessments: auditAssessments(95),
        verdict: "pass" as const,
        score: 95,
        summary: `${stage}可以继续`,
        issues: [],
        repairInstructions: [],
        planningDisposition: null,
        hostReadinessReview: null,
      },
      checkIdentity: contentSha256({ stage, output }),
    });
    const ports: CreativePlanningPorts = {
      treatment: async (context) => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.check += 1;
          return { artifactId: "treatment", output: treatment, reviewCheck: passingCheck("treatment", treatment) };
        }
        calls.treatment += 1;
        return { artifactId: "treatment", output: treatment };
      },
      screenwriter: async (context) => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.check += 1;
          return { artifactId: "script", output: script, reviewCheck: passingCheck("script", script) };
        }
        calls.script += 1;
        return { artifactId: "script", output: script };
      },
      director: async (context) => {
        const output = context.integratedPlan?.output ?? context.directorPlan?.output ?? director;
        if (context.creativeReviewExecution?.mode === "check") {
          calls.check += 1;
          return { artifactId: "director", output, reviewCheck: passingCheck("director", output) };
        }
        calls.director += 1;
        return { artifactId: "director", output };
      },
      discuss: async () => {
        calls.discuss += 1;
        return {
          stage: "director",
          intent: "revise",
          reply: "已改为图库素材。",
          changeSummary: ["镜头 1 改为图库素材"],
          treatment: null,
          script: null,
          director: stockDirector,
          upstreamRequest: null,
        };
      },
      searchCandidates: async (context) => {
        calls.candidates += 1;
        return {
          artifactId: `candidates-${calls.candidates}`,
          output: {
            version: "video-factory/asset-candidates-v1" as const,
            scenes: context.directorPlan!.output.shots
              .filter((shot) => shot.deliveryType === "stock_video")
              .map((shot) => ({
                scenePosition: shot.scenePosition,
                intent: { narrativeRole: shot.narrativeRole },
                query: shot.query,
                candidates: [{
                  provider: "provider-1",
                  assetId: `asset-${shot.scenePosition}`,
                  mediaType: "video" as const,
                  width: 1920,
                  height: 1080,
                  duration: 24,
                  previewUrl: "https://example.test/preview.jpg",
                  sourceUrl: "https://example.test/source",
                  creator: "fixture",
                  licenseNote: "fixture",
                  query: shot.query,
                  qualityScore: 80,
                }],
              })),
          },
        };
      },
      rank: async (context) => {
        calls.rank += 1;
        return {
          artifactId: `ranking-${calls.rank}`,
          output: {
            version: "video-factory/asset-ranking-v1" as const,
            source: "model" as const,
            providerId: "ranker",
            modelId: "ranker-model",
            summary: "逐镜排序",
            scenes: context.candidates!.output.scenes.map((scene) => ({
              scenePosition: scene.scenePosition,
              summary: "可用",
              candidates: scene.candidates.map((candidate, index) => ({
                provider: candidate.provider,
                assetId: candidate.assetId,
                originalRank: index + 1,
                rank: index + 1,
                semanticScore: 80,
                rationale: "匹配",
                locked: false,
              })),
            })),
          },
        };
      },
      integrateDirector: async (context) => {
        calls.integrate += 1;
        return { artifactId: `integrated-${calls.integrate}`, output: structuredClone(context.directorPlan!.output) };
      },
      compile: async (context) => {
        calls.compile += 1;
        return executablePlanCompilePort(context);
      },
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-director-route-change",
      inputDigest: "digest-director-route-change",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate.gate, "confirm-treatment-route-change") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate.gate, "confirm-script-route-change") });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;

    const revised = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "discuss",
        stage: "director",
        commandId: "change-to-stock",
        actor: "creator",
        baseDraftSha256: directorGate.gate.draft.sha256,
        expectedReviewRevision: directorGate.gate.reviewRevision,
        message: "把这个镜头改为图库素材。",
      },
    });
    assert.equal(revised.status, "waiting_user");
    if (revised.status !== "waiting_user") return;
    const afterConfirmation = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(revised.gate, "confirm-stock-route"),
    });

    assert.equal(afterConfirmation.status, "waiting_user", "rebuilt evidence is reviewed before compilation");
    assert.deepEqual(calls, {
      treatment: 1,
      script: 1,
      director: 1,
      check: 3,
      discuss: 1,
      candidates: 2,
      rank: 2,
      integrate: 2,
      compile: 0,
    });
    assert.deepEqual(afterConfirmation.state.artifactIds.candidates, ["candidates-2"]);
    assert.deepEqual(afterConfirmation.state.artifactIds.rank, ["ranking-2"]);

    const completed = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(afterConfirmation.gate, "confirm-rebuilt-stock-evidence"),
    });
    assert.equal(completed.status, "completed");
    const config = { configurable: { thread_id: threadId } };
    const validState = (await graph.getState(config)).values;
    await graph.updateState(config, {
      directorPlan: { artifactId: "director-discussion-stock", output: stockDirector },
      candidatesArtifact: {
        artifactId: "candidates-stale-generated-route",
        output: { version: "video-factory/asset-candidates-v1", scenes: [] },
      },
      candidateSearchFingerprint: candidateSearchFingerprint(director),
      ranking: null,
      rankingInputFingerprint: null,
      integratedPlan: null,
      executablePlan: validState.executablePlan,
    }, "compile");

    const recovered = await runCreativePlanning(graph, { input, threadId });
    assert.equal(recovered.status, "waiting_user", "a poisoned completed checkpoint must rebuild missing library evidence");
    assert.equal(calls.candidates, 3);
    assert.equal(calls.rank, 3);
    assert.equal(calls.integrate, 3);
    assert.equal(calls.compile, 1, "recovery must not compile before rebuilt evidence is reviewed");
  });

  it("keeps a user-confirmed stock route when library candidates are unavailable", async () => {
    const stockDirector = {
      ...director,
      shots: [{
        ...director.shots[0]!,
        deliveryType: "stock_video" as const,
        query: "person comparing two visible results",
        generationPrompt: "",
      }],
    };
    let directorDraftCalls = 0;
    let discussionCalls = 0;
    const passingCheck = (stage: string, output: unknown) => ({
      audit: {
        version: "video-factory/role-audit-v2" as const,
        rubricVersion: "video-factory/role-quality-rubric-v1" as const,
        assessments: auditAssessments(95),
        verdict: "pass" as const,
        score: 95,
        summary: `${stage}可以继续`,
        issues: [],
        repairInstructions: [],
        planningDisposition: null,
        hostReadinessReview: null,
      },
      checkIdentity: contentSha256({ stage, output }),
    });
    const ports: CreativePlanningPorts = {
      treatment: async (context) => ({
        artifactId: "treatment",
        output: treatment,
        ...(context.creativeReviewExecution?.mode === "check"
          ? { reviewCheck: passingCheck("treatment", treatment) }
          : {}),
      }),
      screenwriter: async (context) => ({
        artifactId: "script",
        output: script,
        ...(context.creativeReviewExecution?.mode === "check"
          ? { reviewCheck: passingCheck("script", script) }
          : {}),
      }),
      director: async (context) => {
        const output = context.integratedPlan?.output ?? context.directorPlan?.output ?? director;
        if (context.creativeReviewExecution?.mode === "check") {
          return { artifactId: "director", output, reviewCheck: passingCheck("director", output) };
        }
        directorDraftCalls += 1;
        if (directorDraftCalls > 1) {
          throw new Error("A confirmed director route must not be rewritten automatically.");
        }
        return { artifactId: "director", output };
      },
      discuss: async () => {
        discussionCalls += 1;
        const useStock = discussionCalls === 1;
        return {
          stage: "director",
          intent: "revise",
          reply: useStock ? "已按你的要求改为图库素材。" : "已按新要求改为生成素材。",
          changeSummary: [useStock ? "镜头 1 改为图库素材" : "镜头 1 改为生成素材"],
          treatment: null,
          script: null,
          director: useStock ? stockDirector : director,
          upstreamRequest: null,
        };
      },
      searchCandidates: async (context) => ({
        artifactId: "candidates",
        output: {
          version: "video-factory/asset-candidates-v1" as const,
          scenes: context.directorPlan!.output.shots
            .filter((shot) => shot.deliveryType === "stock_video")
            .map((shot) => ({
              scenePosition: shot.scenePosition,
              intent: { narrativeRole: shot.narrativeRole },
              query: shot.query,
              candidates: [{
                provider: "provider-1",
                assetId: "asset-1",
                mediaType: "video" as const,
                width: 1920,
                height: 1080,
                duration: 24,
                previewUrl: "https://example.test/preview.jpg",
                sourceUrl: "https://example.test/source",
                creator: "fixture",
                licenseNote: "fixture",
                query: shot.query,
                qualityScore: 80,
              }],
            })),
        },
      }),
      rank: async (context) => ({
        artifactId: "ranking",
        output: {
          version: "video-factory/asset-ranking-v1" as const,
          source: "model" as const,
          providerId: "ranker",
          modelId: "ranker-model",
          summary: "逐镜排序",
          scenes: context.candidates!.output.scenes.map((scene) => ({
            scenePosition: scene.scenePosition,
            summary: "候选与确认方案不匹配",
            candidates: scene.candidates.map((candidate, index) => ({
              provider: candidate.provider,
              assetId: candidate.assetId,
              originalRank: index + 1,
              rank: index + 1,
              semanticScore: 20,
              rationale: "不满足确认要求",
              locked: false,
            })),
          })),
        },
      }),
      integrateDirector: async (context) => ({
        artifactId: "integrated",
        output: structuredClone(context.directorPlan!.output),
      }),
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-confirmed-stock-unavailable",
      inputDigest: "digest-confirmed-stock-unavailable",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
    const scriptGate = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(treatmentGate.gate, "confirm-treatment-stock-unavailable"),
    });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
    const directorGate = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(scriptGate.gate, "confirm-script-stock-unavailable"),
    });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;

    const revised = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "discuss",
        stage: "director",
        commandId: "require-stock-route",
        actor: "creator",
        baseDraftSha256: directorGate.gate.draft.sha256,
        expectedReviewRevision: directorGate.gate.reviewRevision,
        message: "这个镜头必须保留图库路线；找不到时先回来告诉我，不要改成生成。",
      },
    });
    assert.equal(revised.status, "waiting_user");
    if (revised.status !== "waiting_user") return;
    const unavailable = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(revised.gate, "confirm-required-stock-route"),
    });

    assert.equal(unavailable.status, "waiting_user");
    if (unavailable.status !== "waiting_user") return;
    assert.equal(unavailable.gate.stage, "director");
    assert.equal(directorDraftCalls, 1, "availability failure must not invoke an automatic director rewrite");
    assert.equal(unavailable.gate.draft.sha256, contentSha256(stockDirector));
    assert.equal(unavailable.state.issues[0]?.target, "source");

    const adjusted = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "discuss",
        stage: "director",
        commandId: "allow-generated-route",
        actor: "creator",
        baseDraftSha256: unavailable.gate.draft.sha256,
        expectedReviewRevision: unavailable.gate.reviewRevision,
        message: "现在允许改成生成素材，但继续保留其它要求。",
      },
    });
    assert.equal(adjusted.status, "waiting_user");
    if (adjusted.status !== "waiting_user") return;
    assert.equal(adjusted.gate.draft.sha256, contentSha256(director));
    assert.deepEqual(adjusted.state.issues, [], "issues for the replaced draft must not remain current");
  });
});
