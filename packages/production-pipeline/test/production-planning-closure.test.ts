import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, mock } from "node:test";
import {
  CodexBridgeError,
  CodexBridgeClient,
  ModelCandidatesExhaustedError,
  CodexScreenwriterAgent,
  type CodexTaskKind,
  RoleAgentLoopError,
  HumanDecisionConflictError,
  ProductionPipeline,
  contentSha256,
  planningReviewCheckpointIdentity,
  type CreativePlanningContext,
  type CreativeReviewState,
  sourceReviewIncompleteError,
  withAuditOperationBinding,
  type CreativeTreatment,
  type CreativeTreatmentAgent,
  type CreativeTreatmentAgentInput,
  type ProductionArticleSourceSnapshot,
  type ProductionBrief,
  type ProductionPipelineOptions,
  type ScreenwriterAgent,
  type ScreenwriterAgentInput,
  type VisualAssetProviderCapability,
  type VisualDirectorAgent,
  type VisualDirectorAgentInput,
  type WorkerResponse,
} from "../src/index.js";
import type { WorkflowRun } from "@video-factory/workflow-core";
import { summarizeJointPlanningExecution } from "../src/production-pipeline.js";
import { CodexBrokerServer } from "../../../apps/codex-broker/src/broker-server.js";
import { runCreativeDiscussionTask } from "../src/codex-creative-discussion.js";
import type { ValidatedTask } from "../../../apps/codex-broker/src/codex-executor.js";
import { CodexAssetSemanticRanker, deterministicAssetRanking, type AssetCandidateReport } from "../src/asset-semantic-ranker.js";
import { ProductionStudio } from "../../../apps/studio/src/server/production-studio.js";
import { JsonRunArchiveStore } from "../../../apps/studio/src/server/run-archive-store.js";

// ---------------------------------------------------------------------------
// B4-REMAINDER：joint-v1 规划编辑合同的行为测试。
// 1) creative-planning 的 execute 必须消费当前 request.brief（输入覆盖真正进入规划）。
// 2) 编辑产生新 input digest，并按阶段依赖闭包失效：script 编辑保留有效 treatment，
//    director 编辑保留有效 treatment/script；不受影响的阶段不得重复调用模型。
// 3) treatment 不再固定使用 treatmentAgents[0]：模型选择影响真实路由，Provider 故障按
//    既有 fallback 合同切换候选。
// 4) role trace（effectiveModelId）严格绑定当前 inputDigest，不读旧执行 trace。
// 全部走真实 ProductionPipeline（SQLite checkpoint + planning commit）；创作角色为本地替身。
// ---------------------------------------------------------------------------

import { parseCreativeTreatment } from "../src/creative-treatment.js";
const TREATMENT_PROVIDER_ID = "codex-creative-treatment-v1";

class ClosureWorker {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "script.draft": { scriptPath: path.join(outputDir, "script.json") },
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"), trackPath: path.join(outputDir, "narration.m4a") },
      "video.render": { videoPath: path.join(outputDir, "final.mp4"), renderManifestPath: path.join(outputDir, "render_manifest.json") },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected capability: ${capability}`);
    const jsonContent = JSON.stringify({ capability });
    const primaryPath = String(Object.values(output)[0]);
    const primaryContent = capability === "video.render" ? "video" : jsonContent;
    await writeFile(primaryPath, primaryContent);
    if (capability === "voice.synthesize") await writeFile(String(output.trackPath), "audio");
    if (capability === "video.render") await writeFile(String(output.renderManifestPath), jsonContent);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output,
      artifacts: [{
        kind: capability.replace(".", "_"),
        uri: primaryPath,
        sha256: createHash("sha256").update(primaryContent).digest("hex"),
        sizeBytes: Buffer.byteLength(primaryContent),
        contentType: capability === "video.render" ? "video/mp4" : "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }, ...(capability === "video.render" ? [{
        kind: "render_manifest",
        uri: String(output.renderManifestPath),
        sha256: createHash("sha256").update(jsonContent).digest("hex"),
        sizeBytes: Buffer.byteLength(jsonContent),
        contentType: "application/json",
        provenance: {
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }] : [])],
    };
  }
}

interface ClosureSpies {
  treatmentTitles: string[];
  treatmentModelCalls: string[];
  treatmentCheckpointPresent: boolean[];
  treatmentInputs?: Array<{ visualIntent?: string; reworkInstruction?: string }>;
  treatmentAuditCalls?: number;
  treatmentAuditModels?: string[];
  // R11-V01：替身入口记录每次 check 调用的操作身份与实际抛出的异常对象，
  // 证明重放确实进入真实 helper/图层拒收链，而不是被前置错误替代。
  treatmentCheckOperations?: string[];
  treatmentRethrown?: unknown[];
  treatmentSources?: unknown[][];
  screenwriterCalls: string[];
  screenwriterSources?: unknown[][];
  screenwriterAuditCalls?: number;
  screenwriterCheckpointPairs?: string[][];
  directorCalls: number;
  directorSources?: unknown[][];
  directorAuditCalls?: number;
  directorCheckpointPairs?: string[][];
  searchCalls: number;
  rankCalls: number;
  /** 排序角色实际收到的请求：断言真实语义意图进入 ranker 输入，而非只有 artifact id。 */
  rankRequests: Array<{ planningIntent?: { rankingIntent?: unknown; semanticIntentVersion?: string } }>;
  /** 排序角色收到的 durable checkpoint key：ranker 身份变化必须改变 checkpoint 身份。 */
  rankCheckpoints: Array<{ key?: string }>;
}

function passingCreativeReviewExecution<T>(
  output: T,
  role: string,
  contractVersion: string,
  taskKind: "creative-treatment" | "script-draft" | "director-plan",
  modelId: string,
) {
  return {
    output,
    trace: {
      taskKind,
      promptVersion: "v1",
      prompt: "fixture role execution",
      providerId: "fixture-role",
      modelId,
    },
    agentLoop: {
      version: "video-factory/agent-loop-v1" as const,
      role,
      contractVersion,
      criteria: ["fixture independent review"],
      status: "passed" as const,
      maxIterations: 1,
      producerModelCallCount: 0,
      auditModelCallCount: 1,
      iterations: [{
        iteration: 1,
        candidate: output,
        candidateHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
        auditTrace: {
          taskKind: "role-audit" as const,
          promptVersion: "v1",
          prompt: "fixture independent review",
          providerId: "fixture-audit",
          modelId: `${modelId}-audit`,
        },
        audit: {
          version: "video-factory/role-audit-v2" as const,
          rubricVersion: "video-factory/role-quality-rubric-v1",
          assessments: [{
            targetPath: "",
            dimensions: [
              { dimension: "attention" as const, score: 92, evidence: "开场给出具体对象。" },
              { dimension: "progression" as const, score: 92, evidence: "中段逐步给出结果。" },
              { dimension: "payoff" as const, score: 92, evidence: "结尾回答原承诺。" },
              { dimension: "expression" as const, score: 92, evidence: "表达具体可执行。" },
            ],
          }],
          verdict: "pass" as const,
          score: 92,
          summary: "当前版本可以确认。",
          issues: [],
          repairInstructions: [],
          planningDisposition: null,
          hostReadinessReview: null,
        },
      }],
    },
  };
}

/**
 * 复核跑完但裁决是 repair：这不是执行故障，loop 以 awaiting_user 正常返回，把建议交给上层，
 * 采不采用由人定。用来在真实 pipeline 上造出确定的"给出负面意见"那一腿。
 */
function repairingCreativeReviewExecution<T>(
  output: T,
  role: string,
  contractVersion: string,
  taskKind: "creative-treatment" | "script-draft" | "director-plan",
  modelId: string,
) {
  const passed = passingCreativeReviewExecution(output, role, contractVersion, taskKind, modelId);
  const iteration = passed.agentLoop.iterations[0]!;
  return {
    ...passed,
    agentLoop: {
      ...passed.agentLoop,
      status: "awaiting_user" as const,
      iterations: [{
        ...iteration,
        audit: {
          ...iteration.audit,
          assessments: [{
            targetPath: "",
            dimensions: [
              { dimension: "attention" as const, score: 70, evidence: "开场是抽象概括。" },
              { dimension: "progression" as const, score: 70, evidence: "中段推进偏慢。" },
              { dimension: "payoff" as const, score: 70, evidence: "结尾没有收束。" },
              { dimension: "expression" as const, score: 70, evidence: "表达偏空。" },
            ],
          }],
          verdict: "repair" as const,
          score: 70,
          summary: "开场缺少具体对象，先改这一处再确认。",
          issues: [{
            severity: "blocking" as const,
            criterion: "前两秒建立具体钩子",
            evidence: "开场是抽象概括，没有具体动作。",
            repairInstruction: "把开场换成一个人正在做的动作。",
          }],
          repairInstructions: ["把开场换成一个人正在做的动作。"],
        },
      }],
    },
  };
}

function legalTreatment(title: string): CreativeTreatment {
  return {
    version: "video-factory/creative-treatment-v2",
    viewerPromise: "看完能避开三个决策坑",
    hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
    progression: [
      { beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" },
      { beatId: "beat-2", purpose: "给出方法", viewerGain: "可执行步骤" },
    ],
    payoff: "低风险决策清单",
    visualPrinciples: ["真实动作", "少字多画面"],
    soundPrinciples: ["环境声先行"],
    evidenceRequirements: [],
    feasibilityQuestions: [],
  };
}

// 两候选构思替身：记录每次调用实际使用的模型，可按候选制造 not_accepted 故障。
interface ClosureTreatmentOptions {
  failFirstCandidate?: boolean;
  repairCheck?: boolean;
  rethrowException?: RoleAgentLoopError;
  auditFailure?: (modelId: string) => unknown;
}

function closureTreatmentAgents(
  spies: ClosureSpies,
  options: ClosureTreatmentOptions = {},
): Array<{ providerId: string; agent: CreativeTreatmentAgent }> {
  const makeAgent = (modelId: string, providerLabel: string): { providerId: string; agent: CreativeTreatmentAgent } => ({
    providerId: providerLabel,
    agent: {
      id: TREATMENT_PROVIDER_ID,
      modelId,
      treat: async (input: { brief: { title: string } }) => {
        spies.treatmentModelCalls.push(modelId);
        spies.treatmentTitles.push(input.brief.title);
        return legalTreatment(input.brief.title);
      },
      treatDetailed: async (input: CreativeTreatmentAgentInput) => {
        if (input.creativeReviewExecution?.mode === "check") {
          spies.treatmentAuditCalls = (spies.treatmentAuditCalls ?? 0) + 1;
          spies.treatmentAuditModels?.push(modelId);
          spies.treatmentCheckOperations = [...(spies.treatmentCheckOperations ?? []),
            input.creativeReviewExecution.auditOperationId ?? "(initial)"];
          const auditFailure = await options.auditFailure?.(modelId);
          if (auditFailure) throw auditFailure;
          // R9-01：按需重抛异常对象（O1 时未绑定、O3 时已绑定 O1）——真实 helper 的
          // 首绑/不覆盖 guard 与图层归属核验按绑定状态分别走登记与拒收。非 Provider
          // 故障按既有合同不做候选切换，每次操作恰好一次角色调用。
          if (options.rethrowException) {
            spies.treatmentRethrown = [...(spies.treatmentRethrown ?? []), options.rethrowException];
            throw options.rethrowException;
          }
          return (options.repairCheck ? repairingCreativeReviewExecution : passingCreativeReviewExecution)(
            input.creativeReviewExecution.candidate,
            "导演前期构思",
            "fixture-treatment-contract-v1",
            "creative-treatment",
            modelId,
          );
        }
        spies.treatmentModelCalls.push(modelId);
        spies.treatmentTitles.push(input.brief.title);
        spies.treatmentSources?.push(structuredClone(input.suppliedSources));
        spies.treatmentCheckpointPresent.push(input.agentLoopCheckpoint !== undefined);
        spies.treatmentInputs?.push({
          ...("visualIntent" in input.brief && typeof input.brief.visualIntent === "string"
            ? { visualIntent: input.brief.visualIntent }
            : {}),
          ...("reworkInstruction" in input.brief && typeof input.brief.reworkInstruction === "string"
            ? { reworkInstruction: input.brief.reworkInstruction }
            : {}),
        });
        if (options.failFirstCandidate && modelId === "treatment-model-a") {
          // 确证发生在受理之前的瞬时 Provider 故障：按既有 fallback 合同允许切换候选。
          throw new CodexBridgeError("treatment model a connection failed", true, "not_accepted");
        }
        return {
          output: legalTreatment(input.brief.title),
          trace: {
            taskKind: "creative-treatment" as const,
            promptVersion: "v1",
            prompt: "fixture prompt",
            providerId: providerLabel,
            modelId,
          },
        };
      },
    },
  });
  // 两个候选保持默认注册：重抛异常不是 Provider 故障，runCandidates 按既有合同原样
  // 上抛、不切换候选，因此每次 check 操作仍只有一次角色调用（由测试的调用计数断言钉住，
  // 不依赖构造期的候选数量判断——rethrowException 允许在 pipeline 启动后按需置位）。
  return [makeAgent("treatment-model-a", "openai"), makeAgent("treatment-model-b", "deepseek")];
}

function closureScreenwriter(spies: ClosureSpies): ScreenwriterAgent {
  return {
    id: "codex-screenwriter-v1",
    modelId: "screenwriter-binding-model",
    draft: async () => {
      throw new Error("closure fixtures must run through draftDetailed for trace evidence");
    },
    draftDetailed: async (input: ScreenwriterAgentInput) => {
      if (input.creativeReviewExecution?.mode === "check") {
        spies.screenwriterAuditCalls = (spies.screenwriterAuditCalls ?? 0) + 1;
        return passingCreativeReviewExecution(
          input.creativeReviewExecution.candidate,
          "编剧",
          "fixture-screenwriter-contract-v1",
          "script-draft",
          input.selectedModelId ?? "screenwriter-binding-model",
        );
      }
      spies.screenwriterCalls.push(input.brief.title);
      spies.screenwriterSources?.push(structuredClone(input.brief.articleSources ?? []));
      if (spies.screenwriterCheckpointPairs) {
        assert.ok(input.agentLoopCheckpointForModel);
        spies.screenwriterCheckpointPairs.push([
          input.agentLoopCheckpointForModel("screenwriter-model-a").key,
          input.agentLoopCheckpointForModel("screenwriter-model-b").key,
        ]);
      }
      return {
        output: {
          viewerPromise: "看完能避开三个决策坑",
          narrativeArc: "问题-方法-清单",
          canonFacts: ["步骤可执行"],
          scenes: [1, 2, 3].map((position) => ({
            position,
            narration: `第${position}段旁白内容`,
            duration: 8,
            visual_strategy: "stock",
            visual_prompt: `第${position}个真实生活动作`,
            search_terms: [`生活动作 ${position}`],
          })),
        },
        trace: {
          taskKind: "script-draft" as const,
          promptVersion: "v1",
          prompt: "fixture prompt",
          providerId: "codex-screenwriter-v1",
          modelId: input.selectedModelId ?? "screenwriter-binding-model",
        },
      };
    },
  };
}

function closureDirector(spies: ClosureSpies): VisualDirectorAgent {
  const director: VisualDirectorAgent = {
    id: "api-visual-director-v1",
    modelId: "director-binding-model",
    plan: async (input: VisualDirectorAgentInput) => {
      if (input.creativeReviewExecution?.mode === "check") {
        spies.directorAuditCalls = (spies.directorAuditCalls ?? 0) + 1;
        return passingCreativeReviewExecution(
          input.creativeReviewExecution.candidate,
          "视觉导演",
          "fixture-director-contract-v1",
          "director-plan",
          input.selectedModelId ?? "director-binding-model",
        ) as never;
      }
      spies.directorCalls += 1;
      spies.directorSources?.push(structuredClone(input.brief.articleSources ?? []));
      if (spies.directorCheckpointPairs) {
        assert.ok(input.agentLoopCheckpointForModel);
        spies.directorCheckpointPairs.push([
          input.agentLoopCheckpointForModel("director-model-a").key,
          input.agentLoopCheckpointForModel("director-model-b").key,
        ]);
      }
      return {
        version: "video-factory/director-plan-v1",
        requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer",
        profileRationale: "用真实动作解释。",
        visualBible: {
          narrativeApproach: "逐步展示", motif: "窗边光影", pacing: "均匀", composition: "稳定中景",
          camera: "固定机位", color: "自然色", continuity: "同一时段", transitionGrammar: "硬切配字幕",
          sound: "环境声", antiPatterns: ["不用电影感运镜"],
        },
        shots: input.scenes.map((scene) => ({
          scenePosition: scene.position,
          reuseFromScenePosition: null,
          referenceFromScenePosition: null,
          narrativeRole: "解释",
          authenticityPolicy: "illustrative",
          preferredProviderId: "local-editorial-v1",
          deliveryType: "editorial_card",
          alternativeProviderIds: [],
          subject: `第${scene.position}段示意主体`,
          environment: "桌面一角，自然光",
          visibleAction: `第${scene.position}段标注动作`,
          temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
          shotSize: "中景卡片",
          sourceInSeconds: 0,
          camera: "固定",
          lighting: "自然光",
          negativeConstraints: ["不冒充真实事件"],
          referenceRequirements: [],
          successCriteria: ["卡面文字可读"],
          query: `editorial-${scene.position}`,
          generationPrompt: `第${scene.position}个真实生活动作`,
          rationale: "本地说明卡可以执行。",
          continuityNote: "保持自然色。",
          confidence: 0.8,
          estimatedCostCny: 0,
        })),
      };
    },
  };
  // check 模式走 role loop，需要完整 execution（含审计迭代）；只实现 plan 时 Provider 会把
  // execution 再包一层当文档校验，「Director plan version」必然缺失（F17 前这个故障被
  // 节点 failed 掩盖，F14/F17 后正确转为暂停停点，夹具随之对齐）。
  director.planDetailed = async (input: VisualDirectorAgentInput) => {
    if (input.creativeReviewExecution?.mode === "check") {
      spies.directorAuditCalls = (spies.directorAuditCalls ?? 0) + 1;
      return passingCreativeReviewExecution(
        input.creativeReviewExecution.candidate,
        "视觉导演",
        "fixture-director-contract-v1",
        "director-plan",
        input.selectedModelId ?? "director-binding-model",
      ) as never;
    }
    return {
      output: await director.plan(input),
      trace: {
        taskKind: "director-plan" as const,
        promptVersion: "v1",
        prompt: "fixture director plan",
        providerId: "fixture-role",
        modelId: input.selectedModelId ?? "director-binding-model",
      },
    };
  };
  return director;
}

const CLOSURE_ASSET_PROVIDERS: VisualAssetProviderCapability[] = [
  { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
];

function closureBrief(overrides: { models?: Record<string, string>; title?: string; assetSemanticRank?: boolean; creativeReview?: boolean } = {}): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: overrides.title ?? "joint-v1 规划编辑闭环",
    angle: "编辑必须进入真实执行",
    audience: "内容创作者",
    nicheSlug: "planning-closure",
    durationSeconds: 24,
    durationRange: { minSeconds: 20, maxSeconds: 34 },
    platform: "douyin",
    runPurpose: "test",
    reviewMode: "manual",
    providers: {
      script: "codex-screenwriter-v1",
      director: "api-visual-director-v1",
      assets: overrides.assetSemanticRank ? "ai-shot-router-v1" : "local-editorial-v1",
      voice: "macos-say-v1",
      render: "python-ffmpeg-v1",
      technicalReview: "python-technical-review-v1",
    },
    workflowFeatures: {
      assetSemanticRank: overrides.assetSemanticRank ?? false,
      referenceGrammar: false,
      executablePlan: true,
      creativePlanning: "joint-v1",
      ...(overrides.creativeReview ? { creativeReview: "user-confirmed-v1" as const } : {}),
    },
    director: {
      profileId: "auto",
      assetProviderIds: overrides.assetSemanticRank ? ["pexels-stock-v1"] : ["local-editorial-v1"],
    },
    ...(overrides.models ? { models: overrides.models } : {}),
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  } as unknown as ProductionBrief;
}

function scriptStageTemplateSnapshot() {
  return {
    templateId: "planning-closure-template",
    templateVersion: 1,
    resolvedAt: "2026-09-13T00:00:00.000Z",
    resolvedBlueprint: {
      platform: "douyin",
      durationSeconds: 24,
      automationLevel: "assisted",
      storyStructure: [{ id: "explain", label: "解释", purpose: "逐步解释", required: true }],
      shotSlots: [{ id: "shot-explain", beatId: "explain", purpose: "展示动作", durationSeconds: 24, allowedCapabilities: ["asset.prepare"], manualReplacement: true }],
      visualSystem: { composition: "一个镜头一个概念", colorIntent: "自然底色", subtitleDensity: "medium", pacing: "measured" },
      soundSystem: { voiceIntent: "自然", pace: "medium", musicIntent: "轻盈" },
      qualityRules: [{ id: "facts", label: "事实准确", dimension: "factual", required: true, threshold: 80 }],
      capabilityRequirements: [{ capability: "script.draft", required: true }],
    },
    sourceLayers: [{ layer: "template", sourceId: "planning-closure-template@1", appliedFields: ["storyStructure"] }],
    fieldSources: { storyStructure: "template" },
  } as const;
}

function newClosurePipeline(
  workspaceRoot: string,
  spies: ClosureSpies,
  treatmentOptions: ClosureTreatmentOptions = {},
): ProductionPipeline {
  return new ProductionPipeline({
    workspaceRoot,
    worker: new ClosureWorker(),
    treatmentAgents: closureTreatmentAgents(spies, treatmentOptions),
    screenwriterAgent: closureScreenwriter(spies),
    directorAgent: closureDirector(spies),
    assetProviders: CLOSURE_ASSET_PROVIDERS,
  });
}

async function effectivePlanningInput(
  pipeline: ProductionPipeline,
  runId: string,
): Promise<{ brief: ProductionBrief }> {
  const run = await pipeline.show(runId);
  const state = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.inputState;
  assert.ok(state, "the planning node must expose input versions");
  const effective = state.versions.find((version) => version.id === state.effectiveVersionId)?.value;
  assert.ok(effective && typeof effective === "object", "the effective planning input must be an object");
  return effective as { brief: ProductionBrief };
}

async function currentRunRevision(pipeline: ProductionPipeline, runId: string): Promise<number> {
  return (await pipeline.show(runId)).revision;
}

// joint-v1 编辑合同要求 caller tokens：直接走 pipeline 的测试同样读取真实并发 token。
async function jointPlanningEditTokens(
  pipeline: ProductionPipeline,
  runId: string,
  nodeId = "creative-planning",
): Promise<{ expectedRunRevision: number; expectedVersionId: string }> {
  const run = await pipeline.show(runId);
  const state = run.nodeRuns.find((node) => node.nodeId === nodeId)?.inputState;
  assert.ok(state, "the edited node must expose input versions");
  return { expectedRunRevision: run.revision, expectedVersionId: state.effectiveVersionId };
}

describe("joint-v1 planning edit contract (B4-REMAINDER)", () => {
  it("carries adopted article evidence through every planning role and invalidates all dependent stages when it changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-article-evidence-planning-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], treatmentSources: [],
      screenwriterCalls: [], screenwriterSources: [], directorCalls: 0, directorSources: [],
      searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const source: ProductionArticleSourceSnapshot = {
      sourceId: "source-report",
      originalUrl: "https://news.example/report",
      finalUrl: "https://news.example/report",
      pageTitle: "公开报告",
      fetchedAt: "2026-09-14T08:00:00.000Z",
      contentSha256: "a".repeat(64),
      extractorVersion: "readability-v1",
      readStatus: "read",
      paragraphs: [{ id: "p1", text: "报告正文中的可核对事实。" }],
      truncated: false,
    };
    const first = await pipeline.start({ ...closureBrief(), articleSources: [source] });
    assert.equal(spies.treatmentSources?.[0]?.[0] && (spies.treatmentSources[0]![0] as { sourceId: string }).sourceId, source.sourceId);
    assert.deepEqual(spies.screenwriterSources?.[0], [source]);
    assert.deepEqual(spies.directorSources?.[0], [source]);

    const current = await effectivePlanningInput(pipeline, first.id);
    const updatedSource = {
      ...source,
      contentSha256: "b".repeat(64),
      paragraphs: [{ id: "p1", text: "刷新后正文中的另一项可核对事实。" }],
    };
    await pipeline.applyNodeInputOverride(first.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, first.id),
      input: { brief: { ...current.brief, articleSources: [updatedSource] } },
    });
    await pipeline.resumeStale(first.id);

    assert.equal(spies.treatmentSources?.length, 2);
    assert.deepEqual(spies.screenwriterSources?.[1], [updatedSource]);
    assert.deepEqual(spies.directorSources?.[1], [updatedSource]);
  });

  it("lets only one of two concurrent confirmation command ids advance the current gate", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-creative-confirm-race-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const run = await pipeline.start(closureBrief({ creativeReview: true }));
    const gate = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.intervention?.continuation;
    assert.ok(gate);
    // OA-03：pass/repair 确认都必须提交停点展示的那一条复核身份。
    const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    const shown = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[gate.stage]?.checkResult;
    const common = {
      actor: "creator",
      expectedRunRevision: run.revision,
      expectedReviewRevision: gate.reviewRevision,
      stage: gate.stage,
      baseDraftSha256: gate.draftSha256,
      ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
      ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
    };
    const outcomes = await Promise.allSettled([
      pipeline.confirmCreativeReview(run.id, { ...common, commandId: "confirm-race-a" }),
      pipeline.confirmCreativeReview(run.id, { ...common, commandId: "confirm-race-b" }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.deepEqual(spies.screenwriterCalls, ["joint-v1 规划编辑闭环"]);
  });

  it("只认当前那一份复核：过期页面上的“仍然确认”被拒，当前页面的复用不再新增审计", async () => {
    // F1 的反例，逐条走真实 pipeline：草稿没变、复核版本前进了。旧页面拿着旧版本号提交，
    // 系统必须拒绝，而不是替他把旧确认绑到新记录上；当前页面按他真正看到的那一条确认则要
    // 走通，并且复用已展示的复核——不新增一轮审计，这正是“默认审计一轮”。
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-creative-stale-confirm-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = newClosurePipeline(workspaceRoot, spies, { repairCheck: true });
    const started = await pipeline.start(closureBrief({ creativeReview: true }));

    const gateOf = (run: WorkflowRun<ProductionBrief>) => {
      const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning");
      assert.ok(node?.intervention?.continuation, "创作规划必须停在复核停点上");
      return { node, continuation: node.intervention.continuation };
    };
    const checkIdentityOf = (run: WorkflowRun<ProductionBrief>) => {
      const output = gateOf(run).node.output as {
        creativeReview: { stages: Record<string, { checkResult?: { verdict: string; checkIdentity: string } }> };
      };
      const checkResult = output.creativeReview.stages.treatment?.checkResult;
      assert.ok(checkResult, "复核跑完必须留下可回查的裁决记录");
      return checkResult;
    };

    const opener = gateOf(started).continuation;
    assert.equal(opener.stage, "treatment");
    // 初稿到达人时已经独立审计；旧页面看到的是草稿 H、复核版本 R。
    const stalePage = { expectedReviewRevision: opener.reviewRevision, baseDraftSha256: opener.draftSha256 };
    assert.equal(spies.treatmentAuditCalls, 1);
    assert.equal(checkIdentityOf(started).verdict, "repair");

    // 用户主动再审当前稿；只审不改、不推进，新意见成为当前页面看到的一条。
    const checked = (await pipeline.dispatchCreativeReviewCommand(started.id, {
      action: "audit_current",
      commandId: "audit-current",
      actor: "creator",
      stage: "treatment",
      expectedRunRevision: started.revision,
      ...stalePage,
    })).completion;
    const checkedRun = await checked;
    assert.equal(spies.treatmentAuditCalls, 2);
    assert.equal(checkedRun.status, "needs_human");
    const afterCheck = gateOf(checkedRun).continuation;
    assert.equal(afterCheck.stage, "treatment");
    assert.equal(afterCheck.draftSha256, stalePage.baseDraftSha256, "裁决只给建议，不改草稿");
    assert.notEqual(afterCheck.reviewRevision, stalePage.expectedReviewRevision);
    const shown = checkIdentityOf(checkedRun);
    assert.equal(shown.verdict, "repair");

    // 旧页面提交：复核版本还停在 R，而记录已经前进。这份确认只能被拒。
    await assert.rejects(
      () => pipeline.confirmCreativeReview(checkedRun.id, {
        commandId: "confirm-from-stale-page",
        actor: "creator",
        stage: "treatment",
        expectedRunRevision: checkedRun.revision,
        ...stalePage,
        acknowledgeRepair: true,
        expectedCheckIdentity: shown.checkIdentity,
      }),
      /stale or belongs to another stage draft/,
    );

    // 版本对上了、但编号指向另一条复核：同样不放行——人确认的必须是他看见的那一份。
    await assert.rejects(
      () => pipeline.confirmCreativeReview(checkedRun.id, {
        commandId: "confirm-with-wrong-check",
        actor: "creator",
        stage: "treatment",
        expectedRunRevision: checkedRun.revision,
        expectedReviewRevision: afterCheck.reviewRevision,
        baseDraftSha256: afterCheck.draftSha256,
        acknowledgeRepair: true,
        expectedCheckIdentity: "0".repeat(64),
      }),
      /复核/,
    );

    // 两次被拒都没有推走流程：仍停在同一个阶段，也没有偷偷多跑一轮审计。
    const stillWaiting = await pipeline.show(checkedRun.id);
    assert.equal(stillWaiting.status, "needs_human");
    assert.equal(gateOf(stillWaiting).continuation.stage, "treatment");
    assert.equal(spies.treatmentAuditCalls, 2);

    // 当前页面按他真正看到的那一条确认：复用，不新增审计。
    const confirmed = await pipeline.confirmCreativeReview(checkedRun.id, {
      commandId: "confirm-current-check",
      actor: "creator",
      stage: "treatment",
      expectedRunRevision: stillWaiting.revision,
      expectedReviewRevision: afterCheck.reviewRevision,
      baseDraftSha256: afterCheck.draftSha256,
      acknowledgeRepair: true,
      expectedCheckIdentity: shown.checkIdentity,
    });
    assert.equal(spies.treatmentAuditCalls, 2, "确认复用已展示的复核，不能悄悄再跑一轮");
    assert.equal(gateOf(confirmed).continuation.stage, "script");
    assert.deepEqual(spies.screenwriterCalls, ["joint-v1 规划编辑闭环"]);
  });

  it("projects three durable creative review waits and rejects generic approval", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-creative-review-pipeline-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    let run = await pipeline.start(closureBrief({ creativeReview: true }));
    assert.equal(run.workflowVersion, "1.7.0");
    assert.equal(run.status, "needs_human");
    assert.deepEqual(spies.screenwriterCalls, []);
    assert.equal(spies.directorCalls, 0);

    const waiting = () => {
      const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning");
      assert.equal(
        node?.intervention?.kind,
        "creative_review",
        `expected creative review gate, got ${JSON.stringify({ status: run.status, node })}`,
      );
      assert.ok(node?.intervention?.continuation);
      return node.intervention.continuation;
    };
    await assert.rejects(
      () => pipeline.decide(run.id, {
        interventionId: run.nodeRuns.find((node) => node.nodeId === "creative-planning")!.intervention!.id,
        action: "approve",
        actor: "creator",
        expectedRunRevision: run.revision,
      }),
      /generic decision endpoint|stage confirmation command/,
    );

    const confirm = async (commandId: string) => {
      const gate = waiting();
      // pass 确认提交的就是停点展示给用户的那一条复核身份（OA-03：图层不再代填）。
      const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
      const review = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { checkIdentity?: string } }> } })?.creativeReview;
      const identity = review?.stages?.[gate.stage]?.checkResult?.checkIdentity;
      const command = {
        commandId,
        actor: "creator",
        expectedRunRevision: run.revision,
        expectedReviewRevision: gate.reviewRevision,
        stage: gate.stage,
        baseDraftSha256: gate.draftSha256,
        ...(identity ? { expectedCheckIdentity: identity } : {}),
      };
      run = await pipeline.confirmCreativeReview(run.id, command);
      return command;
    };
    const treatmentCommand = await confirm("confirm-treatment");
    assert.equal(waiting().stage, "script");
    assert.deepEqual(spies.screenwriterCalls, ["joint-v1 规划编辑闭环"]);
    assert.equal(spies.directorCalls, 0);
    const revisionAfterTreatment = run.revision;
    const replayed = await pipeline.confirmCreativeReview(run.id, treatmentCommand);
    assert.equal(replayed.revision, revisionAfterTreatment);
    assert.deepEqual(spies.screenwriterCalls, ["joint-v1 规划编辑闭环"]);
    await assert.rejects(
      () => pipeline.confirmCreativeReview(run.id, { ...treatmentCommand, actor: "different-actor" }),
      /already used with different content/,
    );

    await confirm("confirm-script");
    assert.equal(waiting().stage, "director");
    assert.equal(spies.directorCalls, 1);

    const directorGate = waiting();
    await assert.rejects(() => pipeline.confirmCreativeReview(run.id, {
      commandId: "wrong-director-purpose", actor: "creator", expectedRunRevision: run.revision,
      expectedReviewRevision: directorGate.reviewRevision, stage: "director",
      baseDraftSha256: directorGate.draftSha256, reviewPurpose: "material_plan",
    }), /another director decision/);

    await confirm("confirm-director");
    assert.notEqual(run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.status, "needs_human");
    assert.equal(spies.treatmentTitles.length, 1);
    assert.equal(spies.treatmentAuditCalls, 1);
    assert.equal(spies.screenwriterCalls.length, 1);
    assert.equal(spies.screenwriterAuditCalls, 1);
    assert.equal(spies.directorCalls, 1);
    assert.equal(spies.directorAuditCalls, 1);
  });
  it("pauses paid generation on an unfinished source review; approve cannot skip it and retry only completes the review", async () => {
    // 资金安全链（R03/R05）：试片审查没跑成 → assets 转暂停干预；通用放行被服务端拒绝且
    // 无任何状态变化；重试只重跑该节点（第二次 asset.prepare 成功），制作继续推进。
    class SourceReviewFlakyWorker extends ClosureWorker {
      assetPrepareCalls = 0;
      async run(request: Record<string, unknown>): Promise<WorkerResponse> {
        if (String(request.capability) === "asset.prepare") {
          this.assetPrepareCalls += 1;
          if (this.assetPrepareCalls === 1) {
            throw sourceReviewIncompleteError(
              "镜头 1 已生成，但试片审查暂未完成，后续付费生成已停止。重试时会复用该镜头并恢复审查。",
            );
          }
        }
        return super.run(request);
      }
    }
    const worker = new SourceReviewFlakyWorker();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-source-review-pause-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    let run = await pipeline.start(closureBrief({ creativeReview: true }));

    // 走完三个规划阶段的确认，规划完成后流程自动进入 assets。
    for (const stage of ["treatment", "script", "director"] as const) {
      const gate = () => {
        const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning");
        assert.equal(node?.intervention?.kind, "creative_review");
        return node.intervention!.continuation!;
      };
      const continuation = gate();
      // 每个阶段的停点都会展示本版首审意见；确认提交用户看到的那一条身份（OA-03）。
      const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
      const shown = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[continuation.stage]?.checkResult;
      run = await pipeline.confirmCreativeReview(run.id, {
        commandId: `confirm-${stage}`,
        actor: "creator",
        stage: continuation.stage,
        expectedRunRevision: run.revision,
        expectedReviewRevision: continuation.reviewRevision,
        baseDraftSha256: continuation.draftSha256,
        ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
        ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
      });
    }
    // 三个阶段确认完成后等待规划编译收尾并自动进入 assets（审查未完成处暂停）。
    for (let i = 0; i < 60; i += 1) {
      run = await pipeline.show(run.id);
      const assets = run.nodeRuns.find((node) => node.nodeId === "assets");
      if (assets?.status === "needs_human") break;
      if (run.status === "failed" || run.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    run = await pipeline.show(run.id);
    const assetsNode = run.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(assetsNode?.status, "needs_human", `assets 应因审查未完成暂停，实际 run=${run.status} assets=${assetsNode?.status} err=${assetsNode?.error ?? ""}`);
    assert.equal(assetsNode?.intervention?.kind, "source_review_retry");
    assert.equal(worker.assetPrepareCalls, 1, "暂停前只发生一次 asset.prepare 请求");

    // R05：普通 approve 被服务端硬禁，且不产生任何状态或资金副作用。
    const revisionBefore = run.revision;
    await assert.rejects(
      () => pipeline.decide(run.id, {
        interventionId: assetsNode!.intervention!.id,
        action: "approve",
        actor: "creator",
        expectedRunRevision: run.revision,
      }),
      /不能跳过审查继续制作/,
    );
    const afterRefusal = await pipeline.show(run.id);
    assert.equal(afterRefusal.status, "needs_human");
    assert.equal(afterRefusal.revision, revisionBefore, "被拒的放行不得改变 run 状态");

    // 重试：只重跑 assets 节点；第二次 asset.prepare 成功后流程继续。
    run = await pipeline.retryFailedNode(run.id, "assets");
    assert.equal(worker.assetPrepareCalls, 2, "重试恰好补跑一次 asset.prepare");
    assert.notEqual(run.status, "failed");
    assert.notEqual(run.nodeRuns.find((node) => node.nodeId === "assets")?.status, "needs_human");
  });

  it("feeds visual intent and script-owned rework into treatment identity and execution", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-treatment-rework-identity-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], treatmentInputs: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const initialInstruction = "把原实证承诺改为明确标注的概念示意，不声称普遍结论。";
    const brief = {
      ...closureBrief(),
      visualIntent: "使用三幅无字生成静帧解释构图变化。",
      rework: {
        sourceRunId: "source-run-not-required-before-assets",
        sourceRunRevision: 1,
        nodeInstructions: {
          script: initialInstruction,
          visualDirection: "保持无字静帧路线。",
          assets: "只生成方案明确要求的静帧。",
        },
        findings: [],
      },
    } as ProductionBrief;

    const run = await pipeline.start(brief);
    assert.equal(run.status, "needs_human", "the fixture pauses after planning when its source run is absent");
    assert.deepEqual(spies.treatmentInputs, [{
      visualIntent: brief.visualIntent,
      reworkInstruction: initialInstruction,
    }]);

    const current = await effectivePlanningInput(pipeline, run.id);
    const nextInstruction = "保留概念示意，并删去任何需要真实受试者数据的承诺。";
    await pipeline.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, run.id),
      input: {
        brief: {
          ...(current.brief as ProductionBrief),
          rework: {
            ...(current.brief as ProductionBrief).rework!,
            nodeInstructions: {
              ...(current.brief as ProductionBrief).rework!.nodeInstructions,
              script: nextInstruction,
            },
          },
        },
      },
    });
    await pipeline.resumeStale(run.id);
    assert.deepEqual(spies.treatmentInputs, [
      { visualIntent: brief.visualIntent, reworkInstruction: initialInstruction },
      { visualIntent: brief.visualIntent, reworkInstruction: nextInstruction },
    ], "changing treatment-owned rework must invalidate the treatment stage instead of carrying the old candidate");
  });

  it("feeds the edited planning input (request.brief) into the next planning execution", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-closure-request-brief-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.deepEqual(spies.treatmentTitles, ["joint-v1 规划编辑闭环"]);

    const original = await effectivePlanningInput(pipeline, run.id);
    await pipeline.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, run.id),
      input: { brief: { ...original.brief, title: "改题后的真实执行" } },
    });
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.deepEqual(
      spies.treatmentTitles,
      ["joint-v1 规划编辑闭环", "改题后的真实执行"],
      "the treatment port must consume the edited request.brief, not a re-read of the stale brief",
    );
    assert.deepEqual(
      spies.screenwriterCalls,
      ["joint-v1 规划编辑闭环", "改题后的真实执行"],
      "the screenwriter brief must reflect the edited title",
    );
  });

  it("strips a legacy template snapshot without invalidating accepted planning", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-closure-script-edit-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human");

    // 模板已暂停参与新制作；旧字段只在新执行边界剥离，不能改变任何角色身份。
    const original = await effectivePlanningInput(pipeline, run.id);
    assert.equal(original.brief.templateSnapshot, undefined);
    await pipeline.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, run.id),
      input: { brief: { ...original.brief, templateSnapshot: scriptStageTemplateSnapshot() } },
    });
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    assert.equal(spies.treatmentTitles.length, 1, "a retired template field must not change the treatment identity");
    assert.equal(spies.screenwriterCalls.length, 1, "a retired template field must not rerun the script stage");
    assert.equal(spies.directorCalls, 1, "a retired template field must not rerun the director stage");
    const formal = resumed.artifacts.filter((artifact) => artifact.producer?.nodeId === "creative-planning" && artifact.kind === "script");
    assert.equal(formal.length, 1, "the accepted planning artifact remains the only effective production artifact");
  });

  it("isolates joint script and director role checkpoints by the actual selected model", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-closure-role-model-checkpoints-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], screenwriterCheckpointPairs: [], directorCalls: 0, directorCheckpointPairs: [],
      searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human");
    assert.equal(spies.screenwriterCheckpointPairs?.length, 1);
    assert.notEqual(spies.screenwriterCheckpointPairs?.[0]?.[0], spies.screenwriterCheckpointPairs?.[0]?.[1]);
    assert.equal(spies.directorCheckpointPairs?.length, 1);
    assert.notEqual(spies.directorCheckpointPairs?.[0]?.[0], spies.directorCheckpointPairs?.[0]?.[1]);
  });

  it("keeps the valid treatment and script when only the director model changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-closure-director-edit-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human");
    assert.equal(spies.treatmentTitles.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1);
    assert.equal(spies.directorCalls, 1);

    const updatedBrief = { ...closureBrief(), models: { "api-visual-director-v1": "director-model-b" } } as ProductionBrief;
    await pipeline.applyNodeExecutionConfiguration(run.id, "creative-planning", updatedBrief, "producer", run.revision);
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    assert.equal(spies.treatmentTitles.length, 1, "a director-stage model edit must not re-run the valid treatment");
    assert.equal(spies.screenwriterCalls.length, 1, "a director-stage model edit must not re-run the valid script");
    assert.equal(spies.directorCalls, 2, "the director stage must re-run with the changed model identity");
  });

  it("routes treatment model selection through the existing candidate ordering contract", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-closure-treatment-model-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const run = await pipeline.start(closureBrief({ models: { [TREATMENT_PROVIDER_ID]: "treatment-model-b" } }));
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    assert.deepEqual(
      spies.treatmentModelCalls,
      ["treatment-model-b"],
      "the selected treatment model must drive real routing instead of always using the first candidate",
    );
  });

  it("fails over to the next treatment candidate on a confirmed not_accepted provider failure", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-closure-treatment-fallback-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies, { failFirstCandidate: true });
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    assert.deepEqual(
      spies.treatmentModelCalls,
      ["treatment-model-a", "treatment-model-b"],
      "a not_accepted provider failure on the first treatment candidate must fail over to the next candidate",
    );
  });

  it("binds planning role traces to the current input digest only", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-closure-trace-digest-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human");

    // 编剧替身把 selectedModelId 写进 trace；选择另一个模型后重跑，旧 digest 的 trace 不得冒充。
    await pipeline.applyNodeExecutionConfiguration(
      run.id,
      "creative-planning",
      { ...closureBrief(), models: { "codex-screenwriter-v1": "screenwriter-model-two" } } as ProductionBrief,
      "producer",
      await currentRunRevision(pipeline, run.id),
    )

    // 重跑之前：pending 阶段必须展示当前有效绑定模型（用户据此判断这次会用哪个模型）。
    const pendingStages = await pipeline.inspectCreativePlanningStages(run.id);
    assert.ok(pendingStages, "the stale joint run still exposes its route stages");
    const pendingScript = pendingStages.find((stage) => stage.id === "script");
    assert.ok(pendingScript);
    assert.equal(pendingScript.status, "pending");
    assert.equal(
      pendingScript.effectiveModelId,
      "screenwriter-model-two",
      "pending model stages must show the currently effective model binding",
    );

    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    // 植入一个 mtime 最新的伪造 v7 checkpoint：不属于当前 input digest 的执行 trace 不得
    // 冒充当前规划的真实执行模型。
    const checkpointDir = path.join(workspaceRoot, "runs", resumed.id, "nodes", "creative-planning", "agent-loop-checkpoints");
    await mkdir(checkpointDir, { recursive: true });
    const staleCheckpoint = {
      version: "video-factory/agent-loop-checkpoint-v7",
      key: "stale-digest-key",
      contractDigest: "stale-digest",
      role: "编剧",
      maxIterations: 3,
      cycle: 1,
      status: "passed",
      completed: [{
        iteration: 1,
        candidate: {},
        candidateTrace: {
          taskKind: "script.draft",
          promptVersion: "v1",
          prompt: "stale",
          providerId: "codex-screenwriter-v1",
          modelId: "planted-stale-model",
        },
        audit: { verdict: "pass", score: 90, summary: "陈旧" },
      }],
      operationGenerations: {},
      failedOperationRequestIds: {},
      attemptedRequestIds: [],
      sessions: {},
      phaseAttempts: { produce: 1, audit: 1 },
      phaseDurationsMs: { produce: 1, audit: 1 },
      validationMs: 1,
      retriedRequestIds: [],
    };
    await writeFile(path.join(checkpointDir, "planted-stale.json"), `${JSON.stringify(staleCheckpoint, null, 2)}\n`);

    const stages = await pipeline.inspectCreativePlanningStages(resumed.id);
    assert.ok(stages, "the resumed joint run must expose planning stages");
    const script = stages.find((stage) => stage.id === "script");
    assert.ok(script);
    assert.equal(
      script.effectiveModelId,
      "screenwriter-model-two",
      "the script stage must report the model that actually ran for the current input digest, never a stale trace",
    );
  });

});

// ---------------------------------------------------------------------------
// B4-FIX（Oracle 第5档审计反馈）：部分完成执行的闭包前驱、A→B→A 重放前驱选择、
// 携带阶段 trace 继承、素材目录变化进入导演身份、不可用模型选择 fail closed、
// fallback 候选 durable checkpoint、图库路线闭包。
// ---------------------------------------------------------------------------

class ClosureLibraryWorker extends ClosureWorker {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    if (capability !== "asset.search") return super.run(request);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const report = {
      version: "video-factory/asset-candidates-v1",
      scene_candidates: [1, 2, 3].map((position) => ({
        scene_position: position,
        intent: { query: `stock-query-${position}` },
        query: `stock-query-${position}`,
        candidates: [{
          provider: "pexels-stock-v1",
          asset_id: `asset-${position}`,
          media_type: "video",
          width: 1920,
          height: 1080,
          duration: 6,
          preview_url: `https://images.pexels.com/preview-${position}.jpg`,
          source_url: `https://videos.pexels.com/video-${position}`,
          creator: "fixture-creator",
          license_note: "Fixture license.",
          query: `stock-query-${position}`,
          score: 80,
        }],
      })),
    };
    const content = JSON.stringify(report, null, 2);
    const candidateSearchPath = path.join(outputDir, "candidate_search.json");
    const candidateInventoryPath = path.join(outputDir, "candidate_inventory.json");
    await writeFile(candidateSearchPath, content);
    await writeFile(candidateInventoryPath, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output: { candidateSearchPath, candidateInventoryPath },
      artifacts: [{
        kind: "asset_candidates",
        uri: candidateSearchPath,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
        contentType: "application/json",
        provenance: {
          providerId: "asset-candidate-search-v1",
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }],
    };
  }
}

function closureRanker(
  spies: ClosureSpies,
  options: { modelId?: string; failFirstCall?: boolean } = {},
): NonNullable<ProductionPipelineOptions["assetSemanticRanker"]> {
  const modelId = options.modelId ?? "ranker-binding-model";
  let calls = 0;
  return {
    id: "codex-asset-ranker-v1",
    modelId,
    rank: async () => {
      throw new Error("closure fixtures must use rankDetailed");
    },
    rankDetailed: async (
      report: { scenes: Array<{ scenePosition: number; candidates: Array<{ provider: string; assetId: string }> }>; planningIntent?: { rankingIntent?: unknown; semanticIntentVersion?: string } },
      checkpoint?: { key?: string },
      selectedModelId?: string,
    ) => {
      calls += 1;
      spies.rankCalls += 1;
      spies.rankRequests.push({ ...(report.planningIntent !== undefined ? { planningIntent: report.planningIntent } : {}) });
      // checkpoint 消费：fake 必须读取并记录 durable checkpoint 身份。
      spies.rankCheckpoints.push({ ...(checkpoint?.key !== undefined ? { key: checkpoint.key } : {}) });

      if (options.failFirstCall && calls === 1) {
        // 排序角色的瞬时故障：规划节点失败停在 rank 阶段，由重试合同恢复。
        throw new Error("simulated ranker outage on the first attempt");
      }
      return {
        output: {
          version: "video-factory/asset-ranking-v1",
          source: "model",
          providerId: "codex-asset-ranker-v1",
          modelId: selectedModelId ?? modelId,
          summary: "语义排序完成",
          scenes: report.scenes.map((scene) => ({
            scenePosition: scene.scenePosition,
            summary: "高分候选可用",
            candidates: scene.candidates.slice(0, 1).map((candidate, index) => ({
              provider: candidate.provider,
              assetId: candidate.assetId,
              originalRank: index + 1,
              rank: index + 1,
              semanticScore: 80,
              rationale: "语义分足够",
              locked: false,
            })),
          })),
        },
        trace: {
          taskKind: "asset-rank" as const,
          promptVersion: "v1",
          prompt: "fixture prompt",
          providerId: "codex-asset-ranker-v1",
          modelId: selectedModelId ?? modelId,
        },
      };
    },
  };
}

function flakyDirector(spies: ClosureSpies, options: { failFirstCall?: boolean } = {}): VisualDirectorAgent {
  let calls = 0;
  return {
    id: "api-visual-director-v1",
    modelId: "director-binding-model",
    plan: async (input: VisualDirectorAgentInput) => {
      calls += 1;
      spies.directorCalls += 1;
      if (options.failFirstCall && calls === 1) {
        throw new Error("director provider temporarily unavailable");
      }
      return {
        version: "video-factory/director-plan-v1",
        requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer",
        profileRationale: "用真实动作解释。",
        visualBible: {
          narrativeApproach: "逐步展示", motif: "窗边光影", pacing: "均匀", composition: "稳定中景",
          camera: "固定机位", color: "自然色", continuity: "同一时段", transitionGrammar: "硬切配字幕",
          sound: "环境声", antiPatterns: ["不用电影感运镜"],
        },
        shots: input.scenes.map((scene) => ({
          scenePosition: scene.position,
          reuseFromScenePosition: null,
          referenceFromScenePosition: null,
          narrativeRole: "解释",
          authenticityPolicy: "illustrative",
          preferredProviderId: "local-editorial-v1",
          deliveryType: "editorial_card",
          alternativeProviderIds: [],
          subject: `第${scene.position}段示意主体`,
          environment: "桌面一角，自然光",
          visibleAction: `第${scene.position}段标注动作`,
          temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
          shotSize: "中景卡片",
          sourceInSeconds: 0,
          camera: "固定",
          lighting: "自然光",
          negativeConstraints: ["不冒充真实事件"],
          referenceRequirements: [],
          successCriteria: ["卡面文字可读"],
          query: `editorial-${scene.position}`,
          generationPrompt: `第${scene.position}个真实生活动作`,
          rationale: "本地说明卡可以执行。",
          continuityNote: "保持自然色。",
          confidence: 0.8,
          estimatedCostCny: 0,
        })),
      };
    },
  };
}

function countSearchCalls(worker: ClosureLibraryWorker): number {
  return (worker as unknown as { searchCalls?: number }).searchCalls ?? 0;
}

// 图库路线导演替身：stock 镜头，检索词与 ClosureLibraryWorker 的候选报告一致。
function closureLibraryDirector(spies: ClosureSpies): VisualDirectorAgent {
  return {
    id: "api-visual-director-v1",
    modelId: "director-binding-model",
    plan: async (input: VisualDirectorAgentInput) => {
      spies.directorCalls += 1;
      return {
        version: "video-factory/director-plan-v1",
        requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer",
        profileRationale: "用真实动作解释。",
        visualBible: {
          narrativeApproach: "逐步展示", motif: "窗边光影", pacing: "均匀", composition: "稳定中景",
          camera: "固定机位", color: "自然色", continuity: "同一时段", transitionGrammar: "硬切配字幕",
          sound: "环境声", antiPatterns: ["不用电影感运镜"],
        },
        shots: input.scenes.map((scene) => ({
          scenePosition: scene.position,
          narrativeRole: "解释",
          authenticityPolicy: "illustrative",
          preferredProviderId: "pexels-stock-v1",
          deliveryType: "stock_video",
          alternativeProviderIds: [],
          temporalBeats: [`[0s-4s] 建立动作`, `[4s-8s] 完成动作`],
          query: `stock-query-${scene.position}`,
          generationPrompt: `第${scene.position}个真实生活动作`,
          rationale: "真实图库可以执行。",
          continuityNote: "保持自然色。",
          confidence: 0.8,
          estimatedCostCny: 0,
        })),
      };
    },
  };
}

describe("joint-v1 planning closure Oracle fixes (B4-FIX)", () => {
  it("audits an edited director draft with optional null fields without changing its published identity", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-audit-exact-edited-director-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies);
    let run = await pipeline.start(closureBrief({ creativeReview: true }));
    const current = () => {
      const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
      const gate = node.intervention!.continuation!;
      const review = (node.output as { creativeReview: CreativeReviewState }).creativeReview;
      return { gate, review, stage: review.stages[gate.stage] };
    };
    for (const stage of ["treatment", "script"] as const) {
      const { gate, stage: state } = current();
      run = await pipeline.confirmCreativeReview(run.id, { commandId: `confirm-${stage}`, actor: "creator", stage,
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision, baseDraftSha256: gate.draftSha256,
        expectedCheckIdentity: state.checkResult!.checkIdentity });
    }
    const { gate, stage } = current();
    const document = structuredClone(stage.currentDocument) as { visualBible: Record<string, unknown>; shots: Array<Record<string, unknown>> };
    delete document.visualBible.viewerPromise;
    for (const shot of document.shots) { shot.reuseFromScenePosition = null; shot.referenceFromScenePosition = null; }
    run = await (await pipeline.dispatchCreativeReviewCommand(run.id, { action: "edit_draft", stage: "director", commandId: "edit-director", actor: "creator",
      expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision, baseDraftSha256: gate.draftSha256, document })).completion;
    const edited = current();
    assert.equal(edited.stage.checkResult, null);
    const hash = edited.gate.draftSha256;
    run = await (await pipeline.dispatchCreativeReviewCommand(run.id, { action: "audit_current", stage: "director", commandId: "audit-edited-director", actor: "creator",
      expectedRunRevision: run.revision, expectedReviewRevision: edited.gate.reviewRevision, baseDraftSha256: hash })).completion;
    assert.equal(run.status, "needs_human");
    const checked = current();
    assert.deepEqual(checked.stage.currentDocument, document);
    assert.equal(checked.gate.draftSha256, hash);
    assert.equal(checked.stage.checkResult?.draftSha256, hash);
    assert.equal(checked.stage.checkResult?.verdict, "pass");
    assert.equal(spies.directorCalls, 1, "主动审计不重新产稿");
    assert.equal(spies.directorAuditCalls, 2, "一次首审及一次用户主动再审");
  });

  for (const sourceReview of [false, true, "incomplete"] as const) it(`delivers host-bound stock consent to the actual asset worker without changing scores (sourceReview=${sourceReview})`, async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-stock-consent-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const ranker = closureRanker(spies);
    const rank = ranker.rankDetailed!;
    ranker.rankDetailed = async (...args) => {
      const execution = await rank(...args);
      for (const scene of execution.output.scenes) for (const candidate of scene.candidates) candidate.semanticScore = 20;
      return execution;
    };
    const director = closureLibraryDirector(spies);
    director.planDetailed = async input => input.creativeReviewExecution?.mode === "check"
      ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "视觉导演", "fixture-director-contract-v1", "director-plan", "director-binding-model")
      : { output: await director.plan(input) };
    const worker = new ClosureLibraryWorker();
    const execute = worker.run.bind(worker);
    let prepared: Record<string, unknown> | undefined;
    worker.run = async request => {
      if (request.capability === "voice.synthesize") throw new Error("intentional stop at voice boundary");
      if (request.capability === "asset.prepare") {
        prepared = request;
        if (!sourceReview) throw new Error("intentional stop at media boundary");
        const response = await execute(request);
        const content = JSON.stringify({ scene_assets: [1, 2, 3].map(scene_position => ({ scene_position, provider: "pexels-stock-v1", asset_id: `asset-${scene_position}` })),
          director_routing: [1, 2, 3].map(scene_position => ({ scene_position, selection_basis: "accepted_quality_risk", quality_review_status: "unverified" })) });
        await writeFile(String(response.output!.assetPlanPath), content);
        response.artifacts[0]!.kind = "asset_plan";
        response.artifacts[0]!.sha256 = createHash("sha256").update(content).digest("hex");
        response.artifacts[0]!.sizeBytes = Buffer.byteLength(content);
        return response;
      }
      return execute(request);
    };
    const pipelineOptions: ProductionPipelineOptions = { workspaceRoot, worker,
      treatmentAgents: closureTreatmentAgents(spies), screenwriterAgent: closureScreenwriter(spies), directorAgent: director,
      assetSemanticRanker: ranker, assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] }, ...CLOSURE_ASSET_PROVIDERS],
      providerRuntimeMetadata: sourceReview ? [{ id: "deepseek-visual-review-v1", label: "审片", modelId: "test-model", transport: "unix_socket", billing: "subscription", approvalPolicy: "none", maxAttempts: 1 }] : [],
      visualReviewAgents: sourceReview ? [{ id: "deepseek-visual-review-v1", modelId: "test-model", review: async () => {
        if (sourceReview === "incomplete") throw new RoleAgentLoopError("review completed without output", {
          version: "video-factory/agent-loop-v1", role: "审片", contractVersion: "test", criteria: [], status: "failed", maxIterations: 3,
          iterations: [], failure: { stage: "completed_failure" },
        }, undefined, new CodexBridgeError("completed", false, "completed_failure", 502, "model_provider_no_output"));
        return {
        version: "video-factory/visual-review-v1", summary: "示意素材匹配一般", scores: { composition: 30, continuity: 30, pacing: 30, legibility: 30, safety: 90 }, confidence: 0.8, recommendation: "reject",
        findings: [{ timecodeMs: 0, startTimecodeMs: 0, endTimecodeMs: 0, scenePosition: 1, targetNodeId: "assets", claimType: "static", evidenceStatus: "failed", evidenceFrameSha256: null, nextAction: "rework_asset", category: "composition", severity: "warning", description: "主体不够清楚", suggestion: "可替换更好素材" }],
      }; } }] : [],
    };
    let pipeline = new ProductionPipeline(pipelineOptions);
    const brief = closureBrief({ assetSemanticRank: true, creativeReview: true });
    if (sourceReview) brief.providers.visualReview = "deepseek-visual-review-v1";
    let run = await pipeline.start(brief);
    for (const stage of ["treatment", "script", "director", "director"] as const) {
      const gate = run.nodeRuns.find(node => node.nodeId === "creative-planning")?.intervention?.continuation;
      assert.equal(gate?.stage, stage, JSON.stringify(run.nodeRuns));
      const purpose = (run.nodeRuns.find(node => node.nodeId === "creative-planning")?.output as { creativeReview?: { directorReviewPurpose?: string } } | undefined)
        ?.creativeReview?.directorReviewPurpose;
      if (stage === "director" && purpose === "direction") {
        assert.equal(spies.searchCalls, 0, "the initial director gate must precede candidate search");
      }
      const gateNode = run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
      const shown = (gateNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[stage]?.checkResult;
      // 选材确认跨部署恢复：目录描述更新不能让用户已看过的素材风险与稿件失效。
      if (purpose === "material_plan") pipeline = new ProductionPipeline({ ...pipelineOptions,
        assetProviders: pipelineOptions.assetProviders!.map(provider => ({ ...provider, label: `${provider.label} 新目录说明` })) });
      run = await pipeline.confirmCreativeReview(run.id, { commandId: `accept-${stage}-${purpose ?? "draft"}`, actor: "creator", stage,
        expectedRunRevision: run.revision, expectedReviewRevision: gate!.reviewRevision, baseDraftSha256: gate!.draftSha256,
        ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
        ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
        ...(purpose === "material_plan" ? { acceptQualityFallback: true } : {}),
      });
    }
    const publishedStages = await pipeline.inspectCreativePlanningStages(run.id);
    assert.ok(publishedStages);
    assert.equal(publishedStages.find(stage => stage.id === "compile")?.status, "completed",
      "accepted stock quality risk must not make a published formal plan look unverified");
    assert.ok(publishedStages.find(stage => stage.id === "compile")?.artifactIds.length,
      "the read-side commit identity must include the accepted stock scope");
    assert.ok(prepared, "confirmation must reach the actual asset worker boundary");
    const input = prepared.input as Record<string, string>;
    const ranking = JSON.parse(await readFile(input.candidateRankingPath!, "utf8"));
    assert.equal(ranking.deliveryAcceptance.policyVersion, "playable-first-v1");
    for (const [field, key] of [["scriptSha256", "scriptPath"], ["directorPlanSha256", "directorPlanPath"], ["inventorySha256", "candidateInventoryPath"]]) {
      assert.equal(ranking.deliveryAcceptance[field!], createHash("sha256").update(await readFile(input[key!]!)).digest("hex"));
    }
    assert.equal(ranking.scenes[0].candidates[0].semanticScore, 20);
    assert.equal(ranking.scenes[0].candidates[0].locked, false);
    assert.equal(spies.rankCalls, 1);
    if (sourceReview) {
      const review = run.nodeRuns.find(node => node.nodeId === "asset-source-review");
      if (sourceReview === "incomplete") {
        assert.equal(review?.status, "needs_human");
        assert.equal((review?.output as { reviewStatus: string }).reviewStatus, "incomplete");
        assert.equal((review?.output as { report?: unknown }).report, undefined);
        const resumed = await pipeline.decide(run.id, { action: "approve", actor: "creator", expectedRunRevision: run.revision, interventionId: review!.intervention!.id, reviewEvidenceId: null });
        assert.ok(resumed.nodeRuns.some(node => node.nodeId === "voice"));
        return;
      }
      assert.equal(review?.status, "succeeded", JSON.stringify(run.nodeRuns));
      assert.equal((review?.output as { qualityRiskAccepted?: boolean }).qualityRiskAccepted, true);
      assert.equal((review?.output as { report: { scores: { composition: number } } }).report.scores.composition, 30);
      assert.ok(run.nodeRuns.some(node => node.nodeId === "voice"));
    }
  });
  it("preserves valid treatment and script when editing after a partially failed plan", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-partial-closure-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: flakyDirector(spies, { failFirstCall: true }),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "failed", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentTitles.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1);
    assert.equal(spies.directorCalls, 1, "the first attempt must fail at the director stage");

    // 导演阶段换模型：新 digest 的前驱是“部分完成的执行”，有效 treatment/script 必须保留。
    await pipeline.applyNodeExecutionConfiguration(
      run.id,
      "creative-planning",
      { ...closureBrief(), models: { "api-visual-director-v1": "director-model-two" } } as ProductionBrief,
      "producer",
      await currentRunRevision(pipeline, run.id),
    );
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentTitles.length, 1, "a director-stage edit after a partial failure must not re-run treatment");
    assert.equal(spies.screenwriterCalls.length, 1, "a director-stage edit after a partial failure must not re-run the valid script");
    assert.equal(spies.directorCalls, 2, "the director must re-run and succeed");
  });

  it("seeds from the most recently executed digest after an A→B→A replay", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-aba-replay-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await pipeline.start(closureBrief({ title: "方案甲" }));
    assert.equal(run.status, "needs_human");

    // A→B：改 title（treatment 输入变化，全链重跑）。
    const inputA = await effectivePlanningInput(pipeline, run.id);
    await pipeline.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, run.id),
      input: { brief: { ...(inputA.brief as ProductionBrief), title: "方案乙" } },
    });
    const afterB = await pipeline.resumeStale(run.id);
    assert.equal(afterB.status, "needs_human");
    assert.equal(spies.treatmentTitles.length, 2);

    // B→A：改回原 title（digest 回到 A，thread 重放，0 次新调用，A 的记录更新为最新执行）。
    await pipeline.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, run.id),
      input: { brief: { ...(inputA.brief as ProductionBrief), title: "方案甲" } },
    });
    const afterA = await pipeline.resumeStale(run.id);
    assert.equal(afterA.status, "needs_human", JSON.stringify(afterA.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentTitles.length, 2, "replaying digest A must not call any role");

    // A→C：只改导演模型；前驱必须是 A（最近执行），treatment/script 不重复调用。
    await pipeline.applyNodeExecutionConfiguration(
      run.id,
      "creative-planning",
      { ...closureBrief({ title: "方案甲" }), models: { "api-visual-director-v1": "director-model-two" } } as ProductionBrief,
      "producer",
      await currentRunRevision(pipeline, run.id),
    );
    const afterC = await pipeline.resumeStale(run.id);
    assert.equal(afterC.status, "needs_human", JSON.stringify(afterC.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentTitles.length, 2, "the post-replay edit must seed from A, not B");
    assert.equal(spies.screenwriterCalls.length, 2);
    assert.equal(spies.directorCalls, 3, "A and B each planned once; only the director re-runs for C");
  });

  it("carries model provenance for seeded stages into the new digest record", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-carried-trace-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await pipeline.start(closureBrief({ models: { [TREATMENT_PROVIDER_ID]: "treatment-model-b" } }));
    assert.equal(run.status, "needs_human");
    assert.deepEqual(spies.treatmentModelCalls, ["treatment-model-b"]);

    // 只改编剧输入：treatment 被携带，不重新执行；其 trace 必须继承到新 digest 的记录。
    const input = await effectivePlanningInput(pipeline, run.id);
    await pipeline.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, run.id),
      input: { brief: { ...(input.brief as ProductionBrief), visualProof: "关键步骤需要真实屏幕录制" } },
    });
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human");

    const stages = await pipeline.inspectCreativePlanningStages(resumed.id);
    assert.ok(stages);
    const treatment = stages.find((stage) => stage.id === "treatment");
    assert.ok(treatment);
    assert.equal(treatment.status, "completed");
    assert.equal(
      treatment.effectiveModelId,
      "treatment-model-b",
      "a seeded stage must inherit the model provenance of its artifact, not relabel it with the preferred binding",
    );
  });

  it("re-runs the director when the asset provider catalog changes under the same ids", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-provider-catalog-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const base = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await base.start(closureBrief());
    assert.equal(run.status, "needs_human");
    assert.equal(spies.directorCalls, 1);

    // 重启后同一 provider id 的目录条目变化（交付类型/约束/价格）：三个核心角色共享的
    // 能力摘要都已变化，不能继续携带任一旧角色成果。
    const restarted = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: [
        {
          id: "local-editorial-v1",
          label: "本地编辑卡片",
          billing: "free",
          modes: ["本地"],
          deliveryTypes: ["editorial_card"],
          constraints: ["新目录约束：单镜头最长 6 秒"],
        },
      ] as VisualAssetProviderCapability[],
    });
    const input = await effectivePlanningInput(restarted, run.id);
    await restarted.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      ...await jointPlanningEditTokens(restarted, run.id),
      input: { brief: { ...(input.brief as ProductionBrief), visualProof: "关键步骤需要真实屏幕录制" } },
    });
    const resumed = await restarted.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentTitles.length, 2, "能力摘要变化后构思必须基于当前目录重跑");
    assert.equal(spies.screenwriterCalls.length, 2, "the script edit itself re-runs the script");
    assert.equal(spies.directorCalls, 2, "the director must re-run because its real provider input changed");
  });

  it("fails closed instead of carrying a treatment across an unavailable model selection", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-unavailable-model-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human");
    assert.equal(spies.treatmentTitles.length, 1);

    await pipeline.applyNodeExecutionConfiguration(
      run.id,
      "creative-planning",
      { ...closureBrief(), models: { [TREATMENT_PROVIDER_ID]: "treatment-model-z" } } as ProductionBrief,
      "producer",
      await currentRunRevision(pipeline, run.id),
    );
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "failed", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const planningError = resumed.nodeRuns.find((node) => node.nodeId === "creative-planning")?.error ?? "";
    assert.match(planningError, /treatment-model-z.*not available|not available.*treatment-model-z/i);
    assert.equal(
      spies.treatmentTitles.length,
      1,
      "the stale treatment must not be carried over an unavailable selection; the shared contract rejects the selection before any candidate executes",
    );
  });

  it("gives every treatment fallback candidate a durable role checkpoint", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-fallback-checkpoint-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies, { failFirstCandidate: true }),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human");
    assert.deepEqual(spies.treatmentModelCalls, ["treatment-model-a", "treatment-model-b"]);
    assert.deepEqual(
      spies.treatmentCheckpointPresent,
      [true, true],
      "both the primary and the fallback treatment candidate must receive a durable role checkpoint",
    );
  });

  it("preserves library evidence across a director-stage edit on the library route", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-library-closure-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const searchWorker = new ClosureLibraryWorker();
    const originalRun = searchWorker.run.bind(searchWorker);
    let searchCalls = 0;
    searchWorker.run = async (request: Record<string, unknown>) => {
      if (request.capability === "asset.search") searchCalls += 1;
      return originalRun(request);
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: searchWorker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureLibraryDirector(spies),
      assetSemanticRanker: closureRanker(spies),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        ...CLOSURE_ASSET_PROVIDERS,
      ],
    });
    const run = await pipeline.start(closureBrief({ assetSemanticRank: true }));
    assert.equal(
      run.status,
      "needs_human",
      JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))),
    );
    assert.equal(searchCalls, 1);
    assert.equal(spies.rankCalls, 1);

    // 导演换模型：导演方案内容不变（确定性替身），候选获取身份与排序输入身份不变——
    // 候选/排序证据必须保留，不重搜不重排；构思/编剧保留。
    await pipeline.applyNodeExecutionConfiguration(
      run.id,
      "creative-planning",
      { ...closureBrief({ assetSemanticRank: true }), models: { "api-visual-director-v1": "director-model-two" } } as ProductionBrief,
      "producer",
      await currentRunRevision(pipeline, run.id),
    );
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.treatmentTitles.length, 1, "treatment must be preserved");
    assert.equal(spies.screenwriterCalls.length, 1, "the valid script must be preserved");
    assert.equal(spies.directorCalls, 2, "the director re-runs with the changed model identity");
    assert.equal(searchCalls, 1, "candidate evidence must be reused without a new search");
    assert.equal(spies.rankCalls, 1, "ranking evidence must be reused without a new rank call");
    void countSearchCalls;
  });

  for (const boundary of ["audit", "unchanged-producer"] as const) it(`recovers an expired real ranking ${boundary} into the joint planning human gate`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-rank-deadline-graph-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    let modelCalls = 0;
    let observations = 0;
    let searches = 0;
    let candidateOutput: unknown;
    const repair = {
      version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1",
      verdict: "repair", score: 50, summary: "需要补证",
      assessments: [{ targetPath: "", dimensions: ["evidence", "coverage", "consistency", "actionability"].map(dimension => ({ dimension, score: 50, evidence: "证据不足" })) }],
      issues: [{ severity: "blocking", criterion: "可见证据", evidence: "不足", repairInstruction: "补齐证据" }], repairInstructions: ["补齐证据"],
    };
    const worker = new ClosureLibraryWorker();
    const runWorker = worker.run.bind(worker);
    worker.run = async request => {
      assert.notEqual(request.capability, "asset.prepare", "human gate must precede media acquisition");
      if (request.capability === "asset.search") searches++;
      return runWorker(request);
    };
    const director = closureLibraryDirector(spies);
    director.planDetailed = async input => input.creativeReviewExecution?.mode === "check"
      ? passingCreativeReviewExecution(input.creativeReviewExecution.candidate, "视觉导演", "fixture-director-contract-v1", "director-plan", "director-binding-model")
      : { output: await director.plan(input) };
    // 恢复用例显式构造升级前的三轮合同，才能真实进入第二版已受理的窗口。
    const ranker = new CodexAssetSemanticRanker({ maxReviewIterations: 3, fetchThumbnail: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      client: { runTask: async () => { throw new Error("must use audited client"); },
        runTaskDetailed: async (kind, payload, requestId, session, options) => {
          modelCalls++;
          const envelope = { requestId, kind, payload, session };
          await options?.beforeSubmit?.({ version: "video-factory/codex-prepared-operation-v1", requestId: requestId!, kind,
            envelope, serializedEnvelope: JSON.stringify(envelope), binding: {} as never, brokerBinding: {} as never,
            route: { socketPath: "/tmp/unused.sock" }, taskFact: "accepted_unknown" });
          if (modelCalls === (boundary === "audit" ? 2 : 3)) throw new Error("accepted ranking interrupted");
          if (kind === "role-audit") return { output: repair };
          candidateOutput = { ...deterministicAssetRanking(payload as AssetCandidateReport), source: "model" };
          return { output: candidateOutput };
        }, observePrepared: async () => {
          observations++;
          return { output: boundary === "audit" ? repair : candidateOutput };
        },
      },
    });
    const pipeline = new ProductionPipeline({ workspaceRoot, worker,
      treatmentAgents: closureTreatmentAgents(spies), screenwriterAgent: closureScreenwriter(spies),
      directorAgent: director, assetSemanticRanker: ranker,
      assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] }, ...CLOSURE_ASSET_PROVIDERS],
    });
    let first = await pipeline.start(closureBrief({ assetSemanticRank: true, creativeReview: true }));
    for (let i = 0; i < 6 && first.status === "needs_human"; i++) {
      const gate = first.nodeRuns.find(node => node.nodeId === "creative-planning")?.intervention?.continuation;
      assert.ok(gate);
      const stageNode = first.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
      const shown = (stageNode.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })?.creativeReview?.stages?.[gate.stage]?.checkResult;
      first = await pipeline.confirmCreativeReview(first.id, { commandId: `confirm-${i}`, actor: "creator",
        expectedRunRevision: first.revision, expectedReviewRevision: gate.reviewRevision,
        stage: gate.stage, baseDraftSha256: gate.draftSha256,
        ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
        ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}) });
    }
    assert.equal(first.status, "failed");
    t.mock.timers.tick(600_001);
    const recovered = await pipeline.retryFailedNode(first.id, "creative-planning");
    assert.equal(recovered.status, "needs_human", JSON.stringify(recovered.nodeRuns));
    assert.equal(modelCalls, boundary === "audit" ? 2 : 3);
    assert.equal(observations, 1);
    assert.equal(searches, 1);
    assert.equal(spies.treatmentTitles.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1);
    const node = recovered.nodeRuns.find(item => item.nodeId === "creative-planning");
    assert.equal(node?.intervention?.continuation?.stage, "director");
    assert.match(JSON.stringify(node?.output), /视觉核验/);
    const directory = path.join(workspaceRoot, "runs", first.id, "nodes", "creative-planning", "agent-loop-checkpoints");
    const records = await Promise.all((await readdir(directory)).filter(name => name.endsWith(".json")).map(async name => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
    const ranking = records.find(value => value.assetRankBatch?.finished)?.assetRankBatch.finished.output;
    assert.ok(ranking);
    assert.equal(ranking.visualEvidence.stopReason, "deadline");
    assert.equal(ranking.source, "fallback");
    assert.equal(ranking.visualEvidence.reviewed.length, 0);
    const gate = node!.intervention!.continuation!;
    const review = node!.output as { creativeReview: { stages: { director: { currentDocument: Record<string, unknown> } } } };
    const edited = await (await pipeline.dispatchCreativeReviewCommand(first.id, {
      action: "edit_draft", commandId: "save-after-deadline", actor: "creator", stage: "director",
      expectedRunRevision: recovered.revision, expectedReviewRevision: gate.reviewRevision, baseDraftSha256: gate.draftSha256,
      document: { ...review.creativeReview.stages.director.currentDocument, profileRationale: "保留当前画面路线，等待核对素材证据。" },
    })).completion;
    assert.equal(edited.status, "needs_human");
    const editedGate = edited.nodeRuns.find(item => item.nodeId === "creative-planning")!.intervention!.continuation!;
    assert.equal(editedGate.stage, "director");
    assert.notEqual(editedGate.draftSha256, gate.draftSha256);
    const confirmed = await pipeline.confirmCreativeReview(first.id, { commandId: "confirm-after-deadline", actor: "creator", stage: "director",
      expectedRunRevision: edited.revision, expectedReviewRevision: editedGate.reviewRevision, baseDraftSha256: editedGate.draftSha256,
      acknowledgeUnaudited: true });
    assert.equal(confirmed.status, "needs_human", "changing rationale must not bypass missing visual evidence");
    assert.equal(modelCalls, boundary === "audit" ? 2 : 3, "a rationale-only save must not reset the ranking budget");
    assert.equal(spies.treatmentTitles.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1);
  });

  it("uses the selected ranking model and invalidates only ranking evidence when that selection changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-selected-ranker-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const worker = new ClosureLibraryWorker();
    const runWorker = worker.run.bind(worker);
    let searches = 0;
    worker.run = async (request: Record<string, unknown>) => {
      if (request.capability === "asset.search") searches += 1;
      return runWorker(request);
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot, worker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureLibraryDirector(spies),
      assetSemanticRanker: closureRanker(spies),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        ...CLOSURE_ASSET_PROVIDERS,
      ],
    });
    const brief = closureBrief({ assetSemanticRank: true, models: { "codex-asset-ranker-v1": "selected-ranker-a" } });
    const run = await pipeline.start(brief);
    assert.equal(run.status, "needs_human");
    const firstRanking = run.artifacts.find((artifact) => artifact.kind === "asset_ranking");
    assert.equal(JSON.parse(await readFile(firstRanking!.uri!, "utf8")).modelId, "selected-ranker-a");
    await pipeline.applyNodeExecutionConfiguration(run.id, "creative-planning", {
      ...brief, models: { "codex-asset-ranker-v1": "selected-ranker-b" },
    }, "producer", await currentRunRevision(pipeline, run.id));
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human");
    assert.equal(spies.rankCalls, 2, "a changed explicit model must invalidate the old ranking");
    assert.equal(searches, 1);
    assert.equal(spies.treatmentTitles.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1);
    assert.equal(spies.directorCalls, 1);
    assert.notEqual(spies.rankCheckpoints[0]?.key, spies.rankCheckpoints[1]?.key);
    const activeIds = resumed.nodeRuns.find((node) => node.nodeId === "creative-planning")!.artifactIds;
    const ranking = resumed.artifacts.find((artifact) => artifact.kind === "asset_ranking" && activeIds.includes(artifact.id));
    assert.equal(JSON.parse(await readFile(ranking!.uri!, "utf8")).modelId, "selected-ranker-b");
  });

  it("reranks with the new ranker identity when only the ranker changes, without re-searching", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-ranker-identity-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const searchWorker = new ClosureLibraryWorker();
    const originalRun = searchWorker.run.bind(searchWorker);
    let searchCalls = 0;
    searchWorker.run = async (request: Record<string, unknown>) => {
      if (request.capability === "asset.search") searchCalls += 1;
      return originalRun(request);
    };
    // 首次执行：排序角色在首轮失败，规划停在 rank 阶段（候选搜索已完成并进入 checkpoint）。
    const first = new ProductionPipeline({
      workspaceRoot,
      worker: searchWorker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureLibraryDirector(spies),
      assetSemanticRanker: closureRanker(spies, { failFirstCall: true }),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        ...CLOSURE_ASSET_PROVIDERS,
      ],
    });
    const run = await first.start(closureBrief({ assetSemanticRank: true }));
    assert.equal(run.status, "failed", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(searchCalls, 1);
    assert.equal(spies.rankCalls, 1);
    assert.equal(spies.rankRequests.length, 1);
    // 排序请求携带真实语义意图（与图内证据覆盖同一投影），不是只有内容摘要式 id。
    assert.equal(spies.rankRequests[0]?.planningIntent?.semanticIntentVersion, "video-factory/ranking-semantic-intent-v1");
    assert.ok(spies.rankRequests[0]?.planningIntent?.rankingIntent, "the rank request must carry the current picture semantic intent");

    // 只更换 ranker 模型后重试：同 digest 的已有 thread 不重放旧排序，也不重跑未变阶段；
    // 候选池保留（不重搜），排序由新身份真实执行。
    const resumed = await new ProductionPipeline({
      workspaceRoot,
      worker: searchWorker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureLibraryDirector(spies),
      assetSemanticRanker: closureRanker(spies, { modelId: "ranker-new-model" }),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        ...CLOSURE_ASSET_PROVIDERS,
      ],
    }).retryFailedNode(run.id, "creative-planning");
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(searchCalls, 1, "the candidate pool must be reused without a new search");
    assert.equal(spies.rankCalls, 2, "a changed ranker identity must trigger a real re-rank, not replay the old ranking");
    assert.equal(spies.treatmentTitles.length, 1, "treatment must not re-run across the ranker change");
    assert.equal(spies.screenwriterCalls.length, 1, "the script must not re-run across the ranker change");
    assert.equal(spies.rankRequests[1]?.planningIntent?.semanticIntentVersion, "video-factory/ranking-semantic-intent-v1");
    // 新排序产物必须来自新 ranker 身份，而不是复用旧排序。
    const rankingArtifact = resumed.artifacts.find((artifact) => artifact.kind === "asset_ranking");
    assert.ok(rankingArtifact);
    const rankingContent = JSON.parse(await readFile(rankingArtifact.uri!, "utf8")) as { modelId?: string };
    assert.equal(rankingContent.modelId, "ranker-new-model");
    // durable checkpoint 消费：ranker 身份进入排序角色的 checkpoint 投影（与外层 stage
    // identity 同一来源），fake 必须真实读取它。
    // durable checkpoint 身份随 ranker 身份变化：重排不得复用旧 checkpoint 身份。
    assert.notEqual(
      spies.rankCheckpoints[1]?.key,
      spies.rankCheckpoints[0]?.key,
      "the rank checkpoint identity must change with the ranker identity",
    );
  });

  it("invalidates a completed ranking cache when only the ranker identity changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-ranker-cache-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const searchWorker = new ClosureLibraryWorker();
    const originalRun = searchWorker.run.bind(searchWorker);
    let searchCalls = 0;
    searchWorker.run = async (request: Record<string, unknown>) => {
      if (request.capability === "asset.search") searchCalls += 1;
      return originalRun(request);
    };
    // 第一轮：ranker A 完成排序并进入终态 checkpoint，随后在正式登记前失败（afterGraph）。
    const crashed = new ProductionPipeline({
      workspaceRoot,
      worker: searchWorker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureLibraryDirector(spies),
      assetSemanticRanker: closureRanker(spies),
      planningFailpoints: { afterGraph: () => { throw new Error("simulated crash after the planning graph completed"); } },
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        ...CLOSURE_ASSET_PROVIDERS,
      ],
    });
    const run = await crashed.start(closureBrief({ assetSemanticRank: true }));
    assert.equal(run.status, "failed", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.rankCalls, 1, "the completed ranking must already live in the graph checkpoint");
    assert.equal(searchCalls, 1);

    // 同 digest 恢复 + 只换 ranker：不得重放 completed graph 的旧排序——必须失效缓存并
    // 用新身份真实重排；候选保留（不重搜），未变角色不重跑。
    const resumed = await new ProductionPipeline({
      workspaceRoot,
      worker: searchWorker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureLibraryDirector(spies),
      assetSemanticRanker: closureRanker(spies, { modelId: "ranker-new-model" }),
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        ...CLOSURE_ASSET_PROVIDERS,
      ],
    }).retryFailedNode(run.id, "creative-planning");
    assert.equal(resumed.status, "needs_human", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(searchCalls, 1, "the candidate pool must be reused without a new search");
    assert.equal(spies.rankCalls, 2, "a changed ranker identity must invalidate the completed ranking cache and re-rank");
    assert.equal(spies.treatmentTitles.length, 1, "treatment must not re-run across the cache invalidation");
    assert.equal(spies.screenwriterCalls.length, 1, "the script must not re-run across the cache invalidation");
    assert.equal(spies.directorCalls, 1, "the director must not re-run across the cache invalidation");
    assert.notEqual(
      spies.rankCheckpoints[1]?.key,
      spies.rankCheckpoints[0]?.key,
      "the re-rank must run under a new checkpoint identity derived from the new ranker",
    );
    const rankingArtifact = resumed.artifacts.find((artifact) => artifact.kind === "asset_ranking");
    assert.ok(rankingArtifact);
    const rankingContent = JSON.parse(await readFile(rankingArtifact.uri!, "utf8")) as { modelId?: string };
    assert.equal(rankingContent.modelId, "ranker-new-model");
  });

  it("keeps provider and model identities separate in formal planning provenance", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-provenance-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const pipeline = newClosurePipeline(workspaceRoot, spies, { failFirstCandidate: true });
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    // fallback 后实际执行的是候选 B：providerId = deepseek，modelId = treatment-model-b。
    assert.deepEqual(spies.treatmentModelCalls, ["treatment-model-a", "treatment-model-b"]);
    const treatmentArtifact = run.artifacts.find((artifact) => artifact.kind === "creative_treatment");
    assert.ok(treatmentArtifact, "the run must register the formal treatment artifact");
    assert.equal(
      treatmentArtifact.provenance?.providerId,
      "deepseek",
      "formal treatment provenance must record the actual executing provider, not a model string",
    );
    assert.notEqual(treatmentArtifact.provenance?.providerId, "treatment-model-b");
    const planningReceipt = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.executionReceipt;
    assert.equal(planningReceipt?.modelId, "treatment-model-b", "the receipt must report the actual model after fallback");

    // 正常（无 fallback）路径：providerId = openai，modelId = treatment-model-a。
    const normalSpies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const normalRun = await newClosurePipeline(await mkdtemp(path.join(tmpdir(), "vf-fix-provenance-ok-")), normalSpies).start(closureBrief());
    const normalTreatment = normalRun.artifacts.find((artifact) => artifact.kind === "creative_treatment");
    assert.ok(normalTreatment);
    assert.equal(normalTreatment.provenance?.providerId, "openai");
    assert.notEqual(normalTreatment.provenance?.providerId, "treatment-model-a");
  });

  it("sends the accepted series promise into the treatment role request", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-treatment-promise-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const capturedPromises: Array<string | undefined> = [];
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: [{
        providerId: "openai",
        agent: {
          id: TREATMENT_PROVIDER_ID,
          modelId: "treatment-model-a",
          treat: async (input: { brief: { title: string; lockedViewerPromise?: string } }) => legalTreatment(input.brief.title),
          treatDetailed: async (input: { brief: { title: string; lockedViewerPromise?: string } }) => {
            spies.treatmentModelCalls.push("treatment-model-a");
            spies.treatmentTitles.push(input.brief.title);
            spies.treatmentCheckpointPresent.push(true);
            capturedPromises.push(input.brief.lockedViewerPromise);
            return {
              output: legalTreatment(input.brief.title),
              trace: {
                taskKind: "creative-treatment" as const,
                promptVersion: "v1",
                prompt: "fixture prompt",
                providerId: "openai",
                modelId: "treatment-model-a",
              },
            };
          },
        },
      }],
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await pipeline.start({
      ...closureBrief(),
      seriesContext: {
        seriesId: "series-1",
        episodeId: "episode-1",
        seriesName: "下班实验室",
        seriesRevision: 1,
        episodeNumber: 1,
        seasonNumber: 1,
        canonBaseRevision: 0,
        premise: "每集完成一个可复现的真实实验。",
        audience: "普通上班族",
        platform: "douyin",
        track: "after-work-lab",
        arc: "从一次实验走到可持续流程",
        episode: {
          updatedAt: "2026-08-30T00:00:00.000Z",
          pillar: "真实实验",
          title: "第一集",
          viewerPromise: "完成一次低成本验证",
          hook: "先展示最容易失败的一步",
          payoff: "给出可复现的结论",
          planning: {
            source: "agent",
            role: "系列开拍总编",
            auditRole: "独立质量审计 Agent",
            auditStatus: "passed",
            auditIterations: 2,
            providerId: "openai",
            modelId: "codex",
            promptVersion: "video-factory/series-greenlight-v1",
          },
        },
        bible: { rules: ["结论必须来自本集实际内容"], recurringElements: [], forbiddenChanges: [] },
        canon: { revision: 0, facts: [] },
        continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: [], canonChecks: [] },
      },
    } as ProductionBrief);
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    // 系列承诺进入构思角色的真实输入（宿主锁定，由 codex 构思角色合同覆盖模型输出），
    // 不是只进入 checkpoint 或身份摘要。
    assert.deepEqual(
      capturedPromises,
      ["完成一次低成本验证"],
      "the accepted series promise must reach the treatment role request as lockedViewerPromise",
    );
    // 无系列上下文的对照组：不构造承诺，构思角色自行生成。
    const plainSpies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const plainCaptured: Array<string | undefined> = [];
    const plainRun = await new ProductionPipeline({
      workspaceRoot: await mkdtemp(path.join(tmpdir(), "vf-fix-treatment-promise-plain-")),
      worker: new ClosureWorker(),
      treatmentAgents: [{
        providerId: "openai",
        agent: {
          id: TREATMENT_PROVIDER_ID,
          modelId: "treatment-model-a",
          treat: async (input: { brief: { title: string; lockedViewerPromise?: string } }) => legalTreatment(input.brief.title),
          treatDetailed: async (input: { brief: { title: string; lockedViewerPromise?: string } }) => {
            plainSpies.treatmentModelCalls.push("treatment-model-a");
            plainSpies.treatmentTitles.push(input.brief.title);
            plainCaptured.push(input.brief.lockedViewerPromise);
            return {
              output: legalTreatment(input.brief.title),
              trace: {
                taskKind: "creative-treatment" as const,
                promptVersion: "v1",
                prompt: "fixture prompt",
                providerId: "openai",
                modelId: "treatment-model-a",
              },
            };
          },
        },
      }],
      screenwriterAgent: closureScreenwriter(plainSpies),
      directorAgent: closureDirector(plainSpies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    }).start(closureBrief());
    assert.equal(plainRun.status, "needs_human");
    assert.deepEqual(plainCaptured, [undefined], "no series promise must not fabricate a locked promise");
  });

  it("fails closed at the quote boundary when executable plan references do not resolve", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-plan-closure-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const workerCalls: string[] = [];
    const countingWorker = new ClosureWorker();
    const originalWorkerRun = countingWorker.run.bind(countingWorker);
    countingWorker.run = async (request: Record<string, unknown>) => {
      workerCalls.push(String(request.capability));
      return originalWorkerRun(request);
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: countingWorker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await pipeline.start(closureBrief());
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const treatmentCallsBefore = spies.treatmentTitles.length;
    const assetPrepareCallsBefore = workerCalls.filter((capability) => capability === "asset.prepare").length;

    // 篡改可执行方案的内部引用（scriptArtifactId 指向不存在的产物），并同步更新 run.json 里
    // 的 artifact 完整性记录——绕过文件 sha 校验，直接命中引用闭包检查层。
    const runJsonPath = path.join(workspaceRoot, "runs", run.id, "run.json");
    const payload = JSON.parse(await readFile(runJsonPath, "utf8")) as {
      artifacts: Array<{ id: string; kind: string; uri?: string; sha256: string; sizeBytes: number }>;
    };
    const planArtifact = payload.artifacts.find((artifact) => artifact.kind === "executable_plan");
    assert.ok(planArtifact?.uri, "the run must register the executable plan artifact");
    const plan = JSON.parse(await readFile(planArtifact.uri, "utf8")) as { scriptArtifactId: string };
    plan.scriptArtifactId = "script:tampered-reference-does-not-exist";
    const tamperedContent = `${JSON.stringify(plan, null, 2)}\n`;
    await writeFile(planArtifact.uri, tamperedContent);
    planArtifact.sha256 = createHash("sha256").update(tamperedContent).digest("hex");
    planArtifact.sizeBytes = Buffer.byteLength(tamperedContent);
    await writeFile(runJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

    // 让素材节点失效并恢复：规划不重跑，素材在报价边界消费被篡改的方案——必须 fail closed，
    // 不进入任何 worker 调用（不产生媒体 create/付费副作用）。
    await pipeline.applyNodeInputOverride(run.id, {
      nodeId: "assets",
      actor: "producer",
      ...await jointPlanningEditTokens(pipeline, run.id, "assets"),
      input: await currentAssetsInput(pipeline, run.id),
    });
    const resumed = await pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "failed", JSON.stringify(resumed.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const assetsError = resumed.nodeRuns.find((node) => node.nodeId === "assets")?.error ?? "";
    assert.match(assetsError, /does not resolve in this run|reference closure is stale/i);
    assert.equal(
      spies.treatmentTitles.length,
      treatmentCallsBefore,
      "the broken reference closure must not re-run planning roles",
    );
    assert.equal(
      workerCalls.filter((capability) => capability === "asset.prepare").length,
      assetPrepareCallsBefore,
      "the quote boundary must fail closed before any new worker execution",
    );
  });

  it("revises narration without evicting the script its commit-registered executable plan references", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-narration-revision-joint-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const workerCalls: string[] = [];
    const countingWorker = new ClosureWorker();
    const originalWorkerRun = countingWorker.run.bind(countingWorker);
    countingWorker.run = async (request: Record<string, unknown>) => {
      workerCalls.push(String(request.capability));
      return originalWorkerRun(request);
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: countingWorker,
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const waiting = await pipeline.start(closureBrief());
    assert.equal(waiting.status, "needs_human", JSON.stringify(waiting.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    const planningBefore = waiting.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    const planningVersionBefore = planningBefore.outputState!.versions.find(
      (version) => version.id === planningBefore.outputState!.effectiveVersionId,
    )!;
    const outputBefore = planningVersionBefore.output as Record<string, unknown>;
    const scriptArtifactBefore = waiting.artifacts.find((artifact) => (
      planningVersionBefore.artifactIds.includes(artifact.id)
      && artifact.kind === "script"
      && artifact.uri === outputBefore.scriptPath
    ));
    assert.ok(scriptArtifactBefore, "the joint route must register its current script artifact");
    const planPathBefore = String(outputBefore.executablePlanPath);
    const planBefore = JSON.parse(await readFile(planPathBefore, "utf8")) as { cuts: unknown[]; totalFrames: number };
    const planArtifactBefore = waiting.artifacts.find((artifact) => (
      planningVersionBefore.artifactIds.includes(artifact.id)
      && artifact.kind === "executable_plan"
      && artifact.uri === planPathBefore
    ));
    assert.ok(planArtifactBefore, "the joint route must register its current executable plan artifact");
    // 原稿的磁盘字节：方案已经引用、规划 commit 已经登记的证据，人工改字不得改写它。
    const originalScriptBytes = await readFile(scriptArtifactBefore.uri!);
    const versionIdsBefore = [...planningVersionBefore.artifactIds];
    // 画面是这条路径里唯一不该动的东西。
    const mediaBefore = waiting.artifacts.filter((artifact) => artifact.kind === "media_asset").map((artifact) => artifact.id);
    const assetPrepareBefore = workerCalls.filter((capability) => capability === "asset.prepare").length;
    const callsBeforeRevision = workerCalls.length;

    const revised = await pipeline.requestNarrationRevision(waiting.id, {
      expectedRunRevision: waiting.revision,
      scenePosition: 2,
      narration: "改过的第二段旁白",
      actor: "director",
      note: "第二段口播改得更直白。",
    });

    assert.equal(
      revised.status,
      "needs_human",
      JSON.stringify(revised.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))),
    );

    // joint 的可执行方案按 artifact id 引用脚本，且引用集受"必须同属规划节点当前接受版本"
    // 与"同属一次规划 commit"两道约束；方案本身又是那次 commit 已登记的证据快照。所以人工
    // 改字既不能把原稿踢出当前版本（方案会引用一份不在版本内的脚本 → 消费方案时 fail closed，
    // 这正是生产里复现的失败），也不能重绑方案（commit 文件里记的是原稿 id，重绑会让方案不再
    // 指向 commit 登记的那一份）。正确形态是：方案与其证据原封不动，改出来的新稿另立一件。
    const planningAfter = revised.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    const planningVersionAfter = planningAfter.outputState!.versions.find(
      (version) => version.id === planningAfter.outputState!.effectiveVersionId,
    )!;
    const currentArtifacts = revised.artifacts.filter((artifact) => planningVersionAfter.artifactIds.includes(artifact.id));
    const plansAfter = currentArtifacts.filter((artifact) => artifact.kind === "executable_plan");
    assert.equal(plansAfter.length, 1, "the accepted planning version must still hold exactly one executable plan");
    assert.equal(plansAfter[0]!.id, planArtifactBefore.id, "the plan is commit-registered evidence and must not be replaced");
    assert.equal(plansAfter[0]!.uri, planPathBefore);
    // 版本成员只增不减：既有证据（含原稿）全部留在当前接受版本里。
    const versionIdsAfter = new Set(planningVersionAfter.artifactIds);
    for (const artifactId of versionIdsBefore) {
      assert.ok(versionIdsAfter.has(artifactId), `narration revision dropped version member '${artifactId}'`);
    }
    assert.equal(
      planningVersionAfter.artifactIds.length,
      versionIdsBefore.length + 2,
      "the revision must add exactly the revised script and the revision request",
    );
    const originalScriptAfter = currentArtifacts.find((artifact) => artifact.id === scriptArtifactBefore.id);
    assert.ok(originalScriptAfter, "the revised script must not evict the script the plan references");
    assert.deepEqual(await readFile(originalScriptAfter.uri!), originalScriptBytes);

    // 方案仍然引用原稿，且时长/镜头一个字段都没动——所以既不重编译也不重买画面。
    const planAfter = JSON.parse(await readFile(plansAfter[0]!.uri!, "utf8")) as { scriptArtifactId: string; cuts: unknown[]; totalFrames: number };
    assert.equal(planAfter.scriptArtifactId, scriptArtifactBefore.id);
    assert.deepEqual(planAfter.cuts, planBefore.cuts);
    assert.equal(planAfter.totalFrames, planBefore.totalFrames);

    // 下游读的是当前接受版本的 scriptPath：新文字必须落在那里，而不是只躺在版本成员里。
    const revisedScriptAfter = currentArtifacts.find((artifact) => (
      artifact.kind === "script"
      && artifact.uri === (planningVersionAfter.output as Record<string, unknown>).scriptPath
      && artifact.id !== scriptArtifactBefore.id
    ));
    assert.ok(revisedScriptAfter, "the revised script must be the one the accepted version points at");
    assert.ok((revisedScriptAfter.parentArtifactIds ?? []).includes(scriptArtifactBefore.id));
    assert.equal(revisedScriptAfter.provenance?.providerId, "human-narration-revision-v1");
    const revisedScript = JSON.parse(await readFile(revisedScriptAfter.uri!, "utf8")) as { scenes: Array<{ narration: string }> };
    assert.equal(revisedScript.scenes[1]?.narration, "改过的第二段旁白");
    assert.equal(revisedScript.scenes[0]?.narration, "第1段旁白内容");

    // 只有读这一行字的下游重跑；画面既没有重新准备，也没有换过任何一份媒体产物。
    assert.deepEqual(
      workerCalls.slice(callsBeforeRevision),
      ["voice.synthesize", "video.render", "quality.review"],
    );
    assert.equal(workerCalls.filter((capability) => capability === "asset.prepare").length, assetPrepareBefore);
    assert.deepEqual(
      revised.artifacts.filter((artifact) => artifact.kind === "media_asset").map((artifact) => artifact.id),
      mediaBefore,
    );
  });
});

// 读取 assets 节点当前生效输入（用于制造一次“只失效素材、不重跑规划”的编辑）。
async function currentAssetsInput(pipeline: ProductionPipeline, runId: string): Promise<unknown> {
  const run = await pipeline.loadPersisted(runId);
  const assets = run.nodeRuns.find((node) => node.nodeId === "assets");
  const version = assets?.inputState?.versions.find((candidate) => candidate.id === assets.inputState?.effectiveVersionId);
  assert.ok(version, "the assets node must expose its effective input version");
  return version.value;
}

describe("planning failure creator copy (B4-FIX)", () => {
  it("maps internal halt reasons to creator-facing text without leaking internals", async () => {
    const { planningFailureForCreators } = await import("../src/index.js");
    const needsUser = planningFailureForCreators(
      "Joint creative planning stopped (needs_user): 存在只有用户能解决的问题，停止自动重试，等待用户决定。 不回退旧规划流程。",
    );
    assert.match(needsUser, /^有需要你决定的问题，规划暂停：存在只有用户能解决的问题/);
    assert.equal(needsUser.includes("Joint creative planning"), false);
    assert.equal(needsUser.includes("needs_user"), false);
    assert.equal(needsUser.includes("不回退旧规划流程"), false);

    const exhausted = planningFailureForCreators(
      "Joint creative planning stopped (cross_role_revisions_exhausted): 跨角色回退已达上限 2 次，停止自动重试。 不回退旧规划流程。",
    );
    assert.match(exhausted, /^多次调整仍未通过质量复核，已停止自动重试：跨角色回退已达上限/);
    assert.equal(exhausted.includes("cross_role_revisions_exhausted"), false);

    const provider = planningFailureForCreators("treatment model a connection failed (ECONNREFUSED)");
    assert.match(provider, /treatment model a connection failed/);
    assert.equal(provider.includes("Joint creative planning"), false);

    // 曾在界面上原样上屏的那句必须换成中文说明。
    const leaked = planningFailureForCreators("Creative review 'treatment' check completed without a passing audit.");
    assert.equal(leaked.includes("Creative review"), false);
    assert.equal(leaked.includes("passing audit"), false);
    assert.match(leaked, /^这一步没有完成/);

    // 复核跑完但没有独立裁决，说的是"这一腿没产出结果"，不是"作品没通过"。措辞换成
    // "independent audit" 之后必须仍然被认出来，且映射文案里不能出现评判作品的说法——
    // 一旦这里退化成"未通过"，人就会把执行故障读成自己的方案被否掉。
    const missingAudit = planningFailureForCreators(
      "Creative review 'director' check completed without an independent audit.",
    );
    assert.equal(missingAudit.includes("Creative review"), false);
    assert.equal(missingAudit.includes("independent audit"), false);
    assert.equal(missingAudit.includes("未通过"), false);
    assert.match(missingAudit, /^这一步没有完成/);

    // 兜底是"按句登记"，不是"看着像英文就替换"：未登记的英文诊断是这条腿唯一的下线信息，
    // 整句换成通用说明等于把它藏起来。上面的 provider 一条就是这个契约的守门人。
    const unregistered = planningFailureForCreators("simulated publication failure after the planning graph completed");
    assert.match(unregistered, /simulated publication failure/);
    // 但也不能让它裸着上屏——创作者看到屏幕上孤零零一句英文，只会以为界面坏了或者自己看不懂。
    // 补一句中文说明这是什么，原文一字不动地跟在后面：既不藏信息，也不把机器的话冒充成界面的话。
    assert.match(unregistered, /^这一步没有完成。/);
    assert.match(unregistered, /机器给出的原文：simulated publication failure/);
  });

  it("keeps a creator-facing Chinese failure reason as written", async () => {
    const { planningFailureForCreators } = await import("../src/index.js");
    assert.equal(
      planningFailureForCreators("导演经过 3 轮修改后仍未通过独立审计。画面承诺无法兑现。"),
      "导演经过 3 轮修改后仍未通过独立审计。画面承诺无法兑现。",
    );
  });
});

describe("same-digest replay fails closed when stage inputs drift (B-FIX)", () => {
  it("keeps valid human-reviewed drafts across runtime catalog changes without recreating or reauditing them", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-human-gate-runtime-change-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    let pipeline = newClosurePipeline(workspaceRoot, spies);
    let run = await pipeline.start(closureBrief({ creativeReview: true }));
    for (const stage of ["treatment", "script", "director"] as const) {
      const node = run.nodeRuns.find(candidate => candidate.nodeId === "creative-planning")!;
      const gate = node.intervention!.continuation!;
      const review = (node.output as { creativeReview: CreativeReviewState }).creativeReview;
      assert.equal(gate.stage, stage);
      const draft = structuredClone(review.stages[stage].currentDraft);
      // 默认运行模型/目录说明可以随部署更新，但用户 brief 与当前稿件没有变化。
      const treatmentAgents = closureTreatmentAgents(spies);
      const screenwriter = closureScreenwriter(spies);
      const director = closureDirector(spies);
      for (const [index, binding] of treatmentAgents.entries()) binding.agent.modelId = `runtime-${stage}-treatment-${index}`;
      screenwriter.modelId = `runtime-${stage}-script`;
      director.modelId = `runtime-${stage}-director`;
      const runtimeOptions: ProductionPipelineOptions = { workspaceRoot, worker: new ClosureWorker(), treatmentAgents,
        screenwriterAgent: screenwriter, directorAgent: director,
        assetProviders: CLOSURE_ASSET_PROVIDERS.map(provider => ({ ...provider, label: `${provider.label} 更新说明 ${stage}` })) };
      pipeline = new ProductionPipeline(runtimeOptions);
      const command = { commandId: `after-deploy-${stage}`, actor: "creator", stage,
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision, baseDraftSha256: gate.draftSha256,
        expectedCheckIdentity: review.stages[stage].checkResult!.checkIdentity };
      if (stage === "director") {
        const incompatible = new ProductionPipeline({ ...runtimeOptions,
          assetProviders: runtimeOptions.assetProviders!.map(provider => ({ ...provider, deliveryTypes: ["stock_image"] })) });
        const preserved = await pipeline.loadPersisted(run.id);
        // D05：不可执行的当前方案在确认边界拒绝，工作台仍在；不是制造 failed 再补救。
        await assert.rejects(incompatible.confirmCreativeReview(run.id, command), /cannot deliver/);
        assert.deepEqual(await pipeline.loadPersisted(run.id), preserved);
        assert.equal(preserved.nodeRuns.find(node => node.nodeId === "creative-planning")?.status, "needs_human");
        // 恢复能力后显式确认原稿，不换任务/命令，也不重跑或补审已有文字阶段。
        run = await pipeline.confirmCreativeReview(run.id, command);
      } else {
        run = await pipeline.confirmCreativeReview(run.id, command);
      }
      const after = run.nodeRuns.find(candidate => candidate.nodeId === "creative-planning")!;
      assert.notEqual(after.status, "failed", after.error);
      const nextOutput = after.output as { creativeReview?: CreativeReviewState; creativeReviewHistory?: CreativeReviewState };
      const nextReview = nextOutput.creativeReview ?? nextOutput.creativeReviewHistory!;
      assert.deepEqual(nextReview.stages[stage].currentDraft, draft, "运行环境更新不得改写原稿身份");
      assert.equal(nextReview.stages[stage].phase, "confirmed");
    }
    assert.equal(spies.treatmentTitles.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1);
    assert.equal(spies.directorCalls, 1);
    assert.equal(spies.treatmentAuditCalls, 1);
    assert.equal(spies.screenwriterAuditCalls, 1);
    assert.equal(spies.directorAuditCalls, 1);
  });

  it("rejects retrying a failed plan thread whose director inputs were built against a different catalog", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-fix-thread-drift-"));
    const spies: ClosureSpies = { treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [] };
    const first = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: flakyDirector(spies, { failFirstCall: true }),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const run = await first.start(closureBrief());
    assert.equal(run.status, "failed", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(spies.directorCalls, 1);

    // 同 digest 重试（planning 失败后 retryFailedNode），但素材目录条目已变：旧 thread 的
    // 导演方案基于不同真实输入构建，必须 fail closed，不得静默重放或继续。
    const restarted = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: closureScreenwriter(spies),
      directorAgent: closureDirector(spies),
      assetProviders: [
        {
          id: "local-editorial-v1",
          label: "本地编辑卡片",
          billing: "free",
          modes: ["本地"],
          deliveryTypes: ["editorial_card"],
          constraints: ["重启后目录约束变化"],
        },
      ] as VisualAssetProviderCapability[],
    });
    const retried = await restarted.retryFailedNode(run.id, "creative-planning");
    assert.equal(retried.status, "failed", JSON.stringify(retried.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const planningError = retried.nodeRuns.find((node) => node.nodeId === "creative-planning")?.error ?? "";
    assert.match(planningError, /cannot resume this thread/i);
    assert.equal(spies.directorCalls, 1, "the drifted thread must not silently replay or re-run planning");
  });
});

describe("joint planning physical execution summary (Revision 9)", () => {
  it("aggregates every role checkpoint by physical request identity without double-counting repairs or unknown work", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-planning-summary-"));
    const runId = "run-summary-fixture";
    const operationRequestId = "creative-planning-operation-1";
    const directory = path.join(workspaceRoot, "runs", runId, "nodes", "creative-planning", "agent-loop-checkpoints");
    await mkdir(directory, { recursive: true });

    const requestId = (
      key: string,
      contractDigest: string,
      cycle: number,
      iteration: number,
      phase: "produce" | "audit",
      generation: number,
    ) => `agent-${createHash("sha256").update(JSON.stringify({
      scope: key,
      contractDigest,
      cycle,
      iteration,
      phase,
      generation,
    })).digest("hex")}`;
    const checkpoint = (
      name: string,
      produceGeneration: number,
      auditGeneration: number,
      structuredRepairModelCallCount: number,
      durations: { produce: number; audit: number; validation: number },
      retriedRequestIds: string[],
      ownerOperationRequestId = operationRequestId,
    ) => {
      const key = `scope-${name}`;
      const contractDigest = createHash("sha256").update(`contract-${name}`).digest("hex");
      const cycle = 1;
      const attemptedRequestIds = [
        ...Array.from({ length: produceGeneration + 1 }, (_, generation) => requestId(key, contractDigest, cycle, 1, "produce", generation)),
        ...Array.from({ length: auditGeneration + 1 }, (_, generation) => requestId(key, contractDigest, cycle, 1, "audit", generation)),
      ];
      return {
        version: "video-factory/agent-loop-checkpoint-v9",
        key,
        contractDigest,
        cycle,
        maxIterations: 3,
        recoveryOwner: { runId, nodeId: "creative-planning", workflowOperationRequestId: ownerOperationRequestId },
        operationGenerations: { "1:1:produce": produceGeneration, "1:1:audit": auditGeneration } as Record<string, number>,
        attemptedRequestIds,
        requestOwners: Object.fromEntries(attemptedRequestIds.map((requestId) => [requestId, ownerOperationRequestId])),
        phaseAttempts: { produce: produceGeneration + 1, audit: auditGeneration + 1 },
        unacceptedPhaseAttempts: { produce: 0, audit: 0 },
        structuredRepairModelCallCount,
        phaseDurationsMs: { produce: durations.produce, audit: durations.audit },
        validationMs: durations.validation,
        retriedRequestIds,
      };
    };

    // 去身份化等价于已复现的三角色 4 + 5 + 5 次物理调用，结构修复分别为 0 + 1 + 2。
    const fixtures = [
      checkpoint("treatment", 1, 1, 0, { produce: 4_000, audit: 5_000, validation: 10 }, []),
      checkpoint("script", 2, 1, 1, { produce: 6_000, audit: 7_000, validation: 20 }, []),
      checkpoint("director", 0, 3, 2, { produce: 8_000, audit: 9_000, validation: 30 }, []),
    ];
    fixtures[0]!.retriedRequestIds = [fixtures[0]!.attemptedRequestIds[1]!];
    fixtures[1]!.retriedRequestIds = [fixtures[1]!.attemptedRequestIds[2]!];
    await Promise.all(fixtures.map((value, index) => writeFile(
      path.join(directory, `role-${index + 1}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    )));

    // 已受理但执行事实未知的请求必须单列，不能硬记为 0 或 1 次已证实执行。
    const unknown = checkpoint("unknown", 0, -1, 0, { produce: 1_000, audit: 0, validation: 0 }, []);
    const unknownRequestId = unknown.attemptedRequestIds[0]!;
    (unknown as Record<string, unknown>).pendingOperation = {
      phase: "produce",
      operation: { requestId: unknownRequestId, taskFact: "accepted_unknown" },
    };
    await writeFile(path.join(directory, "unknown.json"), `${JSON.stringify(unknown, null, 2)}\n`);
    const previousCheckpoint = checkpoint(
      "previous",
      0,
      0,
      1,
      { produce: 2_000, audit: 3_000, validation: 40 },
      [],
      "creative-planning-operation-previous",
    );
    // 正常首次调用不会产生 generation override；汇总仍须从 attempted request 识别 generation=0。
    previousCheckpoint.operationGenerations = {};
    previousCheckpoint.retriedRequestIds = [previousCheckpoint.attemptedRequestIds[0]!];
    await writeFile(path.join(directory, "previous.json"), `${JSON.stringify(previousCheckpoint, null, 2)}\n`);

    const discussionDirectory = path.join(workspaceRoot, "runs", runId, "nodes", "creative-planning", "discussion-executions");
    await mkdir(discussionDirectory, { recursive: true });
    const discussionReceipt = (
      name: string,
      requestId: string,
      state: "completed" | "completed_failure" | "accepted_unknown" | "not_accepted",
      ownerOperationRequestId = operationRequestId,
      providerWaitMs?: number,
    ) => writeFile(path.join(discussionDirectory, `${name}.json`), `${JSON.stringify({
      version: "video-factory/creative-discussion-execution-v1",
      workflowOperationRequestId: ownerOperationRequestId,
      commandId: `command-${name}`,
      requestId,
      stage: "treatment",
      state,
      ...(providerWaitMs === undefined ? {} : { providerWaitMs }),
    }, null, 2)}\n`);
    await Promise.all([
      discussionReceipt("explain", "discussion-explain", "completed", operationRequestId, 1_500),
      discussionReceipt("revise-failed", "discussion-revise", "completed_failure", operationRequestId, 2_500),
      discussionReceipt("unknown", "discussion-unknown", "accepted_unknown", operationRequestId, 9_999),
      discussionReceipt("not-accepted", "discussion-not-accepted", "not_accepted", operationRequestId, 8_888),
      discussionReceipt("explain-duplicate", "discussion-explain", "completed", operationRequestId, 1_500),
      discussionReceipt("previous", "discussion-previous", "completed", "creative-planning-operation-previous", 700),
    ]);

    assert.deepEqual(
      await summarizeJointPlanningExecution(path.join(workspaceRoot, "runs"), runId, operationRequestId),
      {
        modelCallCount: 16,
        producerModelCallCount: 6,
        auditModelCallCount: 8,
        discussionModelCallCount: 2,
        structuredRepairModelCallCount: 3,
        retryCount: 2,
        unknownModelExecutionCount: 2,
        producerMs: 19_000,
        auditMs: 21_000,
        discussionMs: 4_000,
        loopValidationMs: 60,
        previousModelCallCount: 3,
        previousProducerModelCallCount: 1,
        previousAuditModelCallCount: 1,
        previousDiscussionModelCallCount: 1,
        previousStructuredRepairModelCallCount: 1,
        previousRetryCount: 1,
        previousUnknownModelExecutionCount: 0,
        previousProducerMs: 2_000,
        previousAuditMs: 3_000,
        previousDiscussionMs: 700,
        previousLoopValidationMs: 40,
      },
    );
    assert.deepEqual(
      await summarizeJointPlanningExecution(path.join(workspaceRoot, "runs"), runId, operationRequestId),
      await summarizeJointPlanningExecution(path.join(workspaceRoot, "runs"), runId, operationRequestId),
      "reading or polling the same execution evidence must not change any call or timing count",
    );
    const noModelOperation = await summarizeJointPlanningExecution(path.join(workspaceRoot, "runs"), runId, "other-operation");
    assert.equal(noModelOperation?.modelCallCount, 0, "adopt/undo must not claim new model calls");
    assert.equal(noModelOperation?.previousModelCallCount, 19, "adopt/undo must preserve prior run totals");
    await writeFile(path.join(directory, "duplicate.json"), JSON.stringify(fixtures[0]));
    const duplicate = await summarizeJointPlanningExecution(path.join(workspaceRoot, "runs"), runId, operationRequestId);
    assert.equal(duplicate?.producerMs, 19_000, "the same checkpoint evidence must not double time");
    assert.equal(duplicate?.auditMs, 21_000);
    assert.equal(duplicate?.loopValidationMs, 60);

    // 同一个角色 checkpoint 可跨恢复操作包含不同 owner。调用按物理 request 精确归属；
    // 整个 checkpoint 的聚合耗时无法安全拆分时，两边都不能把整段时间据为己有。
    await writeFile(path.join(directory, "duplicate.json"), "{}\n");
    const mixedOwnerCheckpoint = structuredClone(fixtures[0]!);
    mixedOwnerCheckpoint.requestOwners[mixedOwnerCheckpoint.attemptedRequestIds[0]!] = "creative-planning-operation-previous";
    await writeFile(path.join(directory, "role-1.json"), `${JSON.stringify(mixedOwnerCheckpoint, null, 2)}\n`);
    const mixed = await summarizeJointPlanningExecution(path.join(workspaceRoot, "runs"), runId, operationRequestId);
    assert.equal(mixed?.modelCallCount, 15);
    assert.equal(mixed?.producerModelCallCount, 5);
    assert.equal(mixed?.previousModelCallCount, 4);
    assert.equal(mixed?.previousProducerModelCallCount, 2);
    assert.equal(mixed?.producerMs, 15_000, "mixed-owner checkpoint duration must not be claimed by the current operation");
    assert.equal(mixed?.previousProducerMs, 2_000, "mixed-owner checkpoint duration must not be claimed by history either");
  });
});

describe("settled audit candidate exhaustion through the production pipeline", () => {
  it("keeps the valid draft at a human gate when every audit candidate is definitively unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-audit-exhaustion-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], treatmentAuditModels: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = newClosurePipeline(workspaceRoot, spies, { auditFailure: (modelId) =>
      new CodexBridgeError("service temporarily unavailable", true,
        modelId === "treatment-model-a" ? "not_accepted" : "completed_failure", 503, "model_provider_transient"),
    });
    const run = await pipeline.start(closureBrief({ creativeReview: true }));
    assert.equal(run.status, "needs_human", "确定结束的审计故障不能剥夺用户采用现稿的机会");
    const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
    const review = (node.output as { creativeReview: CreativeReviewState }).creativeReview;
    assert.equal(review.stages.treatment.checkResult?.status, "incomplete");
    assert.equal(review.stages.treatment.checkResult?.score, undefined);
    assert.equal(review.stages.treatment.auditHistory.length, 1);
    assert.ok(review.stages.treatment.currentDraft);
    assert.equal(spies.treatmentModelCalls.length, 1, "不重新产稿");
    assert.deepEqual(spies.treatmentAuditModels, ["treatment-model-a", "treatment-model-b"]);
    assert.equal(spies.screenwriterCalls.length, 0, "不得自动推进");
    const gate = node.intervention!.continuation!;
    await pipeline.confirmCreativeReview(run.id, {
      commandId: "adopt-with-incomplete-audit", actor: "creator", stage: gate.stage,
      expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
      baseDraftSha256: gate.draftSha256,
      expectedCheckIdentity: review.stages.treatment.checkResult!.checkIdentity, acknowledgeIncomplete: true,
    });
    assert.equal(spies.treatmentAuditCalls, 2, "明确采用不重复审本稿");
    assert.equal(spies.treatmentModelCalls.length, 1);
    assert.equal(spies.screenwriterCalls.length, 1, "只有人确认后才进入下个节点");
  });

  for (const failure of ["uncertain", "conflict", "rejected", "missing-state", "old-operation"] as const) {
    it(`does not convert a mixed candidate failure into an incomplete audit (${failure})`, async () => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-audit-exhaustion-unsafe-"));
      const spies: ClosureSpies = {
        treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [], treatmentAuditModels: [],
        screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
      };
      const pipeline = newClosurePipeline(workspaceRoot, spies, { auditFailure: (modelId) => {
        if (modelId === "treatment-model-a" && failure !== "old-operation") {
          return new CodexBridgeError("service unavailable", true, "not_accepted", 503);
        }
        if (failure === "old-operation") {
          const error = new RoleAgentLoopError("old completed failure", {
            version: "video-factory/agent-loop-v1", role: "构思", contractVersion: "fixture-v1",
            criteria: [], status: "failed", maxIterations: 1, iterations: [],
          }, undefined, new CodexBridgeError("service unavailable", false, "completed_failure", 503, "model_provider_transient"));
          if (modelId === "treatment-model-a") Object.assign(error, { auditOperationId: "old-operation" });
          return error;
        }
        return failure === "missing-state" ? new Error("unknown provider outcome")
          : new CodexBridgeError("provider boundary requires recovery", false, failure);
      } });
      const run = await pipeline.start(closureBrief({ creativeReview: true }));
      // F03（2026-10-02 执行包）：未知受理/身份冲突不再把 run 打成 failed；它们转成
      // 人工停点＋续接诊断。仍不得被误报为「已核清无结论」的 incomplete 审计。
      assert.equal(run.status, "needs_human", "未知受理/身份冲突停在用户面前，保留工作台");
      const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
      const review = (node.output as { creativeReview?: CreativeReviewState } | undefined)?.creativeReview;
      assert.equal(review?.stages.treatment.auditHistory.length ?? 0, 0);
      assert.equal(review?.stages.treatment.checkResult ?? null, null);
      assert.ok(review?.stages.treatment.continuation, "异常事实进入续接诊断");
      assert.equal(spies.treatmentAuditCalls, 2);
      assert.equal(spies.treatmentModelCalls.length, 1);
      assert.equal(spies.screenwriterCalls.length, 0);
    });
  }
});

for (const scopeChange of ["scene structure", "global intent"] as const) {
  it(`the real screenwriter adapter delivers out-of-scope ${scopeChange} to the human gate without repair loops`, async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-real-script-scope-gate-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const previousScript = { viewerPromise: "看完能避开三个决策坑", narrativeArc: "逐步解释", canonFacts: [],
      scenes: [1, 2, 3, 4, 5, 6, 7].map((position) => ({ position, narration: `第${position}步核对。`,
        duration: position <= 4 ? 3 : 4, visual_strategy: "local", visual_prompt: `旧画面 ${position}`, search_terms: ["核对"] })),
    };
    const candidate = scopeChange === "global intent" ? { ...previousScript, viewerPromise: "擅自换成另一种全片承诺" }
      : { ...previousScript, scenes: previousScript.scenes.slice(0, 5).map((scene, i) => ({
      ...scene, duration: i === 4 ? 4 : 5, visual_prompt: `新画面 ${scene.position}`,
    })) };
    const calls: CodexTaskKind[] = [];
    class ScopeClient extends CodexBridgeClient {
      override async runTaskDetailed(kind: CodexTaskKind) {
        calls.push(kind);
        return { output: candidate };
      }
    }
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies), directorAgent: closureDirector(spies),
      screenwriterAgent: new CodexScreenwriterAgent({ client: new ScopeClient({ socketPath: "/unused/controlled-scope.sock" }) }),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    const initial = await pipeline.start({ ...closureBrief({ creativeReview: true }), rework: {
      sourceRunId: "deidentified-source", sourceRunRevision: 1, findings: [], affectedScenePositions: [],
      previousScript, nodeInstructions: { script: "提出更紧凑的候选，但未扩大范围。", visualDirection: "保留旧方案", assets: "保留旧素材" },
    } });
    const firstNode = initial.nodeRuns.find(node => node.nodeId === "creative-planning")!;
    const gate = firstNode.intervention!.continuation!;
    const review = (firstNode.output as { creativeReview: CreativeReviewState }).creativeReview;
    const current = await pipeline.confirmCreativeReview(initial.id, {
      commandId: "scope-confirm-treatment", actor: "creator", expectedRunRevision: initial.revision,
      expectedReviewRevision: gate.reviewRevision, stage: gate.stage, baseDraftSha256: gate.draftSha256,
      expectedCheckIdentity: review.stages.treatment.checkResult!.checkIdentity,
    });
    assert.equal(current.status, "needs_human", JSON.stringify(current.nodeRuns.map(n => ({ id: n.nodeId, error: n.error }))));
    const node = current.nodeRuns.find(n => n.nodeId === "creative-planning")!;
    const output = node.output as { scopeConflict: { stage: string }; creativeReview: CreativeReviewState };
    assert.equal(output.scopeConflict.stage, "script");
    assert.deepEqual(output.creativeReview.stages.script.currentDocument, previousScript);
    assert.deepEqual(output.creativeReview.stages.script.proposals[0]?.document, candidate);
    assert.deepEqual(calls, ["script-draft"], "范围冲突不是结构错误，不能自动重写或审计");
    assert.equal(spies.directorCalls, 0);
    assert.equal(current.nodeRuns.some(n => n.nodeId === "assets" && n.status !== "pending"), false);
  });
}

it("retrieving a late audit completes only its original creative command receipt", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-audit-retrieval-receipt-"));
  const spies: ClosureSpies = {
    treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
    screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
  };
  let pending = false;
  let recoveryBarrier: Promise<void> | undefined;
  let signalRecovery: (() => void) | undefined;
  const pipeline = newClosurePipeline(workspaceRoot, spies, {
    auditFailure: async () => {
      if (recoveryBarrier) { signalRecovery?.(); await recoveryBarrier; }
      return pending ? new RoleAgentLoopError("original audit result is unknown", {
        version: "video-factory/agent-loop-v1", role: "构思", contractVersion: "fixture-v1",
        criteria: [], status: "failed", maxIterations: 1, iterations: [], failure: { stage: "uncertain" },
      }, undefined, new CodexBridgeError("observe the original request", false, "uncertain")) : undefined;
    },
  });
  const initial = await pipeline.start(closureBrief({ creativeReview: true }));
  const nodeOf = (run: WorkflowRun<ProductionBrief>) => run.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
  const reviewOf = (run: WorkflowRun<ProductionBrief>) => (nodeOf(run).output as { creativeReview: CreativeReviewState }).creativeReview;
  const before = reviewOf(initial).stages.treatment;
  const gate = nodeOf(initial).intervention!.continuation!;
  const command = {
    action: "audit_current" as const, commandId: "late-audit", actor: "creator", stage: gate.stage,
    expectedRunRevision: initial.revision, expectedReviewRevision: gate.reviewRevision,
    baseDraftSha256: gate.draftSha256,
  };
  pending = true;
  // F03（2026-10-02 执行包）：unknown 审计停在人面前（needs_human＋unknown 回执＋续接诊断），
  // 而不是 run failed；同一 commandId 的重放走幂等接续，不丢失原命令绑定。
  const unknownStop = await (await pipeline.dispatchCreativeReviewCommand(initial.id, command)).completion;
  assert.equal(unknownStop.status, "needs_human");
  assert.equal(unknownStop.creativeReviewOperations?.at(-1)?.status, "unknown",
    "原请求未核清时回执保持 unknown，不宣称 completed");
  assert.equal(reviewOf(unknownStop).stages.treatment.continuation?.status, "unknown");
  // 查询后发现原任务仍未落定，第二次同命令接续不能丢失原命令绑定。
  const stillUnknown = await (await pipeline.dispatchCreativeReviewCommand(initial.id, command)).completion;
  assert.equal(stillUnknown.status, "needs_human");
  assert.equal(stillUnknown.creativeReviewOperations?.at(-1)?.status, "unknown");
  pending = false;
  let releaseRecovery!: () => void;
  recoveryBarrier = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const enteredRecovery = new Promise<void>((resolve) => { signalRecovery = resolve; });
  const recovering = await pipeline.dispatchCreativeReviewCommand(initial.id, command);
  await enteredRecovery;
  try {
    const inflight = await pipeline.loadPersisted(initial.id);
    assert.ok(["running", "unknown"].includes(String(inflight.creativeReviewOperations?.at(-1)?.status)),
      "恢复中的命令保持可接管状态（running/unknown），不能落成 completed/failed 终态");
  } finally {
    releaseRecovery();
  }
  const recovered = await recovering.completion;
  assert.equal(recovered.status, "needs_human");
  const after = reviewOf(recovered).stages.treatment;
  assert.deepEqual(after.currentDraft, before.currentDraft);
  assert.equal(after.auditHistory.length, before.auditHistory.length + 1);
  assert.equal(recovered.creativeReviewOperations?.at(-1)?.status, "completed",
    "取回并消费原审计后，命令不能继续显示失败");
  assert.equal(spies.treatmentModelCalls.length, 1);
  assert.equal(spies.screenwriterCalls.length, 0);
  const audits = spies.treatmentAuditCalls;
  const replay = await (await pipeline.dispatchCreativeReviewCommand(initial.id, command)).completion;
  assert.equal(replay.revision, recovered.revision);
  assert.deepEqual(reviewOf(replay), reviewOf(recovered));
  assert.equal(spies.treatmentAuditCalls, audits, "原命令重放只读回执，不再审计");
});

// OA-01/E2E-AUDIT-01：审计操作身份必须进入装配层 checkpoint key——
// 同一 commandId 恢复命中同一请求（B06，不重复扣费）；新 commandId 审同一版本
// 拿到新请求（A05：同版可多次审计并留痕）；A→B→A 的版本轮回不得复用旧审计。
describe("planningReviewCheckpointIdentity (OA-01)", () => {
  const baseContext = {
    runId: "run-oa01",
    inputDigest: "digest",
    base: { creativeReview: "user-confirmed-v1" },
    stage: "treatment",
    issues: [],
  } as never as CreativePlanningContext;

  function checkContext(auditOperationId: string, candidateOutput: unknown): CreativePlanningContext {
    return {
      ...baseContext,
      treatment: { artifactId: "t", output: candidateOutput, schemaVersion: "1" } as never,
      creativeReviewExecution: { mode: "check", stage: "treatment", auditOperationId },
    };
  }

  it("separates two new audit_current operations on the same draft", () => {
    const draft = { version: "v" };
    const first = planningReviewCheckpointIdentity(checkContext("cmd-1", draft));
    const second = planningReviewCheckpointIdentity(checkContext("cmd-2", draft));
    assert.notDeepEqual(first, second, "two new operations must not share one checkpoint identity");
  });

  it("keeps one operation stable across recovery replays", () => {
    const draft = { version: "v" };
    const first = planningReviewCheckpointIdentity(checkContext("cmd-1", draft));
    const replay = planningReviewCheckpointIdentity(checkContext("cmd-1", draft));
    assert.deepEqual(first, replay, "the same persisted operation must keep its request identity");
  });

  it("does not reuse the initial-draft audit for a re-created identical version (A→B→A)", () => {
    const initial = planningReviewCheckpointIdentity(checkContext(
      contentSha256({ source: "initial", version: "A" }), { text: "A" },
    ));
    const recreated = planningReviewCheckpointIdentity(checkContext(
      contentSha256({ source: "initial", version: "A2" }), { text: "A" },
    ));
    assert.notDeepEqual(initial, recreated, "identical bytes of a new version need a fresh audit request");
  });

  it("keeps the legacy derivation when no operation id is present", () => {
    const legacy = planningReviewCheckpointIdentity({
      ...baseContext,
      treatment: { artifactId: "t", output: { version: "v" }, schemaVersion: "1" } as never,
      creativeReviewExecution: { mode: "check", stage: "treatment" },
    } as never);
    assert.deepEqual(Object.keys(legacy).sort(), ["candidateSha256", "mode", "stage"],
      "in-flight checkpoints from before OA-01 must keep their key shape");
  });
});

// R9-01 联动回归：O1 主动审计经真实 ProductionPipeline 首绑并登记一次；O3 重放同一异常
// 对象——生产 helper 不改签其 O1 绑定（R8-01 guard）、图层归属核验拒绝零登记、
// 停点保持 needs_human 而非节点 failed。
it("旧操作的异常经新操作重抛：helper 不改签、图层零登记、停点保留（R9-01）", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-r901-replay-"));
  const spies: ClosureSpies = {
    treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
    screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
  };
  const rethrowBox: { value?: RoleAgentLoopError } = {};
  const pipeline = newClosurePipeline(workspaceRoot, spies, {
    get rethrowException() { return rethrowBox.value; },
  } as never);
  const started = await pipeline.start(closureBrief({ creativeReview: true }));
  const gateOf = (r: any) => {
    const node = r.nodeRuns.find((candidate: any) => candidate.nodeId === "creative-planning");
    assert.ok(node?.intervention?.continuation, "创作规划必须停在复核停点上");
    return node!.intervention!.continuation!;
  };
  const stateOf = (r: any) => {
    const node = r.nodeRuns.find((candidate: any) => candidate.nodeId === "creative-planning");
    const treatment = node?.output?.creativeReview?.stages?.treatment;
    return {
      history: treatment?.auditHistory?.length ?? 0,
      checkResult: treatment?.checkResult ?? null,
      operationStatuses: (r.creativeReviewOperations ?? []).map(
        (operation: { commandId: string; status: string }) => `${operation.commandId}:${operation.status}`,
      ),
    };
  };
  const gate1 = gateOf(started);
  assert.equal(spies.treatmentAuditCalls, 1, "initial draft audit ran once");
  const initial = stateOf(started);
  assert.equal(initial.history, 1, "初稿审计恰好登记一次");

  // 旧操作异常：源错误不是 Provider 故障（runCandidates 按既有合同原样上抛，不做候选
  // 切换包装），异常本身携带一份归属与字节核验都可通过的审计意见。
  const staleException = new RoleAgentLoopError("携带旧操作意见的异常", {
    version: "video-factory/agent-loop-v1", role: "构思", contractVersion: "fixture-v1",
    criteria: [], status: "failed", maxIterations: 1,
    iterations: [{
      iteration: 1, candidate: { payoff: "旧操作审过的稿" }, candidateHash: gate1.draftSha256,
      audit: {
        version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1",
        verdict: "pass", score: 95, summary: "旧操作的 pass 意见", issues: [], repairInstructions: [],
        assessments: [{ targetPath: "", dimensions: [
          { dimension: "attention", score: 95, evidence: "旧操作证据" },
          { dimension: "progression", score: 95, evidence: "旧操作证据" },
          { dimension: "payoff", score: 95, evidence: "旧操作证据" },
          { dimension: "expression", score: 95, evidence: "旧操作证据" },
        ] }],
      },
    }],
  }, undefined, new Error("settled non-provider failure"));
  rethrowBox.value = staleException;

  // O1：主动审计——异常在本次调用边界首绑 O1，图层归属/字节核验通过后登记该意见。
  const o1 = await pipeline.dispatchCreativeReviewCommand(started.id, {
    action: "audit_current", commandId: "audit-o1", actor: "creator", stage: gate1.stage,
    expectedRunRevision: started.revision,
    expectedReviewRevision: gate1.reviewRevision, baseDraftSha256: gate1.draftSha256,
  });
  const o1Run: any = await o1.completion;
  assert.equal(spies.treatmentAuditCalls, 2, "O1 恰好发起一次新的审计调用");
  assert.equal(o1Run.status, "needs_human", "O1 登记后停点保留");
  const afterO1 = stateOf(o1Run);
  assert.equal(afterO1.history, initial.history + 1, "O1 登记恰好一次");
  assert.equal(afterO1.checkResult?.summary, "旧操作的 pass 意见");
  assert.equal(afterO1.checkResult?.score, 95);
  assert.deepEqual(afterO1.operationStatuses, ["audit-o1:completed"]);
  // R11-V01 完整状态快照：O1 后深拷贝整个 creativeReview，O3 拒收后逐字段深比较——
  // 条数/摘要/稿件 SHA 之外的审计历史改写、结论字段替换、版本或轮次推进都会被抓住。
  const reviewAfterO1 = structuredClone(
    o1Run.nodeRuns.find((candidate: any) => candidate.nodeId === "creative-planning")?.output?.creativeReview,
  );

  // O3：重放同一异常对象（已绑定 O1）。helper 原样上抛（不改签 R8-01 guard），
  // 图层归属核验拒收为零登记，拒绝原因到达停点——原稿与 O1 登记保留。
  const gate2 = gateOf(o1Run);
  const o3 = await pipeline.dispatchCreativeReviewCommand(o1Run.id, {
    action: "audit_current", commandId: "audit-o3", actor: "creator", stage: gate2.stage,
    expectedRunRevision: o1Run.revision,
    expectedReviewRevision: gate2.reviewRevision, baseDraftSha256: gate2.draftSha256,
  });
  const o3Run: any = await o3.completion;
  assert.equal(spies.treatmentAuditCalls, 3, "O3 只发起一次审计调用");
  assert.equal(o3Run.status, "needs_human", "旧操作异常不得把停点打成 failed");

  const after = await pipeline.show(o3Run.id);
  assert.equal(after.status, "needs_human");
  assert.equal(gateOf(after).draftSha256, gate1.draftSha256, "旧意见不得改变稿件");
  const afterO3 = stateOf(after);
  assert.equal(afterO3.history, afterO1.history, "O3 零登记");
  assert.equal(afterO3.checkResult?.summary, "旧操作的 pass 意见", "O1 的登记保持");
  assert.deepEqual(afterO3.operationStatuses, ["audit-o1:completed", "audit-o3:completed"]);
  const reviewAfterO3 = (after.nodeRuns.find((candidate: any) => candidate.nodeId === "creative-planning")?.output as any)
    ?.creativeReview;
  // F03：拒收会新增 rejected_operation 续接诊断；除此之外逐字段不变（含历史/结论/版本/轮次）。
  const { continuation: _continuation, ...treatmentAfterO3 } = reviewAfterO3?.stages?.treatment ?? {};
  const { continuation: _continuationBefore, ...treatmentAfterO1 } = reviewAfterO1?.stages?.treatment ?? {};
  assert.deepEqual({ ...reviewAfterO3, stages: { ...reviewAfterO3.stages, treatment: treatmentAfterO3 } },
    { ...reviewAfterO1, stages: { ...reviewAfterO1.stages, treatment: treatmentAfterO1 } },
    "拒收后除续接诊断外逐字段不变");
  assert.equal(reviewAfterO3?.stages?.treatment?.continuation?.status, "rejected_operation");
  const stopDetail = (after.nodeRuns.find((candidate: any) => candidate.nodeId === "creative-planning")?.output as any)
    ?.planningStop;
  assert.ok(stopDetail?.detail?.includes("另一次已过期的操作"), "拒绝原因对创作者可见");

  // R11-V01 仪器化证据：异常对象确实两次进入真实角色调用链（O1 首绑、O3 重放），
  // 三次 check 调用对应三个互不相同的持久化操作身份，且 O3 后绑定仍属 O1（未改签）。
  const checkOps = spies.treatmentCheckOperations ?? [];
  assert.equal(checkOps.length, 3, "初稿、O1、O3 各恰好一次 check 调用");
  assert.ok(new Set(checkOps).size === 3, "三次调用必须是三个不同的审计操作身份");
  assert.ok(checkOps.every(op => op && op !== "(initial)"), "三次调用都必须携带有效操作身份");
  const rethrown = spies.treatmentRethrown ?? [];
  assert.equal(rethrown.length, 2, "异常只在 O1 与 O3 抛出");
  assert.equal(rethrown[0], staleException, "O1 抛出的就是该异常对象本体");
  assert.equal(rethrown[1], staleException, "O3 重放的是同一异常对象本体");
  assert.equal((staleException as unknown as { auditOperationId?: string }).auditOperationId,
    checkOps[1], "异常绑定保持 O1 的操作身份，未被 O3 改签");
});

// R11-V02（r11b 阻断项）：旧操作绑定的 uncertain 异常经新操作重放时，图层按 R11-01
// 的优先顺序先传播原异常（uncertain 优先于异操作拒收），不把它转换成异操作的
// needs_human 停点，零登记，原异常对象与旧绑定保持——真实 ProductionPipeline 全链。
it("旧操作绑定的 uncertain 异常经新操作重抛：原异常传播、零登记、不转停点（R11-V02）", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-r1102-uncertain-"));
  const spies: ClosureSpies = {
    treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
    screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
  };
  const rethrowBox: { value?: RoleAgentLoopError } = {};
  const pipeline = newClosurePipeline(workspaceRoot, spies, {
    get rethrowException() { return rethrowBox.value; },
  } as never);
  const started = await pipeline.start(closureBrief({ creativeReview: true }));
  const nodeOf = (r: any) => r.nodeRuns.find((candidate: any) => candidate.nodeId === "creative-planning");
  const gateOf = (r: any) => {
    const node = nodeOf(r);
    assert.ok(node?.intervention?.continuation, "创作规划必须停在复核停点上");
    return node!.intervention!.continuation!;
  };
  const treatmentOf = (r: any) => nodeOf(r)?.output?.creativeReview?.stages?.treatment;
  const gate = gateOf(started);
  const historyAfterInitial = treatmentOf(started)?.auditHistory?.length ?? 0;
  const checkResultAfterInitial = treatmentOf(started)?.checkResult ?? null;
  assert.equal(historyAfterInitial, 1, "初稿审计恰好登记一次");

  // 旧操作的 uncertain 异常：先经生产 helper 在旧操作边界建立绑定（与 guard 测试同一入口），
  // 再经新操作 audit-o3 在真实 pipeline 中重放。
  const staleUncertain = new RoleAgentLoopError("旧操作未决异常", {
    version: "video-factory/agent-loop-v1", role: "构思", contractVersion: "fixture-v1",
    criteria: [], status: "failed", maxIterations: 1, iterations: [],
    failure: { stage: "uncertain" },
  }, undefined, new CodexBridgeError("旧操作仍在观察原请求", false, "uncertain"));
  const oldOperationId = "old-uncertain-operation-v1";
  await assert.rejects(
    withAuditOperationBinding(oldOperationId, async () => { throw staleUncertain; }),
    (error: unknown) => error === staleUncertain,
  );
  assert.equal((staleUncertain as unknown as { auditOperationId?: string }).auditOperationId, oldOperationId);
  rethrowBox.value = staleUncertain;

  const o3 = await pipeline.dispatchCreativeReviewCommand(started.id, {
    action: "audit_current", commandId: "audit-o3", actor: "creator", stage: gate.stage,
    expectedRunRevision: started.revision,
    expectedReviewRevision: gate.reviewRevision, baseDraftSha256: gate.draftSha256,
  });
  const o3Run: any = await o3.completion;
  // F03（2026-10-02 执行包）替代旧断言：旧绑定 uncertain 不再以节点 failed 锁死制作；
  // 转成 unknown 人工停点＋续接诊断，零登记，初稿审计结论保持，原请求事实可查询。
  assert.equal(o3Run.status, "needs_human", "uncertain 转人工停点，不再以节点失败锁死");
  const stoppedNode = nodeOf(o3Run);
  assert.equal(stoppedNode?.status, "needs_human");
  const treatmentStop = treatmentOf(o3Run);
  assert.equal(treatmentStop?.continuation?.status, "unknown", "原请求事实进入 unknown 续接诊断");
  assert.match(String(stoppedNode?.output?.planningStop?.detail ?? ""), /仍在核实/);

  const after = await pipeline.show(o3Run.id);
  const treatment = treatmentOf(after);
  assert.equal(treatment?.auditHistory?.length, historyAfterInitial, "O3 零登记");
  assert.deepEqual(treatment?.checkResult ?? null, checkResultAfterInitial, "初稿审计结论保持不变");

  // 异常对象与绑定保持：仍是同一对象，绑定仍属旧操作，sourceError 仍为 uncertain。
  const rethrown = spies.treatmentRethrown ?? [];
  assert.equal(rethrown.length, 1, "O3 恰好重放一次");
  assert.equal(rethrown[0], staleUncertain);
  assert.equal((staleUncertain as unknown as { auditOperationId?: string }).auditOperationId,
    oldOperationId, "旧绑定未被新操作改签");
  assert.ok(staleUncertain.sourceError instanceof CodexBridgeError
    && staleUncertain.sourceError.stage === "uncertain", "sourceError.stage 仍为 uncertain");
});

// F03/D05（2026-10-02 执行包）：不可执行稿的完整服务端行为——审计异常转人工停点并给
// 字段级诊断；确认在命令边界被拒绝且保留停点；修正后合法继续。复现事故形态：
// 已发布稿缺 retrievalProviderId，审计重读时结构校验失败。
it("F03：不可执行稿审计停点、确认边界拒绝、修正后续跑（真实 Pipeline）", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-f03-nonexec-draft-"));
  const spies: ClosureSpies = {
    treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
    screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
  };
  const invalidTreatment = {
    ...legalTreatment("F03 不可执行稿"),
    evidenceRequirements: [{
      beatId: "beat-1", claim: "需要一个生成画面", requirement: "illustration_only" as const,
      suppliedSourceIds: [], critical: false, acquisition: "pipeline_generated" as const,
      retrievalProviderId: null,
    }],
  };
  // 事故同款装配：check 模式的角色端口先按真实合同校验候选再审计——结构不过即抛普通 Error。
  const treatmentPort: CreativeTreatmentAgent = {
    id: TREATMENT_PROVIDER_ID,
    modelId: "treatment-model-a",
    treat: async () => invalidTreatment as CreativeTreatment,
    treatDetailed: async (input: CreativeTreatmentAgentInput) => {
      if (input.creativeReviewExecution?.mode === "check") {
        spies.treatmentAuditCalls = (spies.treatmentAuditCalls ?? 0) + 1;
        parseCreativeTreatment(input.creativeReviewExecution.candidate, []);
        throw new Error("Creative treatment evidenceRequirements[0].retrievalProviderId is required for pipeline_generated.");
      }
      spies.treatmentModelCalls.push("treatment-model-a");
      return { output: invalidTreatment as CreativeTreatment, trace: {
        taskKind: "creative-treatment" as const, promptVersion: "v1", prompt: "fixture",
        providerId: "openai", modelId: "treatment-model-a" } };
    },
  };
  const pipeline = new ProductionPipeline({
    workspaceRoot, worker: new ClosureWorker(),
    treatmentAgents: [{ providerId: "openai", agent: treatmentPort }],
    screenwriterAgent: closureScreenwriter(spies),
    directorAgent: closureDirector(spies),
    assetProviders: CLOSURE_ASSET_PROVIDERS,
  });
  const run = await pipeline.start(closureBrief({ creativeReview: true }));
  assert.equal(run.status, "needs_human", "审计异常必须停在用户面前");
  const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
  const review = (node.output as { creativeReview: CreativeReviewState }).creativeReview;
  const stage = review.stages.treatment;
  assert.equal(stage.checkResult, null, "不得伪造结论");
  assert.equal(stage.continuation?.status, "error");
  assert.equal(stage.continuation?.reasonCode, "draft_validation_failed");
  assert.ok(stage.continuation?.validationIssues?.some((issue) => issue.path.includes("evidenceRequirements[0].retrievalProviderId")),
    "字段级问题指向具体字段");
  assert.deepEqual(stage.currentDocument, invalidTreatment, "工作台全文保留");
  const gate = node.intervention!.continuation!;

  // 确认被命令边界拒绝（保留停点），不是节点 failed。
  await assert.rejects(
    pipeline.confirmCreativeReview(run.id, {
      commandId: "confirm-invalid", actor: "creator", stage: gate.stage,
      expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
      baseDraftSha256: gate.draftSha256, acknowledgeUnaudited: true,
    }),
    (error: unknown) => error instanceof HumanDecisionConflictError && /缺必需结构.*retrievalProviderId/u.test(error.message),
  );
  const afterReject = await pipeline.show(run.id);
  assert.equal(afterReject.status, "needs_human", "拒绝后停点保留");
  assert.equal(afterReject.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")?.status, "needs_human");

  // 修正后续跑：把稿改成合法结构（编辑换版），再显式未审采用，进入脚本停点。
  const fixed = legalTreatment("F03 不可执行稿");
  const edited = await pipeline.dispatchCreativeReviewCommand(afterReject.id, {
    action: "edit_draft", commandId: "fix-draft", actor: "creator", stage: gate.stage,
    expectedRunRevision: afterReject.revision, expectedReviewRevision: gate.reviewRevision,
    baseDraftSha256: gate.draftSha256, document: fixed,
  });
  const editedRun = await edited.completion;
  assert.equal(editedRun.status, "needs_human");
  const editedGate = editedRun.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!.intervention!.continuation!;
  const adopted = await pipeline.confirmCreativeReview(editedRun.id, {
    commandId: "adopt-fixed", actor: "creator", stage: editedGate.stage,
    expectedRunRevision: editedRun.revision, expectedReviewRevision: editedGate.reviewRevision,
    baseDraftSha256: editedGate.draftSha256, acknowledgeUnaudited: true,
  });
  const planningAfter = adopted.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
  assert.notEqual(planningAfter.status, "failed", planningAfter.error);
  const reviewAfter = (planningAfter.output as { creativeReview?: CreativeReviewState; creativeReviewHistory?: CreativeReviewState }).creativeReview
    ?? (planningAfter.output as { creativeReviewHistory: CreativeReviewState }).creativeReviewHistory;
  assert.equal(reviewAfter.stages.treatment.phase, "confirmed", "修正后的稿能正常采用");
});

// ---------------------------------------------------------------------------
// DG-UX-04（新前端 Dogfood 修复执行包 R2）：讨论输入合同与失败作用域。
// 已核清的 discuss/revise 咨询失败只属于这条命令：主 run 回到原人工停点，
// 已保存稿/版本/讨论不动，回执按 not_accepted / failed / unknown 分别落账，
// 零后续生成、零重发（重放只回原结果，同 ID 异 body 拒绝）。
// ---------------------------------------------------------------------------

describe("creative discussion failure isolation (DG-UX-04)", () => {
  type BridgeCase = {
    bridgeStage: "completed_failure" | "rejected" | "not_accepted" | "uncertain";
    transient: boolean;
    receipt: "failed" | "not_accepted" | "unknown";
  };
  const bridgeCases: BridgeCase[] = [
    { bridgeStage: "completed_failure", transient: false, receipt: "failed" },
    { bridgeStage: "rejected", transient: false, receipt: "not_accepted" },
    { bridgeStage: "not_accepted", transient: true, receipt: "not_accepted" },
    { bridgeStage: "uncertain", transient: false, receipt: "unknown" },
  ];

  it("keeps the run at the human stop with the saved draft untouched when a consultation fails", async () => {
    for (const gateStage of ["treatment", "script", "director"] as const) {
      for (const testCase of bridgeCases) {
        const workspaceRoot = await mkdtemp(path.join(tmpdir(), `vf-discuss-${gateStage}-${testCase.receipt}-`));
        const spies: ClosureSpies = {
          treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
          screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
        };
        const discussCalls: Array<Record<string, unknown>> = [];
        const failingDiscuss = async (input: Record<string, unknown>) => {
          discussCalls.push(input);
          throw new CodexBridgeError(
            `受控讨论失败（${testCase.bridgeStage}）`,
            testCase.transient,
            testCase.bridgeStage,
          );
        };
        const pipeline = new ProductionPipeline({
          workspaceRoot,
          worker: new ClosureWorker(),
          treatmentAgents: closureTreatmentAgents(spies).map((entry) => ({
            providerId: entry.providerId,
            agent: Object.assign(entry.agent, { discussDetailed: failingDiscuss }),
          })),
          screenwriterAgent: Object.assign(closureScreenwriter(spies), { discussDetailed: failingDiscuss }) as ScreenwriterAgent,
          directorAgent: Object.assign(closureDirector(spies), { discussDetailed: failingDiscuss }) as VisualDirectorAgent,
          assetProviders: CLOSURE_ASSET_PROVIDERS,
        });
        const gateOf = (run: WorkflowRun<ProductionBrief>) => {
          const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
          assert.ok(node.intervention?.continuation, `制作必须停在创作停点上（${gateStage}/${testCase.receipt}）`);
          return { node, continuation: node.intervention.continuation };
        };
        const confirmCurrent = async (run: WorkflowRun<ProductionBrief>): Promise<WorkflowRun<ProductionBrief>> => {
          const { node, continuation } = gateOf(run);
          const shown = (node.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })
            .creativeReview?.stages?.[continuation.stage]?.checkResult;
          return await pipeline.confirmCreativeReview(run.id, {
            commandId: `confirm-${continuation.stage}-${testCase.receipt}-${Math.random().toString(36).slice(2, 8)}`,
            actor: "creator",
            stage: continuation.stage,
            expectedRunRevision: run.revision,
            expectedReviewRevision: continuation.reviewRevision,
            baseDraftSha256: continuation.draftSha256,
            ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
            ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
            ...(!shown ? { acknowledgeUnaudited: true as const } : {}),
          });
        };
        let run = await pipeline.start(closureBrief({ creativeReview: true }));
        if (gateStage !== "treatment") run = await confirmCurrent(run);
        if (gateStage === "director") run = await confirmCurrent(run);
        const gate = gateOf(run).continuation;
        assert.equal(gate.stage, gateStage, `应停在 ${gateStage} 停点`);
        const reviewBefore = (gateOf(run).node.output as { creativeReview: CreativeReviewState }).creativeReview;
        const stageBefore = reviewBefore.stages[gateStage];
        const documentBefore = structuredClone(stageBefore.currentDocument);
        const versionBefore = stageBefore.currentDraft!.versionId;
        const messagesBefore = stageBefore.messages.length;
        const generationBefore = {
          treatment: spies.treatmentTitles.length,
          script: spies.screenwriterCalls.length,
          director: spies.directorCalls,
        };

        // 重放必须逐字复用同一命令体（digest 覆盖全部字段，包括 expectedRunRevision）。
        const discussionCommand = {
          action: "discuss" as const,
          commandId: `discuss-${testCase.receipt}`,
          actor: "creator",
          stage: gateStage,
          expectedRunRevision: run.revision,
          expectedReviewRevision: gate.reviewRevision,
          baseDraftSha256: gate.draftSha256,
          message: "解释这个安排",
        };
        const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, discussionCommand);
        const settled = await dispatched.completion;

        // 失败只属于命令：主 run 回到原人工停点，稿/版本/讨论原样。
        assert.equal(settled.status, "needs_human", `咨询失败不能把主制作打成 failed（${gateStage}/${testCase.receipt}）：${settled.nodeRuns.map((node) => node.error).join(";")}`);
        const settledGate = gateOf(settled).continuation;
        assert.equal(settledGate.stage, gateStage);
        assert.equal(settledGate.draftSha256, gate.draftSha256);
        assert.equal(settledGate.reviewRevision, gate.reviewRevision, "失败咨询不推进复核轮次");
        const reviewAfter = (gateOf(settled).node.output as { creativeReview: CreativeReviewState }).creativeReview;
        const stageAfter = reviewAfter.stages[gateStage];
        assert.deepEqual(stageAfter.currentDocument, documentBefore, "已保存稿未改动");
        assert.equal(stageAfter.currentDraft!.versionId, versionBefore);
        assert.equal(stageAfter.messages.length, messagesBefore, "失败不伪造模型回复");
        const operation = settled.creativeReviewOperations?.find((candidate) => candidate.commandId === "discuss-" + testCase.receipt);
        assert.ok(operation, "命令必须有持久回执");
        assert.equal(operation!.status, testCase.receipt, `回执应为 ${testCase.receipt}`);
        // 零后续生成：咨询失败不得触发任何阶段重新生成。
        assert.equal(spies.treatmentTitles.length, generationBefore.treatment);
        assert.equal(spies.screenwriterCalls.length, generationBefore.script);
        assert.equal(spies.directorCalls, generationBefore.director);

        // 同 commandId 同 body 重放：不再执行第二次（unknown 的恢复重放也必须复用同一 requestId）。
        const callsAfterFirst = discussCalls.length;
        const replay = await pipeline.dispatchCreativeReviewCommand(run.id, discussionCommand);
        const replayed = await replay.completion;
        assert.equal(replayed.status, "needs_human");
        const replayOperation = replayed.creativeReviewOperations?.find((candidate) => candidate.commandId === "discuss-" + testCase.receipt);
        assert.equal(replayOperation!.status, testCase.receipt, "重放回原结果");
        for (const call of discussCalls) {
          assert.equal(call.requestId, discussCalls[0]!.requestId, "所有执行/恢复都必须指向同一原请求身份");
        }
        if (testCase.receipt !== "unknown") {
          assert.equal(discussCalls.length, callsAfterFirst, "已核清结果的重放不得再次执行");
        }
        // 同 commandId 异 body 拒绝。
        await assert.rejects(
          () => pipeline.dispatchCreativeReviewCommand(replayed.id, {
            action: "discuss",
            commandId: `discuss-${testCase.receipt}`,
            actor: "creator",
            stage: gateStage,
            expectedRunRevision: replayed.revision,
            expectedReviewRevision: gate.reviewRevision,
            baseDraftSha256: gate.draftSha256,
            message: "不同的内容",
          }),
          /already used with different content/,
        );
      }
    }
  });

  it("isolates a failed revise without adopting its proposal or advancing the gate", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-revise-failure-"));
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies),
      screenwriterAgent: Object.assign(closureScreenwriter(spies), {
        discussDetailed: async () => {
          throw new CodexBridgeError("受控修订失败", false, "completed_failure");
        },
      }) as ScreenwriterAgent,
      directorAgent: closureDirector(spies),
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    let run = await pipeline.start(closureBrief({ creativeReview: true }));
    const gateOf = (candidate: WorkflowRun<ProductionBrief>) => candidate.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    const treatment = gateOf(run);
    const shown = (treatment.output as { creativeReview: { stages: { treatment: { checkResult: { checkIdentity?: string; verdict?: string } } } } })
      .creativeReview.stages.treatment.checkResult;
    run = await pipeline.confirmCreativeReview(run.id, {
      commandId: "adopt-treatment-for-revise", actor: "creator", stage: "treatment",
      expectedRunRevision: run.revision,
      expectedReviewRevision: treatment.intervention!.continuation!.reviewRevision,
      baseDraftSha256: treatment.intervention!.continuation!.draftSha256,
      ...(shown.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
      ...(shown.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
    });
    const scriptNode = gateOf(run);
    const gate = scriptNode.intervention!.continuation!;
    assert.equal(gate.stage, "script");
    const stageBefore = (scriptNode.output as { creativeReview: CreativeReviewState }).creativeReview.stages.script;
    const documentBefore = structuredClone(stageBefore.currentDocument);

    const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
      action: "revise", commandId: "revise-fail-1", actor: "creator", stage: "script",
      expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
      baseDraftSha256: gate.draftSha256, message: "把开头改得更直接",
    });
    const settled = await dispatched.completion;
    assert.equal(settled.status, "needs_human", `修订失败不得把主制作打成 failed：${gateOf(settled).error}`);
    const settledGate = gateOf(settled).intervention!.continuation!;
    assert.equal(settledGate.stage, "script");
    assert.equal(settledGate.draftSha256, gate.draftSha256);
    const stageAfter = (gateOf(settled).output as { creativeReview: CreativeReviewState }).creativeReview.stages.script;
    assert.deepEqual(stageAfter.currentDocument, documentBefore, "失败修订不改旧稿");
    assert.equal(stageAfter.proposals.length, stageBefore.proposals.length, "失败不落非法提案");
    assert.deepEqual(stageAfter.effectiveUserInstructions, stageBefore.effectiveUserInstructions, "失败意见不当成长期要求");
    const operation = settled.creativeReviewOperations?.find((candidate) => candidate.commandId === "revise-fail-1");
    assert.equal(operation!.status, "failed");
  });
});

// ---------------------------------------------------------------------------
// C2（收尾包 2026-10-04）：统一讨论错误事实分类。
// conflict 不得并入 not_accepted；多候选必须读全部 failures 而非最后一个 cause；
// 执行记录（discussion-executions）与 planning 续接诊断、operation 回执同源一致；
// 未受理/失败/未知任何一类都不得在无全链证据时承诺零费用。
// ---------------------------------------------------------------------------

describe("creative consultation fact classification (C2)", () => {
  type Shape =
    | { kind: "bridge"; stage: "completed_failure" | "rejected" | "not_accepted" | "uncertain" | "conflict" }
    | { kind: "wrapped"; stage: "uncertain" }
    | { kind: "plain" }
    | { kind: "candidates"; stages: Array<"completed_failure" | "not_accepted" | "uncertain">; wrapDepth?: number; wrapFailures?: boolean }
    | { kind: "schema-rejected" };
  type Expect = {
    continuationStatus: "rejected_operation" | "error" | "unknown";
    reasonCode: string;
    receipt: "not_accepted" | "failed" | "unknown";
    executionState: "not_accepted" | "completed_failure" | "accepted_unknown";
  };
  const cases: Array<{ label: string; shape: Shape; expect: Expect; action: "discuss" | "revise" }> = [
    { label: "conflict-is-unknown", shape: { kind: "bridge", stage: "conflict" }, action: "discuss",
      expect: { continuationStatus: "unknown", reasonCode: "discussion_identity_conflict", receipt: "unknown", executionState: "accepted_unknown" } },
    { label: "wrapped-uncertain-is-unknown", shape: { kind: "wrapped", stage: "uncertain" }, action: "discuss",
      expect: { continuationStatus: "unknown", reasonCode: "discussion_request_unknown", receipt: "unknown", executionState: "accepted_unknown" } },
    { label: "plain-error-is-unknown", shape: { kind: "plain" }, action: "revise",
      expect: { continuationStatus: "unknown", reasonCode: "discussion_request_unknown", receipt: "unknown", executionState: "accepted_unknown" } },
    { label: "mixed-failed-then-not-accepted-is-failed", shape: { kind: "candidates", stages: ["completed_failure", "not_accepted"] }, action: "discuss",
      expect: { continuationStatus: "error", reasonCode: "discussion_failed", receipt: "failed", executionState: "completed_failure" } },
    { label: "wrapped-candidates-preserve-failure", shape: { kind: "candidates", stages: ["completed_failure", "not_accepted"], wrapDepth: 1 }, action: "discuss",
      expect: { continuationStatus: "error", reasonCode: "discussion_failed", receipt: "failed", executionState: "completed_failure" } },
    { label: "mixed-failed-then-uncertain-is-unknown", shape: { kind: "candidates", stages: ["completed_failure", "uncertain"] }, action: "revise",
      expect: { continuationStatus: "unknown", reasonCode: "discussion_request_unknown", receipt: "unknown", executionState: "accepted_unknown" } },
    { label: "twice-wrapped-candidates-preserve-unknown", shape: { kind: "candidates", stages: ["completed_failure", "uncertain"], wrapDepth: 2, wrapFailures: true }, action: "revise",
      expect: { continuationStatus: "unknown", reasonCode: "discussion_request_unknown", receipt: "unknown", executionState: "accepted_unknown" } },
    { label: "all-candidates-not-accepted", shape: { kind: "candidates", stages: ["not_accepted", "not_accepted"] }, action: "discuss",
      expect: { continuationStatus: "rejected_operation", reasonCode: "discussion_not_accepted", receipt: "not_accepted", executionState: "not_accepted" } },
    { label: "wrapped-all-not-accepted-retain-identities", shape: { kind: "candidates", stages: ["not_accepted", "not_accepted"], wrapDepth: 2 }, action: "discuss",
      expect: { continuationStatus: "rejected_operation", reasonCode: "discussion_not_accepted", receipt: "not_accepted", executionState: "not_accepted" } },
    { label: "schema-rejected-result-is-failed", shape: { kind: "schema-rejected" }, action: "revise",
      expect: { continuationStatus: "error", reasonCode: "discussion_failed", receipt: "failed", executionState: "completed_failure" } },
  ];

  const buildError = (shape: Shape): unknown => {
    if (shape.kind === "bridge") return new CodexBridgeError(`受控（${shape.stage}）`, shape.stage === "not_accepted", shape.stage);
    if (shape.kind === "wrapped") return new Error("外层普通错误", { cause: new CodexBridgeError("受控（uncertain）", false, "uncertain") });
    if (shape.kind === "plain") return new Error("没有任何 Bridge 证据的普通错误");
    if (shape.kind === "candidates") {
      let error: Error = new ModelCandidatesExhaustedError(shape.stages.map((stage, index) => ({
        modelId: `candidate-model-${index + 1}`,
        providerId: `candidate-provider-${index + 1}`,
        error: shape.wrapFailures
          ? new Error("受控候选包装", { cause: new CodexBridgeError(`受控候选（${stage}）`, stage === "not_accepted", stage) })
          : new CodexBridgeError(`受控候选（${stage}）`, stage === "not_accepted", stage),
      })));
      for (let depth = 0; depth < (shape.wrapDepth ?? 0); depth += 1) error = new Error("受控角色包装", { cause: error });
      return error;
    }
    return undefined;
  };

  it("classifies consistently across continuation, operation receipt and durable execution record on all three stages", async () => {
    for (const gateStage of ["treatment", "script", "director"] as const) {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), `vf-c2-${gateStage}-`));
      const spies: ClosureSpies = {
        treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
        screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
      };
      let schemaRejected = false;
      let callIndex = 0;
      const discussImpl = async (input: Record<string, unknown>) => {
        callIndex += 1;
        const current = cases.find((entry) => entry.label === order[callIndex - 1])!;
        if (current.shape.kind === "schema-rejected") {
          schemaRejected = true;
          // 已受理并返回结果，但 revise 缺少阶段文档 → recordCreativeDiscussion 拒绝。
          return {
            output: { stage: input.stage, intent: "revise", reply: "已按意见修改", changeSummary: ["改写结尾"], treatment: null, script: null, director: null, upstreamRequest: null },
            trace: { taskKind: "creative-discussion", promptVersion: "v3", providerId: "c2-provider", modelId: "c2-model", prompt: "c2" },
          };
        }
        throw buildError(current.shape);
      };
      const order = cases.map((entry) => entry.label);
      const pipeline = new ProductionPipeline({
        workspaceRoot,
        worker: new ClosureWorker(),
        treatmentAgents: closureTreatmentAgents(spies).map((entry) => ({
          providerId: entry.providerId,
          agent: Object.assign(entry.agent, { discussDetailed: discussImpl }),
        })),
        screenwriterAgent: Object.assign(closureScreenwriter(spies), { discussDetailed: discussImpl }) as ScreenwriterAgent,
        directorAgent: Object.assign(closureDirector(spies), { discussDetailed: discussImpl }) as VisualDirectorAgent,
        assetProviders: CLOSURE_ASSET_PROVIDERS,
      });
      const gateOf = (run: WorkflowRun<ProductionBrief>) => {
        const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
        assert.ok(node.intervention?.continuation, "制作必须停在创作停点上");
        return { node, continuation: node.intervention.continuation };
      };
      const confirmCurrent = async (run: WorkflowRun<ProductionBrief>): Promise<WorkflowRun<ProductionBrief>> => {
        const { node, continuation } = gateOf(run);
        const shown = (node.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })
          .creativeReview?.stages?.[continuation.stage]?.checkResult;
        return await pipeline.confirmCreativeReview(run.id, {
          commandId: `confirm-${continuation.stage}-${Math.random().toString(36).slice(2, 8)}`,
          actor: "creator",
          stage: continuation.stage,
          expectedRunRevision: run.revision,
          expectedReviewRevision: continuation.reviewRevision,
          baseDraftSha256: continuation.draftSha256,
          ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
          ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
          ...(!shown ? { acknowledgeUnaudited: true as const } : {}),
        });
      };
      for (const testCase of cases) {
        // 每种故障使用独立制作；unknown未核清时不应允许下一条新模型咨询。
        let run = await pipeline.start(closureBrief({ creativeReview: true }));
        if (gateStage !== "treatment") run = await confirmCurrent(run);
        if (gateStage === "director") run = await confirmCurrent(run);
        const draftBefore = structuredClone((gateOf(run).node.output as { creativeReview: CreativeReviewState }).creativeReview.stages[gateStage].currentDocument);
        const versionBefore = (gateOf(run).node.output as { creativeReview: CreativeReviewState }).creativeReview.stages[gateStage].currentDraft!.versionId;
        const gate = gateOf(run).continuation;
        const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
          action: testCase.action,
          commandId: `c2-${gateStage}-${testCase.label}-${Math.random().toString(36).slice(2, 8)}`,
          actor: "creator",
          stage: gateStage,
          expectedRunRevision: run.revision,
          expectedReviewRevision: gate.reviewRevision,
          baseDraftSha256: gate.draftSha256,
          message: "C2 分类意见",
        });
        const settled = await dispatched.completion;
        assert.equal(settled.status, "needs_human", `${gateStage}/${testCase.label} 不能把主制作打成 failed`);
        const review = (gateOf(settled).node.output as { creativeReview: CreativeReviewState }).creativeReview;
        const stageState = review.stages[gateStage];
        // 事实一：planning 续接诊断
        const continuation = stageState.continuation;
        assert.ok(continuation, `${gateStage}/${testCase.label} 必须留下续接诊断`);
        assert.equal(continuation!.status, testCase.expect.continuationStatus, `${gateStage}/${testCase.label} 续接状态`);
        assert.equal(continuation!.reasonCode, testCase.expect.reasonCode, `${gateStage}/${testCase.label} reasonCode`);
        // 未受理/失败/未知都不得承诺零费用或“没有执行”零调用（除非全链证据）
        if (testCase.expect.continuationStatus !== "rejected_operation") {
          assert.ok(!/不会产生模型调用或费用/.test(continuation!.detail), `${gateStage}/${testCase.label} 不得承诺零费用：${continuation!.detail}`);
        }
        // 事实二：operation 回执
        const operation = settled.creativeReviewOperations?.at(-1);
        assert.equal(operation?.status, testCase.expect.receipt, `${gateStage}/${testCase.label} operation 回执`);
        const studio = new ProductionStudio({ workspaceRoot, pipeline, listProviders: async () => [],
          archiveStore: new JsonRunArchiveStore(path.join(workspaceRoot, "archive.json")) });
        assert.equal((await studio.creativeReviewCommand(settled.id, operation!.commandId))?.status, testCase.expect.receipt,
          `${gateStage}/${testCase.label} 正式Studio耐久读取与operation同事实`);
        // 事实三：原稿不动
        assert.deepEqual(stageState.currentDocument, draftBefore, `${gateStage}/${testCase.label} 原稿不变`);
        assert.equal(stageState.currentDraft!.versionId, versionBefore, `${gateStage}/${testCase.label} 版本不变`);
        // 事实四：durable 执行记录与分类同源（按 commandId 定位，不依赖目录顺序）
        const recordDir = path.join(workspaceRoot, "runs", settled.id, "nodes", "creative-planning", "discussion-executions");
        const recordFiles = await readdir(recordDir).catch(() => [] as string[]);
        const parsed = await Promise.all(recordFiles.filter((name) => name.endsWith(".json"))
          .map(async (name) => JSON.parse(await readFile(path.join(recordDir, name), "utf8")) as Record<string, unknown>));
        const commandId = operation!.commandId;
        const record = parsed.find((entry) => entry.commandId === commandId);
        assert.ok(record, `${gateStage}/${testCase.label} 必须有 durable 执行记录`);
        assert.equal(record!.state, testCase.expect.executionState, `${gateStage}/${testCase.label} 执行记录状态：${JSON.stringify(record)}`);
        if (testCase.shape.kind === "candidates" && testCase.shape.stages.length > 1) {
          // 每个物理候选的事实必须保留，后一个候选不能抹掉前一个已受理失败
          const candidateStates = (record!.candidates as Array<{ state: string }> | undefined)?.map((entry) => entry.state);
          assert.deepEqual(candidateStates, testCase.shape.stages.map((stage) => stage === "completed_failure" ? "failed" : stage === "not_accepted" ? "not_accepted" : "unknown"),
            `${gateStage}/${testCase.label} 候选事实保留`);
        }
        // 各故障保留原停点；unknown不能借此自动开启另一条咨询。
        assert.equal(gateOf(settled).continuation.stage, gateStage);
      }
      // schema-rejected 场景确实走的是“返回结果但被拒”路径
      assert.ok(schemaRejected, "schema-rejected 用例必须真实返回过结果");
    }
  });
});

// ---------------------------------------------------------------------------
// C1（收尾包 2026-10-04）：unknown 讨论的原请求取回与原稿独立处理。
// 真实 Broker（受控执行器）+ 真实 Store/Pipeline；prepared 快照先存后发；
// 恢复只观察原物理请求（executor 物理提交计数不增加）；迟到结果只归档原命令。
// ---------------------------------------------------------------------------

describe("creative discussion unknown recovery (C1)", () => {
  class ControllableDiscussionExecutor {
    submits = 0;
    private held: Array<() => void> = [];
    private mode: "hold" | "complete" = "complete";
    identity = { profileId: "deepseek", providerId: "c1-provider", modelId: "c1-model", taskKinds: ["creative-discussion"] };
    modelCandidates = ["c1-provider"];
    hold() { this.mode = "hold"; }
    release() { this.mode = "complete"; for (const resolve of this.held) resolve(); this.held = []; }
    get pending() { return this.held.length; }

    async runTask(task: ValidatedTask, _options?: unknown): Promise<{ output: string; sessionId: string; trace: Record<string, unknown> }> {
      this.submits += 1;
      const payload = task.payload as Record<string, any>;
      if (task.kind !== "creative-discussion") throw new Error(`unexpected kind ${task.kind}`);
      if (this.mode === "hold" && this.submits > 0) await new Promise<void>(resolve => this.held.push(resolve));
      const isRevise = payload.requestMode === "revise";
      const revised = structuredClone(payload.currentDocument);
      if (isRevise && payload.stage === "treatment") revised.payoff = "C1 修订后的结尾";
      if (isRevise && payload.stage === "script") revised.scenes.at(-1).narration = "C1 修订后的最后一段旁白。";
      if (isRevise && payload.stage === "director") revised.visualBible = { ...revised.visualBible, pacing: "C1 修订后的节奏" };
      const result = {
        stage: payload.stage, intent: isRevise ? "revise" : "explain",
        reply: isRevise ? "已按意见修订；未审，等你决定。" : "C1 受控解释：当前稿从观察到行动再到收束。",
        changeSummary: isRevise ? ["修订结尾"] : [],
        treatment: isRevise && payload.stage === "treatment" ? revised : null,
        script: isRevise && payload.stage === "script" ? revised : null,
        director: isRevise && payload.stage === "director" ? revised : null,
        upstreamRequest: null,
      };
      return {
        output: JSON.stringify(result),
        sessionId: "019c-c1-0000-7000-8000-000000000001",
        trace: { taskKind: task.kind, providerId: "c1-provider", modelId: "c1-model", promptVersion: "controlled-c1", contractDigest: task.expectedContractDigest, prompt: "C1 受控执行器" },
      };
    }
  }

  async function startRecoveryHarness(options: { holdInitially?: boolean } = {}) {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-c1-"));
    const sockets = path.join(workspaceRoot, "sockets");
    await mkdir(sockets, { recursive: true });
    const executor = new ControllableDiscussionExecutor();
    if (options.holdInitially) executor.hold();
    const broker = new CodexBrokerServer({
      socketPath: path.join(sockets, "c1.sock"),
      executor: executor as unknown as ConstructorParameters<typeof CodexBrokerServer>[0]["executor"],
      concurrency: 2,
      maxBacklog: 8,
      idempotencyDirectory: path.join(workspaceRoot, "broker-idempotency"),
      sessionDirectory: path.join(workspaceRoot, "broker-sessions"),
    });
    await broker.start();
    const client = new CodexBridgeClient({ socketPath: path.join(sockets, "c1.sock"), timeoutMs: 400, pollIntervalMs: 20, maxAttempts: 1 });
    const spies: ClosureSpies = {
      treatmentTitles: [], treatmentModelCalls: [], treatmentCheckpointPresent: [],
      screenwriterCalls: [], directorCalls: 0, searchCalls: 0, rankCalls: 0, rankRequests: [], rankCheckpoints: [],
    };
    const discussionViaBroker = (input: import("../src/codex-creative-discussion.js").CreativeDiscussionAgentInput) => runCreativeDiscussionTask(client, input);
    const buildPipeline = () => new ProductionPipeline({
      workspaceRoot,
      worker: new ClosureWorker(),
      treatmentAgents: closureTreatmentAgents(spies).map((entry) => ({
        providerId: entry.providerId,
        agent: Object.assign(entry.agent, { discussDetailed: discussionViaBroker }),
      })),
      screenwriterAgent: Object.assign(closureScreenwriter(spies), { discussDetailed: discussionViaBroker }) as ScreenwriterAgent,
      directorAgent: Object.assign(closureDirector(spies), { discussDetailed: discussionViaBroker }) as VisualDirectorAgent,
      assetProviders: CLOSURE_ASSET_PROVIDERS,
    });
    return { workspaceRoot, executor, broker, client, spies, buildPipeline };
  }

  const gateOf = (run: WorkflowRun<ProductionBrief>) => {
    const node = run.nodeRuns.find((candidate) => candidate.nodeId === "creative-planning")!;
    assert.ok(node.intervention?.continuation, "必须停在创作停点");
    return { node, continuation: node.intervention.continuation };
  };
  const stageReview = (run: WorkflowRun<ProductionBrief>, stage: string) =>
    (gateOf(run).node.output as { creativeReview: CreativeReviewState }).creativeReview.stages[stage as "treatment"];

  async function confirmTo(pipeline: ProductionPipeline, run: WorkflowRun<ProductionBrief>, target: "treatment" | "script" | "director"): Promise<WorkflowRun<ProductionBrief>> {
    let current = run;
    while (gateOf(current).continuation.stage !== target) {
      const { node, continuation } = gateOf(current);
      const shown = (node.output as { creativeReview?: { stages?: Record<string, { checkResult?: { verdict?: string; checkIdentity?: string } }> } })
        .creativeReview?.stages?.[continuation.stage]?.checkResult;
      current = await pipeline.confirmCreativeReview(current.id, {
        commandId: `c1-confirm-${continuation.stage}-${Math.random().toString(36).slice(2, 8)}`,
        actor: "creator",
        stage: continuation.stage,
        expectedRunRevision: current.revision,
        expectedReviewRevision: continuation.reviewRevision,
        baseDraftSha256: continuation.draftSha256,
        ...(shown?.checkIdentity ? { expectedCheckIdentity: shown.checkIdentity } : {}),
        ...(shown?.verdict === "repair" ? { acknowledgeRepair: true as const } : {}),
        ...(!shown ? { acknowledgeUnaudited: true as const } : {}),
      });
    }
    return current;
  }

  it("C1-B allows hand-editing the saved draft while the original request stays unknown, and the late result never overwrites", async () => {
    const harness = await startRecoveryHarness({ holdInitially: true });
    try {
      const pipeline = harness.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "script");
      const gate = gateOf(run).continuation;
      const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
        action: "revise", commandId: "c1b-original", actor: "creator", stage: "script",
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "script").currentDraft!.versionId, message: "C1-B 原修订意见",
      });
      let settled = await dispatched.completion;
      assert.equal(settled.status, "needs_human");
      assert.equal(harness.executor.submits, 1);
      let review = stageReview(settled, "script");
      assert.equal(review.continuation?.status, "unknown");

      // unknown 期间：服务端证明后，用户手改当前稿（新 commandId，正常 CAS）
      const editedDocument = structuredClone(review.currentDocument) as { scenes: Array<{ narration: string }> };
      editedDocument.scenes[0]!.narration = "C1-B 用户在 unknown 期间的手改第一段。";
      const editDispatched = await pipeline.dispatchCreativeReviewCommand(settled.id, {
        action: "edit_draft", commandId: "c1b-user-edit", actor: "creator", stage: "script",
        expectedRunRevision: settled.revision,
        expectedReviewRevision: gateOf(settled).continuation.reviewRevision,
        baseDraftSha256: gateOf(settled).continuation.draftSha256,
        document: editedDocument,
      });
      const edited = await editDispatched.completion;
      assert.equal(edited.status, "needs_human", "unknown 期间手改不被挡");
      const editedReview = stageReview(edited, "script");
      const userVersion = editedReview.currentDraft!.versionId;
      assert.notEqual(editedReview.currentDraft!.sha256, review.currentDraft!.sha256, "用户手改形成有效新版本");
      const originalOperation = edited.creativeReviewOperations?.find(op => op.commandId === "c1b-original");
      assert.equal(originalOperation?.status, "unknown", "旧命令仍 unknown、费用待核");

      // 原请求此后完成：迟到结果不覆盖用户手改，只归档原命令
      harness.executor.release();
      const replay = await pipeline.dispatchCreativeReviewCommand(edited.id, {
        action: "revise", commandId: "c1b-original", actor: "creator", stage: "script",
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "script").currentDraft!.versionId, message: "C1-B 原修订意见",
      });
      const replayed = await replay.completion;
      assert.equal(replayed.status, "needs_human");
      assert.equal(harness.executor.submits, 1, "迟到取回仍零物理重发");
      const lateReview = stageReview(replayed, "script");
      assert.equal(lateReview.currentDraft!.versionId, userVersion, "用户手改版本不被覆盖");
      assert.equal(lateReview.currentDraft!.sha256, editedReview.currentDraft!.sha256);
      assert.deepEqual(lateReview, editedReview, "迟到结果只归原命令，不污染当前稿的续接/审计/意见");
      const lateOperation = replayed.creativeReviewOperations?.find(op => op.commandId === "c1b-original");
      assert.equal(lateOperation?.status, "completed");
      assert.equal(lateOperation?.resultDisposition, "recorded_not_applied");
      // 无新增模型生成：只有最初一次 executor 提交
      assert.equal(harness.spies.screenwriterCalls.length, 1, "unknown/迟到链不触发重新生成");
    } finally {
      await harness.broker.close();
    }
  });

  it("C1-F same-content A-prime does not let the late result re-apply as current", async () => {
    const harness = await startRecoveryHarness({ holdInitially: true });
    try {
      const pipeline = harness.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "script");
      const gate = gateOf(run).continuation;
      const originalDocument = structuredClone(stageReview(run, "script").currentDocument);
      const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
        action: "discuss", commandId: "c1f-original", actor: "creator", stage: "script",
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "script").currentDraft!.versionId, message: "C1-F 原讨论",
      });
      const settled = await dispatched.completion;
      assert.equal(harness.executor.submits, 1);
      // A→B→A：手改成 B 再改回同内容 A′（同 SHA、不同 versionId）
      let current = settled;
      for (const [commandId, narration] of [["c1f-edit-b", "C1-F B 版旁白。"], ["c1f-edit-a-prime", (originalDocument as { scenes: Array<{ narration: string }> }).scenes[0]!.narration]] as const) {
        const doc = structuredClone(stageReview(current, "script").currentDocument) as { scenes: Array<{ narration: string }> };
        doc.scenes[0]!.narration = narration;
        const edit = await pipeline.dispatchCreativeReviewCommand(current.id, {
          action: "edit_draft", commandId, actor: "creator", stage: "script",
          expectedRunRevision: current.revision,
          expectedReviewRevision: gateOf(current).continuation.reviewRevision,
          baseDraftSha256: gateOf(current).continuation.draftSha256,
          document: doc,
        });
        current = await edit.completion;
      }
      const aprimeVersion = stageReview(current, "script").currentDraft!.versionId;
      harness.executor.release();
      const replay = await pipeline.dispatchCreativeReviewCommand(current.id, {
        action: "discuss", commandId: "c1f-original", actor: "creator", stage: "script",
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "script").currentDraft!.versionId, message: "C1-F 原讨论",
      });
      const replayed = await replay.completion;
      const lateReview = stageReview(replayed, "script");
      assert.equal(lateReview.currentDraft!.versionId, aprimeVersion, "A′ 不被历史结果回滚");
      assert.equal(lateReview.currentDraft!.sha256, stageReview(run, "script").currentDraft!.sha256, "确实回到同内容A′");
      assert.notEqual(aprimeVersion, stageReview(run, "script").currentDraft!.versionId, "A′有独立版本身份");
      assert.deepEqual(lateReview, stageReview(current, "script"), "当前稿和旧选择/确认不被污染");
      assert.equal(replayed.creativeReviewOperations?.find(op => op.commandId === "c1f-original")?.resultDisposition, "recorded_not_applied");
    } finally {
      await harness.broker.close();
    }
  });

  it("C1-D rejects conflicting bodies and stale identities without any new model call", async () => {
    const harness = await startRecoveryHarness({ holdInitially: true });
    try {
      const pipeline = harness.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "treatment");
      const gate = gateOf(run).continuation;
      const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
        action: "discuss", commandId: "c1d-original", actor: "creator", stage: "treatment",
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, message: "C1-D 原命令",
      });
      const settled = await dispatched.completion;
      assert.equal(harness.executor.submits, 1);
      // 同 ID 异 body 拒绝
      await assert.rejects(
        () => pipeline.dispatchCreativeReviewCommand(settled.id, {
          action: "discuss", commandId: "c1d-original", actor: "creator", stage: "treatment",
          expectedRunRevision: settled.revision, expectedReviewRevision: gate.reviewRevision,
          baseDraftSha256: gate.draftSha256, message: "不同的内容",
        }),
        /already used with different content/,
      );
      // 错 stage/过期 SHA 由命令边界拒绝（既有 CAS 合同）
      await assert.rejects(
        () => pipeline.dispatchCreativeReviewCommand(settled.id, {
          action: "discuss", commandId: "c1d-other", actor: "creator", stage: "treatment",
          expectedRunRevision: settled.revision, expectedReviewRevision: gate.reviewRevision,
          baseDraftSha256: "0".repeat(64), message: "错 SHA",
        }),
        /stale|another stage|Creative review/,
      );
      assert.equal(harness.executor.submits, 1, "负例零新物理请求");
    } finally {
      await harness.broker.close();
    }
  });

  it("C1-C observes a late revision after adoption without reopening the old stage or changing the next stop", async () => {
    const harness = await startRecoveryHarness({ holdInitially: true });
    try {
      const pipeline = harness.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "script");
      const gate = gateOf(run).continuation;
      const original = {
        action: "revise" as const, commandId: "c1c-original", actor: "creator", stage: "script" as const,
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "script").currentDraft!.versionId!, message: "只修订收束",
      };
      const unknown = await (await pipeline.dispatchCreativeReviewCommand(run.id, original)).completion;
      const adopted = await confirmTo(pipeline, unknown, "director");
      const stop = structuredClone(gateOf(adopted).node.intervention);
      const beforeReview = structuredClone((gateOf(adopted).node.output as { creativeReview: CreativeReviewState }).creativeReview);
      const generated = harness.spies.directorCalls;
      harness.executor.release();
      const recovered = await (await pipeline.dispatchCreativeReviewCommand(adopted.id, original)).completion;
      assert.equal(recovered.status, "needs_human");
      assert.deepEqual(gateOf(recovered).node.intervention, stop, "旧回复不能抢占导演停点");
      assert.deepEqual((gateOf(recovered).node.output as { creativeReview: CreativeReviewState }).creativeReview, beforeReview, "原稿/确认/审计不被污染");
      assert.equal(harness.spies.directorCalls, generated, "取回原请求不重新生成后继");
      assert.equal(harness.executor.submits, 1);
      assert.equal(recovered.creativeReviewOperations?.find(op => op.commandId === original.commandId)?.resultDisposition, "recorded_not_applied");
      const replay = await (await harness.buildPipeline().dispatchCreativeReviewCommand(recovered.id, original)).completion;
      assert.deepEqual(replay, recovered, "服务重建后的重复核对仍返回同一结果");
    } finally { harness.executor.release(); await harness.broker.close(); }
  });

  it("C1-C keeps a returned upstream stop and rediscovers the original command from durable Studio state", async () => {
    const harness = await startRecoveryHarness({ holdInitially: true });
    try {
      const pipeline = harness.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "script");
      const gate = gateOf(run).continuation;
      const original = { action: "revise" as const, commandId: "c1c-return-original", actor: "creator", stage: "script" as const,
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "script").currentDraft!.versionId!, message: "修订最后一段" };
      const unknown = await (await pipeline.dispatchCreativeReviewCommand(run.id, original)).completion;
      const studio = new ProductionStudio({ workspaceRoot: harness.workspaceRoot, pipeline, listProviders: async () => [],
        archiveStore: new JsonRunArchiveStore(path.join(harness.workspaceRoot, "archive.json")) });
      const snapshot = await studio.creativeReview(unknown.id);
      assert.deepEqual(snapshot?.pendingConsultation?.allowedActions, ["edit_draft", "confirm", "return_to_stage"]);
      assert.equal(snapshot?.consultationOperations?.[0]?.command.commandId, original.commandId);
      await assert.rejects(() => pipeline.dispatchCreativeReviewCommand(unknown.id, { ...original, commandId: "new-consultation", expectedRunRevision: unknown.revision }), /尚未核清/);
      await pipeline.withRunMaintenanceLease([unknown.id], async () => {
        assert.equal((await studio.creativeReviewCommand(unknown.id, original.commandId))?.independentDraftActions, undefined, "活跃租约不给独立许可");
        await assert.rejects(() => pipeline.dispatchCreativeReviewCommand(unknown.id, original), /locked by another writer/);
      });
      const returned = await (await pipeline.dispatchCreativeReviewCommand(unknown.id, { action: "return_to_stage", commandId: "explicit-return", actor: "creator",
        stage: "script", expectedRunRevision: unknown.revision, expectedReviewRevision: gateOf(unknown).continuation.reviewRevision,
        baseDraftSha256: gateOf(unknown).continuation.draftSha256, targetStage: "treatment", acknowledgeImpact: true })).completion;
      const stop = structuredClone(gateOf(returned).node.intervention);
      const beforeReview = structuredClone((gateOf(returned).node.output as { creativeReview: CreativeReviewState }).creativeReview);
      const rediscovered = await studio.creativeReview(returned.id);
      const { actor: _actor, ...body } = original;
      assert.deepEqual(rediscovered?.consultationOperations?.[0]?.command, body, "无需本机key便可找回原完整body");
      // 比较同一耐久JSON域；run保存会正常省略undefined可选字段。
      const durableReview = JSON.parse(JSON.stringify(beforeReview)) as CreativeReviewState;
      harness.executor.release();
      const recovered = await (await pipeline.dispatchCreativeReviewCommand(returned.id, original)).completion;
      assert.deepEqual(gateOf(recovered).node.intervention, stop);
      assert.deepEqual((gateOf(recovered).node.output as { creativeReview: CreativeReviewState }).creativeReview, durableReview);
      assert.equal(harness.executor.submits, 1);
      assert.equal(recovered.creativeReviewOperations?.find(op => op.commandId === original.commandId)?.resultDisposition, "recorded_not_applied");
      assert.match((await studio.creativeReview(recovered.id))?.consultationOperations?.[0]?.reply ?? "", /已按意见修订/);
    } finally { harness.executor.release(); await harness.broker.close(); }
  });

  it("C1-A background receipt proof does not reject explicit recovery, but an external active writer still does", async () => {
    const harness = await startRecoveryHarness({ holdInitially: true });
    let unblockProof = () => {};
    try {
      const pipeline = harness.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "script");
      const gate = gateOf(run).continuation;
      const original = { action: "discuss" as const, commandId: "c1a-background-proof", actor: "creator", stage: "script" as const,
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "script").currentDraft!.versionId!, message: "核对原讨论" };
      const unknown = await (await pipeline.dispatchCreativeReviewCommand(run.id, original)).completion;
      const studio = new ProductionStudio({ workspaceRoot: harness.workspaceRoot, pipeline, listProviders: async () => [],
        archiveStore: new JsonRunArchiveStore(path.join(harness.workspaceRoot, "archive.json")) });
      const { actor, ...body } = original;
      await pipeline.withRunMaintenanceLease([unknown.id], async () => {
        await assert.rejects(() => studio.commandCreativeReview(unknown.id, body, actor), /最新版/,
          "外部活跃写者仍由真实租约拒绝，不排队抢占");
        assert.equal((await studio.creativeReviewCommand(unknown.id, original.commandId))?.independentDraftActions, undefined);
      });
      harness.executor.release();
      let proofEntered!: () => void;
      const entered = new Promise<void>(resolve => { proofEntered = resolve; });
      const proofGate = new Promise<void>(resolve => { unblockProof = resolve; });
      const realMaintenance = pipeline.withRunMaintenanceLease.bind(pipeline);
      let delayOnce = true;
      // 仅注入读取时序：真实维护租约/Store/恢复通道仍全部执行。
      const delayed = mock.method(pipeline, "withRunMaintenanceLease", (ids: string[], action: () => Promise<unknown>) =>
        realMaintenance(ids, async () => {
          if (delayOnce) { delayOnce = false; proofEntered(); await proofGate; }
          return action();
        }));
      try {
        const backgroundRead = studio.creativeReview(unknown.id);
        await entered;
        const explicitRecovery = studio.commandCreativeReview(unknown.id, body, actor)
          .then(receipt => ({ receipt }), error => ({ error }));
        await new Promise<void>(resolve => setImmediate(resolve));
        unblockProof();
        await backgroundRead;
        const result = await explicitRecovery;
        assert.ok("receipt" in result, `后台只读证明不能制造命令冲突：${"error" in result ? result.error : ""}`);
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await studio.creativeReviewCommand(unknown.id, original.commandId))?.status === "completed") break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const recovered = await studio.creativeReview(unknown.id);
        assert.equal((await studio.creativeReviewCommand(unknown.id, original.commandId))?.status, "completed");
        assert.equal(recovered?.messages.length, 2, "原讨论只应用一次");
        assert.equal(recovered?.draftVersionId, original.baseDraftVersionId);
        await studio.commandCreativeReview(unknown.id, body, actor);
        assert.equal((await studio.creativeReview(unknown.id))?.messages.length, 2);
        assert.equal(harness.executor.submits, 1, "查询只观察原物理请求，零重投");
      } finally { delayed.mock.restore(); }
    } finally { unblockProof(); harness.executor.release(); await harness.broker.close(); }
  });

  it("RF4 never rebuilds an existing unknown request when its recovery records are missing or unreadable", async () => {
    for (const damage of ["malformed", "missing", "prepared-only"] as const) {
      const harness = await startRecoveryHarness({ holdInitially: true });
      const fresh = mock.method(harness.client, "runTaskDetailed", harness.client.runTaskDetailed.bind(harness.client));
      const prepare = mock.method(harness.client, "prepareTask", harness.client.prepareTask.bind(harness.client));
      const submit = mock.method(harness.client, "submitPreparedIfUnaccepted", harness.client.submitPreparedIfUnaccepted.bind(harness.client));
      try {
        const pipeline = harness.buildPipeline();
        const run = await pipeline.start(closureBrief({ creativeReview: true }));
        const gate = gateOf(run).continuation;
        const body = { action: "discuss" as const, commandId: `rf4-${damage}`, actor: "creator", stage: "treatment" as const,
          expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
          baseDraftSha256: gate.draftSha256, baseDraftVersionId: stageReview(run, "treatment").currentDraft!.versionId!, message: "查询原讨论" };
        const first = await (await pipeline.dispatchCreativeReviewCommand(run.id, body)).completion;
        assert.equal(first.creativeReviewOperations?.at(-1)?.status, "unknown");
        assert.equal(harness.executor.submits, 1);
        const callsBefore = fresh.mock.callCount();
        const prepareBefore = prepare.mock.callCount();
        const submitBefore = submit.mock.callCount();
        const draftBefore = structuredClone(stageReview(first, "treatment").currentDocument);
        for (const directoryName of ["discussion-prepared", ...(damage === "prepared-only" ? [] : ["discussion-executions"])]) {
          const directory = path.join(harness.workspaceRoot, "runs", run.id, "nodes", "creative-planning", directoryName);
          for (const name of (await readdir(directory)).filter(name => name.endsWith(".json"))) {
            const file = path.join(directory, name);
            await rename(file, `${file}.test-backup`);
            if (damage !== "missing") await writeFile(file, "{invalid isolated fixture", "utf8");
          }
        }
        harness.executor.release();
        const rebuilt = harness.buildPipeline();
        const recovered = await (await rebuilt.dispatchCreativeReviewCommand(run.id, body)).completion;
        assert.equal(fresh.mock.callCount(), callsBefore, `${damage}: 原命令不得重进新信封/提交入口`);
        assert.equal(prepare.mock.callCount(), prepareBefore);
        assert.equal(submit.mock.callCount(), submitBefore);
        assert.equal(harness.executor.submits, 1);
        assert.equal(recovered.status, "needs_human");
        assert.equal(recovered.creativeReviewOperations?.find(op => op.commandId === body.commandId)?.status, "unknown");
        assert.deepEqual(stageReview(recovered, "treatment").currentDocument, draftBefore);
        const studio = new ProductionStudio({ workspaceRoot: harness.workspaceRoot, pipeline: rebuilt,
          listProviders: async () => [], archiveStore: new JsonRunArchiveStore(path.join(harness.workspaceRoot, "archive.json")) });
        assert.equal((await studio.creativeReviewCommand(run.id, body.commandId))?.status, "unknown");
        assert.deepEqual((await studio.creativeReview(run.id))?.pendingConsultation?.allowedActions, ["edit_draft", "confirm", "return_to_stage"]);
        assert.match((await studio.creativeReview(run.id))?.reviewContinuation?.detail ?? "", /缺少可核.*不会重新发送/);
        const replay = await (await rebuilt.dispatchCreativeReviewCommand(run.id, body)).completion;
        assert.equal(replay.revision, recovered.revision, "同一缺证据查询不重复修改诊断或稿件");
        const document = { ...(draftBefore as Record<string, unknown>), payoff: "用户保留原成果后明确修改结尾" };
        const edited = await (await rebuilt.dispatchCreativeReviewCommand(run.id, { action: "edit_draft", commandId: `rf4-edit-${damage}`,
          actor: "creator", stage: "treatment", expectedRunRevision: recovered.revision,
          expectedReviewRevision: gateOf(recovered).continuation.reviewRevision, baseDraftSha256: gateOf(recovered).continuation.draftSha256,
          baseDraftVersionId: stageReview(recovered, "treatment").currentDraft!.versionId!, document })).completion;
        assert.equal(edited.status, "needs_human");
        assert.equal((stageReview(edited, "treatment").currentDocument as Record<string, unknown>).payoff, document.payoff);
        assert.equal(edited.creativeReviewOperations?.find(op => op.commandId === body.commandId)?.status, "unknown");
        assert.equal(fresh.mock.callCount(), callsBefore);
      } finally { fresh.mock.restore(); prepare.mock.restore(); submit.mock.restore(); harness.executor.release(); await harness.broker.close(); }
    }
  });

  it("C1-E prepared-save failure means zero external submit; rebuild after completion applies once", async () => {
    // 窗口1：提交前耐久保存失败 → 零外部提交，命令按 unknown 事实记录
    const harness = await startRecoveryHarness({ holdInitially: true });
    try {
      const pipeline = harness.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "treatment");
      const gate = gateOf(run).continuation;
      const preparedDir = path.join(harness.workspaceRoot, "runs", run.id, "nodes", "creative-planning", "discussion-prepared");
      await mkdir(path.dirname(preparedDir), { recursive: true });
      await writeFile(preparedDir, "not-a-directory", "utf8"); // 让 mkdir 失败＝保存失败
      const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
        action: "discuss", commandId: "c1e-save-fail", actor: "creator", stage: "treatment",
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, message: "C1-E 保存失败窗口",
      });
      const settled = await dispatched.completion;
      assert.equal(settled.status, "needs_human");
      assert.equal(harness.executor.submits, 0, "保存失败＝零外部提交");
      assert.equal(stageReview(settled, "treatment").continuation?.status, "unknown");
      assert.equal(settled.creativeReviewOperations?.find(op => op.commandId === "c1e-save-fail")?.status, "unknown");
    } finally {
      await harness.broker.close();
    }
    // 窗口3：远端完成但本地应用前重建服务 → 同 commandId 重放只观察、应用一次
    const harness2 = await startRecoveryHarness({ holdInitially: true });
    try {
      const pipeline = harness2.buildPipeline();
      let run = await pipeline.start(closureBrief({ creativeReview: true }));
      run = await confirmTo(pipeline, run, "treatment");
      const gate = gateOf(run).continuation;
      const body = {
        action: "discuss" as const, commandId: "c1e-rebuild", actor: "creator", stage: "treatment" as const,
        expectedRunRevision: run.revision, expectedReviewRevision: gate.reviewRevision,
        baseDraftSha256: gate.draftSha256, message: "C1-E 重建窗口",
      };
      const first = await (await pipeline.dispatchCreativeReviewCommand(run.id, body)).completion;
      assert.equal(harness2.executor.submits, 1);
      harness2.executor.release();
      const rebuilt = harness2.buildPipeline(); // 服务重建：同一持久 workspace/broker
      const replay = await (await rebuilt.dispatchCreativeReviewCommand(first.id, body)).completion;
      assert.equal(harness2.executor.submits, 1, "重建后重放零物理重发");
      const review = stageReview(replay, "treatment");
      assert.equal(review.continuation, null, "应用成功清诊断");
      assert.ok(review.messages.length >= 2);
      // 窗口4：结果已应用但响应丢失 → 再次重放回原结果，不重复应用
      const replay2 = await (await rebuilt.dispatchCreativeReviewCommand(replay.id, body)).completion;
      assert.equal(harness2.executor.submits, 1);
      assert.equal(stageReview(replay2, "treatment").messages.length, review.messages.length, "应用最多一次");
    } finally {
      await harness2.broker.close();
    }
  });

  it("C1-A retrieves the original result by observing the same physical request exactly once", async () => {
    for (const gateStage of ["treatment", "script", "director"] as const) {
      for (const action of ["discuss", "revise"] as const) {
        const harness = await startRecoveryHarness({ holdInitially: true });
        try {
          const pipeline = harness.buildPipeline();
          let run = await pipeline.start(closureBrief({ creativeReview: true }));
          run = await confirmTo(pipeline, run, gateStage);
          const gate = gateOf(run).continuation;
          const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
            action,
            commandId: `c1a-${gateStage}-${action}`,
            actor: "creator",
            stage: gateStage,
            expectedRunRevision: run.revision,
            expectedReviewRevision: gate.reviewRevision,
            baseDraftSha256: gate.draftSha256,
            message: `C1 原请求意见（${gateStage}/${action}）`,
          });
          let settled = await dispatched.completion;
          assert.equal(settled.status, "needs_human", `${gateStage}/${action} 超时后不失败`);
          let review = stageReview(settled, gateStage);
          assert.equal(harness.executor.submits, 1, `首次提交恰好一次物理请求；continuation=${JSON.stringify(review.continuation)}`);
          assert.equal(review.continuation?.status, "unknown", "超时归 unknown");
          const operation = settled.creativeReviewOperations?.find(op => op.commandId === `c1a-${gateStage}-${action}`);
          assert.equal(operation?.status, "unknown");

          // release 原物理请求后，同 ID 同 body 重放＝只观察原请求
          harness.executor.release();
          const replay = await pipeline.dispatchCreativeReviewCommand(settled.id, {
            action,
            commandId: `c1a-${gateStage}-${action}`,
            actor: "creator",
            stage: gateStage,
            expectedRunRevision: run.revision,
            expectedReviewRevision: gate.reviewRevision,
            baseDraftSha256: gate.draftSha256,
            message: `C1 原请求意见（${gateStage}/${action}）`,
          });
          const replayed = await replay.completion;
          assert.equal(harness.executor.submits, 1, `${gateStage}/${action} 恢复不得再次物理提交`);
          const replayNode = replayed.nodeRuns.find(candidate => candidate.nodeId === "creative-planning")!;
          assert.ok(replayNode.intervention?.continuation, `重放后必须仍有停点：status=${replayed.status} node=${replayNode.status} err=${replayNode.error ?? ""} output=${JSON.stringify(replayNode.output).slice(0, 200)}`);
          review = stageReview(replayed, gateStage);
          assert.equal(review.continuation, null, "应用后清诊断");
          assert.ok(review.messages.length >= 2, "原结果只应用一次：真实消息落账");
          const replayOperation = replayed.creativeReviewOperations?.find(op => op.commandId === `c1a-${gateStage}-${action}`);
          assert.equal(replayOperation?.status, "completed");
          assert.equal(replayOperation?.resultDisposition, "applied");
          if (action === "discuss") {
            assert.equal(review.currentDraft!.sha256, gate.draftSha256, "discuss 不换稿");
          } else {
            assert.notEqual(review.currentDraft!.sha256, gate.draftSha256, "revise 形成新未审稿");
          }
          // 再次重放：幂等回放，不重复应用
          const replay2 = await pipeline.dispatchCreativeReviewCommand(replayed.id, {
            action,
            commandId: `c1a-${gateStage}-${action}`,
            actor: "creator",
            stage: gateStage,
            expectedRunRevision: run.revision,
            expectedReviewRevision: gate.reviewRevision,
            baseDraftSha256: gate.draftSha256,
            message: `C1 原请求意见（${gateStage}/${action}）`,
          });
          const replayed2 = await replay2.completion;
          assert.equal(harness.executor.submits, 1, "重放不触发第三次物理请求");
          assert.equal(stageReview(replayed2, gateStage).messages.length, review.messages.length, "重复核对不重复应用");
        } finally {
          await harness.broker.close();
        }
      }
    }
  });
});
