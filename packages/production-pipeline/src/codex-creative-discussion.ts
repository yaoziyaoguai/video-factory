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
  currentDocument: unknown;
  context: Record<string, unknown>;
  message: string;
  selection?: CreativeDiscussionSelection;
  recentMessages: Array<{ role: "user" | "assistant"; text: string }>;
  selectedModelId?: string;
  requestId: string;
  preparedOperation?: CodexPreparedOperation;
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
  const requestOptions = requestOptionsForDeadline(input.wallClockDeadlineAtMs);
  const execution = input.preparedOperation
    ? await client.observePrepared(input.preparedOperation, requestOptions)
    : await client.runTaskDetailed("creative-discussion", {
      stage: input.stage,
      currentDocument: input.currentDocument,
      context: input.context,
      message: input.message,
      ...(input.selection ? { selection: input.selection } : {}),
      recentMessages: input.recentMessages,
    }, input.requestId, undefined, requestOptions);
  return { ...execution, output: parseCreativeDiscussionResult(execution.output) };
}
