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
  readonly calls: Array<{
    kind: CodexTaskKind;
    payload: unknown;
    requestId: string;
    session: CodexTaskExecution["session"];
    requestOptions: { timeoutMs?: number } | undefined;
  }> = [];

  constructor(
    private readonly responses: unknown[],
    private readonly providerId = "openai",
    private readonly modelId = "gpt-5.6-sol",
  ) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
    requestId: string,
    session?: CodexTaskExecution["session"],
    requestOptions?: { timeoutMs?: number },
  ): Promise<CodexTaskExecution> {
    this.calls.push({ kind, payload, requestId, session: structuredClone(session), requestOptions });
    const output = this.responses.shift();
    if (output === undefined) throw new Error("missing sequenced response");
    return {
      output,
      trace: {
        taskKind: kind,
        promptVersion: `test/${kind}`,
        prompt: `prompt:${kind}`,
        providerId: this.providerId,
        modelId: this.modelId,
        reasoningEffort: this.providerId === "openai" ? "xhigh" : "high",
      },
    };
  }
}

class SessionAwareCodexClient extends CodexBridgeClient {
  readonly calls: Array<{
    kind: CodexTaskKind;
    payload: unknown;
    session: CodexTaskExecution["session"];
  }> = [];
  private readonly callCounts: Partial<Record<CodexTaskKind, number>> = {};

  constructor(private readonly responses: Partial<Record<CodexTaskKind, unknown[]>>) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
    _requestId: string,
    session?: CodexTaskExecution["session"],
  ): Promise<CodexTaskExecution> {
    this.calls.push({ kind, payload, session: structuredClone(session) });
    const callIndex = this.callCounts[kind] ?? 0;
    this.callCounts[kind] = callIndex + 1;
    const output = this.responses[kind]?.[callIndex];
    if (output === undefined) throw new Error(`missing ${kind} response ${callIndex + 1}`);
    return {
      output,
      ...(session ? {
        session: {
          key: session.key,
          handle: session.handle ?? `vfs_${(kind === "role-audit" ? "a" : "p").repeat(32)}`,
        },
      } : {}),
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
  it("rejects a stale selected model before calling a single configured agent", async () => {
    const client = new CapturingCodexClient(() => validDraft());
    const agent = new CodexScreenwriterAgent({ client, modelId: "gpt-current" });

    await assert.rejects(
      () => agent.draft({ ...screenwriterInput(), selectedModelId: "gpt-offline" }),
      /is not available for screenwriting/,
    );
    assert.equal(client.calls.length, 0);
  });

  it("routes stateless ZAI production and independent OpenAI audit to separate clients", async () => {
    const input = screenwriterInput();
    const visualProof = "两条真实标题的措辞差异可以直接并列核对。";
    const visualPlan = {
      strategy: "用来源标题并列和确定性标尺逐项核对。",
      beats: [{
        id: "headline-certainty-scale",
        role: "证据钩子",
        duration: "0-6 秒",
        description: "左右并列真实标题，高亮“网传”和“正在核查”。",
        searchQuery: "原始来源 标题 截图",
        source: "local-card" as const,
      }],
    };
    input.brief.visualProof = visualProof;
    input.brief.visualPlan = visualPlan;
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
    const producerClient = new SequencedCodexClient(
      [first, repaired],
      "zai-bigmodel-api",
      "glm-5.3",
    );
    const auditClient = new SequencedCodexClient(
      [repairAudit, passAudit],
      "openai",
      "gpt-5.6-sol",
    );
    const agent = new CodexScreenwriterAgent({
      client: producerClient,
      auditClient,
      maxReviewIterations: 2,
      modelId: "glm-5.3",
      sessionMode: "stateless",
    });

    const execution = await agent.draftDetailed({ ...input, selectedModelId: "glm-5.3" });

    assert.equal(execution.output.scenes[0]?.narration, "别眨眼，先看结果。");
    assert.deepEqual(producerClient.calls.map((call) => call.kind), ["script-draft", "script-draft"]);
    assert.deepEqual(auditClient.calls.map((call) => call.kind), ["role-audit", "role-audit"]);
    assert.deepEqual(producerClient.calls.map((call) => call.session), [undefined, undefined]);
    const repairPayload = producerClient.calls[1]!.payload as Record<string, unknown>;
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
    assert.deepEqual(
      execution.agentLoop?.iterations.map((iteration) => [
        iteration.candidateTrace?.providerId,
        iteration.candidateTrace?.modelId,
        iteration.auditTrace?.providerId,
        iteration.auditTrace?.modelId,
      ]),
      [
        ["zai-bigmodel-api", "glm-5.3", "openai", "gpt-5.6-sol"],
        ["zai-bigmodel-api", "glm-5.3", "openai", "gpt-5.6-sol"],
      ],
    );

    const firstAuditPayload = auditClient.calls[0]!.payload as Record<string, unknown>;
    const firstProducerPayload = producerClient.calls[0]!.payload as { brief: ScreenwriterAgentInput["brief"] };
    assert.equal(firstProducerPayload.brief.visualProof, visualProof);
    assert.deepEqual(firstProducerPayload.brief.visualPlan, visualPlan);
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
      visualProof,
      visualPlan,
      productionCapabilities: {
        assetProviders: [],
        editing: { sourceRangeReuse: true, staticEditorialCard: false },
      },
    });
    assert.deepEqual((auditClient.calls[1]!.payload as Record<string, unknown>).previousAudit, repairAudit);
  });

  it("keeps revisions stateful while each full independent audit starts without inherited history", async () => {
    const first = validDraft();
    const repaired = validDraft();
    repaired.scenes[0]!.narration = "先看结果，再解释原因。";
    const client = new SessionAwareCodexClient({
      "script-draft": [first, repaired],
      "role-audit": [{
        version: "video-factory/role-audit-v1",
        verdict: "repair",
        score: 72,
        summary: "钩子需要修改。",
        issues: [{
          severity: "blocking",
          criterion: "前两秒建立具体钩子",
          evidence: "第一句没有先给结果。",
          repairInstruction: "先展示结果。",
        }],
        repairInstructions: ["先展示结果。"],
      }, {
        version: "video-factory/role-audit-v1",
        verdict: "pass",
        score: 92,
        summary: "可以进入下游。",
        issues: [],
        repairInstructions: [],
      }],
    });
    const agent = new CodexScreenwriterAgent({ client, maxReviewIterations: 2 });

    await agent.draftDetailed(screenwriterInput());

    const producerCalls = client.calls.filter(({ kind }) => kind === "script-draft");
    const auditCalls = client.calls.filter(({ kind }) => kind === "role-audit");
    assert.equal(producerCalls[0]?.session?.handle, undefined);
    assert.match(producerCalls[1]?.session?.handle ?? "", /^vfs_p/);
    assert.equal(
      ((producerCalls[1]?.payload as Record<string, unknown>).revision as { mode?: string }).mode,
      "repair-delta",
    );
    assert.deepEqual(auditCalls.map(({ session }) => session), [undefined, undefined]);
    assert.ok((auditCalls[1]?.payload as Record<string, unknown>).previousAudit);
  });

  it("keeps the previous script in the producer input without duplicating it into the independent audit", async () => {
    const input = screenwriterInput();
    const previousScript = { viewerPromise: "上一版承诺", scenes: [validScene(1), validScene(2), validScene(3)] };
    input.brief.rework = {
      sourceRunId: "run-rejected-script",
      instruction: "只修正第一句旁白。",
      findings: [],
      previousScript,
    };
    const producerClient = new SequencedCodexClient([validDraft()]);
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 92,
      summary: "返工脚本可执行。",
      issues: [],
      repairInstructions: [],
    }]);
    const agent = new CodexScreenwriterAgent({ client: producerClient, auditClient, maxReviewIterations: 1 });

    await agent.draftDetailed(input);

    assert.deepEqual(
      (producerClient.calls[0]!.payload as { brief: { rework: { previousScript: unknown } } }).brief.rework.previousScript,
      previousScript,
    );
    const auditContext = (auditClient.calls[0]!.payload as {
      context: { upstreamFacts: { rework: Record<string, unknown> }; rework?: unknown; verificationBoundary?: string };
    }).context;
    assert.equal("previousScript" in auditContext.upstreamFacts.rework, false);
    assert.equal("rework" in auditContext, false);
    assert.match(auditContext.verificationBoundary ?? "", /不得宣称已复验/);
  });

  it("keeps unaffected scenes and top-level intent byte-for-byte through every scoped repair round", async () => {
    const input = screenwriterInput();
    const previousScript = {
      viewerPromise: "上一版观众承诺",
      narrativeArc: "上一版叙事弧",
      canonFacts: [],
      scenes: [validScene(1), validScene(2), validScene(3)],
    };
    input.brief.rework = {
      sourceRunId: "run-scoped-script-rework",
      instruction: "只重做镜头 2，其他镜头直接复用。",
      findings: [],
      previousScript,
    };
    Object.assign(input.brief.rework, { affectedScenePositions: [2] });
    const candidate = {
      viewerPromise: "模型擅自改写的观众承诺",
      narrativeArc: "模型擅自改写的叙事弧",
      canonFacts: [],
      scenes: [
        validScene(1, { narration: "模型擅自改写第一镜。" }),
        validScene(2, { narration: "按要求修正第二镜。" }),
        validScene(3, { narration: "模型擅自改写第三镜。" }),
      ],
    };
    const repairedCandidate = {
      viewerPromise: "第二轮再次擅自改写观众承诺",
      narrativeArc: "第二轮再次擅自改写叙事弧",
      canonFacts: ["第二轮新增的越界事实"],
      scenes: [
        validScene(1, { narration: "第二轮擅自改写第一镜。" }),
        validScene(2, { narration: "第二轮按审计建议修正第二镜。" }),
        validScene(3, { narration: "第二轮擅自改写第三镜。" }),
      ],
    };
    const repairAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "repair",
      score: 72,
      summary: "第二镜仍需给出更具体的动作。",
      issues: [{ severity: "blocking", criterion: "镜头动作", evidence: "第二镜动作不具体", repairInstruction: "只修正第二镜" }],
      repairInstructions: ["只修正第二镜"],
    };
    const producerClient = new SequencedCodexClient([candidate, repairedCandidate]);
    const auditClient = new SequencedCodexClient([repairAudit, {
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 92,
      summary: "局部返工保持了未受影响镜头。",
      issues: [],
      repairInstructions: [],
    }]);
    const agent = new CodexScreenwriterAgent({ client: producerClient, auditClient, maxReviewIterations: 2 });

    const execution = await agent.draftDetailed(input);

    assert.equal(execution.output.viewerPromise, previousScript.viewerPromise);
    assert.equal(execution.output.narrativeArc, previousScript.narrativeArc);
    assert.deepEqual(execution.output.canonFacts, previousScript.canonFacts);
    assert.deepEqual(execution.output.scenes, [
      previousScript.scenes[0],
      repairedCandidate.scenes[1],
      previousScript.scenes[2],
    ]);
    const firstAuditedCandidate = (auditClient.calls[0]!.payload as {
      candidate: { viewerPromise?: string; scenes: unknown[] };
    }).candidate;
    const secondAuditedCandidate = (auditClient.calls[1]!.payload as { candidate: unknown }).candidate;
    assert.equal(firstAuditedCandidate.viewerPromise, previousScript.viewerPromise);
    assert.deepEqual(firstAuditedCandidate.scenes, [previousScript.scenes[0], candidate.scenes[1], previousScript.scenes[2]]);
    assert.deepEqual(secondAuditedCandidate, execution.output);
  });

  it("rejects a changed candidate when an empty scope bypasses pre-call script reuse", async () => {
    const input = screenwriterInput();
    const previousScript = {
      viewerPromise: "上一版观众承诺",
      narrativeArc: "上一版叙事弧",
      canonFacts: [],
      scenes: [validScene(1), validScene(2), validScene(3)],
    };
    input.brief.rework = {
      sourceRunId: "run-empty-scope",
      instruction: "没有脚本变化。",
      findings: [],
      affectedScenePositions: [],
      previousScript,
    };
    const changed = {
      ...previousScript,
      scenes: [validScene(1, { narration: "模型不应改写第一镜。" }), validScene(2), validScene(3)],
    };
    const client = new SequencedCodexClient([changed]);
    const agent = new CodexScreenwriterAgent({ client });

    await assert.rejects(
      () => agent.draft(input),
      /empty affectedScenePositions must reuse the verified previous script before model execution/i,
    );
  });

  it("uses the shared wall-clock deadline as an admission gate without shortening accepted operations", async () => {
    const client = new SequencedCodexClient([validDraft(), {
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 90,
      summary: "通过。",
      issues: [],
      repairInstructions: [],
    }]);
    const deadline = Date.now() + 1_000;
    const agent = new CodexScreenwriterAgent({ client });

    await agent.draftDetailed({ ...screenwriterInput(), wallClockDeadlineAtMs: deadline });

    assert.equal(client.calls.length, 2);
    for (const call of client.calls) {
      assert.equal(call.requestOptions?.timeoutMs, undefined);
      assert.equal(typeof (call.requestOptions as { beforeSubmit?: unknown } | undefined)?.beforeSubmit, "function");
      assert.equal("wallClockDeadlineAtMs" in (call.payload as Record<string, unknown>), false);
    }
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
    assert.deepEqual(payload, {
      brief: {
        ...input.brief,
        productionCapabilities: {
          assetProviders: [],
          editing: { sourceRangeReuse: true, staticEditorialCard: false },
        },
      },
    });
    assert.equal("directive" in payload, false);
  });

  it("uses the explicit duration range in production, validation, and audit context", async () => {
    const rangedDraft = {
      scenes: Array.from({ length: 10 }, (_, index) => validScene(index + 1, { duration: 6 })),
    };
    const input = screenwriterInput();
    input.brief.durationSeconds = 30;
    input.brief.durationRange = { minSeconds: 20, maxSeconds: 90 };
    const producerClient = new SequencedCodexClient([rangedDraft]);
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 92,
      summary: "时长和内容均可执行。",
      issues: [],
      repairInstructions: [],
    }]);
    const agent = new CodexScreenwriterAgent({ client: producerClient, auditClient, maxReviewIterations: 1 });

    const execution = await agent.draftDetailed(input);

    assert.equal(execution.output.scenes.reduce((sum, scene) => sum + scene.duration, 0), 60);
    assert.deepEqual(
      (producerClient.calls[0]!.payload as { brief: ScreenwriterAgentInput["brief"] }).brief.durationRange,
      { minSeconds: 20, maxSeconds: 90 },
    );
    const auditContract = (auditClient.calls[0]!.payload as {
      context: { currentRoleContract: Record<string, unknown> };
    }).context.currentRoleContract;
    assert.deepEqual(auditContract.durationRange, { minSeconds: 20, maxSeconds: 90 });
    assert.deepEqual(auditContract.acceptedSceneDurationTotal, { minSeconds: 20, maxSeconds: 90 });
    assert.throws(
      () => validateScriptDraft(rangedDraft, {
        durationSeconds: 24,
        durationRange: { minSeconds: 24, maxSeconds: 24 },
      }),
      /outside the 24-24s duration range/,
    );
    const overRangeDraft = {
      scenes: Array.from({ length: 13 }, (_, index) => validScene(index + 1, { duration: 7 })),
    };
    assert.throws(
      () => validateScriptDraft(overRangeDraft, {
        durationSeconds: 30,
        durationRange: { minSeconds: 20, maxSeconds: 90 },
      }),
      /outside the 20-90s duration range/,
    );
    assert.throws(
      () => validateScriptDraft(rangedDraft, { durationSeconds: 30 }),
      /outside 0\.6-1\.4x of the 30s target/,
    );
  });

  it("gives the auditor host-computed exact duration and canon boundary facts", async () => {
    const durations = [2.5, 3.5, 4, 3.5, 3.5, 5, 2.5, 3.5, 2.5, 3.5];
    const draft = {
      canonFacts: [],
      scenes: durations.map((duration, index) => validScene(index + 1, { duration })),
    };
    const input = screenwriterInput();
    input.brief.durationSeconds = 30;
    input.brief.durationRange = { minSeconds: 20, maxSeconds: 34 };
    const producerClient = new SequencedCodexClient([draft]);
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 92,
      summary: "宿主时长事实合规。",
      issues: [],
      repairInstructions: [],
    }]);
    const agent = new CodexScreenwriterAgent({ client: producerClient, auditClient, maxReviewIterations: 1 });

    await agent.draftDetailed(input);

    const facts = (auditClient.calls[0]!.payload as {
      context: { currentRoleContract: { candidateFacts: Record<string, unknown> } };
    }).context.currentRoleContract.candidateFacts;
    assert.equal(facts.sceneCount, 10);
    assert.equal(facts.totalDurationSeconds, 34);
    assert.deepEqual(facts.durationRange, { minSeconds: 20, maxSeconds: 34 });
    assert.equal(facts.durationWithinRange, true);
    assert.deepEqual((facts.canonFacts as Record<string, unknown>).allowedCount, { min: 0, max: 8 });
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

  it("requires an explicit 0-8 canon facts array for a series script", () => {
    for (const count of [0, 1, 8]) {
      const accepted = {
        ...validDraft(),
        canonFacts: Array.from({ length: count }, (_, index) => `本集已建立事实 ${index + 1}`),
      };
      assert.deepEqual(validateScriptDraft(accepted, { durationSeconds: 24 }), accepted);
      assert.deepEqual(validateScriptDraft(accepted, { durationSeconds: 24, requireCanonFacts: true }), accepted);
    }
    assert.throws(
      () => validateScriptDraft(validDraft(), { durationSeconds: 24, requireCanonFacts: true }),
      /must contain a canonFacts array/,
    );
    assert.throws(
      () => validateScriptDraft({ ...validDraft(), canonFacts: null }, { durationSeconds: 24, requireCanonFacts: true }),
      /canonFacts must be an array/,
    );
    assert.throws(
      () => validateScriptDraft({ ...validDraft(), canonFacts: Array.from({ length: 9 }, (_, index) => `事实 ${index + 1}`) }, {
        durationSeconds: 24,
        requireCanonFacts: true,
      }),
      /0 to 8 strings/,
    );
    assert.throws(
      () => validateScriptDraft({ ...validDraft(), canonFacts: [""] }, { durationSeconds: 24, requireCanonFacts: true }),
      /canonFacts\[0\]/,
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

  it("keeps generated scenes inside an explicit illustration boundary", () => {
    const unsafe = {
      scenes: [
        validScene(1, {
          visual_strategy: "generated",
          narration: "这个画面已经证明了方法有效。",
          visual_prompt: "生成式人物完成实验",
        }),
        validScene(2),
        validScene(3),
      ],
    };
    assert.throws(
      () => validateScriptDraft(unsafe, { durationSeconds: 24 }),
      /generated visual as real-world evidence/,
    );

    const bounded = {
      scenes: [
        validScene(1, {
          visual_strategy: "generated",
          narration: "下面只用机制示意解释步骤，并不构成真实验证。",
          visual_prompt: "无文字的机制示意",
        }),
        validScene(2),
        validScene(3),
      ],
    };
    assert.deepEqual(validateScriptDraft(bounded, { durationSeconds: 24 }), bounded);
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
