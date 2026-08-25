import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexScreenwriterAgent,
  type CodexTaskKind,
  type ScreenwriterAgentInput,
  validateScriptDraft,
} from "../src/index.js";

class CapturingCodexClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];

  constructor(private readonly respond: () => unknown) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTask(kind: CodexTaskKind, payload: unknown): Promise<unknown> {
    this.calls.push({ kind, payload });
    return this.respond();
  }
}

function screenwriterInput(durationSeconds = 24): ScreenwriterAgentInput {
  return {
    brief: {
      title: "下班后别急着做这 3 件事",
      angle: "用三条具体动作减少下班后的决策消耗",
      audience: "普通上班族",
      nicheSlug: "life-avoidance",
      platform: "douyin",
      durationSeconds,
    },
  };
}

function validScene(position: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    position,
    narration: `第 ${position} 场旁白：一个具体动作。`,
    duration: 8,
    visual_strategy: "stock",
    visual_prompt: `第 ${position} 场画面：日常动作竖屏近景`,
    search_terms: ["下班回家", "日常动作"],
    ...overrides,
  };
}

function validDraft(): { scenes: Array<Record<string, unknown>> } {
  return { scenes: [validScene(1), validScene(2), validScene(3)] };
}

describe("CodexScreenwriterAgent", () => {
  it("sends the script-draft payload and returns the validated draft", async () => {
    const codexClient = new CapturingCodexClient(() => validDraft());
    const agent = new CodexScreenwriterAgent({ client: codexClient });
    const input = screenwriterInput();

    const result = await agent.draft(input);

    assert.deepEqual(result, validDraft());
    assert.equal(agent.id, "codex-screenwriter-v1");
    assert.equal(codexClient.calls.length, 1);
    assert.equal(codexClient.calls[0]?.kind, "script-draft");
    const payload = codexClient.calls[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload, { brief: input.brief });
    assert.equal("directive" in payload, false);
  });

  it("rejects invalid brief targets before sending anything to codex", async () => {
    const codexClient = new CapturingCodexClient(() => validDraft());
    const agent = new CodexScreenwriterAgent({ client: codexClient });

    await assert.rejects(() => agent.draft(screenwriterInput(5)), /integer between 20 and 180/);
    await assert.rejects(() => agent.draft(screenwriterInput(200)), /integer between 20 and 180/);
    await assert.rejects(() => agent.draft(screenwriterInput(24.5)), /integer between 20 and 180/);
    assert.equal(codexClient.calls.length, 0);
  });

  it("validateScriptDraft enforces its own target bounds", () => {
    assert.throws(
      () => validateScriptDraft(validDraft(), { durationSeconds: 5 }),
      /target durationSeconds must be an integer between 20 and 180/,
    );
    assert.throws(
      () => validateScriptDraft(validDraft(), { durationSeconds: 24.5 }),
      /target durationSeconds must be an integer between 20 and 180/,
    );
    assert.deepEqual(validateScriptDraft(validDraft(), { durationSeconds: 24 }), validDraft());
  });

  it("rejects non-contract drafts without any fallback", async () => {
    const cases: Array<{ name: string; output: () => unknown; pattern: RegExp }> = [
      { name: "missing scenes", output: () => ({}), pattern: /scenes must be an array/ },
      {
        name: "too few scenes",
        output: () => ({ scenes: [validScene(1), validScene(2)] }),
        pattern: /between 3 and 10 scenes; got 2/,
      },
      {
        name: "too many scenes",
        output: () => ({ scenes: Array.from({ length: 11 }, (_, index) => validScene(index + 1)) }),
        pattern: /between 3 and 10 scenes; got 11/,
      },
      {
        name: "position gap",
        output: () => ({ scenes: [validScene(1), validScene(2), validScene(4)] }),
        pattern: /contiguous integers starting at 1/,
      },
      {
        name: "duplicate position",
        output: () => ({ scenes: [validScene(1), validScene(2), validScene(2)] }),
        pattern: /contiguous integers starting at 1/,
      },
      {
        name: "invalid strategy",
        output: () => ({ scenes: [validScene(1), validScene(2), validScene(3, { visual_strategy: "editorial" })] }),
        pattern: /visual_strategy must be one of stock, image, local/,
      },
      {
        name: "empty search terms",
        output: () => ({ scenes: [validScene(1), validScene(2, { search_terms: [] }), validScene(3)] }),
        pattern: /search_terms must be an array of 1 to 8 strings/,
      },
      {
        name: "blank search term",
        output: () => ({ scenes: [validScene(1), validScene(2, { search_terms: ["待办清单", "  "] }), validScene(3)] }),
        pattern: /search_terms\[1\] must be a non-empty string/,
      },
      {
        name: "duplicate search terms",
        output: () => ({ scenes: [validScene(1), validScene(2, { search_terms: ["待办清单", "待办清单"] }), validScene(3)] }),
        pattern: /must not contain duplicate terms after trimming/,
      },
      {
        name: "total duration too long",
        output: () => ({ scenes: [validScene(1, { duration: 15 }), validScene(2, { duration: 15 }), validScene(3, { duration: 15 })] }),
        pattern: /outside 0\.6-1\.4x/,
      },
      {
        name: "total duration too short",
        output: () => ({ scenes: [validScene(1, { duration: 3 }), validScene(2, { duration: 3 }), validScene(3, { duration: 3 })] }),
        pattern: /outside 0\.6-1\.4x/,
      },
      {
        name: "empty narration",
        output: () => ({ scenes: [validScene(1, { narration: " " }), validScene(2), validScene(3)] }),
        pattern: /scenes\[0\]\.narration must be a non-empty string/,
      },
      {
        name: "non-finite duration",
        output: () => ({ scenes: [validScene(1, { duration: Number.POSITIVE_INFINITY }), validScene(2), validScene(3)] }),
        pattern: /duration must be a finite positive number/,
      },
    ];
    for (const testCase of cases) {
      const codexClient = new CapturingCodexClient(testCase.output);
      const agent = new CodexScreenwriterAgent({ client: codexClient });
      await assert.rejects(() => agent.draft(screenwriterInput()), testCase.pattern);
      assert.equal(codexClient.calls.length, 1, testCase.name);
    }
  });
});
