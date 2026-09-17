import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexBridgeError,
  FallbackCodexTaskClient,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexTaskSession,
} from "../src/index.js";

class ControlledClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; requestId?: string; session?: CodexTaskSession }> = [];

  constructor(
    private readonly providerId: string,
    private readonly modelId: string,
    private readonly respond: (kind: CodexTaskKind) => unknown,
  ) {
    super({ socketPath: `/tmp/${providerId}.sock` });
  }

  override async runTaskDetailed(
    kind: CodexTaskKind,
    _payload: unknown,
    requestId?: string,
    session?: CodexTaskSession,
  ): Promise<CodexTaskExecution> {
    this.calls.push({ kind, ...(requestId ? { requestId } : {}), ...(session ? { session } : {}) });
    const output = this.respond(kind);
    return {
      output,
      trace: {
        taskKind: kind,
        promptVersion: `test/${kind}`,
        prompt: `prompt:${kind}`,
        providerId: this.providerId,
        modelId: this.modelId,
      },
      ...(session ? { session: { key: session.key, handle: `${this.providerId}-session` } } : {}),
    };
  }
}

describe("FallbackCodexTaskClient", () => {
  it("switches providers only for a classified provider failure and records the attempt chain", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", true, "not_accepted", 503, "model_provider_transient");
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ideas: [] }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["topic-ideas", "role-audit"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["topic-ideas", "role-audit"] },
      ],
    });

    const result = await client.runTaskDetailed("topic-ideas", {}, "topic-request", { key: "topic-session" });

    assert.deepEqual(result.trace?.attemptedModelIds, ["gpt-5.6-sol", "deepseek-flash"]);
    assert.equal(result.trace?.fallbackFromModelId, "gpt-5.6-sol");
    assert.deepEqual(result.trace?.modelCandidateAttempts?.map((attempt) => attempt.outcome), ["failed", "succeeded"]);
    assert.equal(openai.calls[0]?.requestId, "topic-request");
    assert.notEqual(deepseek.calls[0]?.requestId, "topic-request");
    assert.equal(deepseek.calls[0]?.session?.handle, undefined);
  });

  it("keeps later calls in one session on the provider that accepted it", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", true, "not_accepted", 503, "model_provider_transient");
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["series-roadmap"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["series-roadmap"] },
      ],
    });

    const first = await client.runTaskDetailed("series-roadmap", {}, "series-1", { key: "series-session" });
    await client.runTaskDetailed("series-roadmap", {}, "series-2", first.session);

    assert.equal(openai.calls.length, 1);
    assert.equal(deepseek.calls.length, 2);
    assert.equal(deepseek.calls[1]?.session?.handle, "deepseek-session");
  });

  it("keeps a stateless backup on the same provider without sending unsupported session fields", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", true, "not_accepted", 503, "model_provider_transient");
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        {
          client: deepseek,
          providerId: "deepseek",
          modelId: "deepseek-flash",
          taskKinds: ["publish-copy"],
          sessionMode: "stateless",
        },
      ],
    });

    await client.runTaskDetailed("publish-copy", {}, "publish-1", { key: "publish-session" });
    await client.runTaskDetailed("publish-copy", {}, "publish-2", { key: "publish-session" });

    assert.equal(openai.calls.length, 1);
    assert.equal(deepseek.calls.length, 2);
    assert.equal(deepseek.calls[0]?.session, undefined);
    assert.equal(deepseek.calls[1]?.session, undefined);
  });

  it("still switches providers after a not_accepted service-unavailable rejection", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("Codex bridge returned HTTP 503.", true, "not_accepted", 503);
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["publish-copy"] },
      ],
    });

    const result = await client.runTaskDetailed("publish-copy", {}, "publish-primary");

    assert.deepEqual(result.trace?.modelCandidateAttempts?.map((attempt) => [
      attempt.modelId,
      attempt.outcome,
      attempt.failureStage,
    ]), [
      ["gpt-5.6-sol", "failed", "not_accepted"],
      ["deepseek-flash", "succeeded", undefined],
    ]);
    assert.equal(openai.calls[0]?.requestId, "publish-primary");
    assert.equal(deepseek.calls.length, 1);
  });

  it("does not generate a fallback requestId when the primary outcome is uncertain", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("request timed out after 285000ms; the task may still be executing", false, "uncertain");
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["publish-copy"] },
      ],
    });

    await assert.rejects(
      () => client.runTaskDetailed("publish-copy", {}, "publish-uncertain"),
      (error: unknown) => {
        assert.ok(error instanceof CodexBridgeError);
        assert.equal(error.stage, "uncertain");
        return true;
      },
    );

    assert.deepEqual(openai.calls, [{ kind: "publish-copy", requestId: "publish-uncertain" }]);
    assert.equal(deepseek.calls.length, 0);
  });

  it("switches providers after the broker confirms a classified transient failure", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", false, "completed_failure", 503, "model_provider_transient");
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["publish-copy"] },
      ],
    });

    const execution = await client.runTaskDetailed("publish-copy", {}, "publish-completed-failure");
    assert.deepEqual(execution.output, { ok: true });
    assert.equal(deepseek.calls.length, 1);
    assert.match(deepseek.calls[0]?.requestId ?? "", /^backup-/);
  });

  it("does not switch providers for invalid output or business validation failures", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("Output contract is invalid.", false, "completed_failure", 422);
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["publish-copy"] },
      ],
    });

    await assert.rejects(() => client.runTaskDetailed("publish-copy", {}), /Output contract is invalid/);
    assert.equal(deepseek.calls.length, 0);
  });

  it("switches providers when the configured model id is retired", async () => {
    // 模型被下线或改名：provider 回 404，Broker 照实归类成 invalid_request 并把 404 记进
    // reasonCode。这条腿必须换下一个候选——停下来会让人以为自己的请求有问题，而合同一个字都没错。
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("Codex bridge returned HTTP 422.", false, "completed_failure", 422, undefined, {
        category: "invalid_request",
        reasonCode: "http_404",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
      });
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["publish-copy"] },
      ],
    });

    const execution = await client.runTaskDetailed("publish-copy", {}, "publish-retired-model");
    assert.deepEqual(execution.output, { ok: true });
    assert.equal(deepseek.calls.length, 1);
    assert.match(deepseek.calls[0]?.requestId ?? "", /^backup-/);
  });

  it("does not switch providers for a request-contract violation", async () => {
    // 同样是 invalid_request，但 reasonCode 说的是"请求本身不合合同"。换第二个模型只会把
    // 合同 bug 掩盖成"第二个模型也不行"，所以这条腿必须停下并保留原证据。
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("Codex bridge returned HTTP 422.", false, "completed_failure", 422, undefined, {
        category: "invalid_request",
        reasonCode: "contract_mismatch",
        providerId: "codex-broker",
        modelId: "gpt-5.6-sol",
      });
    });
    const deepseek = new ControlledClient("deepseek", "deepseek-flash", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        { client: deepseek, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["publish-copy"] },
      ],
    });

    await assert.rejects(() => client.runTaskDetailed("publish-copy", {}), /HTTP 422/);
    assert.equal(deepseek.calls.length, 0);
  });
});
