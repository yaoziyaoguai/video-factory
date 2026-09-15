import {
  CodexCreativeTreatmentAgent,
  CodexScreenwriterAgent,
  CodexVisualDirectorAgent,
  CodexVisualReviewAgent,
  FallbackScreenwriterAgent,
  FallbackVisualDirectorAgent,
  FallbackVisualReviewAgent,
  IndependentDualVisualReviewAgent,
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
  /** 前期构思 producer 候选按 broker 顺序排列；构思进入正式生产图时的消费与接管策略由接入方决定。 */
  treatmentAgents: Array<{ agent: CodexCreativeTreatmentAgent; providerId: "openai" | "zai-bigmodel-api" }>;
}

/**
 * 一个 broker 上该角色可以实际跑到的模型：它自己的默认模型，加上它在 /health 公告的已审核候选表。
 * 默认模型始终在列表里，哪怕候选表还没有它——broker 会把"请求的模型就是我自己"归一化成没有覆盖，
 * 所以这条路径不需要候选表；而候选表里的每个模型都会成为一个真的能把模型送上线路的候选 agent。
 */
function offeredModels(settings: CodexProviderSettings, defaultModelId: string): string[] {
  return [...new Set([defaultModelId, ...(settings.modelCandidates ?? [])].filter((modelId) => modelId.trim()))];
}

export function buildRoleAgentAssembly(options: RoleAgentAssemblyOptions): RoleAgentAssembly {
  const { codexSettings, zaiCodexSettings, codexClient, zaiCodexClient } = options;
  const codexModelId = codexSettings.modelId || options.environment.VIDEO_FACTORY_CODEX_MODEL?.trim() || "codex-default";
  const codexModelFor = (taskKind: string) => codexSettings.taskModels?.[taskKind] || codexModelId;
  const zaiTextModelId = zaiCodexSettings.modelId || resolveZaiTextModelId(options.environment);
  const zaiModelFor = (taskKind: string) => zaiCodexSettings.taskModels?.[taskKind] || zaiTextModelId;

  const directorAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "director-plan");
  const codexDirector = codexClient && directorAvailability.codex
    ? new CodexVisualDirectorAgent({
        client: codexClient,
        modelId: codexModelFor("director-plan"),
        sessionMode: "stateless",
      })
    : undefined;
  const glmDirector = zaiCodexClient && directorAvailability.zai
    ? new CodexVisualDirectorAgent({
        client: zaiCodexClient,
        auditClient: zaiCodexClient,
        modelId: zaiModelFor("director-plan"),
        sessionMode: "stateless",
      })
    : undefined;
  const directorCandidates = [codexDirector, glmDirector]
    .filter((agent): agent is CodexVisualDirectorAgent => Boolean(agent));

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
  const screenwriterCandidates = [...codexScreenwriter, ...glmScreenwriter];

  const treatmentAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "creative-treatment");
  const codexTreatment = codexClient && treatmentAvailability.codex
    ? new CodexCreativeTreatmentAgent({
        client: codexClient,
        modelId: codexModelFor("creative-treatment"),
        sessionMode: "stateless",
      })
    : undefined;
  const glmTreatment = zaiCodexClient && treatmentAvailability.zai
    ? new CodexCreativeTreatmentAgent({
        client: zaiCodexClient,
        auditClient: zaiCodexClient,
        modelId: zaiModelFor("creative-treatment"),
        sessionMode: "stateless",
      })
    : undefined;
  const treatmentAgents = [codexTreatment, glmTreatment]
    .filter((agent): agent is CodexCreativeTreatmentAgent => Boolean(agent))
    .map((agent) => ({
      agent,
      providerId: (agent === codexTreatment ? "openai" : "zai-bigmodel-api") as "openai" | "zai-bigmodel-api",
    }));

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
      directorAgent: new FallbackVisualDirectorAgent({
        candidates: directorCandidates.map((agent) => ({
          agent,
          providerId: agent === codexDirector ? "openai" : "zai-bigmodel-api",
        })),
      }),
    } : {}),
    visualReviewAgents: orderedVisualReviewAgents(codexReview, glmReview, options.reviewMedia),
    treatmentAgents,
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
