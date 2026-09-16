import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DurationRange } from "../src/executable-timeline.js";
import { compileExecutableProductionPlan, parseExecutableProductionPlan } from "../src/executable-production-plan.js";
import type { CreativeTreatment } from "../src/creative-treatment.js";
import type { ScriptDraft } from "../src/codex-screenwriter.js";
import type { VisualDirectorPlan } from "../src/visual-director.js";
import { assetReuseSourceScenePosition } from "../src/generative-asset-worker.js";
import type { AssetCandidateReport, AssetSemanticRanking } from "../src/asset-semantic-ranker.js";
import type { ExecutableProductionPlan } from "../src/executable-production-plan.js";
import {
  AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM,
  candidateSearchFingerprint,
  createCreativePlanningGraph,
  defaultAvailabilityReviewer,
  executablePlanCompilePort,
  MAX_CROSS_ROLE_REVISIONS,
  planningIssueDigest,
  planningSourceAdvisories,
  runCreativePlanning,
  type AvailabilityReviewer,
  type CreateCreativePlanningGraphOptions,
  type CreativePlanningContext,
  type CreativePlanningInput,
  type CreativePlanningPorts,
  type CreativePlanningRunOutcome,
  type PlanningArtifact,
  type PlanningGraphState,
  type PlanningIssue,
} from "../src/creative-planning.js";
import {
  CreativePlanningStore,
  planningCheckpointSqlitePath,
  planningThreadId,
} from "../src/creative-planning-store.js";
import { runRoleAgentLoop } from "../src/role-agent-loop.js";

// B3 固定创作规划图：固定拓扑、责任路由、有界回退、SQLite checkpoint 恢复与付费边界。
// 全部使用注入的 spy port 与确定性 fixture，不调用任何真实模型或付费服务。

const DURATION_RANGE: DurationRange = { minSeconds: 20, maxSeconds: 34 };
const RUN_ID = "run-b3-graph";
const INPUT_DIGEST = "b3-accepted-input-digest-0001";

// ---------------------------------------------------------------------------
// 确定性 fixture
// ---------------------------------------------------------------------------

function treatmentFixture(): CreativeTreatment {
  return {
    version: "video-factory/creative-treatment-v2",
    viewerPromise: "看完能掌握测试主题的三个要点",
    hook: { narrationIntent: "直接抛出问题", visualIntent: "对比画面开场" },
    progression: [
      { beatId: "beat-1", purpose: "建立问题", viewerGain: "知道要解决什么" },
      { beatId: "beat-2", purpose: "展开方法", viewerGain: "掌握关键步骤" },
      { beatId: "beat-3", purpose: "兑现结论", viewerGain: "得到可行动的结论" },
    ],
    payoff: "回顾三个要点并给出行动建议",
    visualPrinciples: ["真实场景优先"],
    soundPrinciples: ["环境声为主"],
    evidenceRequirements: [],
    feasibilityQuestions: [],
  };
}

function scriptFixture(): ScriptDraft {
  return {
    viewerPromise: "看完能掌握测试主题的三个要点",
    narrativeArc: "问题-方法-结论",
    canonFacts: [],
    scenes: [1, 2, 3].map((position) => ({
      position,
      purpose: `第${position}段`,
      narration: `第${position}段旁白内容`,
      duration: 8,
      visual_strategy: "stock",
      visual_prompt: `第${position}段画面`,
      search_terms: [`term-${position}`],
    })),
  };
}

function directorPlanFixture(
  options?: { sceneTwoQuery?: string; sceneThreeDeliveryType?: "generated_video" },
): VisualDirectorPlan {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "documentary-observer",
    resolvedProfileId: "documentary-observer",
    profileRationale: "测试固定档案",
    visualBible: {
      narrativeApproach: "观察式",
      pacing: "克制推进",
      composition: "中景与细节交替",
      camera: "自然光轻微手持",
      color: "自然色",
      continuity: "场景连贯",
      sound: "环境声优先",
    },
    shots: [1, 2, 3].map((position) => ({
      scenePosition: position,
      narrativeRole: position === 2 ? "关键证据" : "主镜头",
      authenticityPolicy: "illustrative" as const,
      preferredProviderId: "stock-free",
      deliveryType: (position === 3 ? options?.sceneThreeDeliveryType ?? "stock_video" : "stock_video") as "stock_video" | "generated_video",
      alternativeProviderIds: [],
      query: position === 2 ? options?.sceneTwoQuery ?? "stock-query-2" : `stock-query-${position}`,
      generationPrompt: `第${position}镜生成提示`,
      rationale: "测试",
      continuityNote: "测试",
      confidence: 0.8,
      estimatedCostCny: 0,
      temporalBeats: [{ startSeconds: 0, endSeconds: 8, action: "推进画面" }],
    })),
  };
}

// 第二版稿件：第 2 段画面语义变化（旁白与画面提示），用于证明排序证据必须跟随语义输入身份。
function scriptV2Fixture(): ScriptDraft {
  const script = scriptFixture();
  const sceneTwo = script.scenes[1]!;
  sceneTwo.narration = "第2段旁白内容（v2：证据口径已改）";
  sceneTwo.visual_prompt = "第2段新画面语义（v2）";
  return script;
}

// 仅改写说明字段的重修导演方案：检索词、交付类型与 Provider 路由保持不变（候选获取身份未变），
// 但方案内容 digest 变化（排序实际输入已变）。
function reworkedRationalePlan(): VisualDirectorPlan {
  const plan = directorPlanFixture();
  plan.shots = plan.shots.map((shot) => ({ ...shot, rationale: `重修后画面说明：${shot.rationale}` }));
  return plan;
}

// 合法复用方案：第 2 镜复用第 1 镜母片（更早镜头、stock 母片有可自动采用的候选）。
// 复用镜头自身的 deliveryType 仍是 stock_video、检索词与 Provider 不变——生产 Python 搜索
// 对复用镜头跳过搜索并保留空候选报告行（stock_assets.py search_routed_scene_asset_candidates）。
function reuseDirectorPlanFixture(): VisualDirectorPlan {
  const plan = directorPlanFixture();
  plan.shots[1]!.reuseFromScenePosition = 1;
  return plan;
}

// 复用根变体：第 3 镜在 v1 是独立 stock 镜头、在 v2 改为复用第 1 镜母片；同时改写第 1 镜
// camera 字段作为导演按反馈的真实修复（camera 不进入 stock 检索身份，但会改变排序实际输入）。
function cameraReusePlanFixture(reuseSceneThree: boolean): VisualDirectorPlan {
  const plan = directorPlanFixture();
  plan.shots[0]!.camera = reuseSceneThree ? "横移跟随" : "固定机位";
  if (reuseSceneThree) {
    plan.shots[2]!.reuseFromScenePosition = 1;
  }
  return plan;
}

// 复用表达形式变体：第 2 镜复用第 1 镜（stock 母片）同一复用关系的三种表达——显式字段、
// query 前缀数字编码、query 前缀英文词形编码（生产端 assetReuseSourceScenePosition 同形合法）。
type ReuseForm = "explicit" | "query-numeric" | "query-word";

function reuseFormPlanFixture(form: ReuseForm): VisualDirectorPlan {
  const plan = directorPlanFixture();
  const shotTwo = plan.shots[1]!;
  if (form === "explicit") {
    shotTwo.reuseFromScenePosition = 1;
  } else {
    shotTwo.query = form === "query-numeric"
      ? "REUSE_ONLY scene 1 stock-query-2"
      : "REUSE_ONLY scene one stock-query-2";
  }
  shotTwo.sourceInSeconds = 4;
  return plan;
}

// 显式字段与 query 编码同时存在（同值冗余）：整合删除冗余显式字段后复用关系仍由 query 承载。
function reuseExplicitWithQueryPlanFixture(): VisualDirectorPlan {
  const plan = directorPlanFixture();
  const shotTwo = plan.shots[1]!;
  shotTwo.reuseFromScenePosition = 1;
  shotTwo.query = "REUSE_ONLY scene 1 stock-query-2";
  shotTwo.sourceInSeconds = 4;
  return plan;
}

// 生成母片复用链：第 1 镜 generated_video 母片，第 2 镜显式复用第 1 镜，第 3 镜 query 编码
// 复用第 2 镜（链式，有效根为第 1 镜）。
function generatedReuseChainPlanFixture(): VisualDirectorPlan {
  const plan = directorPlanFixture();
  plan.shots[0]!.deliveryType = "generated_video";
  plan.shots[1]!.reuseFromScenePosition = 1;
  plan.shots[1]!.sourceInSeconds = 4;
  plan.shots[2]!.query = "REUSE_ONLY scene 2 stock-query-3";
  plan.shots[2]!.sourceInSeconds = 6;
  return plan;
}

// 正常整合：只改写 rationale（纯采用说明），其余画面要求字段——含 narrativeRole（进入
// Python candidate intent）与复用/参考关系——必须与被证据覆盖的草案一致。
function integratedPlanFromDraft(draft: VisualDirectorPlan): VisualDirectorPlan {
  const plan = JSON.parse(JSON.stringify(draft)) as VisualDirectorPlan;
  plan.shots = plan.shots.map((shot) => ({
    ...shot,
    rationale: `整合后采用排序首选候选：${shot.rationale}`,
  }));
  return plan;
}

function rankingFixture(options?: { sceneTwoSemanticScore?: number }): AssetSemanticRanking {
  return {
    version: "video-factory/asset-ranking-v1",
    source: "model",
    providerId: "test-ranker",
    modelId: "test-rank-model",
    summary: "测试排序",
    scenes: [1, 2, 3].map((position) => ({
      scenePosition: position,
      summary: `第${position}镜排序`,
      candidates: [{
        provider: "stock-free",
        assetId: `asset-${position}-a`,
        originalRank: 1,
        rank: 1,
        semanticScore: position === 2 ? options?.sceneTwoSemanticScore ?? 80 : 80,
        rationale: "主体与画面意图一致",
        locked: false,
      }],
    })),
  };
}

function baseInput(): CreativePlanningInput {
  return {
    runId: RUN_ID,
    inputDigest: INPUT_DIGEST,
    durationRange: DURATION_RANGE,
  };
}

// ---------------------------------------------------------------------------
// spy port 工厂
// ---------------------------------------------------------------------------

interface PlanningPortCalls {
  treatment: CreativePlanningContext[];
  script: CreativePlanningContext[];
  director: CreativePlanningContext[];
  integrate: CreativePlanningContext[];
  search: CreativePlanningContext[];
  rank: CreativePlanningContext[];
  compile: CreativePlanningContext[];
}

interface SpyPortsOptions {
  /** 注入 searchCandidates 时启用图库路线；缺省为无图库固定路线。 */
  withLibrary?: boolean;
  /** 按调用序返回的导演方案；耗尽后回落到最后一次返回过的方案（模拟内容确定性的导演角色）。 */
  directorOutputs?: VisualDirectorPlan[];
  /** 按调用序返回的稿件；耗尽后回落到 fixture。 */
  scriptOutputs?: ScriptDraft[];
  /** 按调用序返回的排序；耗尽后按当前 context 投影。 */
  rankingOutputs?: AssetSemanticRanking[];
  /** integrate port 首次调用抛出模拟中断。 */
  failIntegrateFirstCall?: boolean;
  /** compile port 首次调用抛出模拟中断（用于整合成功后、编译前中断）。 */
  failCompileFirstCall?: boolean;
  /** 第 N 次导演调用（1 起）抛出模拟中断，用于回退途中中断。 */
  failDirectorAtCall?: number;
  /** 搜索替身从当前导演方案投影报告时丢弃该镜头（制造 report 与排序一致缺失必需镜头）。 */
  dropReportScene?: number;
  /** 搜索替身让该镜头的候选列表合法为空（对照：覆盖完整、候选不足，走既有责任路由）。 */
  emptyCandidatesAtScene?: number;
  /** 搜索替身改写该镜头的报告检索词（制造当前方案与报告的关联合同不一致）。 */
  reportQueryOverride?: { scenePosition: number; query: string };
  /** 排序替身按当前输入内容返回逐镜语义分覆盖（按 context 分支，不按调用序）。 */
  rankScoresFromContext?: (context: CreativePlanningContext) => Record<number, number>;
  /** 整合替身在默认整合形态之上应用改写（模拟整合改写候选身份等违约输出）。 */
  integrateTransform?: (plan: VisualDirectorPlan, context: CreativePlanningContext) => VisualDirectorPlan;
}

function spyPorts(options: SpyPortsOptions = {}): { ports: CreativePlanningPorts; calls: PlanningPortCalls } {
  const calls: PlanningPortCalls = { treatment: [], script: [], director: [], integrate: [], search: [], rank: [], compile: [] };
  const directorOutputs = [...(options.directorOutputs ?? [])];
  const scriptOutputs = [...(options.scriptOutputs ?? [])];
  const rankingOutputs = [...(options.rankingOutputs ?? [])];
  let integrateCalled = false;
  let lastDirectorOutput: VisualDirectorPlan | undefined;

  // 报告从当前导演方案投影：stock 镜头逐镜生成候选，检索词与 Provider 路由来自方案本身——
  // 测试替身依据输入内容产生结果，而不是按调用序返回与输入无关的固定 fixture。
  // 复用镜头与生产 Python 行为一致（stock_assets.py search_routed_scene_asset_candidates）：
  // 跳过搜索、保留空候选报告行——复用是合法的覆盖形态，不得伪造候选。
  const reportFromContext = (context: CreativePlanningContext): AssetCandidateReport => {
    const draft = context.directorPlan;
    if (!draft) throw new Error("spy searchCandidates requires a director plan artifact");
    const scenes = draft.output.shots
      .filter((shot) => (shot.deliveryType === "stock_video" || shot.deliveryType === "stock_image")
        && shot.scenePosition !== options.dropReportScene)
      .map((shot) => {
        const overridden = options.reportQueryOverride?.scenePosition === shot.scenePosition
          ? options.reportQueryOverride.query
          : undefined;
        const query = (overridden ?? shot.query).trim();
        const reuseSource = assetReuseSourceScenePosition({
          ...(shot.reuseFromScenePosition !== undefined ? { reuseFromScenePosition: shot.reuseFromScenePosition } : {}),
          query,
        });
        const emptyCandidates = shot.scenePosition === options.emptyCandidatesAtScene
          || reuseSource !== undefined;
        return {
          scenePosition: shot.scenePosition,
          intent: { narrativeRole: shot.narrativeRole },
          query,
          candidates: emptyCandidates ? [] : [{
            provider: shot.preferredProviderId,
            assetId: `asset-${shot.scenePosition}-a`,
            mediaType: shot.deliveryType === "stock_image" ? ("image" as const) : ("video" as const),
            width: 1920,
            height: 1080,
            duration: 10,
            previewUrl: `https://example.test/preview-${shot.scenePosition}.jpg`,
            sourceUrl: `https://example.test/source-${shot.scenePosition}`,
            creator: "测试作者",
            licenseNote: "测试许可",
            query,
            qualityScore: 70,
          }],
        };
      });
    return { version: "video-factory/asset-candidates-v1", scenes };
  };

  const ports: CreativePlanningPorts = {
    treatment: async (context) => {
      calls.treatment.push(context);
      return { artifactId: "treatment:1", output: treatmentFixture() };
    },
    screenwriter: async (context) => {
      calls.script.push(context);
      const output = scriptOutputs.shift() ?? scriptFixture();
      return { artifactId: `script:${calls.script.length}`, output };
    },
    director: async (context) => {
      calls.director.push(context);
      if (options.failDirectorAtCall === calls.director.length) {
        throw new Error("SIMULATED_INTERRUPTION_inside_director_rework");
      }
      // 队列耗尽后回落到最后一次输出：同一输入确定性重跑应得到同一方案，而不是新造 fixture。
      if (directorOutputs.length > 0) {
        lastDirectorOutput = directorOutputs.shift()!;
      }
      const output = lastDirectorOutput ?? directorPlanFixture();
      return { artifactId: `director:${calls.director.length}`, output };
    },
    compile: async (context) => {
      calls.compile.push(context);
      if (options.failCompileFirstCall && calls.compile.length === 1) {
        throw new Error("SIMULATED_INTERRUPTION_inside_compile");
      }
      return executablePlanCompilePort(context);
    },
  };
  if (options.withLibrary) {
    // rank/integrateDirector 只在图库路线提供：无图库固定路线不得要求不会执行的假 port。
    ports.integrateDirector = async (context) => {
      calls.integrate.push(context);
      if (options.failIntegrateFirstCall && !integrateCalled) {
        integrateCalled = true;
        throw new Error("SIMULATED_INTERRUPTION_inside_integrate");
      }
      const draft = context.directorPlan;
      if (!draft) throw new Error("spy integrateDirector requires a director plan artifact");
      const integrated = integratedPlanFromDraft(draft.output);
      const output = options.integrateTransform ? options.integrateTransform(integrated, context) : integrated;
      return { artifactId: `integrate:${calls.integrate.length}`, output };
    };
    ports.rank = async (context) => {
      calls.rank.push(context);
      const queued = rankingOutputs.shift();
      if (queued) return { artifactId: `ranking:${calls.rank.length}`, output: queued };
      // 排序按当前候选证据投影，语义分可按输入内容覆盖：排序结果必须反映它实际排的是什么。
      const scores = options.rankScoresFromContext?.(context) ?? {};
      const report = context.candidates?.output;
      if (!report) throw new Error("spy rank requires a candidates artifact");
      const scenes = report.scenes.map((scene) => ({
        scenePosition: scene.scenePosition,
        summary: `第${scene.scenePosition}镜排序`,
        candidates: scene.candidates.map((candidate, index) => ({
          provider: candidate.provider,
          assetId: candidate.assetId,
          originalRank: index + 1,
          rank: index + 1,
          semanticScore: scene.scenePosition in scores ? scores[scene.scenePosition]! : 80,
          rationale: "主体与画面意图一致",
          locked: false,
        })),
      }));
      return {
        artifactId: `ranking:${calls.rank.length}`,
        output: {
          version: "video-factory/asset-ranking-v1",
          source: "model" as const,
          providerId: "test-ranker",
          modelId: "test-rank-model",
          summary: "测试排序",
          scenes,
        },
      };
    };
    ports.searchCandidates = async (context) => {
      calls.search.push(context);
      return { artifactId: `candidates:${calls.search.length}`, output: reportFromContext(context) };
    };
  }
  return { ports, calls };
}

/** 按调用序返回注入的 issue 列表，耗尽后返回空（问题已解决）。 */
function queuedReviewer(queues: PlanningIssue[][]): { reviewer: AvailabilityReviewer; contexts: unknown[] } {
  const pending = [...queues];
  const contexts: unknown[] = [];
  const reviewer: AvailabilityReviewer = (context) => {
    contexts.push(context);
    return pending.shift() ?? [];
  };
  return { reviewer, contexts };
}

function directorIssue(overrides: Partial<PlanningIssue> = {}): PlanningIssue {
  return {
    id: "issue-director-1",
    target: "director",
    beatIds: [],
    scenePositions: [2],
    reason: "图库候选与画面意图不符",
    requiredChange: "调整第 2 镜画面路线",
    evidenceArtifactIds: ["ranking:1"],
    ...overrides,
  };
}

// 整合问题复检替身：按传入方案实际内容分支（不按调用序）。整合方案（rationale 带采用标记）
// 上报第 2 镜可得性问题；isFixed 由用例按方案内容判断修复是否真实生效。
function integratedAvailabilityReviewer(
  isFixed: (plan: VisualDirectorPlan) => boolean,
): AvailabilityReviewer {
  return (input) => {
    const isIntegrated = input.directorPlan.shots.some(
      (shot) => shot.rationale.includes("整合后采用排序首选候选"),
    );
    if (!isIntegrated || isFixed(input.directorPlan)) return [];
    return [directorIssue({
      id: "issue-integrated-availability",
      reason: "整合方案第 2 镜候选不可用",
      scenePositions: [2],
    })];
  };
}

// 第 1 镜机位反馈复检替身：按传入方案实际内容分支，机位仍是“固定机位”时上报 director 问题。
function cameraFeedbackReviewer(): AvailabilityReviewer {
  return (input) => (
    input.directorPlan.shots[0]!.camera === "固定机位"
      ? [directorIssue({
        id: "issue-scene-one-camera",
        reason: "第 1 镜机位与旁白节奏不匹配",
        scenePositions: [1],
      })]
      : []
  );
}

async function withWorkspace<T>(run: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "vf-b3-planning-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function completedOutcome(outcome: CreativePlanningRunOutcome): Extract<CreativePlanningRunOutcome, { status: "completed" }> {
  assert.equal(outcome.status, "completed");
  return outcome;
}

// ---------------------------------------------------------------------------
// 1. 无图库固定路线调用计数
// ---------------------------------------------------------------------------

describe("B3 固定创作规划图", () => {
  describe("1 无图库固定路线（P04）", () => {
    it("treatment/script/director/compile 各调用 1 次，search/rank 为 0，不存在以 integrate 为名的第二次导演调用", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts();
          // 无图库路线只提供四个创作 port：不得要求不会执行的 rank/integrateDirector 假 port。
          assert.equal("searchCandidates" in ports, false);
          assert.equal("rank" in ports, false);
          assert.equal("integrateDirector" in ports, false);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(calls.treatment.length, 1);
          assert.equal(calls.script.length, 1);
          assert.equal(calls.director.length, 1);
          assert.equal(calls.search.length, 0);
          assert.equal(calls.rank.length, 0);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 1);

          assert.equal(outcome.state.stage, "compile");
          assert.equal(outcome.state.inputDigest, INPUT_DIGEST);
          assert.equal(outcome.state.crossRoleRevisions, 0);
          assert.deepEqual(outcome.state.issues, []);
          assert.deepEqual(outcome.state.unresolvedIssueDigests, []);
          assert.deepEqual(outcome.state.artifactIds, {
            treatment: ["treatment:1"],
            script: ["script:1"],
            director: ["director:1"],
            compile: [outcome.executablePlan.artifactId],
          });
          // 无图库路线最终方案是导演草案本身，不是以 integrate 名义再调一次导演。
          assert.equal(calls.compile[0]!.directorPlan?.artifactId, "director:1");
          assert.equal(calls.compile[0]!.integratedPlan, null);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. 有图库整合路线调用计数
  // -------------------------------------------------------------------------

  describe("2 有图库整合路线（P04）", () => {
    it("treatment=1、script=1、director=2（草案+整合）、search=1、rank=1、compile=1", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(calls.treatment.length, 1);
          assert.equal(calls.script.length, 1);
          assert.equal(calls.director.length, 1);
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.search.length, 1);
          assert.equal(calls.rank.length, 1);
          assert.equal(calls.compile.length, 1);
          // 导演角色总调用（草案 + 整合）恰为 2，不多不少。
          assert.equal(calls.director.length + calls.integrate.length, 2);

          assert.equal(outcome.state.stage, "compile");
          assert.equal(outcome.state.crossRoleRevisions, 0);
          assert.deepEqual(outcome.state.artifactIds, {
            treatment: ["treatment:1"],
            script: ["script:1"],
            director: ["director:1"],
            candidates: ["candidates:1"],
            rank: ["ranking:1"],
            integrate: ["integrate:1"],
            compile: [outcome.executablePlan.artifactId],
          });
          // 整合阶段的导演调用能看到候选与排序证据。
          assert.equal(calls.integrate[0]!.candidates?.artifactId, "candidates:1");
          assert.equal(calls.integrate[0]!.ranking?.artifactId, "ranking:1");
          // 最终编译使用整合后的方案。
          assert.equal(calls.compile[0]!.integratedPlan?.artifactId, "integrate:1");
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. 仅画面路线反馈的责任边界
  // -------------------------------------------------------------------------

  describe("3 仅画面路线反馈（P05）", () => {
    it("target=director 反馈不再调用 treatment/script，只重修受影响 director；候选条件未变不重搜", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 重修方案与草案内容一致：候选获取身份与排序实际输入均未变。
            directorOutputs: [directorPlanFixture()],
          });
          const { reviewer, contexts } = queuedReviewer([
            [directorIssue()],
            [],
          ]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(calls.treatment.length, 1);
          assert.equal(calls.script.length, 1);
          assert.equal(calls.director.length, 2, "导演草案 + 按反馈重修");
          assert.equal(calls.search.length, 1, "候选条件未变不得重新搜索");
          assert.equal(calls.rank.length, 1, "排序实际输入未变不得重新排序");
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 1);
          assert.equal(outcome.state.crossRoleRevisions, 1);
          assert.equal(outcome.state.stage, "compile");

          // 重修调用收到画面路线 issue；分类器收到了排序证据。
          assert.equal(calls.director[1]!.issues.length, 1);
          assert.equal(calls.director[1]!.issues[0]!.target, "director");
          assert.deepEqual(calls.director[1]!.issues[0]!.scenePositions, [2]);
          // 复检共三轮：草案复检、重修草案复检、整合方案复检（整合后仍要过同一责任边界）。
          assert.equal(contexts.length, 3);
        } finally {
          store.close();
        }
      });
    });

    it("候选查询条件变化后必须重新搜索与排序", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 草案之后按反馈重修：重修方案改写了第 2 镜的 stock 检索词。
            directorOutputs: [
              directorPlanFixture(),
              directorPlanFixture({ sceneTwoQuery: "stock-query-2-reworked" }),
            ],
          });
          const { reviewer } = queuedReviewer([[directorIssue()], []]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(calls.treatment.length, 1);
          assert.equal(calls.script.length, 1);
          assert.equal(calls.director.length, 2);
          assert.equal(calls.search.length, 2, "候选查询变化必须重搜");
          assert.equal(calls.rank.length, 2, "重搜后必须重排");
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 1);
        } finally {
          store.close();
        }
      });
    });

    it("candidateSearchFingerprint 只由 stock 镜头的查询身份决定且稳定", () => {
      const draft = directorPlanFixture();
      assert.equal(candidateSearchFingerprint(draft), candidateSearchFingerprint(directorPlanFixture()));
      assert.notEqual(
        candidateSearchFingerprint(draft),
        candidateSearchFingerprint(directorPlanFixture({ sceneTwoQuery: "another-query" })),
      );
      const generated = directorPlanFixture();
      generated.shots[1]!.deliveryType = "generated_video";
      assert.notEqual(candidateSearchFingerprint(draft), candidateSearchFingerprint(generated));
      const reworded = directorPlanFixture();
      reworded.shots[1]!.narrativeRole = "次要铺垫";
      assert.equal(candidateSearchFingerprint(draft), candidateSearchFingerprint(reworded));
    });

    it("candidateSearchFingerprint 覆盖 Provider 路由身份：换 Provider 必须重搜", () => {
      const draft = directorPlanFixture();
      // 仅 preferredProviderId 变化（query/deliveryType 不变）：Provider 路由属于候选条件。
      const providerChanged = directorPlanFixture();
      providerChanged.shots[1]!.preferredProviderId = "pixabay";
      assert.notEqual(candidateSearchFingerprint(draft), candidateSearchFingerprint(providerChanged));

      // alternativeProviderIds 排序去重后参与身份：顺序与重复不改变身份，集合变化改变身份。
      const altA = directorPlanFixture();
      altA.shots[0]!.alternativeProviderIds = ["pixabay", "pexels", "pixabay"];
      const altB = directorPlanFixture();
      altB.shots[0]!.alternativeProviderIds = ["pexels", "pixabay"];
      assert.equal(candidateSearchFingerprint(altA), candidateSearchFingerprint(altB));
      const altChanged = directorPlanFixture();
      altChanged.shots[0]!.alternativeProviderIds = ["pexels"];
      assert.notEqual(candidateSearchFingerprint(altB), candidateSearchFingerprint(altChanged));

      // 检索词 trim 后比较：首尾空白不改变检索身份。
      const padded = directorPlanFixture();
      padded.shots[0]!.query = "  stock-query-1  ";
      assert.equal(candidateSearchFingerprint(draft), candidateSearchFingerprint(padded));
    });
  });

  // -------------------------------------------------------------------------
  // 4. 责任路由与有界回退
  // -------------------------------------------------------------------------

  describe("4 责任路由与有界回退（P05/P06）", () => {
    it("target=script 时重跑编剧并重建导演；treatment 不再调用", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 重建导演方案改变了第 2 镜检索词，触发重搜重排。
            directorOutputs: [
              directorPlanFixture(),
              directorPlanFixture({ sceneTwoQuery: "rebuilt-query-2" }),
            ],
          });
          const { reviewer } = queuedReviewer([
            [directorIssue({ id: "issue-script-1", target: "script", beatIds: ["beat-2"], scenePositions: [2], reason: "旁白与证据不匹配", requiredChange: "重写第 2 段旁白" })],
            [],
          ]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(calls.treatment.length, 1);
          assert.equal(calls.script.length, 2, "script 责任问题必须重跑编剧");
          assert.equal(calls.director.length, 2, "script 变更后必须重建导演方案");
          assert.equal(calls.search.length, 2, "重建方案改变候选条件后必须重搜");
          assert.equal(calls.rank.length, 2);
          assert.equal(calls.compile.length, 1);

          // 重跑的编剧收到 script 责任的 issue；跨角色回退恰计 1 次。
          assert.equal(calls.script[1]!.issues.length, 1);
          assert.equal(calls.script[1]!.issues[0]!.target, "script");
          assert.equal(outcome.state.crossRoleRevisions, 1);
        } finally {
          store.close();
        }
      });
    });

    it("target=user 时停在 needs_user；target=source 时停在 needs_source；不再重试", async () => {
      await withWorkspace(async (workspaceRoot) => {
        for (const target of ["user", "source"] as const) {
          const store = CreativePlanningStore.open(workspaceRoot);
          try {
            const { ports, calls } = spyPorts({ withLibrary: true });
            const { reviewer } = queuedReviewer([
              [directorIssue({ id: `issue-${target}-1`, target, reason: target === "user" ? "需要用户确认口径" : "素材来源确实不可得", requiredChange: target === "user" ? "等待用户决定" : "补充素材" })],
            ]);
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
            // 每个 target 一个独立输入身份：input digest 与 threadId 必须一致（新合同精确校验）。
            const targetInput = { ...baseInput(), inputDigest: `${INPUT_DIGEST}-${target}` };
            const outcome = await runCreativePlanning(graph, {
              input: targetInput,
              threadId: planningThreadId(RUN_ID, `${INPUT_DIGEST}-${target}`),
            });

            assert.equal(outcome.status, "halted");
            assert.equal(outcome.halt.reason, target === "user" ? "needs_user" : "needs_source");
            assert.deepEqual(outcome.halt.issueIds, [`issue-${target}-1`]);
            // 停止：不整合、不编译、不再回退任何角色。
            assert.equal(calls.integrate.length, 0);
            assert.equal(calls.compile.length, 0);
            assert.equal(calls.director.length, 1);
            assert.equal(calls.script.length, 1);
            assert.equal(calls.treatment.length, 1);
            assert.equal(outcome.state.crossRoleRevisions, 0);
            assert.equal(outcome.state.issues.length, 1);
          } finally {
            store.close();
          }
        }
      });
    });

    it("同一结构问题第二次原样出现即停止（duplicate_issue）", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const issue = directorIssue();
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 重修方案不改变候选条件，也没有解决该问题。
            directorOutputs: [directorPlanFixture()],
          });
          const { reviewer } = queuedReviewer([[issue], [issue]]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "duplicate_issue");
          assert.deepEqual(outcome.halt.issueIds, [issue.id]);
          // 回退一次后发现相同问题：不再无限重修。
          assert.equal(calls.director.length, 2);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
          assert.equal(outcome.state.crossRoleRevisions, 1);
          assert.deepEqual(outcome.state.unresolvedIssueDigests, [planningIssueDigest(issue)]);
        } finally {
          store.close();
        }
      });
    });

    it("同一叙事目标的图库阻断换 query 与 ranking id 后仍转人工门禁", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const revisedPlan = directorPlanFixture({ sceneTwoQuery: "revised-stock-query-2" });
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [directorPlanFixture(), revisedPlan],
            // 同一第 2 段叙事目标仍无可用候选；只改 query 会产生新的候选与 ranking artifact，
            // 但实际候选数量和最佳分数都没有改善，不能借此获得第三轮。
            rankScoresFromContext: () => ({ 2: 20 }),
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          assert.match(outcome.halt.detail, /调整检索词|生成|复用/);
          assert.doesNotMatch(outcome.halt.detail, /实验|实证/);
          assert.equal(outcome.state.issues[0]?.target, "source");
          assert.equal(calls.director.length, 2, "第二次确认来源路线无进展后不得再调用第三组导演");
          assert.equal(calls.search.length, 2);
          assert.equal(calls.rank.length, 2, "第二次排序已证明同类阻断，不得再进入第三组排序");
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
          assert.equal(outcome.state.crossRoleRevisions, 1, "无进展停止不应消耗第二次回退额度");
        } finally {
          store.close();
        }
      });
    });

    it("同一已接受稿件目标仅改写导演 successCriteria/visibleAction 时第二轮止损", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const firstPlan = directorPlanFixture();
          firstPlan.shots[1]!.visibleAction = "缓慢旋转物体";
          firstPlan.shots[1]!.successCriteria = ["完整展示旋转动作"];
          const secondPlan = directorPlanFixture({ sceneTwoQuery: "revised-stock-query-2" });
          secondPlan.shots[1]!.visibleAction = "物体被缓慢转动";
          secondPlan.shots[1]!.successCriteria = ["应看到完整的旋转过程"];
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [firstPlan, secondPlan],
            rankScoresFromContext: () => ({ 2: 20 }),
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          assert.equal(calls.director.length, 2);
          assert.equal(calls.rank.length, 2);
          assert.equal(outcome.state.crossRoleRevisions, 1);
        } finally {
          store.close();
        }
      });
    });

    it("不同已接受稿件目标即使证据没有改善也不会被上一目标提前阻断", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const revisedPlan = directorPlanFixture({ sceneTwoQuery: "revised-stock-query-2" });
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [directorPlanFixture(), revisedPlan],
            rankScoresFromContext: (context) => (
              context.directorPlan?.output.shots[1]?.query === "revised-stock-query-2"
                ? { 1: 20 }
                : { 2: 20 }
            ),
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          assert.equal(calls.director.length, 3, "第二轮转向不同的已接受稿件目标，必须允许一次真实修订");
          assert.equal(calls.search.length, 2);
          assert.equal(calls.rank.length, 2);
          assert.equal(outcome.state.crossRoleRevisions, 2);
        } finally {
          store.close();
        }
      });
    });

    it("同一目标候选分数真实改善后允许继续，下一轮不再改善才转人工门禁", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const secondPlan = directorPlanFixture({ sceneTwoQuery: "improved-stock-query-2" });
          const thirdPlan = directorPlanFixture({ sceneTwoQuery: "stalled-stock-query-2" });
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [directorPlanFixture(), secondPlan, thirdPlan],
            rankScoresFromContext: (context) => ({
              2: context.directorPlan?.output.shots[1]?.query === "stock-query-2" ? 20 : 30,
            }),
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(calls.director.length, 3);
          assert.equal(calls.rank.length, 3, "20→30 是真实改善；30→30 才停止");
          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          assert.equal(outcome.state.crossRoleRevisions, 2);
        } finally {
          store.close();
        }
      });
    });

    it("关闭并重开 SQLite 后仍保留同一目标的无进展证据", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const first = spyPorts({
            withLibrary: true,
            directorOutputs: [directorPlanFixture()],
            rankScoresFromContext: () => ({ 2: 20 }),
            failDirectorAtCall: 2,
          });
          const graph = createCreativePlanningGraph({ ports: first.ports, checkpointer: firstStore.saver });
          await assert.rejects(() => runCreativePlanning(graph, { input: baseInput(), threadId }), /SIMULATED_INTERRUPTION/);
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const revised = directorPlanFixture({ sceneTwoQuery: "restored-stock-query-2" });
          revised.shots[1]!.successCriteria = ["同义改写后的完整动作"];
          const resumed = spyPorts({
            withLibrary: true,
            directorOutputs: [revised],
            rankScoresFromContext: () => ({ 2: 20 }),
          });
          const graph = createCreativePlanningGraph({ ports: resumed.ports, checkpointer: resumedStore.saver });
          const outcome = await runCreativePlanning(graph, { input: baseInput(), threadId });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          assert.equal(resumed.calls.director.length, 1);
          assert.equal(resumed.calls.rank.length, 1);
        } finally {
          resumedStore.close();
        }
      });
    });

    it("跨角色回退最多 2 次，之后按 cross_role_revisions_exhausted 停止", async () => {
      assert.equal(MAX_CROSS_ROLE_REVISIONS, 2);
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [directorPlanFixture(), directorPlanFixture()],
          });
          // 三轮各不相同的 director 问题：两次回退后第三次必须停止。
          const { reviewer } = queuedReviewer([
            [directorIssue({ id: "issue-1", reason: "图库候选与画面意图不符" })],
            [directorIssue({ id: "issue-2", reason: "构图与旁白节奏不匹配" })],
            [directorIssue({ id: "issue-3", reason: "镜头连续性断裂" })],
          ]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "cross_role_revisions_exhausted");
          assert.deepEqual(outcome.halt.issueIds, ["issue-3"]);
          // 草案 + 2 次重修后停止，不出现第三次回退。
          assert.equal(calls.director.length, 3);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
          assert.equal(outcome.state.crossRoleRevisions, MAX_CROSS_ROLE_REVISIONS);
        } finally {
          store.close();
        }
      });
    });

    it("issue digest 由结构化字段决定，id 与 requiredChange 不参与", () => {
      const base = directorIssue();
      const reidentified = directorIssue({ id: "issue-other-id", requiredChange: "完全不同的修复建议" });
      assert.equal(planningIssueDigest(base), planningIssueDigest(reidentified));

      const reordered = directorIssue({ scenePositions: [1, 2], beatIds: ["beat-b", "beat-a"], evidenceArtifactIds: ["evidence-b", "evidence-a"] });
      const sorted = directorIssue({ scenePositions: [2, 1], beatIds: ["beat-a", "beat-b"], evidenceArtifactIds: ["evidence-a", "evidence-b"] });
      assert.equal(planningIssueDigest(reordered), planningIssueDigest(sorted));

      assert.notEqual(planningIssueDigest(base), planningIssueDigest(directorIssue({ reason: "另一个结构原因" })));
      assert.notEqual(planningIssueDigest(base), planningIssueDigest(directorIssue({ target: "script" })));
      assert.notEqual(planningIssueDigest(base), planningIssueDigest(directorIssue({ scenePositions: [3] })));
    });

    it("默认 availability reviewer：候选低于自动采用阈值按 director 责任上报", () => {
      const plan = directorPlanFixture();
      const ranking: PlanningArtifact<AssetSemanticRanking> = { artifactId: "ranking:weak", output: rankingFixture({ sceneTwoSemanticScore: AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM - 1 }) };
      const issues = defaultAvailabilityReviewer({ script: scriptFixture(), directorPlan: plan, ranking });

      assert.equal(issues.length, 1);
      assert.equal(issues[0]!.target, "director");
      assert.deepEqual(issues[0]!.scenePositions, [2]);
      assert.deepEqual(issues[0]!.evidenceArtifactIds, ["ranking:weak"]);

      const healthy = defaultAvailabilityReviewer({
        script: scriptFixture(),
        directorPlan: plan,
        ranking: { artifactId: "ranking:ok", output: rankingFixture() },
      });
      assert.deepEqual(healthy, []);
      // 无排序证据时不臆造问题。
      assert.deepEqual(defaultAvailabilityReviewer({ script: scriptFixture(), directorPlan: plan, ranking: null }), []);
    });
  });

  // -------------------------------------------------------------------------
  // 5. rank 完成后中断，用同一 SQLite/thread 恢复
  // -------------------------------------------------------------------------

  describe("5 图 checkpoint 恢复（P07 图部分）", () => {
    it("rank 已完成后中断：treatment/script/search/rank/director 不再调用，只完成 integrate/compile", async () => {
      await withWorkspace(async (workspaceRoot) => {
        assert.equal(
          planningCheckpointSqlitePath(workspaceRoot),
          path.join(workspaceRoot, "planning", "checkpoints.sqlite"),
        );

        const firstStore = CreativePlanningStore.open(workspaceRoot);
        let firstCalls: PlanningPortCalls;
        try {
          const spy = spyPorts({ withLibrary: true, failIntegrateFirstCall: true });
          firstCalls = spy.calls;
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: firstStore.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /SIMULATED_INTERRUPTION_inside_integrate/,
          );
          assert.equal(firstCalls.treatment.length, 1);
          assert.equal(firstCalls.rank.length, 1);
          assert.equal(firstCalls.integrate.length, 1, "中断发生在 integrate 首次调用");
        } finally {
          firstStore.close();
        }

        // 同一 SQLite 文件上重新打开 store 与图：恢复不得重跑已完成节点。
        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.director.length, 0);
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.rank.length, 0);
          assert.equal(spy.calls.integrate.length, 1, "只补做被中断的 integrate");
          assert.equal(spy.calls.compile.length, 1);
          assert.equal(outcome.state.stage, "compile");
          assert.equal(outcome.state.crossRoleRevisions, 0);
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6. 输入身份与 thread 边界
  // ---------------------------------------------------------------------------

  describe("6 输入 digest 与 thread 边界（P06）", () => {
    it("planningThreadId 是输入身份的确定性纯函数", () => {
      const first = planningThreadId(RUN_ID, INPUT_DIGEST);
      assert.equal(first, planningThreadId(RUN_ID, INPUT_DIGEST));
      assert.notEqual(first, planningThreadId(RUN_ID, `${INPUT_DIGEST}-changed`));
      assert.notEqual(first, planningThreadId("run-b3-other", INPUT_DIGEST));
      assert.ok(!/\s/.test(first), "thread id 必须可直接作为存储键");
    });

    it("输入 digest 改变不能命中旧图结果", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
          const first = spyPorts({ withLibrary: true });
          const firstGraph = createCreativePlanningGraph({ ports: first.ports, checkpointer: store.saver });
          completedOutcome(await runCreativePlanning(firstGraph, { input: baseInput(), threadId }));

          const changedInput = { ...baseInput(), inputDigest: `${INPUT_DIGEST}-changed` };
          const second = spyPorts({ withLibrary: true });
          const secondGraph = createCreativePlanningGraph({ ports: second.ports, checkpointer: store.saver });
          // digest 改变 ⇒ 规范 threadId 必然不同：旧 thread 对新输入必须失效（精确匹配先行）。
          await assert.rejects(
            () => runCreativePlanning(secondGraph, { input: changedInput, threadId }),
            /must equal planningThreadId/,
          );
          // 拒绝发生在任何节点执行之前：旧结果不能被新输入复用。
          assert.equal(second.calls.treatment.length, 0);
          assert.equal(second.calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("不同 run/thread 不串状态，各自独立完成", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const runA = spyPorts({ withLibrary: true });
          const graphA = createCreativePlanningGraph({ ports: runA.ports, checkpointer: store.saver });
          const outcomeA = completedOutcome(await runCreativePlanning(graphA, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          }));

          const otherInput = { ...baseInput(), runId: "run-b3-other", inputDigest: "b3-other-digest" };
          const runB = spyPorts({ withLibrary: true });
          const graphB = createCreativePlanningGraph({ ports: runB.ports, checkpointer: store.saver });
          const outcomeB = completedOutcome(await runCreativePlanning(graphB, {
            input: otherInput,
            threadId: planningThreadId("run-b3-other", "b3-other-digest"),
          }));

          assert.equal(outcomeA.state.inputDigest, INPUT_DIGEST);
          assert.equal(outcomeB.state.inputDigest, "b3-other-digest");
          assert.equal(runA.calls.treatment.length, 1);
          assert.equal(runB.calls.treatment.length, 1);

          // B 完成后再次恢复 A 的 thread：仍是 A 的已完成状态，零节点调用，不串 B 的结果。
          const resumedA = completedOutcome(await runCreativePlanning(graphA, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          }));
          assert.equal(resumedA.state.inputDigest, INPUT_DIGEST);
          assert.equal(resumedA.state.stage, "compile");
          assert.equal(runA.calls.treatment.length, 1);
          assert.equal(runA.calls.compile.length, 1);
        } finally {
          store.close();
        }
      });
    });

    it("中断后恢复不重置跨角色回退计数", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const issue = directorIssue();
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          // 首轮 evaluate 产生回退，重修导演方案时中断：crossRoleRevisions=1 已入 checkpoint。
          const spy = spyPorts({ withLibrary: true, failDirectorAtCall: 2 });
          const { reviewer } = queuedReviewer([[issue]]);
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: firstStore.saver, availabilityReviewer: reviewer });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_inside_director_rework/,
          );
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          // 恢复时同一问题仍在：已花费的 1 次回退不能被清零，必须按重复问题停止。
          const spy = spyPorts({ withLibrary: true, directorOutputs: [directorPlanFixture()] });
          const { reviewer } = queuedReviewer([[issue]]);
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver, availabilityReviewer: reviewer });
          const outcome = await runCreativePlanning(graph, { input: baseInput(), threadId });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "duplicate_issue");
          assert.equal(outcome.state.crossRoleRevisions, 1, "恢复不得重置跨角色回退计数");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.rank.length, 0);
          assert.equal(spy.calls.director.length, 1, "只补做被中断的重修");
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 7. 付费媒体边界
  // ---------------------------------------------------------------------------

  describe("7 付费媒体边界（费用安全）", () => {
    // 编译期断言：图的公共依赖面不得出现付费授权 / Provider registry / 媒体创建下载能力。
    type ForbiddenPlanningSurface =
      | "SpendAuthorization"
      | "authorizeSpend"
      | "dispatchSpendAuthorization"
      | "quoteSpend"
      | "providerRegistry"
      | "resolveProvider"
      | "createMedia"
      | "purchaseMedia"
      | "downloadMedia";
    type PortKeyLeak = Extract<keyof CreativePlanningPorts, ForbiddenPlanningSurface>;
    const portKeysAreClean: PortKeyLeak extends never ? true : never = true;
    type GraphOptionKeyLeak = Extract<keyof CreateCreativePlanningGraphOptions, ForbiddenPlanningSurface>;
    const graphOptionsAreClean: GraphOptionKeyLeak extends never ? true : never = true;
    void portKeysAreClean;
    void graphOptionsAreClean;

    it("图运行期间付费媒体调用为 0，且只访问创作规划 port", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const paidMediaCalls: string[] = [];
          const paidMediaSurface = {
            createMedia: () => { paidMediaCalls.push("createMedia"); },
            purchaseMedia: () => { paidMediaCalls.push("purchaseMedia"); },
            downloadMedia: () => { paidMediaCalls.push("downloadMedia"); },
            authorizeSpend: () => { paidMediaCalls.push("authorizeSpend"); },
            providerRegistry: { resolve: () => { paidMediaCalls.push("providerRegistry"); } },
          };
          const { ports, calls } = spyPorts({ withLibrary: true });
          const accessedPortKeys = new Set<string>();
          const proxiedPorts = new Proxy(ports, {
            get(target, property) {
              accessedPortKeys.add(String(property));
              return Reflect.get(target, property);
            },
          }) as CreativePlanningPorts;

          const graph = createCreativePlanningGraph({
            ports: proxiedPorts,
            checkpointer: store.saver,
            availabilityReviewer: defaultAvailabilityReviewer,
          });
          completedOutcome(await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          }));

          assert.deepEqual(paidMediaCalls, []);
          const allowedPortKeys = new Set([
            "treatment",
            "screenwriter",
            "director",
            "integrateDirector",
            "searchCandidates",
            "rank",
            "compile",
            "discuss",
          ]);
          for (const key of accessedPortKeys) {
            assert.ok(allowedPortKeys.has(key), `图访问了规划合同之外的依赖面：${key}`);
          }
          assert.equal(calls.compile.length, 1);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 8. compile 使用 A 阶段正式编译合同
  // -------------------------------------------------------------------------

  describe("8 compile 正式合同（A2 衔接）", () => {
    it("通过 compileExecutableProductionPlan 产出与合同一致的 executable plan", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports } = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          }));

          // 默认整合保持候选身份：只改写非检索字段，最终编译消费的是整合后方案。
          const integratedPlan = integratedPlanFromDraft(directorPlanFixture());
          const expected: ExecutableProductionPlan = compileExecutableProductionPlan({
            treatmentArtifactId: "treatment:1",
            scriptArtifactId: "script:1",
            directorArtifactId: "integrate:1",
            candidateArtifactIds: ["candidates:1", "ranking:1"],
            durationRange: DURATION_RANGE,
            scenes: [1, 2, 3].map((position) => ({ position, duration: 8 })),
            shots: integratedPlan.shots.map((shot) => ({
              scenePosition: shot.scenePosition,
              ...(shot.sourceInSeconds !== undefined ? { sourceInSeconds: shot.sourceInSeconds } : {}),
              temporalBeats: shot.temporalBeats ?? [],
            })),
          });
          assert.deepEqual(outcome.executablePlan.output, expected);
          // 编译产物能通过正式 parse 合同的 round-trip。
          assert.deepEqual(
            parseExecutableProductionPlan(JSON.parse(JSON.stringify(outcome.executablePlan.output))),
            expected,
          );
        } finally {
          store.close();
        }
      });
    });

    it("导演节拍未覆盖接受时长时 fail closed，不产出 executable plan", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          // 无图库路线的 compile 直接消费导演草案：草案节拍不合法必须拒绝。
          const brokenPlan = directorPlanFixture();
          brokenPlan.shots[1]!.temporalBeats = [{ startSeconds: 0, endSeconds: 7, action: "缺 1 秒" }];
          const { ports } = spyPorts({ directorOutputs: [brokenPlan] });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /Director timing for scene 2 must cover the accepted 8s script cut/,
          );
        } finally {
          store.close();
        }
      });
    });

    it("整合方案镜头与稿件场景不一一对应时 fail closed", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          // 整合方案保留草案候选身份（检索词不变），只裁掉第 3 镜制造编译期镜头缺失。
          const integrated = directorPlanFixture();
          integrated.shots = integrated.shots.slice(0, 2);
          const { ports } = spyPorts({ withLibrary: true });
          const portsWithBrokenIntegrate: CreativePlanningPorts = {
            ...ports,
            integrateDirector: async (context) => {
              void context;
              return { artifactId: "integrate:1", output: integrated };
            },
          };
          const graph = createCreativePlanningGraph({ ports: portsWithBrokenIntegrate, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /must keep every draft shot/,
          );
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 9. thread 身份：清洗/截断不得跨 run 碰撞，threadId 必须精确匹配
  // -------------------------------------------------------------------------

  describe("9 thread 身份与恢复边界（P06/P07）", () => {
    it("planningThreadId 不因 runId 清洗或截断而跨 run 碰撞", () => {
      // 清洗碰撞："/" 与 ":" 清洗后同为 "-"，旧实现会把两个不同 run 折叠成同一 thread。
      assert.notEqual(planningThreadId("run/a", INPUT_DIGEST), planningThreadId("run:a", INPUT_DIGEST));

      // 截断碰撞：超过 64 字符、只在截断点之后不同的 runId 不得共享 thread。
      const longA = `run-${"x".repeat(70)}-a`;
      const longB = `run-${"x".repeat(70)}-b`;
      assert.ok(longA.length > 64 && longB.length > 64);
      assert.notEqual(planningThreadId(longA, INPUT_DIGEST), planningThreadId(longB, INPUT_DIGEST));

      // 输入 digest 仍然区分身份；thread id 保持可直接作为存储键。
      assert.notEqual(planningThreadId(longA, INPUT_DIGEST), planningThreadId(longA, `${INPUT_DIGEST}-changed`));
      assert.ok(!/\s/.test(planningThreadId(longA, INPUT_DIGEST)));
    });

    it("错误 threadId 在任何节点执行前拒绝，零 port 调用", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: "creative-planning:run-b3-graph:not-the-canonical-thread",
            }),
            /must equal planningThreadId/,
          );
          assert.equal(calls.treatment.length, 0);
          assert.equal(calls.script.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("即使 digest 相同也不能把 run A 的 checkpoint 给 run B", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const runA = spyPorts({ withLibrary: true });
          const graphA = createCreativePlanningGraph({ ports: runA.ports, checkpointer: store.saver });
          const threadA = planningThreadId(RUN_ID, INPUT_DIGEST);
          completedOutcome(await runCreativePlanning(graphA, { input: baseInput(), threadId: threadA }));

          // B 与 A 共享同一 digest、不同 runId：A 的 thread 对 B 必须失效，B 零 port 调用。
          const runB = spyPorts({ withLibrary: true });
          const graphB = createCreativePlanningGraph({ ports: runB.ports, checkpointer: store.saver });
          const bInput: CreativePlanningInput = { runId: "run-b3-other", inputDigest: INPUT_DIGEST, durationRange: DURATION_RANGE };
          await assert.rejects(
            () => runCreativePlanning(graphB, { input: bInput, threadId: threadA }),
            /must equal planningThreadId/,
          );
          assert.equal(runB.calls.treatment.length, 0);
          assert.equal(runB.calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 10. durable 输入投影：运行时 callback/deadline 不得持久化
  // -------------------------------------------------------------------------

  describe("10 durable 输入投影（P07）", () => {
    it("checkpoint 只保存 durable 规划身份：额外 callback/deadline 不持久化，恢复不依赖它们", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          // 模拟忽略 TS 类型的 JS 调用方：输入携带运行时 callback 与 wall-clock deadline。
          const runtimeInput = {
            ...baseInput(),
            agentLoopCheckpointForModel: () => {
              throw new Error("runtime callback must not be invoked from checkpoint");
            },
            wallClockDeadlineAtMs: 1_900_000_000_000,
          } as unknown as CreativePlanningInput;
          const spy = spyPorts({ withLibrary: true, failIntegrateFirstCall: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: firstStore.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: runtimeInput, threadId }),
            /SIMULATED_INTERRUPTION_inside_integrate/,
          );
        } finally {
          firstStore.close();
        }

        // 关闭/重开 SQLite：checkpoint 里的 base 只允许 durable 字段，不静默依赖 callback。
        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
          const base = (snapshot?.values as Partial<PlanningGraphState> | undefined)?.base;
          assert.deepEqual(base, { runId: RUN_ID, inputDigest: INPUT_DIGEST, durationRange: DURATION_RANGE });

          // 用干净的最小输入恢复：图不依赖（也不可能依赖）首次运行时的 callback/deadline。
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));
          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.integrate.length, 1, "只补做被中断的 integrate");
          assert.equal(spy.calls.compile.length, 1);
        } finally {
          resumedStore.close();
        }
      });
    });

    it("runId/inputDigest 非空与 durationRange 基本合法在节点执行前校验", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts();
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: { ...baseInput(), runId: "" }, threadId: "unused" }),
            /runId must be a non-empty string/,
          );
          await assert.rejects(
            () => runCreativePlanning(graph, { input: { ...baseInput(), inputDigest: " " }, threadId: "unused" }),
            /inputDigest must be a non-empty string/,
          );
          for (const durationRange of [
            { minSeconds: 35, maxSeconds: 34 },
            { minSeconds: 20.5, maxSeconds: 34 },
            { minSeconds: 0, maxSeconds: 34 },
          ]) {
            const input = { ...baseInput(), durationRange };
            await assert.rejects(
              () => runCreativePlanning(graph, {
                input,
                threadId: planningThreadId(input.runId, input.inputDigest),
              }),
              /durationRange/,
            );
          }
          assert.equal(calls.treatment.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 11. 图库路线 port 合同：构建期验证，无图库不要求假 port
  // -------------------------------------------------------------------------

  describe("11 图库路线 port 合同", () => {
    it("searchCandidates 存在而 rank 或 integrateDirector 缺失时构建期明确抛错", () => {
      const complete = spyPorts({ withLibrary: true }).ports;
      const { rank: _rank, ...withoutRank } = complete;
      assert.throws(
        () => createCreativePlanningGraph({ ports: withoutRank as CreativePlanningPorts }),
        /requires both the rank and integrateDirector ports/,
      );
      const { integrateDirector: _integrate, ...withoutIntegrate } = complete;
      assert.throws(
        () => createCreativePlanningGraph({ ports: withoutIntegrate as CreativePlanningPorts }),
        /requires both the rank and integrateDirector ports/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 12. rank 产物合同：进入 availability reviewer 前校验
  // -------------------------------------------------------------------------

  describe("12 rank 产物合同（P05）", () => {
    it("排序漏 scene 时在 reviewer/integrate/compile 之前 fail closed", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const broken = rankingFixture();
          broken.scenes = broken.scenes.slice(0, 2);
          const { ports, calls } = spyPorts({ withLibrary: true, rankingOutputs: [broken] });
          const reviewerCalls: unknown[] = [];
          const reviewer: AvailabilityReviewer = (input) => {
            reviewerCalls.push(input);
            return [];
          };
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /Asset ranking must cover every candidate scene/,
          );
          assert.equal(reviewerCalls.length, 0, "排序违约必须在 availability reviewer 之前拒绝");
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("模型凭空锁定候选时 fail closed（人工 lock 仍属宿主 override 边界，不在图内授予）", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const locked = rankingFixture();
          locked.scenes[0]!.candidates[0]!.locked = true;
          const { ports, calls } = spyPorts({ withLibrary: true, rankingOutputs: [locked] });
          const reviewerCalls: unknown[] = [];
          const reviewer: AvailabilityReviewer = (input) => {
            reviewerCalls.push(input);
            return [];
          };
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /cannot lock candidates/,
          );
          assert.equal(reviewerCalls.length, 0);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 13. 排序证据身份：候选获取身份与排序实际输入身份分离
  // -------------------------------------------------------------------------

  describe("13 排序证据身份（P05）", () => {
    it("script 画面语义变化但 stock 检索词与 Provider 未变：复用候选，但旧排序不得继续充当当前证据", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 第二版稿件改变第 2 段画面语义；重建导演方案只改写说明字段，检索词与 Provider 不变。
            scriptOutputs: [scriptFixture(), scriptV2Fixture()],
            directorOutputs: [directorPlanFixture(), reworkedRationalePlan()],
            // 排序替身按输入内容分支：只有当前稿件是 v2 时第 2 镜语义分低于自动采用阈值。
            rankScoresFromContext: (context) =>
              context.script?.output.scenes[1]?.visual_prompt.includes("（v2）")
                ? { 2: AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM - 1 }
                : {},
          });
          // 复检替身同样按输入内容分支：v1 稿件上报 script 责任问题；v2 稿件交给默认确定性规则。
          const reviewer: AvailabilityReviewer = (input) =>
            input.script.scenes[1]?.visual_prompt.includes("（v2）")
              ? defaultAvailabilityReviewer(input)
              : [directorIssue({
                id: "issue-script-v1",
                target: "script",
                beatIds: ["beat-2"],
                reason: "第 2 段画面语义与证据口径不匹配",
                requiredChange: "重写第 2 段画面语义",
              })];
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          // 旧排序（第 2 镜 80 分可用）若仍被当作当前证据，v2 复检会直接整合编译而不是发现可得性问题。
          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          assert.deepEqual(outcome.halt.issueIds, ["asset-availability-scene-2"]);
          assert.equal(calls.treatment.length, 1);
          assert.equal(calls.script.length, 2, "script 责任问题必须重跑编剧");
          assert.equal(calls.director.length, 3, "script 变更重建方案 + 可得性问题重修方案");
          assert.equal(calls.search.length, 1, "候选获取身份未变（检索词/Provider）不得重搜");
          assert.equal(calls.rank.length, 2, "排序实际输入已变，旧排序失效必须重排");
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
          assert.equal(outcome.state.crossRoleRevisions, 2);
        } finally {
          store.close();
        }
      });
    });

    it("对照：script/director 重跑但内容未变（排序实际输入未变）不重搜不重排", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const issue = directorIssue({ id: "issue-script-repeat", target: "script", beatIds: ["beat-2"], reason: "旁白与证据不匹配" });
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 稿件队列耗尽后回落到同一 fixture：重跑编剧输出内容未变。
            scriptOutputs: [scriptFixture()],
            directorOutputs: [directorPlanFixture()],
          });
          const { reviewer } = queuedReviewer([[issue], [issue]]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "duplicate_issue");
          assert.equal(calls.script.length, 2);
          assert.equal(calls.director.length, 2);
          assert.equal(calls.search.length, 1, "实际输入未变不得重搜");
          assert.equal(calls.rank.length, 1, "排序实际输入未变不得重排");
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 14. 必需图库镜头覆盖：candidate report 与 ranking 同时漏镜头时 fail closed
  // -------------------------------------------------------------------------

  describe("14 必需图库镜头覆盖（P05 关联合同）", () => {
    it("当前方案要求的图库镜头同时缺失于 report 与 ranking：在 reviewer/integrate/compile 前 fail closed", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          // 搜索替身从方案投影报告时丢掉第 2 镜，排序又按报告投影：report 与 ranking 一致地漏掉该镜头。
          const { ports, calls } = spyPorts({ withLibrary: true, dropReportScene: 2 });
          const reviewerCalls: unknown[] = [];
          const reviewer: AvailabilityReviewer = (input) => {
            reviewerCalls.push(input);
            return [];
          };
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /required stock scene 2 is missing from the candidate report/,
          );
          // 关联合同错误不得进入责任路由：reviewer 看不到该输入，更不能整合编译。
          assert.equal(reviewerCalls.length, 0, "覆盖缺失必须在 availability reviewer 之前失败");
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("对照：镜头存在但候选为空走既有 director 责任路由，不判关联合同错误", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({ withLibrary: true, emptyCandidatesAtScene: 2 });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          // 第 2 镜在报告与排序中都存在但候选为空：先按导演责任重修；第二轮仍不可得时转人工素材门禁。
          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          assert.equal(calls.director.length, 2);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("candidate report 的检索词与当前方案镜头不一致：关联合同错误 fail closed", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            reportQueryOverride: { scenePosition: 2, query: "mismatched-report-query-2" },
          });
          const reviewerCalls: unknown[] = [];
          const reviewer: AvailabilityReviewer = (input) => {
            reviewerCalls.push(input);
            return [];
          };
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /does not match the current plan query/,
          );
          assert.equal(reviewerCalls.length, 0);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 15. 整合出口检查：integratedPlan 不得改写候选身份或绕过可得性复检
  // -------------------------------------------------------------------------

  describe("15 整合出口检查（P05/P06）", () => {
    it("整合改写 stock 检索词：旧候选/排序证据不能直接编译，明确失败", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            integrateTransform: (plan) => {
              const changed = JSON.parse(JSON.stringify(plan)) as VisualDirectorPlan;
              changed.shots[1]!.query = "integrated-query-2";
              return changed;
            },
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /changes the candidate\/ranking evidence identity for scene 2/,
          );
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("整合改写 Provider 路由：同样不能沿用旧证据直接编译", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            integrateTransform: (plan) => {
              const changed = JSON.parse(JSON.stringify(plan)) as VisualDirectorPlan;
              changed.shots[1]!.preferredProviderId = "pixabay";
              return changed;
            },
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /changes the candidate\/ranking evidence identity for scene 2/,
          );
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("整合把生成镜头改回图库（新增图库依赖）：无候选证据覆盖，明确失败", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 草案第 3 镜走生成路线：搜索与排序只覆盖第 1、2 镜。
            directorOutputs: [directorPlanFixture({ sceneThreeDeliveryType: "generated_video" })],
            integrateTransform: (plan) => {
              const changed = JSON.parse(JSON.stringify(plan)) as VisualDirectorPlan;
              changed.shots[2]!.deliveryType = "stock_video";
              return changed;
            },
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
            /changes the candidate\/ranking evidence identity for scene 3/,
          );
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("整合重新引入不可用路线：修复重修后可收敛编译（有界回退内完成）", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 重修方案只改写说明字段：候选获取身份未变（不重搜），排序输入变化（重排）。
            directorOutputs: [directorPlanFixture(), reworkedRationalePlan()],
          });
          const issue = directorIssue({ id: "issue-integrated-1", reason: "整合方案第 2 镜候选不可用" });
          const { reviewer } = queuedReviewer([[], [issue], [], []]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(outcome.state.stage, "compile");
          assert.equal(calls.director.length, 2);
          assert.equal(calls.integrate.length, 2);
          assert.equal(calls.search.length, 1);
          assert.equal(calls.rank.length, 2, "重修改变排序实际输入后必须重排");
          assert.equal(calls.compile.length, 1);
          assert.equal(outcome.state.crossRoleRevisions, 1);
        } finally {
          store.close();
        }
      });
    });

    it("整合后同一问题原样再次出现：duplicate_issue 停止，不进入整合-复检循环", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // 重修方案内容与草案一致：问题不会被解决。
            directorOutputs: [directorPlanFixture()],
          });
          const issue = directorIssue({ id: "issue-integrated-repeat", reason: "整合方案第 2 镜候选不可用" });
          const { reviewer } = queuedReviewer([[], [issue], [issue]]);
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver, availabilityReviewer: reviewer });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "duplicate_issue");
          assert.deepEqual(outcome.halt.issueIds, [issue.id]);
          assert.equal(calls.director.length, 2);
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.rank.length, 1);
          assert.equal(calls.compile.length, 0);
          assert.equal(outcome.state.crossRoleRevisions, 1);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 16. 失效状态的 SQLite 恢复：恢复不得把旧排序当当前证据
  // -------------------------------------------------------------------------

  describe("16 失效状态的 SQLite 恢复（P07）", () => {
    it("script 回退重排前中断：恢复复用候选不重搜，但必须重排并绑定新排序证据", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);

        // 首跑：草案复检上报 script 责任问题 → 稿件改写为 v2 → 重修导演方案时中断。
        // 此时 checkpoint 里留着 v1 语义下的旧排序与可复用的候选报告。
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({
            withLibrary: true,
            scriptOutputs: [scriptFixture(), scriptV2Fixture()],
            failDirectorAtCall: 2,
          });
          const reviewer: AvailabilityReviewer = (input) =>
            input.script.scenes[1]?.visual_prompt.includes("（v2）")
              ? []
              : [directorIssue({
                id: "issue-script-v1",
                target: "script",
                beatIds: ["beat-2"],
                reason: "第 2 段画面语义与证据口径不匹配",
                requiredChange: "重写第 2 段画面语义",
              })];
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: firstStore.saver, availabilityReviewer: reviewer });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_inside_director_rework/,
          );
          assert.equal(spy.calls.script.length, 2);
          assert.equal(spy.calls.rank.length, 1);
        } finally {
          firstStore.close();
        }

        // 同一 SQLite/thread 恢复：补做重修导演 → 重排（v2 语义，第 2 镜 39 分）→ 复检 → 整合 → 编译。
        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({
            withLibrary: true,
            directorOutputs: [reworkedRationalePlan()],
            rankScoresFromContext: (context) =>
              context.script?.output.scenes[1]?.visual_prompt.includes("（v2）") ? { 2: 39 } : {},
          });
          const reviewerContexts: Array<{ ranking: { output: AssetSemanticRanking } | null }> = [];
          const reviewer: AvailabilityReviewer = (input) => {
            reviewerContexts.push({ ranking: input.ranking ? { output: input.ranking.output } : null });
            return [];
          };
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver, availabilityReviewer: reviewer });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.director.length, 1, "只补做被中断的导演重修");
          assert.equal(spy.calls.search.length, 0, "候选获取身份未变：恢复不得重搜");
          assert.equal(spy.calls.rank.length, 1, "排序实际输入已变：恢复必须重排，不得复用旧排序");
          assert.equal(spy.calls.integrate.length, 1);
          assert.equal(spy.calls.compile.length, 1);
          // 编译与复检绑定的是重排后的证据：第 2 镜 39 分来自恢复后对 v2 语义的新排序，
          // 而中断前旧排序里该镜是 80 分——恢复没有把旧证据当作当前结果。
          assert.equal(spy.calls.compile[0]!.ranking?.output.scenes[1]!.candidates[0]!.semanticScore, 39);
          assert.equal(reviewerContexts[0]?.ranking?.output.scenes[1]!.candidates[0]!.semanticScore, 39);
          assert.equal(outcome.state.crossRoleRevisions, 1, "恢复不得重置跨角色回退计数");
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 17. 整合证据身份：任何影响候选/排序/画面语义的整合变更都不得沿用旧证据
  // -------------------------------------------------------------------------

  describe("17 整合证据身份（P05）", () => {
    it("整合把 stock 镜头改为生成/说明卡/另一 stock 类型：旧候选与排序证据不得继续，明确失败", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const transitions = [
            { label: "stock_video→generated_video", deliveryType: "generated_video" as const },
            { label: "stock_video→editorial_card", deliveryType: "editorial_card" as const },
            { label: "stock_video→stock_image", deliveryType: "stock_image" as const },
          ];
          for (const transition of transitions) {
            const { ports, calls } = spyPorts({
              withLibrary: true,
              integrateTransform: (plan) => {
                const changed = JSON.parse(JSON.stringify(plan)) as VisualDirectorPlan;
                changed.shots[1]!.deliveryType = transition.deliveryType;
                return changed;
              },
            });
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
            const inputDigest = `${INPUT_DIGEST}-17-route-${transition.deliveryType}`;
            await assert.rejects(
              () => runCreativePlanning(graph, {
                input: { ...baseInput(), inputDigest },
                threadId: planningThreadId(RUN_ID, inputDigest),
              }),
              /changes the candidate\/ranking evidence identity for scene 2/,
            );
            assert.equal(calls.integrate.length, 1, transition.label);
            assert.equal(calls.compile.length, 0, transition.label);
          }
        } finally {
          store.close();
        }
      });
    });

    it("query 与 Provider 不变但主体/动作语义改变：不得携旧排序编译", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const mutations: Array<{ label: string; apply: (plan: VisualDirectorPlan) => void }> = [
            { label: "subject", apply: (plan) => { plan.shots[1]!.subject = "完全不同的主体"; } },
            { label: "visibleAction", apply: (plan) => { plan.shots[1]!.visibleAction = "完全不同的可见动作"; } },
          ];
          for (const mutation of mutations) {
            const { ports, calls } = spyPorts({
              withLibrary: true,
              integrateTransform: (plan) => {
                const changed = JSON.parse(JSON.stringify(plan)) as VisualDirectorPlan;
                mutation.apply(changed);
                return changed;
              },
            });
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
            const inputDigest = `${INPUT_DIGEST}-17-semantics-${mutation.label}`;
            await assert.rejects(
              () => runCreativePlanning(graph, {
                input: { ...baseInput(), inputDigest },
                threadId: planningThreadId(RUN_ID, inputDigest),
              }),
              /changes the candidate\/ranking evidence identity for scene 2/,
            );
            assert.equal(calls.integrate.length, 1, mutation.label);
            assert.equal(calls.compile.length, 0, mutation.label);
          }
        } finally {
          store.close();
        }
      });
    });

    it("排序意图字段（narrativeRole/generationPrompt/visualBible）改变：同样不得携旧证据", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const mutations: Array<{
            label: string;
            rejection: RegExp;
            apply: (plan: VisualDirectorPlan) => void;
          }> = [
            {
              label: "narrativeRole",
              rejection: /changes the candidate\/ranking evidence identity for scene 2/,
              apply: (plan) => { plan.shots[1]!.narrativeRole = "整合后重写的叙事角色"; },
            },
            {
              label: "generationPrompt",
              rejection: /changes the candidate\/ranking evidence identity for scene 2/,
              apply: (plan) => { plan.shots[1]!.generationPrompt = "整合后重写的生成提示"; },
            },
            {
              label: "visualBible",
              rejection: /changes plan-level creative contract fields/,
              apply: (plan) => { plan.visualBible.continuity = "整合后改写的连续性"; },
            },
          ];
          for (const mutation of mutations) {
            const { ports, calls } = spyPorts({
              withLibrary: true,
              integrateTransform: (plan) => {
                const changed = JSON.parse(JSON.stringify(plan)) as VisualDirectorPlan;
                mutation.apply(changed);
                return changed;
              },
            });
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
            const inputDigest = `${INPUT_DIGEST}-17-intent-${mutation.label}`;
            await assert.rejects(
              () => runCreativePlanning(graph, {
                input: { ...baseInput(), inputDigest },
                threadId: planningThreadId(RUN_ID, inputDigest),
              }),
              mutation.rejection,
            );
            assert.equal(calls.integrate.length, 1, mutation.label);
            assert.equal(calls.compile.length, 0, mutation.label);
          }
        } finally {
          store.close();
        }
      });
    });

    it("对照：只改 rationale（纯采用说明）的正常整合可以完成", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(outcome.state.stage, "compile");
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 1);
          assert.deepEqual(outcome.state.unresolvedIssueDigests, []);
          // 对照本身有意义：整合方案确实只改写了采用说明，其余字段与草案一致。
          const draftShot = calls.compile[0]!.directorPlan?.output.shots[1]!;
          const integratedShot = calls.compile[0]!.integratedPlan?.output.shots[1]!;
          assert.notEqual(integratedShot.rationale, draftShot.rationale);
          assert.equal(integratedShot.narrativeRole, draftShot.narrativeRole);
          assert.equal(integratedShot.subject, draftShot.subject);
          assert.equal(integratedShot.visibleAction, draftShot.visibleAction);
          assert.equal(integratedShot.generationPrompt, draftShot.generationPrompt);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 18. 未决问题 digest 跨阶段保留：同一整合问题第二次出现立即停止
  // -------------------------------------------------------------------------

  describe("18 未决问题 digest 跨阶段保留（P06）", () => {
    it("草案通过→整合问题 I→重修草案通过→同一整合问题 I：第二次立即 duplicate_issue，crossRoleRevisions=1", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({
            ports,
            checkpointer: store.saver,
            availabilityReviewer: integratedAvailabilityReviewer(() => false),
          });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "duplicate_issue");
          assert.deepEqual(outcome.halt.issueIds, ["issue-integrated-availability"]);
          assert.equal(outcome.state.crossRoleRevisions, 1, "同一整合问题第二次出现不再分配第二次回退");
          assert.equal(calls.director.length, 2, "草案 + 一次重修");
          assert.equal(calls.integrate.length, 2, "两次整合都产生了同一问题");
          assert.equal(calls.compile.length, 0);
          assert.deepEqual(outcome.state.unresolvedIssueDigests, [
            planningIssueDigest(directorIssue({
              id: "issue-integrated-availability",
              reason: "整合方案第 2 镜候选不可用",
              scenePositions: [2],
            })),
          ]);
        } finally {
          store.close();
        }
      });
    });

    it("整合问题 digest 跨 SQLite 关闭重开保留：恢复后同一整合问题仍 duplicate_issue", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          // 首跑：草案复检通过 → 整合方案复检报问题 I → 回退 → 重修导演方案时中断。
          // checkpoint 里留着已见问题 digest、crossRoleRevisions=1 与有效候选/排序证据。
          const spy = spyPorts({ withLibrary: true, failDirectorAtCall: 2 });
          const graph = createCreativePlanningGraph({
            ports: spy.ports,
            checkpointer: firstStore.saver,
            availabilityReviewer: integratedAvailabilityReviewer(() => false),
          });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_inside_director_rework/,
          );
          assert.equal(spy.calls.integrate.length, 1, "中断前整合方案已复检出问题 I");
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({
            ports: spy.ports,
            checkpointer: resumedStore.saver,
            availabilityReviewer: integratedAvailabilityReviewer(() => false),
          });
          const outcome = await runCreativePlanning(graph, { input: baseInput(), threadId });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "duplicate_issue");
          assert.equal(outcome.state.crossRoleRevisions, 1, "恢复不得因中间草案复检通过而忘记问题");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.rank.length, 0);
          assert.equal(spy.calls.director.length, 1, "只补做被中断的重修");
          assert.equal(spy.calls.integrate.length, 1);
          assert.equal(spy.calls.compile.length, 0);
        } finally {
          resumedStore.close();
        }
      });
    });

    it("对照：整合问题被导演真实修复（改写第 2 镜检索词）后整合/复检可以完成", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [
              directorPlanFixture(),
              directorPlanFixture({ sceneTwoQuery: "stock-query-2-reworked" }),
            ],
          });
          const graph = createCreativePlanningGraph({
            ports,
            checkpointer: store.saver,
            availabilityReviewer: integratedAvailabilityReviewer((plan) => plan.shots[1]!.query !== "stock-query-2"),
          });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(outcome.state.stage, "compile");
          assert.equal(calls.director.length, 2);
          assert.equal(calls.search.length, 2, "真实修复改写检索词后必须重搜");
          assert.equal(calls.rank.length, 2);
          assert.equal(calls.integrate.length, 2);
          assert.equal(calls.compile.length, 1);
          assert.equal(outcome.state.crossRoleRevisions, 1);
          // 整合方案复检确认无问题并编译时，此前问题 digest 才被消解。
          assert.deepEqual(outcome.state.unresolvedIssueDigests, []);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 19. 复用镜头可得性：合法复用继承母片根，非法复用关系 fail closed
  // -------------------------------------------------------------------------

  describe("19 复用镜头可得性（P05）", () => {
    it("把模型协议中的 null 复用根视为未设置，并保留后续镜头的合法母片复用", async () => {
      const plan = reuseDirectorPlanFixture();
      Object.assign(plan.shots[0]!, { reuseFromScenePosition: null });

      const compiled = await executablePlanCompilePort({
        runId: RUN_ID,
        inputDigest: `${INPUT_DIGEST}-19-null-root`,
        base: { ...baseInput(), inputDigest: `${INPUT_DIGEST}-19-null-root` },
        stage: "compile",
        issues: [],
        treatment: { artifactId: "treatment:null-root", output: treatmentFixture() },
        script: { artifactId: "script:null-root", output: scriptFixture() },
        directorPlan: { artifactId: "director:null-root", output: plan },
        candidates: null,
        ranking: null,
        integratedPlan: null,
        availabilityHistory: [],
      });

      assert.equal(compiled.output.cuts[0]!.assetKey, "asset-scene-1");
      assert.equal(compiled.output.cuts[1]!.assetKey, "asset-scene-1");
    });

    it("stock 母片有高分候选 + 合法复用镜头自身候选为空：不产生错误 director 回退并完成", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [reuseDirectorPlanFixture()],
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(outcome.state.stage, "compile");
          assert.equal(calls.director.length, 1, "合法复用不得触发错误回退");
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 1);
          assert.equal(outcome.state.crossRoleRevisions, 0);
          assert.deepEqual(outcome.state.issues, []);
          // 复用关系保留到正式编译输入（compile 的复用根解析沿用 A 阶段合同）。
          assert.equal(calls.compile[0]!.integratedPlan?.output.shots[1]!.reuseFromScenePosition, 1);
        } finally {
          store.close();
        }
      });
    });

    it("普通非复用 stock 镜头候选为空仍走 director 责任路由；合法复用镜头不重复上报", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [reuseDirectorPlanFixture()],
            emptyCandidatesAtScene: 3,
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          // 只有第 3 镜（独立 stock、候选为空）承担问题；复用第 1 镜的第 2 镜不重复背锅。
          assert.deepEqual(outcome.halt.issueIds, ["asset-availability-scene-3"]);
          assert.equal(outcome.state.issues.length, 1);
          assert.deepEqual(outcome.state.issues[0]!.scenePositions, [3]);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("复用根缺失/向后/自环：确定性 fail closed，不伪装成质量问题", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const cases: Array<{ label: string; reuseFrom: number; rejection: RegExp }> = [
            { label: "missing-root", reuseFrom: 9, rejection: /which is missing from the plan/ },
            { label: "backward-root", reuseFrom: 3, rejection: /must reuse an earlier scene, received 3/ },
            { label: "self-cycle", reuseFrom: 2, rejection: /reuse cycle involving scene 2/ },
          ];
          for (const testCase of cases) {
            const plan = reuseDirectorPlanFixture();
            plan.shots[1]!.reuseFromScenePosition = testCase.reuseFrom;
            const { ports, calls } = spyPorts({ withLibrary: true, directorOutputs: [plan] });
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
            const inputDigest = `${INPUT_DIGEST}-19-invalid-${testCase.label}`;
            await assert.rejects(
              () => runCreativePlanning(graph, {
                input: { ...baseInput(), inputDigest },
                threadId: planningThreadId(RUN_ID, inputDigest),
              }),
              testCase.rejection,
            );
            assert.equal(calls.integrate.length, 0, testCase.label);
            assert.equal(calls.compile.length, 0, testCase.label);
          }
        } finally {
          store.close();
        }
      });
    });

    it("复用根不可用（母片候选为空）：由根镜头承担问题，复用镜头不重复上报", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [reuseDirectorPlanFixture()],
            emptyCandidatesAtScene: 1,
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = await runCreativePlanning(graph, {
            input: baseInput(),
            threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
          });

          assert.equal(outcome.status, "halted");
          assert.equal(outcome.halt.reason, "needs_source");
          // 母片第 1 镜自身候选不可用承担问题；复用它的第 2 镜不重复上报。
          assert.deepEqual(outcome.halt.issueIds, ["asset-availability-scene-1"]);
          assert.equal(outcome.state.issues.length, 1);
          assert.equal(calls.integrate.length, 0);
          assert.equal(calls.compile.length, 0);
        } finally {
          store.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 20. 复用关系变化的证据依赖身份：候选获取身份覆盖复用，恢复不丢依赖身份
  // -------------------------------------------------------------------------

  describe("20 复用关系变化与恢复（P05/P07）", () => {
    it("独立 stock 镜头改为复用：候选获取身份变化必须重搜，旧候选报告不得继续", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            // v1：第 1 镜机位待修（复检反馈来源）、第 3 镜独立 stock；v2：机位修复且第 3 镜改为复用第 1 镜。
            directorOutputs: [cameraReusePlanFixture(false), cameraReusePlanFixture(true)],
          });
          const graph = createCreativePlanningGraph({
            ports,
            checkpointer: store.saver,
            availabilityReviewer: cameraFeedbackReviewer(),
          });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(outcome.state.stage, "compile");
          assert.equal(calls.director.length, 2);
          assert.equal(calls.search.length, 2, "复用关系改变候选获取身份，必须重搜");
          assert.equal(calls.rank.length, 2);
          assert.equal(calls.integrate.length, 1);
          assert.equal(calls.compile.length, 1);
          assert.equal(outcome.state.crossRoleRevisions, 1);
          // 第二次搜索确实以“第 3 镜复用第 1 镜”的方案为输入，编译绑定的是新候选证据：
          // 新报告里第 3 镜（复用）候选为空，旧报告（独立 stock）里它带候选。
          assert.equal(calls.search[1]!.directorPlan?.output.shots[2]!.reuseFromScenePosition, 1);
          assert.deepEqual(outcome.state.artifactIds.candidates, ["candidates:2"]);
          const sceneThree = calls.compile[0]!.candidates?.output.scenes
            .find((scene) => scene.scenePosition === 3);
          assert.equal(sceneThree?.candidates.length, 0);
        } finally {
          store.close();
        }
      });
    });

    it("复用关系变化后中断重修：SQLite 恢复后依赖身份仍在，必须重搜而非沿用旧报告", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          // 首跑：v1 草案复检上报第 1 镜机位问题 → 回退 → 重修导演方案（改为复用）时中断。
          const spy = spyPorts({
            withLibrary: true,
            directorOutputs: [cameraReusePlanFixture(false)],
            failDirectorAtCall: 2,
          });
          const graph = createCreativePlanningGraph({
            ports: spy.ports,
            checkpointer: firstStore.saver,
            availabilityReviewer: cameraFeedbackReviewer(),
          });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_inside_director_rework/,
          );
          assert.equal(spy.calls.search.length, 1);
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({
            withLibrary: true,
            directorOutputs: [cameraReusePlanFixture(true)],
          });
          const graph = createCreativePlanningGraph({
            ports: spy.ports,
            checkpointer: resumedStore.saver,
            availabilityReviewer: cameraFeedbackReviewer(),
          });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.director.length, 1, "只补做被中断的重修");
          // 依赖身份跨 checkpoint 保留：重修引入复用后必须重搜，不得沿用旧候选报告。
          assert.equal(spy.calls.search.length, 1, "恢复后候选获取身份变化必须重搜");
          assert.equal(spy.calls.rank.length, 1);
          assert.equal(spy.calls.integrate.length, 1);
          assert.equal(spy.calls.compile.length, 1);
          // 编译绑定的是恢复后重搜的新报告：第 3 镜（复用）候选为空，而不是中断前带候选的旧报告。
          const resumedSceneThree = spy.calls.compile[0]!.candidates?.output.scenes
            .find((scene) => scene.scenePosition === 3);
          assert.equal(resumedSceneThree?.candidates.length, 0);
          assert.deepEqual(outcome.state.artifactIds.candidates, [spy.calls.compile[0]!.candidates?.artifactId]);
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 21. port 边界隔离与 REUSE_ONLY 等价绑定：共享别名不得污染已接受证据
  // -------------------------------------------------------------------------

  describe("21 port 边界隔离与 REUSE_ONLY 等价绑定（P05/P07）", () => {
    it("integrateDirector 原地改写传入 context.directorPlan.output 并原样返回：必须在 compile 前拒绝，已接受证据未被污染", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
          const spy = spyPorts({ withLibrary: true });
          const malicious: CreativePlanningPorts = {
            ...spy.ports,
            integrateDirector: async (context) => {
              // 若 context 与 graph state 共享对象别名，baseline（草案）与返回 output 同时被
              // 污染，证据身份比较会自我通过并携旧 ranking 编译。
              const draft = context.directorPlan!;
              draft.output.shots[1]!.subject = "被 port 原地改写的主体";
              draft.output.shots[1]!.visibleAction = "被 port 原地改写的动作";
              return { artifactId: "integrate:malicious", output: draft.output };
            },
          };
          const graph = createCreativePlanningGraph({ ports: malicious, checkpointer: store.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /changes the candidate\/ranking evidence identity for scene 2/,
          );
          assert.equal(spy.calls.integrate.length, 0, "恶意 port 不经 spy 计数（独立注入）");
          assert.equal(spy.calls.compile.length, 0);

          // 已接受的草案/稿件/候选/排序证据在 checkpoint 中保持原样，未被 port 改写。
          const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
          const values = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
          assert.equal(values.directorPlan?.output.shots[1]!.subject, undefined);
          assert.equal(values.directorPlan?.output.shots[1]!.visibleAction, undefined);
          assert.equal(values.scriptArtifact?.output.scenes[0]!.narration, "第1段旁白内容");
          assert.equal(values.candidatesArtifact?.artifactId, "candidates:1");
          assert.equal(values.ranking?.artifactId, "ranking:1");
          assert.equal(values.integratedPlan, null);
        } finally {
          store.close();
        }
      });
    });

    it("port 原地污染后抛错：同 SQLite/thread 恢复，已完成节点不被污染也不重复", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const malicious: CreativePlanningPorts = {
            ...spy.ports,
            integrateDirector: async (context) => {
              context.directorPlan!.output.shots[0]!.rationale = "被 port 原地污染的说明";
              context.script!.output.scenes[0]!.narration = "被 port 原地污染的旁白";
              throw new Error("SIMULATED_INTERRUPTION_after_pollution");
            },
          };
          const graph = createCreativePlanningGraph({ ports: malicious, checkpointer: firstStore.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_after_pollution/,
          );
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.director.length, 0);
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.rank.length, 0);
          assert.equal(spy.calls.integrate.length, 1, "只补做被中断的整合");
          assert.equal(spy.calls.compile.length, 1);
          // 恢复后消费的已接受证据是原始内容，不是 port 污染过的对象。
          assert.equal(spy.calls.compile[0]!.script?.output.scenes[0]!.narration, "第1段旁白内容");
          assert.equal(spy.calls.compile[0]!.directorPlan?.output.shots[0]!.rationale, "测试");
        } finally {
          resumedStore.close();
        }
      });
    });

    it("port 在成功返回的节点中原地污染已接受证据（编译前中断）：恢复后 checkpoint 不含污染", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          // 整合 port 原地改写已接受的稿件旁白后返回合法整合方案：若 context 与 state 共享
          // 别名，污染会随 integrate/evaluate 的成功 checkpoint 落库；编译首调抛错制造中断。
          const spy = spyPorts({ withLibrary: true, failCompileFirstCall: true });
          const malicious: CreativePlanningPorts = {
            ...spy.ports,
            integrateDirector: async (context) => {
              context.script!.output.scenes[0]!.narration = "被 port 原地污染的旁白";
              return { artifactId: "integrate:1", output: integratedPlanFromDraft(context.directorPlan!.output) };
            },
          };
          const graph = createCreativePlanningGraph({ ports: malicious, checkpointer: firstStore.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_inside_compile/,
          );
          // 中断发生在 compile 首调：恶意 integrate 已成功返回（不经 spy 计数），污染若存在已
          // 随 integrate/evaluate 的成功 checkpoint 落库。
          assert.equal(spy.calls.compile.length, 1, "中断发生在 compile 首调");
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.integrate.length, 0, "整合已完成，恢复不得重复");
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.rank.length, 0);
          assert.equal(spy.calls.compile.length, 1);
          // 恢复后编译消费的稿件是原始内容——污染没有进入任何已落库 checkpoint。
          assert.equal(spy.calls.compile[0]!.script?.output.scenes[0]!.narration, "第1段旁白内容");
        } finally {
          resumedStore.close();
        }
      });
    });

    it("显式 reuse 与 query 的 REUSE_ONLY 数字/词形编码：正式 executable plan 绑定同一 stock 母片", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const forms: ReuseForm[] = ["explicit", "query-numeric", "query-word"];
          for (const form of forms) {
            const { ports } = spyPorts({
              withLibrary: true,
              directorOutputs: [reuseFormPlanFixture(form)],
            });
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
            const inputDigest = `${INPUT_DIGEST}-21-form-${form}`;
            const outcome = completedOutcome(
              await runCreativePlanning(graph, {
                input: { ...baseInput(), inputDigest },
                threadId: planningThreadId(RUN_ID, inputDigest),
              }),
            );

            const cuts = outcome.executablePlan.output.cuts;
            assert.equal(cuts[0]!.assetKey, "asset-scene-1", form);
            // 三种表达形式都必须把第 2 镜绑到同一母片 assetKey，并保留 sourceInSeconds 语义。
            assert.equal(cuts[1]!.assetKey, "asset-scene-1", form);
            assert.equal(cuts[1]!.sourceInFrame, 120, form);
            assert.equal(cuts[2]!.assetKey, "asset-scene-3", form);
          }
        } finally {
          store.close();
        }
      });
    });

    it("整合删除冗余显式复用字段（query 仍编码 REUSE_ONLY）：整合被接受且母片绑定不变", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts({
            withLibrary: true,
            directorOutputs: [reuseExplicitWithQueryPlanFixture()],
            integrateTransform: (plan) => {
              const changed = JSON.parse(JSON.stringify(plan)) as VisualDirectorPlan;
              // 删除冗余显式字段：复用关系只剩 query 编码，不应丢失母片绑定。
              delete changed.shots[1]!.reuseFromScenePosition;
              return changed;
            },
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          assert.equal(outcome.state.stage, "compile");
          assert.equal(calls.integrate.length, 1, "调用次数不变，整合仍被接受");
          assert.equal(calls.compile[0]!.integratedPlan?.output.shots[1]!.reuseFromScenePosition, undefined);
          const cuts = outcome.executablePlan.output.cuts;
          assert.equal(cuts[1]!.assetKey, "asset-scene-1");
          assert.equal(cuts[1]!.sourceInFrame, 120);
        } finally {
          store.close();
        }
      });
    });

    it("生成母片复用链（显式 + query 编码链式）：全部镜头解析到同一有效根", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports } = spyPorts({
            withLibrary: true,
            directorOutputs: [generatedReuseChainPlanFixture()],
          });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const outcome = completedOutcome(
            await runCreativePlanning(graph, {
              input: baseInput(),
              threadId: planningThreadId(RUN_ID, INPUT_DIGEST),
            }),
          );

          const cuts = outcome.executablePlan.output.cuts;
          assert.equal(cuts[0]!.assetKey, "asset-scene-1");
          assert.equal(cuts[1]!.assetKey, "asset-scene-1", "显式复用绑定生成母片");
          assert.equal(cuts[1]!.sourceInFrame, 120);
          assert.equal(cuts[2]!.assetKey, "asset-scene-1", "query 编码链式复用解析到同一有效根");
          assert.equal(cuts[2]!.sourceInFrame, 180);
        } finally {
          store.close();
        }
      });
    });

    it("query-only 复用经 SQLite 恢复：已完成 search/rank 不重复，母片绑定不丢", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({
            withLibrary: true,
            directorOutputs: [reuseFormPlanFixture("query-numeric")],
            failIntegrateFirstCall: true,
          });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: firstStore.saver });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_inside_integrate/,
          );
          assert.equal(spy.calls.search.length, 1);
          assert.equal(spy.calls.rank.length, 1);
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.search.length, 0, "恢复不得重复搜索");
          assert.equal(spy.calls.rank.length, 0, "恢复不得重复排序");
          assert.equal(spy.calls.integrate.length, 1);
          assert.equal(spy.calls.compile.length, 1);
          const cuts = outcome.executablePlan.output.cuts;
          assert.equal(cuts[1]!.assetKey, "asset-scene-1", "恢复后 query 编码复用仍绑定母片");
          assert.equal(cuts[1]!.sourceInFrame, 120);
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 22. 可注入 AvailabilityReviewer 的边界隔离：只能看隔离快照，不得改写图拥有的证据
  // -------------------------------------------------------------------------

  describe("22 reviewer 输入隔离（P05/P07）", () => {
    it("reviewer 原地改写 script/director/ranking 并返回空：编译前中断恢复后，后续 compile 只看到原 accepted artifacts", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true, failCompileFirstCall: true });
          const maliciousReviewer: AvailabilityReviewer = (input) => {
            // 若 reviewer 收到的是 state 拥有的引用，污染会随 evaluate 的成功 checkpoint 落库，
            // integrate 在污染后的画面语义上自我通过，compile 携旧 ranking 消费变更内容。
            input.directorPlan.shots[1]!.subject = "被 reviewer 原地改写的主体";
            input.directorPlan.shots[1]!.visibleAction = "被 reviewer 原地改写的动作";
            input.script.scenes[0]!.narration = "被 reviewer 原地污染的旁白";
            if (input.ranking) {
              input.ranking.output.scenes[1]!.candidates[0]!.semanticScore = 100;
            }
            return [];
          };
          const graph = createCreativePlanningGraph({
            ports: spy.ports,
            checkpointer: firstStore.saver,
            availabilityReviewer: maliciousReviewer,
          });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_inside_compile/,
          );
          assert.equal(spy.calls.integrate.length, 1, "两轮复检都被放行，整合已完成");
          assert.equal(spy.calls.compile.length, 1, "中断发生在 compile 首调");
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.director.length, 0);
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.rank.length, 0);
          assert.equal(spy.calls.integrate.length, 0, "整合已完成，恢复不得重复");
          assert.equal(spy.calls.compile.length, 1);
          // 检查后续 compile 实际消费的内容（不是 reviewer 收到的副本）：
          // 稿件旁白、草案/整合方案画面语义、排序分数都保持原始 accepted 值。
          assert.equal(spy.calls.compile[0]!.script?.output.scenes[0]!.narration, "第1段旁白内容");
          assert.equal(spy.calls.compile[0]!.directorPlan?.output.shots[1]!.subject, undefined);
          assert.equal(spy.calls.compile[0]!.integratedPlan?.output.shots[1]!.visibleAction, undefined);
          assert.equal(spy.calls.compile[0]!.ranking?.output.scenes[1]!.candidates[0]!.semanticScore, 80);
        } finally {
          resumedStore.close();
        }
      });
    });

    it("守护：reviewer 原地污染后抛错：同 SQLite/thread 恢复，已完成节点不被污染也不重复", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const maliciousReviewer: AvailabilityReviewer = (input) => {
            input.directorPlan.shots[0]!.rationale = "被 reviewer 原地污染的说明";
            input.script.scenes[0]!.narration = "被 reviewer 原地污染的旁白";
            throw new Error("SIMULATED_INTERRUPTION_reviewer_pollution");
          };
          const graph = createCreativePlanningGraph({
            ports: spy.ports,
            checkpointer: firstStore.saver,
            availabilityReviewer: maliciousReviewer,
          });
          await assert.rejects(
            () => runCreativePlanning(graph, { input: baseInput(), threadId }),
            /SIMULATED_INTERRUPTION_reviewer_pollution/,
          );
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.treatment.length, 0);
          assert.equal(spy.calls.script.length, 0);
          assert.equal(spy.calls.director.length, 0);
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.rank.length, 0);
          assert.equal(spy.calls.integrate.length, 1, "只补做草案复检之后的整合");
          assert.equal(spy.calls.compile.length, 1);
          assert.equal(spy.calls.compile[0]!.script?.output.scenes[0]!.narration, "第1段旁白内容");
          assert.equal(spy.calls.compile[0]!.directorPlan?.output.shots[0]!.rationale, "测试");
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 23. 非有限剪辑源偏移 fail closed（B3-NONFINITE-OFFSET）：JSON 隔离不得把
  //     NaN/Infinity/-Infinity 静默改写成 null，再经 A 编译器的 ?? 0 变成 0 秒偏移
  // -------------------------------------------------------------------------

  describe("23 非有限剪辑源偏移 fail closed（B3-NONFINITE-OFFSET）", () => {
    const nonFiniteOffsets = [
      { label: "NaN", value: Number.NaN },
      { label: "Infinity", value: Number.POSITIVE_INFINITY },
      { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
    ] as const;

    /** 断言 run 以共享隔离边界的合同错误拒绝，错误点名非有限值与所在字段。 */
    async function assertIsolationRejects(
      graph: ReturnType<typeof createCreativePlanningGraph>,
      inputDigest: string,
      expectedValueLabel: string,
      expectedField: string,
    ): Promise<void> {
      const expected = `Creative planning isolation rejected non-finite number ${expectedValueLabel} at '${expectedField}'`;
      await assert.rejects(
        () => runCreativePlanning(graph, {
          input: { ...baseInput(), inputDigest },
          threadId: planningThreadId(RUN_ID, inputDigest),
        }),
        (error: Error) => {
          assert.ok(
            error.message.includes(expected),
            `unexpected error (expected to mention '${expected}'): ${error.message}`,
          );
          return true;
        },
      );
    }

    it("无图库固定路线：非法 sourceInSeconds 在隔离边界拒绝，不得编译成 0 秒偏移", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          for (const offset of nonFiniteOffsets) {
            const illegal = directorPlanFixture();
            illegal.shots[0]!.sourceInSeconds = offset.value;
            const { ports, calls } = spyPorts({ directorOutputs: [illegal] });
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
            const inputDigest = `${INPUT_DIGEST}-23-nolib-${offset.label}`;
            await assertIsolationRejects(graph, inputDigest, offset.label, "sourceInSeconds");

            // 不得产生 accepted 非法 director update，也不得抵达编译。
            assert.equal(calls.director.length, 1, offset.label);
            assert.equal(calls.compile.length, 0, offset.label);
            const snapshot = await graph.getState({ configurable: { thread_id: planningThreadId(RUN_ID, inputDigest) } });
            const values = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
            assert.equal(values.directorPlan, null, `${offset.label}: 非法 director 返回未被接受`);
            assert.equal(values.executablePlan, null, `${offset.label}: 不得生成可执行方案`);
          }
        } finally {
          store.close();
        }
      });
    });

    it("有图库合法复用路线：非法 sourceInSeconds 在隔离边界拒绝，不得变成母片零偏移请求", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          for (const offset of nonFiniteOffsets) {
            // 复用关系本身合法（第 2 镜复用第 1 镜 stock 母片）：非法的只有母片偏移数值。
            const illegal = reuseFormPlanFixture("explicit");
            illegal.shots[1]!.sourceInSeconds = offset.value;
            const { ports, calls } = spyPorts({ withLibrary: true, directorOutputs: [illegal] });
            const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
            const inputDigest = `${INPUT_DIGEST}-23-reuse-${offset.label}`;
            await assertIsolationRejects(graph, inputDigest, offset.label, "sourceInSeconds");

            assert.equal(calls.director.length, 1, offset.label);
            assert.equal(calls.search.length, 0, offset.label);
            assert.equal(calls.rank.length, 0, offset.label);
            assert.equal(calls.integrate.length, 0, offset.label);
            assert.equal(calls.compile.length, 0, offset.label);
            const snapshot = await graph.getState({ configurable: { thread_id: planningThreadId(RUN_ID, inputDigest) } });
            const values = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
            assert.equal(values.directorPlan, null, `${offset.label}: 非法 director 返回未被接受`);
            assert.equal(values.executablePlan, null, `${offset.label}: 不得生成零偏移母片请求`);
          }
        } finally {
          store.close();
        }
      });
    });

    it("共享隔离边界统一 fail closed：非 sourceInSeconds 数值字段（confidence）的非有限值同样拒绝", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          // confidence 不进入 compile 投影：若隔离只特判 sourceInSeconds，NaN 会被静默吞成
          // null 并照常完成——共享边界必须对任何非有限 number 一致拒绝。
          const illegal = directorPlanFixture();
          illegal.shots[0]!.confidence = Number.NaN;
          const { ports, calls } = spyPorts({ directorOutputs: [illegal] });
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const inputDigest = `${INPUT_DIGEST}-23-confidence-nan`;
          await assertIsolationRejects(graph, inputDigest, "NaN", "confidence");

          assert.equal(calls.compile.length, 0);
          const snapshot = await graph.getState({ configurable: { thread_id: planningThreadId(RUN_ID, inputDigest) } });
          const values = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
          assert.equal(values.directorPlan, null, "非有限 confidence 的 director 返回未被接受");
        } finally {
          store.close();
        }
      });
    });

    it("非法偏移拒绝后 SQLite 关闭重开恢复：已接受 artifacts 原样、已完成角色不重复、不落非法值或 0", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const illegal = reuseFormPlanFixture("explicit");
          illegal.shots[1]!.sourceInSeconds = Number.NaN;
          const spy = spyPorts({ withLibrary: true, directorOutputs: [illegal] });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: firstStore.saver });
          await assertIsolationRejects(graph, INPUT_DIGEST, "NaN", "sourceInSeconds");

          // 中断发生在 director 节点：构思/稿件已完成，非法方案确由导演 port 返回后被拒。
          assert.equal(spy.calls.treatment.length, 1);
          assert.equal(spy.calls.script.length, 1);
          assert.equal(spy.calls.director.length, 1);
          assert.equal(spy.calls.search.length, 0);
          assert.equal(spy.calls.integrate.length, 0);
          assert.equal(spy.calls.compile.length, 0);
          // checkpoint 只保留已接受的原始 artifacts：非法值与 0 都没有落库。
          const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
          const values = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
          assert.equal(values.directorPlan, null);
          assert.equal(values.executablePlan, null);
          assert.equal(values.scriptArtifact?.output.scenes[0]!.narration, "第1段旁白内容");
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts({ withLibrary: true, directorOutputs: [reuseFormPlanFixture("explicit")] });
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, { input: baseInput(), threadId }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(spy.calls.treatment.length, 0, "已完成构思不重复");
          assert.equal(spy.calls.script.length, 0, "已完成稿件不重复");
          assert.equal(spy.calls.director.length, 1, "只重做被拒绝的导演节点");
          assert.equal(spy.calls.search.length, 1);
          assert.equal(spy.calls.rank.length, 1);
          assert.equal(spy.calls.integrate.length, 1);
          assert.equal(spy.calls.compile.length, 1);
          // 恢复后合法复用绑定母片，偏移是 4 秒×30 帧，不是 0。
          const cuts = outcome.executablePlan.output.cuts;
          assert.equal(cuts[1]!.assetKey, "asset-scene-1", "恢复后复用仍绑定母片");
          assert.equal(cuts[1]!.sourceInFrame, 120, "恢复后偏移保持 4s×30，不得是 0");
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // 24. 入口输入快照防 TOCTOU（B3-INITIAL-INPUT-TOCTOU）：调用方在入口首个
  //     await 之后改写或替换 input，图只能消费入口已校验接受的 canonical 快照
  // -------------------------------------------------------------------------

  describe("24 入口输入快照防 TOCTOU（B3-INITIAL-INPUT-TOCTOU）", () => {
    const ACCEPTED_BASE = {
      runId: RUN_ID,
      inputDigest: INPUT_DIGEST,
      durationRange: DURATION_RANGE,
    };

    /** 调用方持有的独立可变 input：durationRange 必须是副本，不得污染共享 fixture。 */
    function independentCallerInput(): CreativePlanningInput {
      return { runId: RUN_ID, inputDigest: INPUT_DIGEST, durationRange: { ...DURATION_RANGE } };
    }

    async function checkpointValues(
      graph: ReturnType<typeof createCreativePlanningGraph>,
      threadId: string,
    ): Promise<Partial<PlanningGraphState>> {
      const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
      return (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
    }

    /** 断言入口接受的身份贯穿角色 context、outcome 与 checkpoint。 */
    function assertAcceptedIdentity(
      contexts: CreativePlanningContext[],
      outcomeInputDigest: string,
      values: Partial<PlanningGraphState>,
    ): void {
      for (const context of contexts) {
        assert.equal(context.runId, RUN_ID, "角色 context.runId 保持入口接受值");
        assert.equal(context.inputDigest, INPUT_DIGEST, "角色 context.inputDigest 保持入口接受值");
        assert.deepEqual(context.base, ACCEPTED_BASE, "角色 context.base 保持入口接受值");
      }
      assert.equal(outcomeInputDigest, INPUT_DIGEST, "outcome.state.inputDigest 保持入口接受值");
      assert.equal(values.runId, RUN_ID, "checkpoint runId 保持入口接受值");
      assert.equal(values.inputDigest, INPUT_DIGEST, "checkpoint inputDigest 保持入口接受值");
      assert.deepEqual(values.base, ACCEPTED_BASE, "checkpoint base 保持入口接受值");
    }

    it("调用方在入口首个 await 后原地改写 runId/inputDigest：不得把 B 输入写进 A 的 thread", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts();
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const callerInput = independentCallerInput();
          const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
          // runCreativePlanning 同步执行到首个 await（graph.getState）才把 pending 交还调用方；
          // 这里的同步改写发生在任何 await 续体（微任务）之前，必然落在入口校验之后、
          // initial state 构造之前的窗口内。
          const pending = runCreativePlanning(graph, { input: callerInput, threadId });
          callerInput.runId = "run-attacker-b";
          callerInput.inputDigest = "digest-attacker-b";
          const outcome = completedOutcome(await pending);

          assertAcceptedIdentity(
            [...calls.treatment, ...calls.compile],
            outcome.state.inputDigest,
            await checkpointValues(graph, threadId),
          );
        } finally {
          store.close();
        }
      });
    });

    it("调用方在入口首个 await 后原地改写嵌套 durationRange.maxSeconds：base 与可执行方案保持接受值", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts();
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const callerInput = independentCallerInput();
          const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
          const pending = runCreativePlanning(graph, { input: callerInput, threadId });
          callerInput.durationRange.maxSeconds = 40;
          const outcome = completedOutcome(await pending);

          assert.deepEqual(calls.treatment[0]!.base.durationRange, DURATION_RANGE, "首个角色 context 的 durationRange 保持接受值");
          assert.deepEqual(calls.compile[0]!.base.durationRange, DURATION_RANGE, "编译角色 context 的 durationRange 保持接受值");
          assert.deepEqual(outcome.executablePlan.output.durationRange, DURATION_RANGE, "可执行方案 durationRange 保持接受值");
          const values = await checkpointValues(graph, threadId);
          assert.deepEqual(values.base, ACCEPTED_BASE, "checkpoint base 保持入口接受值");
          assert.equal(values.runId, RUN_ID);
          assert.equal(values.inputDigest, INPUT_DIGEST);
        } finally {
          store.close();
        }
      });
    });

    it("调用方在入口首个 await 后整体替换 options.input 引用：图只消费入口已接受的快照", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        try {
          const { ports, calls } = spyPorts();
          const graph = createCreativePlanningGraph({ ports, checkpointer: store.saver });
          const callerInput = independentCallerInput();
          const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
          const options = { input: callerInput, threadId };
          const pending = runCreativePlanning(graph, options);
          options.input = {
            runId: "run-attacker-b",
            inputDigest: "digest-attacker-b",
            durationRange: { minSeconds: 20, maxSeconds: 40 },
          };
          const outcome = completedOutcome(await pending);

          assertAcceptedIdentity(
            [...calls.treatment, ...calls.compile],
            outcome.state.inputDigest,
            await checkpointValues(graph, threadId),
          );
          assert.deepEqual(outcome.executablePlan.output.durationRange, DURATION_RANGE, "可执行方案 durationRange 保持接受值");
        } finally {
          store.close();
        }
      });
    });

    it("改写尝试完成后 SQLite 关闭重开恢复：原 accepted input + 原 thread 返回原结果，已完成角色全部 0 次", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const threadId = planningThreadId(RUN_ID, INPUT_DIGEST);
        const firstStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts();
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: firstStore.saver });
          const callerInput = independentCallerInput();
          const options = { input: callerInput, threadId };
          const pending = runCreativePlanning(graph, options);
          callerInput.runId = "run-attacker-b";
          callerInput.inputDigest = "digest-attacker-b";
          callerInput.durationRange.maxSeconds = 40;
          const outcome = completedOutcome(await pending);

          assert.equal(spy.calls.treatment.length, 1);
          assertAcceptedIdentity(
            [...spy.calls.treatment, ...spy.calls.compile],
            outcome.state.inputDigest,
            await checkpointValues(graph, threadId),
          );
        } finally {
          firstStore.close();
        }

        const resumedStore = CreativePlanningStore.open(workspaceRoot);
        try {
          const spy = spyPorts();
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: resumedStore.saver });
          const outcome = completedOutcome(await runCreativePlanning(graph, {
            input: { runId: RUN_ID, inputDigest: INPUT_DIGEST, durationRange: { minSeconds: 20, maxSeconds: 34 } },
            threadId,
          }));

          assert.equal(outcome.state.stage, "compile");
          assert.equal(outcome.state.inputDigest, INPUT_DIGEST);
          assert.equal(spy.calls.treatment.length, 0, "已完成构思不重复");
          assert.equal(spy.calls.script.length, 0, "已完成稿件不重复");
          assert.equal(spy.calls.director.length, 0, "已完成导演不重复");
          assert.equal(spy.calls.compile.length, 0, "已完成编译不重复");
          // 恢复返回的是入口接受身份的同一结果，checkpoint 身份/base 未被 B 输入污染。
          assert.deepEqual(outcome.executablePlan.output.durationRange, DURATION_RANGE);
          const values = await checkpointValues(graph, threadId);
          assert.equal(values.runId, RUN_ID);
          assert.equal(values.inputDigest, INPUT_DIGEST);
          assert.deepEqual(values.base, ACCEPTED_BASE);
        } finally {
          resumedStore.close();
        }
      });
    });
  });

  describe("25 规划角色非局部处置", () => {
    it("把正式 role loop 的 needs_source 转成下游可见的建议，不再拦下这条制作", async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = CreativePlanningStore.open(workspaceRoot);
        let roleCheckpoint: unknown;
        let producerCalls = 0;
        let auditCalls = 0;
        try {
          const spy = spyPorts();
          spy.ports.treatment = async () => {
            const execution = await runRoleAgentLoop<CreativeTreatment>({
              role: "导演前期构思",
              planningRole: true,
              contractVersion: "creative-treatment-planning-disposition-v1",
              criteria: ["核心真实承诺必须有来源"],
              maxIterations: 3,
              checkpoint: {
                key: "creative-treatment-needs-source",
                load: async () => roleCheckpoint,
                save: async (value) => { roleCheckpoint = structuredClone(value); },
              },
              produce: async () => {
                producerCalls += 1;
                return { output: treatmentFixture() };
              },
              audit: async () => {
                auditCalls += 1;
                return { output: {
                  version: "video-factory/role-audit-v2",
                  rubricVersion: "video-factory/role-quality-rubric-v1",
                  verdict: "repair",
                  score: 91,
                  assessments: [{
                    targetPath: "",
                    dimensions: [
                      { dimension: "attention", score: 91, evidence: "开场给出具体对象。" },
                      { dimension: "progression", score: 91, evidence: "中段逐步给出结果。" },
                      { dimension: "payoff", score: 91, evidence: "结尾回答原承诺。" },
                      { dimension: "expression", score: 91, evidence: "表达具体可执行。" },
                    ],
                  }],
                  summary: "创作表达完整，但锁定的真实实测承诺缺少证据来源",
                  issues: [{
                    severity: "blocking",
                    criterion: "事实来源",
                    evidence: "当前输入没有专属实验记录，现有图库和生成能力不能证明真实结果",
                    repairInstruction: "请补充真实实验记录，或由用户确认改变承诺",
                  }],
                  repairInstructions: ["补充真实实验记录"],
                  planningDisposition: { action: "needs_source", issueIndexes: [0] },
                } };
              },
              validate: (value) => value as CreativeTreatment,
            });
            const advisories = planningSourceAdvisories(execution, "treatment");
            assert.equal(execution.agentLoop?.status, "awaiting_user");
            return {
              artifactId: "treatment:needs-source",
              output: execution.output,
              ...(advisories.length ? { advisories } : {}),
            };
          };
          const graph = createCreativePlanningGraph({ ports: spy.ports, checkpointer: store.saver });
          const input = { runId: RUN_ID, inputDigest: `${INPUT_DIGEST}-needs-source`, durationRange: DURATION_RANGE };
          const threadId = planningThreadId(input.runId, input.inputDigest);

          const first = await runCreativePlanning(graph, { input, threadId });
          // 来源缺口只出建议：制作继续往下走，缺口随 state.issues 交给下一个角色，创作者在确认关
          // 也能看到它。判不判得成是创作者的事，规则没有权力在这里把整条制作判停。
          assert.equal(first.status, "completed");
          assert.equal(producerCalls, 1);
          assert.equal(auditCalls, 1);
          assert.equal(spy.calls.script.length, 1);
          const delivered = spy.calls.script[0]?.issues ?? [];
          const sourceAdvice = delivered.find((issue) => issue.target === "source");
          assert.ok(sourceAdvice, "下游角色必须收到来源缺口这条建议");
          assert.match(sourceAdvice.requiredChange, /补充真实实验记录/);
          assert.match(sourceAdvice.reason, /事实来源/);

          const resumed = await runCreativePlanning(graph, { input, threadId });
          assert.equal(resumed.status, "completed");
          assert.equal(producerCalls, 1, "refresh/restart replay must not produce again");
          assert.equal(auditCalls, 1, "refresh/restart replay must not audit again");
        } finally {
          store.close();
        }
      });
    });
  });
});
