import {
  CodexBriefAuditAgent,
  CodexCreativeTreatmentAgent,
  CodexScreenwriterAgent,
  CodexVisualDirectorAgent,
  CodexVisualReviewAgent,
  FallbackScreenwriterAgent,
  FallbackVisualDirectorAgent,
  FallbackVisualReviewAgent,
  IndependentDualVisualReviewAgent,
  type BriefAuditAgent,
  type CodexBridgeClient,
  type ScreenwriterAgent,
  type VisualDirectorAgent,
  type VisualReviewAgent,
  type VisualReviewMediaPreprocessor,
} from "@video-factory/production-pipeline";
import {
  auditedRoleCandidateAvailability,
  resolveDeepseekModelId,
  type CodexProviderSettings,
} from "./codex-provider-settings.js";

/** 一个 broker 上该角色的来源标识，最终会写进回执，界面上据此显示产出与复核分别来自谁。 */
export type RoleProviderId = "deepseek" | "openai";

export interface RoleAgentAssemblyOptions {
  codexSettings?: CodexProviderSettings;
  deepseekCodexSettings: CodexProviderSettings;
  codexClient?: CodexBridgeClient;
  deepseekCodexClient?: CodexBridgeClient;
  reviewMedia: VisualReviewMediaPreprocessor;
  environment: NodeJS.ProcessEnv;
}

export interface RoleAgentAssembly {
  screenwriterAgent?: ScreenwriterAgent;
  directorAgent?: VisualDirectorAgent;
  visualReviewAgents: VisualReviewAgent[];
  /** 前期构思 producer 候选：先按 broker 顺序，每个 broker 内再按它公告的候选顺序；消费与接管策略由接入方决定。 */
  treatmentAgents: Array<{ agent: CodexCreativeTreatmentAgent; providerId: RoleProviderId }>;
  /** 内容简报的独立复核候选，同样按 broker 顺序展开到模型级；它只审不产，所以没有 producer 侧的接管问题。 */
  briefAuditAgents: Array<{ agent: BriefAuditAgent; providerId: RoleProviderId }>;
}

/**
 * 一个 broker 上该角色可以实际跑到的模型：它自己的默认模型，加上它在 /health 公告的已审核候选表。
 * 默认模型始终在列表里，哪怕候选表还没有它——broker 会把"请求的模型就是我自己"归一化成没有覆盖，
 * 所以这条路径不需要候选表；而候选表里的每个模型都会成为一个真的能把模型送上线路的候选 agent。
 */
function offeredModels(settings: CodexProviderSettings, defaultModelId: string): string[] {
  return [...new Set([defaultModelId, ...(settings.modelCandidates ?? [])].filter((modelId) => modelId.trim()))];
}

type BrokerCandidate<TAgent extends { modelId?: string }> = {
  agent: TAgent;
  providerId: RoleProviderId;
};

/**
 * 同一个角色池里的模型必须两两不同——`validateCandidates` 会拒绝重复，而那道检查在**建图时**执行，
 * 也就是启动即失败。两个 broker 被配成公告同一批模型时重复是真会发生的（配置项就是一张模型 id 列表），
 * 而留着同名的那条毫无意义：它跑的是同一个模型，不是一次兜底。这里保留先出现的那条，顺序即偏好。
 */
function distinctCandidates<TAgent extends { modelId?: string }>(
  candidates: Array<BrokerCandidate<TAgent>>,
): Array<BrokerCandidate<TAgent>> {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const modelId = candidate.agent.modelId?.trim();
    if (!modelId || seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
}

export function buildRoleAgentAssembly(options: RoleAgentAssemblyOptions): RoleAgentAssembly {
  const { codexSettings, deepseekCodexSettings, codexClient, deepseekCodexClient } = options;
  // ChatGPT/Codex 套餐已退役（用户指令 2026-09-18）：codexSettings/codexClient 不再传入，
  // codex 侧候选分支全部自然关闭。provider id（codex-*-v1）作为遗留名保留以兼容历史 run。
  const codexModelFor = (taskKind: string) => codexSettings?.taskModels?.[taskKind] || codexSettings?.modelId || "codex-default";
  const deepseekModelId = deepseekCodexSettings.modelId || resolveDeepseekModelId(options.environment);
  const deepseekModelFor = (taskKind: string) => deepseekCodexSettings.taskModels?.[taskKind] || deepseekModelId;

  // 视审片之外的角色都摊到模型级：一个 broker 上公告了几个可用模型，就有几个候选。首选只是排在最前，
  // 不是唯一；某个模型被限流或下线时，下一个立刻接上，不用等人来改配置重跑。
  //
  // 顺序即默认：每个角色的池子都是 DeepSeek 在前、Codex 在后，所以「首选」是 DeepSeek，除非用户
  // 在制作或单个节点上手动改选了别的模型（那只是把数组重排，不改这里的候选集合）。
  //
  // chat-completions 那条通路上 broker 不持有会话，所以属于它的 agent 一律 stateless。
  const directorAvailability = auditedRoleCandidateAvailability(deepseekCodexSettings, "director-plan");
  const directorCandidates = distinctCandidates<CodexVisualDirectorAgent>([
    ...(deepseekCodexClient && directorAvailability.deepseek
      ? offeredModels(deepseekCodexSettings, deepseekModelFor("director-plan")).map((modelId) => ({
          agent: new CodexVisualDirectorAgent({
            client: deepseekCodexClient,
            modelId,
            sessionMode: "stateless",
          }),
          providerId: "deepseek" as const,
        }))
      : []),
  ]);

  const screenwriterAvailability = auditedRoleCandidateAvailability(deepseekCodexSettings, "script-draft");
  const deepseekScreenwriter = deepseekCodexClient && screenwriterAvailability.deepseek
    ? offeredModels(deepseekCodexSettings, deepseekModelFor("script-draft")).map((modelId) => ({
        agent: new CodexScreenwriterAgent({
          client: deepseekCodexClient,
          modelId,
          sessionMode: "stateless",
        }),
        providerId: "deepseek" as const,
      }))
    : [];
  const screenwriterCandidates = distinctCandidates<ScreenwriterAgent>([...deepseekScreenwriter]);

  const treatmentAvailability = auditedRoleCandidateAvailability(deepseekCodexSettings, "creative-treatment");
  const treatmentAgents = distinctCandidates<CodexCreativeTreatmentAgent>([
    ...(deepseekCodexClient && treatmentAvailability.deepseek
      ? offeredModels(deepseekCodexSettings, deepseekModelFor("creative-treatment")).map((modelId) => ({
          agent: new CodexCreativeTreatmentAgent({
            client: deepseekCodexClient,
            modelId,
            sessionMode: "stateless",
          }),
          providerId: "deepseek" as const,
        }))
      : []),
  ]);

  // 简报复核只跑 role-audit，没有 producer 任务要过，所以可用性只看 role-audit 一项。
  const briefAuditAvailability = auditedRoleCandidateAvailability(deepseekCodexSettings, "role-audit");
  const briefAuditAgents = distinctCandidates<BriefAuditAgent>([
    ...(deepseekCodexClient && briefAuditAvailability.deepseek
      ? offeredModels(deepseekCodexSettings, deepseekModelFor("role-audit")).map((modelId) => ({
          agent: new CodexBriefAuditAgent({
            client: deepseekCodexClient,
            modelId,
          }),
          providerId: "deepseek" as const,
        }))
      : []),
  ]);

  const reviewAvailability = auditedRoleCandidateAvailability(deepseekCodexSettings, "visual-review");
  const deepseekReview = deepseekCodexClient && reviewAvailability.deepseek
    ? new CodexVisualReviewAgent({
        client: deepseekCodexClient,
        media: options.reviewMedia,
        providerId: "deepseek-visual-review-v1",
        modelId: deepseekCodexSettings.taskModels?.["visual-review"] || resolveDeepseekModelId(options.environment),
        producerSessionMode: "stateless",
        maxProducerCalls: 3,
      })
    : undefined;
  // 第二审片腿：原 gpt-5.6-sol（codex broker）已随 ChatGPT 套餐退役，改为 deepseek-v4-pro
  //（同一 broker 的另一模型，非同一模型双跑）。providerId 保留遗留名以兼容已暂停 run 的
  // checkpoint 恢复；界面展示的是真实 modelId。


  return {
    ...(screenwriterCandidates.length > 0 ? {
      screenwriterAgent: new FallbackScreenwriterAgent({ candidates: screenwriterCandidates }),
    } : {}),
    ...(directorCandidates.length > 0 ? {
      directorAgent: new FallbackVisualDirectorAgent({ candidates: directorCandidates }),
    } : {}),
    // 双模型审片随 ChatGPT/Codex 套餐一并退役：只剩 DeepSeek 单腿复核（用户指令 2026-09-18）。
    visualReviewAgents: orderedVisualReviewAgents(deepseekReview, undefined, options.reviewMedia),
    treatmentAgents,
    briefAuditAgents,
  };
}

/**
 * 双审的两个分支必须来自两个真正不同的模型，这是「正式制作需要两个独立审片人」那条治理契约的编码。
 * 两个分支互为对方的主用，所以哪个排在前只决定没指定 providerId 时的默认选择，不改变任何一个分支的
 * 判据；这里把 DeepSeek 排在前，与候选链的首选顺序一致。
 */
function orderedVisualReviewAgents(
  deepseek: CodexVisualReviewAgent | undefined,
  codex: CodexVisualReviewAgent | undefined,
  media: VisualReviewMediaPreprocessor,
): VisualReviewAgent[] {
  if (deepseek && codex) {
    const deepseekWithSourceFallback = new FallbackVisualReviewAgent({
      primary: deepseek,
      primaryProviderId: "deepseek",
      backups: [{ agent: codex, label: "Codex 视觉审片", providerId: "openai" }],
    });
    const codexWithSourceFallback = new FallbackVisualReviewAgent({
      primary: codex,
      primaryProviderId: "openai",
      backups: [{ agent: deepseek, label: "DeepSeek 视觉审片", providerId: "deepseek" }],
    });
    return [
      new IndependentDualVisualReviewAgent({
        primary: deepseek,
        secondary: codex,
        sourceAgent: deepseekWithSourceFallback,
        media,
      }),
      new IndependentDualVisualReviewAgent({
        primary: codex,
        secondary: deepseek,
        sourceAgent: codexWithSourceFallback,
        media,
      }),
    ];
  }
  return deepseek ? [deepseek] : codex ? [codex] : [];
}
