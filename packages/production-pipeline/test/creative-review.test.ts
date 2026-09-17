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
  runRoleAgentLoop,
  type AvailabilityReviewer,
  type CreativePlanningPorts,
  type CreativeReviewGate,
  type CreativeTreatment,
} from "../src/index.js";
import { planningThreadId } from "../src/creative-planning-store.js";
import { initialCreativeReviewState, publishCreativeDraft, recordCreativeDiscussion, applyCreativeReviewDeterministicCommand, applyCreativeReviewEditDraft, recordCreativeReviewCheck, confirmCreativeDraft, creativeReturnTargets, returnCreativeReviewToStage, parseCreativeReviewResume } from "../src/creative-review.js";

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
  it("swaps in a hand-edited draft as a new revision, clearing the old check binding", () => {
    // 人工修订与 AI 修订走同一条制度：换稿即新一版草稿（revision+1、sha256 按新文档重算、
    // checkResult/confirmation 清空、上一稿入 previousDraft 槽）。旧复核意见不能继续绑在新稿上，
    // 之后的确认必须对改后的稿重新跑一轮独立复核。
    let review = publishCreativeDraft(initialCreativeReviewState(), "treatment", "treatment", treatment, "input");
    review = recordCreativeReviewCheck(review, "treatment", {
      draftSha256: review.stages.treatment.currentDraft!.sha256,
      checkIdentity: "check-1",
      verdict: "repair",
      score: 55,
      summary: "开场不够直接",
      issues: [{ severity: "blocking", criterion: "开场", evidence: "铺垫太长", repairInstruction: "直接给冲突" }],
    });
    const before = review.stages.treatment;
    assert.equal(before.checkResult?.verdict, "repair");

    const edited = structuredClone(treatment);
    edited.hook.narrationIntent = "第一句就给冲突";
    const gate: CreativeReviewGate = {
      kind: "creative_review",
      stage: "treatment",
      reviewRevision: review.reviewRevision,
      draft: review.stages.treatment.currentDraft!,
    };
    const editResume = {
      action: "edit_draft" as const,
      stage: "treatment" as const,
      commandId: "edit-1",
      actor: "creator",
      baseDraftSha256: gate.draft.sha256,
      expectedReviewRevision: review.reviewRevision,
      document: edited,
    };
    review = applyCreativeReviewEditDraft(review, editResume, edited);

    const after = review.stages.treatment;
    assert.equal(after.phase, "waiting_user");
    assert.deepEqual(after.currentDocument, edited, "当前稿件必须是修订后的这一份");
    assert.equal(after.currentDraft!.sha256, contentSha256(edited), "草稿摘要必须随内容重算");
    assert.equal(after.currentDraft!.revision, before.currentDraft!.revision + 1);
    assert.equal(after.checkResult, null, "旧复核意见不得继续绑在新稿上");
    assert.equal(after.confirmation, null);
    assert.deepEqual(after.previousDocument, treatment);
    assert.equal(review.reviewRevision, gate.reviewRevision + 1);
    assert.ok(after.effectiveUserInstructions.some((instruction) => instruction.commandId === "edit-1"));

    // 旧稿摘要再来一次必须被拒：修订只能基于人当前看到的那一版（版本或摘要任一过期都算）。
    assert.throws(
      () => applyCreativeReviewEditDraft(review, { ...editResume, baseDraftSha256: gate.draft.sha256 }, edited),
      /stale/,
    );

    // parse 侧：document 缺失或不是对象必须被拒；未知字段同样拒绝。
    assert.throws(
      () => parseCreativeReviewResume({ ...editResume, document: undefined }),
      /requires a document object/,
    );
    assert.throws(
      () => parseCreativeReviewResume({ ...editResume, document: [edited] }),
      /requires a document object/,
    );
    assert.throws(
      () => parseCreativeReviewResume({ ...editResume, extra: 1 }),
      /field 'extra' is not allowed/,
    );
    const parsed = parseCreativeReviewResume(editResume);
    assert.equal(parsed.action, "edit_draft");
  });

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
  it("names the three creative stages the way the creator sees them, at every stop", () => {
    // 创作规划三段只有一套用户可见名字：treatment=前期构思、script=脚本、director=导演方案。
    // 这里逐段钉住回退提示里的说法。曾经 treatment 被叫成"导演方案"、director 被叫成"分镜与
    // 画面方案"，于是同一个停点的标题和影响提示各说各的名字，人不知道自己确认的是哪一份东西。
    const confirmedStage = (
      review: ReturnType<typeof initialCreativeReviewState>,
      stage: "treatment" | "script" | "director",
      document: unknown,
    ) => {
      const published = publishCreativeDraft(review, stage, stage, document, "input");
      const draftSha256 = published.stages[stage].currentDraft!.sha256;
      const checkIdentity = contentSha256(`checked-${stage}`);
      const checked = recordCreativeReviewCheck(published, stage, {
        draftSha256, checkIdentity, verdict: "pass", score: 90, summary: "可继续", issues: [],
      });
      return confirmCreativeDraft(checked, {
        action: "confirm", stage, commandId: `confirm-${stage}`, actor: "creator",
        baseDraftSha256: draftSha256,
        expectedReviewRevision: checked.reviewRevision,
        checkIdentity,
        confirmedAt: "2026-09-14T00:00:00.000Z",
      });
    };
    let review = initialCreativeReviewState();
    review = confirmedStage(review, "treatment", treatment);
    review = confirmedStage(review, "script", script);
    // 回退发生在导演讲完了、人还没确认的那个停点上，所以导演阶段停在 waiting_user。
    review = publishCreativeDraft(review, "director", "director", director, "input");
    const returnTo = (targetStage: "treatment" | "script") => returnCreativeReviewToStage(review, {
      action: "return_to_stage",
      stage: "director",
      commandId: `return-${targetStage}`,
      actor: "creator",
      baseDraftSha256: review.stages.director.currentDraft!.sha256,
      expectedReviewRevision: review.reviewRevision,
      targetStage,
      acknowledgeImpact: true,
    });

    const backToTreatment = returnTo("treatment").stages.treatment.messages.at(-1)!.text;
    assert.match(backToTreatment, /^已返回前期构思。/);
    assert.match(backToTreatment, /脚本、导演方案及其后续确认已失效/);
    // "分镜"是导演方案里的镜头，不是任何阶段的阶段名；它出现在这一段就说明名字又串了。
    assert.equal(backToTreatment.includes("分镜"), false);

    const backToScript = returnTo("script").stages.script.messages.at(-1)!.text;
    assert.match(backToScript, /^已返回脚本。/);
    assert.match(backToScript, /前期构思确认保留，导演方案及其后续确认已失效/);
    assert.equal(backToScript.includes("分镜"), false);

    assert.deepEqual(creativeReturnTargets(review), ["treatment", "script", "director"]);
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
  it("lets the creator override a repair verdict at the graph gate, and records which verdict was overridden", async () => {
    const calls = { treatment: 0, audit: 0, script: 0, director: 0 };
    // 每一轮独立复核都给 repair：这正是"模型说不行、人说了算"要验的场景。
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
                assessments: auditAssessments(76),
                verdict: "repair" as const,
                score: 76,
                summary: `${stage}还有意见`,
                issues: [{
                  severity: "blocking" as const,
                  criterion: "与已声明能力相容",
                  evidence: "上游采用同期环境声",
                  repairInstruction: "二选一",
                }],
                repairInstructions: ["二选一"],
                planningDisposition: null,
                hostReadinessReview: null,
              },
              checkIdentity: contentSha256({ stage, output, round: calls.audit }),
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
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-review-override",
      inputDigest: "digest-review-override",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);

    const first = await runCreativePlanning(graph, { input, threadId });
    assert.equal(first.status, "waiting_user");
    if (first.status !== "waiting_user") return;

    // 确认之后复核给 repair：不是 run failed，而是带着这条意见停在人面前。
    const advised = await runCreativePlanning(graph, { input, threadId, resume: resume(first.gate, "confirm-advised") });
    assert.equal(advised.status, "waiting_user");
    if (advised.status !== "waiting_user") return;
    assert.equal(advised.gate.stage, "treatment");
    assert.equal(advised.state.creativeReview!.stages.treatment.checkResult?.verdict, "repair");
    assert.equal(advised.state.creativeReview!.stages.treatment.phase, "waiting_user");
    assert.equal(calls.script, 0, "意见没有通过之前不许进入下一阶段");

    // 「看过意见，仍然确认」必须真的放行：否则人只能在同一条意见上无限重试，
    // 决策权就还在模型手里。放行用的就是他已经看过的那一条复核，不另跑一轮。
    const auditsBeforeOverride = calls.audit;
    const recorded = advised.state.creativeReview!.stages.treatment.checkResult!;
    const overridden = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        ...resume(advised.gate, "confirm-override"),
        acknowledgeRepair: true,
        checkIdentity: recorded.checkIdentity,
      },
    });
    assert.equal(calls.audit, auditsBeforeOverride, "人已经承担过的意见不重跑复核");
    assert.equal(overridden.status, "waiting_user");
    if (overridden.status !== "waiting_user") return;
    assert.equal(overridden.gate.stage, "script", "承担之后要真的进入下一阶段");
    // 放行要留痕：事后必须查得出"是谁在哪条裁决下按的确认"。
    assert.deepEqual(overridden.state.creativeReview!.stages.treatment.confirmation?.acknowledgedRepair, {
      verdict: "repair", score: 76, issueCount: 1,
    });
  });

  it("refuses to rebind an acknowledgement onto a review the creator never saw", async () => {
    const calls = { audit: 0 };
    const rolePort = <T>(artifactId: string, output: T) =>
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
                assessments: auditAssessments(76),
                verdict: "repair" as const,
                score: 76,
                summary: "还有意见",
                issues: [{
                  severity: "blocking" as const,
                  criterion: "与已声明能力相容",
                  evidence: "上游采用同期环境声",
                  repairInstruction: "二选一",
                }],
                repairInstructions: ["二选一"],
                planningDisposition: null,
                hostReadinessReview: null,
              },
              checkIdentity: contentSha256({ round: calls.audit }),
            },
          };
        }
        return { artifactId, output };
      };
    const ports: CreativePlanningPorts = {
      treatment: rolePort("treatment-1", treatment),
      screenwriter: rolePort("script-1", script),
      director: rolePort("director-1", director),
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-review-stale",
      inputDigest: "digest-review-stale",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);

    const first = await runCreativePlanning(graph, { input, threadId });
    if (first.status !== "waiting_user") throw new Error("expected a treatment gate");
    const advised = await runCreativePlanning(graph, { input, threadId, resume: resume(first.gate, "confirm-advised") });
    if (advised.status !== "waiting_user") throw new Error("expected a repair stop");
    const recorded = advised.state.creativeReview!.stages.treatment.checkResult!;
    const auditsBefore = calls.audit;

    // 旧页面：这一版复核已经被换过一轮，它带着旧编号提交"仍然确认"。
    await assert.rejects(
      () => runCreativePlanning(graph, {
        input,
        threadId,
        resume: {
          ...resume(advised.gate, "confirm-stale-revision"),
          acknowledgeRepair: true,
          checkIdentity: recorded.checkIdentity,
          expectedReviewRevision: advised.gate.reviewRevision - 1,
        },
      }),
      /已经不是当前这一条/,
    );
    // 编号对不上：人确认的是他没看过的那一条意见。
    await assert.rejects(
      () => runCreativePlanning(graph, {
        input,
        threadId,
        resume: {
          ...resume(advised.gate, "confirm-stale-identity"),
          acknowledgeRepair: true,
          checkIdentity: contentSha256({ stage: "treatment", advice: "never-shown" }),
        },
      }),
      /已经不是当前这一条/,
    );
    assert.equal(calls.audit, auditsBefore, "被拒的确认不能偷偷再跑一轮复核");
  });
  // 「默认只审计一轮」这条承诺的证据就在这里：下面的 audit 计数在每次确认后只涨 1，且不确认的
  // 观察调用一次都不涨。改动复核回路时这两个事实必须同时成立——多涨一次是偷偷加审，不涨是复核
  // 被跳过了。
  it("waits without side effects, runs exactly one independent audit per confirmation, and resumes one stage at a time", async () => {
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
    // 只是重新看一眼停点，不能再跑一轮复核。
    assert.deepEqual(calls, { treatment: 1, script: 0, director: 0, audit: 0, compile: 0 });

    const second = await runCreativePlanning(graph, { input, threadId, resume: resume(first.gate, "confirm-treatment") });
    assert.equal(second.status, "waiting_user");
    if (second.status !== "waiting_user") return;
    assert.equal(second.gate.stage, "script");
    // 一次确认 = 一轮复核：audit 从 0 到 1，不多不少。
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

// 自动循环停下说的是"我推不动了"，不是"这个作品不行"。有创作确认关时它必须收成一个等人决定的
// 停点：角色这一轮已经产出的候选以草稿身份发布出去，停下的理由一起带到人眼前，人确认就继续、
// 要改就就地改。让它以 run failed 收场，等于让模型替人下了判决——治理不变量「任何审计都不能
// 判定成功或失败，只有人能」拦的正是这件事。
describe("自动循环停下时把决定交还给人", () => {
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

  // 直接构造 RoleAgentPlanningHaltError 会把"生产里到底抛出什么"变成测试的假设，所以这里跑
  // 真的角色循环：审计给出 needs_user 处置时它中止这一轮，把候选与审计一起抛出来。
  const haltingTreatment = (key: string): CreativePlanningPorts["treatment"] => async (context) => {
    if (context.creativeReviewExecution?.mode === "check") {
      return { artifactId: "treatment", output: treatment, reviewCheck: passingCheck("treatment", treatment) };
    }
    await runRoleAgentLoop<CreativeTreatment>({
      role: "导演前期构思",
      planningRole: true,
      contractVersion: "creative-treatment-planning-disposition-v1",
      criteria: ["核心真实承诺必须有来源"],
      maxIterations: 3,
      checkpoint: { key, load: async () => undefined, save: async () => undefined },
      produce: async () => ({ output: treatment }),
      audit: async () => ({ output: {
        version: "video-factory/role-audit-v2" as const,
        rubricVersion: "video-factory/role-quality-rubric-v1" as const,
        verdict: "repair" as const,
        score: 91,
        assessments: [{ targetPath: "", dimensions: auditAssessments(91)[0]!.dimensions }],
        summary: "创作表达完整，但锁定的真实实测承诺只有用户能决定是否改",
        issues: [{
          severity: "blocking" as const,
          criterion: "事实来源",
          evidence: "当前输入没有专属实验记录，现有图库和生成能力不能证明真实结果",
          repairInstruction: "请补充真实实验记录，或由用户确认改变承诺",
        }],
        repairInstructions: ["补充真实实验记录"],
        planningDisposition: { action: "needs_user" as const, issueIndexes: [0] },
      } }),
      validate: (value) => value as CreativeTreatment,
    });
    throw new Error("needs_user 处置必须中止这一轮构思，测试替身不应走到这里。");
  };

  it("角色级的 needs_user 停在构思确认关等人，确认后照常进入脚本", async () => {
    const ports: CreativePlanningPorts = {
      treatment: haltingTreatment("creative-treatment-needs-user"),
      screenwriter: async (context) => ({
        artifactId: "script",
        output: script,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("script", script) } : {}),
      }),
      director: async (context) => ({
        artifactId: "director",
        output: director,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("director", director) } : {}),
      }),
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = {
      runId: "run-role-needs-user-halt",
      inputDigest: "digest-role-needs-user-halt",
      durationRange: { minSeconds: 20, maxSeconds: 30 },
      creativeReview: CREATIVE_REVIEW_FEATURE,
    };
    const threadId = planningThreadId(input.runId, input.inputDigest);

    const stop = await runCreativePlanning(graph, { input, threadId });
    assert.equal(stop.status, "waiting_user", "自动循环停下必须停在人面前，而不是把整条制作判失败");
    if (stop.status !== "waiting_user") return;
    assert.equal(stop.gate.stage, "treatment");
    assert.equal(stop.state.planningStop?.reason, "needs_user");
    assert.match(stop.state.planningStop?.detail ?? "", /独立审计确认继续需要用户决定/);
    assert.deepEqual(stop.state.issues.map((issue) => issue.target), ["user"]);
    // 角色这一轮的产出以草稿身份发出去，并登记成这一步的产物：人看到的是"这一步做完了，
    // 有件事只有你能定"，而不是一个连产物都没有的失败节点。
    assert.equal(stop.state.artifactIds.treatment?.length, 1);
    assert.equal(stop.state.creativeReview?.stages.treatment.phase, "waiting_user");
    assert.deepEqual(stop.state.creativeReview?.stages.treatment.currentDocument, treatment);

    const advanced = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(stop.gate, "confirm-treatment-needs-user"),
    });
    assert.equal(advanced.status, "waiting_user");
    if (advanced.status !== "waiting_user") return;
    // 确认就是放行：照常走到脚本确认关，而不是在原处再停一遍。
    assert.equal(advanced.gate.stage, "script");
    assert.equal(advanced.state.planningStop, undefined, "人做过决定之后，停下的理由不能再跟着走");
  });

  it("复检级的 needs_user 停在导演确认关等人，并让已确认的方案继续走到编译", async () => {
    const stockDirector = {
      ...director,
      shots: [{
        ...director.shots[0]!,
        deliveryType: "stock_video" as const,
        query: "person comparing two visible results",
        generationPrompt: "",
      }],
    };
    const ports: CreativePlanningPorts = {
      treatment: async (context) => ({
        artifactId: "treatment",
        output: treatment,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("treatment", treatment) } : {}),
      }),
      screenwriter: async (context) => ({
        artifactId: "script",
        output: script,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("script", script) } : {}),
      }),
      director: async (context) => {
        const output = context.integratedPlan?.output ?? context.directorPlan?.output ?? stockDirector;
        return context.creativeReviewExecution?.mode === "check"
          ? { artifactId: "director", output, reviewCheck: passingCheck("director", output) }
          : { artifactId: "director", output };
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
                provider: "provider-1", assetId: "asset-1", mediaType: "video" as const,
                width: 1920, height: 1080, duration: 24,
                previewUrl: "https://example.test/preview.jpg", sourceUrl: "https://example.test/source",
                creator: "fixture", licenseNote: "fixture", query: shot.query, qualityScore: 80,
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
            summary: "可用",
            candidates: scene.candidates.map((candidate, index) => ({
              provider: candidate.provider, assetId: candidate.assetId,
              originalRank: index + 1, rank: index + 1,
              semanticScore: 80, rationale: "匹配", locked: false,
            })),
          })),
        },
      }),
      integrateDirector: async (context) => ({
        artifactId: "director-integrated",
        output: structuredClone(context.directorPlan!.output),
      }),
      compile: executablePlanCompilePort,
    };
    // 只有用户能解决的问题：第一轮停下等人，之后不再重复上报。
    let reported = false;
    const reviewer: AvailabilityReviewer = () => {
      if (reported) return [];
      reported = true;
      return [{
        id: "issue-needs-user",
        target: "user",
        beatIds: [],
        scenePositions: [1],
        reason: "这条画面要求会改变你已锁定的承诺",
        requiredChange: "请你决定是否改口径",
        evidenceArtifactIds: [],
      }];
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver(), availabilityReviewer: reviewer });
    const input = {
      runId: "run-evaluate-needs-user-halt",
      inputDigest: "digest-evaluate-needs-user-halt",
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
      resume: resume(treatmentGate.gate, "confirm-treatment-evaluate-halt"),
    });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;

    const stop = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(scriptGate.gate, "confirm-script-evaluate-halt"),
    });
    assert.equal(stop.status, "waiting_user", "复检停下必须停在导演确认关，而不是把整条制作判失败");
    if (stop.status !== "waiting_user") return;
    assert.equal(stop.gate.stage, "director");
    assert.equal(stop.state.planningStop?.reason, "needs_user");
    assert.deepEqual(stop.state.creativeReview?.stages.director.currentDocument, stockDirector);

    const afterDecision = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(stop.gate, "confirm-director-evaluate-halt"),
    });
    // 人确认之后自动循环继续跑下去，走到下一个正常的确认关（整合方案复检），而不是又停在
    // 同一个停点上、也不是以失败收场。停下的理由已经作废，不能跟着走到这一步。
    assert.equal(afterDecision.status, "waiting_user");
    if (afterDecision.status !== "waiting_user") return;
    assert.equal(afterDecision.gate.stage, "director");
    assert.equal(afterDecision.state.planningStop, undefined);
    assert.deepEqual(afterDecision.state.artifactIds.integrate?.length, 1, "确认后必须真的走过整合，而不是原地打转");
    assert.notEqual(afterDecision.gate.reviewRevision, stop.gate.reviewRevision, "这是一次新的确认，不是原来那一次");

    const completed = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(afterDecision.gate, "confirm-integrated-director-plan"),
    });
    // 这条制作不是被审计否掉的，是被人的决定放行的；编译照常完成。
    assert.equal(completed.status, "completed");
  });
});
