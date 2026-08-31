import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexScreenwriterAgent,
  type CodexTaskExecution,
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

class SequencedCodexClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];

  constructor(private readonly responses: unknown[]) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
    this.calls.push({ kind, payload });
    const output = this.responses.shift();
    if (output === undefined) throw new Error("missing sequenced response");
    return {
      output,
      trace: {
        taskKind: kind,
        promptVersion: `test/${kind}`,
        prompt: `prompt:${kind}`,
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    };
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
  it("runs an independent critic and repairs the draft before exposing it downstream", async () => {
    const first = validDraft();
    const repaired = validDraft();
    repaired.scenes[0]!.narration = "别眨眼，先看结果。";
    const repairAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "repair",
      score: 68,
      summary: "开头不够具体。",
      issues: [{ severity: "blocking", criterion: "前两秒钩子", evidence: "首句只有说明", repairInstruction: "先展示具体结果" }],
      repairInstructions: ["重写第一镜旁白并保持事实边界"],
    };
    const passAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 91,
      summary: "合同可执行。",
      issues: [],
      repairInstructions: [],
    };
    const client = new SequencedCodexClient([first, repairAudit, repaired, passAudit]);
    const agent = new CodexScreenwriterAgent({ client, maxReviewIterations: 2 });

    const execution = await agent.draftDetailed(screenwriterInput());

    assert.equal(execution.output.scenes[0]?.narration, "别眨眼，先看结果。");
    assert.deepEqual(client.calls.map((call) => call.kind), ["script-draft", "role-audit", "script-draft", "role-audit"]);
    const repairPayload = client.calls[2]!.payload as Record<string, unknown>;
    const revision = repairPayload.revision as Record<string, unknown>;
    assert.equal(revision.mode, "repair-bootstrap");
    assert.deepEqual(revision.candidate, first);
    assert.match(String(revision.candidateHash), /^[a-f0-9]{64}$/);
    assert.deepEqual(revision.audit, {
      summary: repairAudit.summary,
      issues: repairAudit.issues,
      repairInstructions: repairAudit.repairInstructions,
    });
    assert.equal(execution.agentLoop?.status, "passed");
    assert.equal(execution.agentLoop?.iterations.length, 2);
    assert.equal(execution.agentLoop?.iterations[0]?.audit.verdict, "repair");
    assert.equal(execution.agentLoop?.iterations[1]?.audit.verdict, "pass");

    const firstAuditPayload = client.calls[1]!.payload as Record<string, unknown>;
    const auditContext = firstAuditPayload.context as Record<string, unknown>;
    assert.equal("brief" in auditContext, false);
    assert.deepEqual(auditContext.roleScope, {
      owns: ["viewerPromise", "narrativeArc", "canonFacts", "scenes"],
      doesNotOwn: ["素材实际命中", "画面生成结果", "配音成品", "渲染与终审结果"],
    });
    assert.deepEqual(auditContext.upstreamFacts, {
      title: "下班后别急着做这 3 件事",
      angle: "用三条具体动作减少下班后的决策消耗",
      audience: "普通上班族",
      nicheSlug: "life-avoidance",
    });
    assert.deepEqual((client.calls[3]!.payload as Record<string, unknown>).previousAudit, repairAudit);
  });

  it("allows three audit and repair rounds by default", async () => {
    const repairAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "repair",
      score: 70,
      summary: "仍需修订。",
      issues: [{ severity: "blocking", criterion: "镜头动作", evidence: "动作不够具体", repairInstruction: "补充可见动作" }],
      repairInstructions: ["补充可见动作"],
    };
    const passAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 92,
      summary: "第三轮达到交付标准。",
      issues: [],
      repairInstructions: [],
    };
    const first = validDraft();
    const second = validDraft();
    second.scenes[0]!.narration = "先展示第一个具体动作。";
    const third = validDraft();
    third.scenes[0]!.narration = "先展示结果，再完成第一个具体动作。";
    const client = new SequencedCodexClient([
      first, repairAudit,
      second, repairAudit,
      third, passAudit,
    ]);
    const agent = new CodexScreenwriterAgent({ client });

    const execution = await agent.draftDetailed(screenwriterInput());

    assert.equal(execution.agentLoop?.iterations.length, 3);
    assert.equal(execution.agentLoop?.iterations[2]?.audit.verdict, "pass");
    assert.equal(client.calls.length, 6);
  });

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

  it("requires explicit canon facts for a series script", () => {
    const standaloneDraft = { ...validDraft(), canonFacts: [] };
    assert.deepEqual(
      validateScriptDraft(standaloneDraft, { durationSeconds: 24 }),
      standaloneDraft,
    );
    assert.throws(
      () => validateScriptDraft(standaloneDraft, { durationSeconds: 24, requireCanonFacts: true }),
      /between 1 and 8 canonFacts/,
    );
    const draft = { ...validDraft(), canonFacts: ["本集已经验证：先记录问题再选择工具。"] };
    assert.deepEqual(
      validateScriptDraft(draft, { durationSeconds: 24, requireCanonFacts: true }),
      draft,
    );
  });

  it("preserves the v2 viewer promise and inspectable shot intent", () => {
    const draft = {
      viewerPromise: "看完能用一杯水判断窗边光线方向。",
      narrativeArc: "误区、动作验证、结论。",
      scenes: [1, 2, 3].map((position) => validScene(position, {
        purpose: position === 1 ? "结果钩子" : "动作验证",
        visible_action: "手拉开窗帘，杯沿高光从暗变亮。",
        on_screen_text: "看高光移动",
        sound_cue: "窗帘摩擦声",
        success_criteria: ["手完成拉帘", "杯沿亮度明显变化"],
        failure_conditions: ["只有静态杯子", "窗帘没有变化"],
      })),
    };

    assert.deepEqual(validateScriptDraft(draft, { durationSeconds: 24 }), draft);
  });

  it("rejects non-contract drafts without any fallback", async () => {
    const cases: Array<{ name: string; output: () => unknown; pattern: RegExp }> = [
      { name: "missing scenes", output: () => ({}), pattern: /scenes must be an array/ },
      {
        name: "too few scenes",
        output: () => ({ scenes: [validScene(1), validScene(2)] }),
        pattern: /between 3 and 24 scenes; got 2/,
      },
      {
        name: "too many scenes",
        output: () => ({ scenes: Array.from({ length: 25 }, (_, index) => validScene(index + 1)) }),
        pattern: /between 3 and 24 scenes; got 25/,
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
        pattern: /visual_strategy must be one of stock, image, generated, local/,
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
