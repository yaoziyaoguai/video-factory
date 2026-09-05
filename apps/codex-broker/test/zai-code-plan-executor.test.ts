import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { CodexExecutorError, codexExecutorProfileFor, parseTaskRequest } from "../src/codex-executor.js";
import { BROKER_TASK_KINDS } from "../src/task-definitions.js";
import { ZaiCodePlanExecutor } from "../src/zai-code-plan-executor.js";

const API_KEY = "test-only-zai-key";
const ZAI_CHAT_COMPLETIONS_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const ZAI_CODING_PLAN_URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions";

function scriptDraftTask() {
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "script-draft",
    payload: {
      brief: {
        title: "下班后先做一件事",
        angle: "用一个动作恢复精力",
        audience: "上班族",
        nicheSlug: "after-work",
        platform: "douyin",
        durationSeconds: 20,
      },
    },
  }, codexExecutorProfileFor("zai").identity);
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
    payload: {
      directorProfiles: [{ id: "documentary-observer" }],
      brief: { title: "下班后先做一件事", requestedProfileId: "auto" },
      scenes: [{ position: 1, narration: "先放下手机。", duration: 4 }],
      assetProviders: [{ id: "pexels-stock-v1", deliveryTypes: ["stock_video"] }],
      economics: { allowMeteredProviders: false },
    },
  }, codexExecutorProfileFor("zai").identity);
}

function validDirectorPlan(): Record<string, unknown> {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "auto",
    resolvedProfileId: "documentary-observer",
    profileRationale: "真实动作适合观察式表达",
    visualBible: {
      viewerPromise: "看清一个可执行动作",
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
      narrativeRole: "hook",
      authenticityPolicy: "illustrative",
      preferredProviderId: "pexels-stock-v1",
      deliveryType: "stock_video",
      alternativeProviderIds: [],
      subject: "一只手和手机",
      environment: "室内桌面",
      visibleAction: "手把手机放到桌面",
      temporalBeats: ["[0s-2s] 手持手机", "[2s-4s] 手机落到桌面"],
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

function visualReviewTask() {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    kind: "visual-review",
    payload: {
      durationMs: 10_000,
      frames: [{
        timecodeMs: 0,
        sha256: createHash("sha256").update(jpeg).digest("hex"),
        jpegBase64: jpeg.toString("base64"),
      }],
      reviewContext: { title: "测试短片", viewerPromise: "验证画面是否清晰" },
    },
  }, codexExecutorProfileFor("zai").identity);
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
      scenePosition: 1,
      targetNodeId: "assets",
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
  }, codexExecutorProfileFor("zai").identity);
}

function validRoleAudit(): Record<string, unknown> {
  return {
    version: "video-factory/role-audit-v1",
    verdict: "pass",
    score: 90,
    summary: "候选交付满足本轮验收标准。",
    issues: [],
    repairInstructions: [],
  };
}

describe("ZaiCodePlanExecutor", () => {
  it("does not fall through to the ambient process credential when an environment is injected", () => {
    const previous = process.env.ZAI_BIGMODEL_API_KEY;
    process.env.ZAI_BIGMODEL_API_KEY = "ambient-test-key";
    try {
      assert.throws(
        () => new ZaiCodePlanExecutor({ env: {} }),
        /ZAI_BIGMODEL_API_KEY environment variable is required/,
      );
    } finally {
      if (previous === undefined) delete process.env.ZAI_BIGMODEL_API_KEY;
      else process.env.ZAI_BIGMODEL_API_KEY = previous;
    }
  });

  it("sends bounded frames to the official BigModel Chat Completion endpoint and validates the report", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validReport()) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn,
      effort: "max",
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(capturedUrl, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
    assert.equal(new Headers(capturedInit?.headers).get("authorization"), `Bearer ${API_KEY}`);
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(body.model, "glm-5.3-flash");
    assert.equal(body.reasoning_effort, "max");
    assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false });
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.stream, false);
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
    assert.equal(result.trace?.providerId, "zai-bigmodel-api");
    assert.equal(result.trace?.modelId, "glm-5.3-flash");
    assert.equal(result.trace?.taskKind, "visual-review");
    assert.doesNotMatch(result.trace?.prompt ?? "", /base64|test-only-zai-key/i);
  });

  it("uses the configured visual-review model in both the request and trace", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const executor = new ZaiCodePlanExecutor({
      env: {
        ZAI_BIGMODEL_API_KEY: API_KEY,
        ZAI_VISUAL_REVIEW_MODEL_ID: "glm-5.3-flash-preview",
      },
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validReport()) } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(capturedBody?.model, "glm-5.3-flash-preview");
    assert.equal(result.trace?.modelId, "glm-5.3-flash-preview");
    assert.equal(executor.identity.modelId, "glm-5.3");
    assert.equal(executor.identity.taskModels?.["visual-review"], "glm-5.3-flash-preview");
  });

  it("normalizes xhigh to max for glm-5.3-flash requests and traces", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      effort: "xhigh",
      fetchFn: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validReport()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(visualReviewTask());

    assert.equal(capturedBody?.reasoning_effort, "max");
    assert.equal(result.trace?.reasoningEffort, "max");
  });

  it("sends script drafting to the ZAI Coding Plan endpoint with glm-5.3", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    let clock = 2_000;
    const output = validScriptDraft();
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      now: () => clock,
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        clock = 2_041;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(scriptDraftTask());

    assert.equal(capturedUrl, ZAI_CODING_PLAN_URL);
    assert.equal(capturedBody?.model, "glm-5.3");
    assert.equal(capturedBody?.reasoning_effort, "high");
    assert.equal(typeof (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content, "string");
    assert.deepEqual(JSON.parse(result.output), output);
    assert.equal(result.trace?.providerId, "zai-bigmodel-api");
    assert.equal(result.trace?.modelId, "glm-5.3");
    assert.equal(result.trace?.taskKind, "script-draft");
    assert.equal(result.trace?.providerWaitMs, 41);
    assert.equal(result.trace?.firstOutputEventMs, 41);
    assert.equal(result.trace?.toolMs, 0);
    assert.equal(result.trace?.validationMs, 0);
  });

  it("sends director planning to the ZAI Coding Plan endpoint with glm-5.3", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const output = validDirectorPlan();
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(directorPlanTask());

    assert.equal(capturedUrl, ZAI_CODING_PLAN_URL);
    assert.equal(capturedBody?.model, "glm-5.3");
    assert.equal(typeof (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content, "string");
    assert.deepEqual(JSON.parse(result.output), output);
    assert.equal(result.trace?.providerId, "zai-bigmodel-api");
    assert.equal(result.trace?.modelId, "glm-5.3");
    assert.equal(result.trace?.taskKind, "director-plan");
  });

  it("sends a role audit without images to Coding Plan with the text model", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validRoleAudit()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(roleAuditTask(false));

    assert.equal(capturedUrl, ZAI_CODING_PLAN_URL);
    assert.equal(capturedBody?.model, "glm-5.3");
    assert.equal(typeof (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content, "string");
    assert.equal(result.trace?.modelId, "glm-5.3");
  });

  it("sends a role audit with images to Chat Completions with the visual model", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validRoleAudit()) } }],
        }), { status: 200 });
      },
    });

    const result = await executor.runTask(roleAuditTask(true));

    assert.equal(capturedUrl, ZAI_CHAT_COMPLETIONS_URL);
    assert.equal(capturedBody?.model, "glm-5.3-flash");
    const content = (capturedBody?.messages as Array<{ content: unknown }>)[0]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0]?.type, "text");
    assert.equal(content[1]?.type, "image_url");
    assert.equal(result.trace?.modelId, "glm-5.3-flash");
  });

  it("advertises every broker task with the configured text and visual models", () => {
    const executor = new ZaiCodePlanExecutor({ env: { ZAI_BIGMODEL_API_KEY: API_KEY } });

    assert.deepEqual(executor.identity.taskKinds, BROKER_TASK_KINDS);
    for (const kind of BROKER_TASK_KINDS) {
      const expected = ["asset-rank", "reference-grammar", "visual-review"].includes(kind)
        ? "glm-5.3-flash"
        : "glm-5.3";
      assert.equal(executor.identity.taskModels?.[kind], expected);
    }
  });

  it("does not expose API error bodies or the credential", async () => {
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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
    const upstreamRequestId = "zai-upstream-request-secret";
    let clock = 1_000;
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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
          requestIdHash: createHash("sha256").update(upstreamRequestId).digest("hex"),
          providerId: "zai-bigmodel-api",
          modelId: "glm-5.3",
          providerWaitMs: 37,
        });
        const serialized = JSON.stringify(error.details);
        assert.doesNotMatch(serialized, new RegExp(API_KEY));
        assert.doesNotMatch(serialized, /private response|zai-upstream-request-secret/);
        return true;
      },
    );
  });

  it("does not classify a generic HTTP 500 response as transient", async () => {
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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

  it("classifies an explicit service-unavailable error code as transient", async () => {
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn: async () => new Response(new ReadableStream({ start() {} }), { status: 429 }),
      timeoutMs: 2_000,
    });
    const startedAt = Date.now();

    await assert.rejects(() => executor.runTask(visualReviewTask()), /HTTP 429/);

    assert.ok(Date.now() - startedAt < 1_000);
  });

  it("rejects an oversized success response without buffering it all", async () => {
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn: async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 }),
    });

    await assert.rejects(
      () => executor.runTask(visualReviewTask()),
      /response exceeds 1048576 bytes/,
    );
  });

  it("rejects malformed reports and findings outside the supplied duration", async () => {
    const responseFor = (report: unknown): typeof fetch => async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(report) } }],
    }), { status: 200 });

    await assert.rejects(
      () => new ZaiCodePlanExecutor({
        env: { ZAI_BIGMODEL_API_KEY: API_KEY },
        fetchFn: responseFor({ summary: "missing required fields" }),
      }).runTask(visualReviewTask()),
      (error: unknown) => {
        assert.ok(error instanceof CodexExecutorError);
        assert.match(error.message, /does not match visual-review schema/);
        assert.equal(error.details?.category, "invalid_output");
        assert.equal(error.details?.reasonCode, "output_contract");
        return true;
      },
    );

    const lateFinding = validReport();
    lateFinding.findings = [{
      timecodeMs: 10_001,
      scenePosition: 1,
      targetNodeId: "assets",
      category: "other",
      severity: "warning",
      description: "时间码超界。",
      suggestion: "重新定位。",
    }];
    await assert.rejects(
      () => new ZaiCodePlanExecutor({
        env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
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
        assert.equal(error.details?.providerId, "zai-bigmodel-api");
        assert.equal(error.details?.modelId, "glm-5.3");
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
    const executor = new ZaiCodePlanExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn,
      timeoutMs: 5,
    });

    await assert.rejects(() => executor.runTask(visualReviewTask()), /timed out/);
  });
});
