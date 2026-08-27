import {
  codexExecutorProfileFor,
  type CodexExecutorProfile,
  type CodexExecutorProfileId,
} from "./codex-executor.js";

const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface BrokerRuntimeConfig {
  profile: CodexExecutorProfile;
  socketPath: string;
  workspaceRoot: string;
  codexBin: string;
  effort: string;
  timeoutMs: number;
  concurrency: number;
  maxBacklog: number;
}

export function brokerRuntimeConfigFromEnv(env: NodeJS.ProcessEnv): BrokerRuntimeConfig {
  const profileId = readProfileId(env);
  const configuredModel = optionalText(env, "VIDEO_FACTORY_CODEX_MODEL");
  if (profileId === "zai" && configuredModel !== undefined) {
    throw new Error("VIDEO_FACTORY_CODEX_MODEL cannot override the zai profile model.");
  }
  if (profileId === "zai" && optionalText(env, "ZAI_API_KEY") === undefined) {
    throw new Error("ZAI_API_KEY environment variable is required for the zai profile.");
  }
  const effort = optionalText(env, "VIDEO_FACTORY_CODEX_EFFORT") ?? "high";
  if (!ALLOWED_EFFORTS.has(effort)) {
    throw new Error("VIDEO_FACTORY_CODEX_EFFORT must be one of low|medium|high|xhigh|max.");
  }

  return {
    profile: codexExecutorProfileFor(
      profileId,
      configuredModel,
      optionalText(env, "VIDEO_FACTORY_CODEX_MODEL_CATALOG_PATH"),
    ),
    socketPath: optionalText(env, "VIDEO_FACTORY_CODEX_SOCKET_PATH") ?? defaultSocketPath(profileId),
    workspaceRoot: optionalText(env, "VIDEO_FACTORY_CODEX_WORKSPACE_ROOT") ?? defaultWorkspaceRoot(profileId),
    codexBin: optionalText(env, "CODEX_BIN") ?? "codex",
    effort,
    timeoutMs: readInteger(env, "VIDEO_FACTORY_CODEX_TIMEOUT_MS", 300_000, 1_000, 3_600_000),
    concurrency: readInteger(env, "VIDEO_FACTORY_CODEX_CONCURRENCY", 1, 1, 8),
    maxBacklog: readInteger(env, "VIDEO_FACTORY_CODEX_MAX_BACKLOG", 20, 1, 1_000),
  };
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
