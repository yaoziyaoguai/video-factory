import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ProductionPipeline, RoleAgentLoopError, contentSha256, type CreativeTreatmentAgentInput, type ProductionBrief, type ProductionPipelineOptions, type VisualAssetProviderCapability, type VisualDirectorAgentInput, type WorkerResponse } from "@video-factory/production-pipeline";
import { ProductionStudio, loadAgentLoopProgress } from "../src/server/production-studio.js";
import type { StudioRunDetail } from "../src/shared/api.js";

// ---------------------------------------------------------------------------
// joint-v1 planning stage DTO（只读投影）的行为测试。
// 全部走真实 ProductionPipeline（SQLite planning checkpoint + planning commit）
// + ProductionStudio.get() 详情装配；创作角色是本地替身，无真实外部调用。
// 每个 stage 对象字段必须精确为 id / status / effectiveModelId / artifactIds /
// issue / allowedActions（optional 字段缺省不出现）。
// ---------------------------------------------------------------------------

class PlanningStagesWorker {
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
    const jsonContent = capability === "video.render"
      ? JSON.stringify({ capability, font_resource: { family: "Fixture Sans", license_note: "Fixture font; rights not verified.", license_verified: false } })
      : JSON.stringify({ capability });
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

// 图库路线 worker：asset.search 输出真实 AssetCandidateReport JSON。
class PlanningStagesLibraryWorker extends PlanningStagesWorker {
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
          providerId: String((request.parameters as Record<string, unknown>).providerId),
          producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt),
          licenseNote: "Integration fixture.",
        },
      }],
    };
  }
}

interface PlanningSpies {
  treatmentCalls: number;
  screenwriterCalls: number;
  directorCalls: number;
  rankCalls: number;
}

const CREATIVE_DIMENSION_EVIDENCE: Record<string, string> = {
  attention: "前两秒给出具体问题。",
  progression: "中段有可辨认的推进。",
  payoff: "结尾兑现了承诺里的结论。",
  expression: "画面要求在当前素材能力内可落地。",
};

// 创作交付类角色的评估对象是整份候选（根路径 ""），维度由宿主固定为四维创作维度；
// 总分等于全部维度分的最低分，所以每维取同一个分数。
const CREATIVE_ASSESSMENTS = [{
  targetPath: "",
  dimensions: Object.entries(CREATIVE_DIMENSION_EVIDENCE).map(([dimension, evidence]) => ({ dimension, score: 92, evidence })),
}];

function planningAgents(
  spies: PlanningSpies,
  failure: { treatment?: boolean; screenwriter?: boolean } = {},
): Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent" | "assetSemanticRanker"> {
  return {
    treatmentAgents: [{
      providerId: "openai",
      agent: {
        id: "codex-creative-treatment-v1",
        modelId: "treatment-primary-model",
        treat: async () => {
          spies.treatmentCalls += 1;
          if (failure.treatment) throw new Error("构思审计失败：三轮未通过");
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
        },
      },
    }],
    screenwriterAgent: {
      id: "codex-screenwriter-v1",
      modelId: "screenwriter-primary-model",
      draftDetailed: async () => {
        spies.screenwriterCalls += 1;
        if (failure.screenwriter) throw new Error("稿件审计失败：三轮未通过");
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
          // 真实执行 trace：与首选绑定不同的实际模型（fallback 后），检视必须以它为准。
          trace: {
            taskKind: "script-draft" as const,
            promptVersion: "v1",
            prompt: "fixture prompt",
            providerId: "codex-screenwriter-v1",
            modelId: "screenwriter-fallback-actual-model",
          },
        };
      },
    },
    directorAgent: {
      id: "api-visual-director-v1",
      modelId: "director-primary-model",
      plan: async (input: VisualDirectorAgentInput) => {
        spies.directorCalls += 1;
        return {
          version: "video-factory/director-plan-v1",
          requestedProfileId: input.brief.requestedProfileId,
          resolvedProfileId: "documentary-observer",
          profileRationale: "用真实动作解释。",
          visualBible: {
            narrativeApproach: "逐步展示", pacing: "均匀", composition: "稳定中景",
            camera: "固定机位", color: "自然色", continuity: "同一时段", sound: "环境声",
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
    },
    assetSemanticRanker: {
      id: "codex-asset-ranker-v1",
      modelId: "ranker-primary-model",
      rank: async () => {
        throw new Error("joint-v1 rank adapter must use rankDetailed");
      },
      rankDetailed: async (report: { version: string; scenes: unknown[] }) => {
        spies.rankCalls += 1;
        return {
          output: {
            version: "video-factory/asset-ranking-v1",
            source: "model",
            providerId: "codex-asset-ranker-v1",
            modelId: "ranker-primary-model",
            summary: "语义排序完成",
            scenes: (report.scenes as Array<{ scenePosition: number; candidates: Array<{ provider: string; assetId: string }> }>).map((scene) => ({
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
        };
      },
    },
  };
}

function reviewCapablePlanningAgents(
  spies: PlanningSpies,
): Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent" | "assetSemanticRanker"> {
  const agents = planningAgents(spies);
  const treatmentAgent = agents.treatmentAgents?.[0]?.agent;
  assert.ok(treatmentAgent);
  treatmentAgent.treatDetailed = async (input: CreativeTreatmentAgentInput) => {
    if (input.creativeReviewExecution?.mode !== "check") {
      return {
        output: await treatmentAgent.treat(input),
        trace: {
          taskKind: "creative-treatment" as const,
          promptVersion: "fixture-v1",
          prompt: "fixture treatment draft",
          providerId: "openai",
          modelId: treatmentAgent.modelId,
        },
      };
    }
    const output = input.creativeReviewExecution.candidate;
    const audit = {
      version: "video-factory/role-audit-v2" as const,
      rubricVersion: "video-factory/role-quality-rubric-v1" as const,
      verdict: "pass" as const,
      score: 92,
      assessments: CREATIVE_ASSESSMENTS,
      summary: "当前构思可以确认。",
      issues: [],
      repairInstructions: [],
      planningDisposition: null,
      hostReadinessReview: null,
    };
    return {
      output,
      trace: {
        taskKind: "creative-treatment" as const,
        promptVersion: "fixture-v1",
        prompt: "fixture treatment check",
        providerId: "openai",
        modelId: treatmentAgent.modelId,
      },
      agentLoop: {
        version: "video-factory/agent-loop-v1" as const,
        role: "导演前期构思",
        contractVersion: "fixture-treatment-contract-v1",
        criteria: ["当前构思满足确认条件"],
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
            promptVersion: "fixture-v1",
            prompt: "fixture independent review",
            providerId: "fixture-audit",
            modelId: "fixture-audit-model",
          },
          audit,
        }],
      },
    };
  };
  return agents;
}

const PLANNING_ASSET_PROVIDERS: VisualAssetProviderCapability[] = [
  { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
  { id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
];

function planningBrief(overrides: { assetSemanticRank?: boolean; joint?: boolean; creativeReview?: boolean } = {}): ProductionBrief {
  const joint = overrides.joint ?? true;
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "joint-v1 规划阶段详情",
    angle: "一条规划链完成构思与导演",
    audience: "内容创作者",
    nicheSlug: "planning-stages",
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
      ...(joint ? { creativePlanning: "joint-v1" as const } : {}),
      ...(overrides.creativeReview ? { creativeReview: "user-confirmed-v1" as const } : {}),
    },
    director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1", "local-editorial-v1"] },
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  };
}

interface StudioHarness {
  studio: ProductionStudio;
  pipeline: ProductionPipeline;
}

function newPlanningStudio(
  workspaceRoot: string,
  worker: PlanningStagesWorker,
  agents: Pick<ProductionPipelineOptions, "treatmentAgents" | "screenwriterAgent" | "directorAgent" | "assetSemanticRanker">,
): StudioHarness {
  const pipeline = new ProductionPipeline({
    workspaceRoot,
    worker,
    ...agents,
    assetProviders: PLANNING_ASSET_PROVIDERS,
  });
  const studio = new ProductionStudio({
    workspaceRoot,
    pipeline,
    archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
    listProviders: async () => [],
  });
  return { studio, pipeline };
}

type StageRecord = NonNullable<StudioRunDetail["planningStages"]>[number];

async function planningStagesOf(studio: ProductionStudio, runId: string): Promise<StageRecord[] | undefined> {
  const detail = await studio.get(runId);
  assert.ok(detail, "the run detail must be readable");
  return detail.planningStages;
}

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeyOrder(entry)]),
  );
}

const STAGE_FIELD_NAMES = ["id", "status", "effectiveModelId", "providerId", "artifactIds", "decisionStatus", "reviewPurpose", "issue", "allowedActions"] as const;

// 字段合同：所有出现的键都必须属于六字段；键集合必须包含四个必填字段。
// optional（effectiveModelId / issue）缺省时不得以 undefined 键出现。
function assertStageShape(stage: StageRecord, context: string): void {
  const keys = Object.keys(stage);
  for (const key of keys) {
    assert.ok(
      (STAGE_FIELD_NAMES as readonly string[]).includes(key),
      `${context}: unexpected stage field '${key}' (${JSON.stringify(keys)})`,
    );
  }
  for (const required of ["id", "status", "artifactIds", "allowedActions"]) {
    assert.ok(keys.includes(required), `${context}: missing required stage field '${required}'`);
  }
  assert.ok(Array.isArray(stage.artifactIds), `${context}: artifactIds must be an array`);
  assert.ok(stage.artifactIds.every((id) => typeof id === "string"), `${context}: artifactIds must hold strings`);
}

describe("joint-v1 planning stage DTO (read-only projection)", () => {
  it("preserves an adopted, failed-check treatment across script model editing and process reconstruction", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-r11-adopt-carry-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const agents = reviewCapablePlanningAgents(spies);
    const agent = agents.treatmentAgents![0]!.agent;
    const original = agent.treatDetailed!.bind(agent);
    agent.treatDetailed = async (input) => {
      if (input.creativeReviewExecution?.mode === "check") throw new Error("构思独审请求合同被拒绝");
      assert.equal(input.brief.budgetIntentionCny, 35);
      return original(input);
    };
    agent.discussDetailed = async (input) => ({ trace: {
      taskKind: "creative-discussion", promptVersion: "fixture-v1", prompt: "fixture discussion",
      providerId: "openai", modelId: agent.modelId,
    }, output: {
      stage: "treatment", intent: "propose", reply: "提供另一种开场，采用前不会替换当前稿。",
      changeSummary: ["开场先展示结果"],
      treatment: { ...(input.currentDocument as Record<string, unknown>), payoff: "用结果对照收束，保留用户采用意见" },
      script: null, director: null, upstreamRequest: null,
    } });
    const { pipeline, studio } = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), agents);
    const input = { ...planningBrief({ creativeReview: true }), budgetIntentionCny: 35 };
    const run = await pipeline.start(input);
    const command = async (action: "discuss" | "adopt_proposal" | "confirm", extras: Record<string, unknown> = {}) => {
      const review = await studio.creativeReview(run.id);
      assert.ok(review);
      const dispatched = await pipeline.dispatchCreativeReviewCommand(run.id, {
        action, commandId: `r11-${action}`, actor: "creator", stage: review.stage,
        expectedRunRevision: review.runRevision, expectedReviewRevision: review.reviewRevision,
        baseDraftSha256: review.draftSha256, ...extras,
      } as Parameters<ProductionPipeline["dispatchCreativeReviewCommand"]>[1]);
      return dispatched.completion;
    };
    const discussed = await command("discuss", { message: "给一个不同开场，先不要替换" });
    assert.equal(discussed.status, "needs_human", JSON.stringify(discussed.nodeRuns.map((node) => ({ id: node.nodeId, error: node.error }))));
    const proposal = (await studio.creativeReview(run.id))!.proposals[0]!;
    await command("adopt_proposal", { proposalId: proposal.proposalId });
    const adopted = (await studio.creativeReview(run.id))!;
    const failed = await command("confirm");
    // F14/F17 契约：复核腿故障（此处为审计请求合同被拒，无任何裁决）不再是节点 failed，
    // 而是可恢复暂停——adopted 草稿与进度保留，等用户重试或修改。
    assert.equal(failed.status, "needs_human");
    const failedNode = failed.nodeRuns.find((node) => node.nodeId === "creative-planning")!;
    assert.equal((failed.creativeReviewOperations ?? []).at(-1)?.status, "completed", "确认命令正常完成：暂停是停点，不是命令失败");
    const stopDetail = failedNode.intervention?.stopDetail
      ?? (failedNode.output as { planningStop?: { detail?: string } } | undefined)?.planningStop?.detail
      ?? "";
    assert.match(stopDetail, /构思独审请求合同被拒绝/, "停点必须带上复核失败的原因");
    assert.equal((await pipeline.inspectCreativePlanningStages(run.id))?.find((stage) => stage.id === "treatment")?.status, "completed",
      "复核没跑成不是内容失败：adopted 草稿仍在，阶段不得标 failed");
    assert.equal((await pipeline.inspectCreativePlanningStages(run.id))?.find((stage) => stage.id === "treatment")?.decisionStatus, "waiting_user",
      "产物已生成不等于当前版本已经得到用户确认");
    await pipeline.applyNodeExecutionConfiguration(run.id, "creative-planning", {
      ...input, models: { ...input.models, [input.providers.script]: "different-script-model" },
    }, "creator", failed.revision);
    const reconstructed = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), agents);
    const resumed = await reconstructed.pipeline.resumeStale(run.id);
    assert.equal(resumed.status, "needs_human");
    const restored = (await reconstructed.studio.creativeReview(run.id))!;
    assert.equal(restored.draftSha256, adopted.draftSha256);
    assert.deepEqual(restored.draft, adopted.draft);
    assert.deepEqual(restored.messages, adopted.messages);
    assert.deepEqual(restored.effectiveUserInstructions, adopted.effectiveUserInstructions);
    assert.notEqual(restored.checkResult?.verdict, "pass");
    assert.equal(spies.treatmentCalls, 1);
    assert.equal(spies.screenwriterCalls, 0);
  });
  it("recovers an accepted creative confirmation from its persisted command without repeating the producer", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-creative-command-recovery-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), reviewCapablePlanningAgents(spies));
    const run = await harness.pipeline.start(planningBrief({ creativeReview: true }));
    const review = await harness.studio.creativeReview(run.id);
    assert.ok(review);
    const request = {
      action: "confirm" as const,
      commandId: "recover-confirm-treatment",
      actor: "creator",
      expectedRunRevision: review.runRevision,
      expectedReviewRevision: review.reviewRevision,
      stage: review.stage,
      baseDraftSha256: review.draftSha256,
    };
    const resume = {
      action: "confirm" as const,
      stage: request.stage,
      commandId: request.commandId,
      actor: request.actor,
      baseDraftSha256: request.baseDraftSha256,
      expectedReviewRevision: request.expectedReviewRevision,
      checkIdentity: contentSha256({
        runId: run.id,
        stage: request.stage,
        draftSha256: request.baseDraftSha256,
        reviewRevision: request.expectedReviewRevision,
        contract: "creative-review-confirm-v1",
      }),
      confirmedAt: "2026-09-14T08:00:00.000Z",
    };
    const interrupted = await harness.pipeline.loadPersisted(run.id);
    interrupted.status = "running";
    delete interrupted.finishedAt;
    interrupted.interventions = [];
    interrupted.creativeReviewOperations = [{
      commandId: request.commandId,
      requestDigest: contentSha256(request),
      action: request.action,
      stage: request.stage,
      status: "running",
      acceptedAt: "2026-09-14T08:00:00.000Z",
      request,
      resume,
    }];
    interrupted.nodeRuns = interrupted.nodeRuns.map((node) => node.nodeId === "creative-planning"
      ? {
          ...node,
          status: "running",
          output: { continuationOperation: { commandId: request.commandId, action: request.action, status: "running" } },
          intervention: undefined,
        }
      : node);
    await writeFile(
      path.join(workspaceRoot, "runs", run.id, "run.json"),
      `${JSON.stringify(interrupted, null, 2)}\n`,
    );

    assert.equal(await harness.pipeline.recoverInterruptedRuns(), 1);
    let recovered = await harness.pipeline.show(run.id);
    for (let attempt = 0; attempt < 100 && (
      recovered.status === "running"
      || recovered.creativeReviewOperations?.find((operation) => operation.commandId === request.commandId)?.status === "running"
    ); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      recovered = await harness.pipeline.show(run.id);
    }
    const nextReview = await harness.studio.creativeReview(run.id);
    assert.equal(nextReview?.stage, "script");
    assert.equal(spies.treatmentCalls, 1, "the saved treatment draft must not be regenerated");
    assert.equal(spies.screenwriterCalls, 1, "the recovered confirmation advances exactly once");
    assert.equal(
      recovered.creativeReviewOperations?.find((operation) => operation.commandId === request.commandId)?.status,
      "completed",
    );
  });

  it("replays a completed creative command through ProductionStudio without re-running the role", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-studio-command-replay-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), reviewCapablePlanningAgents(spies));
    const run = await harness.pipeline.start(planningBrief({ creativeReview: true }));
    const review = await harness.studio.creativeReview(run.id);
    assert.ok(review);
    const command = {
      action: "confirm" as const,
      commandId: "studio-confirm-replay",
      expectedRunRevision: review.runRevision,
      expectedReviewRevision: review.reviewRevision,
      stage: review.stage,
      baseDraftSha256: review.draftSha256,
    };

    await harness.studio.commandCreativeReview(run.id, command, "creator");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const receipt = await harness.studio.creativeReviewCommand(run.id, command.commandId);
      if (receipt?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(
      (await harness.studio.creativeReviewCommand(run.id, command.commandId))?.status,
      "completed",
      JSON.stringify((await harness.pipeline.show(run.id)).nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))),
    );
    const screenwriterCallsAfterCompletion = spies.screenwriterCalls;

    const replay = await harness.studio.commandCreativeReview(run.id, command, "creator");
    assert.equal(replay.status, "completed");
    assert.equal(spies.screenwriterCalls, screenwriterCallsAfterCompletion);
    await assert.rejects(
      () => harness.studio.commandCreativeReview(run.id, command, "another-creator"),
      /当前方案已经更新/,
    );
  });

  it("marks only checkpoint-completed stages as completed when a mid-chain role fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-fail-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies, { treatment: true }));
    const run = await harness.pipeline.start(planningBrief());
    assert.equal(run.status, "failed", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const stages = await planningStagesOf(harness.studio, run.id);

    assert.ok(stages, "failed joint-v1 runs must still expose planning stages");
    assert.deepEqual(stages.map((stage) => stage.id), ["treatment", "script", "director", "compile"]);
    const [treatment, script, director, compile] = stages;
    assert.equal(treatment?.status, "failed");
    assert.match(treatment?.issue ?? "", /构思审计失败/);
    assert.equal(script?.status, "pending");
    assert.equal(director?.status, "pending");
    assert.equal(compile?.status, "pending");
    for (const stage of stages) {
      assertStageShape(stage, "treatment failure");
      assert.deepEqual(stage.artifactIds, [], "in-progress planning must not expose formal artifact ids");
    }
    assert.equal(script?.issue, undefined, "the top-level failure must not be copied onto later stages");
    assert.equal(director?.issue, undefined);
    assert.equal(compile?.issue, undefined);
  });

  it("keeps earlier checkpoint evidence completed when the screenwriter role fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-script-fail-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies, { screenwriter: true }));
    const run = await harness.pipeline.start(planningBrief());
    assert.equal(run.status, "failed", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    const stages = await planningStagesOf(harness.studio, run.id);

    assert.ok(stages);
    assert.deepEqual(stages.map((stage) => stage.id), ["treatment", "script", "director", "compile"]);
    assert.equal(stages[0]?.status, "completed", "the treatment artifact lives in the checkpoint and must read back completed");
    assert.equal(stages[0]?.artifactIds.length, 0, "treatment has no formal committed artifact");
    assert.equal(stages[1]?.status, "failed");
    assert.match(stages[1]?.issue ?? "", /稿件审计失败/);
    assert.equal(stages[2]?.status, "pending");
    assert.equal(stages[3]?.status, "pending");
  });

  it("projects the running stage from the checkpoint cursor when the node was interrupted", async () => {    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-interrupted-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies, { screenwriter: true }));
    const run = await harness.pipeline.start(planningBrief());

    // 受控改写 run.json：模拟进程中断——planning 节点仍处于 running（无失败终态），
    // SQLite checkpoint 停在 script 节点之前。
    const runJsonPath = path.join(workspaceRoot, "runs", run.id, "run.json");
    const payload = JSON.parse(await readFile(runJsonPath, "utf8")) as {
      nodeRuns: Array<{ nodeId: string; status: string; error?: string }>;
    };
    const planningNode = payload.nodeRuns.find((node) => node.nodeId === "creative-planning");
    assert.ok(planningNode, "the persisted run must contain the creative-planning node");
    planningNode.status = "running";
    delete planningNode.error;
    await writeFile(runJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

    const stages = await planningStagesOf(harness.studio, run.id);
    assert.ok(stages);
    assert.equal(stages[0]?.status, "completed");
    assert.equal(stages[1]?.status, "running", "the checkpoint cursor names script as the next node");
    assert.equal(stages[2]?.status, "pending");
    assert.equal(stages[3]?.status, "pending");
  });

  it("does not show every stage completed when the graph finished but formal publication failed", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-publication-failed-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies));
    const run = await harness.pipeline.start(planningBrief());
    assert.equal(run.status, "needs_human");

    // 受控改写 run.json：图已完成（全部阶段产物在 checkpoint），但正式发布失败——
    // planning 节点以 failed 结束。用户看到的状态必须暴露失败，而不是全部 completed。
    const runJsonPath = path.join(workspaceRoot, "runs", run.id, "run.json");
    const payload = JSON.parse(await readFile(runJsonPath, "utf8")) as {
      status: string;
      nodeRuns: Array<{ nodeId: string; status: string; error?: string }>;
    };
    const planningNode = payload.nodeRuns.find((node) => node.nodeId === "creative-planning");
    assert.ok(planningNode);
    planningNode.status = "failed";
    planningNode.error = "simulated publication failure after the planning graph completed";
    payload.status = "failed";
    await writeFile(runJsonPath, `${JSON.stringify(payload, null, 2)}\n`);

    const stages = await planningStagesOf(harness.studio, run.id);
    assert.ok(stages);
    assert.deepEqual(stages.map((stage) => stage.id), ["treatment", "script", "director", "compile"]);
    assert.equal(stages[0]?.status, "completed");
    assert.equal(stages[1]?.status, "completed");
    assert.equal(stages[2]?.status, "completed");
    assert.equal(stages[3]?.status, "failed", "the publication failure must surface on the formal plan stage");
    assert.match(
      stages[3]?.issue ?? "",
      /simulated publication failure/,
      "the failed stage must carry the actionable failure instead of hiding it behind completed stages",
    );
    for (const stage of stages) {
      assert.equal(stage.artifactIds.length, 0, "an uncommitted plan must not expose formal artifact ids");
    }
  });

  it("reports every real library-route stage with committed artifacts after completion", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-library-done-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesLibraryWorker(), planningAgents(spies));
    const run = await harness.pipeline.start(planningBrief({ assetSemanticRank: true }));
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    const detail = await harness.studio.get(run.id);
    assert.ok(detail);
    const stages = detail.planningStages;
    assert.ok(stages, "a completed joint-v1 run must expose planning stages");
    assert.deepEqual(
      stages.map((stage) => stage.id),
      ["treatment", "script", "director", "candidates", "rank", "integrate", "compile"],
    );
    for (const stage of stages) {
      assertStageShape(stage, `library route ${stage.id}`);
      assert.equal(stage.status, "completed", `stage ${stage.id} must be completed`);
      assert.equal(stage.issue, undefined, `stage ${stage.id} must not carry an issue after success`);
    }
    // 正式 artifactIds 映射到 planning commit 绑定的 run 正式产物。
    const artifactIdOfKind = (kind: string) => {
      const matches = run.artifacts.filter((artifact) => artifact.producer?.nodeId === "creative-planning" && artifact.kind === kind);
      assert.equal(matches.length, 1, `exactly one formal ${kind} artifact must exist`);
      return matches[0]!.id;
    };
    assert.deepEqual(stages.find((stage) => stage.id === "script")?.artifactIds, [artifactIdOfKind("script")]);
    assert.deepEqual(stages.find((stage) => stage.id === "director")?.artifactIds, [artifactIdOfKind("storyboard")]);
    assert.deepEqual(stages.find((stage) => stage.id === "candidates")?.artifactIds, [artifactIdOfKind("asset_candidates")]);
    assert.deepEqual(stages.find((stage) => stage.id === "rank")?.artifactIds, [artifactIdOfKind("asset_ranking")]);
    assert.deepEqual(stages.find((stage) => stage.id === "integrate")?.artifactIds, [artifactIdOfKind("storyboard")]);
    assert.deepEqual(stages.find((stage) => stage.id === "compile")?.artifactIds, [artifactIdOfKind("executable_plan")]);
    // treatment 已是正式登记的创作产物：阶段投影必须给出唯一正式 artifact，而不是空数组。
    assert.deepEqual(stages.find((stage) => stage.id === "treatment")?.artifactIds, [artifactIdOfKind("creative_treatment")]);
    // effectiveModelId 来源诚实合同：已执行阶段只显示真实执行 trace（含 fallback 后的实际
    // 模型）——替身导演用无 trace 的 plan()，来源未知即不显示，不得用首选绑定冒充；
    // pending/running 阶段才显示当前绑定。
    assert.equal(stages.find((stage) => stage.id === "treatment")?.effectiveModelId, "treatment-primary-model");
    assert.equal(stages.find((stage) => stage.id === "script")?.effectiveModelId, "screenwriter-fallback-actual-model");
    // 已执行模型阶段来源未知时显式 unknown（不用首选绑定冒充，也不沉默隐藏）。
    assert.equal(stages.find((stage) => stage.id === "director")?.effectiveModelId, "unknown", "a completed model stage without an execution trace must report unknown provenance");
    assert.equal(stages.find((stage) => stage.id === "rank")?.effectiveModelId, "unknown", "rank without an execution trace must report unknown provenance");
    assert.equal(stages.find((stage) => stage.id === "candidates")?.effectiveModelId, undefined, "candidate search runs no model");
    assert.equal(stages.find((stage) => stage.id === "integrate")?.effectiveModelId, undefined, "deterministic integrate runs no model");
    assert.equal(stages.find((stage) => stage.id === "compile")?.effectiveModelId, undefined, "deterministic compile runs no model");
    // allowedActions：可编辑创作角色 vs 只读阶段；treatment 有正式产物，同样可查看。
    assert.deepEqual(stages.find((stage) => stage.id === "treatment")?.allowedActions, ["edit_input", "change_model", "view_artifacts"]);
    assert.deepEqual(stages.find((stage) => stage.id === "script")?.allowedActions, ["edit_input", "change_model", "view_artifacts"]);
    assert.deepEqual(stages.find((stage) => stage.id === "director")?.allowedActions, ["edit_input", "change_model", "view_artifacts"]);
    assert.deepEqual(stages.find((stage) => stage.id === "candidates")?.allowedActions, ["view_artifacts"]);
    assert.deepEqual(stages.find((stage) => stage.id === "rank")?.allowedActions, ["view_artifacts"]);
    assert.deepEqual(stages.find((stage) => stage.id === "integrate")?.allowedActions, ["view_artifacts"]);
    assert.deepEqual(stages.find((stage) => stage.id === "compile")?.allowedActions, ["view_artifacts"]);
    // 详情对象不泄露托管绝对路径。
    const serialized = JSON.stringify(detail.planningStages);
    assert.equal(serialized.includes(workspaceRoot), false, "planning stages must not leak managed absolute paths");
  });

  it("omits library-only stages on the fixed route without fabricating artifacts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-fixed-done-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies));
    const run = await harness.pipeline.start(planningBrief());
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    const stages = await planningStagesOf(harness.studio, run.id);
    assert.ok(stages);
    assert.deepEqual(stages.map((stage) => stage.id), ["treatment", "script", "director", "compile"]);
    assert.equal(spies.rankCalls, 0);
    for (const stage of stages) {
      assert.equal(stage.status, "completed");
      assertStageShape(stage, `fixed route ${stage.id}`);
      for (const artifactId of stage.artifactIds) {
        const matches = run.artifacts.filter((artifact) => artifact.id === artifactId);
        assert.equal(matches.length, 1, `stage ${stage.id} artifact must map to a registered run artifact`);
        assert.equal(
          matches[0]!.kind === "asset_candidates" || matches[0]!.kind === "asset_ranking",
          false,
          "the fixed route must not fabricate candidate artifacts",
        );
      }
    }
  });

  it("keeps legacy runs without planning stages", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-legacy-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies));
    const run = await harness.pipeline.start(planningBrief({ joint: false }));
    assert.equal(run.status, "needs_human", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));

    const detail = await harness.studio.get(run.id);
    assert.ok(detail);
    assert.equal(detail.planningStages, undefined, "legacy runs have no joint-v1 planning stages to project");
  });

  it("does not show the previous thread's completion after the effective input digest changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-digest-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies));
    const run = await harness.pipeline.start(planningBrief());
    assert.equal(run.status, "needs_human");
    const completed = await planningStagesOf(harness.studio, run.id);
    assert.ok(completed?.every((stage) => stage.status === "completed"));

    const planningInputState = run.nodeRuns.find((node) => node.nodeId === "creative-planning")?.inputState;
    const originalInput = planningInputState?.versions
      .find((version) => version.id === planningInputState.effectiveVersionId)?.value as { brief: ProductionBrief };
    assert.ok(originalInput);
    const currentRun = await harness.pipeline.loadPersisted(run.id);
    await harness.pipeline.applyNodeInputOverride(run.id, {
      nodeId: "creative-planning",
      actor: "producer",
      expectedRunRevision: currentRun.revision,
      expectedVersionId: planningInputState!.effectiveVersionId,
      input: { brief: { ...originalInput.brief, title: "改题后的规划阶段详情" } },
      allowTerminalEdit: true,
    });

    const stages = await planningStagesOf(harness.studio, run.id);
    assert.ok(stages, "the overridden run still exposes stages for its current effective input");
    for (const stage of stages) {
      assert.equal(stage.status, "pending", `stage ${stage.id} must not inherit the previous thread's completion`);
      assert.deepEqual(stage.artifactIds, [], `stage ${stage.id} must not inherit the previous thread's artifacts`);
    }
  });

  it("keeps the same planning thread and completed stages when only JSON field order changes across a restart", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-key-order-"));
    const firstSpies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const first = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(firstSpies));
    const run = await first.pipeline.start(planningBrief());
    assert.equal(run.status, "needs_human");
    assert.deepEqual(firstSpies, { treatmentCalls: 1, screenwriterCalls: 1, directorCalls: 1, rankCalls: 0 });

    const before = await first.studio.get(run.id);
    assert.ok(before);
    const planning = before.nodes.find((node) => node.id === "creative-planning");
    assert.ok(planning?.inputState);
    const currentInput = planning.inputState.versions.find((version) => version.id === planning.inputState?.effectiveVersionId)?.value;
    assert.ok(currentInput);
    await first.studio.applyNodeInputOverride(run.id, "creative-planning", {
      input: reverseObjectKeyOrder(currentInput),
      expectedRunRevision: before.revision,
      expectedVersionId: planning.inputState.effectiveVersionId,
      planningStageId: "treatment",
    }, "producer");

    const rebuiltSpies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const rebuilt = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(rebuiltSpies));
    const stagesAfterRestart = await planningStagesOf(rebuilt.studio, run.id);
    assert.ok(stagesAfterRestart?.every((stage) => stage.status === "completed"), JSON.stringify(stagesAfterRestart));

    const unchanged = await rebuilt.pipeline.loadPersisted(run.id);
    assert.equal(unchanged.status, "needs_human", "an order-only edit is a no-op and must not create stale work");
    assert.deepEqual(
      rebuiltSpies,
      { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 },
      "field ordering alone must not create another planning execution after restart",
    );
  });

  it("fails closed on missing, corrupted, or foreign planning checkpoints", async () => {
    // 三个子场景各自使用独立 mkdtemp：同一 workspace 里多个 ProductionPipeline 共享
    // planning SQLite，一旦写入损坏存储，后续 run 的规划执行会在打开存储时直接失败——
    // 这是夹具串扰而非被测行为，隔离后各子场景语义不变。
    // (1) planning 未启动：上游 reference-grammar 角色轮次耗尽（RoleAgentLoopError 不降级），
    // creative-planning 无 inputState、无 checkpoint。
    {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-failclosed-missing-"));
      const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
      const referenceRoot = path.join(workspaceRoot, "uploads", "reference-videos");
      const uploadId = "11111111-2222-3333-4444-555555555555";
      const sourcePath = path.join(referenceRoot, uploadId, "source.mp4");
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, "reference-video");
      const pipeline = new ProductionPipeline({
        workspaceRoot,
        worker: new PlanningStagesWorker(),
        ...planningAgents(spies),
        referenceVideoRoot: referenceRoot,
        referenceGrammarAgent: {
          id: "codex-reference-grammar-v1",
          modelId: "codex-default",
          analyze: async () => { throw new Error("multimodal service unavailable"); },
          analyzeDetailed: async () => {
            // 普通错误会被受控回退语法吞掉；只有角色轮次耗尽才让节点真实失败，
            // 从而构造出 planning 从未启动的真实上游失败路径。
            throw new RoleAgentLoopError("参考视频分析三轮审计未通过", {
              version: "video-factory/agent-loop-v1",
              role: "参考视频分析",
              contractVersion: "video-factory/reference-grammar-agent-v1",
              criteria: [],
              status: "failed",
              maxIterations: 3,
              iterations: [],
            });
          },
        },
        assetProviders: PLANNING_ASSET_PROVIDERS,
      });
      const studio = new ProductionStudio({
        workspaceRoot,
        pipeline,
        archiveStore: { list: async () => [], add: async () => {}, remove: async () => {} },
        listProviders: async () => [],
      });
      const run = await pipeline.start({
        ...planningBrief(),
        workflowFeatures: { assetSemanticRank: false, referenceGrammar: true, executablePlan: true, creativePlanning: "joint-v1" as const },
        referenceVideo: {
          uploadId, label: "参考节奏.mp4", mimeType: "video/mp4", sizeBytes: 15, path: sourcePath,
          sha256: createHash("sha256").update("reference-video").digest("hex"),
        },
      });
      assert.equal(run.status, "failed", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
      const stages = await planningStagesOf(studio, run.id);
      assert.ok(stages, "joint-v1 runs expose their route stages even before planning started");
      for (const stage of stages) {
        assert.equal(stage.status, "pending", `stage ${stage.id} must stay pending without a checkpoint`);
        assert.deepEqual(stage.artifactIds, []);
      }
      assert.equal(
        spies.treatmentCalls + spies.screenwriterCalls + spies.directorCalls + spies.rankCalls,
        0,
        "inspection and the failed upstream must not invoke any creative role",
      );
    }

    // (2) 错 run：复制一个成功 run 的目录为另一 runId，不得展示原 run 的完成状态。
    {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-failclosed-forged-"));
      const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
      const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies));
      const run = await harness.pipeline.start(planningBrief());
      assert.equal(run.status, "needs_human");
      const forgedRunId = `${run.id}-forged`;
      await cp(path.join(workspaceRoot, "runs", run.id), path.join(workspaceRoot, "runs", forgedRunId), { recursive: true });
      const runJsonPath = path.join(workspaceRoot, "runs", forgedRunId, "run.json");
      const payload = JSON.parse(await readFile(runJsonPath, "utf8")) as { id: string };
      payload.id = forgedRunId;
      await writeFile(runJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
      const stages = await planningStagesOf(harness.studio, forgedRunId);
      assert.ok(stages, "the copied run still declares the joint-v1 route");
      for (const stage of stages) {
        assert.equal(stage.status, "pending", `stage ${stage.id} must not display the source run's completion`);
        assert.deepEqual(stage.artifactIds, []);
      }
    }

    // (3) SQLite checkpoint 损坏：详情不得 throw，也不得伪造阶段状态。
    {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-failclosed-corrupt-"));
      const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
      const harness = newPlanningStudio(workspaceRoot, new PlanningStagesWorker(), planningAgents(spies));
      const run = await harness.pipeline.start(planningBrief());
      assert.equal(run.status, "needs_human");
      const beforeCalls = { ...spies };
      const sqlitePath = path.join(workspaceRoot, "planning", "checkpoints.sqlite");
      await writeFile(sqlitePath, "this is not a sqlite database");
      const detail = await harness.studio.get(run.id);
      assert.ok(detail, "a corrupted planning checkpoint must not break the run detail");
      assert.equal(detail.planningStages, undefined, "a corrupted planning checkpoint must fail closed without fabricated stages");
      assert.deepEqual(
        { treatmentCalls: spies.treatmentCalls, screenwriterCalls: spies.screenwriterCalls, directorCalls: spies.directorCalls, rankCalls: spies.rankCalls },
        beforeCalls,
        "inspection must never invoke creative roles",
      );
    }
  });

  it("prefers the digest-bound executed model trace and still reads v7 loop progress", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-stage-v7-"));
    const spies: PlanningSpies = { treatmentCalls: 0, screenwriterCalls: 0, directorCalls: 0, rankCalls: 0 };
    const harness = newPlanningStudio(workspaceRoot, new PlanningStagesLibraryWorker(), planningAgents(spies));
    const run = await harness.pipeline.start(planningBrief({ assetSemanticRank: true }));
    assert.equal(run.status, "needs_human");

    // 编剧替身经真实执行路径带回 fallback 后的实际模型 trace；规划阶段的 effectiveModelId
    // 必须以它为准，而不是首选绑定。
    const stages = await planningStagesOf(harness.studio, run.id);
    assert.ok(stages);
    const script = stages.find((stage) => stage.id === "script");
    assert.ok(script);
    assert.equal(
      script.effectiveModelId,
      "screenwriter-fallback-actual-model",
      "the executed role trace wins over the preferred binding, including after fallback",
    );
    for (const stage of stages) assertStageShape(stage, `v7 route ${stage.id}`);

    // 与当前 inputDigest 无关的 v7 checkpoint（别的 thread 的旧执行）不得冒充当前 trace。
    const checkpointDir = path.join(workspaceRoot, "runs", run.id, "nodes", "creative-planning", "agent-loop-checkpoints");
    await mkdir(checkpointDir, { recursive: true });
    const v7Checkpoint = {
      version: "video-factory/agent-loop-checkpoint-v7",
      key: "fixture-key",
      contractDigest: "fixture-digest",
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
          prompt: "fixture prompt",
          providerId: "codex-screenwriter-v1",
          modelId: "planted-stale-model",
          fallbackFromModelId: "screenwriter-primary-model",
        },
        audit: { verdict: "pass", score: 88, summary: "结构完整" },
      }],
      operationGenerations: {},
      failedOperationRequestIds: {},
      attemptedRequestIds: [],
      sessions: {},
      phaseAttempts: { produce: 1, audit: 1 },
      phaseDurationsMs: { produce: 10, audit: 10 },
      validationMs: 1,
      retriedRequestIds: [],
      recoveryOwner: {
        runId: run.id,
        nodeId: "final-review",
        workflowOperationRequestId: "operation-v7-fixture",
      },
    };
    await writeFile(path.join(checkpointDir, "fixture-screenwriter.json"), `${JSON.stringify(v7Checkpoint, null, 2)}\n`);
    const stagesAfterPlant = await planningStagesOf(harness.studio, run.id);
    assert.equal(
      stagesAfterPlant?.find((stage) => stage.id === "script")?.effectiveModelId,
      "screenwriter-fallback-actual-model",
      "planted v7 checkpoints from other digests must not masquerade as the current execution trace",
    );

    // Studio 的既有 agent loop 进度展示同样要能读 v7。
    await mkdir(path.join(workspaceRoot, "runs", run.id, "nodes", "final-review", "agent-loop-checkpoints"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "runs", run.id, "nodes", "final-review", "agent-loop-checkpoints", "fixture.json"),
      `${JSON.stringify(v7Checkpoint, null, 2)}\n`,
    );
    const progress = await loadAgentLoopProgress(workspaceRoot, run.id, "final-review", "operation-v7-fixture");
    assert.ok(progress, "v7 checkpoints must be readable by the studio loop progress loader");
    assert.equal(progress.phase, "passed");
    assert.equal(progress.iteration, 1);
    assert.equal(progress.maxIterations, 3);
    assert.equal(progress.latestAudit?.score, 88);
  });
});
