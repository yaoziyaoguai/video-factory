import {
  CodexBridgeClient,
  requestOptionsForDeadline,
  type CodexPreparedOperation,
  type CodexTaskExecution,
} from "./codex-chat.js";
import {
  parseCreativeDiscussionResult,
  type CreativeDiscussionResult,
  type CreativeDiscussionSelection,
  type CreativeStage,
} from "./creative-review.js";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export interface CreativeDiscussionAgentInput {
  stage: CreativeStage;
  requestMode?: "discuss" | "revise";
  currentDocument: unknown;
  context: Record<string, unknown>;
  message: string;
  selection?: CreativeDiscussionSelection;
  recentMessages: Array<{ role: "user" | "assistant"; text: string }>;
  selectedModelId?: string;
  requestId: string;
  preparedOperation?: CodexPreparedOperation;
  /**
   * C1（收尾包）：提交前捕获实际 prepared 快照（含真实模型绑定与序列化信封）。
   * 捕获回调抛错＝零外部提交；恢复路径只观察已保存的 prepared，不再提交。
   */
  beforeSubmit?: (operation: CodexPreparedOperation) => Promise<void>;
  wallClockDeadlineAtMs?: number;
  // 与候选路由的通用接口兼容；讨论本身不使用角色 loop checkpoint。
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
}

export interface CreativeDiscussionAgent {
  id: string;
  modelId?: string;
  discussDetailed(input: CreativeDiscussionAgentInput): Promise<CodexTaskExecution<CreativeDiscussionResult>>;
}

export async function runCreativeDiscussionTask(
  client: Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared">,
  input: CreativeDiscussionAgentInput,
): Promise<CodexTaskExecution<CreativeDiscussionResult>> {
  const requestOptions = { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs) };
  const execution = input.preparedOperation
    ? await client.observePrepared(input.preparedOperation, requestOptions)
    : await client.runTaskDetailed("creative-discussion", {
      stage: input.stage,
      ...(input.requestMode ? { requestMode: input.requestMode } : {}),
      currentDocument: input.currentDocument,
      context: input.context,
      message: input.message,
      ...(input.selection ? { selection: input.selection } : {}),
      recentMessages: input.recentMessages,
    }, input.requestId, undefined, {
      ...requestOptions,
      // C1：实际 prepared（含模型绑定）在提交前交给宿主耐久保存；保存失败即中止提交。
      ...(input.beforeSubmit ? { beforeSubmit: input.beforeSubmit } : {}),
    });
  return { ...execution, output: parseCreativeDiscussionResult(execution.output) };
}
