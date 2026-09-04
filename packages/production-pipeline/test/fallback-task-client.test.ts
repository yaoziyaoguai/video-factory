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
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", false, "completed_failure", 503, "model_provider_transient");
    });
    const zai = new ControlledClient("zai-bigmodel-api", "glm-5.3", () => ({ ideas: [] }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["topic-ideas", "role-audit"] },
        { client: zai, providerId: "zai-bigmodel-api", modelId: "glm-5.3", taskKinds: ["topic-ideas", "role-audit"] },
      ],
    });

    const result = await client.runTaskDetailed("topic-ideas", {}, "topic-request", { key: "topic-session" });

    assert.deepEqual(result.trace?.attemptedModelIds, ["gpt-5.6-sol", "glm-5.3"]);
    assert.equal(result.trace?.fallbackFromModelId, "gpt-5.6-sol");
    assert.deepEqual(result.trace?.modelCandidateAttempts?.map((attempt) => attempt.outcome), ["failed", "succeeded"]);
    assert.equal(openai.calls[0]?.requestId, "topic-request");
    assert.notEqual(zai.calls[0]?.requestId, "topic-request");
    assert.equal(zai.calls[0]?.session?.handle, undefined);
  });

  it("keeps later calls in one session on the provider that accepted it", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", false, "completed_failure", 503, "model_provider_transient");
    });
    const zai = new ControlledClient("zai-bigmodel-api", "glm-5.3", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["series-roadmap"] },
        { client: zai, providerId: "zai-bigmodel-api", modelId: "glm-5.3", taskKinds: ["series-roadmap"] },
      ],
    });

    const first = await client.runTaskDetailed("series-roadmap", {}, "series-1", { key: "series-session" });
    await client.runTaskDetailed("series-roadmap", {}, "series-2", first.session);

    assert.equal(openai.calls.length, 1);
    assert.equal(zai.calls.length, 2);
    assert.equal(zai.calls[1]?.session?.handle, "zai-bigmodel-api-session");
  });

  it("keeps a stateless backup on the same provider without sending unsupported session fields", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("OpenAI service temporarily unavailable.", false, "completed_failure", 503, "model_provider_transient");
    });
    const zai = new ControlledClient("zai-bigmodel-api", "glm-5.3", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        {
          client: zai,
          providerId: "zai-bigmodel-api",
          modelId: "glm-5.3",
          taskKinds: ["publish-copy"],
          sessionMode: "stateless",
        },
      ],
    });

    await client.runTaskDetailed("publish-copy", {}, "publish-1", { key: "publish-session" });
    await client.runTaskDetailed("publish-copy", {}, "publish-2", { key: "publish-session" });

    assert.equal(openai.calls.length, 1);
    assert.equal(zai.calls.length, 2);
    assert.equal(zai.calls[0]?.session, undefined);
    assert.equal(zai.calls[1]?.session, undefined);
  });

  it("does not switch providers for invalid output or business validation failures", async () => {
    const openai = new ControlledClient("openai", "gpt-5.6-sol", () => {
      throw new CodexBridgeError("Output contract is invalid.", false, "completed_failure", 422);
    });
    const zai = new ControlledClient("zai-bigmodel-api", "glm-5.3", () => ({ ok: true }));
    const client = new FallbackCodexTaskClient({
      candidates: [
        { client: openai, providerId: "openai", modelId: "gpt-5.6-sol", taskKinds: ["publish-copy"] },
        { client: zai, providerId: "zai-bigmodel-api", modelId: "glm-5.3", taskKinds: ["publish-copy"] },
      ],
    });

    await assert.rejects(() => client.runTaskDetailed("publish-copy", {}), /Output contract is invalid/);
    assert.equal(zai.calls.length, 0);
  });
});
