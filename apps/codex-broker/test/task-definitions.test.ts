import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } from "../../../packages/production-pipeline/src/codex-chat.js";
import { CODEX_BRIDGE_PROTOCOL_VERSION } from "../src/codex-executor.js";
import {
  BROKER_TASK_KINDS,
  outputSchemaFor,
  outputValidationErrorFor,
  taskContractDescriptorFor,
  taskPromptFor,
} from "../src/task-definitions.js";

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
    temporalBeats: ["[0s-1s] 观看", "[1s-2s] 上滑"],
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
      viewerPromise: "给出清楚判断",
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
    assert.equal(
      REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["visual-review"],
      taskContractDescriptorFor("visual-review").digest,
    );
    assert.equal(
      REQUIRED_CODEX_TASK_CONTRACT_DIGESTS["role-audit"],
      taskContractDescriptorFor("role-audit").digest,
    );
  });
  it("pins protocol v2 and owns prompts for every allowed task kind", () => {
    assert.equal(CODEX_BRIDGE_PROTOCOL_VERSION, "video-factory/codex-bridge-v2");
    assert.deepEqual(BROKER_TASK_KINDS, [
      "topic-ideas",
      "series-roadmap",
      "director-plan",
      "script-draft",
      "publish-copy",
      "asset-rank",
      "reference-grammar",
      "visual-review",
      "role-audit",
    ]);

    assert.match(taskPromptFor("topic-ideas").directive, /中文短视频选题总编/);
    assert.match(taskPromptFor("series-roadmap").directive, /系列总编兼 showrunner/);
    assert.match(taskPromptFor("director-plan").directive, /导演不是素材配方/);
    assert.match(taskPromptFor("script-draft").directive, /短视频平台的创意编剧/);
    assert.match(taskPromptFor("publish-copy", "douyin").directive, /抖音/);
    assert.match(taskPromptFor("asset-rank").directive, /语义选片师/);
    assert.match(taskPromptFor("reference-grammar").directive, /参考视频分析师/);
    assert.match(taskPromptFor("visual-review").directive, /视觉审片/);
    assert.match(taskPromptFor("role-audit").directive, /独立于生产角色的质量审计 Agent/);
    assert.match(taskPromptFor("role-audit").directive, /不得发明输入中不存在的验收要求/);
    assert.match(taskPromptFor("role-audit").directive, /不得把下游节点尚未产出的证据/);
    assert.match(taskPromptFor("role-audit").directive, /上一轮审计/);
    assert.match(taskPromptFor("role-audit").directive, /不得要求新增或配置输入中不存在的 Provider/);
    assert.match(taskPromptFor("director-plan").directive, /不得要求新增一个输入中不存在的 Provider/);
    assert.match(
      taskPromptFor("visual-review").outputRules.join("\n"),
      /version 必须固定为 video-factory\/visual-review-v1/,
    );
    assert.match(taskPromptFor("visual-review").outputRules.join("\n"), /severity 只能是 info、warning、critical/);

    const neutral = taskPromptFor("publish-copy", "somewhere-else").directive;
    assert.match(neutral, /中性/);
    assert.doesNotMatch(neutral, /抖音/);
  });

  it("pins prompt-pack versions and production-quality role contracts", () => {
    const topic = taskPromptFor("topic-ideas");
    const script = taskPromptFor("script-draft");
    const director = taskPromptFor("director-plan");
    const review = taskPromptFor("visual-review");

    assert.equal(topic.version, "video-factory/topic-editor-v7");
    assert.equal(script.version, "video-factory/screenwriter-v14");
    assert.equal(director.version, "video-factory/director-v25");
    assert.equal(review.version, "video-factory/visual-review-v13");
    assert.match(review.outputRules.join("\n"), /不得为了通过审计而美化评分/);
    assert.match(review.directive, /真实来源材料自带.*editorial_card.*renderManifest.*不因‘出现文字’本身打回/);
    assert.match(review.directive, /生成模型自造的标签、乱码.*内部工作流术语.*必须留下 failed/);
    assert.match(review.directive, /主体、物体、动作.*不得 recommendation=approve/);
    assert.match(review.directive, /pilotScenePositions.*仅审列出的试片镜头/);
    assert.match(review.directive, /证据不足.*补充已有素材.*不能直接要求重新付费生成/);
    assert.match(review.directive, /scale-to-fill.*center crop.*不能仅因源素材画幅比例存在轻微偏差.*rework_asset/);
    assert.match(
      review.directive,
      /方案本身在当前 Provider 能力边界内无法兑现.*visual-direction 或 script.*replan_upstream.*不得.*assets.*重复付费生成/,
    );
    assert.match(
      review.directive,
      /上游.*不承诺.*精确身份.*不能豁免.*同一人物、物件或空间.*replan_upstream/,
    );
    assert.match(
      review.examples.join("\n"),
      /"startTimecodeMs".*"evidenceStatus":"not_observed".*"evidenceFrameSha256":null.*"nextAction":"inspect_existing_media"/,
    );
    assert.match(review.outputRules.join("\n"), /scenePosition.*targetNodeId/);
    assert.match(topic.directive, /值得做视频/);
    assert.match(topic.directive, /visualPlan/);
    assert.match(topic.directive, /待试片验证的实现方案.*不是已经发生或已经核验的事实/);
    assert.match(topic.directive, /模板.*不能.*覆盖/);
    assert.match(script.directive, /观众承诺/);
    assert.match(script.directive, /镜头数量由观众收益和可执行动作决定/);
    assert.match(script.directive, /每秒约 2 到 6 个汉字/);
    assert.match(script.directive, /每个 scene 必须能由一段素材从开头独立执行/);
    assert.match(script.directive, /事实陈述.*绝对化断言/);
    assert.match(script.directive, /单变量对照.*画面可核验/);
    assert.match(script.directive, /生成式画面.*不能.*真实实验|真实因果/);
    assert.match(script.directive, /最后半秒.*简短行动提示/);
    assert.match(script.directive, /shotSlots 不是灵感列表.*不能用同一故事段落中的相邻动作替代/);
    assert.match(script.directive, /只有输入明确列出停帧能力.*固定机位.*近静止关键状态/);
    assert.match(director.directive, /选择其中的 metered Provider 只是形成报价/);
    assert.match(taskPromptFor("role-audit").directive, /真实付费审批在下游执行/);
    assert.match(script.directive, /成功条件/);
    assert.match(script.directive, /visualProof 与 visualPlan.*不得用 templateBlueprint 的通用镜头机械覆盖/);
    assert.match(director.directive, /逐秒动作/);
    assert.match(director.directive, /shots 只输出 affectedScenePositions/);
    assert.match(director.directive, /负面约束/);
    assert.match(director.directive, /Provider Compiler/);
    assert.match(director.directive, /deliveryType/);
    assert.match(director.directive, /移动、出现、消失、亮度变化.*stock_video 或 generated_video/);
    assert.match(director.directive, /静态图片冒充动作已经完成/);
    assert.match(director.directive, /未列出自有素材库存/);
    assert.match(director.directive, /只交付一张静态卡片/);
    assert.match(director.directive, /图库是检索而不是生成/);
    assert.match(director.directive, /不得假设图库视频自带停帧.*固定机位的近静止连续画面/);
    assert.match(director.directive, /事实证据.*不得改成 generated/);
    assert.match(director.directive, /生成式画面.*不得.*现实因果|真实实验/);
    assert.match(director.directive, /精确多步动作.*事实证据/);
    assert.match(director.directive, /3 到 8 个具体英文概念/);
    assert.match(director.directive, /onScreenText.*soundCue/);
    assert.match(director.directive, /完整方案.*真实报价/);
    assert.match(director.directive, /visualProof 与 visualPlan.*不得用 templateBlueprint 的通用镜头机械覆盖/);
    assert.match(director.directive, /costFeedback.*重规划偏好/);
    assert.match(director.directive, /目标预计费用.*不是硬门禁/);
    assert.match(director.directive, /不得.*说明卡.*降级/);
    assert.match(director.directive, /REUSE_ONLY scene N/);
    assert.match(director.directive, /reuseFromScenePosition=N/);
    assert.match(director.directive, /referenceFromScenePosition=N/);
    assert.match(director.directive, /supportsReferenceImage=true/);
    assert.match(director.directive, /参考图生成会正常调用和报价/);
    assert.match(director.directive, /不得只在 generationPrompt、continuityNote 等文字里描述参考关系/);
    assert.match(director.directive, /未使用对应路由时输出 null/);
    assert.match(director.directive, /独立生成且没有复用.*generated_image/);
    assert.match(director.directive, /静态交付.*一个.*状态节拍/);
    assert.match(director.directive, /只允许引用更早镜头/);
    assert.match(director.directive, /不会重新搜索、生成或计费/);
    assert.match(director.directive, /不会产生新的动作、光线变化或画面状态/);
    assert.match(director.directive, /temporalBeats.*最终成片使用的镜头时长/);
    assert.match(director.directive, /最短时长.*裁切.*多出的尾部/);
    const rank = taskPromptFor("asset-rank");
    assert.equal(rank.version, "video-factory/asset-rank-v3");
    assert.match(rank.directive, /主体、物体、动作.*硬门槛/);
    assert.match(rank.directive, /没有任何.*合格候选.*诚实的 no-match/);
    assert.match(rank.directive, /低于自动执行阈值/);
    assert.match(rank.directive, /输入候选本来为空.*原样保留空数组/);
    assert.match(director.directive, /没有可执行的免费或复用方案.*保留可执行的付费镜头.*重新报价/);
    assert.doesNotMatch(director.directive, /付费镜头上限是硬边界/);
    assert.doesNotMatch(director.directive, /costPolicy/);
    assert.doesNotMatch(script.directive, /costPolicy/);
    assert.match(director.outputRules.join("\n"), /不要逐字复述脚本/);
    assert.match(director.outputRules.join("\n"), /每个标量字段最多一句/);
    assert.match(review.directive, /脚本.*导演意图/);
    assert.match(review.directive, /逐场核对/);
    assert.match(review.directive, /scene_triplets.*opening.*middle.*closing/);
    assert.match(review.directive, /scene_sequence.*高密度帧.*近似保持时长/);
    assert.match(review.directive, /hook_and_scene_midpoints.*scene_change_keyframes/);
    assert.match(review.directive, /稀疏证据/);
    assert.match(review.directive, /不得仅因未覆盖而自动给出 revise/);
    assert.ok(script.examples.some((example) => /反例/.test(example)));
    assert.ok(director.examples.some((example) => /\[0s-2s\]/.test(example)));
  });

  it("allows the topic editor to return an explicit empty shortlist and treats signal links as leads", () => {
    const topic = taskPromptFor("topic-ideas");
    assert.match(topic.directive, /sourceId、url、collectedAt 只是来源线索/);
    assert.match(topic.directive, /榜单排名和热度不足事实证据/);
    assert.match(topic.directive, /每个顶层信号是一个 canonical topic/);
    assert.match(topic.directive, /relatedSignals.*同一事件的关联报道/);
    assert.match(topic.directive, /signalId.*顶层 canonical id/);
    assert.match(topic.directive, /来源数量门槛由下游/);
    assert.match(topic.directive, /不得仅因来源数量不足.*空短名单/);
    assert.match(topic.directive, /空短名单/);
    assert.match(topic.directive, /ideas 为空数组/);
    assert.match(topic.task, /内容价值或视频表现价值.*不足时.*空 ideas 数组/);
    assert.match(topic.outputRules.join("\n"), /空数组只能表示.*内容或视觉价值不足/);
  });

  it("owns a strict output schema for every allowed task kind", () => {
    const requiredByKind = new Map([
      ["topic-ideas", ["ideas"]],
      ["series-roadmap", ["episodes"]],
      ["director-plan", ["version", "requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]],
      ["script-draft", ["viewerPromise", "narrativeArc", "canonFacts", "scenes"]],
      ["publish-copy", ["title", "description", "hashtags"]],
      ["asset-rank", ["version", "source", "providerId", "modelId", "summary", "scenes"]],
      ["reference-grammar", ["version", "summary", "durationMs", "pacing", "composition", "camera", "color", "transitions", "sound", "beats", "reusableRules", "avoidCopying", "confidence"]],
      ["visual-review", ["version", "summary", "scores", "findings", "confidence", "recommendation"]],
      ["role-audit", ["version", "verdict", "score", "summary", "issues", "repairInstructions"]],
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

  it("requires inspectable shot intent instead of accepting generic scene prose", () => {
    const scriptSchema = outputSchemaFor("script-draft") as {
      required: string[];
      properties: { scenes: { minItems: number; items: { required: string[] } } };
    };
    const directorSchema = outputSchemaFor("director-plan") as {
      properties: { shots: { items: { required: string[]; properties: { temporalBeats: { minItems: number } } } } };
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
    assert.equal(scriptSchema.properties.scenes.minItems, 3);
    assert.equal(directorSchema.properties.shots.items.properties.temporalBeats.minItems, 1);
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
          evidenceStatus: "failed",
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
        evidenceStatus: "failed",
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
        evidenceStatus: "failed",
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
        evidenceStatus: "failed",
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
        targetNodeId: "script",
        evidenceStatus: "failed",
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
});
