import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { codexExecutorProfileFor, parseTaskRequest } from "../src/codex-executor.js";
import { ZaiVisualReviewExecutor } from "../src/zai-visual-review-executor.js";

const API_KEY = "test-only-zai-key";

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
      category: "legibility",
      severity: "warning",
      description: "浅色字幕与背景对比不足。",
      suggestion: "增加半透明深色底板。",
    }],
    confidence: 0.91,
    recommendation: "revise",
  };
}

describe("ZaiVisualReviewExecutor", () => {
  it("does not fall through to the ambient process credential when an environment is injected", () => {
    const previous = process.env.ZAI_BIGMODEL_API_KEY;
    process.env.ZAI_BIGMODEL_API_KEY = "ambient-test-key";
    try {
      assert.throws(
        () => new ZaiVisualReviewExecutor({ env: {} }),
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
    const executor = new ZaiVisualReviewExecutor({
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
    const executor = new ZaiVisualReviewExecutor({
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
    assert.equal(executor.identity.modelId, "glm-5.3-flash-preview");
  });

  it("rejects non-visual work before any network request", async () => {
    let calls = 0;
    const executor = new ZaiVisualReviewExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn: async () => {
        calls += 1;
        return new Response();
      },
    });
    const task = parseTaskRequest({
      protocolVersion: "video-factory/codex-bridge-v2",
      kind: "topic-ideas",
      payload: { signals: [] },
    });

    await assert.rejects(() => executor.runTask(task), /not allowed for the ZAI visual-review executor/);
    assert.equal(calls, 0);
  });

  it("does not expose API error bodies or the credential", async () => {
    const executor = new ZaiVisualReviewExecutor({
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

  it("does not let a stalled HTTP error body occupy the broker request timeout", async () => {
    const executor = new ZaiVisualReviewExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn: async () => new Response(new ReadableStream({ start() {} }), { status: 429 }),
      timeoutMs: 2_000,
    });
    const startedAt = Date.now();

    await assert.rejects(() => executor.runTask(visualReviewTask()), /HTTP 429/);

    assert.ok(Date.now() - startedAt < 1_000);
  });

  it("rejects an oversized success response without buffering it all", async () => {
    const executor = new ZaiVisualReviewExecutor({
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
      () => new ZaiVisualReviewExecutor({
        env: { ZAI_BIGMODEL_API_KEY: API_KEY },
        fetchFn: responseFor({ summary: "missing required fields" }),
      }).runTask(visualReviewTask()),
      /does not match visual-review schema/,
    );

    const lateFinding = validReport();
    lateFinding.findings = [{
      timecodeMs: 10_001,
      category: "other",
      severity: "warning",
      description: "时间码超界。",
      suggestion: "重新定位。",
    }];
    await assert.rejects(
      () => new ZaiVisualReviewExecutor({
        env: { ZAI_BIGMODEL_API_KEY: API_KEY },
        fetchFn: responseFor(lateFinding),
      }).runTask(visualReviewTask()),
      /timecodeMs exceeds payload.durationMs/,
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
    const executor = new ZaiVisualReviewExecutor({
      env: { ZAI_BIGMODEL_API_KEY: API_KEY },
      fetchFn,
      timeoutMs: 5,
    });

    await assert.rejects(() => executor.runTask(visualReviewTask()), /timed out/);
  });
});
