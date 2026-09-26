import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withAuditOperationBinding } from "../src/index.js";
import type { CreativePlanningContext } from "../src/index.js";
import type { AssetCandidateReport } from "../src/asset-semantic-ranker.js";
import { describe, it } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import {
  CREATIVE_REVIEW_FEATURE,
  candidateSearchFingerprint,
  contentSha256,
  createCreativePlanningGraph,
  executablePlanCompilePort,
  RoleAgentLoopError,
  CodexBridgeError,
  runCreativePlanning,
  runRoleAgentLoop,
  type AvailabilityReviewer,
  type CreativePlanningPorts,
  type CreativeReviewGate,
  type CreativeTreatment,
  type VisualDirectorPlan,
} from "../src/index.js";
import { planningThreadId } from "../src/creative-planning-store.js";
import { ReworkScopeConflictError } from "../src/generative-asset-worker.js";
import { initialCreativeReviewState, publishCreativeDraft, recordCreativeDiscussion, applyCreativeReviewDeterministicCommand, applyCreativeReviewEditDraft, recordCreativeReviewCheck, confirmCreativeDraft, creativeReturnTargets, creativeReviewGate, returnCreativeReviewToStage, parseCreativeReviewResume } from "../src/creative-review.js";

// 构思、脚本、导演方案都是创作交付：宿主规定的评估对象是当前完整候选（根路径 ""），
// 维度固定为 attention/progression/payoff/expression。全部分数取同一个值，
// 好让 score 恰好等于最低维度分这个归约成立。
const CREATIVE_AUDIT_DIMENSIONS = ["attention", "progression", "payoff", "expression"] as const;

function reviewedCandidates(report: AssetCandidateReport) {
  return { reportDigest: createHash("sha256").update(JSON.stringify(report)).digest("hex"), supplementaryBatches: 0 as const,
    reviewed: report.scenes.flatMap(scene => scene.candidates.map(candidate => ({
      scenePosition: scene.scenePosition, provider: candidate.provider, assetId: candidate.assetId, sha256: "a".repeat(64),
    }))) };
}

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

function resume(
  outcome: {
    gate: CreativeReviewGate;
    state: { creativeReview?: ReturnType<typeof initialCreativeReviewState> };
  },
  commandId: string,
) {
  const gate = outcome.gate;
  // 提交的就是这个停点展示给用户的那一条复核身份；拿不到说明夹具没走到已审停点。
  const identity = outcome.state.creativeReview?.stages[gate.stage]?.checkResult?.checkIdentity;
  if (!identity) throw new Error(`fixture: stage ${gate.stage} has no recorded check to confirm`);
  return {
    action: "confirm" as const,
    stage: gate.stage,
    commandId,
    actor: "creator",
    baseDraftSha256: gate.draft.sha256,
    expectedReviewRevision: gate.reviewRevision,
    checkIdentity: identity,
    confirmedAt: "2026-09-14T00:00:00.000Z",
  };
}

describe("初稿审一次的版本与动作合同", () => {
  function publishWithCheck(stage: "treatment" | "script" | "director", output: unknown, score: number) {
    let review = initialCreativeReviewState();
    review = publishCreativeDraft(review, stage, `${stage}-artifact`, output, `${stage}-input`);
    const auditId = `${stage}-audit-1`;
    review = recordCreativeReviewCheck(review, stage, {
      versionId: review.stages[stage].currentDraft!.versionId,
      auditId,
      draftSha256: review.stages[stage].currentDraft!.sha256,
      checkIdentity: contentSha256({ stage, sha: review.stages[stage].currentDraft!.sha256 }),
      verdict: "pass",
      score,
      summary: "可执行",
      issues: [],
    });
    return { review, auditId };
  }

  it("为每版稿件分配不可变 versionId：同内容重发不复用版本，A→B→A 各自独立", () => {
    let review = initialCreativeReviewState();
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "in-1");
    const v1 = review.stages.treatment.currentDraft!.versionId;
    assert.ok(v1, "初稿必须有 versionId");
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "in-1");
    assert.equal(review.stages.treatment.currentDraft!.versionId, v1, "同一内容同一输入不换版");
    const changed = { ...treatment, payoff: "换一个结尾" };
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", changed, "in-1");
    const v2 = review.stages.treatment.currentDraft!.versionId;
    assert.notEqual(v2, v1, "内容变化必须产生新版本");
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "in-1");
    const v3 = review.stages.treatment.currentDraft!.versionId;
    assert.notEqual(v3, v1, "A→B→A 的第三版不是第一版");
    assert.notEqual(v3, v2);
  });

  it("手工保存、采用备选与恢复旧稿都生成新版本，旧审计不能跟随", () => {
    const base = publishCreativeDraft(initialCreativeReviewState(), "treatment", "treatment-artifact", treatment, "in-1");
    const firstVersion = base.stages.treatment.currentDraft!.versionId;
    const editedDocument = { ...treatment, payoff: "手工修改结尾" };
    const edited = applyCreativeReviewEditDraft(base, {
      action: "edit_draft", stage: "treatment", commandId: "manual-v2", actor: "creator",
      baseDraftSha256: base.stages.treatment.currentDraft!.sha256,
      expectedReviewRevision: base.reviewRevision, document: editedDocument,
    }, editedDocument);
    const secondVersion = edited.stages.treatment.currentDraft!.versionId;
    assert.notEqual(secondVersion, firstVersion);
    const restored = applyCreativeReviewDeterministicCommand(edited, {
      action: "undo_draft", stage: "treatment", commandId: "restore-v3", actor: "creator",
      baseDraftSha256: edited.stages.treatment.currentDraft!.sha256,
      expectedReviewRevision: edited.reviewRevision,
    });
    assert.notEqual(restored.stages.treatment.currentDraft!.versionId, firstVersion);
    assert.notEqual(restored.stages.treatment.currentDraft!.versionId, secondVersion);
    assert.equal(restored.stages.treatment.checkResult, null);

    const proposedDocument = { ...treatment, payoff: "备选结尾" };
    const proposed = recordCreativeDiscussion(base, {
      action: "discuss", stage: "treatment", commandId: "propose-v2", actor: "creator",
      message: "提出备选", baseDraftSha256: base.stages.treatment.currentDraft!.sha256,
      expectedReviewRevision: base.reviewRevision,
    }, {
      stage: "treatment", intent: "propose", reply: "这是备选", changeSummary: [],
      treatment: proposedDocument, script: null, director: null, upstreamRequest: null,
    });
    const adopted = applyCreativeReviewDeterministicCommand(proposed, {
      action: "adopt_proposal", stage: "treatment", commandId: "adopt-v2", actor: "creator",
      proposalId: "proposal:propose-v2", baseDraftSha256: proposed.stages.treatment.currentDraft!.sha256,
      expectedReviewRevision: proposed.reviewRevision,
    });
    assert.notEqual(adopted.stages.treatment.currentDraft!.versionId, firstVersion);
    assert.equal(adopted.stages.treatment.checkResult, null);
  });

  it("连续多次修订后仍能回看每版全文和当时的采用决定", () => {
    let review = publishCreativeDraft(initialCreativeReviewState(), "treatment", "treatment-artifact", treatment, "in-1");
    const versions = [review.stages.treatment.currentDraft!.versionId];
    for (const payoff of ["第一稿修改", "第二稿修改", "第三稿修改"]) {
      const document = { ...treatment, payoff };
      review = applyCreativeReviewEditDraft(review, {
        action: "edit_draft", stage: "treatment", commandId: `edit-${versions.length}`, actor: "creator",
        baseDraftSha256: review.stages.treatment.currentDraft!.sha256,
        expectedReviewRevision: review.reviewRevision, document,
      }, document);
      versions.push(review.stages.treatment.currentDraft!.versionId);
    }
    assert.deepEqual(review.stages.treatment.versionHistory.map((entry) => entry.draft.versionId), versions);
    assert.deepEqual(review.stages.treatment.versionHistory.map((entry) => (entry.document as typeof treatment).payoff), [
      treatment.payoff, "第一稿修改", "第二稿修改", "第三稿修改",
    ]);
    const gate = creativeReviewGate(review, "treatment");
    review = confirmCreativeDraft(review, {
      action: "confirm", stage: "treatment", commandId: "adopt-latest", actor: "creator",
      baseDraftSha256: gate.draft.sha256, expectedReviewRevision: gate.reviewRevision,
      acknowledgeUnaudited: true, confirmedAt: "2026-09-24T00:00:00.000Z",
    });
    assert.equal(review.stages.treatment.confirmationHistory[0]?.versionId, versions.at(-1));
  });

  it("审计记录绑定 versionId：V1 的审计不能回挂到同文字的 V3（B03）", () => {
    let review = initialCreativeReviewState();
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "in-1");
    const v1 = review.stages.treatment.currentDraft!;
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", { ...treatment, payoff: "B 结尾" }, "in-1");
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "in-1");
    const v3 = review.stages.treatment.currentDraft!;
    assert.equal(v3.sha256, v1.sha256, "夹具前提：V3 与 V1 文字相同");
    assert.notEqual(v3.versionId, v1.versionId, "夹具前提：版本 id 不同");
    assert.throws(() => recordCreativeReviewCheck(review, "treatment", {
      versionId: v1.versionId,
      auditId: "audit-v1",
      draftSha256: v1.sha256,
      checkIdentity: contentSha256({ late: true }),
      verdict: "pass",
      score: 90,
      summary: "迟到的 V1 审计",
      issues: [],
    }), /version/);
  });

  it("同版可多次审计并全部留痕：checkResult 取最新，auditHistory 完整（A05）", () => {
    let review = initialCreativeReviewState();
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "in-1");
    const versionId = review.stages.treatment.currentDraft!.versionId;
    const sha = review.stages.treatment.currentDraft!.sha256;
    review = recordCreativeReviewCheck(review, "treatment", {
      versionId, auditId: "audit-1", draftSha256: sha, checkIdentity: contentSha256({ n: 1 }),
      verdict: "repair", score: 70, summary: "第一轮意见", issues: [],
    });
    review = recordCreativeReviewCheck(review, "treatment", {
      versionId, auditId: "audit-2", draftSha256: sha, checkIdentity: contentSha256({ n: 2 }),
      verdict: "pass", score: 88, summary: "第二轮通过", issues: [],
    });
    assert.equal(review.stages.treatment.checkResult!.auditId, "audit-2");
    assert.equal(review.stages.treatment.auditHistory.length, 2);
    assert.deepEqual(review.stages.treatment.auditHistory.map((record) => record.auditId), ["audit-1", "audit-2"]);
    for (let index = 3; index <= 12; index += 1) {
      review = recordCreativeReviewCheck(review, "treatment", {
        versionId, auditId: `audit-${index}`, draftSha256: sha,
        checkIdentity: contentSha256({ n: index }), verdict: "pass", score: 88,
        summary: `第 ${index} 次审计`, issues: [],
      });
    }
    assert.equal(review.stages.treatment.auditHistory.length, 12, "历史不能在第十一轮被静默截断");
  });

  it("未审修订必须显式承认才能采用，且决定记为未审采用（A04）", () => {
    const { review } = publishWithCheck("treatment", treatment, 90);
    const gate = creativeReviewGate(review, "treatment");
    // 修订：发布新版本，清掉本版审计。
    const revised = publishCreativeDraft(review, "treatment", "treatment-artifact", { ...treatment, payoff: "修订结尾" }, "in-1");
    const revisedGate = creativeReviewGate(revised, "treatment");
    assert.equal(revised.stages.treatment.checkResult, null, "修订后本版未审");
    // 不承认未审就确认：拒绝。
    assert.throws(() => confirmCreativeDraft(revised, {
      action: "confirm", stage: "treatment", commandId: "c1", actor: "creator",
      baseDraftSha256: revisedGate.draft.sha256, expectedReviewRevision: revisedGate.reviewRevision,
      confirmedAt: "2026-09-24T00:00:00.000Z",
    }), /未审|unaudited|独立/);
    // 显式承认未审：确认成功，决定不带 checkIdentity、不虚构 pass。
    const confirmed = confirmCreativeDraft(revised, {
      action: "confirm", stage: "treatment", commandId: "c2", actor: "creator",
      baseDraftSha256: revisedGate.draft.sha256, expectedReviewRevision: revisedGate.reviewRevision,
      acknowledgeUnaudited: true, confirmedAt: "2026-09-24T00:00:01.000Z",
    });
    const confirmation = confirmed.stages.treatment.confirmation!;
    assert.equal(confirmation.versionId, revised.stages.treatment.currentDraft!.versionId);
    assert.equal(confirmation.auditId, null);
    assert.equal(confirmation.unauditedAdoption, true);
    assert.equal(confirmation.checkIdentity, undefined);
    void gate;
  });

  it("已审初稿确认时绑定当时的版本与审计身份（A06）", () => {
    const { review, auditId } = publishWithCheck("treatment", treatment, 90);
    const gate = creativeReviewGate(review, "treatment");
    const confirmed = confirmCreativeDraft(review, {
      action: "confirm", stage: "treatment", commandId: "c3", actor: "creator",
      baseDraftSha256: gate.draft.sha256, expectedReviewRevision: gate.reviewRevision,
      checkIdentity: review.stages.treatment.checkResult!.checkIdentity,
      confirmedAt: "2026-09-24T00:00:02.000Z",
    });
    const confirmation = confirmed.stages.treatment.confirmation!;
    assert.equal(confirmation.versionId, review.stages.treatment.currentDraft!.versionId);
    assert.equal(confirmation.auditId, auditId);
    assert.equal(confirmation.unauditedAdoption, undefined);
  });

  it("主动审计是一个独立的一等动作（parseCreativeReviewResume）", () => {
    const parsed = parseCreativeReviewResume({
      action: "audit_current", stage: "treatment", commandId: "c4", actor: "creator",
      baseDraftSha256: "a".repeat(64), expectedReviewRevision: 3,
    });
    assert.equal(parsed.action, "audit_current");
    assert.throws(() => parseCreativeReviewResume({ action: "audit_current" }), /stage is invalid/);
    // 缺 commandId / revision 等身份字段同样拒绝。
    assert.throws(() => parseCreativeReviewResume({ action: "audit_current", stage: "treatment" }), /commandId|expectedReviewRevision/);
  });
});

describe("three-stage creative review gates", () => {
  it("does not offer unaudited adoption while the original audit request is still unknown", async () => {
    const graph = createCreativePlanningGraph({ checkpointer: new MemorySaver(), ports: {
      treatment: async context => {
        if (context.creativeReviewExecution?.mode === "check") {
          throw new RoleAgentLoopError("original audit is still being observed", {
            version: "video-factory/agent-loop-v1", role: "构思", contractVersion: "test", criteria: [],
            status: "failed", maxIterations: 1, iterations: [], failure: { stage: "uncertain" },
          }, undefined, new CodexBridgeError("still observing", false, "uncertain"));
        }
        return { artifactId: "treatment", output: treatment };
      },
      screenwriter: async () => ({ artifactId: "script", output: script }),
      director: async () => ({ artifactId: "director", output: director }),
      compile: executablePlanCompilePort,
    } });
    const input = { runId: "unknown-audit", inputDigest: "unknown-audit", durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    await assert.rejects(
      runCreativePlanning(graph, { input, threadId: planningThreadId(input.runId, input.inputDigest) }),
      (error: unknown) => error instanceof RoleAgentLoopError && error.sourceError instanceof CodexBridgeError
        && error.sourceError.stage === "uncertain",
    );
  });

  // R11-V02（r12b 余项）：旧操作绑定的 uncertain 异常进入新操作时，图执行 rejection
  // 边界拿到的必须是原异常对象本体——图层若把它复制成同类型、同消息、同 sourceError
  // 的新对象再抛出，本用例的引用同一性断言会失败。调用边界经生产
  // withAuditOperationBinding（与装配层同一入口），不导出私有审计函数。
  it("propagates the original old-bound uncertain exception object at the graph rejection boundary (R11-V02)", async () => {
    const staleUncertain = new RoleAgentLoopError("旧操作未决异常", {
      version: "video-factory/agent-loop-v1", role: "构思", contractVersion: "test", criteria: [],
      status: "failed", maxIterations: 1, iterations: [], failure: { stage: "uncertain" },
    }, undefined, new CodexBridgeError("旧操作仍在观察原请求", false, "uncertain"));
    const oldOperationId = "old-uncertain-operation-graph-v1";
    await assert.rejects(
      withAuditOperationBinding(oldOperationId, async () => { throw staleUncertain; }),
      (error: unknown) => error === staleUncertain,
    );
    assert.equal((staleUncertain as unknown as { auditOperationId?: string }).auditOperationId, oldOperationId);

    const graph = createCreativePlanningGraph({ checkpointer: new MemorySaver(), ports: {
      treatment: async context => {
        if (context.creativeReviewExecution?.mode === "check") {
          // 模拟装配层的调用边界：新操作身份经生产 helper 包裹角色调用；
          // 已绑定旧操作的异常按 guard 原样上抛，交由图层 uncertain 优先分支传播。
          return await withAuditOperationBinding(
            context.creativeReviewExecution.auditOperationId ?? "(initial)",
            async (): Promise<never> => { throw staleUncertain; },
          );
        }
        return { artifactId: "treatment", output: treatment };
      },
      screenwriter: async () => ({ artifactId: "script", output: script }),
      director: async () => ({ artifactId: "director", output: director }),
      compile: executablePlanCompilePort,
    } });
    const input = { runId: "old-bound-uncertain", inputDigest: "old-bound-uncertain", durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    await assert.rejects(
      runCreativePlanning(graph, { input, threadId: planningThreadId(input.runId, input.inputDigest) }),
      (error: unknown) => error === staleUncertain,
      "图执行边界必须原样交还旧操作绑定的 uncertain 异常对象",
    );
    assert.equal((staleUncertain as unknown as { auditOperationId?: string }).auditOperationId,
      oldOperationId, "旧绑定在图执行后保持");
    assert.ok(staleUncertain.sourceError instanceof CodexBridgeError
      && staleUncertain.sourceError.stage === "uncertain", "sourceError 引用与 uncertain 状态保持");
  });

  it("rejects an audit result for different draft bytes before binding it to the current version", async () => {
    const otherTreatment = { ...treatment, payoff: "另一份稿件的结尾" };
    const graph = createCreativePlanningGraph({ checkpointer: new MemorySaver(), ports: {
      treatment: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "other", output: otherTreatment, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: "wrong-draft-audit", audit: {
            version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass", score: 90, summary: "另一份稿件可用", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "treatment", output: treatment },
      screenwriter: async () => ({ artifactId: "script", output: script }),
      director: async () => ({ artifactId: "director", output: director }),
      compile: executablePlanCompilePort,
    } });
    const input = { runId: "wrong-draft-audit", inputDigest: "wrong-draft-audit", durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    await assert.rejects(
      runCreativePlanning(graph, { input, threadId: planningThreadId(input.runId, input.inputDigest) }),
      /different draft|稿件.*不一致/,
    );
  });

  it("lets the creator adopt a valid draft after a settled check failure without inventing a score", async () => {
    let checks = 0;
    const graph = createCreativePlanningGraph({ checkpointer: new MemorySaver(), ports: {
      treatment: async context => {
        if (context.creativeReviewExecution?.mode === "check") {
          checks++;
          throw new RoleAgentLoopError("model completed without output", {
            version: "video-factory/agent-loop-v1", role: "构思", contractVersion: "test", criteria: [], status: "failed", maxIterations: 3, iterations: [],
            failure: { stage: "completed_failure" },
          }, undefined, new CodexBridgeError("completed", false, "completed_failure", 502, "model_provider_no_output"));
        }
        return { artifactId: "treatment", output: treatment };
      },
      screenwriter: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "script", output: script, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: contentSha256({ stage: "script", round: "fixture" }), audit: {
            version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "script", output: script }, director: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "director", output: director, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: contentSha256({ stage: "director", round: "fixture" }), audit: {
            version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "director", output: director },
      compile: executablePlanCompilePort,
      validateEditedDraft: (_stage, value) => { assert.deepEqual(value, treatment); },
    } });
    const input = { runId: "settled-review", inputDigest: "settled-review", durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    // 新合同：初稿停点自带审计结果。审计腿已核清失败 → 本版「未取得结论」已在停点呈现。
    const first = await runCreativePlanning(graph, { input, threadId });
    if (first.status !== "waiting_user") throw new Error("missing gate");
    const result = first.state.creativeReview!.stages.treatment.checkResult!;
    assert.equal(result.status, "incomplete");
    assert.equal(result.score, undefined);
    assert.equal(checks, 1);
    const accepted = await runCreativePlanning(graph, { input, threadId, resume: {
      ...resume(first, "accept-incomplete"), checkIdentity: result.checkIdentity, acknowledgeIncomplete: true,
    } });
    assert.equal(accepted.status, "waiting_user");
    if (accepted.status === "waiting_user") assert.equal(accepted.gate.stage, "script");
    assert.equal(checks, 1);
    assert.equal(accepted.state.creativeReview!.stages.treatment.confirmation!.acknowledgedIncomplete, true);
  });
  for (const legacyStop of [false, true]) it(`lets the creator accept low-quality illustrative stock without rewriting or rescoring it (legacy=${legacyStop})`, async () => {
    const stockDirector: VisualDirectorPlan = structuredClone(director);
    stockDirector.shots[0] = { ...stockDirector.shots[0]!, deliveryType: "stock_video", query: "illustration" };
    let searches = 0;
    let ranks = 0;
    let drafts = 0;
    const checked = <T>(output: T, ctx?: CreativePlanningContext) => ({ artifactId: contentSha256(output), output, reviewCheck: { auditOperationId: (ctx?.creativeReviewExecution?.mode === "check" ? ctx.creativeReviewExecution.auditOperationId : undefined) ?? "fixture-op",
      checkIdentity: contentSha256(output), audit: { version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1" as const, verdict: "pass" as const, score: 90, summary: "可执行", issues: [], repairInstructions: [], assessments: auditAssessments(90) },
    } });
    const graph = createCreativePlanningGraph({ checkpointer: new MemorySaver(), ports: {
      treatment: async (context) => checked(treatment, context), screenwriter: async (context) => checked(script, context),
      director: async (context) => { if (context.creativeReviewExecution?.mode !== "check") drafts++; return checked(context.directorPlan?.output ?? stockDirector, context); },
      searchCandidates: async () => { searches++; return { artifactId: "candidates", output: {
        version: "video-factory/asset-candidates-v1", scenes: [{ scenePosition: 1, query: "illustration", intent: {}, candidates: [{
          provider: "provider-1", assetId: "low", mediaType: "video", width: 1080, height: 1920, duration: 24,
          previewUrl: "https://example.test/low.jpg", sourceUrl: "https://example.test/low", creator: "fixture", licenseNote: "test", query: "illustration", qualityScore: 60,
        }] }],
      } }; },
      rank: async () => { ranks++; return { artifactId: "ranking", output: {
        version: "video-factory/asset-ranking-v1", source: "model", providerId: "ranker", modelId: "ranker",
        summary: "候选得分偏低，视觉核验未完成", scenes: [{ scenePosition: 1, summary: "低分", candidates: [{
          provider: "provider-1", assetId: "low", originalRank: 1, rank: 1, semanticScore: 20, rationale: "匹配一般", locked: false,
        }] }],
      } }; },
      integrateDirector: async (context) => ({ artifactId: "integrated", output: structuredClone(context.directorPlan!.output) }),
      discuss: async () => ({ stage: "director", intent: "explain", reply: "只解释，不改画面", changeSummary: [], treatment: null, script: null, director: null, upstreamRequest: null }),
      compile: executablePlanCompilePort,
    } });
    const input = { runId: "playable-first", inputDigest: "playable-first", durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    let outcome = await runCreativePlanning(graph, { input, threadId });
    for (const stage of ["treatment", "script"] as const) {
      assert.equal(outcome.status, "waiting_user");
      if (outcome.status !== "waiting_user") throw new Error("missing user gate");
      assert.equal(outcome.gate.stage, stage);
      outcome = await runCreativePlanning(graph, { input, threadId, resume: resume(outcome, `confirm-${stage}`) });
    }
    assert.equal(outcome.status, "waiting_user");
    if (outcome.status !== "waiting_user") throw new Error("missing director gate");
    assert.equal(outcome.gate.purpose, "direction");
    assert.equal(searches, 0);
    outcome = await runCreativePlanning(graph, { input, threadId, resume: resume(outcome, "confirm-direction") });
    assert.equal(outcome.status, "waiting_user");
    if (outcome.status !== "waiting_user") throw new Error("missing material plan gate");
    assert.equal(outcome.gate.purpose, "material_plan");
    if (legacyStop) await graph.updateState({ configurable: { thread_id: threadId } }, { integratedPlan: null, manualDirectorReview: true }, "evaluate");
    outcome = await runCreativePlanning(graph, { input, threadId, resume: {
      action: "discuss", stage: "director", commandId: "explain-stock", actor: "creator", message: "解释当前候选",
      baseDraftSha256: outcome.gate.draft.sha256, expectedReviewRevision: outcome.gate.reviewRevision,
    } });
    if (outcome.status !== "waiting_user") throw new Error("explanation must preserve the gate");
    outcome = await runCreativePlanning(graph, { input, threadId, resume: resume(outcome, "without-stock-consent") });
    assert.equal(outcome.status, "waiting_user", "质量建议不能自动转为采用授权");
    if (outcome.status !== "waiting_user") throw new Error("missing quality consent gate");
    assert.match(outcome.state.planningStop!.detail, /质量|匹配/);
    const accepted = await runCreativePlanning(graph, { input, threadId, resume: {
      ...resume(outcome, "accept-current-stock"), acceptQualityFallback: true,
    } });
    assert.equal(accepted.status, "completed");
    assert.equal(searches, 1);
    assert.equal(ranks, 1);
    assert.equal(drafts, 1);
    const saved = (await graph.getState({ configurable: { thread_id: threadId } })).values;
    assert.equal(saved.ranking.output.scenes[0].candidates[0].semanticScore, 20);
    assert.equal(saved.ranking.output.scenes[0].candidates[0].locked, false);
    assert.ok(saved.creativeReview.stages.director.confirmation.deliveryAcceptance.scopeDigest);
  });
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
    review = recordCreativeDiscussion(review, { ...command("revision"), action: "revise", message: "只调整语气，保留其它内容" }, {
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

  it("does not apply a model's unsolicited rewrite to a discussion-only command (B01)", () => {
    const original = publishCreativeDraft(initialCreativeReviewState(), "treatment", "treatment", treatment, "input");
    const draft = original.stages.treatment.currentDraft!;
    const reply = recordCreativeDiscussion(original, {
      action: "discuss", stage: "treatment", commandId: "explain-only", actor: "creator",
      baseDraftSha256: draft.sha256, expectedReviewRevision: original.reviewRevision,
      message: "解释这个开场，不要改稿",
    }, {
      stage: "treatment", intent: "revise", reply: "我建议换个开场", changeSummary: ["开场调整"],
      treatment: { ...treatment, payoff: "模型越权写入" }, script: null, director: null, upstreamRequest: null,
    });
    assert.equal(reply.stages.treatment.currentDraft?.versionId, draft.versionId);
    assert.deepEqual(reply.stages.treatment.currentDocument, treatment);
    assert.match(reply.stages.treatment.messages.at(-1)?.text ?? "", /未修改|未采用/);
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
      // 新合同区分「没有本版审计」（走未审采用）与「带的复核身份对不上」；后者是陈旧确认。
      /not the one the creator saw/,
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
            reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
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

    // 初稿审计给 repair：不是 run failed，而是初稿停点直接带着这条意见停在人面前（S3）。
    const advised = first;
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
        ...resume(advised, "confirm-override"),
        acknowledgeRepair: true,
        checkIdentity: recorded.checkIdentity,
      },
    });
    // 放行后 audit 恰好多 1：那是脚本阶段自己的「初稿审一次」（A01），不是当前节点的重复审计。
    assert.equal(calls.audit, auditsBeforeOverride + 1);
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
            reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
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
    // 初稿停点自带 repair 审计（S3）：陈旧确认的防线在第一次交互前就已就位。
    const advised = first;
    const recorded = advised.state.creativeReview!.stages.treatment.checkResult!;
    const auditsBefore = calls.audit;

    // 旧页面：这一版复核已经被换过一轮，它带着旧编号提交"仍然确认"。
    await assert.rejects(
      () => runCreativePlanning(graph, {
        input,
        threadId,
        resume: {
          ...resume(advised, "confirm-stale-revision"),
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
          ...resume(advised, "confirm-stale-identity"),
          acknowledgeRepair: true,
          checkIdentity: contentSha256({ stage: "treatment", advice: "never-shown" }),
        },
      }),
      /已经不是当前这一条/,
    );
    assert.equal(calls.audit, auditsBefore, "被拒的确认不能偷偷再跑一轮复核");
  });
  // 「每版初稿只审计一次」这条承诺的证据就在这里：audit 计数在每次初稿发布（节点产稿）后恰好多 1，
  // 不确认的观察调用一次都不涨，确认本身不再补审。改动复核回路时这些事实必须同时成立——
  // 多涨一次是偷偷加审，不涨是复核被跳过了。
  it("waits without side effects, runs exactly one independent audit per draft publication, and resumes one stage at a time", async () => {
    const calls = { treatment: 0, script: 0, director: 0, audit: 0, compile: 0 };
    const rolePort = <T>(stage: "treatment" | "script" | "director", artifactId: string, output: T) =>
      async (context: Parameters<CreativePlanningPorts["treatment"]>[0]) => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.audit += 1;
          return {
            artifactId,
            output,
            reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
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
    // 初稿审计随初稿发布完成：停点第一次出现时意见已经在场（S3）。
    assert.deepEqual(calls, { treatment: 1, script: 0, director: 0, audit: 1, compile: 0 });

    const observed = await runCreativePlanning(graph, { input, threadId });
    assert.equal(observed.status, "waiting_user");
    // 只是重新看一眼停点，不能再跑一轮复核。
    assert.deepEqual(calls, { treatment: 1, script: 0, director: 0, audit: 1, compile: 0 });

    const second = await runCreativePlanning(graph, { input, threadId, resume: resume(first, "confirm-treatment") });
    assert.equal(second.status, "waiting_user");
    if (second.status !== "waiting_user") return;
    assert.equal(second.gate.stage, "script");
    // 确认零模型调用；audit+1 是脚本阶段自己的初稿审计（A01/A04）。
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 0, audit: 2, compile: 0 });

    const third = await runCreativePlanning(graph, { input, threadId, resume: resume(second, "confirm-script") });
    assert.equal(third.status, "waiting_user");
    if (third.status !== "waiting_user") return;
    assert.equal(third.gate.stage, "director");
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, audit: 3, compile: 0 });

    const completed = await runCreativePlanning(graph, { input, threadId, resume: resume(third, "confirm-director") });
    assert.equal(completed.status, "completed");
    // 终审确认不再补审：audit 停在 3。
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, audit: 3, compile: 1 });
  });

  it("keeps an out-of-scope model script as an unadopted proposal at the human gate", async () => {
    const changedScript = structuredClone(script);
    changedScript.scenes[0]!.visual_prompt = "改成未经批准的新画面";
    let scriptAudits = 0;
    const ports: CreativePlanningPorts = {
      treatment: async (context) => ({ artifactId: "treatment-scope", output: treatment,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          audit: { version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1" as const,
            assessments: auditAssessments(90), verdict: "pass" as const, score: 90, summary: "构思可继续", issues: [],
            repairInstructions: [], planningDisposition: null, hostReadinessReview: null },
          checkIdentity: contentSha256({ stage: "treatment", draft: contentSha256(treatment) }),
        } } : {}) }),
      screenwriter: async (context) => {
        if (context.creativeReviewExecution?.mode === "check") scriptAudits += 1;
        return { artifactId: "script-scope-candidate", output: changedScript };
      },
      director: async () => ({ artifactId: "director-scope", output: director }),
      compile: executablePlanCompilePort,
      reworkBaseline: { script: { artifactId: "script-scope-original", output: script } },
      validateEditedDraft: (stage, document) => {
        if (stage === "script" && (document as typeof script).scenes[0]?.visual_prompt !== script.scenes[0]?.visual_prompt) {
          throw new ReworkScopeConflictError("镜头 1 超出批准范围", [1]);
        }
      },
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = { runId: "run-scope-proposal", inputDigest: "scope-proposal", durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const first = await runCreativePlanning(graph, { input, threadId });
    assert.equal(first.status, "waiting_user");
    if (first.status !== "waiting_user") return;
    const second = await runCreativePlanning(graph, { input, threadId, resume: resume(first, "confirm-treatment-scope") });
    assert.equal(second.status, "waiting_user");
    if (second.status !== "waiting_user") return;
    assert.equal(second.gate.stage, "script");
    assert.deepEqual(second.state.creativeReview?.stages.script.currentDocument, script, "approved baseline stays current");
    assert.deepEqual(second.state.creativeReview?.stages.script.proposals[0]?.document, changedScript);
    assert.equal(second.state.creativeReview?.stages.script.checkResult, null);
    assert.equal(scriptAudits, 0, "out-of-scope proposal is not independently audited as an adoptable draft");
    assert.match(second.state.planningStop?.detail ?? "", /镜头 1/);
  });

  it("keeps an out-of-scope model director plan separate from the approved baseline", async () => {
    const changedDirector = structuredClone(director);
    changedDirector.visualBible.pacing = "未经批准的全片加速";
    let directorAudits = 0;
    const rolePort = <T>(stage: "treatment" | "script" | "director", artifactId: string, output: T) =>
      async (context: Parameters<CreativePlanningPorts["treatment"]>[0]) => ({
        artifactId, output,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          audit: { version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1" as const,
            assessments: auditAssessments(90), verdict: "pass" as const, score: 90,
            summary: `${stage}可继续`, issues: [], repairInstructions: [], planningDisposition: null, hostReadinessReview: null },
          checkIdentity: contentSha256({ stage, draft: contentSha256(output) }),
        } } : {}),
      });
    const ports: CreativePlanningPorts = {
      treatment: rolePort("treatment", "treatment-director-scope", treatment),
      screenwriter: rolePort("script", "script-director-scope", script),
      director: async (context) => {
        if (context.creativeReviewExecution?.mode === "check") directorAudits += 1;
        return { artifactId: "director-scope-candidate", output: changedDirector };
      },
      compile: executablePlanCompilePort,
      reworkBaseline: { director: { artifactId: "director-scope-original", output: director } },
      validateEditedDraft: (stage, document) => {
        if (stage === "director" && (document as typeof director).visualBible.pacing !== director.visualBible.pacing) {
          throw new ReworkScopeConflictError("全片视觉节奏超出批准范围", [1]);
        }
      },
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = { runId: "run-director-scope", inputDigest: "director-scope", durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    const threadId = planningThreadId(input.runId, input.inputDigest);
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate, "confirm-treatment-director-scope") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate, "confirm-script-director-scope") });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;
    assert.equal(directorGate.gate.stage, "director");
    assert.deepEqual(directorGate.state.creativeReview?.stages.director.currentDocument, director);
    assert.deepEqual(directorGate.state.creativeReview?.stages.director.proposals[0]?.document, changedDirector);
    assert.equal(directorAudits, 0);
    assert.equal(directorGate.state.scopeConflict?.proposalId, directorGate.state.creativeReview?.stages.director.proposals[0]?.proposalId);
  });

  it("records an explanation at the current gate without changing the draft or starting the next role", async () => {
    const calls = { treatment: 0, script: 0, discuss: 0 };
    const ports: CreativePlanningPorts = {
      treatment: async context => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.treatment += 1;
          return { artifactId: "treatment-discuss", output: treatment, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
            checkIdentity: contentSha256({ stage: "treatment", round: "fixture" }), audit: {
              version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
              verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
            },
          } };
        }
        calls.treatment += 1;
        return { artifactId: "treatment-discuss", output: treatment };
      },
      screenwriter: async () => { calls.script += 1; return { artifactId: "script-unused", output: script }; },
      director: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "director-unused", output: director, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: contentSha256({ stage: "director", round: "fixture" }), audit: {
            version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "director-unused", output: director },
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
    // treatment=2：一次产稿 + 一次初稿独立审计（S3）；讨论本身零产稿、零新审计。
    assert.deepEqual(calls, { treatment: 2, script: 0, discuss: 1 });
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
          const loopError = new RoleAgentLoopError("当前方案需要修改。", {
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
          // 模拟装配层 withAuditOperationBinding：异常标记其产生时的操作身份。
          (loopError as { auditOperationId?: string }).auditOperationId =
            context.creativeReviewExecution?.mode === "check"
              ? context.creativeReviewExecution.auditOperationId
              : "fixture-op";
          throw loopError;
        }
        calls.treatment += 1;
        return { artifactId: "treatment-repair", output: treatment };
      },
      screenwriter: async () => {
        calls.script += 1;
        return { artifactId: "script-unused", output: script };
      },
      director: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "director-unused", output: director, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: contentSha256({ stage: "director", round: "fixture" }), audit: {
            version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "director-unused", output: director },
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
    // 初稿审计给 repair：停点直接带着意见，稿件原位等待，不进下一阶段（S3）。
    assert.equal(first.state.creativeReview?.stages.treatment.checkResult?.verdict, "repair");
    assert.equal(first.state.creativeReview?.stages.treatment.checkResult?.issues.length, 1);
    assert.deepEqual(calls, { treatment: 1, audit: 1, script: 0 });
    // 没有显式承担的普通确认推不动：意见仍由人处理。
    await assert.rejects(
      () => runCreativePlanning(graph, { input, threadId, resume: resume(first, "confirm-needs-repair") }),
      /独立复核对本版有意见/,
    );
    assert.deepEqual(calls, { treatment: 1, audit: 1, script: 0 });
  });

  it("keeps proposals separate, adopts without another model call, and can undo the adopted draft", async () => {
    const proposed = { ...treatment, payoff: "给出三步判断清单" };
    let discussCalls = 0;
    const validatedDocuments: unknown[] = [];
    const ports: CreativePlanningPorts = {
      treatment: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "treatment-original", output: treatment, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: contentSha256({ stage: "treatment", round: "fixture" }), audit: {
            version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "treatment-original", output: treatment },
      screenwriter: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "script-unused", output: script, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: contentSha256({ stage: "script", round: "fixture" }), audit: {
            version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "script-unused", output: script },
      director: async context => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "director-unused", output: director, reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
          checkIdentity: contentSha256({ stage: "director", round: "fixture" }), audit: {
            version: "video-factory/role-audit-v2" as const, rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass" as const, score: 90, summary: "夹具意见：通过", issues: [], repairInstructions: [], assessments: auditAssessments(90),
          },
        } }
        : { artifactId: "director-unused", output: director },
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
      validateEditedDraft: (_stage, document) => { validatedDocuments.push(structuredClone(document)); },
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
    assert.deepEqual(validatedDocuments, [proposed], "采用备选前必须重验当前阶段硬合同");

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
    assert.deepEqual(validatedDocuments, [proposed, treatment], "恢复旧内容作为新稿前也必须重验硬合同");
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
            reviewCheck: { auditOperationId: context.creativeReviewExecution?.auditOperationId ?? "fixture-op",
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
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate, "confirm-treatment-return") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate, "confirm-script-return") });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, checks: 3 });

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
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 1, checks: 3 });
    assert.equal(returned.state.creativeReview?.stages.treatment.confirmation !== null, true);
    assert.equal(returned.state.creativeReview?.stages.script.confirmation, null);
    assert.equal(returned.state.creativeReview?.stages.director.confirmation, null);

    const regeneratedDirector = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(returned, "reconfirm-script"),
    });
    assert.equal(regeneratedDirector.status, "waiting_user");
    if (regeneratedDirector.status !== "waiting_user") return;
    assert.equal(regeneratedDirector.gate.stage, "director");
    assert.deepEqual(calls, { treatment: 1, script: 1, director: 2, checks: 4 });
  });

  it("keeps low-scoring illustrative scenes as advice instead of automatically rewriting the director plan", async () => {
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
    const passingCheck = (stage: string, output: unknown, ctx?: CreativePlanningContext) => ({
      auditOperationId: (ctx?.creativeReviewExecution?.mode === "check" ? ctx.creativeReviewExecution.auditOperationId : undefined) ?? "fixture-op",
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
        ? { artifactId: "treatment", output: treatment, reviewCheck: passingCheck("treatment", treatment, context) }
        : { artifactId: "treatment", output: treatment },
      screenwriter: async (context) => context.creativeReviewExecution?.mode === "check"
        ? { artifactId: "script", output: fiveSceneScript, reviewCheck: passingCheck("script", fiveSceneScript, context) }
        : { artifactId: "script", output: fiveSceneScript },
      director: async (context) => {
        directorContexts.push(context);
        if (context.creativeReviewExecution?.mode === "check") {
          const output = context.integratedPlan?.output ?? context.directorPlan?.output;
          assert.ok(output, "director review must check the persisted current draft");
          return { artifactId: "director-checked", output, reviewCheck: passingCheck("director", output, context) };
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
          visualEvidence: reviewedCandidates(context.candidates!.output),
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
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate, "confirm-treatment-availability") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate, "confirm-script-availability") });

    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;
    assert.equal(directorGate.gate.stage, "director");
    const draftContexts = directorContexts.filter((context) => context.creativeReviewExecution?.mode !== "check");
    assert.equal(draftContexts.length, 1);
    assert.deepEqual(directorGate.state.issues, []);
    assert.deepEqual(directorGate.state.advisoryIssues?.flatMap(issue => issue.scenePositions), [],
      "stock quality advice appears only after the creator approves the initial direction and candidates are inspected");
    assert.deepEqual(directorGate.state.creativeReview?.stages.director.currentDocument, plans[0]);
    assert.equal(directorGate.state.creativeReview?.stages.director.currentDocument !== null, true);
    const materialGate = await runCreativePlanning(graph, { input, threadId, resume: resume(directorGate, "confirm-direction-availability") });
    assert.equal(materialGate.status, "waiting_user");
    if (materialGate.status === "waiting_user") {
      assert.equal(materialGate.gate.purpose, "material_plan");
      assert.deepEqual(materialGate.state.advisoryIssues?.flatMap(issue => issue.scenePositions), [1, 2]);
    }
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
    const passingCheck = (stage: string, output: unknown, ctx?: CreativePlanningContext) => ({
      auditOperationId: (ctx?.creativeReviewExecution?.mode === "check" ? ctx.creativeReviewExecution.auditOperationId : undefined) ?? "fixture-op",
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
          return { artifactId: "treatment", output: treatment, reviewCheck: passingCheck("treatment", treatment, context) };
        }
        calls.treatment += 1;
        return { artifactId: "treatment", output: treatment };
      },
      screenwriter: async (context) => {
        if (context.creativeReviewExecution?.mode === "check") {
          calls.check += 1;
          return { artifactId: "script", output: script, reviewCheck: passingCheck("script", script, context) };
        }
        calls.script += 1;
        return { artifactId: "script", output: script };
      },
      director: async (context) => {
        const output = context.integratedPlan?.output ?? context.directorPlan?.output ?? director;
        if (context.creativeReviewExecution?.mode === "check") {
          calls.check += 1;
          return { artifactId: "director", output, reviewCheck: passingCheck("director", output, context) };
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
console.log("T16 step at line 1403");
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
console.log("T16 step at line 1406");
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate, "confirm-treatment-route-change") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
console.log("T16 step at line 1409");
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate, "confirm-script-route-change") });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;
    assert.equal(calls.candidates, 0, "the first director draft must wait for the creator before searching stock");
    assert.equal(calls.rank, 0, "the first director draft must wait for the creator before ranking stock");

console.log("T16 step at line 1415");
    const revised = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "revise",
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
    // 讨论改稿产生的是未审新稿：先主动审计这一版，再用它的意见确认（S1/S3 合同）。
    assert.equal(revised.state.creativeReview!.stages.director.checkResult, null);
console.log("T16 step at line 1432");
    const reaudited = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "audit_current", stage: "director", commandId: "audit-revised-stock",
        actor: "creator", baseDraftSha256: revised.gate.draft.sha256,
        expectedReviewRevision: revised.gate.reviewRevision,
      },
    });
    assert.equal(reaudited.status, "waiting_user");
    if (reaudited.status !== "waiting_user") return;
    assert.equal(reaudited.state.creativeReview!.stages.director.checkResult?.verdict, "pass");
console.log("T16 step at line 1444");
    const afterConfirmation = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: { ...resume(reaudited, "confirm-stock-route"), checkIdentity: reaudited.state.creativeReview!.stages.director.checkResult!.checkIdentity },
    });

    assert.equal(afterConfirmation.status, "waiting_user", "rebuilt evidence is reviewed before compilation");
    assert.deepEqual(calls, {
      treatment: 1,
      script: 1,
      // 讨论改稿走 discuss 端口，不再重跑导演产稿；check=5：三阶段初稿各一次 + 修订稿主动审计 + 整合方案(material_plan)初稿审计
      director: 1,
      check: 5,
      discuss: 1,
      candidates: 1,
      rank: 1,
      integrate: 1,
      compile: 0,
    });
    assert.deepEqual(afterConfirmation.state.artifactIds.candidates, ["candidates-1"]);
    assert.deepEqual(afterConfirmation.state.artifactIds.rank, ["ranking-1"]);

console.log("T16 step at line 1466");
    const completed = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: { ...resume(afterConfirmation, "confirm-rebuilt-stock-evidence"), checkIdentity: afterConfirmation.state.creativeReview!.stages.director.checkResult!.checkIdentity },
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

console.log("T16 step at line 1487");
    const recovered = await runCreativePlanning(graph, { input, threadId });
    assert.equal(recovered.status, "waiting_user", "a poisoned completed checkpoint must rebuild missing library evidence");
    assert.equal(calls.candidates, 2);
    assert.equal(calls.rank, 2);
    assert.equal(calls.integrate, 2);
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
    const passingCheck = (stage: string, output: unknown, ctx?: CreativePlanningContext) => ({
      auditOperationId: (ctx?.creativeReviewExecution?.mode === "check" ? ctx.creativeReviewExecution.auditOperationId : undefined) ?? "fixture-op",
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
          ? { reviewCheck: passingCheck("treatment", treatment, context) }
          : {}),
      }),
      screenwriter: async (context) => ({
        artifactId: "script",
        output: script,
        ...(context.creativeReviewExecution?.mode === "check"
          ? { reviewCheck: passingCheck("script", script, context) }
          : {}),
      }),
      director: async (context) => {
        const output = context.integratedPlan?.output ?? context.directorPlan?.output ?? director;
        if (context.creativeReviewExecution?.mode === "check") {
          return { artifactId: "director", output, reviewCheck: passingCheck("director", output, context) };
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
          visualEvidence: reviewedCandidates(context.candidates!.output),
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
console.log("T16 step at line 1627");
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
console.log("T16 step at line 1630");
    const scriptGate = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(treatmentGate, "confirm-treatment-stock-unavailable"),
    });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
console.log("T16 step at line 1637");
    const directorGate = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(scriptGate, "confirm-script-stock-unavailable"),
    });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;

console.log("T16 step at line 1645");
    const revised = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "revise",
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
console.log("T16 step at line 1660");
    const unavailable = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "confirm",
        stage: revised.gate.stage,
        commandId: "confirm-required-stock-route",
        actor: "creator",
        baseDraftSha256: revised.gate.draft.sha256,
        expectedReviewRevision: revised.gate.reviewRevision,
        confirmedAt: "2026-09-14T00:00:00.000Z",
        acknowledgeUnaudited: true as const,
      },
    });

    assert.equal(unavailable.status, "waiting_user");
    if (unavailable.status !== "waiting_user") return;
    assert.equal(unavailable.gate.stage, "director");
    assert.equal(directorDraftCalls, 1, "availability failure must not invoke an automatic director rewrite");
    assert.equal(unavailable.gate.draft.sha256, contentSha256(stockDirector));
    assert.equal(unavailable.state.creativeReview?.stages.director.checkResult?.draftSha256,
      unavailable.gate.draft.sha256, "选材停点也必须交付本版首审意见");
    assert.equal(unavailable.state.advisoryIssues?.[0]?.availabilityBlocker?.evidence.bestSemanticScore, 20);
    assert.equal(unavailable.state.creativeReview?.stages.director.confirmation, null);

console.log("T16 step at line 1674");
    const adjusted = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: {
        action: "revise",
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
  const passingCheck = (stage: string, output: unknown, ctx?: CreativePlanningContext) => ({
      auditOperationId: (ctx?.creativeReviewExecution?.mode === "check" ? ctx.creativeReviewExecution.auditOperationId : undefined) ?? "fixture-op",
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
      return { artifactId: "treatment", output: treatment, reviewCheck: passingCheck("treatment", treatment, context) };
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
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("script", script, context) } : {}),
      }),
      director: async (context) => ({
        artifactId: "director",
        output: director,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("director", director, context) } : {}),
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

console.log("T16 step at line 1774");
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

console.log("T16 step at line 1787");
    const advanced = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(stop, "confirm-treatment-needs-user"),
    });
    assert.equal(advanced.status, "waiting_user");
    if (advanced.status !== "waiting_user") return;
    // 确认就是放行：照常走到脚本确认关，而不是在原处再停一遍。
    assert.equal(advanced.gate.stage, "script");
    assert.equal(advanced.state.planningStop, undefined, "人做过决定之后，停下的理由不能再跟着走");
  });

  it("导演角色级 needs_user 仍是初稿停点，确认前不得检索候选", async () => {
    let candidateCalls = 0;
    const ports: CreativePlanningPorts = {
      treatment: async (context) => ({ artifactId: "treatment", output: treatment,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("treatment", treatment, context) } : {}) }),
      screenwriter: async (context) => ({ artifactId: "script", output: script,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("script", script, context) } : {}) }),
      director: async (context) => {
        if (context.creativeReviewExecution?.mode === "check") {
          return { artifactId: "director", output: director, reviewCheck: passingCheck("director", director, context) };
        }
        await runRoleAgentLoop<VisualDirectorPlan>({
          role: "导演前期构思", planningRole: true, contractVersion: "director-needs-user-test-v1",
          criteria: ["创作方向需由用户决定"], maxIterations: 3,
          checkpoint: { key: "director-needs-user", load: async () => undefined, save: async () => undefined },
          produce: async () => ({ output: director }),
          audit: async () => ({ output: {
            version: "video-factory/role-audit-v2" as const,
            rubricVersion: "video-factory/role-quality-rubric-v1" as const,
            verdict: "repair" as const, score: 91, assessments: auditAssessments(91),
            summary: "创作方向需要用户决定", issues: [{ severity: "blocking" as const,
              criterion: "创作方向", evidence: "现有画面路线存在取舍", repairInstruction: "请用户决定画面路线" }],
            repairInstructions: ["请用户决定画面路线"],
            planningDisposition: { action: "needs_user" as const, issueIndexes: [0] },
          } }),
          validate: (value) => value as VisualDirectorPlan,
        });
        throw new Error("needs_user 应中止导演角色循环");
      },
      searchCandidates: async () => { candidateCalls += 1; throw new Error("确认前不得检索候选"); },
      rank: async () => { throw new Error("确认前不得排序"); },
      integrateDirector: async () => { throw new Error("确认前不得整合"); },
      compile: executablePlanCompilePort,
    };
    const graph = createCreativePlanningGraph({ ports, checkpointer: new MemorySaver() });
    const input = { runId: "run-director-needs-user", inputDigest: "digest-director-needs-user",
      durationRange: { minSeconds: 20, maxSeconds: 30 }, creativeReview: CREATIVE_REVIEW_FEATURE };
    const threadId = planningThreadId(input.runId, input.inputDigest);
console.log("T16 step at line 1837");
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
console.log("T16 step at line 1840");
    const scriptGate = await runCreativePlanning(graph, { input, threadId, resume: resume(treatmentGate, "confirm-treatment-director-halt") });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;
console.log("T16 step at line 1843");
    const directorGate = await runCreativePlanning(graph, { input, threadId, resume: resume(scriptGate, "confirm-script-director-halt") });
    assert.equal(directorGate.status, "waiting_user");
    if (directorGate.status !== "waiting_user") return;
    assert.equal(directorGate.gate.purpose, "direction");
    assert.equal(candidateCalls, 0);
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
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("treatment", treatment, context) } : {}),
      }),
      screenwriter: async (context) => ({
        artifactId: "script",
        output: script,
        ...(context.creativeReviewExecution?.mode === "check" ? { reviewCheck: passingCheck("script", script, context) } : {}),
      }),
      director: async (context) => {
        const output = context.integratedPlan?.output ?? context.directorPlan?.output ?? stockDirector;
        return context.creativeReviewExecution?.mode === "check"
          ? { artifactId: "director", output, reviewCheck: passingCheck("director", output, context) }
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

console.log("T16 step at line 1945");
    const treatmentGate = await runCreativePlanning(graph, { input, threadId });
    assert.equal(treatmentGate.status, "waiting_user");
    if (treatmentGate.status !== "waiting_user") return;
console.log("T16 step at line 1948");
    const scriptGate = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(treatmentGate, "confirm-treatment-evaluate-halt"),
    });
    assert.equal(scriptGate.status, "waiting_user");
    if (scriptGate.status !== "waiting_user") return;

console.log("T16 step at line 1956");
    const directionGate = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(scriptGate, "confirm-script-evaluate-halt"),
    });
    assert.equal(directionGate.status, "waiting_user");
    if (directionGate.status !== "waiting_user") return;
    assert.equal(directionGate.gate.purpose, "direction");
console.log("T16 step at line 1964");
    const stop = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(directionGate, "confirm-direction-evaluate-halt"),
    });
    assert.equal(stop.status, "waiting_user", "复检停下必须停在导演确认关，而不是把整条制作判失败");
    if (stop.status !== "waiting_user") return;
    assert.equal(stop.gate.stage, "director");
    assert.equal(stop.state.planningStop?.reason, "needs_user");
    assert.deepEqual(stop.state.creativeReview?.stages.director.currentDocument, stockDirector);

console.log("T16 step at line 1975");
    const afterDecision = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(stop, "confirm-director-evaluate-halt"),
    });
    // 人确认之后自动循环继续跑下去，走到下一个正常的确认关（整合方案复检），而不是又停在
    // 同一个停点上、也不是以失败收场。停下的理由已经作废，不能跟着走到这一步。
    assert.equal(afterDecision.status, "waiting_user");
    if (afterDecision.status !== "waiting_user") return;
    assert.equal(afterDecision.gate.stage, "director");
    assert.equal(afterDecision.state.planningStop, undefined);
    assert.deepEqual(afterDecision.state.artifactIds.integrate?.length, 1, "确认后必须真的走过整合，而不是原地打转");
    assert.notEqual(afterDecision.gate.reviewRevision, stop.gate.reviewRevision, "这是一次新的确认，不是原来那一次");

console.log("T16 step at line 1989");
    const completed = await runCreativePlanning(graph, {
      input,
      threadId,
      resume: resume(afterDecision, "confirm-integrated-director-plan"),
    });
    // 这条制作不是被审计否掉的，是被人的决定放行的；编译照常完成。
    assert.equal(completed.status, "completed");
  });
});

describe("审计记账幂等（OA-04 / W4 恢复窗口）", () => {
  function recordedReview(auditId: string) {
    let review = initialCreativeReviewState();
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "treatment-input");
    review = recordCreativeReviewCheck(review, "treatment", {
      versionId: review.stages.treatment.currentDraft!.versionId,
      auditId,
      draftSha256: review.stages.treatment.currentDraft!.sha256,
      checkIdentity: "identity-1",
      verdict: "repair",
      score: 58,
      summary: "第一轮意见",
      issues: [],
    }, { source: "initial", recordedAt: "2026-09-14T00:00:00.000Z" });
    return review;
  }

  it("replays of the same applied operation are a strict no-op (no history, no revision, no checkResult rollback)", () => {
    let review = recordedReview("audit-stable-1");
    // 同版本后来又完成了一次更新的审计 B；旧操作 A 的重放不得把当前意见回退到 A。
    review = recordCreativeReviewCheck(review, "treatment", {
      versionId: review.stages.treatment.currentDraft!.versionId,
      auditId: "audit-stable-2-newer",
      draftSha256: review.stages.treatment.currentDraft!.sha256,
      checkIdentity: "identity-2",
      verdict: "pass",
      score: 91,
      summary: "第二轮意见（更新）",
      issues: [],
    }, { source: "manual", recordedAt: "2026-09-14T01:00:00.000Z" });
    assert.equal(review.stages.treatment.checkResult?.auditId, "audit-stable-2-newer");
    const before = review.reviewRevision;
    const history = review.stages.treatment.auditHistory!.length;
    const replayed = recordCreativeReviewCheck(review, "treatment", {
      versionId: review.stages.treatment.currentDraft!.versionId,
      draftSha256: review.stages.treatment.currentDraft!.sha256,
      checkIdentity: "identity-1",
      verdict: "repair",
      score: 58,
      summary: "第一轮意见",
      issues: [],
    }, { auditId: "audit-stable-1", source: "initial" });
    assert.equal(replayed.reviewRevision, before, "replay must not advance the review revision");
    assert.equal(replayed.stages.treatment.auditHistory!.length, history, "replay must not append a duplicate record");
    assert.equal(replayed.stages.treatment.checkResult?.auditId, "audit-stable-2-newer",
      "P12：A 后 B 再重放 A，当前 checkResult 必须仍是 B");
  });

  it("rejects a conflicting conclusion under the same audit identity", () => {
    const review = recordedReview("audit-stable-2");
    assert.throws(
      () => recordCreativeReviewCheck(review, "treatment", {
        versionId: review.stages.treatment.currentDraft!.versionId,
        draftSha256: review.stages.treatment.currentDraft!.sha256,
        checkIdentity: "identity-2",
        verdict: "pass",
        score: 91,
        summary: "恢复窗口冒出的另一份结论",
        issues: [],
      }, { auditId: "audit-stable-2", source: "initial" }),
      /不一致/,
    );
  });

  it("rejects reusing an older version's audit id onto a re-created identical version (P11)", () => {
    let review = initialCreativeReviewState();
    review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "treatment-input");
    const v1 = review.stages.treatment.currentDraft!;
    review = recordCreativeReviewCheck(review, "treatment", {
      versionId: v1.versionId,
      auditId: "audit-v1-identity",
      draftSha256: v1.sha256,
      checkIdentity: "identity-v1",
      verdict: "pass",
      score: 90,
      summary: "V1 意见",
      issues: [],
    }, { source: "initial" });
    // 手工保存 B 再恢复 A：V3 与 V1 同字节（A→B→A）但版本不同。
    review = publishCreativeDraft(review, "treatment", "treatment-artifact-2", { ...treatment, payoff: "改成别的兑现" }, "treatment-input-2");
    review = publishCreativeDraft(review, "treatment", "treatment-artifact-3", treatment, "treatment-input-3");
    const v3 = review.stages.treatment.currentDraft!;
    assert.equal(v3.sha256, v1.sha256, "fixture must actually recreate identical bytes (A→B→A)");
    review = recordCreativeReviewCheck(review, "treatment", {
      versionId: v3.versionId,
      auditId: "audit-v3-identity",
      draftSha256: v3.sha256,
      checkIdentity: "identity-v3",
      verdict: "pass",
      score: 90,
      summary: "V3 意见",
      issues: [],
    }, { source: "initial" });
    // 宿主补写场景（P11）：result 不带 versionId（图层按当前 V3 解释），
    // 但 auditId 已绑定 V1 的登记——完整比较发现目标版本不同，必须冲突而不是放行。
    assert.throws(
      () => recordCreativeReviewCheck(review, "treatment", {
        draftSha256: v3.sha256,
        checkIdentity: "identity-v1",
        verdict: "pass",
        score: 90,
        summary: "V1 意见",
        issues: [],
      }, { auditId: "audit-v1-identity", source: "initial" }),
      /另一版本/,
    );
  });
});

// R3-03：pass 确认不带身份 = 无法证明用户看过哪一条复核——图层必须拒绝，
// 不得有任何代填兜底（OA-03 的漏洞正是这条路径上的覆盖）。
it("refuses a pass confirmation that omits the seen check identity", () => {
  let review = initialCreativeReviewState();
  review = publishCreativeDraft(review, "treatment", "treatment-artifact", treatment, "treatment-input");
  review = recordCreativeReviewCheck(review, "treatment", {
    versionId: review.stages.treatment.currentDraft!.versionId,
    auditId: "audit-pass-1",
    draftSha256: review.stages.treatment.currentDraft!.sha256,
    checkIdentity: "identity-pass-1",
    verdict: "pass",
    score: 92,
    summary: "可执行",
    issues: [],
  });
  const gate = creativeReviewGate(review, "treatment");
  assert.throws(
    () => confirmCreativeDraft(review, {
      action: "confirm" as const,
      stage: "treatment",
      commandId: "confirm-no-identity",
      actor: "creator",
      baseDraftSha256: gate.draft.sha256,
      expectedReviewRevision: gate.reviewRevision,
      confirmedAt: "2026-09-14T00:00:00.000Z",
    }),
    /check|复核|身份/,
  );
});

// R8-01：旧操作异常经过真实装配 helper 不得被重新绑定到当前操作（同字节 A→B→A 绕过路径）。
describe("withAuditOperationBinding guard (R8-01)", () => {
  // 回归必须经过生产 helper 本体（r9 阻断项），不能用测试内复刻规则替代。
  const sameOperation = { creativeReviewExecution: { mode: "check" as const, stage: "treatment" as const, auditOperationId: "O3" } };

  it("keeps the original binding when an already-bound old exception passes a new operation's helper", async () => {
    const bound = new RoleAgentLoopError("旧操作异常", {
      version: "video-factory/agent-loop-v1", role: "导演前期构思", contractVersion: "fixture-v1",
      criteria: [], status: "failed", maxIterations: 1, iterations: [],
      failure: { stage: "completed_failure" },
    }, undefined, new CodexBridgeError("completed", false, "completed_failure", 502, "model_provider_no_output"));
    (bound as { auditOperationId?: string }).auditOperationId = "O1";

    let rethrown: unknown;
    try {
      await withAuditOperationBinding("O3", async () => { throw bound; });
    } catch (caught) {
      rethrown = caught;
    }
    assert.equal(rethrown, bound, "the helper must rethrow the same exception object");
    assert.equal((bound as { auditOperationId?: string }).auditOperationId, "O1",
      "the old operation's binding must survive the new operation's helper boundary");
  });

  it("establishes a first binding for an unbound exception at the current call boundary", async () => {
    const unbound = new RoleAgentLoopError("未绑定异常", {
      version: "video-factory/agent-loop-v1", role: "导演前期构思", contractVersion: "fixture-v1",
      criteria: [], status: "failed", maxIterations: 1, iterations: [],
      failure: { stage: "completed_failure" },
    }, undefined, new CodexBridgeError("completed", false, "completed_failure", 502, "model_provider_no_output"));
    let rethrown: unknown;
    try {
      await withAuditOperationBinding("O3", async () => { throw unbound; });
    } catch (caught) {
      rethrown = caught;
    }
    assert.equal((rethrown as { auditOperationId?: string }).auditOperationId, "O3",
      "first binding at the trusted call boundary must record the current operation");
    assert.equal(rethrown, unbound, "first binding must rethrow the same exception object");
  });

  it("keeps an existing same-operation binding unchanged on replay through the helper", async () => {
    const bound = new RoleAgentLoopError("同操作重放异常", {
      version: "video-factory/agent-loop-v1", role: "导演前期构思", contractVersion: "fixture-v1",
      criteria: [], status: "failed", maxIterations: 1, iterations: [],
      failure: { stage: "completed_failure" },
    }, undefined, new CodexBridgeError("completed", false, "completed_failure", 502, "model_provider_no_output"));
    (bound as { auditOperationId?: string }).auditOperationId = "O3";
    let rethrown: unknown;
    try {
      await withAuditOperationBinding("O3", async () => { throw bound; });
    } catch (caught) {
      rethrown = caught;
    }
    assert.equal(rethrown, bound);
    assert.equal((bound as { auditOperationId?: string }).auditOperationId, "O3", "same binding must not be rewritten");
  });
});
