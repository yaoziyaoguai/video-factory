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
      temporalBeats: [
        { startSeconds: 0, endSeconds: 2, action: "雨伞占据前景，人物进入" },
        { startSeconds: 2, endSeconds: 5, action: "收伞并抬头，暖光落在脸侧" },
      ],
      sourceInSeconds: 0,
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
    input.brief.durationRange = { minSeconds: 20, maxSeconds: 34 };
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
    input.brief.voiceTiming = { rate: 192, pauseScale: 1.2 };
    const articleSources = [{
      sourceId: "source-report",
      originalUrl: "https://news.example/report",
      finalUrl: "https://news.example/report",
      pageTitle: "公开报告",
      fetchedAt: "2026-09-14T08:00:00.000Z",
      contentSha256: "a".repeat(64),
      extractorVersion: "readability-v1",
      readStatus: "read" as const,
      paragraphs: [{ id: "p1", text: "正文中的可核对事实。" }],
      truncated: false,
    }];
    input.brief.articleSources = articleSources;
    input.assetProviders[0]!.constraints.push("成片必须保留 AIGC 标识");
    const firstPlan = validPlan();
    const repairedPlan = validPlan();
    repairedPlan.profileRationale = "都市夜景、人物动作与冷暖光对照共同兑现观众承诺。";
    const repairAudit = {
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 78, evidence: "开场镜头有具体对象。" },
          { dimension: "progression", score: 78, evidence: "逐镜视觉推进不明确。" },
          { dimension: "payoff", score: 78, evidence: "风格理由没有兑现观众承诺。" },
          { dimension: "expression", score: 78, evidence: "理由只写题材适配。" },
        ],
      }],
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
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 94, evidence: "开场给出具体动作。" },
          { dimension: "progression", score: 94, evidence: "逐镜视觉推进连贯。" },
          { dimension: "payoff", score: 94, evidence: "结尾兑现观众承诺。" },
          { dimension: "expression", score: 94, evidence: "风格理由自然可读。" },
        ],
      }],
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
        upstreamFacts: {
          brief: {
            visualProof?: string;
            visualPlan?: unknown;
            voiceTiming?: unknown;
            articleSources?: unknown;
          };
          scenes: Array<Record<string, unknown>>;
        };
        currentRoleContract: Record<string, unknown>;
        downstreamBoundary: string;
      };
    };
    const producerBrief = (producerClient.calls[0]!.payload as { brief: VisualDirectorAgentInput["brief"] }).brief;
    assert.equal(producerBrief.visualProof, visualProof);
    assert.deepEqual(producerBrief.visualPlan, visualPlan);
    assert.deepEqual(producerBrief.durationRange, { minSeconds: 20, maxSeconds: 34 });
    assert.deepEqual(producerBrief.voiceTiming, { rate: 192, pauseScale: 1.2 });
    assert.deepEqual(producerBrief.articleSources, articleSources);
    assert.equal(auditPayload.context.upstreamFacts.brief.visualProof, visualProof);
    assert.deepEqual(auditPayload.context.upstreamFacts.brief.visualPlan, visualPlan);
    assert.deepEqual(auditPayload.context.upstreamFacts.brief.voiceTiming, { rate: 192, pauseScale: 1.2 });
    assert.deepEqual(auditPayload.context.upstreamFacts.brief.articleSources, articleSources);
    const contract = auditPayload.context.currentRoleContract;
    assert.deepEqual(contract.durationRange, { minSeconds: 20, maxSeconds: 34 });
    const auditCriteria = (auditClient.calls[0]!.payload as { criteria: string[] }).criteria.join("\n");
    assert.match(
      auditCriteria,
      /视觉圣经和逐镜职责兑现已接受构思与脚本承诺.*可说明的推进/,
    );
    assert.match(
      auditCriteria,
      /真正的跨镜身份与因果要求有执行依据.*否定句中的词语不构成肯定要求/,
    );
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
    assert.match(
      String((contract.inheritedScriptFields as { onScreenText: string }).onScreenText),
      /下游从脚本逐镜继承.*不重复输出/,
    );
    assert.deepEqual(contract.assetReuse, {
      querySyntax: "REUSE_ONLY scene N",
      execution: "下游素材执行器直接复用已解析的更早镜头母片，不会重新搜索、生成或计费。",
      constraints: [
        "N 只能引用更早且可成功解析的导演镜头。",
        "多级复用始终解析到同一个根母片，不能形成循环。",
        "视频可从母片明确的非负起点按正常速度使用；只有母片完整覆盖该源区间时才允许复用。",
        "静态图片的 sourceInSeconds 必须为 0；所有媒体都不得循环、变速、定格或补帧凑时长。",
        "生成视频母片的请求时长按全部直接与多级复用区间的最远终点，以及所选模型的时长规则归一化。",
      ],
    });
    assert.deepEqual(contract.timelineExecution, {
      temporalBeatsDescribeRenderedSceneDuration: true,
      generatedClipMayBeLongerThanRenderedScene: true,
      extraGeneratedTailIsTrimmed: true,
      rule: "temporalBeats 的结束时间不得超过脚本镜头时长；Provider 最短生成时长更长时，只描述成片实际使用区间，多出的母片尾部由渲染器裁切。",
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

  it("keeps revisions stateful while each full independent audit starts without inherited history", async () => {
    const first = validPlan();
    const repaired = validPlan();
    repaired.profileRationale = "用固定轴线和冷暖光变化兑现观众承诺。";
    const client = new SessionAwareCodexClient({
      "director-plan": [first, repaired],
      "role-audit": [{
        version: "video-factory/role-audit-v2",
        rubricVersion: "video-factory/role-quality-rubric-v1",
        assessments: [{
          targetPath: "",
          dimensions: [
            { dimension: "attention", score: 76, evidence: "开场钩子偏弱。" },
            { dimension: "progression", score: 76, evidence: "镜头推进缺少变化。" },
            { dimension: "payoff", score: 76, evidence: "风格理由没有说明动作与光线。" },
            { dimension: "expression", score: 76, evidence: "理由表述笼统。" },
          ],
        }],
        verdict: "repair",
        score: 76,
        summary: "风格理由需要修改。",
        issues: [{
          severity: "blocking",
          criterion: "视觉圣经兑现观众承诺",
          evidence: "风格理由没有说明动作与光线。",
          repairInstruction: "补充动作和光线。",
        }],
        repairInstructions: ["补充动作和光线。"],
      }, {
        version: "video-factory/role-audit-v2",
        rubricVersion: "video-factory/role-quality-rubric-v1",
        assessments: [{
          targetPath: "",
          dimensions: [
            { dimension: "attention", score: 93, evidence: "开场具体。" },
            { dimension: "progression", score: 93, evidence: "视觉推进清楚。" },
            { dimension: "payoff", score: 93, evidence: "结尾兑现承诺。" },
            { dimension: "expression", score: 93, evidence: "风格理由可读。" },
          ],
        }],
        verdict: "pass",
        score: 93,
        summary: "可以进入下游。",
        issues: [],
        repairInstructions: [],
      }],
    });
    const agent = new CodexVisualDirectorAgent({ client, maxReviewIterations: 2 });

    await agent.planDetailed(directorInput());

    const producerCalls = client.calls.filter(({ kind }) => kind === "director-plan");
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
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 95, evidence: "开场具体。" },
          { dimension: "progression", score: 95, evidence: "逐镜推进连贯。" },
          { dimension: "payoff", score: 95, evidence: "两类返工要求均已落实。" },
          { dimension: "expression", score: 95, evidence: "方案表述清楚。" },
        ],
      }],
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
    const producerRework = (producerClient.calls[0]!.payload as {
      brief: { rework: { affectedScenePositions: number[]; previousDirectorPlan: { shots: Array<{ scenePosition: number }> } } };
    }).brief.rework;
    assert.deepEqual(producerRework.affectedScenePositions, [1]);
    assert.deepEqual(producerRework.previousDirectorPlan.shots.map(({ scenePosition }) => scenePosition), [1]);
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
            preservedShotAuthority: string;
            verificationBoundary: string;
          };
        };
      };
    };
    assert.ok(auditPayload.criteria.some((criterion) => (
      criterion.includes("visualDirectionInstruction 与 assetInstruction")
      && criterion.includes("仅修改授权范围并继承其余镜头")
      // 未受影响镜头由宿主逐字继承，候选无法改写；审计不得要求方案为它们改写字段，
      // 否则审计会向一个结构上无法执行的要求开闸，把返工卡成永久失败。
      && criterion.includes("未受影响镜头")
      && criterion.includes("宿主逐字继承")
      && criterion.includes("不得要求")
      && criterion.includes("没有新审片证据不能标 verified")
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
    // 只把“未受影响镜头归宿主所有、候选不可改写”说清楚，同时保留冲突职责：
    // 为未受影响镜头安排新付费生成、丢弃既有母片或直接违反补查要求仍必须阻断。
    const preservedShotAuthority = auditPayload.context.currentRoleContract.reworkAuthorization.preservedShotAuthority;
    assert.match(preservedShotAuthority, /未受影响镜头/);
    assert.match(preservedShotAuthority, /宿主/);
    assert.match(preservedShotAuthority, /不得要求/);
    assert.match(preservedShotAuthority, /仍必须阻断/);
    assert.match(auditPayload.context.currentRoleContract.reworkAuthorization.verificationBoundary, /不得宣称后续视觉审片已经验证通过/);
    const auditRework = (auditClient.calls[0]!.payload as {
      context: { upstreamFacts: { brief: { rework: Record<string, unknown> } } };
    }).context.upstreamFacts.brief.rework;
    // 本用例只有镜头 1 且全部受影响，生产模型侧的收窄是空操作，审计基线应与原始基线同形。
    assert.deepEqual(
      (auditRework.previousDirectorPlan as { shots: Array<{ scenePosition: number }> })
        .shots.map(({ scenePosition }) => scenePosition),
      [1],
    );
    assert.equal(auditRework.visualDirectionInstruction, input.brief.rework.visualDirectionInstruction);
    assert.deepEqual(auditRework.affectedScenePositions, [1]);
  });

  it("gives the independent audit the un-narrowed rework baseline so inherited shots are not read as new paid routes", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const candidate = structuredClone(previousPlan);
    // 生产模型只需给出受影响镜头；未受影响的镜头 1 由宿主逐字继承。
    (candidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "修正后的第二镜";
    candidate.shots = [(candidate.shots as Array<Record<string, unknown>>)[1]!];
    const producerClient = new SequencedCodexClient([candidate], "openai", "gpt-5.6-sol");
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 95, evidence: "开场镜头保持有效。" },
          { dimension: "progression", score: 95, evidence: "返工后推进连贯。" },
          { dimension: "payoff", score: 95, evidence: "结尾兑现承诺。" },
          { dimension: "expression", score: 95, evidence: "方案表述清楚。" },
        ],
      }],
      verdict: "pass",
      score: 95,
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

    await agent.planDetailed({ ...input, selectedModelId: "gpt-5.6-sol" });

    const producerRework = (producerClient.calls[0]!.payload as {
      brief: { rework: { previousDirectorPlan: { shots: Array<{ scenePosition: number }> } } };
    }).brief.rework;
    const auditRework = (auditClient.calls[0]!.payload as {
      context: {
        upstreamFacts: { brief: { rework: {
          affectedScenePositions: number[];
          previousDirectorPlan: { shots: Array<{ scenePosition: number; generationPrompt: string }> };
        } } };
      };
    }).context.upstreamFacts.brief.rework;

    // 生产模型只拿到受影响镜头 2 的基线……
    assert.deepEqual(producerRework.previousDirectorPlan.shots.map(({ scenePosition }) => scenePosition), [2]);
    // ……审计必须拿到未收窄的完整基线，才能核对“其余镜头逐字继承”而不是靠 visual_strategy 反推。
    assert.deepEqual(auditRework.previousDirectorPlan.shots.map(({ scenePosition }) => scenePosition), [1, 2]);
    assert.equal(auditRework.previousDirectorPlan.shots[0]!.generationPrompt, "雨夜城市人物近景");
    assert.deepEqual(auditRework.affectedScenePositions, [2]);
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
    candidateShots[1]!.generationPrompt = "修正后的第二镜";
    candidate.shots = [candidateShots[1]!];
    const producerClient = new SequencedCodexClient([candidate], "openai", "gpt-5.6-sol");
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 96, evidence: "开场镜头保持有效。" },
          { dimension: "progression", score: 96, evidence: "返工后推进连贯。" },
          { dimension: "payoff", score: 96, evidence: "结尾兑现承诺。" },
          { dimension: "expression", score: 96, evidence: "方案表述清楚。" },
        ],
      }],
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
    assert.equal((producerClient.calls[0]!.payload as { brief: { rework: { affectedScenePositions: number[] } } }).brief.rework.affectedScenePositions[0], 2);
  });

  it("keeps the initial rework scoped, then lets stateless repair inspect the merged plan", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const firstCandidate = structuredClone(previousPlan);
    const secondCandidate = structuredClone(previousPlan);
    (firstCandidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "第一次修正后的第二镜";
    (secondCandidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "审计后修正的第二镜";
    firstCandidate.shots = [(firstCandidate.shots as Array<Record<string, unknown>>)[1]!];
    const producerClient = new SequencedCodexClient([firstCandidate, secondCandidate], "zai-bigmodel-api", "glm-5.3");
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 78, evidence: "开场钩子偏弱。" },
          { dimension: "progression", score: 78, evidence: "第二镜缺少动作落点。" },
          { dimension: "payoff", score: 78, evidence: "结尾收益不明确。" },
          { dimension: "expression", score: 78, evidence: "镜头描述偏笼统。" },
        ],
      }],
      verdict: "repair",
      score: 78,
      summary: "第二镜动作还不够明确。",
      issues: [{
        severity: "blocking",
        criterion: "动作可执行",
        evidence: "第二镜缺少动作落点。",
        repairInstruction: "只补齐第二镜动作落点。",
      }],
      repairInstructions: ["只补齐第二镜动作落点。"],
    }, {
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 94, evidence: "开场镜头有效。" },
          { dimension: "progression", score: 94, evidence: "第二镜动作已落实。" },
          { dimension: "payoff", score: 94, evidence: "结尾兑现承诺。" },
          { dimension: "expression", score: 94, evidence: "镜头描述具体。" },
        ],
      }],
      verdict: "pass",
      score: 94,
      summary: "局部返工可执行。",
      issues: [],
      repairInstructions: [],
    }], "openai", "gpt-5.6-sol");
    const agent = new CodexVisualDirectorAgent({
      client: producerClient,
      auditClient,
      maxReviewIterations: 2,
      modelId: "glm-5.3",
      sessionMode: "stateless",
    });

    const execution = await agent.planDetailed({ ...input, selectedModelId: "glm-5.3" });

    const firstPayload = producerClient.calls[0]!.payload as {
      brief: { rework: { previousDirectorPlan: { shots: Array<{ scenePosition: number }> } } };
    };
    const secondRevision = (producerClient.calls[1]!.payload as {
      revision: { mode: string; candidate: { shots: Array<{ scenePosition: number }> } };
    }).revision;
    assert.deepEqual(firstPayload.brief.rework.previousDirectorPlan.shots.map(({ scenePosition }) => scenePosition), [2]);
    assert.equal(secondRevision.mode, "repair-bootstrap");
    assert.deepEqual(secondRevision.candidate.shots.map(({ scenePosition }) => scenePosition), [1, 2]);
    assert.deepEqual(
      auditClient.calls.map(({ payload }) => (payload as { candidate: { shots: Array<{ scenePosition: number }> } }).candidate.shots.map(({ scenePosition }) => scenePosition)),
      [[1, 2], [1, 2]],
    );
    assert.equal(execution.output.shots[0]!.generationPrompt, "雨夜城市人物近景");
    assert.equal(execution.output.shots[1]!.generationPrompt, "审计后修正的第二镜");
  });

  it("does not let an audit repair silently expand a scoped rework to an unaffected shot", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    (previousPlan.shots as Array<Record<string, unknown>>)[0]!.generationPrompt = "第一镜仍有水位矛盾";
    const firstCandidate = structuredClone(previousPlan);
    (firstCandidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "第一次修正后的第二镜";
    firstCandidate.shots = [(firstCandidate.shots as Array<Record<string, unknown>>)[1]!];
    const repairedCandidate = structuredClone(previousPlan);
    (repairedCandidate.shots as Array<Record<string, unknown>>)[0]!.generationPrompt = "第一镜水位已经统一";
    (repairedCandidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "第一次修正后的第二镜";
    const producerClient = new SequencedCodexClient([firstCandidate, repairedCandidate], "zai-bigmodel-api", "glm-5.3");
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 75, evidence: "开场镜头有效。" },
          { dimension: "progression", score: 75, evidence: "第一镜水位与视觉圣经冲突。" },
          { dimension: "payoff", score: 75, evidence: "结尾收益受影响。" },
          { dimension: "expression", score: 75, evidence: "跨镜描述不一致。" },
        ],
      }],
      verdict: "repair",
      score: 75,
      summary: "第一镜仍有阻断性的水位矛盾。",
      issues: [{
        severity: "blocking",
        criterion: "合并后的完整方案必须保持跨镜一致",
        evidence: "第一镜水位与视觉圣经冲突。",
        repairInstruction: "只修正第一镜水位，其他镜头保持不变。",
      }],
      repairInstructions: ["只修正第一镜水位，其他镜头保持不变。"],
    }, {
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 92, evidence: "开场镜头有效。" },
          { dimension: "progression", score: 92, evidence: "跨镜水位已经统一。" },
          { dimension: "payoff", score: 92, evidence: "结尾兑现承诺。" },
          { dimension: "expression", score: 92, evidence: "描述一致可读。" },
        ],
      }],
      verdict: "pass",
      score: 92,
      summary: "合并后的完整方案已经一致。",
      issues: [],
      repairInstructions: [],
    }], "openai", "gpt-5.6-sol");
    const agent = new CodexVisualDirectorAgent({
      client: producerClient,
      auditClient,
      maxReviewIterations: 2,
      modelId: "glm-5.3",
      sessionMode: "stateless",
    });

    await assert.rejects(
      () => agent.planDetailed({ ...input, selectedModelId: "glm-5.3" }),
      /按修改建议重做后内容没有变化/,
    );

    const repairRevision = (producerClient.calls[1]!.payload as {
      revision: { mode: string; candidate: { shots: Array<{ scenePosition: number }> } };
    }).revision;
    assert.equal(repairRevision.mode, "repair-bootstrap");
    assert.deepEqual(repairRevision.candidate.shots.map(({ scenePosition }) => scenePosition), [1, 2]);
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
    assert.deepEqual(plan.shots[1]!.temporalBeats, [
      { startSeconds: 0, endSeconds: 2, action: "雨势减弱" },
      { startSeconds: 2, endSeconds: 4, action: "人物走入街角" },
    ]);
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

    assert.deepEqual(plan.shots[0]!.temporalBeats, [
      { startSeconds: 0, endSeconds: 2, action: "雨伞占据前景，人物进入" },
      { startSeconds: 2, endSeconds: 5, action: "收伞并抬头，暖光落在脸侧" },
    ]);
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

  it("stops before the model when a previous provider leaves the authorized rework scope", async () => {
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
    const client = new CapturingCodexClient(() => candidate);
    const agent = new CodexVisualDirectorAgent({ client });

    await assert.rejects(() => agent.plan(input), /scenes 1.*no longer executable/);
    assert.equal(client.calls.length, 0);
  });

  it("stops before the model when a new video-model duration makes an unaffected reuse route impossible", async () => {
    const input = directorInput();
    input.scenes[0] = { ...input.scenes[0]!, duration: 4 };
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      duration: 5,
      narration: "继续沿用同一段母片",
      visualPrompt: "复用第一镜母片",
    });
    input.assetProviders = [{
      id: "seedance-video-v1",
      label: "Seedance",
      billing: "metered",
      modes: ["AI 视频"],
      deliveryTypes: ["generated_video"],
      strengths: ["动态镜头"],
      constraints: ["当前模型最多生成 4 秒"],
      minDurationSeconds: 4,
      maxDurationSeconds: 4,
      estimatedCnyPerClip: 2,
    }];
    input.economics = { allowMeteredProviders: true };
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    previousPlan.shots = [{
      ...structuredClone(baseShot),
      scenePosition: 1,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      query: "generated master",
      temporalBeats: ["[0s-2s] 建立母片", "[2s-4s] 完成母片"],
    }, {
      ...structuredClone(baseShot),
      scenePosition: 2,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      query: "REUSE_ONLY scene 1 locked master crop",
      temporalBeats: ["[0s-2s] 复用前段", "[2s-5s] 复用后段"],
    }];
    input.brief.rework = {
      sourceRunId: "run-reuse-duration-drift",
      visualDirectionInstruction: "只重做镜头 1。",
      assetInstruction: "镜头 2 继续沿用已有母片。",
      findings: [],
      affectedScenePositions: [1],
      previousDirectorPlan: previousPlan,
    };
    const client = new CapturingCodexClient(() => previousPlan);
    const agent = new CodexVisualDirectorAgent({ client });

    await assert.rejects(() => agent.plan(input), /scenes 2.*no longer executable/);
    assert.equal(client.calls.length, 0);
  });

  it("requires renewed scope before the model when an unaffected reuse source offset exceeds the model limit", async () => {
    const input = directorInput();
    input.scenes[0] = { ...input.scenes[0]!, duration: 4 };
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      duration: 4,
      narration: "从母片后半段继续",
      visualPrompt: "从第四秒复用第一镜母片",
    });
    input.assetProviders = [{
      id: "seedance-video-v1",
      label: "Seedance",
      billing: "metered",
      modes: ["AI 视频"],
      deliveryTypes: ["generated_video"],
      strengths: ["动态镜头"],
      constraints: ["当前模型最多生成 6 秒"],
      minDurationSeconds: 4,
      maxDurationSeconds: 6,
      estimatedCnyPerClip: 2,
    }];
    input.economics = { allowMeteredProviders: true };
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    previousPlan.shots = [{
      ...structuredClone(baseShot),
      scenePosition: 1,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      query: "generated master",
      temporalBeats: ["[0s-2s] 建立母片", "[2s-4s] 完成母片"],
    }, {
      ...structuredClone(baseShot),
      scenePosition: 2,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      query: "REUSE_ONLY scene 1 later source range",
      sourceInSeconds: 4,
      temporalBeats: ["[0s-2s] 使用后半段", "[2s-4s] 完成复用"],
    }];
    input.brief.rework = {
      sourceRunId: "run-reuse-offset-duration-drift",
      visualDirectionInstruction: "只重做镜头 1。",
      assetInstruction: "镜头 2 继续沿用已有母片。",
      findings: [],
      affectedScenePositions: [1],
      previousDirectorPlan: previousPlan,
    };
    const client = new CapturingCodexClient(() => previousPlan);
    const agent = new CodexVisualDirectorAgent({ client });

    await assert.rejects(() => agent.plan(input), /scenes 2.*no longer executable/);
    assert.equal(client.calls.length, 0);
  });

  it("requires renewed scope before the model when an unaffected generated-video root exceeds the model limit", async () => {
    const input = directorInput();
    input.scenes[0] = { ...input.scenes[0]!, duration: 8 };
    input.scenes.push({
      ...input.scenes[0]!,
      position: 2,
      duration: 4,
      narration: "重做第二镜",
      visualPrompt: "新的第二镜",
    });
    input.assetProviders = [{
      id: "seedance-video-v1",
      label: "Seedance",
      billing: "metered",
      modes: ["AI 视频"],
      deliveryTypes: ["generated_video"],
      strengths: ["动态镜头"],
      constraints: ["当前模型最多生成 4 秒"],
      minDurationSeconds: 4,
      maxDurationSeconds: 4,
      estimatedCnyPerClip: 2,
    }];
    input.economics = { allowMeteredProviders: true };
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    previousPlan.shots = [{
      ...structuredClone(baseShot),
      scenePosition: 1,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      query: "eight second generated master",
      temporalBeats: ["[0s-4s] 建立母片", "[4s-8s] 完成母片"],
    }, {
      ...structuredClone(baseShot),
      scenePosition: 2,
      preferredProviderId: "seedance-video-v1",
      deliveryType: "generated_video",
      query: "replacement scene",
      temporalBeats: ["[0s-2s] 建立新镜头", "[2s-4s] 完成新镜头"],
    }];
    input.brief.rework = {
      sourceRunId: "run-generated-root-duration-drift",
      visualDirectionInstruction: "只重做镜头 2。",
      assetInstruction: "只替换镜头 2 的素材。",
      findings: [],
      affectedScenePositions: [2],
      previousDirectorPlan: previousPlan,
    };
    const client = new CapturingCodexClient(() => previousPlan);
    const agent = new CodexVisualDirectorAgent({ client });

    await assert.rejects(() => agent.plan(input), /scenes 1.*no longer executable/);
    assert.equal(client.calls.length, 0);
  });

  it("does not ask the model to repair configuration drift outside the approved scene set", async () => {
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
    (candidate.shots as Array<Record<string, unknown>>)[0]!.preferredProviderId = "removed-image-v2";
    (candidate.shots as Array<Record<string, unknown>>)[1]!.preferredProviderId = "local-editorial-v1";
    (candidate.shots as Array<Record<string, unknown>>)[1]!.deliveryType = "editorial_card";
    const client = new CapturingCodexClient(() => candidate);
    const agent = new CodexVisualDirectorAgent({ client });

    await assert.rejects(() => agent.plan(input), /scenes 1.*no longer executable/);
    assert.equal(client.calls.length, 0);
  });

  it("keeps the previous visual bible during a scene-scoped rework", async () => {
    const { input, previousPlan } = scopedReworkWithSecondScene();
    const candidate = structuredClone(previousPlan);
    (candidate.shots as Array<Record<string, unknown>>)[0]!.generationPrompt = "模型无意中改写了第一镜";
    (candidate.shots as Array<Record<string, unknown>>)[1]!.generationPrompt = "修正后的第二镜";
    (candidate.visualBible as Record<string, unknown>).color = "统一换成冷蓝色体系";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => candidate) });

    const plan = await agent.plan(input);

    assert.equal((plan.visualBible as { color: string }).color, "霓虹综合色");
    assert.equal(plan.shots[0]!.generationPrompt, "雨夜城市人物近景");
    assert.equal(plan.shots[1]!.generationPrompt, "修正后的第二镜");
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

  it("requires renewed scope approval when an unaffected reference alternative loses support", async () => {
    const input = directorInput();
    input.scenes.push({ ...input.scenes[0]!, position: 2, narration: "雨停之后", visualPrompt: "雨停后的街角" });
    input.assetProviders = [
      {
        id: "seedream-image-v1",
        label: "Seedream",
        billing: "metered",
        modes: ["AI 图片", "参考图再生成"],
        deliveryTypes: ["generated_image"],
        supportsReferenceImage: true,
        strengths: ["系列视觉连续性"],
        constraints: ["不得作为事实证据"],
        estimatedCnyPerClip: 0.25,
      },
      {
        id: "doubao-image-v1",
        label: "Doubao",
        billing: "metered",
        modes: ["AI 图片"],
        deliveryTypes: ["generated_image"],
        strengths: ["解释性画面"],
        constraints: ["不得作为事实证据"],
        estimatedCnyPerClip: 0.2,
      },
    ];
    input.economics = { allowMeteredProviders: true };
    const baseShot = (validPlan().shots as Array<Record<string, unknown>>)[0]!;
    const previousPlan = validPlan();
    const previousShots = previousPlan.shots as Array<Record<string, unknown>>;
    previousShots[0] = {
      ...structuredClone(baseShot),
      preferredProviderId: "seedream-image-v1",
      deliveryType: "generated_image",
      alternativeProviderIds: [],
      estimatedCostCny: 0.25,
    };
    // 上一版第二镜的 preferred 仍支持参考图，但备选已不支持：与验证同口径应判漂移。
    previousShots.push({
      ...structuredClone(baseShot),
      scenePosition: 2,
      preferredProviderId: "seedream-image-v1",
      deliveryType: "generated_image",
      alternativeProviderIds: ["doubao-image-v1"],
      referenceFromScenePosition: 1,
      generationPrompt: "上一版第二镜",
      query: "雨后 街角",
      estimatedCostCny: 0.25,
    });
    input.brief.rework = {
      sourceRunId: "run-reference-alternative-drift",
      visualDirectionInstruction: "只重做第一镜，第二镜沿用。",
      assetInstruction: "保留第二镜。",
      findings: [{
        findingId: "vf_driftaaaaaaaaaaaaaaaaaaaaa",
        timecodeMs: 2_000,
        scenePosition: 1,
        category: "composition",
        description: "第一镜构图失衡。",
        suggestion: "重新构图。",
        targetNodeIds: ["visual-direction", "assets"],
      }],
      affectedScenePositions: [1],
      previousDirectorPlan: previousPlan,
    };
    const candidate = structuredClone(previousPlan);
    const candidateShots = candidate.shots as Array<Record<string, unknown>>;
    candidateShots[0]!.generationPrompt = "修正后的第一镜";
    candidateShots[1]!.alternativeProviderIds = [];
    candidateShots[1]!.generationPrompt = "备选已清理的第二镜";
    const client = new CapturingCodexClient(() => candidate);
    const agent = new CodexVisualDirectorAgent({ client });

    await assert.rejects(() => agent.plan(input), /scenes 2.*no longer executable/);
    assert.equal(client.calls.length, 0);
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
    assert.deepEqual(payload.brief, {
      ...input.brief,
      productionCapabilities: {
        assetProviders: [{
          id: "local-editorial-v1",
          deliveryTypes: ["editorial_card"],
          supportsReferenceImage: false,
          strengths: ["标题卡、数据卡与清单步骤"],
          constraints: ["不包含真实人物动作或现场环境"],
        }],
        editing: { sourceRangeReuse: true, staticEditorialCard: true },
        audio: { narration: false, pauseControl: "unsupported", musicTrack: false, soundEffectsTrack: false },
      },
    });
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

  it("lets the director replace an illustrative stock suggestion with an allowed generated route", async () => {
    const input = directorInput();
    input.scenes[0]!.visualStrategy = "stock";
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
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.preferredProviderId = "seedream-image-v1";
    shot.deliveryType = "generated_image";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    const result = await agent.plan(input);
    assert.equal(result.shots[0]?.deliveryType, "generated_image");
  });

  it("rejects generated shots that claim real verification", async () => {
    const input = directorInput();
    input.scenes[0]!.visualStrategy = "generated";
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
    const plan = validPlan();
    const shot = (plan.shots as Array<Record<string, unknown>>)[0]!;
    shot.preferredProviderId = "seedream-image-v1";
    shot.deliveryType = "generated_image";
    shot.authenticityPolicy = "illustrative";
    shot.rationale = "生成画面已经验证了产品效果。";
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    await assert.rejects(() => agent.plan(input), /generated visual as real-world evidence/);
  });

  it("lets the independent audit name unsupported identity continuity instead of keyword-rejecting the plan", async () => {
    const input = directorInput();
    input.scenes = [1, 2].map((position) => ({
      position,
      narration: `第 ${position} 幕`,
      duration: 5,
      visualPrompt: `生成镜头 ${position}`,
      visualStrategy: "generated" as const,
      visibleAction: "人物完成一个独立动作",
      successCriteria: ["动作可见"],
      failureConditions: ["动作缺失"],
      searchTerms: ["人物动作"],
    }));
    input.assetProviders = [{
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "free",
      modes: ["AI 图片"],
      deliveryTypes: ["generated_image"],
      strengths: ["解释性画面"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 0,
    }];
    const plan = validPlan();
    plan.visualBible = { ...(plan.visualBible as Record<string, unknown>), continuity: "同一人物与同一杯子跨镜保持不变" };
    plan.shots = [1, 2].map((position) => ({
      ...(structuredClone((validPlan().shots as Array<Record<string, unknown>>)[0]!)),
      scenePosition: position,
      preferredProviderId: "seedream-image-v1",
      deliveryType: "generated_image",
      authenticityPolicy: "illustrative",
      subject: "人物与杯子",
      generationPrompt: `第 ${position} 个独立生成画面`,
      continuityNote: "同一人物与杯子保持一致",
    }));
    const producerClient = new SequencedCodexClient([plan], "zai-bigmodel-api", "glm-5.3");
    const auditClient = new SequencedCodexClient([{
      version: "video-factory/role-audit-v2",
      rubricVersion: "video-factory/role-quality-rubric-v1",
      assessments: [{
        targetPath: "",
        dimensions: [
          { dimension: "attention", score: 55, evidence: "开场画面独立可用。" },
          { dimension: "progression", score: 55, evidence: "跨镜身份依赖没有执行依据。" },
          { dimension: "payoff", score: 55, evidence: "身份连续性承诺无法兑现。" },
          { dimension: "expression", score: 55, evidence: "画面描述与路由不一致。" },
        ],
      }],
      verdict: "repair",
      score: 55,
      summary: "方案把两个独立生成镜头当作同一人物与物件，当前路由无法兑现。",
      issues: [{
        severity: "blocking",
        criterion: "跨镜身份依赖必须有可执行复用或参考依据",
        evidence: "两个镜头均独立生成，却要求同一人物和杯子保持不变。",
        repairInstruction: "改用同一母片复用、受支持的参考图，或重写为无需同一主体的叙事。",
      }],
      repairInstructions: ["为身份连续性提供可执行路由，或删除该叙事依赖。"],
    }], "openai", "gpt-5.6-sol");
    const agent = new CodexVisualDirectorAgent({
      client: producerClient,
      auditClient,
      maxReviewIterations: 1,
      modelId: "glm-5.3",
      sessionMode: "stateless",
    });

    // 方案没有被关键词过滤器拦下（它会误伤"不承诺精确身份"的否定句），而是走完了 producer，
    // 由独立审计指名问题。审计只出建议，不替用户判成败：候选与这条 repair 结论一起交还给用户。
    const stopped = await agent.planDetailed({ ...input, selectedModelId: "glm-5.3" });
    assert.equal(stopped.agentLoop?.status, "awaiting_user");
    assert.equal(stopped.agentLoop?.iterations.at(-1)?.audit.verdict, "repair");
    assert.match(stopped.agentLoop?.iterations.at(-1)?.audit.summary ?? "", /同一人物与物件/);
    assert.deepEqual(producerClient.calls.map(({ kind }) => kind), ["director-plan"]);
    assert.deepEqual(auditClient.calls.map(({ kind }) => kind), ["role-audit"]);
  });

  it("accepts independently generated scenes that explicitly disclaim shared identity", async () => {
    const input = directorInput();
    input.scenes = [1, 2].map((position) => ({
      position,
      narration: `第 ${position} 幕`,
      duration: 5,
      visualPrompt: `生成镜头 ${position}`,
      visualStrategy: "generated" as const,
      visibleAction: "人物完成一个独立动作",
      successCriteria: ["动作可见"],
      failureConditions: ["动作缺失"],
      searchTerms: ["人物动作"],
    }));
    input.assetProviders = [{
      id: "seedream-image-v1",
      label: "Seedream",
      billing: "free",
      modes: ["AI 图片"],
      deliveryTypes: ["generated_image"],
      strengths: ["解释性画面"],
      constraints: ["不得作为事实证据"],
      estimatedCnyPerClip: 0,
    }];
    const plan = validPlan();
    plan.visualBible = {
      ...(plan.visualBible as Record<string, unknown>),
      continuity: "只统一构图和色彩，不承诺跨镜是同一人物或同一物件。",
    };
    plan.shots = [1, 2].map((position) => ({
      ...(structuredClone((validPlan().shots as Array<Record<string, unknown>>)[0]!)),
      scenePosition: position,
      preferredProviderId: "seedream-image-v1",
      deliveryType: "generated_image",
      authenticityPolicy: "illustrative",
      subject: "无可识别身份特征的人物与普通物件",
      generationPrompt: `第 ${position} 个独立生成画面`,
      continuityNote: "只延续视觉母题，不宣称人物或物件与其他镜头属于同一实体。",
    }));
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => plan) });

    const result = await agent.plan(input);

    assert.equal(result.shots.length, 2);
  });

  it("keeps the historical provider id for persisted briefs", () => {
    const agent = new CodexVisualDirectorAgent({ client: new CapturingCodexClient(() => validPlan()) });
    assert.equal(agent.id, "api-visual-director-v1");
  });
});
