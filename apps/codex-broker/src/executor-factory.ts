import {
  CodexExecutor,
  type BrokerTaskExecutor,
} from "./codex-executor.js";
import type { BrokerRuntimeConfig } from "./runtime-config.js";
import { ChatCompletionsExecutor, DEEPSEEK_CHAT_COMPLETIONS_PROVIDER } from "./chat-completions-executor.js";

export interface BrokerExecutorDependencies {
  fetchFn?: typeof fetch;
}

export function createBrokerExecutor(
  config: BrokerRuntimeConfig,
  environment: NodeJS.ProcessEnv,
  dependencies: BrokerExecutorDependencies = {},
): BrokerTaskExecutor {
  const profileId = config.profile.identity.profileId;
  if (profileId === "deepseek") {
    return new ChatCompletionsExecutor({
      env: environment,
      effort: config.effort,
      auditEffort: config.auditEffort,
      provider: DEEPSEEK_CHAT_COMPLETIONS_PROVIDER,
      // 同一个供应商下的其他已审核模型（例如 deepseek-v4-pro）也进候选表，用户才能在界面里换。
      extraModelCandidates: config.modelCandidates,
      timeoutMs: config.timeoutMs,
      ...(dependencies.fetchFn ? { fetchFn: dependencies.fetchFn } : {}),
    });
  }
  return new CodexExecutor({
    workspaceRoot: config.workspaceRoot,
    codexBin: config.codexBin,
    profile: config.profile,
    effort: config.effort,
    ...(config.auditModel ? { auditModel: config.auditModel } : {}),
    auditEffort: config.auditEffort,
    modelCandidates: config.modelCandidates,
    timeoutMs: config.timeoutMs,
  });
}
