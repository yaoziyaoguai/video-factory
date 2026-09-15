// 跨进程合同测试：Studio 的真实 topic/script payload 构造 × Broker 的真实 parser/validator。
// 防止两端合同再次漂移（R2-ISSUE-001 与 script-draft 漂移同族）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTaskRequest } from "../src/codex-executor.js";
import { taskContractDescriptorFor } from "../src/task-definitions.js";
// 跨包相对导入（ts 运行时由 tsx 编译；不经过任何构建产物，杜绝 stale dist 假绿）。
import {
  CodexBridgeClient,
  REQUIRED_CODEX_TASK_CONTRACT_DIGESTS,
  type CodexTaskExecution,
  type CodexTaskKind,
} from "../../../packages/production-pipeline/src/codex-chat.js";
import { CodexCreativeTreatmentAgent } from "../../../packages/production-pipeline/src/codex-creative-treatment.js";
import { parseCreativeTreatment } from "../../../packages/production-pipeline/src/creative-treatment.js";
import { CodexScreenwriterAgent } from "../../../packages/production-pipeline/src/codex-screenwriter.js";
import { CodexVisualDirectorAgent } from "../../../packages/production-pipeline/src/codex-visual-director.js";
import {
  CodexVisualReviewAgent,
  type VisualReviewMediaPayload,
  type VisualReviewReport,
} from "../../../packages/production-pipeline/src/codex-visual-review.js";
import {
  summarizeProductionCapabilities,
  type ProductionCapabilities,
} from "../../../packages/production-pipeline/src/production-capabilities.js";
import type { VisualDirectorAgentInput } from "../../../packages/production-pipeline/src/visual-director.js";
import {
  TOPIC_IDEAS_STRATEGY_MAX_LENGTH,
  topicIdeasModelPayload,
} from "../../studio/src/server/topic-ideas-payload.js";
import { reviewedVideoModelCatalog } from "../../studio/src/server/video-provider-settings.js";
import { legalCreativeTreatmentOutput } from "./fixtures/creative-treatment.js";

const IDENTITY = {
  profileId: "openai",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  taskKinds: ["topic-ideas", "script-draft"],
} as const;

const CORE_IDENTITY = {
  profileId: "openai",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  taskKinds: ["creative-treatment", "script-draft", "director-plan", "role-audit"],
} as const;

function envelope(kind: string, payload: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId: `contract-probe-${kind}`,
    kind,
    payload,
    ...extra,
  };
}

const signal = {
  id: "sig-contract-1",
  sourceId: "newsnow" as const,
  platform: "weibo",
  rank: 1,
  title: "某地发布新消费补贴政策",
  collectedAt: "2026-09-12T01:00:00.000Z",
};

const strategy = {
  positioning: "把复杂热点转成普通人能看懂的短视频。",
  targetAudience: "通勤上班族",
  preferredDirections: "真实生活影响",
  excludedDirections: "纯娱乐八卦",
  sourcePolicy: "primary_or_two_independent" as const,
  customInstruction: "优先可实测题材。",
};

describe("topic-ideas cross-process contract (Studio builder × Broker parser)", () => {
  it("accepts the canonical Studio payload: only signals + strategy", () => {
    const { payload } = topicIdeasModelPayload([{ ...signal, relatedSignals: [] }], strategy);
    const task = parseTaskRequest(envelope("topic-ideas", payload, {
      expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest,
    }), IDENTITY);
    assert.equal(task.kind, "topic-ideas");
    assert.deepEqual(Object.keys(task.payload).sort(), ["signals", "strategy"]);
    const raw = task.payload as unknown as Record<string, unknown>;
    assert.equal("creatorStrategy" in raw, false);
    assert.equal("generationNonce" in raw, false);
    assert.match(raw.strategy as string, /内容定位：/);
  });

  it("keeps generationNonce out of the payload while varying the generation identity", () => {
    const first = topicIdeasModelPayload([{ ...signal, relatedSignals: [] }], strategy, "nonce-aaa");
    const second = topicIdeasModelPayload([{ ...signal, relatedSignals: [] }], strategy, "nonce-bbb");
    assert.deepEqual(first.payload, second.payload);
    assert.notEqual(first.generationNonce, second.generationNonce);
  });

  it("preserves maximum legal preference fields and enforces the shared 6000-character boundary", () => {
    const longStrategy = {
      ...strategy,
      positioning: "定".repeat(500),
      targetAudience: "人".repeat(500),
      preferredDirections: "优".repeat(1_000),
      excludedDirections: "避".repeat(1_000),
      customInstruction: "补".repeat(2_000),
    };
    const { payload } = topicIdeasModelPayload([{ ...signal, relatedSignals: [] }], longStrategy);
    const strategyText = (payload as { strategy: string }).strategy;
    assert.equal(strategyText.length <= TOPIC_IDEAS_STRATEGY_MAX_LENGTH, true);

    for (const marker of ["内容定位", "核心受众", "优先题材", "明确避开", "来源工作流", "补充原则"]) {
      assert.equal(strategyText.includes(marker), true);
    }
    const atLimit = { signals: payload.signals, strategy: "长".repeat(TOPIC_IDEAS_STRATEGY_MAX_LENGTH) };
    assert.equal(parseTaskRequest(envelope("topic-ideas", atLimit, {
      expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest,
    }), IDENTITY).kind, "topic-ideas");
    const over = { signals: payload.signals, strategy: "长".repeat(TOPIC_IDEAS_STRATEGY_MAX_LENGTH + 1) };
    assert.throws(
      () => parseTaskRequest(envelope("topic-ideas", over, {
        expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest,
      }), IDENTITY),
      /exceeds 6000 characters/,
    );
  });

  it("protects topic-ideas with the shared contract digest", () => {
    const descriptor = taskContractDescriptorFor("topic-ideas");
    assert.equal(REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["topic-ideas"], descriptor.digest);

    const { payload } = topicIdeasModelPayload([{ ...signal, relatedSignals: [] }], strategy);
    assert.throws(
      () => parseTaskRequest(envelope("topic-ideas", payload), IDENTITY),
      /missing a valid expected task contract digest/,
    );
    assert.throws(
      () => parseTaskRequest(envelope("topic-ideas", payload, { expectedContractDigest: "0".repeat(64) }), IDENTITY),
      /not available on this broker/,
    );
  });
});

describe("script-draft cross-process contract (planning chain brief × Broker parser)", () => {
  it("accepts the real planning-chain brief: durationRange + creativeTreatment + planningIssues", () => {
    const brief = {
      title: "三种手机充电习惯的耗电真相实测",
      angle: "这三个充电习惯，正在偷偷吃掉你的电池寿命。",
      audience: "每天为手机电量焦虑的通勤上班族",
      nicheSlug: "tech-observer",
      platform: "douyin",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      visualIntent: "用通用生活画面解释机制，不冒充用户实测。",
      creativeTreatment: legalCreativeTreatmentOutput(),
      planningIssues: [{ severity: "advisory", detail: "补齐第三条来源后可加强结论" }],
      visualPlan: { strategy: "桌面实测特写", beats: [] },
      productionCapabilities: {
        assetProviders: [],
        editing: { sourceRangeReuse: true, staticEditorialCard: false },
        audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
      },
    };
    const task = parseTaskRequest(envelope("script-draft", { brief }, {
      expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
    }), IDENTITY);
    assert.equal(task.kind, "script-draft");
    const record = task.payload as unknown as { brief: Record<string, unknown> };
    assert.deepEqual(record.brief.durationRange, { minSeconds: 20, maxSeconds: 34 });
    assert.equal(record.brief.visualIntent, "用通用生活画面解释机制，不冒充用户实测。");
    assert.equal(record.brief.templateGuidance, undefined);
    assert.ok(record.brief.creativeTreatment);
    assert.ok(record.brief.planningIssues);
  });

  it("still rejects unknown brief keys and invalid duration ranges", () => {
    const base = {
      title: "测试标题", angle: "测试角度", audience: "测试受众", nicheSlug: "t",
      platform: "douyin", durationSeconds: 24,
      productionCapabilities: {
        assetProviders: [],
        editing: { sourceRangeReuse: true, staticEditorialCard: false },
        audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
      },
    };
    assert.throws(
      () => parseTaskRequest(envelope("script-draft", { brief: { ...base, evilField: true } }, {
        expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
      }), IDENTITY),
      /payload\.brief\.evilField is not allowed/,
    );
    assert.throws(
      () => parseTaskRequest(envelope("script-draft", { brief: { ...base, durationRange: { minSeconds: 40, maxSeconds: 30 } } }, {
        expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
      }), IDENTITY),
      /minSeconds must not exceed maxSeconds/,
    );
    assert.throws(
      () => parseTaskRequest(envelope("script-draft", { brief: { ...base, durationRange: { minSeconds: 10, maxSeconds: 30 } } }, {
        expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
      }), IDENTITY),
      /must be an integer between 20 and 180/,
    );
    const { productionCapabilities: _omitted, ...withoutCapabilities } = base;
    assert.throws(
      () => parseTaskRequest(envelope("script-draft", { brief: withoutCapabilities }, {
        expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
      }), IDENTITY),
      /productionCapabilities must be an object/,
    );
    assert.throws(
      () => parseTaskRequest(envelope("script-draft", { brief: { ...base, productionCapabilities: "unsupported" } }, {
        expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
      }), IDENTITY),
      /productionCapabilities must be an object/,
    );
    assert.throws(
      () => parseTaskRequest(envelope("script-draft", {
        brief: { ...base, productionCapabilities: { ...base.productionCapabilities, unknownCapability: true } },
      }, {
        expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
      }), IDENTITY),
      /unknownCapability is not allowed/,
    );
  });
});

class ParsingTreatmentClient extends CodexBridgeClient {
  readonly calls: Array<ReturnType<typeof parseTaskRequest>> = [];
  private treatmentCalls = 0;

  constructor() {
    super({ socketPath: "/nonexistent/contract-parser.sock", sleep: async () => undefined });
  }

  override async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
    const task = parseTaskRequest(envelope(kind, payload, {
      expectedContractDigest: taskContractDescriptorFor(kind).digest,
    }), CORE_IDENTITY);
    this.calls.push(task);
    if (kind === "creative-treatment") {
      this.treatmentCalls += 1;
      return { output: this.treatmentCalls === 1 ? {} : legalCreativeTreatmentOutput() };
    }
    if (kind === "role-audit") {
      return {
        output: {
          version: "video-factory/role-audit-v1",
          verdict: "pass",
          score: 95,
          summary: "构思合同与能力上下文一致。",
          issues: [],
          repairInstructions: [],
        },
      };
    }
    throw new Error(`Unexpected task ${kind}`);
  }
}

describe("creative-treatment adapter × Broker parser", () => {
  it("accepts the actual reference-grammar request, validation repair, and matching audit capability snapshot", async () => {
    const client = new ParsingTreatmentClient();
    const agent = new CodexCreativeTreatmentAgent({ client, maxReviewIterations: 1 });
    const productionCapabilities: ProductionCapabilities = {
      assetProviders: [],
      editing: { sourceRangeReuse: true, staticEditorialCard: false },
      audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
    };
    await agent.treatDetailed({
      brief: {
        title: "资料结论怎么核对",
        angle: "教普通人识别结论边界",
        audience: "刚开始独立生活的观众",
        nicheSlug: "evidence-basics",
        platform: "douyin",
        durationSeconds: 30,
        durationRange: { minSeconds: 24, maxSeconds: 40 },
        visualIntent: "以来源截图和通用示意解释核对方法。",
        seriesContext: {
          seriesName: "下班实验室",
          seasonNumber: 1,
          episodeNumber: 3,
          premise: "每集完成一次可复现验证",
          track: "after-work-lab",
          arc: "从偶然成功走向稳定方法",
          episode: {
            pillar: "真实实验",
            title: "第三集",
            viewerPromise: "看懂失败发生在哪一步",
            hook: "先展示反常结果",
            payoff: "给出可复现检查表",
          },
          bible: { rules: ["结论必须来自本集实际内容"], recurringElements: [], forbiddenChanges: [] },
          canon: { revision: 2, facts: [] },
          continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: [], canonChecks: [] },
        },
        productionCapabilities,
      },
      suppliedSources: [{ sourceId: "source-1", label: "原始报道" }],
      referenceGrammar: {
        version: "video-factory/shot-grammar-v1",
        summary: "短促开场后稳定解释",
        durationMs: 30_000,
        pacing: "先快后稳",
        composition: "主体居中",
        camera: "静态取证",
        color: "自然色",
        transitions: "直接切换",
        sound: "未观察",
        beats: [{
          startMs: 0,
          endMs: 30_000,
          narrativeFunction: "建立问题并兑现",
          shotSize: "中景",
          composition: "主体居中",
          cameraMovement: "未观察",
          subjectMovement: "未观察",
          lighting: "自然光",
          color: "自然色",
          transitionIn: "直接切换",
          soundRole: "未观察",
        }],
        reusableRules: ["先给判断范围，再展示来源"],
        avoidCopying: ["不复制人物、对白和品牌"],
        confidence: 0.8,
      },
    });

    assert.deepEqual(client.calls.map((call) => call.kind), ["creative-treatment", "creative-treatment", "role-audit"]);
    const initial = client.calls[0]!.payload as unknown as Record<string, unknown>;
    const repaired = client.calls[1]!.payload as unknown as Record<string, unknown>;
    const audit = client.calls[2]!.payload as unknown as {
      context: { upstreamFacts: Record<string, unknown> };
    };
    assert.equal((initial.referenceGrammar as { evidenceStatus?: string }).evidenceStatus, "style_structure_reference");
    assert.equal((repaired.revision as { mode?: string }).mode, "validation-repair");
    assert.equal((initial.brief as { visualIntent?: string }).visualIntent, "以来源截图和通用示意解释核对方法。");
    assert.equal(
      ((initial.brief as { seriesContext?: { episode?: { viewerPromise?: string } } }).seriesContext?.episode?.viewerPromise),
      "看懂失败发生在哪一步",
    );
    assert.equal((initial.brief as { templateGuidance?: unknown }).templateGuidance, undefined);
    assert.deepEqual((initial.brief as { productionCapabilities: unknown }).productionCapabilities, productionCapabilities);
    assert.equal(audit.context.upstreamFacts.visualIntent, "以来源截图和通用示意解释核对方法。");
    assert.equal(audit.context.upstreamFacts.templateGuidance, undefined);
    assert.deepEqual(audit.context.upstreamFacts.productionCapabilities, productionCapabilities);
  });
});

class ParsingRepairClient extends CodexBridgeClient {
  readonly calls: Array<ReturnType<typeof parseTaskRequest>> = [];
  private producerCalls = 0;

  constructor(
    private readonly producerKind: "script-draft" | "director-plan",
    private readonly validCandidate: Record<string, unknown>,
  ) {
    super({ socketPath: "/nonexistent/formal-planning-repair.sock", sleep: async () => undefined });
  }

  override async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
    const task = parseTaskRequest(envelope(kind, payload, {
      expectedContractDigest: taskContractDescriptorFor(kind).digest,
    }), CORE_IDENTITY);
    this.calls.push(task);
    if (kind === this.producerKind) {
      this.producerCalls += 1;
      return { output: this.producerCalls === 1 ? {} : structuredClone(this.validCandidate) };
    }
    if (kind === "role-audit") {
      return {
        output: {
          version: "video-factory/role-audit-v1",
          verdict: "pass",
          score: 95,
          summary: "正式输入、候选与下游边界一致。",
          issues: [],
          repairInstructions: [],
          planningDisposition: null,
          hostReadinessReview: null,
        },
      };
    }
    throw new Error(`Unexpected task ${kind}`);
  }
}

const stockCapabilities: ProductionCapabilities = {
  assetProviders: [{
    id: "pexels-stock-v1",
    deliveryTypes: ["stock_video", "stock_image"],
    supportsReferenceImage: false,
    strengths: ["通用纪实素材"],
    constraints: ["不能证明用户专属实验"],
  }],
  editing: { sourceRangeReuse: true, staticEditorialCard: false },
  audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
};

function validScriptCandidate(): Record<string, unknown> {
  return {
    viewerPromise: "学会识别资料支持的结论边界",
    narrativeArc: "先提出核对问题，再解释来源边界，最后给出行动方法。",
    canonFacts: [],
    scenes: [1, 2, 3].map((position) => ({
      position,
      narration: `第 ${position} 段解释一个核对步骤。`,
      duration: 8,
      visual_strategy: "stock",
      visual_prompt: `第 ${position} 段通用生活示意画面`,
      visible_action: "人物查看资料并做标记",
      success_criteria: ["动作清楚可见"],
      failure_conditions: ["画面出现无法核实的实验结果"],
      search_terms: ["person checking document vertical video"],
    })),
  };
}

function validDirectorCandidate(): Record<string, unknown> {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "auto",
    resolvedProfileId: "documentary-observer",
    profileRationale: "通用纪实画面适合解释核对方法。",
    visualBible: {
      viewerPromise: "学会识别资料支持的结论边界",
      narrativeApproach: "按动作推进核对步骤",
      motif: "纸面标记与手机资料",
      pacing: "稳定清楚",
      composition: "主体与资料同屏",
      camera: "轻微推进",
      color: "自然色",
      continuity: "同一人物与桌面环境",
      transitionGrammar: "按动作方向切换",
      sound: "环境声克制",
      antiPatterns: ["无关空镜", "无法核实的实验画面"],
    },
    shots: [1, 2, 3].map((scenePosition) => ({
      scenePosition,
      narrativeRole: "解释核对步骤",
      authenticityPolicy: "illustrative",
      preferredProviderId: "pexels-stock-v1",
      deliveryType: "stock_video",
      alternativeProviderIds: [],
      subject: "查看资料的普通人",
      environment: "自然光桌面",
      visibleAction: "人物查看资料并做标记",
      temporalBeats: [{ startSeconds: 0, endSeconds: 8, action: "查看资料并完成一处标记" }],
      sourceInSeconds: 0,
      shotSize: "中近景",
      camera: "稳定轻推",
      lighting: "自然柔光",
      negativeConstraints: ["不出现品牌水印", "不冒充实测"],
      referenceRequirements: [],
      successCriteria: ["动作清楚可见"],
      query: "person checking document vertical video",
      generationPrompt: "自然光桌面前查看资料并做标记的纪实竖屏画面",
      rationale: "通用纪实素材足以承担机制示意。",
      continuityNote: "保持人物与桌面视觉连续。",
      confidence: 0.8,
      estimatedCostCny: 0,
    })),
  };
}

describe("script/director adapters × Broker parser", () => {
  it("accepts the actual producer, validation repair, and audit requests with the revision 9 brief", async () => {
    const creativeTreatment = parseCreativeTreatment(legalCreativeTreatmentOutput(), ["source-1"]);
    const commonBrief = {
      title: "资料结论怎么核对",
      angle: "用通用示意解释核对方法",
      audience: "刚开始独立生活的观众",
      platform: "douyin",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      visualProof: "不能把示意画面说成用户实测。",
      visualIntent: "用自然生活画面解释核对动作。",
      creativeTreatment,
      planningIssues: [{
        id: "planning-issue-1",
        target: "director" as const,
        beatIds: ["evidence"],
        scenePositions: [2],
        reason: "素材只承担机制示意。",
        requiredChange: "导演不得把通用素材描述成用户实测。",
        evidenceArtifactIds: [],
      }],
      productionCapabilities: stockCapabilities,
    };

    const scriptClient = new ParsingRepairClient("script-draft", validScriptCandidate());
    await new CodexScreenwriterAgent({ client: scriptClient, maxReviewIterations: 1 }).draftDetailed({
      brief: { ...commonBrief, nicheSlug: "evidence-basics" },
      planningMode: true,
    });
    assert.deepEqual(scriptClient.calls.map((call) => call.kind), ["script-draft", "script-draft", "role-audit"]);

    const directorClient = new ParsingRepairClient("director-plan", validDirectorCandidate());
    await new CodexVisualDirectorAgent({ client: directorClient, maxReviewIterations: 1 }).planDetailed({
      brief: { ...commonBrief, requestedProfileId: "auto" },
      scenes: (validScriptCandidate().scenes as Array<Record<string, unknown>>).map((scene) => ({
        position: scene.position as number,
        narration: scene.narration as string,
        duration: scene.duration as number,
        visualPrompt: scene.visual_prompt as string,
        visualStrategy: "stock" as const,
        visibleAction: scene.visible_action as string,
        successCriteria: scene.success_criteria as string[],
        failureConditions: scene.failure_conditions as string[],
        searchTerms: scene.search_terms as string[],
      })),
      assetProviders: [{
        id: "pexels-stock-v1",
        label: "Pexels 图库",
        billing: "free",
        modes: ["图库检索"],
        deliveryTypes: ["stock_video", "stock_image"],
        supportsReferenceImage: false,
        strengths: ["通用纪实素材"],
        constraints: ["不能证明用户专属实验"],
        estimatedCnyPerClip: 0,
      }],
      economics: { allowMeteredProviders: false },
      planningMode: true,
    });
    assert.deepEqual(directorClient.calls.map((call) => call.kind), ["director-plan", "director-plan", "role-audit"]);

    for (const calls of [scriptClient.calls, directorClient.calls]) {
      const initial = calls[0]!.payload as unknown as { brief: Record<string, unknown> };
      const repaired = calls[1]!.payload as unknown as { revision: { mode?: string } };
      const audit = calls[2]!.payload as unknown as { context: { upstreamFacts: Record<string, unknown> } };
      assert.equal(initial.brief.visualIntent, commonBrief.visualIntent);
      assert.equal(initial.brief.templateGuidance, undefined);
      assert.deepEqual(initial.brief.creativeTreatment, commonBrief.creativeTreatment);
      assert.deepEqual(initial.brief.planningIssues, commonBrief.planningIssues);
      assert.equal(repaired.revision.mode, "validation-repair");
      assert.ok(audit.context.upstreamFacts);
    }
  });
});

describe("visual-review adapter × Broker parser", () => {
  it("accepts the complete production visual-review audit criteria", async () => {
    const identity = {
      ...CORE_IDENTITY,
      taskKinds: [...CORE_IDENTITY.taskKinds, "visual-review"],
    } as const;
    const media: VisualReviewMediaPayload = {
      durationMs: 1_000,
      frames: [{
        timecodeMs: 500,
        sourceTimecodeMs: 500,
        sha256: "eb881b6abf48739ee3e6c9d97aa6a7fe7f5eca9af4c6e7f012a4dbb49b3437ab",
        jpegBase64: "/9j/4AAA/9k=",
        scenePosition: 1,
        phase: "middle",
      }],
    };
    const report: VisualReviewReport = {
      version: "video-factory/visual-review-v1",
      summary: "当前证据范围内画面满足硬性要求。",
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 },
      findings: [],
      confidence: 0.9,
      recommendation: "approve",
    };
    const audit = {
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 95,
      summary: "报告与画面证据和硬性要求一致。",
      issues: [],
      repairInstructions: [],
      planningDisposition: null,
      hostReadinessReview: null,
    };
    const parsedKinds: CodexTaskKind[] = [];
    const client = new class extends CodexBridgeClient {
      constructor() {
        super({ socketPath: "/nonexistent/visual-review-contract.sock", sleep: async () => undefined });
      }

      override async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
        const parsed = parseTaskRequest(envelope(kind, payload, {
          expectedContractDigest: taskContractDescriptorFor(kind).digest,
        }), identity);
        parsedKinds.push(parsed.kind);
        return { output: kind === "visual-review" ? report : audit };
      }
    }();

    const result = await new CodexVisualReviewAgent({
      client,
      media: { prepare: async () => media },
      maxReviewIterations: 1,
    }).reviewDetailed({ runRoot: "/run", preparedMedia: media });

    assert.equal(result.output.recommendation, "approve");
    assert.deepEqual(parsedKinds, ["visual-review", "role-audit"]);
  });
});

class RejectAfterParseClient extends CodexBridgeClient {
  readonly calls: Array<ReturnType<typeof parseTaskRequest>> = [];

  constructor() {
    super({ socketPath: "/nonexistent/formal-capability-matrix.sock", sleep: async () => undefined });
  }

  override async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
    this.calls.push(parseTaskRequest(envelope(kind, payload, {
      expectedContractDigest: taskContractDescriptorFor(kind).digest,
    }), CORE_IDENTITY));
    throw new Error("stop-after-formal-parser");
  }
}

function officialCapabilityScenarios(): Array<{ label: string; capabilities: ProductionCapabilities }> {
  const catalog = reviewedVideoModelCatalog({});
  const profiles = Object.entries(catalog).flatMap(([providerId, models]) => models.map((model) => ({
    providerId,
    model,
  })));
  assert.ok(profiles.length > 0);
  for (const { model } of profiles) {
    assert.ok(model.id);
    assert.ok(model.taskTypes.length > 0);
    assert.ok(model.resolutions.length > 0);
    assert.ok(model.aspectRatios.length > 0);
    assert.ok(model.minDurationSeconds > 0);
    assert.ok(model.maxDurationSeconds >= model.minDurationSeconds);
  }
  const capability = ({ providerId, model }: (typeof profiles)[number]) => ({
    id: providerId,
    deliveryTypes: ["generated_video"],
    supportsReferenceImage: model.taskTypes.includes("image-to-video"),
    strengths: ["正式目录声明的视频生成能力"],
    constraints: ["合成画面不得作为事实证据"],
    selectedModelId: model.id,
    minDurationSeconds: model.minDurationSeconds,
    maxDurationSeconds: model.maxDurationSeconds,
    aspectRatios: model.aspectRatios,
  });
  const recommended = Object.entries(catalog).map(([providerId, models]) => ({
    providerId,
    model: models.find((model) => model.recommended) ?? models[0]!,
  }));
  return [
    { label: "empty", capabilities: summarizeProductionCapabilities([]) },
    ...profiles.map((profile) => ({
      label: `${profile.providerId}/${profile.model.id}`,
      capabilities: summarizeProductionCapabilities([capability(profile)]),
    })),
    { label: "mixed-recommended", capabilities: summarizeProductionCapabilities(recommended.map(capability)) },
  ];
}

function directorInputForCapabilities(capabilities: ProductionCapabilities): VisualDirectorAgentInput {
  return {
    brief: {
      title: "正式能力合同矩阵",
      angle: "用当前能力目录规划可执行画面",
      audience: "普通观众",
      platform: "douyin",
      durationSeconds: 24,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
      requestedProfileId: "auto",
      productionCapabilities: capabilities,
    },
    scenes: [{
      position: 1,
      narration: "先展示一个可观察动作。",
      duration: 24,
      visualPrompt: "可观察动作的竖屏画面",
      visualStrategy: "generated",
      visibleAction: "主体完成一个清晰动作",
      successCriteria: ["动作可见"],
      failureConditions: ["动作不可辨认"],
      searchTerms: [],
    }],
    assetProviders: capabilities.assetProviders.map((provider) => ({
      id: provider.id,
      label: provider.id,
      billing: "metered" as const,
      modes: ["AI 视频"],
      deliveryTypes: provider.deliveryTypes as VisualDirectorAgentInput["assetProviders"][number]["deliveryTypes"],
      supportsReferenceImage: provider.supportsReferenceImage,
      strengths: [...provider.strengths],
      constraints: [...provider.constraints],
      estimatedCnyPerClip: 1,
      ...(provider.selectedModelId ? { selectedModelId: provider.selectedModelId } : {}),
      ...(provider.minDurationSeconds !== undefined ? { minDurationSeconds: provider.minDurationSeconds } : {}),
      ...(provider.maxDurationSeconds !== undefined ? { maxDurationSeconds: provider.maxDurationSeconds } : {}),
      ...(provider.aspectRatios ? { aspectRatios: [...provider.aspectRatios] } : {}),
    })),
    economics: { allowMeteredProviders: true },
    planningMode: true,
  };
}

describe("official Provider capability catalog × all planning adapters × Broker parser", () => {
  it("accepts empty, every declared model profile, and mixed capabilities for treatment, script, and director", async () => {
    for (const { label, capabilities } of officialCapabilityScenarios()) {
      const treatmentClient = new RejectAfterParseClient();
      await assert.rejects(
        new CodexCreativeTreatmentAgent({ client: treatmentClient, maxReviewIterations: 1 }).treatDetailed({
          brief: {
            title: "正式能力合同矩阵",
            angle: "用当前能力目录规划可执行画面",
            audience: "普通观众",
            nicheSlug: "capability-contract",
            platform: "douyin",
            durationSeconds: 24,
            durationRange: { minSeconds: 20, maxSeconds: 34 },
            productionCapabilities: capabilities,
          },
          suppliedSources: [],
          planningMode: true,
        }),
        /stop-after-formal-parser/,
        label,
      );
      assert.deepEqual(treatmentClient.calls.map((call) => call.kind), ["creative-treatment"], label);

      const scriptClient = new RejectAfterParseClient();
      await assert.rejects(
        new CodexScreenwriterAgent({ client: scriptClient, maxReviewIterations: 1 }).draftDetailed({
          brief: {
            title: "正式能力合同矩阵",
            angle: "用当前能力目录规划可执行画面",
            audience: "普通观众",
            nicheSlug: "capability-contract",
            platform: "douyin",
            durationSeconds: 24,
            durationRange: { minSeconds: 20, maxSeconds: 34 },
            productionCapabilities: capabilities,
          },
          planningMode: true,
        }),
        /stop-after-formal-parser/,
        label,
      );
      assert.deepEqual(scriptClient.calls.map((call) => call.kind), ["script-draft"], label);

      const directorClient = new RejectAfterParseClient();
      await assert.rejects(
        new CodexVisualDirectorAgent({ client: directorClient, maxReviewIterations: 1 }).planDetailed(
          directorInputForCapabilities(capabilities),
        ),
        /stop-after-formal-parser/,
        label,
      );
      assert.deepEqual(directorClient.calls.map((call) => call.kind), ["director-plan"], label);
    }
  });
});
