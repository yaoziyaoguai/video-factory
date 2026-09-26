import { CodexBridgeError, type CodexBridgeClient, type CodexPreparedOperation, type CodexTaskExecution, type CodexTaskKind } from "./codex-chat.js";

/** 单次文字操作不借用产审循环；宿主先留存请求，再接收可重放结果。 */
export interface DocumentTaskContext {
  requestId: string;
  prepared?: CodexPreparedOperation;
  execution?: CodexTaskExecution;
  beforeSubmit(operation: CodexPreparedOperation): Promise<void>;
  onCompleted(execution: CodexTaskExecution): Promise<void>;
  onValidated?: () => Promise<void>;
  onInvalid?: () => Promise<void>;
  beforeApply?(resultSha256: string): Promise<void>;
  waitTimeoutMs?: number;
}

export async function validateDocumentResult<T>(context: DocumentTaskContext | undefined, validate: () => T): Promise<T> {
  let value: T;
  try { value = validate(); }
  catch (error) { await context?.onInvalid?.(); throw error; }
  await context?.onValidated?.();
  return value;
}

type DocumentTaskClient = Pick<CodexBridgeClient, "runTask">
  & Partial<Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared" | "submitPreparedIfUnaccepted">>;

export async function runDocumentTask(
  client: DocumentTaskClient,
  kind: CodexTaskKind,
  payload: () => Promise<unknown>,
  context?: DocumentTaskContext,
  model?: string,
): Promise<unknown> {
  if (!context) return client.runTask(kind, await payload(), undefined, model ? { model } : {});
  if (context.execution) return context.execution.output;
  if (!client.runTaskDetailed || !client.observePrepared) {
    throw new Error("Document commands require durable model execution and recovery support.");
  }
  if (context.prepared && (context.prepared.kind !== kind || context.prepared.requestId !== context.requestId)) {
    throw new Error("The saved document request does not match this command.");
  }
  // 受理不明时只观察原请求；不重新抽帧、改写信封或切换模型。
  const prepared = context.prepared;
  const execution = prepared
    ? await client.observePrepared(prepared, context.waitTimeoutMs ? { timeoutMs: context.waitTimeoutMs } : {}).catch((error: unknown) => {
      if (error instanceof CodexBridgeError && error.stage === "not_accepted" && client.submitPreparedIfUnaccepted) {
        return client.submitPreparedIfUnaccepted(prepared, context.waitTimeoutMs ? { timeoutMs: context.waitTimeoutMs } : {});
      }
      throw error;
    })
    : await client.runTaskDetailed(kind, await payload(), context.requestId, undefined, {
      beforeSubmit: context.beforeSubmit,
      ...(context.waitTimeoutMs ? { timeoutMs: context.waitTimeoutMs } : {}),
      ...(model ? { model } : {}),
    });
  // 结构校验或版本落盘失败也不得丢失已完成结果，恢复时不能再次付费。
  await context.onCompleted(execution);
  return execution.output;
}

export async function observeDocumentTask(client: DocumentTaskClient, context: DocumentTaskContext): Promise<void> {
  if (context.execution) return;
  if (!context.prepared || !client.observePrepared) throw new Error("No recoverable document request is available.");
  await context.onCompleted(await client.observePrepared(context.prepared, context.waitTimeoutMs ? { timeoutMs: context.waitTimeoutMs } : {}));
}
