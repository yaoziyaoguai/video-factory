import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } from "../../../packages/production-pipeline/src/codex-chat.js";
import { CODEX_BRIDGE_PROTOCOL_VERSION } from "../src/codex-executor.js";
import {
  BROKER_TASK_KINDS,
  COMMON_ROLE_PREAMBLE,
  outputSchemaFor,
  providerOutputSchemaFor,
  outputSchemaValidationErrorFor,
  outputValidationErrorFor,
  taskContractDescriptorFor,
  taskPromptFor,
} from "../src/task-definitions.js";
import {
  creativeTreatmentWhitespaceInvalidCases,
  legalCreativeTreatmentOutput,
  paddedLegalCreativeTreatmentOutput,
} from "./fixtures/creative-treatment.js";

function validDirectorPlan() {
  const shot = {
    scenePosition: 1,
    reuseFromScenePosition: null as number | null,
    referenceFromScenePosition: null as number | null,
    narrativeRole: "hook",
    authenticityPolicy: "illustrative",
    preferredProviderId: "pexels-stock-v1",
    deliveryType: "stock_video",
    alternativeProviderIds: ["pixabay-stock-v1"],
    subject: "手机用户",
    environment: "室内",
    visibleAction: "拇指向上滑动",
    temporalBeats: [
      { startSeconds: 0, endSeconds: 1, action: "观看" },
      { startSeconds: 1, endSeconds: 2, action: "上滑" },
    ],
    sourceInSeconds: 0,
    shotSize: "近景",
    camera: "固定机位",
    lighting: "自然侧光",
    negativeConstraints: ["无品牌"],
    referenceRequirements: [],
    successCriteria: ["完整看见一次上滑"],
    query: "hand swipe smartphone",
    generationPrompt: "手机用户在自然侧光的室内完成一次清楚的向上滑动，固定近景",
    rationale: "常见单一动作适合图库检索",
    continuityNote: "承接上一镜",
    confidence: 0.8,
    estimatedCostCny: 0,
  };
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "auto",
    resolvedProfileId: "documentary-observer",
    profileRationale: "生活观察题材",
    visualBible: {
      narrativeApproach: "问题到结论",
      motif: "手机动作",
      pacing: "短促",
      composition: "竖屏近景",
      camera: "固定为主",
      color: "自然色",
      continuity: "同一手部方向",
      transitionGrammar: "动作切",
      sound: "真实环境声",
      antiPatterns: ["空泛氛围镜头"],
    },
    shots: [shot, { ...shot, scenePosition: 2, query: "video editing timeline" }],
  };
}

function validCreativeTreatment(): Record<string, unknown> {
  return {
    version: "video-factory/creative-treatment-v2",
    viewerPromise: "学会识别资料支持的结论边界",
    hook: { narrationIntent: "提出一个具体判断", visualIntent: "展示原始资料的关键差异" },
    progression: [
      { beatId: "question", purpose: "建立问题", viewerGain: "知道要核对什么" },
      { beatId: "evidence", purpose: "核对资料", viewerGain: "区分事实与推测" },
      { beatId: "payoff", purpose: "兑现判断", viewerGain: "知道下一步如何判断" },
    ],
    payoff: "给出有条件的结论及下一步",
    visualPrinciples: ["来源画面优先"],
    soundPrinciples: ["自然语速、清楚停顿"],
    evidenceRequirements: [{
      beatId: "evidence",
      claim: "原材料中的陈述",
      requirement: "factual_support",
      suppliedSourceIds: ["source-1"],
      critical: true,
      acquisition: "supplied",
      retrievalProviderId: null,
    }],
    feasibilityQuestions: [{ beatId: "evidence", question: "来源画面是否可读且有使用依据" }],
  };
}

function assertStrictObjectRequirements(schema: unknown, path: string): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  if (record.type === "object") {
    const properties = typeof record.properties === "object" && record.properties !== null && !Array.isArray(record.properties)
      ? record.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(record.required) ? record.required : [];
    assert.deepEqual(
      [...required].sort(),
      Object.keys(properties).sort(),
      `${path} must require every declared property for strict structured outputs`,
    );
    for (const [key, child] of Object.entries(properties)) {
      assertStrictObjectRequirements(child, `${path}.${key}`);
    }
  }
  if (record.type === "array") assertStrictObjectRequirements(record.items, `${path}[]`);
}

describe("broker-owned task definitions", () => {
  it("keeps production contract pins synchronized with protected broker tasks", () => {
    assert.deepEqual(Object.keys(REQUIRED_CODEX_TASK_CONTRACT_DIGESTS).sort(), [...BROKER_TASK_KINDS].sort());
    for (const kind of BROKER_TASK_KINDS) {
      assert.equal(REQUIRED_CODEX_TASK_CONTRACT_DIGESTS[kind], taskContractDescriptorFor(kind).digest);
    }
  });
  it("publishes source timecodes in both visual evidence input contracts", () => {
    const visualReview = taskContractDescriptorFor("visual-review").inputContract as { frameFields?: string[] };
    const roleAudit = taskContractDescriptorFor("role-audit").inputContract as {
      criteriaMaxItems?: number;
      imageFields?: string[];
    };
    assert.equal(visualReview.frameFields?.includes("sourceTimecodeMs"), true);
    assert.equal(roleAudit.imageFields?.includes("sourceTimecodeMs"), true);
    assert.equal(roleAudit.criteriaMaxItems, 16);
  });
  it("pins protocol v2 and owns prompts for every allowed task kind", () => {
    assert.equal(CODEX_BRIDGE_PROTOCOL_VERSION, "video-factory/codex-bridge-v2");
    assert.deepEqual(BROKER_TASK_KINDS, [
      "topic-ideas",
      "series-roadmap",
      "creative-treatment",
      "director-plan",
      "script-draft",
      "publish-copy",
      "asset-rank",
      "reference-grammar",
      "visual-review",
      "role-audit",
      "creative-discussion",
    ]);
    for (const kind of BROKER_TASK_KINDS) {
      assert.equal(
        taskPromptFor(kind).directive.includes(COMMON_ROLE_PREAMBLE),
        false,
        `${kind} must rely on the prompt builder's single shared preamble`,
      );
    }

    assert.match(taskPromptFor("topic-ideas").directive, /中文短视频选题总编/);
    assert.match(taskPromptFor("series-roadmap").directive, /长期视频栏目的系列总编/);
    assert.match(taskPromptFor("creative-treatment").directive, /脚本写定前建立本片创作方向/);
    assert.match(taskPromptFor("director-plan").directive, /短视频总导演/);
    assert.match(taskPromptFor("script-draft").directive, /中文短视频创意编剧/);
    assert.match(taskPromptFor("publish-copy", "douyin").directive, /抖音/);
    assert.match(taskPromptFor("asset-rank").directive, /语义选片师/);
    assert.match(taskPromptFor("reference-grammar").directive, /参考片关键帧中提炼可复用的制作语法/);
    assert.match(taskPromptFor("visual-review").directive, /视觉审片/);
    assert.match(taskPromptFor("role-audit").directive, /独立审计当前角色候选/);
    assert.match(taskPromptFor("role-audit").directive, /没有依据的审美偏好不能阻断/);
    assert.match(taskPromptFor("role-audit").directive, /前期不要求已经下载普通图库或生成付费画面/);
    assert.match(taskPromptFor("role-audit").directive, /previousAudit/);
    assert.match(taskPromptFor("role-audit").directive, /不要求凭空增加库存、服务商或后期功能/);
    assert.match(taskPromptFor("director-plan").directive, /assetProviders 是本轮可用于规划与报价的池/);
    assert.match(
      taskPromptFor("visual-review").outputRules.join("\n"),
      /version 必须固定为 video-factory\/visual-review-v1/,
    );
    assert.match(taskPromptFor("visual-review").outputRules.join("\n"), /severity 只能是 info、warning、critical/);

    const neutral = taskPromptFor("publish-copy", "somewhere-else").directive;
    assert.match(neutral, /中性/);
    assert.doesNotMatch(neutral, /抖音/);
  });

  it("keeps publish-copy contract identity static while platform prompts stay distinct", () => {
    const platforms = ["douyin", "shipinhao", "kuaishou", "xiaohongshu", "bilibili", "somewhere-else"];
    const descriptors = platforms.map((platform) => taskContractDescriptorFor("publish-copy", platform));

    assert.equal(new Set(descriptors.map((descriptor) => descriptor.digest)).size, 1);
    assert.equal(descriptors[0]?.digest, taskContractDescriptorFor("publish-copy").digest);
    assert.equal(new Set(platforms.map((platform) => taskPromptFor("publish-copy", platform).directive)).size, platforms.length);
  });

  it("pins prompt-pack versions and production-quality role contracts", () => {
    const topic = taskPromptFor("topic-ideas");
    const series = taskPromptFor("series-roadmap");
    const treatment = taskPromptFor("creative-treatment");
    const script = taskPromptFor("script-draft");
    const director = taskPromptFor("director-plan");
    const publish = taskPromptFor("publish-copy");
    const rank = taskPromptFor("asset-rank");
    const reference = taskPromptFor("reference-grammar");
    const review = taskPromptFor("visual-review");
    const audit = taskPromptFor("role-audit");

    assert.deepEqual(
      [topic.version, series.version, treatment.version, script.version, director.version],
      [
        "video-factory/topic-editor-v8",
        "video-factory/series-showrunner-v2",
        "video-factory/treatment-director-v5",
        "video-factory/screenwriter-v17",
        "video-factory/director-v28",
      ],
    );
    assert.deepEqual(
      [publish.version, rank.version, reference.version, review.version, audit.version],
      [
        "video-factory/publish-editor-v3",
        "video-factory/asset-rank-v4",
        "video-factory/reference-grammar-v3",
        "video-factory/visual-review-v18",
        "video-factory/role-audit-v8",
      ],
    );

    assert.match(topic.directive, /strategy.*创作者的定位、受众、偏好、避开方向/);
    assert.doesNotMatch(topic.directive, /creatorStrategy/);
    assert.match(series.directive, /canon 只包含已经内部定版的事实/);
    assert.match(treatment.directive, /brief\.productionCapabilities/);
    assert.match(treatment.directive, /referenceGrammar 只作为风格和结构参考/);
    assert.match(script.directive, /brief\.creativeTreatment.*brief\.planningIssues/);
    assert.match(script.directive, /durationRange.*没有明确范围.*目标时长兼容边界/);
    assert.match(script.directive, /同一母片的不同、完整覆盖的区间/);
    assert.doesNotMatch(script.directive, /每个 scene 必须能由一段素材从开头独立执行/);
    assert.match(director.directive, /sourceInSeconds.*已知非负源起点.*正常速度裁切/);
    assert.match(director.directive, /reuseFromScenePosition=N.*REUSE_ONLY scene N/);
    assert.match(director.directive, /referenceFromScenePosition=N.*Provider 明确支持参考图/);
    assert.match(director.directive, /跨镜身份要求.*独立生成只能要求可见母题一致/);
    assert.match(director.directive, /costFeedback 是降本方向，不是全片硬上限/);
    assert.doesNotMatch(director.directive, /creatorStrategy|付费镜头上限是硬边界|costPolicy/);
    assert.match(publish.directive, /没有成片审片证据输入时，不宣称已经审片通过/);
    assert.match(rank.directive, /全部不合格时诚实返回 no-match/);
    assert.match(reference.directive, /静帧无法证明真实相机运动、连续动作或音轨/);
    assert.match(audit.directive, /判断语义而不是匹配词语/);
    assert.match(audit.directive, /iteration 大于 1 时逐项复核 previousAudit/);
    assert.match(review.outputRules.join("\n"), /不得为了通过审计而美化评分/);
    assert.match(review.directive, /pilotScenePositions.*仅审已列出的试片/);
    assert.match(review.directive, /稀疏模式只能证明已采样状态[\s\S]*not_observed/);
    assert.match(review.directive, /scale-to-fill.*center crop/);
    assert.match(review.directive, /方案本身不可执行.*replan_upstream/);
    assert.match(review.directive, /不得因否定句里出现“同一人物”就认定作品要求身份一致/);
    assert.match(
      review.examples.join("\n"),
      /"startTimecodeMs".*"evidenceStatus":"not_observed".*"evidenceFrameSha256":null.*"nextAction":"inspect_existing_media"/,
    );
    assert.match(review.outputRules.join("\n"), /scenePosition.*targetNodeId/);
    assert.match(review.outputRules.join("\n"), /startTimecodeMs <= timecodeMs <= endTimecodeMs/);
    assert.match(review.outputRules.join("\n"), /evidenceStatus=failed.*severity.*warning.*critical.*nextAction.*replan_upstream.*rework_asset/);
    assert.match(review.outputRules.join("\n"), /evidenceStatus=not_observed.*severity.*info.*nextAction.*inspect_existing_media/);
    assert.match(review.outputRules.join("\n"), /evidenceStatus=satisfied.*not_applicable.*severity.*info.*nextAction.*none/);
    assert.doesNotMatch(script.directive, /costPolicy/);
    assert.match(director.outputRules.join("\n"), /不要逐字复述脚本/);
    assert.match(director.outputRules.join("\n"), /每个标量字段最多一句/);
    assert.match(review.directive, /scene_triplets.*opening.*middle.*closing/);
    // 证据能力规则必须按主张类型声明，且覆盖"画面之外的东西"这一类，否则模型只能靠题材猜。
    assert.match(review.directive, /claimType 声明这条主张要靠哪类证据判定：static.*motion.*non_visual/);
    assert.match(review.directive, /更判不了 non_visual，采多少帧也采不到声音/);
    assert.match(review.outputRules.join("\n"), /claimType 只能是 static、motion 或 non_visual/);
    assert.match(review.outputRules.join("\n"), /claimType=non_visual 的 finding 不可能靠抽帧证成/);
    assert.ok(script.examples.some((example) => /反例/.test(example)));
    assert.ok(director.examples.some((example) => /startSeconds.*endSeconds.*action/.test(example)));
  });

  it("allows the topic editor to return an explicit empty shortlist and treats signal links as leads", () => {
    const topic = taskPromptFor("topic-ideas");
    assert.match(topic.directive, /sourceId、url、collectedAt 是来源线索/);
    assert.match(topic.directive, /榜单排名和热度不能证明报道中的具体结论/);
    assert.match(topic.directive, /每个顶层 signals 项是归并后的 canonical topic/);
    assert.match(topic.directive, /relatedSignals 只是关联报道/);
    assert.match(topic.directive, /signalId.*原样引用顶层 id/);
    assert.match(topic.directive, /来源数量门槛由下游/);
    assert.match(topic.directive, /来源不足但内容和视觉价值成立的角度可以保留/);
    assert.match(topic.directive, /全部输入均无内容或视觉价值时才返回空 ideas/);
    assert.match(topic.task, /内容价值或视频表现价值.*不足时.*空 ideas 数组/);
    assert.match(topic.outputRules.join("\n"), /空数组只能表示.*内容或视觉价值不足/);
  });

  it("owns a strict output schema for every allowed task kind", () => {
    const requiredByKind = new Map([
      ["topic-ideas", ["ideas"]],
      ["series-roadmap", ["episodes"]],
      ["creative-treatment", ["version", "viewerPromise", "hook", "progression", "payoff", "visualPrinciples", "soundPrinciples", "evidenceRequirements", "feasibilityQuestions"]],
      ["director-plan", ["version", "requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]],
      ["script-draft", ["viewerPromise", "narrativeArc", "canonFacts", "scenes"]],
      ["publish-copy", ["title", "description", "hashtags"]],
      ["asset-rank", ["version", "source", "providerId", "modelId", "summary", "scenes"]],
      ["reference-grammar", ["version", "summary", "durationMs", "pacing", "composition", "camera", "color", "transitions", "sound", "beats", "reusableRules", "avoidCopying", "confidence"]],
      ["visual-review", ["version", "summary", "scores", "findings", "confidence", "recommendation"]],
      ["role-audit", ["version", "verdict", "score", "summary", "issues", "repairInstructions", "planningDisposition", "hostReadinessReview"]],
      ["creative-discussion", ["stage", "intent", "reply", "changeSummary", "treatment", "script", "director", "upstreamRequest"]],
    ] as const);

    for (const kind of BROKER_TASK_KINDS) {
      const schema = outputSchemaFor(kind) as { additionalProperties?: boolean; required?: string[] };
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, requiredByKind.get(kind));
    }
  });

  it("keeps every response schema compatible with strict OpenAI structured outputs", () => {
    for (const kind of BROKER_TASK_KINDS) {
      assertStrictObjectRequirements(outputSchemaFor(kind), kind);
    }
  });

  it("projects unsupported uniqueness only at the provider boundary without mutating the domain schema", () => {
    for (const kind of BROKER_TASK_KINDS) {
      const before = JSON.stringify(outputSchemaFor(kind));
      const projected = providerOutputSchemaFor(kind);
      assert.equal(JSON.stringify(projected).includes('"uniqueItems"'), false, kind);
      assertStrictObjectRequirements(projected, kind);
      assert.equal(JSON.stringify(outputSchemaFor(kind)), before);
      const removeUnique = (value: unknown): unknown => Array.isArray(value)
        ? value.map(removeUnique)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "uniqueItems").map(([key, entry]) => [key, removeUnique(entry)]))
          : value;
      assert.deepEqual(projected, removeUnique(outputSchemaFor(kind)));
    }
    assert.ok(JSON.stringify(outputSchemaFor("topic-ideas")).includes('"uniqueItems":true'));
    assert.ok(JSON.stringify(outputSchemaFor("role-audit")).includes('"uniqueItems":true'));
    assert.match(outputSchemaValidationErrorFor("role-audit", {
      version: "video-factory/role-audit-v1", verdict: "pass", score: 95, summary: "检查完成",
      issues: [], repairInstructions: [], planningDisposition: null,
      hostReadinessReview: { misclassifiedIssueIds: ["issue-1", "issue-1"] },
    }) ?? "", /unique|duplicate|match any/i);
  });

  it("requires inspectable shot intent instead of accepting generic scene prose", () => {
    const scriptSchema = outputSchemaFor("script-draft") as {
      required: string[];
      properties: { scenes: { minItems: number; items: { required: string[] } } };
    };
    const directorSchema = outputSchemaFor("director-plan") as {
      properties: { shots: { items: { required: string[]; properties: {
        sourceInSeconds: { minimum: number };
        temporalBeats: { minItems: number; items: { required: string[] } };
      } } } };
    };

    assert.deepEqual(scriptSchema.required, ["viewerPromise", "narrativeArc", "canonFacts", "scenes"]);
    assert.ok(scriptSchema.properties.scenes.items.required.includes("visible_action"));
    assert.ok(scriptSchema.properties.scenes.items.required.includes("success_criteria"));
    assert.ok(scriptSchema.properties.scenes.items.required.includes("failure_conditions"));
    assert.ok(directorSchema.properties.shots.items.required.includes("temporalBeats"));
    assert.ok(directorSchema.properties.shots.items.required.includes("negativeConstraints"));
    assert.ok(directorSchema.properties.shots.items.required.includes("successCriteria"));
    assert.ok(directorSchema.properties.shots.items.required.includes("deliveryType"));
    assert.ok(directorSchema.properties.shots.items.required.includes("reuseFromScenePosition"));
    assert.ok(directorSchema.properties.shots.items.required.includes("referenceFromScenePosition"));
    assert.ok(directorSchema.properties.shots.items.required.includes("sourceInSeconds"));
    assert.equal(scriptSchema.properties.scenes.minItems, 3);
    assert.equal(directorSchema.properties.shots.items.properties.temporalBeats.minItems, 1);
    assert.deepEqual(directorSchema.properties.shots.items.properties.temporalBeats.items.required, ["startSeconds", "endSeconds", "action"]);
    assert.equal(directorSchema.properties.shots.items.properties.sourceInSeconds.minimum, 0);
  });

  it("rejects an invalid director source start", () => {
    const invalid = validDirectorPlan();
    invalid.shots[0]!.sourceInSeconds = -1;
    assert.match(outputValidationErrorFor("director-plan", invalid) ?? "", /sourceInSeconds.*at least 0/);
  });

  it("validates structured reference-image routing fields", () => {
    const referenced = validDirectorPlan();
    referenced.shots[0]!.preferredProviderId = "seedream-image-v1";
    referenced.shots[0]!.deliveryType = "generated_image";
    referenced.shots[1]!.preferredProviderId = "seedream-image-v1";
    referenced.shots[1]!.deliveryType = "generated_image";
    referenced.shots[1]!.referenceFromScenePosition = 1;
    assert.equal(outputValidationErrorFor("director-plan", referenced), undefined);

    const futureReference = structuredClone(referenced);
    futureReference.shots[0]!.referenceFromScenePosition = 2;
    assert.match(outputValidationErrorFor("director-plan", futureReference) ?? "", /must reference an earlier scene/);

    const reusedReference = structuredClone(referenced);
    reusedReference.shots[1]!.reuseFromScenePosition = 1;
    assert.match(outputValidationErrorFor("director-plan", reusedReference) ?? "", /cannot reference and reuse/);

    const wrongDelivery = structuredClone(referenced);
    wrongDelivery.shots[1]!.deliveryType = "stock_image";
    assert.match(outputValidationErrorFor("director-plan", wrongDelivery) ?? "", /requires deliveryType generated_image/);

    const invalidScalar = structuredClone(referenced) as unknown as { shots: Array<Record<string, unknown>> };
    invalidScalar.shots[1]!.referenceFromScenePosition = "scene 1";
    assert.match(outputValidationErrorFor("director-plan", invalidScalar) ?? "", /must be a finite number/);
  });

  it("rejects blank director execution prompts before they reach the production pipeline", () => {
    const invalidDirector = validDirectorPlan();
    invalidDirector.shots[0]!.generationPrompt = "";

    assert.match(
      outputValidationErrorFor("director-plan", invalidDirector) ?? "",
      /generationPrompt.*shorter than 1 character/,
    );
  });

  it("validates nested visual-review output fields at runtime", () => {
    const valid = {
      version: "video-factory/visual-review-v1",
      summary: "画面清晰。",
      scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 },
      findings: [],
      confidence: 0.9,
      recommendation: "approve",
    };
    assert.equal(outputValidationErrorFor("visual-review", valid), undefined);

    const invalidCases = [
      { ...valid, scores: { ...valid.scores, extra: 1 } },
      { ...valid, scores: { ...valid.scores, pacing: 90.5 } },
      { ...valid, confidence: 1.1 },
      { ...valid, recommendation: "maybe" },
      {
        ...valid,
        findings: [{
          timecodeMs: 0,
          startTimecodeMs: 0,
          endTimecodeMs: 500,
          scenePosition: 1,
          targetNodeId: "assets",
          planningStageId: null,
          claimType: "static", evidenceStatus: "failed",
          evidenceFrameSha256: "a".repeat(64),
          nextAction: "rework_asset",
          category: "unknown",
          severity: "warning",
          description: "问题",
          suggestion: "建议",
        }],
      },
    ];
    for (const output of invalidCases) {
      assert.equal(typeof outputValidationErrorFor("visual-review", output), "string");
    }
    assert.match(outputValidationErrorFor("visual-review", {
      ...valid,
      recommendation: "revise",
      findings: [{
        timecodeMs: 100,
        startTimecodeMs: 0,
        endTimecodeMs: 500,
        scenePosition: 1,
        targetNodeId: "assets",
        planningStageId: null,
        claimType: "static", evidenceStatus: "failed",
        evidenceFrameSha256: "not-a-sha256",
        nextAction: "rework_asset",
        category: "continuity",
        severity: "warning",
        description: "镜头重复",
        suggestion: "更换素材",
      }],
    }) ?? "", /evidenceFrameSha256.*required pattern/);
    assert.match(outputValidationErrorFor("visual-review", {
      ...valid,
      scores: { ...valid.scores, pacing: 74 },
    }) ?? "", /cannot approve/);
    assert.match(outputValidationErrorFor("visual-review", {
      ...valid,
      confidence: 0.69,
    }) ?? "", /cannot approve/);
    assert.match(outputValidationErrorFor("visual-review", {
      ...valid,
      findings: [{
        timecodeMs: 100,
        startTimecodeMs: 0,
        endTimecodeMs: 500,
        scenePosition: 1,
        targetNodeId: "assets",
        planningStageId: null,
        claimType: "static", evidenceStatus: "failed",
        evidenceFrameSha256: "a".repeat(64),
        nextAction: "rework_asset",
        category: "continuity",
        severity: "warning",
        description: "镜头重复",
        suggestion: "更换素材",
      }],
    }) ?? "", /cannot approve/);
    assert.match(outputValidationErrorFor("visual-review", {
      ...valid,
      findings: [{
        timecodeMs: 100,
        startTimecodeMs: 0,
        endTimecodeMs: 500,
        claimType: "static", evidenceStatus: "failed",
        evidenceFrameSha256: "a".repeat(64),
        nextAction: "rework_asset",
        category: "other",
        severity: "warning",
        description: "第 8 镜没有杯子。",
        suggestion: "替换素材。",
      }],
    }) ?? "", /scenePosition|required property/);

    assert.equal(outputValidationErrorFor("visual-review", {
      ...valid,
      scores: { ...valid.scores, pacing: 74 },
      findings: [{
        timecodeMs: 100,
        startTimecodeMs: 0,
        endTimecodeMs: 500,
        scenePosition: 1,
        targetNodeId: "creative-planning", planningStageId: "script",
        claimType: "static", evidenceStatus: "failed",
        evidenceFrameSha256: "a".repeat(64),
        nextAction: "replan_upstream",
        category: "pacing",
        severity: "warning",
        description: "前六秒没有兑现承诺。",
        suggestion: "重写开场脚本。",
      }],
      recommendation: "revise",
    }), undefined);
  });

  it("rejects broken scene ordering and duplicate director routes", () => {
    const scriptSchema = outputSchemaFor("script-draft") as {
      properties: { scenes: { items: Record<string, unknown> } };
    };
    const scene = {
      position: 1,
      purpose: "提出问题",
      narration: "为什么越长不一定越好？",
      duration: 2,
      visual_strategy: "stock",
      visual_prompt: "手指滑过视频时间线",
      visible_action: "手指从左向右拖动片段",
      on_screen_text: "越长越好吗",
      sound_cue: "短促点击声",
      success_criteria: ["片段长度发生变化"],
      failure_conditions: ["看不到拖动动作"],
      search_terms: ["视频剪辑"],
    };
    assert.ok(scriptSchema.properties.scenes.items);
    assert.match(outputValidationErrorFor("script-draft", {
      viewerPromise: "给出一个可执行判断",
      narrativeArc: "问题、例子、结论",
      canonFacts: [],
      scenes: Array.from({ length: 5 }, (_, index) => ({
        ...scene,
        position: index === 3 ? 5 : index + 1,
      })),
    }) ?? "", /without gaps/);

    const validDirector = validDirectorPlan();
    validDirector.shots[1]!.scenePosition = 1;
    assert.match(outputValidationErrorFor("director-plan", validDirector) ?? "", /duplicates scene 1/);
  });

  it("requires integer 0-100 topic scores", () => {
    const valid = {
      ideas: [{
        signalId: "signal-1",
        track: "life-observation",
        title: "选题",
        audience: "城市上班族",
        painPoint: "下班后仍然疲惫",
        hook: "钩子",
        rationale: "理由",
        facts: [],
        uncertainties: ["尚未读取正文"],
        visualProof: "拍摄下班后用工具整理日程前后的可见对比，来自可复现实拍，动作变化比文字描述更直观。",
        visualPlan: {
          strategy: "同一本纸质时间账本贯穿前后对照。",
          beats: [{
            id: "ledger-before-after",
            role: "前后对照",
            duration: "0-6 秒",
            description: "俯拍同一只手划掉重复安排，再圈出省下的时间。",
            searchQuery: "paper planner hand before after",
            source: "creator",
          }],
        },
        visualFeasibility: 85,
        productionCostEfficiency: 90,
        novelty: 80,
        seriesPotential: 70,
        monetization: 60,
      }],
    };
    assert.equal(outputValidationErrorFor("topic-ideas", valid), undefined);
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], novelty: 80.5 }],
    }), "string");
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], monetization: 101 }],
    }), "string");
    assert.equal(outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], facts: [{ statement: "正文事实", sourceId: "signal-1", paragraphIds: ["p1"], uncertainty: null }] }],
    }), undefined);
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], facts: [{ statement: "正文事实", sourceId: "signal-1", paragraphIds: ["p1", "p1"], uncertainty: null }] }],
    }), "string");
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], facts: [{ statement: "正文事实", sourceId: "signal-1", paragraphIds: ["p1"] }] }],
    }), "string");
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], visualProof: undefined }],
    }), "string");
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [{ ...valid.ideas[0], visualProof: "" }],
    }), "string");
    const { visualPlan: _visualPlan, ...withoutVisualPlan } = valid.ideas[0]!;
    assert.equal(typeof outputValidationErrorFor("topic-ideas", {
      ideas: [withoutVisualPlan],
    }), "string");
  });

  it("requires a contiguous, strictly structured series roadmap", () => {
    const episode = {
      episodeNumber: 3,
      pillar: "真实实验",
      title: "验证一个真实任务",
      viewerPromise: "得到一个可执行结论",
      hook: "先看真实结果。",
      payoff: "完成实验并给出结论。",
      fromPrevious: ["承接已定版结论"],
      toNext: ["留下成本问题"],
    };
    assert.equal(outputValidationErrorFor("series-roadmap", { episodes: [episode, { ...episode, episodeNumber: 4, title: "核算成本" }] }), undefined);
    assert.match(outputValidationErrorFor("series-roadmap", { episodes: [episode, { ...episode, episodeNumber: 5, title: "核算成本" }] }) ?? "", /contiguous/);
    assert.equal(typeof outputValidationErrorFor("series-roadmap", { episodes: [{ ...episode, canon: "planned fact" }] }), "string");
  });

  it("pins the creative-treatment prompt pack and enforces beat-reference semantics", () => {
    const prompt = taskPromptFor("creative-treatment");
    assert.equal(prompt.version, "video-factory/treatment-director-v5");
    assert.match(prompt.directive, /不输出完整逐镜分镜.*不报价.*不声称画面或配音已完成/);
    assert.match(prompt.directive, /lockedViewerPromise.*保持其实际收益与事实边界/);
    assert.match(prompt.directive, /suppliedSourceIds 只能引用 suppliedSources 中的 id/);
    assert.match(prompt.directive, /现实事实、因果、实验结果、数字或具体事件/);
    assert.match(prompt.directive, /主观观察、创作启发、构图选择.*illustration_only.*not_needed/);
    assert.match(prompt.directive, /示意不能证明普遍结论.*不自动升级为外部来源要求/);
    assert.match(taskPromptFor("role-audit").directive, /边界声明.*不能单独作为 factual_support.*external_required/);
    assert.match(prompt.outputRules.join("\n"), /progression 输出 1 到 12 项，beatId 唯一/);
    assert.match(prompt.outputRules.join("\n"), /reworkInstruction/);

    const valid = validCreativeTreatment();
    assert.equal(outputValidationErrorFor("creative-treatment", valid), undefined);

    const duplicateBeat = structuredClone(valid);
    (duplicateBeat.progression as Array<Record<string, unknown>>)[1]!.beatId = "question";
    assert.match(outputValidationErrorFor("creative-treatment", duplicateBeat) ?? "", /beatId/);

    const missingEvidenceBeat = structuredClone(valid);
    (missingEvidenceBeat.evidenceRequirements as Array<Record<string, unknown>>)[0]!.beatId = "ghost";
    assert.match(outputValidationErrorFor("creative-treatment", missingEvidenceBeat) ?? "", /beatId/);

    const missingFeasibilityBeat = structuredClone(valid);
    (missingFeasibilityBeat.feasibilityQuestions as Array<Record<string, unknown>>)[0]!.beatId = "ghost";
    assert.match(outputValidationErrorFor("creative-treatment", missingFeasibilityBeat) ?? "", /beatId/);

    const blankPromise = structuredClone(valid);
    blankPromise.viewerPromise = " ";
    assert.match(outputValidationErrorFor("creative-treatment", blankPromise) ?? "", /viewerPromise/);

    const wrongVersion = structuredClone(valid);
    wrongVersion.version = "video-factory/creative-treatment-v1";
    assert.match(outputValidationErrorFor("creative-treatment", wrongVersion) ?? "", /version/);
  });

  it("rejects whitespace-only creative-treatment fields that the host parser rejects", () => {
    for (const testCase of creativeTreatmentWhitespaceInvalidCases()) {
      const output = legalCreativeTreatmentOutput();
      testCase.apply(output);
      const error = outputValidationErrorFor("creative-treatment", output) ?? "";
      assert.match(error, /must not be blank/, `${testCase.field} must be rejected as blank`);
      assert.ok(error.includes(testCase.field), `${testCase.field} must be named in: ${error}`);
    }
  });

  it("accepts padded legal creative-treatment text because the host trims it", () => {
    assert.equal(outputValidationErrorFor("creative-treatment", paddedLegalCreativeTreatmentOutput()), undefined);
  });

  it("pins the creative-treatment semantic rules version that owns the whitespace contract", () => {
    assert.equal(
      taskContractDescriptorFor("creative-treatment").semanticRulesVersion,
      "creative-treatment-semantics-v10|production-capabilities-v3|visual-plan-v2|host-readiness-v2|rework-instruction-v1|series-context-v1",
    );
  });
});
