import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexBridgeClient, type CodexTaskExecution, type CodexTaskKind } from "../src/codex-chat.js";
import { CodexVisualDirectorAgent } from "../src/codex-visual-director.js";
import type { VisualDirectorAgentInput } from "../src/visual-director.js";

class CapturingCodexClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];

  constructor(public respond: () => unknown) {
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
  }> = [];

  constructor(
    private readonly responses: unknown[],
    private readonly providerId: string,
    private readonly modelId: string,
  ) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTaskDetailed(
    kind: CodexTaskKind,
    payload: unknown,
    requestId: string,
    session?: CodexTaskExecution["session"],
  ): Promise<CodexTaskExecution> {
    this.calls.push({ kind, payload, requestId, session: structuredClone(session) });
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

function directorInput(): VisualDirectorAgentInput {
  return {
    brief: {
      title: "下班后的城市为什么让人舍不得回家",
      angle: "都市夜晚的情绪空间",
      audience: "城市上班族",
      platform: "douyin",
      durationSeconds: 24,
      requestedProfileId: "urban-poetic",
    },
    scenes: [{
      position: 1,
      narration: "夜晚开始了",
      duration: 5,
      visualPrompt: "雨夜城市",
      visualStrategy: "local",
      visibleAction: "标题逐行出现",
      onScreenText: "下班后的城市",
      soundCue: "雨声渐入",
      successCriteria: ["标题可读"],
      failureConditions: ["出现虚构人物"],
      searchTerms: [],
    }],
    assetProviders: [{
      id: "local-editorial-v1",
      label: "本地",
      billing: "free",
      modes: ["本地"],
      deliveryTypes: ["editorial_card"],
      strengths: ["标题卡、数据卡与清单步骤"],
      constraints: ["不包含真实人物动作或现场环境"],
      estimatedCnyPerClip: 0,
    }],
    economics: { allowMeteredProviders: false },
  };
}

function validPlan(): Record<string, unknown> {
  return {
    version: "video-factory/director-plan-v1",
    requestedProfileId: "urban-poetic",
    resolvedProfileId: "urban-poetic",
    profileRationale: "都市夜景与人物情绪适配。",
    visualBible: {
      viewerPromise: "看见夜晚如何改变人的行动节奏。",
      narrativeApproach: "碎片化观察",
      motif: "反光路面与暖色窗光",
      pacing: "短促后停顿",
      composition: "偏置近景",
      camera: "缓慢横移",
      color: "霓虹综合色",
      continuity: "同一雨夜",
      transitionGrammar: "用动作方向和光源匹配切换",
      sound: "环境声与低频音乐",
      antiPatterns: ["静态卡片超过三秒", "无人物动机的霓虹空镜"],
    },
    shots: [{
      scenePosition: 1,
      narrativeRole: "情绪钩子",
      authenticityPolicy: "expressive",
      preferredProviderId: "local-editorial-v1",
      deliveryType: "editorial_card",
      alternativeProviderIds: [],
      subject: "下班后停在便利店门口的上班族",
      environment: "雨夜街角与便利店暖光",
      visibleAction: "人物收起雨伞并抬头看向店内",
      temporalBeats: ["[0s-2s] 雨伞占据前景，人物进入", "[2s-5s] 收伞并抬头，暖光落在脸侧"],
      shotSize: "中近景",
      camera: "轻微手持跟进后稳定",
      lighting: "冷色雨夜环境光与暖色店内光对照",
      negativeConstraints: ["不出现文字水印", "不改变人物服装"],
      referenceRequirements: [],
      successCriteria: ["能看见完整收伞动作", "冷暖光关系清晰"],
      query: "雨夜 城市 人物",
      generationPrompt: "雨夜城市人物近景",
      rationale: "适合情绪表达。",
      continuityNote: "保持雨夜。",
      confidence: 0.8,
      estimatedCostCny: 0,
    }],
  };
}

describe("CodexVisualDirectorAgent", () => {
  it("rejects a stale selected model before calling a single configured agent", async () => {
    const client = new CapturingCodexClient(() => validPlan());
    const agent = new CodexVisualDirectorAgent({ client, modelId: "gpt-current" });

    await assert.rejects(
      () => agent.plan({ ...directorInput(), selectedModelId: "gpt-offline" }),
      /is not available for visual direction/,
    );
    assert.equal(client.calls.length, 0);
  });

  it("routes stateless ZAI production and independent OpenAI audit to separate clients", async () => {
    const input = directorInput();
    input.assetProviders[0]!.constraints.push("成片必须保留 AIGC 标识");
    const firstPlan = validPlan();
    const repairedPlan = validPlan();
    repairedPlan.profileRationale = "都市夜景、人物动作与冷暖光对照共同兑现观众承诺。";
    const repairAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "repair",
      score: 78,
      summary: "导演风格理由没有连接具体动作与光线。",
      issues: [{
        severity: "blocking",
        criterion: "视觉圣经与观众承诺一致",
        evidence: "理由只写题材适配，没有说明动作和光线如何兑现承诺。",
        repairInstruction: "把人物动作、冷暖光和观众承诺写进风格理由。",
      }],
      repairInstructions: ["补全动作、光线与观众承诺之间的关系。"],
    };
    const passAudit = {
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 94,
      summary: "逐镜方案可执行。",
      issues: [],
      repairInstructions: [],
    };
    const producerClient = new SequencedCodexClient(
      [firstPlan, repairedPlan],
      "zai-bigmodel-api",
      "glm-5.3",
    );
    const auditClient = new SequencedCodexClient(
      [repairAudit, passAudit],
      "openai",
      "gpt-5.6-sol",
    );
    const agent = new CodexVisualDirectorAgent({
      client: producerClient,
      auditClient,
      maxReviewIterations: 2,
      modelId: "glm-5.3",
      sessionMode: "stateless",
    });

    const execution = await agent.planDetailed({ ...input, selectedModelId: "glm-5.3" });

    assert.equal(execution.agentLoop?.status, "passed");
    assert.deepEqual(producerClient.calls.map(({ kind }) => kind), ["director-plan", "director-plan"]);
    assert.deepEqual(auditClient.calls.map(({ kind }) => kind), ["role-audit", "role-audit"]);
    assert.deepEqual(producerClient.calls.map(({ session }) => session), [undefined, undefined]);
    assert.equal(
      ((producerClient.calls[1]!.payload as Record<string, unknown>).revision as { mode?: string }).mode,
      "repair-bootstrap",
    );
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
    const auditPayload = auditClient.calls[0]!.payload as {
      context: {
        upstreamFacts: { scenes: Array<Record<string, unknown>> };
        currentRoleContract: Record<string, unknown>;
        downstreamBoundary: string;
      };
    };
    const contract = auditPayload.context.currentRoleContract;
    assert.equal("directorProfiles" in contract, false);
    assert.deepEqual(contract.availableDirectorProfileIds, [
      "documentary-observer",
      "quiet-humanism",
      "urban-poetic",
      "chromatic-storytelling",
      "geometric-control",
      "suspense-staging",
    ]);
    assert.equal((contract.selectedDirectorProfile as { id: string }).id, "urban-poetic");
    assert.deepEqual(contract.assetReuse, {
      querySyntax: "REUSE_ONLY scene N",
      execution: "下游素材执行器直接复用已解析的更早镜头母片，不会重新搜索、生成或计费。",
      constraints: [
        "N 只能引用更早且可成功解析的导演镜头。",
        "多级复用始终解析到同一个根母片，不能形成循环。",
        "复用从母片开头使用相同媒体内容，不会产生新的动作、光线变化、后续片段或画面状态。",
        "生成视频母片的真实长度按所选模型的最短/最长时长和整数秒规则归一化；复用镜头不得更长。",
      ],
    });
    assert.deepEqual(
      (contract.assetProviders as Array<{ constraints: string[] }>)[0]?.constraints,
      ["不包含真实人物动作或现场环境"],
    );
    assert.match(String(auditPayload.context.downstreamBoundary), /AIGC.*渲染与发布/);
    assert.deepEqual(Object.keys(auditPayload.context.upstreamFacts.scenes[0]!).sort(), [
      "duration",
      "failureConditions",
      "narration",
      "onScreenText",
      "position",
      "soundCue",
      "successCriteria",
      "visibleAction",
      "visualPrompt",
      "visualStrategy",
    ]);
  });

  it("authorizes both rework instructions without expanding finding ownership or verification claims", async () => {
    const input = directorInput();
    input.assetProviders = [{
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "metered",
      modes: ["AI 图片"],
      deliveryTypes: ["generated_image"],
      strengths: ["解释性画面"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 6,
    }];
    input.economics = { allowMeteredProviders: true };
    input.brief.rework = {
      sourceRunId: "run-rejected-1",
      visualDirectionInstruction: "保持雨夜母题，但把人物动作改成可连续观察的近景。",
      assetInstruction: "第一镜改用无字生成图片，不得继续使用说明卡。",
      findings: [{
        findingId: "vf_bbbbbbbbbbbbbbbbbbbbbbbb",
        timecodeMs: 1_000,
        scenePosition: 1,
        category: "continuity",
        description: "人物动作与视觉母题脱节。",
        suggestion: "调整构图并替换素材。",
        targetNodeIds: ["visual-direction", "assets"],
      }],
      affectedScenePositions: [1],
      previousDirectorPlan: validPlan(),
    };
    const revisedPlan = validPlan();
    const revisedShot = (revisedPlan.shots as Array<Record<string, unknown>>)[0]!;
    revisedShot.preferredProviderId = "seedream-image-v1";
    revisedShot.deliveryType = "generated_image";
    revisedShot.query = "rainy city portrait";
    revisedShot.generationPrompt = "无文字的雨夜人物近景，人物收伞后停在暖光边缘";
    revisedShot.estimatedCostCny = 6;
    const producerClient = new SequencedCodexClient([revisedPlan], "zai-bigmodel-api", "glm-5.3");
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 95,
      summary: "两类返工要求均已进入可执行方案。",
      issues: [],
      repairInstructions: [],
    }], "openai", "gpt-5.6-sol");
    const agent = new CodexVisualDirectorAgent({
      client: producerClient,
      auditClient,
      maxReviewIterations: 1,
      modelId: "glm-5.3",
      sessionMode: "stateless",
    });

    const execution = await agent.planDetailed({ ...input, selectedModelId: "glm-5.3" });

    assert.equal(execution.agentLoop?.status, "passed");
    assert.deepEqual(
      ((producerClient.calls[0]!.payload as { brief: { rework: unknown } }).brief.rework),
      input.brief.rework,
    );
    const auditPayload = auditClient.calls[0]!.payload as {
      criteria: string[];
      context: {
        currentRoleContract: {
          reworkAuthorization: {
            requiredInstructions: { visualDirection: string; assets: string };
            permittedPlanChanges: string[];
            findingOwnership: string;
            affectedScenePositions: number[];
            preservationRule: string;
            verificationBoundary: string;
          };
        };
      };
    };
    assert.ok(auditPayload.criteria.some((criterion) => (
      criterion.includes("visualDirectionInstruction 与 assetInstruction")
      && criterion.includes("不得把 assetInstruction 驱动的改动判为越权")
    )));
    assert.ok(auditPayload.criteria.some((criterion) => (
      criterion.includes("findings 只追踪分配给 visual-direction 的 findingId")
      && criterion.includes("不得宣称问题已经复验通过")
    )));
    assert.deepEqual(auditPayload.context.currentRoleContract.reworkAuthorization.requiredInstructions, {
      visualDirection: input.brief.rework.visualDirectionInstruction,
      assets: input.brief.rework.assetInstruction,
    });
    assert.deepEqual(auditPayload.context.currentRoleContract.reworkAuthorization.permittedPlanChanges, [
      "visualBible",
      "逐镜 Provider 与交付类型",
      "复用/参考图路由与 query",
      "generationPrompt 与镜头验收条件",
    ]);
    assert.deepEqual(auditPayload.context.currentRoleContract.reworkAuthorization.affectedScenePositions, [1]);
    assert.match(auditPayload.context.currentRoleContract.reworkAuthorization.findingOwnership, /assetInstruction 无需额外 findingId/);
    assert.match(auditPayload.context.currentRoleContract.reworkAuthorization.preservationRule, /不得.*撤销 assetInstruction/);
    assert.match(auditPayload.context.currentRoleContract.reworkAuthorization.verificationBoundary, /不得宣称后续视觉审片已经验证通过/);
  });

  it("keeps unaffected shots byte-for-byte from the previous director plan during scoped rework", async () => {
    const input = directorInput();
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      narration: "雨停之后",
      visualPrompt: "雨停后的街角",
    });
    const previousPlan = validPlan();
    const previousShot = (previousPlan.shots as Array<Record<string, unknown>>)[0]!;
    (previousPlan.shots as Array<Record<string, unknown>>).push({
      ...structuredClone(previousShot),
      scenePosition: 2,
      generationPrompt: "上一版第二镜",
      query: "雨后 街角",
    });
    input.brief.rework = {
      sourceRunId: "run-rejected-2",
      visualDirectionInstruction: "保留未受影响镜头，只重做镜头 2。",
      assetInstruction: "保留未受影响母片，只替换镜头 2。",
      findings: [{
        findingId: "vf_cccccccccccccccccccccccc",
        timecodeMs: 5_000,
        scenePosition: 2,
        category: "continuity",
        description: "第二镜动作错误。",
        suggestion: "只重做第二镜。",
        targetNodeIds: ["visual-direction", "assets"],
      }],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    const candidate = structuredClone(previousPlan);
    const candidateShots = candidate.shots as Array<Record<string, unknown>>;
    candidateShots[0]!.generationPrompt = "模型无意中改写了第一镜";
    candidateShots[1]!.generationPrompt = "修正后的第二镜";
    const producerClient = new SequencedCodexClient([candidate], "openai", "gpt-5.6-sol");
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v1",
      verdict: "pass",
      score: 96,
      summary: "返工范围正确。",
      issues: [],
      repairInstructions: [],
    }], "openai", "gpt-5.6-sol");
    const agent = new CodexVisualDirectorAgent({
      client: producerClient,
      auditClient,
      maxReviewIterations: 1,
      modelId: "gpt-5.6-sol",
    });

    const execution = await agent.planDetailed({ ...input, selectedModelId: "gpt-5.6-sol" });
    const outputShots = execution.output.shots;
    const auditedShots = (auditClient.calls[0]!.payload as { candidate: { shots: Array<Record<string, unknown>> } }).candidate.shots;

    assert.equal(outputShots[0]!.generationPrompt, "雨夜城市人物近景");
    assert.equal(outputShots[1]!.generationPrompt, "修正后的第二镜");
    assert.equal(auditedShots[0]!.generationPrompt, "雨夜城市人物近景");
  });

  it("validates only the merged plan so an obsolete affected shot cannot fail a scoped rework", async () => {
    const input = directorInput();
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      narration: "雨停之后",
      visualPrompt: "雨停后的街角",
    });
    input.scenes[1]!.duration = 4;
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    (previousPlan.shots as Array<Record<string, unknown>>).push({
      ...structuredClone(baseShot),
      scenePosition: 2,
      query: "雨后 街角",
      generationPrompt: "上一版第二镜",
      // 旧 shot 的节拍超出本轮 4 秒脚本，但它即将被 candidate 替换。
      temporalBeats: ["[0s-3s] 雨势减弱", "[3s-6s] 人物走入街角"],
    });
    const candidate = structuredClone(previousPlan);
    const candidateShots = candidate.shots as Array<Record<string, unknown>>;
    candidateShots[0]!.generationPrompt = "模型无意中改写了第一镜";
    candidateShots[1]!.generationPrompt = "修正后的第二镜";
    candidateShots[1]!.temporalBeats = ["[0s-2s] 雨势减弱", "[2s-4s] 人物走入街角"];
    input.brief.rework = {
      sourceRunId: "run-rejected-merge-first",
      visualDirectionInstruction: "只重做镜头 2。",
      assetInstruction: "只替换镜头 2 的素材。",
      findings: [],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    const plan = await agent.plan(input);

    assert.equal(plan.shots[0]!.generationPrompt, "雨夜城市人物近景");
    assert.equal(plan.shots[1]!.generationPrompt, "修正后的第二镜");
    assert.deepEqual(plan.shots[1]!.temporalBeats, ["[0s-2s] 雨势减弱", "[2s-4s] 人物走入街角"]);
  });

  it("adopts the previous shot when the candidate drifts invalidly on an unaffected scene", async () => {
    const input = directorInput();
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      narration: "雨停之后",
      visualPrompt: "雨停后的街角",
    });
    input.scenes[1]!.duration = 4;
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    (previousPlan.shots as Array<Record<string, unknown>>).push({
      ...structuredClone(baseShot),
      scenePosition: 2,
      query: "雨后 街角",
      generationPrompt: "上一版第二镜",
      temporalBeats: ["[0s-2s] 雨势减弱", "[2s-4s] 人物走入街角"],
    });
    const candidate = structuredClone(previousPlan);
    const candidateShots = candidate.shots as Array<Record<string, unknown>>;
    // candidate 的未受影响镜头漂移到无效节拍，但 previous 对应 shot 合法，合并后采用 previous。
    candidateShots[0]!.temporalBeats = ["[0s-3s] 雨伞占据前景", "[3s-7s] 收伞并抬头"];
    candidateShots[1]!.generationPrompt = "修正后的第二镜";
    input.brief.rework = {
      sourceRunId: "run-rejected-invalid-drift",
      visualDirectionInstruction: "只重做镜头 2。",
      assetInstruction: "只替换镜头 2 的素材。",
      findings: [],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    const plan = await agent.plan(input);

    assert.deepEqual(plan.shots[0]!.temporalBeats, ["[0s-2s] 雨伞占据前景，人物进入", "[2s-5s] 收伞并抬头，暖光落在脸侧"]);
    assert.equal(plan.shots[1]!.generationPrompt, "修正后的第二镜");
  });

  it("still rejects a scoped rework whose final affected candidate shot is invalid", async () => {
    const input = directorInput();
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      narration: "雨停之后",
      visualPrompt: "雨停后的街角",
    });
    input.scenes[1]!.duration = 4;
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    (previousPlan.shots as Array<Record<string, unknown>>).push({
      ...structuredClone(baseShot),
      scenePosition: 2,
      query: "雨后 街角",
      generationPrompt: "上一版第二镜",
      temporalBeats: ["[0s-2s] 雨势减弱", "[2s-4s] 人物走入街角"],
    });
    const candidate = structuredClone(previousPlan);
    const candidateShots = candidate.shots as Array<Record<string, unknown>>;
    // 受影响镜头的 candidate 本身无效，即使 previous 合法也必须拒绝，证明合并没有放宽最终校验。
    candidateShots[1]!.temporalBeats = ["[0s-3s] 雨势减弱", "[3s-6s] 人物走入街角"];
    input.brief.rework = {
      sourceRunId: "run-rejected-invalid-affected",
      visualDirectionInstruction: "只重做镜头 2。",
      assetInstruction: "只替换镜头 2 的素材。",
      findings: [],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    await assert.rejects(() => agent.plan(input), /exceed|overlap|duration|beat/i);
  });

  function scopedReworkWithSecondScene() {
    const input = directorInput();
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      narration: "雨停之后",
      visualPrompt: "雨停后的街角",
    });
    const previousPlan = validPlan();
    const previousShot = (previousPlan.shots as Array<Record<string, unknown>>)[0]!;
    (previousPlan.shots as Array<Record<string, unknown>>).push({
      ...structuredClone(previousShot),
      scenePosition: 2,
      query: "雨后 街角",
      generationPrompt: "上一版第二镜",
    });
    input.brief.rework = {
      sourceRunId: "run-rejected-scoped-merge",
      visualDirectionInstruction: "只重做镜头 2。",
      assetInstruction: "只替换镜头 2 的素材。",
      findings: [],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    return { input, previousPlan };
  }

  it("rejects a scoped rework whose affected candidate shot is missing even when the previous shot is valid", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const candidate = structuredClone(previousPlan);
    (candidate.shots as Array<Record<string, unknown>>).splice(1, 1);
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    await assert.rejects(() => agent.plan(input), /candidate is missing the affected shot for scene 2/);
  });

  it("rejects a scoped rework whose unaffected previous shot is missing even when the candidate has it", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const candidate = structuredClone(previousPlan);
    (candidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "修正后的第二镜";
    // previous 缺少未受影响的第一镜；不得用 candidate 的未授权漂移补洞。
    (previousPlan.shots as Array<Record<string, unknown>>).splice(0, 1);
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    await assert.rejects(() => agent.plan(input), /previous plan is missing the unaffected shot for scene 1/);
  });

  it("rejects a rework candidate that contains a duplicate scenePosition instead of silently picking one", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const candidate = structuredClone(previousPlan);
    const candidateShots = candidate.shots as Array<Record<string, unknown>>;
    candidateShots.push(structuredClone(candidateShots[1]!));
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    await assert.rejects(() => agent.plan(input), /more than one shot for scene 2/);
  });

  it("rejects a previous plan with a duplicate unaffected scenePosition instead of silently picking one", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const candidate = structuredClone(previousPlan);
    (candidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "修正后的第二镜";
    // previous 中未受影响的第一镜出现两次；歧义必须显式拒绝，不能静默取其一。
    (previousPlan.shots as Array<Record<string, unknown>>).push(
      structuredClone((previousPlan.shots as Array<Record<string, unknown>>)[0]!),
    );
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    await assert.rejects(() => agent.plan(input), /more than one shot for scene 1/);
  });

  it("auto-adopts the candidate replacement when a previous provider leaves the allowed pool", async () => {
    const input = directorInput();
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      narration: "雨停之后",
      visualPrompt: "雨停后的街角",
    });
    input.assetProviders = [{
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "metered",
      modes: ["AI 图片"],
      deliveryTypes: ["generated_image"],
      strengths: ["解释性画面"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 6,
    }];
    input.economics = { allowMeteredProviders: true };
    type MutableDirectorShot = Record<string, unknown> & {
      scenePosition: number;
      preferredProviderId: string;
      deliveryType: string;
      query: string;
      generationPrompt: string;
    };
    const baseShot = (validPlan().shots as MutableDirectorShot[])[0]!;
    // 上一版两镜都使用已下线的 A（wan-video-v1）；finding 只定位镜头 2；用户当前只允许 B。
    const previousPlan = validPlan();
    const previousShots = previousPlan.shots as MutableDirectorShot[];
    previousShots.push(structuredClone(baseShot));
    previousShots.forEach((shot, index) => {
      shot.scenePosition = index + 1;
      shot.preferredProviderId = "wan-video-v1";
      shot.deliveryType = "generated_video";
    });
    previousShots[1]!.query = "雨后 街角";
    previousShots[1]!.generationPrompt = "上一版第二镜";
    input.brief.rework = {
      sourceRunId: "run-rejected-removed-provider",
      visualDirectionInstruction: "只重做镜头 2。",
      assetInstruction: "只替换镜头 2 的素材。",
      findings: [{
        findingId: "vf_dddddddddddddddddddddddd",
        timecodeMs: 5_000,
        scenePosition: 2,
        category: "continuity",
        description: "第二镜动作错误。",
        suggestion: "只重做第二镜。",
        targetNodeIds: ["visual-direction", "assets"],
      }],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    const candidate = structuredClone(previousPlan);
    for (const shot of candidate.shots as Array<Record<string, unknown>>) {
      shot.preferredProviderId = "seedream-image-v1";
      shot.deliveryType = "generated_image";
    }
    (candidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "修正后的第二镜";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    const plan = await agent.plan(input);

    // 镜头 1 不回滚为已下线的 A，两镜都按 candidate 的 B 进入新报价。
    assert.deepEqual(plan.shots.map((shot) => shot.preferredProviderId), ["seedream-image-v1", "seedream-image-v1"]);
    assert.deepEqual(plan.shots.map((shot) => shot.deliveryType), ["generated_image", "generated_image"]);
    assert.deepEqual(plan.shots.map((shot) => shot.estimatedCostCny), [6, 6]);
    assert.equal(plan.shots[0]!.generationPrompt, "雨夜城市人物近景");
    assert.equal(plan.shots[1]!.generationPrompt, "修正后的第二镜");
  });

  it("still rejects a drift-expanded shot whose candidate provider is outside the allowed pool", async () => {
    const input = directorInput();
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      narration: "雨停之后",
      visualPrompt: "雨停后的街角",
    });
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    (previousPlan.shots as Array<Record<string, unknown>>).push(structuredClone(baseShot));
    (previousPlan.shots as Array<Record<string, unknown>>).forEach((shot, index) => {
      shot.scenePosition = index + 1;
      shot.preferredProviderId = "wan-video-v1";
      shot.deliveryType = "generated_video";
    });
    input.brief.rework = {
      sourceRunId: "run-rejected-removed-provider-no-bypass",
      visualDirectionInstruction: "只重做镜头 2。",
      assetInstruction: "只替换镜头 2 的素材。",
      findings: [],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    const candidate = structuredClone(previousPlan);
    // candidate 对差异闭包新增的镜头 1 给出的替换同样不在允许目录内：
    // 差异闭包不得绕过 allowed-provider 完整校验，仍必须拒绝。
    (candidate.shots as Array<Record<string, unknown>>)[0]!.preferredProviderId = "removed-image-v2";
    (candidate.shots as Array<Record<string, unknown>>)[1]!.preferredProviderId = "local-editorial-v1";
    (candidate.shots as Array<Record<string, unknown>>)[1]!.deliveryType = "editorial_card";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    await assert.rejects(() => agent.plan(input), /not in the enabled asset pool/);
  });

  it("rejects a partial-scope rework that changes the top-level visual bible", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const candidate = structuredClone(previousPlan);
    (candidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "修正后的第二镜";
    (candidate.visualBible as Record<string, unknown>).color = "统一换成冷蓝色体系";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    await assert.rejects(
      () => agent.plan(input),
      /changes the top-level visualBible while the rework scope is not the whole script/,
    );
  });

  it("adopts the candidate visual bible when the rework scope covers every scene", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    input.brief.rework!.affectedScenePositions = [1, 2];
    const candidate = structuredClone(previousPlan);
    (candidate.shots as Array<Record<string, unknown>>)[0]!.generationPrompt = "全片重做后的第一镜";
    (candidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "全片重做后的第二镜";
    (candidate.visualBible as Record<string, unknown>).color = "统一换成冷蓝色体系";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    const plan = await agent.plan(input);

    assert.equal((plan.visualBible as { color: string }).color, "统一换成冷蓝色体系");
    assert.equal(plan.shots[0]!.generationPrompt, "全片重做后的第一镜");
    assert.equal(plan.shots[1]!.generationPrompt, "全片重做后的第二镜");
  });

  it("sends the director-plan payload and returns the validated plan", async () => {
    const codexClient = new CapturingCodexClient(() => validPlan());
    const agent = new CodexVisualDirectorAgent({ client: codexClient });
    const input = directorInput();

    const result = await agent.plan(input);

    assert.deepEqual(result, validPlan());
    assert.equal(agent.id, "api-visual-director-v1");
    assert.equal(codexClient.calls.length, 1);
    assert.equal(codexClient.calls[0]?.kind, "director-plan");
    const payload = codexClient.calls[0]!.payload as Record<string, unknown>;
    assert.equal("directive" in payload, false);
    assert.equal("task" in payload, false);
    assert.equal("outputContract" in payload, false);
    const profiles = payload.directorProfiles as Array<{ id: string }>;
    assert.equal(profiles.length, 6);
    assert.equal(profiles[0]?.id, "documentary-observer");
    assert.deepEqual(payload.brief, input.brief);
    assert.deepEqual(payload.scenes, input.scenes);
    assert.deepEqual(payload.assetProviders, input.assetProviders);
    assert.deepEqual(payload.economics, input.economics);
  });

  it("accepts structured reference-image routes only when the director catalog declares support", async () => {
    const input = directorInput();
    input.scenes.push({ ...input.scenes[0]!, position: 2 });
    input.assetProviders = [{
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "metered",
      modes: ["AI 图片", "参考图再生成"],
      deliveryTypes: ["generated_image"],
      supportsReferenceImage: true,
      strengths: ["系列视觉连续性"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 0.25,
    }];
    input.economics = { allowMeteredProviders: true };
    const generatedPlan = validPlan();
    const first = (generatedPlan.shots as Array<Record<string, unknown>>)[0]!;
    first.preferredProviderId = "seedream-image-v1";
    first.deliveryType = "generated_image";
    const second = structuredClone(first);
    second.scenePosition = 2;
    second.referenceFromScenePosition = 1;
    (generatedPlan.shots as Array<Record<string, unknown>>).push(second);
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => generatedPlan) });

    const result = await agent.plan(input);

    assert.equal(result.shots[1]?.referenceFromScenePosition, 1);
    assert.deepEqual(result.shots.map((shot) => shot.estimatedCostCny), [0.25, 0.25]);
  });

  it("rejects malformed or incomplete plans without any fallback", async () => {
    const codexClient = new CapturingCodexClient(() => ({}));
    const agent = new CodexVisualDirectorAgent({ client: codexClient });

    await assert.rejects(() => agent.plan(directorInput()), /Director plan version must be/);

    codexClient.respond = () => null;
    await assert.rejects(() => agent.plan(directorInput()), /Director plan must be an object/);

    codexClient.respond = () => ({ version: "video-factory/director-plan-v1" });
    await assert.rejects(() => agent.plan(directorInput()), /requestedProfileId/);
    assert.equal(codexClient.calls.length, 3);
  });

  it("rejects plans that reference a provider outside the allowlist", async () => {
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.preferredProviderId = "pexels-stock-v1";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    await assert.rejects(() => agent.plan(directorInput()), /not in the enabled asset pool/);
  });

  it("keeps the creator cost target as planning feedback instead of a hidden hard limit", async () => {
    const input = directorInput();
    input.assetProviders = [{
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "metered",
      modes: ["AI 图片"],
      deliveryTypes: ["generated_image"],
      strengths: ["解释性画面"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 6,
    }];
    input.economics = { allowMeteredProviders: true };
    input.costFeedback = [
      { reason: "too_expensive", previousEstimatedCostCny: 10, targetEstimatedCostCny: 5 },
      { reason: "too_expensive", previousEstimatedCostCny: 12, targetEstimatedCostCny: 10 },
    ];
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.preferredProviderId = "seedream-image-v1";
    shot.deliveryType = "generated_image";
    const client = new CapturingCodexClient(() => plan);
    const agent = new CodexVisualDirectorAgent({ client });

    const result = await agent.plan(input);

    assert.equal(result.shots[0]?.estimatedCostCny, 6);
    assert.deepEqual((client.calls[0]?.payload as { costFeedback?: unknown }).costFeedback, input.costFeedback);
  });

  it("rejects element animation assigned to a static editorial card", async () => {
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.subject = "静态状态卡";
    shot.visibleAction = "灰色圆点同步变为绿色对勾";
    shot.temporalBeats = ["[0s-2s] 三项显示灰色圆点", "[2s-5s] 三个圆点同步变为绿色对勾"];
    shot.generationPrompt = "三行灰色圆点同步变为绿色对勾";
    shot.rationale = "本地卡片适合清单表达。";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    await assert.rejects(() => agent.plan(directorInput()), /unsupported element animation/);
  });

  it("rejects a shot whose rationale admits the selected provider cannot execute it", async () => {
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.visibleAction = "所有元素从首帧完整存在，整张卡片轻微推近";
    shot.temporalBeats = ["[0s-2s] 全部元素完整存在", "[2s-5s] 整张卡片轻微推近"];
    shot.generationPrompt = "静态卡片只做整张画面轻微推近";
    shot.rationale = "当前 Provider 缺少元素动画能力，需补充可执行 Provider 后生产。";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    await assert.rejects(() => agent.plan(directorInput()), /selected provider cannot execute/);
  });

  it("rejects plans that do not cover every scene exactly once", async () => {
    const input = directorInput();
    input.scenes = [
      ...input.scenes,
      {
        position: 2,
        narration: "第二幕",
        duration: 5,
        visualPrompt: "便利店灯箱",
        visualStrategy: "stock",
        visibleAction: "人物走进便利店",
        successCriteria: ["动作完整"],
        failureConditions: ["只有静态文字"],
        searchTerms: ["便利店", "夜晚"],
      },
    ];
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => validPlan()) });

    await assert.rejects(() => agent.plan(input), /must cover every script scene exactly once/);
  });

  it("rejects evidence shots routed to a generated delivery provider", async () => {
    const input = directorInput();
    input.assetProviders.push({
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "free",
      modes: ["AI 图片"],
      deliveryTypes: ["generated_image"],
      strengths: ["解释性画面"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 0,
    });
    const generatedPlan = validPlan();
    const generatedShot = (generatedPlan.shots as Array<Record<string, unknown>>)[0]!;
    generatedShot.authenticityPolicy = "evidence";
    generatedShot.preferredProviderId = "seedream-image-v1";
    generatedShot.deliveryType = "generated_image";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => generatedPlan) });

    await assert.rejects(() => agent.plan(input), /evidence shot.*generative provider/);
  });

  it("keeps the historical provider id for persisted briefs", () => {
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => validPlan()) });
    assert.equal(agent.id, "api-visual-director-v1");
  });
});
