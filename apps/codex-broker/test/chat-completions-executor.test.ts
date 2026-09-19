import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { CodexExecutorError, codexExecutorProfileFor, parseTaskRequest } from "../src/codex-executor.js";
import { BROKER_TASK_KINDS, taskContractDescriptorFor } from "../src/task-definitions.js";
import {
  ChatCompletionsExecutor,
  DEEPSEEK_CHAT_COMPLETIONS_PROVIDER,
  type ChatCompletionsExecutorOptions,
} from "../src/chat-completions-executor.js";
import {
  creativeTreatmentRequest,
  creativeTreatmentSourceContractCases,
  creativeTreatmentWhitespaceInvalidCases,
  ghostBeatCreativeTreatmentOutput,
  legalCreativeTreatmentOutput,
  legalCreativeTreatmentOutputWithSourceRefs,
  paddedLegalCreativeTreatmentOutput,
} from "./fixtures/creative-treatment.js";

const API_KEY = "test-only-deepseek-key";
const CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";

/**
 * 这个文件测的是 chat-completions 引擎本身，与供应商无关；固定挂在 DeepSeek 描述符上，
 * 于是断言里的端点、标签与默认模型都只有一处出处。
 */
function chatExecutor(options: Omit<ChatCompletionsExecutorOptions, "provider">): ChatCompletionsExecutor {
  return new ChatCompletionsExecutor({ ...options, provider: DEEPSEEK_CHAT_COMPLETIONS_PROVIDER });
}

function scriptDraftTask() {
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "script-draft",
    expectedContractDigest: taskContractDescriptorFor("script-draft").digest,
    payload: {
      brief: {
        title: "下班后先做一件事",
        angle: "用一个动作恢复精力",
        audience: "上班族",
        nicheSlug: "after-work",
        platform: "douyin",
        durationSeconds: 20,
        productionCapabilities: {
          assetProviders: [],
          editing: { sourceRangeReuse: true, staticEditorialCard: false },
          audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
        },
      },
    },
  }, codexExecutorProfileFor("deepseek").identity);
}

function validScriptDraft(): Record<string, unknown> {
  const scene = {
    purpose: "推动叙事",
    narration: "先放下手机。",
    duration: 4,
    visual_strategy: "stock",
    visual_prompt: "手把手机放到桌面",
    visible_action: "手从画面右侧进入并放下手机",
    on_screen_text: "先停一下",
    sound_cue: "轻微落桌声",
    success_criteria: ["能看见手机落到桌面"],
    failure_conditions: ["手部动作被遮挡"],
    search_terms: ["hand puts phone on desk"],
  };
  return {
    viewerPromise: "用一个动作切换下班状态",
    narrativeArc: "提出疲惫问题，演示动作，给出结论",
    canonFacts: [],
    scenes: Array.from({ length: 5 }, (_, index) => ({ ...scene, position: index + 1 })),
  };
}

function directorPlanTask() {
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "director-plan",
    expectedContractDigest: taskContractDescriptorFor("director-plan").digest,
    payload: {
      directorProfiles: [{ id: "documentary-observer" }],
      brief: {
        title: "下班后先做一件事",
        requestedProfileId: "auto",
        productionCapabilities: {
          assetProviders: [{
            id: "pexels-stock-v1",
            deliveryTypes: ["stock_video"],
            supportsReferenceImage: false,
            strengths: ["真实环境与动作"],
            constraints: ["不能保证精确人物身份"],
          }],
          editing: { sourceRangeReuse: true, staticEditorialCard: false },
          audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
        },
      },
      scenes: [{ position: 1, narration: "先放下手机。", duration: 4 }],
      assetProviders: [{ id: "pexels-stock-v1", deliveryTypes: ["stock_video"] }],
      economics: { allowMeteredProviders: false },
    },
  }, codexExecutorProfileFor("deepseek").identity);
}

function validDirectorPlan(): Record<string, unknown> {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "auto",
    resolvedProfileId: "documentary-observer",
    profileRationale: "真实动作适合观察式表达",
    visualBible: {
      narrativeApproach: "问题到行动",
      motif: "手机与手部",
      pacing: "短促",
      composition: "竖屏近景",
      camera: "固定机位",
      color: "自然色",
      continuity: "保持手部运动方向",
      transitionGrammar: "动作切",
      sound: "保留真实环境声",
      antiPatterns: ["空泛氛围镜头"],
    },
    shots: [{
      scenePosition: 1,
      reuseFromScenePosition: null,
      referenceFromScenePosition: null,
      narrativeRole: "hook",
      authenticityPolicy: "illustrative",
      preferredProviderId: "pexels-stock-v1",
      deliveryType: "stock_video",
      alternativeProviderIds: [],
      subject: "一只手和手机",
      environment: "室内桌面",
      visibleAction: "手把手机放到桌面",
      temporalBeats: [
        { startSeconds: 0, endSeconds: 2, action: "手持手机" },
        { startSeconds: 2, endSeconds: 4, action: "手机落到桌面" },
      ],
      sourceInSeconds: 0,
      shotSize: "近景",
      camera: "固定机位",
      lighting: "自然侧光",
      negativeConstraints: ["不出现品牌标识"],
      referenceRequirements: [],
      successCriteria: ["完整看见放下动作"],
      query: "hand puts phone on desk",
      generationPrompt: "自然侧光下，一只手把手机放到室内桌面",
      rationale: "单一真实动作适合图库视频",
      continuityNote: "保持手从右向左运动",
      confidence: 0.9,
      estimatedCostCny: 0,
    }],
  };
}

function creativeTreatmentTask(suppliedSources: Array<Record<string, unknown>> = [{ sourceId: "source-1", label: "原始报道" }]) {
  return parseTaskRequest({
    ...creativeTreatmentRequest(),
    expectedContractDigest: taskContractDescriptorFor("creative-treatment").digest,
    payload: { ...creativeTreatmentRequest().payload, suppliedSources },
  }, codexExecutorProfileFor("deepseek").identity);
}

function visualReviewTask() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "visual-review",
    expectedContractDigest: taskContractDescriptorFor("visual-review").digest,
    payload: {
      durationMs: 10_000,
      frames: [{
        timecodeMs: 0,
        sha256: createHash("sha256").update(jpeg).digest("hex"),
        jpegBase64: jpeg.toString("base64"),
      }],
      reviewContext: { title: "测试短片", viewerPromise: "验证画面是否清晰" },
    },
  }, codexExecutorProfileFor("deepseek").identity);
}

function validReport(): Record<string, unknown> {
  return {
    version: "video-factory/visual-review-v1",
    summary: "画面主体清晰，字幕对比度需要提高。",
    scores: {
      composition: 86,
      continuity: 84,
      pacing: 80,
      legibility: 68,
      safety: 98,
    },
    findings: [{
      timecodeMs: 0,
      startTimecodeMs: 0,
      endTimecodeMs: 0,
      scenePosition: 1,
      targetNodeId: "assets",
      planningStageId: null,
      claimType: "static", evidenceStatus: "failed",
      evidenceFrameSha256: createHash("sha256")
        .update(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]))
        .digest("hex"),
      nextAction: "rework_asset",
      category: "legibility",
      severity: "warning",
      description: "浅色字幕与背景对比不足。",
      suggestion: "增加半透明深色底板。",
    }],
    confidence: 0.91,
    recommendation: "revise",
  };
}

function roleAuditTask(withImage: boolean) {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "role-audit",
    expectedContractDigest: taskContractDescriptorFor("role-audit").digest,
    payload: {
      role: "screenwriter",
      iteration: 1,
      criteria: ["开头必须在三秒内兑现观众承诺"],
      context: { title: "下班后先做一件事" },
      candidate: { hook: "先放下手机。" },
      ...(withImage ? {
        images: [{
          imageIndex: 1,
          sha256: createHash("sha256").update(jpeg).digest("hex"),
          jpegBase64: jpeg.toString("base64"),
        }],
      } : {}),
    },
  }, codexExecutorProfileFor("deepseek").identity);
}

function assetRankTask(withThumbnail: boolean) {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "asset-rank",
    expectedContractDigest: taskContractDescriptorFor("asset-rank").digest,
    payload: {
      version: "video-factory/asset-candidates-v1",
      scenes: [],
      thumbnails: withThumbnail ? [{
        scenePosition: 1,
        provider: "pexels",
        assetId: "asset-1",
        sha256: createHash("sha256").update(jpeg).digest("hex"),
        jpegBase64: jpeg.toString("base64"),
      }] : [],
    },
  }, codexExecutorProfileFor("deepseek").identity);
}

function validRoleAudit(): Record<string, unknown> {
  return {
    version: "video-factory/role-audit-v2",
    rubricVersion: "video-factory/role-quality-rubric-v1",
    assessments: [{
      targetPath: "",
      dimensions: [
        { dimension: "attention", score: 90, evidence: "开场就给出具体对象。" },
        { dimension: "progression", score: 90, evidence: "每场都在推进信息。" },
        { dimension: "payoff", score: 90, evidence: "结尾回答了原承诺。" },
        { dimension: "expression", score: 90, evidence: "旁白具体可理解。" },
      ],
    }],
    verdict: "pass",
    score: 90,
    summary: "候选交付满足本轮验收标准。",
    issues: [],
    repairInstructions: [],
    planningDisposition: null,
    hostReadinessReview: null,
  };
}

describe("ChatCompletionsExecutor", () => {
  it("does not fall through to the ambient process credential when an environment is injected", () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "ambient-test-key";
    try {
      assert.throws(
        () => chatExecutor({ env: {} }),
        /DEEPSEEK_API_KEY environment variable is required/,
      );
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("sends bounded frames to the Coding Plan Chat Completion endpoint and validates the report", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validReport()) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn,
      effort: "max",
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(capturedUrl, CHAT_COMPLETIONS_URL);
    assert.equal(new Headers(capturedInit?.headers).get("authorization"), `Bearer ${API_KEY}`);
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.reasoning_effort, "max");
    assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false });
    assert.deepEqual(body.response_format, { type: "json_object" });
    // 流式是契约的一部分：等待期若没有可观测事件，"模型在思考"与"连接已卡死"就无法区分。
    assert.equal(body.stream, true);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(API_KEY));
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.content[0]?.type, "text");
    assert.match(String(messages[0]?.content[0]?.text), /video-factory\/visual-review-v1/);
    assert.deepEqual(messages[0]?.content[1], {
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,/9j/4AAA/9k=" },
    });
    assert.deepEqual(JSON.parse(result.output), validReport());
    assert.equal(result.trace?.providerId, "deepseek");
    assert.equal(result.trace?.modelId, "deepseek-flash");
    assert.equal(result.trace?.taskKind, "visual-review");
    assert.doesNotMatch(result.trace?.prompt ?? "", /base64|test-only-deepseek-key/i);
  });

  it("uses the configured visual-review model in both the request and trace", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const executor = chatExecutor({
      env: {
        DEEPSEEK_API_KEY: API_KEY,
        DEEPSEEK_VISUAL_MODEL_ID: "deepseek-flash-preview",
      },
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validReport()) } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(capturedBody?.model, "deepseek-flash-preview");
    assert.equal(result.trace?.modelId, "deepseek-flash-preview");
    assert.equal(executor.identity.modelId, "deepseek-flash");
    assert.equal(executor.identity.taskModels?.["visual-review"], "deepseek-flash-preview");
  });

  it("sends the configured effort through unchanged", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      effort: "xhigh",
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validReport()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(capturedBody?.reasoning_effort, "xhigh");
    assert.equal(result.trace?.reasoningEffort, "xhigh");
  });

  it("ignores a requested model on a task that carries images", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      // 候选表里的模型不保证都能读图：deepseek-v4-pro 接受 image_url 却收不到图像。
      extraModelCandidates: ["deepseek-v4-pro"],
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validReport()) } }],
        }), { status: 200 });
      },
    });

    // 覆盖请求命中的是一条带图的复核：让看不见图的模型接过去，会产出一份格式合法、内容瞎猜的裁决。
    await executor.runTask(visualReviewTask(), { model: "deepseek-v4-pro" });

    assert.equal(capturedBody?.model, "deepseek-flash");
  });

  it("honours a requested model on a task that carries no images", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      extraModelCandidates: ["deepseek-v4-pro"],
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validScriptDraft()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(scriptDraftTask(), { model: "deepseek-v4-pro" });

    assert.equal(capturedBody?.model, "deepseek-v4-pro");
    assert.equal(result.trace?.modelId, "deepseek-v4-pro");
  });

  it("sends script drafting to the DeepSeek chat-completions endpoint with deepseek-flash", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let clock = 2_000;
    const output = validScriptDraft();
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      now: () => clock,
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        clock = 2_041;
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
          usage: {
            prompt_tokens: 1_200,
            completion_tokens: 3_400,
            total_tokens: 4_600,
            completion_tokens_details: { reasoning_tokens: 2_700 },
          },
        }), { status: 200, headers: { "x-request-id": "deepseek-success-request" } });
      },
    });

    const result = await executor.runTask(scriptDraftTask());

    assert.equal(capturedUrl, CHAT_COMPLETIONS_URL);
    assert.equal(
      ((capturedInit as RequestInit & { dispatcher?: { constructor?: { name?: string } } })?.dispatcher)?.constructor?.name,
      "Agent",
    );
    assert.equal(capturedBody?.model, "deepseek-flash");
    assert.equal(capturedBody?.reasoning_effort, "max");
    assert.equal(capturedBody?.max_tokens, 65_536);
    assert.equal(typeof (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content, "string");
    assert.deepEqual(JSON.parse(result.output), output);
    assert.equal(result.trace?.providerId, "deepseek");
    assert.equal(result.trace?.modelId, "deepseek-flash");
    assert.equal(result.trace?.taskKind, "script-draft");
    assert.equal(result.trace?.providerWaitMs, 41);
    assert.equal(result.trace?.firstOutputEventMs, 41);
    assert.equal(result.trace?.toolMs, 0);
    assert.equal(result.trace?.validationMs, 0);
    assert.equal(result.trace?.finishReason, "stop");
    assert.equal(result.trace?.promptTokens, 1_200);
    assert.equal(result.trace?.completionTokens, 3_400);
    assert.equal(result.trace?.totalTokens, 4_600);
    assert.equal(result.trace?.reasoningTokens, 2_700);
    assert.equal(result.trace?.requestIdHash, createHash("sha256").update("deepseek-success-request").digest("hex"));
  });

  it("classifies finish_reason length as truncated no-output before JSON parsing", async () => {
    const requestId = "deepseek-truncated-request";
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      now: () => 0,
      fetchFn: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: '{"viewerPromise":"unfinished' } }],
        usage: {
          prompt_tokens: 2_000,
          completion_tokens: 65_536,
          total_tokens: 67_536,
          completion_tokens_details: { reasoning_tokens: 61_000 },
        },
      }), { status: 200, headers: { "x-request-id": requestId } }),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.match(error.message, /output limit/);
        assert.equal(error.failureKind, "model_provider_no_output");
        assert.deepEqual(error.details, {
          category: "invalid_output",
          reasonCode: "output_truncated",
          providerId: "deepseek",
          modelId: "deepseek-flash",
          providerWaitMs: 0,
          requestIdHash: createHash("sha256").update(requestId).digest("hex"),
          finishReason: "length",
          promptTokens: 2_000,
          completionTokens: 65_536,
          totalTokens: 67_536,
          reasoningTokens: 61_000,
          modelAttemptCount: 1,
          structuredRepairCount: 0,
        });
        return true;
      },
    );
  });

  it("repairs one JSON contract failure without weakening the original visual-review task", async () => {
    const invalid = validReport();
    delete (invalid as Partial<typeof invalid>).version;
    let calls = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async (_input, init) => {
        calls += 1;
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const output = calls === 1 ? invalid : validReport();
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(result.output), validReport());
    assert.equal(result.trace?.modelAttemptCount, 2);
    assert.equal(result.trace?.structuredRepairCount, 1);
    const retryMessages = requestBodies[1]?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.match(String(retryMessages[0]?.content[0]?.text), /output\.version is required/);
    assert.match(String(retryMessages[0]?.content[0]?.text), /不得改变 scores、confidence、recommendation/);
    assert.doesNotMatch(String(retryMessages[0]?.content[0]?.text), /允许按确定性合同调整/);
    assert.equal(retryMessages[0]?.content.filter((item) => item.type === "image_url").length, 1);
    assert.equal(requestBodies[0]?.temperature, 1);
    assert.equal(requestBodies[1]?.temperature, 0.6);
  });

  it("repairs one unparseable reply instead of burning the round as invalid_json", async () => {
    // 实测故障（topic-ideas）：模型这轮话说了，只是形态不是 JSON。它与"JSON 合规但违反 schema"
    // 同属可修，过去却只有后者有修复轮，前者直接判终局，整轮模型调用就此作废。
    const prose = "这版方案我建议这样拍：先给出结论，再补三组证据。";
    let calls = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async (_input, init) => {
        calls += 1;
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const content = calls === 1 ? prose : JSON.stringify(validReport());
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(calls, 2, "unparseable reply must get exactly one repair attempt");
    assert.deepEqual(JSON.parse(result.output), validReport());
    assert.equal(result.trace?.modelAttemptCount, 2);
    assert.equal(result.trace?.structuredRepairCount, 1);
    const retryMessages = requestBodies[1]?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const retryPrompt = String(retryMessages[0]?.content[0]?.text);
    assert.match(retryPrompt, /不是合法 JSON/);
    assert.match(retryPrompt, /这版方案我建议这样拍/);
    // 什么都没解析出来，就不能告诉模型"上一份已完成内容判断"——那会诱导它现编一份判断来保护。
    assert.doesNotMatch(retryPrompt, /已完成内容判断/);
    assert.equal(requestBodies[0]?.temperature, 1);
    assert.equal(requestBodies[1]?.temperature, 0.6);
  });

  it("stops after one unparseable-reply repair and keeps the evidence", async () => {
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "仍然不是 JSON。" } }],
        }), { status: 200 });
      },
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.details?.reasonCode, "invalid_json");
        assert.equal(error.details?.structuredRepairCount, 1);
        assert.equal(error.details?.modelAttemptCount, 2);
        return true;
      },
    );
    assert.equal(calls, 2, "one accepted task may execute at most one structured repair");
  });

  it("allows a visual format repair to remove only an unsupported extra field", async () => {
    const invalid = { ...validReport(), internalNote: "must not cross the public contract" };
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(calls === 1 ? invalid : validReport()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(result.output), validReport());
  });

  it("rejects a visual format repair that changes evidence semantics", async () => {
    const invalid = validReport();
    delete (invalid as Partial<typeof invalid>).version;
    const changed = validReport();
    changed.scores = { composition: 96, continuity: 96, pacing: 96, legibility: 96, safety: 98 };
    changed.recommendation = "approve";
    changed.findings = [];
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(calls === 1 ? invalid : changed) } }],
        }), { status: 200 });
      },
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.details?.category, "invalid_output");
        assert.equal(error.details?.reasonCode, "repair_semantic_drift");
        return true;
      },
    );
    assert.equal(calls, 2);
  });

  it("rejects a visual format repair that redirects a finding to another production node", async () => {
    const invalid = validReport();
    delete (invalid as Partial<typeof invalid>).version;
    const changed = validReport();
    // 改成指向方案（并指明重做哪一段），输出本身仍然合法：被拒必须是因为格式修复动了语义，
    // 不是因为改出了非法取值。
    (changed.findings as Array<Record<string, unknown>>)[0]!.targetNodeId = "creative-planning";
    (changed.findings as Array<Record<string, unknown>>)[0]!.planningStageId = "script";
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(calls === 1 ? invalid : changed) } }],
        }), { status: 200 });
      },
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.details?.reasonCode, "repair_semantic_drift");
        return true;
      },
    );
    assert.equal(calls, 2);
  });

  it("sends director planning to the DeepSeek chat-completions endpoint with deepseek-flash", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const output = validDirectorPlan();
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(directorPlanTask());

    assert.equal(capturedUrl, CHAT_COMPLETIONS_URL);
    assert.equal(capturedBody?.model, "deepseek-flash");
    assert.equal(typeof (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content, "string");
    assert.deepEqual(JSON.parse(result.output), output);
    assert.equal(result.trace?.providerId, "deepseek");
    assert.equal(result.trace?.modelId, "deepseek-flash");
    assert.equal(result.trace?.taskKind, "director-plan");
  });

  it("repairs one semantically invalid director candidate inside the accepted broker task", async () => {
    const task = directorPlanTask();
    if (task.kind !== "director-plan") throw new Error("expected director-plan task");
    task.payload.scenes.push({ position: 2, narration: "抬头看看窗外。", duration: 4 });
    const invalid = validDirectorPlan();
    const invalidShots = invalid.shots as Array<Record<string, unknown>>;
    invalidShots.push({ ...invalidShots[0], scenePosition: 1, narrativeRole: "payoff" });
    const repaired = structuredClone(invalid);
    (repaired.shots as Array<Record<string, unknown>>)[1]!.scenePosition = 2;
    let calls = 0;
    let repairPrompt = "";
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async (_input, init) => {
        calls += 1;
        if (calls === 2) {
          const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
          repairPrompt = body.messages[0]!.content;
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(calls === 1 ? invalid : repaired) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(task);

    assert.equal(calls, 2);
    assert.match(repairPrompt, /duplicate_scene_position/);
    assert.match(repairPrompt, /output\.shots\[1\]\.scenePosition/);
    assert.deepEqual(JSON.parse(result.output), repaired);
  });

  it("stops after one director semantic repair when the repaired output is still invalid", async () => {
    const task = directorPlanTask();
    if (task.kind !== "director-plan") throw new Error("expected director-plan task");
    task.payload.scenes.push({ position: 2, narration: "抬头看看窗外。", duration: 4 });
    const invalid = validDirectorPlan();
    const invalidShots = invalid.shots as Array<Record<string, unknown>>;
    invalidShots.push({ ...invalidShots[0], scenePosition: 1, narrativeRole: "payoff" });
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(invalid) } }],
        }), { status: 200 });
      },
    });

    await assert.rejects(
      () => executor.runTask(task),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.details?.reasonCode, "duplicate_scene_position");
        assert.equal(error.details?.modelAttemptCount, 2);
        assert.equal(error.details?.structuredRepairCount, 1);
        return true;
      },
    );
    assert.equal(calls, 2, "one accepted task may execute at most one structured repair");
  });

  it("shares one repair budget across director semantic then schema failures", async () => {
    const task = directorPlanTask();
    if (task.kind !== "director-plan") throw new Error("expected director-plan task");
    task.payload.scenes.push({ position: 2, narration: "第二镜", duration: 4 });
    const semanticInvalid = validDirectorPlan();
    const shots = semanticInvalid.shots as Array<Record<string, unknown>>;
    shots.push({ ...shots[0], scenePosition: 1, narrativeRole: "payoff" });
    const schemaInvalid = structuredClone(semanticInvalid) as Record<string, unknown>;
    delete schemaInvalid.version;
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(calls === 1 ? semanticInvalid : schemaInvalid) } }],
        }), { status: 200 });
      },
    });

    await assert.rejects(() => executor.runTask(task), (error: unknown) => {
      assert.ok(error instanceof CodexExecutorError);
      assert.equal(error.details?.reasonCode, "task_schema");
      assert.equal(error.details?.modelAttemptCount, 2);
      assert.equal(error.details?.structuredRepairCount, 1);
      return true;
    });
    assert.equal(calls, 2);
  });

  it("sends a role audit without images to Coding Plan with the text model", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validRoleAudit()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(roleAuditTask(false));

    assert.equal(capturedUrl, CHAT_COMPLETIONS_URL);
    assert.equal(capturedBody?.model, "deepseek-flash");
    assert.equal(typeof (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content, "string");
    assert.equal(result.trace?.modelId, "deepseek-flash");
    // 没给审计强度时，复核沿用产出强度：这条路径的行为不该被新选项改变。
    assert.equal(capturedBody?.reasoning_effort, "max");
  });

  it("gives the independent audit its own effort while production keeps its own", async () => {
    const queued = [validScriptDraft(), validRoleAudit()];
    const efforts: unknown[] = [];
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      effort: "max",
      auditEffort: "high",
      fetchFn: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        efforts.push(body.reasoning_effort);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(queued.shift()) } }],
        }), { status: 200 });
      },
    });

    // 同一轮里跑两次：产出走产出强度，复核读的是已经成型的产出，走审计强度。
    const production = await executor.runTask(scriptDraftTask());
    const audit = await executor.runTask(roleAuditTask(false));

    assert.deepEqual(efforts, ["max", "high"]);
    assert.equal(production.trace?.reasoningEffort, "max");
    assert.equal(audit.trace?.reasoningEffort, "high");
  });

  it("runs creative-treatment on the text model and rejects the same invalid fixture as the OpenAI executor", async () => {
    let capturedUrl = "";
    let capturedPrompt = "";
    let capturedBody: Record<string, unknown> | undefined;
    const output = legalCreativeTreatmentOutput();
    const fetchFn: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const content = (capturedBody?.messages as Array<{ content: string }>)[0]?.content ?? "";
      capturedPrompt = typeof content === "string" ? content : "";
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
      }), { status: 200 });
    };
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn,
      effort: "max",
    });

    const result = await executor.runTask(creativeTreatmentTask());

    assert.equal(capturedUrl, CHAT_COMPLETIONS_URL);
    assert.equal(capturedBody?.model, "deepseek-flash");
    assert.equal(capturedBody?.reasoning_effort, "max");
    assert.match(capturedPrompt, /你在脚本写定前建立本片创作方向/);
    assert.match(capturedPrompt, /source-1/);
    assert.deepEqual(JSON.parse(result.output), output);
    assert.equal(result.trace?.taskKind, "creative-treatment");
    assert.equal(result.trace?.promptVersion, "video-factory/treatment-director-v6");

    await assert.rejects(
      async () => executor.runTask(creativeTreatmentTask([])),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, false);
        assert.match(error.message, /suppliedSourceIds/);
        return true;
      },
    );
  });

  it("rejects the shared ghost-beat fixture at the same semantic boundary as the OpenAI executor", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(ghostBeatCreativeTreatmentOutput()) } }],
      }), { status: 200 }),
    });

    await assert.rejects(
      async () => executor.runTask(creativeTreatmentTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, false);
        assert.match(error.message, /evidenceRequirements\[0\]\.beatId must reference a progression beat/);
        return true;
      },
    );
  });

  it("rejects every whitespace-invalid creative-treatment output from the shared matrix", async () => {
    for (const testCase of creativeTreatmentWhitespaceInvalidCases()) {
      const invalidOutput = legalCreativeTreatmentOutput();
      testCase.apply(invalidOutput);
      const executor = chatExecutor({
        env: { DEEPSEEK_API_KEY: API_KEY },
        fetchFn: async () => new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(invalidOutput) } }],
        }), { status: 200 }),
      });

      await assert.rejects(
        async () => executor.runTask(creativeTreatmentTask()),
        (error: unknown) => {
          assert.ok(error instanceof CodexExecutorError, `${testCase.field}: expected CodexExecutorError`);
          assert.equal(error.transient, false);
          assert.match(error.message, /must not be blank/, `${testCase.field} must be rejected as blank`);
          assert.ok(error.message.includes(testCase.field), `${testCase.field} must be named in: ${error.message}`);
          return true;
        },
      );
    }
  });

  it("accepts padded legal creative-treatment text because the host trims it", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(paddedLegalCreativeTreatmentOutput()) } }],
      }), { status: 200 }),
    });

    const result = await executor.runTask(creativeTreatmentTask());

    assert.equal(JSON.parse(result.output).viewerPromise, " 学会识别资料支持的结论边界 ");
  });

  it("applies trim-canonical source-id rules at the payload and output boundaries", async () => {
    for (const testCase of creativeTreatmentSourceContractCases()) {
      if (testCase.outcome === "payload-rejected") {
        await assert.rejects(
          async () => creativeTreatmentTask(testCase.suppliedSources),
          (error: unknown) => {
            assert.ok(error instanceof CodexExecutorError, `${testCase.label}: expected CodexExecutorError`);
            assert.match(error.message, /sourceId/, testCase.label);
            return true;
          },
        );
        continue;
      }
      const output = legalCreativeTreatmentOutputWithSourceRefs(testCase.suppliedSourceIds);
      const executor = chatExecutor({
        env: { DEEPSEEK_API_KEY: API_KEY },
        fetchFn: async () => new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
        }), { status: 200 }),
      });
      if (testCase.outcome === "accepted") {
        const result = await executor.runTask(creativeTreatmentTask(testCase.suppliedSources));
        assert.deepEqual(
          (JSON.parse(result.output) as { evidenceRequirements: Array<{ suppliedSourceIds: string[] }> }).evidenceRequirements[0]!.suppliedSourceIds,
          testCase.suppliedSourceIds,
          testCase.label,
        );
      } else {
        await assert.rejects(
          async () => executor.runTask(creativeTreatmentTask(testCase.suppliedSources)),
          (error: unknown) => {
            assert.ok(error instanceof CodexExecutorError, `${testCase.label}: expected CodexExecutorError`);
            assert.equal(error.transient, false);
            assert.match(error.message, /suppliedSourceIds/, testCase.label);
            return true;
          },
        );
      }
    }
  });

  it("repairs creative-treatment structure without touching existing contract content", async () => {
    let attempt = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        attempt += 1;
        const output = attempt === 1
          ? {
            ...legalCreativeTreatmentOutput(),
            draftNote: "结构外备注",
            hook: { ...(legalCreativeTreatmentOutput().hook as Record<string, unknown>), draftNote: "嵌套备注" },
          }
          : legalCreativeTreatmentOutput();
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(creativeTreatmentTask());

    assert.equal(attempt, 2);
    assert.deepEqual(JSON.parse(result.output), legalCreativeTreatmentOutput());
  });

  // JSON.parse 按 DefineOwnProperty 语义把 "__proto__"、"constructor"、"toString" 等键
  // 落成自有数据属性，等价于模型真实返回的 JSON；对象字面量与展开写法构造不出这类自有字段。
  function creativeTreatmentOutputWithOwnExtraField(field: string, value: unknown): Record<string, unknown> {
    const legal = legalCreativeTreatmentOutput();
    return JSON.parse(`{${JSON.stringify(field)}:${JSON.stringify(value)},${JSON.stringify(legal).slice(1)}`) as Record<string, unknown>;
  }

  // 额外字段即使与 Object.prototype 继承属性同名，也只是 strict schema 不支持的结构外内容；
  // 第二次结果只删除该字段且不改任何合同内容时必须成功，不允许撞上 repair 规则表的继承属性。
  for (const { field, value } of [
    { field: "draftNote", value: "结构外备注" },
    { field: "constructor", value: "结构外备注" },
    { field: "toString", value: "结构外备注" },
    { field: "__proto__", value: { note: "结构外备注" } },
  ] as const) {
    it(`allows a creative-treatment repair that only drops the extra own field ${JSON.stringify(field)}`, async () => {
      let attempt = 0;
      const executor = chatExecutor({
        env: { DEEPSEEK_API_KEY: API_KEY },
        fetchFn: async () => {
          attempt += 1;
          const output = attempt === 1
            ? creativeTreatmentOutputWithOwnExtraField(field, value)
            : legalCreativeTreatmentOutput();
          return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(output) } }],
          }), { status: 200 });
        },
      });

      const result = await executor.runTask(creativeTreatmentTask());

      assert.equal(attempt, 2);
      assert.deepEqual(JSON.parse(result.output), legalCreativeTreatmentOutput());
    });
  }

  it("rejects a creative-treatment repair that rewrites existing hook or progression content", async () => {
    // 第一次输出带结构外字段触发 repair；第二次输出 schema 合法但改写了已有合同内容。
    const schemaInvalidBaseline = () => ({ ...legalCreativeTreatmentOutput(), draftNote: "结构外备注" });
    const rewrittenHook = () => ({
      ...legalCreativeTreatmentOutput(),
      hook: { narrationIntent: "被改写的开头", visualIntent: "展示原始资料的关键差异" },
    });
    const rewrittenProgression = () => {
      const legal = legalCreativeTreatmentOutput();
      const progression = [...legal.progression as Array<Record<string, unknown>>];
      progression[1] = { ...progression[1]!, purpose: "被改写的段落职责" };
      return { ...legal, progression };
    };
    for (const drift of [rewrittenHook, rewrittenProgression]) {
      let attempt = 0;
      const executor = chatExecutor({
        env: { DEEPSEEK_API_KEY: API_KEY },
        fetchFn: async () => {
          attempt += 1;
          return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(attempt === 1 ? schemaInvalidBaseline() : drift()) } }],
          }), { status: 200 });
        },
      });
      await assert.rejects(
        async () => executor.runTask(creativeTreatmentTask()),
        (error: unknown) => {
          assert.ok(error instanceof CodexExecutorError);
          assert.equal(error.transient, false);
          assert.match(error.message, /format repair changed protected content/);
          assert.equal((error as CodexExecutorError & { details?: { reasonCode?: string } }).details?.reasonCode, "repair_semantic_drift");
          return true;
        },
      );
    }
  });

  it("sends a role audit with images to Chat Completions with the visual model", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validRoleAudit()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(roleAuditTask(true));

    assert.equal(capturedUrl, CHAT_COMPLETIONS_URL);
    assert.equal(capturedBody?.model, "deepseek-flash");
    const content = (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0]?.type, "text");
    assert.equal(content[1]?.type, "image_url");
    assert.equal(result.trace?.modelId, "deepseek-flash");
  });

  it("advertises every broker task with the configured text and visual models", () => {
    const executor = chatExecutor({
      env: {
        DEEPSEEK_API_KEY: API_KEY,
        DEEPSEEK_MODEL_ID: "text-custom",
        DEEPSEEK_VISUAL_MODEL_ID: "visual-custom",
      },
    });

    assert.deepEqual(executor.identity.taskKinds, BROKER_TASK_KINDS);
    for (const kind of BROKER_TASK_KINDS) {
      const expected = ["asset-rank", "reference-grammar", "visual-review"].includes(kind)
        ? "visual-custom"
        : "text-custom";
      assert.equal(executor.identity.taskModels?.[kind], expected);
    }
    assert.deepEqual(executor.identity.taskModelRoutes, {
      "asset-rank": { withoutImages: "text-custom", withImages: "visual-custom" },
      "role-audit": { withoutImages: "text-custom", withImages: "visual-custom" },
    });
  });

  it("uses the same declared model route for asset ranking with and without thumbnails", async () => {
    const models: unknown[] = [];
    const executor = chatExecutor({
      env: {
        DEEPSEEK_API_KEY: API_KEY,
        DEEPSEEK_MODEL_ID: "text-custom",
        DEEPSEEK_VISUAL_MODEL_ID: "visual-custom",
      },
      fetchFn: async (_input, init) => {
        models.push((JSON.parse(String(init?.body)) as Record<string, unknown>).model);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            version: "video-factory/asset-ranking-v1",
            source: "model",
            providerId: "deepseek",
            modelId: "test",
            summary: "没有候选需要排序。",
            scenes: [],
          }) } }],
        }), { status: 200 });
      },
    });

    const withoutThumbnail = await executor.runTask(assetRankTask(false));
    const withThumbnail = await executor.runTask(assetRankTask(true));

    assert.deepEqual(models, ["text-custom", "visual-custom"]);
    assert.equal(withoutThumbnail.trace?.modelId, "text-custom");
    assert.equal(withThumbnail.trace?.modelId, "visual-custom");
  });

  it("does not expose API error bodies or the credential", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        JSON.stringify({ error: { code: "1308", message: `upstream echoed ${API_KEY}` } }),
        { status: 429 },
      ),
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 429 \(code 1308\)/);
        assert.doesNotMatch(error.message, new RegExp(API_KEY));
        assert.doesNotMatch(error.message, /upstream echoed/);
        return true;
      },
    );
  });

  it("keeps safe structured diagnostics for a non-2xx provider response", async () => {
    const upstreamRequestId = "deepseek-upstream-request-secret";
    let clock = 1_000;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      now: () => clock,
      fetchFn: async () => {
        clock = 1_037;
        return new Response(
          JSON.stringify({ error: { code: "1308", message: `private response ${API_KEY}` } }),
          { status: 429, headers: { "x-request-id": upstreamRequestId } },
        );
      },
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.deepEqual(error.details, {
          category: "rate_limited",
          reasonCode: "1308",
          scope: "provider_account",
          requestIdHash: createHash("sha256").update(upstreamRequestId).digest("hex"),
          providerId: "deepseek",
          modelId: "deepseek-flash",
          providerWaitMs: 37,
          modelAttemptCount: 1,
          structuredRepairCount: 0,
        });
        const serialized = JSON.stringify(error.details);
        assert.doesNotMatch(serialized, new RegExp(API_KEY));
        assert.doesNotMatch(serialized, /private response|deepseek-upstream-request-secret/);
        return true;
      },
    );
  });

  it("preserves an explicit model retirement code without treating a bare 404 as one", async () => {
    const explicitModelFailure = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        JSON.stringify({ error: { code: "model_not_found", message: "private upstream detail" } }),
        { status: 404 },
      ),
    });
    const barePathFailure = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(JSON.stringify({ error: { message: "private upstream detail" } }), { status: 404 }),
    });

    await assert.rejects(() => explicitModelFailure.runTask(scriptDraftTask()), (error: unknown) => {
      assert.ok(error instanceof CodexExecutorError);
      assert.equal(error.details?.category, "invalid_request");
      assert.equal(error.details?.reasonCode, "model_not_found");
      return true;
    });
    await assert.rejects(() => barePathFailure.runTask(scriptDraftTask()), (error: unknown) => {
      assert.ok(error instanceof CodexExecutorError);
      assert.equal(error.details?.category, "invalid_request");
      assert.equal(error.details?.reasonCode, "http_404");
      return true;
    });
  });

  it("classifies account credentials, balance, and generic rate limits without exposing provider text", async () => {
    const cases: Array<{
      status: number;
      body: unknown;
      category: "authentication" | "payment_required" | "rate_limited";
      reasonCode: string;
    }> = [
      { status: 401, body: { error: { message: "private authentication detail" } }, category: "authentication", reasonCode: "http_401" },
      { status: 403, body: { error: { message: "private permission detail" } }, category: "authentication", reasonCode: "http_403" },
      { status: 402, body: { error: { code: "insufficient_quota", message: "private balance detail" } }, category: "payment_required", reasonCode: "insufficient_quota" },
      { status: 429, body: { error: { message: "private throttling detail" } }, category: "rate_limited", reasonCode: "http_429" },
    ];

    for (const item of cases) {
      const executor = chatExecutor({
        env: { DEEPSEEK_API_KEY: API_KEY },
        fetchFn: async () => new Response(JSON.stringify(item.body), { status: item.status }),
      });
      await assert.rejects(() => executor.runTask(scriptDraftTask()), (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.details?.category, item.category);
        assert.equal(error.details?.reasonCode, item.reasonCode);
        assert.equal(error.details?.scope, "provider_account");
        assert.doesNotMatch(JSON.stringify(error.details), /private (?:authentication|permission|balance|throttling) detail/);
        return true;
      });
    }
  });

  it("does not classify a generic HTTP 500 response as transient", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        JSON.stringify({ error: { code: "execution_failed" } }),
        { status: 500 },
      ),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, false);
        assert.equal(error.details?.category, "execution_failed");
        assert.equal(error.details?.reasonCode, "http_500");
        return true;
      },
    );
  });

  it("classifies an HTTP 408 response as a timeout-category transient failure", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(null, { status: 408 }),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.match(error.message, /HTTP 408/);
        assert.equal(error.transient, true);
        assert.equal(error.details?.category, "timeout");
        assert.equal(error.details?.reasonCode, "http_408");
        return true;
      },
    );
  });

  it("classifies the underlying Undici response-headers deadline without exposing its message", async () => {
    let clock = 5_000;
    const privateMessage = `headers timeout leaked ${API_KEY}`;
    const providerError = Object.assign(new Error(privateMessage), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      now: () => clock,
      fetchFn: async () => {
        clock = 305_051;
        throw new TypeError("fetch failed", { cause: providerError });
      },
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, true);
        assert.match(error.message, /response headers timed out/);
        assert.deepEqual(error.details, {
          category: "timeout",
          reasonCode: "response_headers_timeout",
          providerId: "deepseek",
          modelId: "deepseek-flash",
          providerWaitMs: 300_051,
          executionLayer: "provider_transport",
          networkCode: "UND_ERR_HEADERS_TIMEOUT",
          headersReceived: false,
          localExecutionEnded: true,
          remoteQueryable: false,
          modelAttemptCount: 1,
          structuredRepairCount: 0,
        });
        assert.doesNotMatch(error.message, new RegExp(API_KEY));
        assert.doesNotMatch(JSON.stringify(error.details), /headers timeout leaked/);
        return true;
      },
    );
  });

  it("classifies an explicit service-unavailable error code as transient", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        JSON.stringify({ error: { code: "service_unavailable" } }),
        { status: 500 },
      ),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, true);
        assert.equal(error.details?.category, "service_unavailable");
        assert.equal(error.details?.reasonCode, "service_unavailable");
        return true;
      },
    );
  });

  it("does not classify an explicit invalid-request response as transient", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        JSON.stringify({ error: { code: "invalid_request" } }),
        { status: 503 },
      ),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, false);
        assert.equal(error.details?.category, "invalid_request");
        assert.equal(error.details?.reasonCode, "invalid_request");
        return true;
      },
    );
  });

  it("classifies an empty successful response as provider no-output", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(JSON.stringify({
        choices: [{ message: { content: "" } }],
      }), { status: 200 }),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, false);
        assert.equal(error.failureKind, "model_provider_no_output");
        assert.equal(error.details?.category, "execution_failed");
        assert.equal(error.details?.reasonCode, "no_output");
        return true;
      },
    );
  });

  it("does not let a stalled HTTP error body occupy the broker request timeout", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(new ReadableStream({ start() {} }), { status: 429 }),
      timeoutMs: 2_000,
    });
    const startedAt = Date.now();

    await assert.rejects(() => executor.runTask(visualReviewTask()), /HTTP 429/);

    assert.ok(Date.now() - startedAt < 1_000);
  });

  it("rejects an oversized success response and names the reason", async () => {
    // 传输上限随 max_tokens 预算推导（65536×512=32MB）：F15 的教训是 8MB 会被一次
    // 合法的 xhigh 长审计（reasoning 逐 token 的 SSE 信封）在未超 token 预算时撞穿。
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(new Uint8Array(32 * 1024 * 1024 + 1), { status: 200 }),
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.match(error.message, /response exceeds 33554432 bytes/);
        // 这个原因码是终态失败唯一留下的证据：没有它，上游只能打出笼统的"服务端错误（HTTP 422）"。
        assert.equal(error.details?.reasonCode, "response_too_large");
        return true;
      },
    );
  });

  // 订阅额度、推理长度这些"模型确实在工作"的失败，过去会被合进同一个 1 MiB 上限里，
  // 于是 deepseek-flash 在 max 强度下思考 110 秒就被判成总编不可用，全站静默退回规则保底。
  // 这里钉住不变量：被丢弃的 reasoning 帧只受传输上限约束，不占交付内容的配额。
  it("does not charge discarded reasoning frames against the delivered answer limit", async () => {
    const payload = JSON.stringify(validReport());
    const encoder = new TextEncoder();
    const reasoningFrame = (text: string): string =>
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`;
    const frames = [
      // 40 帧 × 32 KB ≈ 1.25 MB 的推理流，已经超过交付上限，但一个字节都不该算进答案。
      ...Array.from({ length: 40 }, () => reasoningFrame("思考".repeat(5_500))),
      `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const fetchFn: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn,
      timeoutMs: 5_000,
    });

    const result = await executor.runTask(visualReviewTask());

    assert.deepEqual(JSON.parse(result.output), validReport());
    assert.equal(result.trace?.finishReason, "stop");
  });

  it("rejects malformed reports and findings outside the supplied duration", async () => {
    const responseFor = (report: unknown): typeof fetch => async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(report) } }],
    }), { status: 200 });

    await assert.rejects(
      () => chatExecutor({
        env: { DEEPSEEK_API_KEY: API_KEY },
        fetchFn: responseFor({ summary: "missing required fields" }),
      }).runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.match(error.message, /does not match visual-review schema/);
        assert.equal(error.details?.category, "invalid_output");
        assert.equal(error.details?.reasonCode, "task_schema");
        return true;
      },
    );

    const lateFinding = validReport();
    lateFinding.findings = [{
      timecodeMs: 10_001,
      startTimecodeMs: 10_001,
      endTimecodeMs: 10_001,
      scenePosition: 1,
      targetNodeId: "assets",
      planningStageId: null,
      claimType: "static", evidenceStatus: "failed",
      evidenceFrameSha256: createHash("sha256")
        .update(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]))
        .digest("hex"),
      nextAction: "rework_asset",
      category: "other",
      severity: "warning",
      description: "时间码超界。",
      suggestion: "重新定位。",
    }];
    await assert.rejects(
      () => chatExecutor({
        env: { DEEPSEEK_API_KEY: API_KEY },
        fetchFn: responseFor(lateFinding),
      }).runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.match(error.message, /timecodeMs exceeds payload.durationMs/);
        assert.equal(error.details?.category, "invalid_output");
        assert.equal(error.details?.reasonCode, "timecode_out_of_bounds");
        return true;
      },
    );
  });

  it("classifies non-JSON model output without retaining the response body", async () => {
    const privateOutput = `not-json-${API_KEY}`;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(JSON.stringify({
        choices: [{ message: { content: privateOutput } }],
      }), { status: 200 }),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.details?.category, "invalid_output");
        assert.equal(error.details?.reasonCode, "invalid_json");
        assert.equal(error.details?.providerId, "deepseek");
        assert.equal(error.details?.modelId, "deepseek-flash");
        assert.equal(typeof error.details?.providerWaitMs, "number");
        assert.doesNotMatch(JSON.stringify(error.details), new RegExp(API_KEY));
        assert.doesNotMatch(JSON.stringify(error.details), /not-json/);
        return true;
      },
    );
  });

  it("keeps the timeout active while the response body is still streaming", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(validReport()) } }],
    }));
    const fetchFn: typeof fetch = async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(encoded);
          controller.close();
        }, 40);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(init.signal?.reason);
        }, { once: true });
      },
    }), { status: 200 });
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn,
      timeoutMs: 5,
    });

    await assert.rejects(() => executor.runTask(visualReviewTask()), /timed out/);
  });

  it("measures the first output event on an SSE stream and assembles deltas split across chunks", async () => {
    const payload = JSON.stringify(validReport());
    const encoder = new TextEncoder();
    // 故意把 JSON 在中间切开，证明跨分片的行缓冲与 delta 累加都是真的而不是一次整包读取。
    const frames: Array<{ delayMs: number; text: string }> = [
      { delayMs: 0, text: ": keep-alive\n\n" },
      { delayMs: 0, text: `data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(0, 40) } }] })}\n\n` },
      { delayMs: 150, text: `data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(40) } }] })}\n\n` },
      {
        delayMs: 150,
        text: `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1_200,
            completion_tokens: 3_400,
            total_tokens: 4_600,
            completion_tokens_details: { reasoning_tokens: 2_700 },
          },
        })}\n\n`,
      },
      { delayMs: 150, text: "data: [DONE]\n\n" },
    ];
    const fetchFn: typeof fetch = async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        let index = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const push = (): void => {
          const frame = frames[index];
          index += 1;
          if (frame === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(frame.text));
          timer = setTimeout(push, frame.delayMs);
        };
        push();
        init?.signal?.addEventListener("abort", () => {
          if (timer !== undefined) clearTimeout(timer);
          controller.error(init.signal?.reason);
        }, { once: true });
      },
    }), { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "deepseek-streamed-request" } });
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn,
      timeoutMs: 5_000,
    });

    const result = await executor.runTask(visualReviewTask());

    assert.deepEqual(JSON.parse(result.output), validReport());
    assert.equal(result.trace?.finishReason, "stop");
    assert.equal(result.trace?.promptTokens, 1_200);
    assert.equal(result.trace?.completionTokens, 3_400);
    assert.equal(result.trace?.totalTokens, 4_600);
    assert.equal(result.trace?.reasoningTokens, 2_700);
    assert.equal(result.trace?.requestIdHash, createHash("sha256").update("deepseek-streamed-request").digest("hex"));
    const firstOutputEventMs = result.trace?.firstOutputEventMs;
    const providerWaitMs = result.trace?.providerWaitMs;
    assert.equal(typeof firstOutputEventMs, "number");
    assert.equal(typeof providerWaitMs, "number");
    // 首字节测得出来且显著早于整体时长：这正是"模型在长时间思考"与"连接已经死在等"的区分依据。
    assert.ok(
      (firstOutputEventMs ?? 0) + 100 < (providerWaitMs ?? 0),
      `expected the first output event (${firstOutputEventMs} ms) well before the whole wait (${providerWaitMs} ms)`,
    );
    assert.doesNotMatch(JSON.stringify(result.trace), new RegExp(API_KEY));
  });

  it("preserves a UTF-8 character split across SSE chunks", async () => {
    const payload = JSON.stringify(validReport());
    const frame = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const encoded = new TextEncoder().encode(frame);
    const splitAt = encoded.findIndex((byte, index) => byte >= 0xc2 && byte <= 0xf4 && index + 1 < encoded.length);
    assert.ok(splitAt > 0, "fixture must contain a multi-byte UTF-8 code point");
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.slice(0, splitAt + 1));
          controller.enqueue(encoded.slice(splitAt + 1));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });

    const result = await executor.runTask(visualReviewTask());

    assert.deepEqual(JSON.parse(result.output), validReport());
  });

  it("does not accept a partial SSE response as a completed model result", async () => {
    const payload = JSON.stringify(validReport());
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });

    await assert.rejects(() => executor.runTask(visualReviewTask()), (error: unknown) => {
      assert.ok(error instanceof CodexExecutorError);
      assert.equal(error.details?.category, "invalid_output");
      assert.equal(error.details?.reasonCode, "stream_incomplete");
      return true;
    });
  });

  it("fails fast when an SSE stream never produces an output event", async () => {
    const encoder = new TextEncoder();
    let aborted = false;
    const fetchFn: typeof fetch = async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        // 只发心跳、从不出字：连接看起来还活着，但已经没有任何产出。
        const timer = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 10);
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          clearInterval(timer);
          controller.error(init.signal?.reason);
        }, { once: true });
      },
    }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn,
      timeoutMs: 5_000,
      firstOutputEventTimeoutMs: 60,
    });
    const startedAt = Date.now();

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.match(error.message, /no output event within 60 ms/);
        assert.equal(error.transient, true);
        assert.equal(error.failureKind, "model_provider_no_output");
        assert.equal(error.outcomeUncertain, true);
        assert.equal(error.details?.category, "timeout");
        assert.equal(error.details?.reasonCode, "response_first_output_timeout");
        assert.equal(error.details?.providerId, "deepseek");
        assert.equal(error.details?.modelId, "deepseek-flash");
        assert.equal(error.details?.executionLayer, "provider_transport");
        assert.equal(error.details?.headersReceived, true);
        assert.equal(error.details?.remoteQueryable, false);
        assert.ok((error.details?.providerWaitMs ?? 0) >= 60);
        return true;
      },
    );

    // 卡死必须在整体超时之前暴露，否则等待期又变回不可观测。
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(aborted, true);
  });

  it("treats a stream that ends without content as provider no-output", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });

    await assert.rejects(
      () => executor.runTask(scriptDraftTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, false);
        assert.equal(error.failureKind, "model_provider_no_output");
        assert.equal(error.details?.reasonCode, "no_output");
        return true;
      },
    );
  });

  it("rejects a stream frame that is not a data event", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        'event: ping\ndata: {"choices":[{"delta":{"content":"{}"}}]}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.transient, false);
        assert.equal(error.details?.category, "invalid_output");
        assert.equal(error.details?.reasonCode, "output_contract");
        return true;
      },
    );
  });

  it("keeps a whole JSON response on the envelope path even when its body looks like SSE", async () => {
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => new Response(
        'data: {"choices":[{"delta":{"content":"{}"}}]}\n\n',
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.equal(error.details?.reasonCode, "invalid_json");
        return true;
      },
    );
  });
});

describe("ChatCompletionsExecutor reviewed model override", () => {
  it("announces one candidate when both roles point at the same model, and the extras alongside it", () => {
    // 文本与视觉都默认是 deepseek-flash：同一个模型不该在候选表里出现两遍。
    const collapsed = chatExecutor({ env: { DEEPSEEK_API_KEY: API_KEY } });
    assert.deepEqual(collapsed.modelCandidates, ["deepseek-flash"]);

    const split = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY, DEEPSEEK_VISUAL_MODEL_ID: "deepseek-v4-pro" },
      extraModelCandidates: ["deepseek-v4-pro", "deepseek-flash"],
    });
    assert.deepEqual(split.modelCandidates, ["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("runs a text task on a candidate model when the request asks for it", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      extraModelCandidates: ["deepseek-v4-pro"],
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validScriptDraft()) } }],
        }), { status: 200 });
      },
    });

    // script-draft 默认走 deepseek-flash；覆盖成另一个已审核模型必须同时改请求体和 trace。
    const result = await executor.runTask(scriptDraftTask(), { model: "deepseek-v4-pro" });

    assert.equal(capturedBody?.model, "deepseek-v4-pro");
    assert.equal(result.trace?.modelId, "deepseek-v4-pro");
  });

  it("rejects an unreviewed model instead of sending it upstream", async () => {
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    await assert.rejects(
      executor.runTask(scriptDraftTask(), { model: "deepseek-9-unreviewed" }),
      /is not in the reviewed model candidates/,
    );
    assert.equal(calls, 0);
  });

  it("refuses an effort override because the runtime configuration pins the effort", async () => {
    let calls = 0;
    const executor = chatExecutor({
      env: { DEEPSEEK_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });

    // 强度来自 broker 的运行时配置：收下一个不会生效的值就是骗用户。
    await assert.rejects(
      executor.runTask(scriptDraftTask(), { effort: "low" }),
      /pins reasoning effort in its runtime configuration/,
    );
    assert.equal(calls, 0);
  });
});
