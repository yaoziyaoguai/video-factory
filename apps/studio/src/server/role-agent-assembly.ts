import {
  CodexScreenwriterAgent,
  CodexVisualDirectorAgent,
  CodexVisualReviewAgent,
  FallbackScreenwriterAgent,
  FallbackVisualDirectorAgent,
  FallbackVisualReviewAgent,
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
}

export function buildRoleAgentAssembly(options: RoleAgentAssemblyOptions): RoleAgentAssembly {
  const { codexSettings, zaiCodexSettings, codexClient, zaiCodexClient } = options;
  const codexModelId = codexSettings.modelId || options.environment.VIDEO_FACTORY_CODEX_MODEL?.trim() || "codex-default";
  const codexModelFor = (taskKind: string) => codexSettings.taskModels?.[taskKind] || codexModelId;
  const zaiTextModelId = zaiCodexSettings.modelId || resolveZaiTextModelId(options.environment);
  const zaiModelFor = (taskKind: string) => zaiCodexSettings.taskModels?.[taskKind] || zaiTextModelId;

  const directorAvailability = auditedRoleCandidateAvailability(codexSettings, zaiCodexSettings, "director-plan");
  const codexDirector = codexClient && directorAvailability.codex
    ? new CodexVisualDirectorAgent({ client: codexClient, modelId: codexModelFor("director-plan") })
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
    ? new CodexScreenwriterAgent({ client: codexClient, modelId: codexModelFor("script-draft") })
    : undefined;
  const glmScreenwriter = zaiCodexClient && screenwriterAvailability.zai
    ? new CodexScreenwriterAgent({
        client: zaiCodexClient,
        auditClient: zaiCodexClient,
        modelId: zaiModelFor("script-draft"),
        sessionMode: "stateless",
      })
    : undefined;
  const screenwriterCandidates = [codexScreenwriter, glmScreenwriter]
    .filter((agent): agent is CodexScreenwriterAgent => Boolean(agent));

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
      screenwriterAgent: new FallbackScreenwriterAgent({
        candidates: screenwriterCandidates.map((agent) => ({
          agent,
          providerId: agent === codexScreenwriter ? "openai" : "zai-bigmodel-api",
        })),
      }),
    } : {}),
    ...(directorCandidates.length > 0 ? {
      directorAgent: new FallbackVisualDirectorAgent({
        candidates: directorCandidates.map((agent) => ({
          agent,
          providerId: agent === codexDirector ? "openai" : "zai-bigmodel-api",
        })),
      }),
    } : {}),
    visualReviewAgents: orderedVisualReviewAgents(codexReview, glmReview),
  };
}

function orderedVisualReviewAgents(
  codex: CodexVisualReviewAgent | undefined,
  glm: CodexVisualReviewAgent | undefined,
): VisualReviewAgent[] {
  if (codex && glm) {
    return [
      new FallbackVisualReviewAgent({
        primary: glm,
        primaryProviderId: "zai-bigmodel-api",
        backups: [{ agent: codex, label: "Codex 视觉审片", providerId: "openai" }],
      }),
      new FallbackVisualReviewAgent({
        primary: codex,
        primaryProviderId: "openai",
        backups: [{ agent: glm, label: "GLM 视觉审片", providerId: "zai-bigmodel-api" }],
      }),
    ];
  }
  return glm ? [glm] : codex ? [codex] : [];
}
