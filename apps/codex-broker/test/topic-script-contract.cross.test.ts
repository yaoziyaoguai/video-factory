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
import { CodexScreenwriterAgent } from "../../../packages/production-pipeline/src/codex-screenwriter.js";
import { CodexVisualDirectorAgent } from "../../../packages/production-pipeline/src/codex-visual-director.js";
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
      creativeTreatment: {
        version: "video-factory/creative-treatment-v1",
        viewerPromise: "看清楚哪些习惯真的在耗电",
        beats: [],
      },
      planningIssues: [{ severity: "advisory", detail: "补齐第三条来源后可加强结论" }],
      visualPlan: { strategy: "桌面实测特写", beats: [] },
      productionCapabilities: {
        assetProviders: [],
        editing: { sourceRangeReuse: true, staticEditorialCard: false },
      },
    };
    const task = parseTaskRequest(envelope("script-draft", { brief }, {
      expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
    }), IDENTITY);
    assert.equal(task.kind, "script-draft");
    const record = task.payload as unknown as { brief: Record<string, unknown> };
    assert.deepEqual(record.brief.durationRange, { minSeconds: 20, maxSeconds: 34 });
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
    const productionCapabilities = {
      assetProviders: [],
      editing: { sourceRangeReuse: true, staticEditorialCard: false },
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
    assert.deepEqual((initial.brief as { productionCapabilities: unknown }).productionCapabilities, productionCapabilities);
    assert.deepEqual(audit.context.upstreamFacts.productionCapabilities, productionCapabilities);
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
