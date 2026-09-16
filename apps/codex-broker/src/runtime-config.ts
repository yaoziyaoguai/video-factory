import {
  ALLOWED_REASONING_EFFORTS,
  codexExecutorProfileFor,
  isReviewableModelId,
  type CodexExecutorProfile,
  type CodexExecutorProfileId,
} from "./codex-executor.js";
import { GLM_REASONING_EFFORTS } from "./zai-code-plan-executor.js";

const DEFAULT_PRODUCTION_MODEL = "gpt-5.6-sol";
const DEFAULT_DEEP_REVIEW_MODEL = "gpt-5.6-sol";
/**
 * zai 的独立复核默认 high 而不是 xhigh：glm-5.3 只有 low|high|max 三档，xhigh 在这里不是
 * "降级"而是让请求失败。复核读的是已经成型的产出，中间档就够；实测 max 档一次复核约 4 分钟。
 */
const DEFAULT_ZAI_AUDIT_EFFORT = "high";

export interface BrokerRuntimeConfig {
  profile: CodexExecutorProfile;
  socketPath: string;
  workspaceRoot: string;
  codexBin: string;
  effort: string;
  auditModel?: string;
  auditEffort: string;
  modelCandidates: string[];
  timeoutMs: number;
  concurrency: number;
  maxBacklog: number;
}

export function brokerRuntimeConfigFromEnv(env: NodeJS.ProcessEnv): BrokerRuntimeConfig {
  const profileId = readProfileId(env);
  const configuredModel = optionalText(env, "VIDEO_FACTORY_CODEX_MODEL")
    ?? (profileId === "openai" ? DEFAULT_PRODUCTION_MODEL : undefined);
  const configuredAuditModel = optionalText(env, "VIDEO_FACTORY_CODEX_AUDIT_MODEL")
    ?? (profileId === "openai" ? DEFAULT_DEEP_REVIEW_MODEL : undefined);
  const configuredZaiModel = optionalText(env, "ZAI_TEXT_MODEL_ID");
  if (profileId === "zai" && configuredModel !== undefined) {
    throw new Error("VIDEO_FACTORY_CODEX_MODEL cannot override the zai profile model.");
  }
  if (profileId === "zai" && optionalText(env, "VIDEO_FACTORY_CODEX_AUDIT_MODEL") !== undefined) {
    throw new Error("VIDEO_FACTORY_CODEX_AUDIT_MODEL cannot override the zai profile model.");
  }
  if (profileId === "zai" && optionalText(env, "ZAI_BIGMODEL_API_KEY") === undefined) {
    throw new Error("ZAI_BIGMODEL_API_KEY environment variable is required for the zai profile.");
  }
  const effort = optionalText(env, "VIDEO_FACTORY_CODEX_EFFORT") ?? (profileId === "zai" ? "max" : "xhigh");
  if (!ALLOWED_REASONING_EFFORTS.has(effort)) {
    throw new Error("VIDEO_FACTORY_CODEX_EFFORT must be one of low|medium|high|xhigh|max.");
  }
  const auditEffort = optionalText(env, "VIDEO_FACTORY_CODEX_AUDIT_EFFORT")
    ?? (profileId === "zai" ? DEFAULT_ZAI_AUDIT_EFFORT : "xhigh");
  if (!ALLOWED_REASONING_EFFORTS.has(auditEffort)) {
    throw new Error("VIDEO_FACTORY_CODEX_AUDIT_EFFORT must be one of low|medium|high|xhigh|max.");
  }
  if (profileId === "zai" && !GLM_REASONING_EFFORTS.has(auditEffort)) {
    throw new Error("VIDEO_FACTORY_CODEX_AUDIT_EFFORT must be one of low|high|max for the zai profile.");
  }

  return {
    profile: codexExecutorProfileFor(profileId, configuredModel, configuredZaiModel),
    socketPath: optionalText(env, "VIDEO_FACTORY_CODEX_SOCKET_PATH") ?? defaultSocketPath(profileId),
    workspaceRoot: optionalText(env, "VIDEO_FACTORY_CODEX_WORKSPACE_ROOT") ?? defaultWorkspaceRoot(profileId),
    codexBin: optionalText(env, "CODEX_BIN") ?? "codex",
    effort,
    ...(configuredAuditModel ? { auditModel: configuredAuditModel } : {}),
    auditEffort,
    modelCandidates: readModelCandidates(env),
    // 600s 仍可能掐断 xhigh/max 级强推理候选；默认放宽到 20 分钟，与 ZAI 生产 unit 的 1200000ms 对齐。
    timeoutMs: readInteger(env, "VIDEO_FACTORY_CODEX_TIMEOUT_MS", 1_200_000, 1_000, 3_600_000),
    concurrency: readInteger(env, "VIDEO_FACTORY_CODEX_CONCURRENCY", 1, 1, 8),
    maxBacklog: readInteger(env, "VIDEO_FACTORY_CODEX_MAX_BACKLOG", 1, 1, 1_000),
  };
}

/**
 * 上层可以按任务覆盖模型，但只能覆盖到这张已审核候选表内的模型。留空即不允许任何覆盖，
 * 这是安全默认：请求方不应能凭空引入一个未审核、计费未知的模型。
 */
function readModelCandidates(env: NodeJS.ProcessEnv): string[] {
  const raw = optionalText(env, "VIDEO_FACTORY_CODEX_MODEL_CANDIDATES");
  if (raw === undefined) return [];
  const candidates = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (!isReviewableModelId(candidate)) {
      throw new Error(`VIDEO_FACTORY_CODEX_MODEL_CANDIDATES contains an invalid model id: '${candidate}'.`);
    }
  }
  return candidates;
}

function readProfileId(env: NodeJS.ProcessEnv): CodexExecutorProfileId {
  const value = optionalText(env, "VIDEO_FACTORY_CODEX_PROFILE") ?? "openai";
  if (value !== "openai" && value !== "zai") {
    throw new Error("VIDEO_FACTORY_CODEX_PROFILE must be openai or zai.");
  }
  return value;
}

function defaultSocketPath(profileId: CodexExecutorProfileId): string {
  return profileId === "zai"
    ? "/run/video-factory-zai-codex/worker.sock"
    : "/run/video-factory-codex/worker.sock";
}

function defaultWorkspaceRoot(profileId: CodexExecutorProfileId): string {
  return profileId === "zai"
    ? "/var/lib/video-factory-zai-codex/workspace"
    : "/home/vf-codex/.local/state/video-factory/tasks";
}

function optionalText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
