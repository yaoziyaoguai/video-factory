import {
  CodexExecutor,
  type BrokerTaskExecutor,
} from "./codex-executor.js";
import type { BrokerRuntimeConfig } from "./runtime-config.js";
import { ZaiVisualReviewExecutor } from "./zai-visual-review-executor.js";

export interface BrokerExecutorDependencies {
  fetchFn?: typeof fetch;
}

export function createBrokerExecutor(
  config: BrokerRuntimeConfig,
  environment: NodeJS.ProcessEnv,
  dependencies: BrokerExecutorDependencies = {},
): BrokerTaskExecutor {
  if (config.profile.identity.profileId === "zai") {
    return new ZaiVisualReviewExecutor({
      env: environment,
      effort: config.effort,
      timeoutMs: config.timeoutMs,
      ...(dependencies.fetchFn ? { fetchFn: dependencies.fetchFn } : {}),
    });
  }
  return new CodexExecutor({
    workspaceRoot: config.workspaceRoot,
    codexBin: config.codexBin,
    profile: config.profile,
    effort: config.effort,
    auditEffort: config.auditEffort,
    timeoutMs: config.timeoutMs,
  });
}
