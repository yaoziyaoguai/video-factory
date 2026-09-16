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
  resolveZaiTextModelId,
  resolveZaiVisualReviewModelId,
  type CodexProviderSettings,
} from "./codex-provider-settings.js";

export interface RoleAgentAssemblyOptions {
  codexSettings: CodexProviderSettings;
  zaiCodexSettings: CodexProviderSettings;
  codexClient?: CodexBridgeClient;
  zaiCodexClient?: CodexBridgeClient;
  reviewMedia: VisualReviewMediaPreprocessor;
  environment: NodeJS.ProcessEnv;
}

export interface RoleAgentAssembly {
  screenwriterAgent?: ScreenwriterAgent;
  directorAgent?: VisualDirectorAgent;
  visualReviewAgents: VisualReviewAgent[];
  /** 前期构思 producer 候选：先按 broker 顺序，每个 broker 内再按它公告的候选顺序；消费与接管策略由接入方决定。 */
  treatmentAgents: Array<{ agent: CodexCreativeTreatmentAgent; providerId: "openai" | "zai-bigmodel-api" }>;
  /** 内容简报的独立复核候选，同样按 broker 顺序展开到模型级；它只审不产，所以没有 producer 侧的接管问题。 */
  briefAuditAgents: Array<{ agent: BriefAuditAgent; providerId: "openai" | "zai-bigmodel-api" }>;
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
  providerId: "openai" | "zai-bigmodel-api";
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
  const { codexSettings, zaiCodexSettings, codexClient, zaiCodexClient } = options;
  const codexModelId = codexSettings.modelId || options.environment.VIDEO_FACTORY_CODEX_MODEL?.trim() || "codex-default";
  const codexModelFor = (taskKind: string) => codexSettings.taskModels?.[taskKind] || codexModelId;
  const zaiTextModelId = zaiCodexSettings.modelId || resolveZaiTextModelId(options.environment);
  const zaiModelFor = (taskKind: string) => zaiCodexSettings.taskModels?.[taskKind] || zaiTextModelId;

  // 视审片之外的角色都摊到模型级：一个 broker 上公告了几个可用模型，就有几个候选。首选只是排在最前，
  // 不是唯一；某个模型被限流或下线时，下一个立刻接上，不用等人来改配置重跑。
  const directorAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "director-plan");
  const directorCandidates = distinctCandidates<CodexVisualDirectorAgent>([
    ...(codexClient && directorAvailability.codex
      ? offeredModels(codexSettings, codexModelFor("director-plan")).map((modelId) => ({
          agent: new CodexVisualDirectorAgent({
            client: codexClient,
            modelId,
            sessionMode: "stateless",
          }),
          providerId: "openai" as const,
        }))
      : []),
    ...(zaiCodexClient && directorAvailability.zai
      ? offeredModels(zaiCodexSettings, zaiModelFor("director-plan")).map((modelId) => ({
          agent: new CodexVisualDirectorAgent({
            client: zaiCodexClient,
            auditClient: zaiCodexClient,
            modelId,
            sessionMode: "stateless",
          }),
          providerId: "zai-bigmodel-api" as const,
        }))
      : []),
  ]);

  const screenwriterAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "script-draft");
  const codexScreenwriter = codexClient && screenwriterAvailability.codex
    ? offeredModels(codexSettings, codexModelFor("script-draft")).map((modelId) => ({
        agent: new CodexScreenwriterAgent({
          client: codexClient,
          modelId,
          sessionMode: "stateless",
        }),
        providerId: "openai" as const,
      }))
    : [];
  const glmScreenwriter = zaiCodexClient && screenwriterAvailability.zai
    ? offeredModels(zaiCodexSettings, zaiModelFor("script-draft")).map((modelId) => ({
        agent: new CodexScreenwriterAgent({
          client: zaiCodexClient,
          auditClient: zaiCodexClient,
          modelId,
          sessionMode: "stateless",
        }),
        providerId: "zai-bigmodel-api" as const,
      }))
    : [];
  const screenwriterCandidates = distinctCandidates<ScreenwriterAgent>([...codexScreenwriter, ...glmScreenwriter]);

  const treatmentAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "creative-treatment");
  const treatmentAgents = distinctCandidates<CodexCreativeTreatmentAgent>([
    ...(codexClient && treatmentAvailability.codex
      ? offeredModels(codexSettings, codexModelFor("creative-treatment")).map((modelId) => ({
          agent: new CodexCreativeTreatmentAgent({
            client: codexClient,
            modelId,
            sessionMode: "stateless",
          }),
          providerId: "openai" as const,
        }))
      : []),
    ...(zaiCodexClient && treatmentAvailability.zai
      ? offeredModels(zaiCodexSettings, zaiModelFor("creative-treatment")).map((modelId) => ({
          agent: new CodexCreativeTreatmentAgent({
            client: zaiCodexClient,
            auditClient: zaiCodexClient,
            modelId,
            sessionMode: "stateless",
          }),
          providerId: "zai-bigmodel-api" as const,
        }))
      : []),
  ]);

  // 简报复核只跑 role-audit，没有 producer 任务要过，所以可用性只看 role-audit 一项。
  const briefAuditAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "role-audit");
  const briefAuditAgents = distinctCandidates<BriefAuditAgent>([
    ...(codexClient && briefAuditAvailability.codex
      ? offeredModels(codexSettings, codexModelFor("role-audit")).map((modelId) => ({
          agent: new CodexBriefAuditAgent({
            client: codexClient,
            modelId,
          }),
          providerId: "openai" as const,
        }))
      : []),
    ...(zaiCodexClient && briefAuditAvailability.zai
      ? offeredModels(zaiCodexSettings, zaiModelFor("role-audit")).map((modelId) => ({
          agent: new CodexBriefAuditAgent({
            client: zaiCodexClient,
            modelId,
          }),
          providerId: "zai-bigmodel-api" as const,
        }))
      : []),
  ]);

  const reviewAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "visual-review");
  const codexReview = codexClient && reviewAvailability.codex
    ? new CodexVisualReviewAgent({
        client: codexClient,
        media: options.reviewMedia,
        providerId: "codex-visual-review-v1",
        modelId: codexModelFor("visual-review"),
      })
    : undefined;
  const glmReview = zaiCodexClient && reviewAvailability.zai
    ? new CodexVisualReviewAgent({
        client: zaiCodexClient,
        auditClient: zaiCodexClient,
        media: options.reviewMedia,
        providerId: "glm-visual-review-v1",
        modelId: zaiCodexSettings.taskModels?.["visual-review"] || resolveZaiVisualReviewModelId(options.environment),
        producerSessionMode: "stateless",
        maxProducerCalls: 3,
      })
    : undefined;

  return {
    ...(screenwriterCandidates.length > 0 ? {
      screenwriterAgent: new FallbackScreenwriterAgent({ candidates: screenwriterCandidates }),
    } : {}),
    ...(directorCandidates.length > 0 ? {
      directorAgent: new FallbackVisualDirectorAgent({ candidates: directorCandidates }),
    } : {}),
    visualReviewAgents: orderedVisualReviewAgents(codexReview, glmReview, options.reviewMedia),
    treatmentAgents,
    briefAuditAgents,
  };
}

function orderedVisualReviewAgents(
  codex: CodexVisualReviewAgent | undefined,
  glm: CodexVisualReviewAgent | undefined,
  media: VisualReviewMediaPreprocessor,
): VisualReviewAgent[] {
  if (codex && glm) {
    const glmWithSourceFallback = new FallbackVisualReviewAgent({
      primary: glm,
      primaryProviderId: "zai-bigmodel-api",
      backups: [{ agent: codex, label: "Codex 视觉审片", providerId: "openai" }],
    });
    const codexWithSourceFallback = new FallbackVisualReviewAgent({
      primary: codex,
      primaryProviderId: "openai",
      backups: [{ agent: glm, label: "GLM 视觉审片", providerId: "zai-bigmodel-api" }],
    });
    return [
      new IndependentDualVisualReviewAgent({
        primary: glm,
        secondary: codex,
        sourceAgent: glmWithSourceFallback,
        media,
      }),
      new IndependentDualVisualReviewAgent({
        primary: codex,
        secondary: glm,
        sourceAgent: codexWithSourceFallback,
        media,
      }),
    ];
  }
  return glm ? [glm] : codex ? [codex] : [];
}
