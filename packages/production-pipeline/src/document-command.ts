import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { CodexBridgeError, type CodexPreparedOperation, type CodexTaskExecution, type ModelProviderFailureDetails } from "./codex-chat.js";
import type { DocumentTaskContext } from "./document-task.js";
import type { NodeExecutionReceipt } from "@video-factory/workflow-core";

export type DocumentExecutionReceipt = Omit<NodeExecutionReceipt, "status" | "billing" | "finishedAt"> & {
  status: "succeeded" | "failed" | "unknown"; billing: "unverified"; finishedAt?: string;
};

export class DocumentCommandConflictError extends Error {
  constructor(message: string) { super(message); this.name = "DocumentCommandConflictError"; }
}

export class DocumentCommandPendingError extends CodexBridgeError {
  constructor(readonly commandId: string, cause: CodexBridgeError) {
    super(cause.message, false, "uncertain", cause.statusCode, cause.failureKind, cause.failureDetails);
  }
}

export async function assertNoPendingDocumentCommands(runRoot: string, allowedCommandId?: string): Promise<void> {
  for (const nodeId of ["reference-grammar", "publish-package"]) {
    const records = await new DocumentCommandStore(runRoot, nodeId).list();
    if (records.some((record) => ["created", "pending", "completed"].includes(record.state)
      && record.commandId !== allowedCommandId)) {
      throw new DocumentCommandConflictError("还有文字操作的结果尚未取回或写入，请先在原节点恢复，暂不推进或开始新的费用。");
    }
  }
}

export interface DocumentCommandRecord {
  version: "video-factory/document-command-v1";
  commandId: string;
  requestDigest: string;
  action: "revise" | "audit";
  actor: string;
  input: { expectedRunRevision: number; expectedVersionId: string; instruction?: string; confirmTerminalEdit?: boolean };
  state: "created" | "pending" | "completed" | "applied" | "failed" | "stale" | "unchanged" | "invalid";
  createdAt: string;
  updatedAt: string;
  /** 首次核实模型终态的时间；重复查询和本地采用不能延长它。 */
  completedAt?: string;
  prepared?: CodexPreparedOperation;
  execution?: CodexTaskExecution;
  validated?: boolean;
  resultSha256?: string;
  priorRequests?: Array<{ requestId: string; providerId: string; modelId: string }>;
  failureDetails?: ModelProviderFailureDetails;
  source?: { artifactId: string; sha256: string; contextDigest: string; selectedModelId?: string };
  error?: { message: string; stage?: string };
}

export class DocumentCommandStore {
  readonly directory: string;

  constructor(runRoot: string, nodeId: string) {
    if (nodeId !== "reference-grammar" && nodeId !== "publish-package") throw new Error("Unsupported document node.");
    this.directory = path.join(runRoot, "nodes", nodeId, "document-commands");
  }

  async list(): Promise<DocumentCommandRecord[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).map(async (file) => {
      let value: DocumentCommandRecord;
      try { value = JSON.parse(await readFile(path.join(this.directory, file), "utf8")) as DocumentCommandRecord; }
      catch { throw new DocumentCommandConflictError("文字操作记录无法读取；请先检查记录，不要再次调用模型。"); }
      if (!value || value.version !== "video-factory/document-command-v1"
        || typeof value.commandId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.commandId)
        || file !== `${digest(value.commandId)}.json`
        || !["revise", "audit"].includes(value.action) || typeof value.actor !== "string" || !value.actor.trim()
        || !["created", "pending", "completed", "applied", "failed", "stale", "unchanged", "invalid"].includes(value.state)
        || !value.input || !Number.isSafeInteger(value.input.expectedRunRevision) || value.input.expectedRunRevision < 0
        || typeof value.input.expectedVersionId !== "string" || !value.input.expectedVersionId
        || value.requestDigest !== digest({ action: value.action, actor: value.actor, input: value.input })
        || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
        throw new DocumentCommandConflictError("文字操作记录无法核对；请先检查记录，不要再次调用模型。");
      }
      return value;
    }));
  }

  async withCommand<T>(
    identity: { commandId?: string; action: "revise" | "audit"; actor: string; input: DocumentCommandRecord["input"] },
    execute: (record: DocumentCommandRecord, task: DocumentTaskContext) => Promise<T>,
    beforeCreate?: (persist: () => Promise<void>) => Promise<void>,
  ): Promise<T> {
    const requestDigest = digest({ action: identity.action, actor: identity.actor, input: identity.input });
    const commandId = identity.commandId ?? `legacy-${requestDigest}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(commandId)) {
      throw new DocumentCommandConflictError("文字操作编号无效，请刷新后重新操作。");
    }
    await mkdir(this.directory, { recursive: true });
    let compromised = false;
    const release = await lock(this.directory, { realpath: false, stale: 30_000, update: 10_000,
      retries: 0, onCompromised: () => { compromised = true; } });
    const assertOwned = () => { if (compromised) throw new DocumentCommandConflictError("文字操作的执行锁已失效，结果保留，暂不提交。"); };
    try {
      const records = await this.list();
      let record = records.find((item) => item.commandId === commandId);
      const isNew = !record;
      if (record && record.requestDigest !== requestDigest) {
        throw new DocumentCommandConflictError("同一文字操作不能更换稿件、动作或修改意见；原操作保持不变。");
      }
      if (!record && records.some((item) => ["created", "pending", "completed"].includes(item.state))) {
        throw new DocumentCommandConflictError("这个节点有一条尚未结清的文字操作，请先取回原结果，不要重复发送。");
      }
      record ??= { version: "video-factory/document-command-v1", commandId, requestDigest,
        action: identity.action, actor: identity.actor, input: identity.input,
        state: "created", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const saved = record;
      if (!saved.completedAt && (saved.execution || saved.state === "failed")) saved.completedAt = saved.updatedAt;
      const persist = async () => { assertOwned(); saved.updatedAt = new Date().toISOString(); await this.save(saved); };
      if (isNew && beforeCreate) await beforeCreate(persist);
      else await persist();
      const task: DocumentTaskContext = {
        requestId: saved.prepared?.requestId ?? `doc-${digest({ directory: this.directory, commandId })}`,
        ...(saved.prepared ? { prepared: saved.prepared } : {}),
        ...(saved.execution ? { execution: saved.execution } : {}),
        beforeSubmit: async (operation) => {
          if (saved.prepared && saved.prepared.requestId !== operation.requestId) {
            const prior = saved.prepared;
            saved.priorRequests = [...(saved.priorRequests ?? []), { requestId: prior.requestId,
              providerId: prior.brokerBinding.providerId, modelId: prior.brokerBinding.modelId }];
          }
          saved.prepared = structuredClone(operation);
          saved.state = "pending";
          delete saved.error;
          await persist();
        },
        onCompleted: async (execution) => {
          saved.execution = structuredClone(execution);
          saved.completedAt ??= new Date().toISOString();
          saved.state = "completed";
          delete saved.error;
          await persist();
        },
        onValidated: async () => { saved.validated = true; await persist(); },
        onInvalid: async () => { saved.state = "invalid"; await persist(); },
        beforeApply: async (resultSha256) => {
          if (saved.resultSha256 && saved.resultSha256 !== resultSha256) {
            throw new DocumentCommandConflictError("原操作与待写入结果不一致，不能覆盖稿件。");
          }
          saved.resultSha256 = resultSha256;
          await persist();
        },
      };
      if (["failed", "invalid", "stale"].includes(saved.state)) throw new DocumentCommandConflictError(saved.error?.message ?? "原文字操作已结束，请查看原因后再决定是否发起新操作。");
      try {
        const result = await execute(saved, task);
        if (saved.state !== "unchanged") saved.state = "applied";
        delete saved.error;
        await persist();
        return result;
      } catch (error) {
        const bridgeError = error instanceof CodexBridgeError ? error
          : error instanceof Error && error.cause instanceof CodexBridgeError ? error.cause : undefined;
        saved.error = { message: bridgeError ? bridgeError.creatorMessage
          : error instanceof Error && ["StudioConflictError", "DocumentCommandConflictError"].includes(error.name)
            ? error.message : "文字操作暂未完成，原稿和操作记录已保留。",
          ...(bridgeError ? { stage: bridgeError.stage } : {}) };
        if (bridgeError?.failureDetails) saved.failureDetails = structuredClone(bridgeError.failureDetails);
        // 已受理或尚未核实的请求绝不因本地异常被当作可以重新提交。
        if (!saved.execution && (!saved.prepared || bridgeError
          && ["not_accepted", "completed_failure", "rejected"].includes(bridgeError.stage))) {
          saved.state = "failed";
          saved.completedAt ??= new Date().toISOString();
        }
        await persist();
        throw error;
      }
    } finally { await release(); }
  }

  private async save(record: DocumentCommandRecord): Promise<void> {
    const destination = path.join(this.directory, `${digest(record.commandId)}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, destination);
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
