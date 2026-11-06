import Database from "better-sqlite3";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { BillingFact, ExecutionInput, ExecutionObservation, MediaContent, RecoveryQuery } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { canonicalJson, newAgentId, type AgentClock } from "./util.js";
import { runRow, quoteMinor } from "./production-store.js";

export interface FauxMediaOptions {
  fixtureRoot: string;
  delayMs?: number;
  loseSubmitResponse?: boolean;
  recoverySupported?: boolean;
  cancellationSupported?: boolean;
  outcome?: "succeeded" | "failed";
  billing?: BillingFact | null;
}
interface Job { identity: string; input_json: string; task_id: string | null; ready_at: number; cancelled: number; blob_json: string | null }

// 独立 SQLite 模拟外部供应商：业务事务回滚不能回滚已受理任务。这里只读固定本地媒体，完全不联网。
export class FauxMediaPort implements MediaExecutionPort {
  readonly providerDb: Database.Database;
  constructor(dataDir: string, private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, readonly options: FauxMediaOptions) {
    this.providerDb = new Database(path.join(dataDir, "faux-provider.db"));
    this.providerDb.pragma("journal_mode=WAL"); this.providerDb.pragma("synchronous=FULL");
    this.providerDb.exec("CREATE TABLE IF NOT EXISTS jobs(identity TEXT PRIMARY KEY,input_json TEXT NOT NULL,task_id TEXT,ready_at INTEGER NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,blob_json TEXT)");
  }
  close(): void { this.providerDb.close(); }
  async submit(input: ExecutionInput, permit: SubmitPermit): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    this.providerDb.prepare("INSERT INTO jobs(identity,input_json,task_id,ready_at) VALUES(?,?,?,?)")
      .run(input.requestIdentity, canonicalJson(input), input.operation.kind === "render" ? null : newAgentId("fixture-task"), Date.parse(this.clock()) + (this.options.delayMs ?? 8000));
    if (this.options.loseSubmitResponse) throw new Error("simulated response loss after acceptance");
    return this.observation(input.requestIdentity, input.attemptId);
  }
  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    this.verifyQuery(query);
    if (this.options.recoverySupported === false) return this.unknown(query.attemptId);
    return this.observation(query.requestIdentity, query.attemptId);
  }
  async cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    this.verifyQuery(query);
    if (this.options.cancellationSupported !== false) this.providerDb.prepare("UPDATE jobs SET cancelled=1 WHERE identity=? AND ready_at>?").run(query.requestIdentity, Date.parse(this.clock()));
    return this.observation(query.requestIdentity, query.attemptId);
  }
  private verifyQuery(query: RecoveryQuery): void {
    const job = this.providerDb.prepare("SELECT * FROM jobs WHERE identity=?").get(query.requestIdentity) as Job | undefined;
    if (!job) return;
    const input = JSON.parse(job.input_json) as ExecutionInput;
    if (input.attemptId !== query.attemptId || input.runId !== query.runId || input.operationId !== query.operationId
      || (input.operation.kind === "render" ? query.kind !== "local" : query.kind !== "provider" || canonicalJson(query.accountBinding) !== canonicalJson(input.operation.model) || query.providerTaskId !== null && query.providerTaskId !== job.task_id)) throw new Error("recovery identity mismatch");
  }
  private unknown(attemptId: string): ExecutionObservation {
    return { observationId: newAgentId("obs"), attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: this.clock(), message: "模拟供应商尚无法核实原任务。", billing: null };
  }
  private observation(identity: string, attemptId: string): ExecutionObservation {
    const job = this.providerDb.prepare("SELECT * FROM jobs WHERE identity=?").get(identity) as Job | undefined;
    if (!job) return this.unknown(attemptId);
    const input = JSON.parse(job.input_json) as ExecutionInput;
    const finished = job.ready_at <= Date.parse(this.clock());
    const state = job.cancelled ? "cancelled" : finished ? this.options.outcome ?? "succeeded" : "running";
    let blob: ExecutionObservation["blob"] = job.blob_json ? JSON.parse(job.blob_json) as ExecutionObservation["blob"] : null;
    if (state === "succeeded" && !blob) {
      const run = runRow(this.db, input.runId);
      // 配音通道按合同返回 audio/mpeg（与真实 OpenAI Realtime 转 MP3 一致）；wav 样片会让 narrated/timed
      // 渲染的旁白槽在执行期被 mime 校验拒绝，替身必须忠实于通道契约。
      const type: MediaContent["mimeType"] = input.operation.kind === "image" ? "image/png" : input.operation.kind === "speech" ? "audio/mpeg" : "video/mp4";
      const fixture = input.operation.kind === "image" ? "sample.png" : input.operation.kind === "speech" ? "sample.mp3" : "sample.mp4";
      const saved = this.blobs.persist(run.owner_id, run.conversation_id, readFileSync(path.join(this.options.fixtureRoot, fixture)), type, type.startsWith("image/") ? null : 3000);
      blob = { id: saved.id, digest: saved.digest, mimeType: saved.mime_type };
      this.providerDb.prepare("UPDATE jobs SET blob_json=? WHERE identity=?").run(canonicalJson(blob), identity);
    }
    const billing = input.operation.kind === "render" ? null : this.options.billing !== undefined ? this.options.billing : {
      kind: "authoritative" as const, billingFactId: `fixture-bill-${attemptId}`, sourceRevision: state === "running" ? "1" : "2",
      netAmount: { currency: "CNY" as const, amountMinor: state === "cancelled" ? 0 : quoteMinor(input.operation) },
      final: state !== "running", evidenceId: `fixture-evidence-${attemptId}`,
    };
    return { observationId: newAgentId("obs"), attemptId, state, providerTaskId: job.task_id, blob, observedAt: this.clock(), message: "模拟媒体返回，仅验证制作流程。", billing };
  }
}
