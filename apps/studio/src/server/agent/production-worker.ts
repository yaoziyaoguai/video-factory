import type { MediaExecutionPort } from "../../shared/agent/ports.js";
import type { ContentSource, CreationBinding, ExecutionInput, ExecutionObservation, FrozenReviewTarget, LocalRenderOperation, MediaContent, OperationSpec, RecoveryQuery, RevisionRef, Run } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { renderSlotRole } from "./render-inputs.js";
import { type EventHub, insertEvent } from "./event-log.js";
import { emptyReferences, insertMessage, nextSeq } from "./conversation-store.js";
import { getRevisionRow, maxArtifactSeq, proposalPlanSource } from "./artifact-store.js";
import { AgentError } from "./errors.js";
import { canonicalJson, digestOf, newAgentId, type AgentClock } from "./util.js";
import { ProductionBlobs, type BlobRow } from "./production-blobs.js";
import type { ProductionCrashHook } from "./production-service.js";
import { aggregateSources, mergeSources, recordBlobSources } from "./material-store.js";
import { attemptsFor, finances, heldLocalAttemptRuns, mergeBilling, operationsFor, quoteMinor, runRow, snapshotFor, terminal, toRun, type AttemptRow, type OperationRow, type RunRow } from "./production-store.js";
import { issueSubmitPermit } from "./submit-permit.js";
import { parseCreationState, setReviewItemDraft, setVideoOutput, type WorkRow } from "./creative-work.js";

interface Lease { runId: string; epoch: number }
export interface ProductionWorkerOptions {
  pollMs?: number;
  leaseMs?: number;
  crash?: ProductionCrashHook;
}

// 单节点有界后台：一个运行串行处理其操作图，不占 Pi 的前台队列。
// 租约只转移处理权，submit_started 之后永不凭租约重试 create。
// reconcileTerminalBilling=false（Ark）：执行已终态且只剩账务未核的运行不再进入周期供应商查询。
export class ProductionWorker {
  private readonly identity = newAgentId("worker");
  private readonly active = new Map<string, { kind: "provider" | "local"; promise: Promise<void>; stop: AbortController }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly leaseMs: number;
  private readonly crash: ProductionCrashHook;
  private readonly reconcileTerminalBilling: boolean;
  constructor(private readonly db: AgentDatabase, private readonly clock: AgentClock, private readonly hub: EventHub,
    private readonly blobs: ProductionBlobs, private readonly port: MediaExecutionPort, private readonly options: ProductionWorkerOptions = {}) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.crash = options.crash ?? (() => {});
    this.reconcileTerminalBilling = port.reconcileTerminalBilling ?? true;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pollOnce().catch(error => console.error("production worker:", error)); }, this.options.pollMs ?? 1000);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // 服务关闭：先通知本地在途等待退出（渲染进程、图片 HTTP、配音会话），
    // 已取得的事实随各端口既有语义落盘；不伪造用户取消，不打断的事实按重启路径读取。
    for (const active of this.active.values()) active.stop.abort();
    await Promise.all([...this.active.values()].map(a => a.promise));
  }
  async pollOnce(): Promise<void> {
    if (this.stopped) return;
    // submit 等待期间（本地渲染、图片 HTTP、配音会话）都要接收用户停止；复用轮询，不新建调度器。
    for (const [runId, active] of this.active) {
      if (runRow(this.db, runId).state === "cancel_requested") active.stop.abort();
    }
    // 终态账务子查询按宿主能力展开：供应商任务接口不是账单接口时，纯账务未核不再触发供应商 GET。
    const billingPending = this.reconcileTerminalBilling
      ? `EXISTS(SELECT 1 FROM production_attempts a WHERE a.run_id=r.id AND a.phase<>'prepared' AND (a.billing_final=0 OR a.billing_conflict=1)
          AND NOT (a.state='unknown' AND a.phase='observed' AND a.provider_task_id IS NULL AND ${this.port.queryRequiresProviderTaskId ? "1" : "0"}))`
      : `EXISTS(SELECT 1 FROM production_attempts a WHERE a.run_id=r.id AND a.phase<>'prepared' AND (a.billing_final=0 OR a.billing_conflict=1) AND a.state NOT IN ('succeeded','failed','cancelled')
          AND NOT (a.state='unknown' AND a.phase='observed' AND a.provider_task_id IS NULL AND ${this.port.queryRequiresProviderTaskId ? "1" : "0"}))`;
    const candidates = this.db.prepare(`SELECT * FROM production_runs r WHERE
      (r.state NOT IN ('succeeded','failed','cancelled') OR ${billingPending}
        OR EXISTS(SELECT 1 FROM ledger_observations l JOIN production_attempts a ON a.id=l.attempt_id WHERE a.run_id=r.id AND l.applied=0))
      AND (lease_until IS NULL OR lease_until<=?) ORDER BY COALESCE(lease_until,created_at), created_seq LIMIT 32`).all(this.clock()) as RunRow[];
    // 本地并发1同时覆盖：本进程在途的渲染、以及跨重启尚未确认退出的本地尝试（收据缺失即占用）。
    // 占用只计“其他 run”：run 自身的未决尝试必须继续被轮询查询，否则永远轮不到发现其退出证据。
    const localHeldRuns = new Set(heldLocalAttemptRuns(this.db).filter(row => !this.active.has(row.runId)).map(row => row.runId));
    const started: Promise<void>[] = [];
    for (const run of candidates) {
      if (this.active.has(run.id)) continue;
      const operation = this.nextOperation(run);
      const kind = operation && (JSON.parse(operation.spec_json) as OperationSpec).kind === "render" ? "local" : "provider";
      if (kind === "local"
        ? [...this.active.values()].filter(a => a.kind === "local").length + [...localHeldRuns].filter(id => id !== run.id).length >= 1
        : [...this.active.values()].filter(a => a.kind === kind).length >= 2) continue;
      const lease = this.claim(run.id);
      if (!lease) continue;
      const stop = new AbortController();
      const promise = this.execute(lease, stop.signal).finally(() => {
        this.active.delete(run.id);
        // 保留最近释放时间用于公平轮询，长期 unknown 不能一直抢在新运行前面。
        this.db.prepare("UPDATE production_runs SET lease_owner=NULL,lease_until=? WHERE id=? AND lease_owner=? AND execution_epoch=?")
          .run(this.clock(), run.id, this.identity, lease.epoch);
      });
      this.active.set(run.id, { kind, promise, stop });
      started.push(promise);
    }
    await Promise.all(started);
  }
  private claim(runId: string): Lease | null {
    return this.db.transaction(() => {
      const now = this.clock();
      const changed = this.db.prepare("UPDATE production_runs SET lease_owner=?, execution_epoch=execution_epoch+1, lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<=?)")
        .run(this.identity, this.expires(), runId, now);
      return changed.changes ? { runId, epoch: runRow(this.db, runId).execution_epoch } : null;
    })();
  }
  private expires(): string { return new Date(Date.parse(this.clock()) + this.leaseMs).toISOString(); }
  private owns(lease: Lease): boolean {
    const row = runRow(this.db, lease.runId);
    return row.lease_owner === this.identity && row.execution_epoch === lease.epoch && row.lease_until! > this.clock();
  }
  private nextOperation(run: RunRow): OperationRow | undefined {
    const operations = operationsFor(this.db, run.id), attempts = attemptsFor(this.db, run.id);
    if (run.state === "cancel_requested") return operations.find(op =>
      attempts.some(a => a.operation_id === op.id && a.phase !== "prepared" && !terminal(a.state)));
    // 无 taskId 只说明没有远端查询渠道，不等于没有本地结果（M0/R1）：在途 unknown 一律交端口
    // 恢复查询——端口先读本地完成收据与落盘文件，无果时返回幂等的稳定 unknown，不会外呼。
    // 纯账务未核的终态尝试才按渠道判断是否续查，避免无意义的周期查询。
    const renderIds = renderOperationIds(operations);
    // 操作值得继续处理：还没开始、有在途尝试（unknown 交端口核对）、或按次数与账务仍有重试空间。
    const actionable = (op: OperationRow): boolean => {
      const mine = attempts.filter(a => a.operation_id === op.id);
      if (mine.length === 0) return true;
      const maxAttempts = (JSON.parse(op.spec_json) as OperationSpec).maxCreateAttempts;
      return mine.some(a => !terminal(a.state) || a.phase === "prepared")
        || mine.some(a => a.state === "failed" && a.billing_final && !a.billing_conflict && a.ordinal < maxAttempts);
    };
    const incomplete = !terminal(run.state) && operations.find(op => !terminal(op.state) && actionable(op)
      && (JSON.parse(op.spec_json) as OperationSpec).inputs.every(input =>
        input.kind !== "operation_output" || operations.find(p => p.id === input.producerOperationId)?.output_blob_id));
    if (incomplete) return incomplete;
    // 纯账务未核的终态尝试：宿主不支持终态对账或已无查询渠道时不再作为查询理由。
    const outstanding = attempts.find(a => this.billingQueryAlive(a, renderIds));
    return outstanding ? operations.find(op => op.id === outstanding.operation_id) : undefined;
  }
  // 账务未核且仍有真实查询渠道的尝试（镜像 finances 的待核判定）：不支持终态对账的端口对
  // 终态尝试不再查询；无任务身份且查询必须带身份的 unknown 没有渠道。同一判定既决定 worker
  // 是否继续周期查询，也决定对用户说“费用仍在核对”还是“实际费用未取得”。
  private billingQueryAlive(a: AttemptRow, renderIds: Set<string>): boolean {
    return a.phase !== "prepared" && (a.billing_final === 0 || a.billing_conflict !== 0)
      && (this.reconcileTerminalBilling || !terminal(a.state))
      && !(a.state === "unknown" && a.provider_task_id === null
        && !renderIds.has(a.operation_id) && (this.port.queryRequiresProviderTaskId ?? false));
  }
  private async execute(lease: Lease, signal: AbortSignal): Promise<void> {
    const renewal = setInterval(() => {
      if (this.owns(lease)) this.db.prepare("UPDATE production_runs SET lease_until=? WHERE id=? AND lease_owner=? AND execution_epoch=?")
        .run(this.expires(), lease.runId, this.identity, lease.epoch);
    }, Math.min(15_000, this.leaseMs / 4));
    renewal.unref();
    try {
      // 旧 epoch 的迟到结果先作为观测保留，新持有者负责应用。
      const saved = this.db.prepare("SELECT observation_json FROM ledger_observations WHERE applied=0 AND attempt_id IN (SELECT id FROM production_attempts WHERE run_id=?) ORDER BY id").all(lease.runId) as { observation_json: string }[];
      for (const row of saved) this.observe(lease, JSON.parse(row.observation_json) as ExecutionObservation);
      if (!this.owns(lease)) return;
      if (runRow(this.db, lease.runId).state === "cancel_requested") {
        await this.cancelSubmitted(lease);
        return;
      }
      this.db.transaction(() => this.refresh(lease.runId))();
      let run = runRow(this.db, lease.runId);
      const operation = this.nextOperation(run);
      if (!operation) return;
      const spec = JSON.parse(operation.spec_json) as OperationSpec;
      let attempt = attemptsFor(this.db, run.id).filter(a => a.operation_id === operation.id).at(-1);
      if (operation.state === "pending" && attempt?.state === "failed" && attempt.billing_final && !attempt.billing_conflict && attempt.ordinal < spec.maxCreateAttempts) attempt = undefined;
      if (terminal(operation.state)) attempt = attemptsFor(this.db, run.id).find(a => a.operation_id === operation.id && a.phase !== "prepared" && (!a.billing_final || a.billing_conflict)
        && (this.reconcileTerminalBilling || !terminal(a.state)));
      if (!attempt) {
        if (terminal(run.state) || run.state === "cancel_requested") return;
        attempt = this.prepare(lease, spec);
        if (!attempt) return;
        this.crash("after-attempt-prepared");
      }
      run = runRow(this.db, lease.runId);
      if (attempt.phase === "prepared") {
        if (run.state === "cancel_requested") { await this.cancelSubmitted(lease); return; }
        let input: ExecutionInput;
        try { input = this.executionInput(run, spec, attempt); }
        catch (error) {
          if (!(error instanceof AgentError)) throw error;
          this.db.transaction(() => {
            this.db.prepare("UPDATE production_attempts SET state='cancelled' WHERE id=?").run(attempt!.id);
            this.fail(run.id, "INPUT_UNAVAILABLE", error.message);
          })(); return;
        }
        const permitted = this.db.transaction(() => {
          if (!this.owns(lease) || runRow(this.db, run.id).state === "cancel_requested") return false;
          // prepared 可能来自上次执行；迟到费用更正必须在真正提交前生效。
          if (!this.withinBudget(run)) return false;
          this.db.prepare("UPDATE production_attempts SET phase='submit_started',state='unknown' WHERE id=? AND phase='prepared'").run(attempt!.id);
          this.db.prepare("UPDATE production_operations SET state='running' WHERE run_id=? AND id=?").run(run.id, spec.operationId);
          this.refresh(run.id);
          return true;
        })();
        if (!permitted) return;
        this.crash("after-submit-started");
        const observation = await this.call(attempt.id, () => this.port.submit(input, issueSubmitPermit(attempt!.id, lease.epoch), signal));
        this.observe(lease, observation);
      } else {
        const query = this.recoveryQuery(run.id, spec, attempt);
        const observation = await this.call(attempt.id, () => this.port.query(query));
        this.observe(lease, observation);
      }
      // submit 已退出后再核对全部已提交尝试；active 是整段 execute，不能拿它阻断自己的收敛。
      if (this.owns(lease) && runRow(this.db, lease.runId).state === "cancel_requested") await this.cancelSubmitted(lease);
    } finally {
      clearInterval(renewal);
      this.hub.notifyCommitted(runRow(this.db, lease.runId).conversation_id);
    }
  }
  // 停止先经 query 消费全部已有完成事实，再考虑远端取消；中途 observe/refresh 不释放输入锁。
  private async cancelSubmitted(lease: Lease): Promise<void> {
    const operations = operationsFor(this.db, lease.runId);
    const cancelUnsupported = runRow(this.db, lease.runId).issue_json
      && JSON.parse(runRow(this.db, lease.runId).issue_json!).code === "CANCEL_UNSUPPORTED";
    for (const attempt of attemptsFor(this.db, lease.runId)) {
      if (attempt.phase === "prepared" || terminal(attempt.state)) continue;
      const op = JSON.parse(operations.find(row => row.id === attempt.operation_id)!.spec_json) as OperationSpec;
      const query = this.recoveryQuery(lease.runId, op, attempt);
      const observed = await this.call(attempt.id, () => this.port.query(query));
      this.observe(lease, observed);
      if (!this.owns(lease)) return;
      const current = attemptsFor(this.db, lease.runId).find(row => row.id === attempt.id)!;
      if (!terminal(current.state) && !cancelUnsupported
        && (op.kind === "render" || current.provider_task_id !== null || !this.port.queryRequiresProviderTaskId)) {
        this.observe(lease, await this.call(attempt.id, () => this.port.cancel(this.recoveryQuery(lease.runId, op, current))), true);
        if (!this.owns(lease)) return;
      }
    }
    this.db.transaction(() => this.refresh(lease.runId, undefined, true))();
  }
  private async call(attemptId: string, action: () => Promise<ExecutionObservation>): Promise<ExecutionObservation> {
    try {
      const value = await action();
      if (value.attemptId !== attemptId) throw new Error("execution observation belongs to another attempt");
      return value;
    } catch (error) {
      console.error("production execution:", { attemptId, name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : "非 Error 异常" });
      return { observationId: newAgentId("obs"), attemptId, state: "unknown", providerTaskId: null, blob: null,
        observedAt: this.clock(), message: null, billing: null };
    }
  }
  private prepare(lease: Lease, op: OperationSpec): AttemptRow | undefined {
    return this.db.transaction(() => {
      if (!this.owns(lease)) return;
      const run = runRow(this.db, lease.runId), attempts = attemptsFor(this.db, run.id);
      if (run.state === "cancel_requested" || terminal(run.state)) return;
      const previous = attempts.filter(a => a.operation_id === op.operationId);
      if (previous.some(a => !terminal(a.state) || !a.billing_final || a.billing_conflict) || previous.length >= op.maxCreateAttempts) return;
      // 本地免费运行没有报价与额度事实：预留记 0，不进预算门（§4.2.1 不造假账单）。
      const free = snapshotFor(this.db, run).kind === "local";
      const reserve = free ? 0 : quoteMinor(op);
      if (!free && !this.withinBudget(run, reserve)) return;
      const id = newAgentId("att");
      this.db.prepare("INSERT INTO production_attempts(id,run_id,operation_id,ordinal,request_identity,phase,state,reserve_minor) VALUES(?,?,?,?,?,'prepared','prepared',?)")
        .run(id, run.id, op.operationId, previous.length + 1, newAgentId("submit"), reserve);
      this.refresh(run.id);
      return attemptsFor(this.db, run.id).find(a => a.id === id);
    })();
  }
  private withinBudget(run: RunRow, additionalReserve = 0): boolean {
    const snapshot = snapshotFor(this.db, run);
    // 本地运行报价与账务为空（§4.2.1），没有额度事实可判，不进预算门。
    if (snapshot.kind === "local") return true;
    const held = attemptsFor(this.db, run.id).reduce((sum, a) => {
      const candidate = a.billing_json ? (JSON.parse(a.billing_json) as { netAmount: { amountMinor: number } }).netAmount.amountMinor : 0;
      const reserved = a.billing_final && !a.billing_conflict || a.phase === "prepared" && terminal(a.state) ? 0 : Math.max(0, a.reserve_minor - a.billed_minor);
      return sum + Math.max(candidate, a.billed_minor + reserved);
    }, 0);
    if (held + additionalReserve <= snapshot.spec.maxSpend.amountMinor) return true;
    this.fail(run.id, "BUDGET_EXHAUSTED", "实际费用已超出剩余额度，没有提交后续操作。");
    return false;
  }
  private executionInput(run: RunRow, op: OperationSpec, attempt: AttemptRow): ExecutionInput {
    // code_project 的执行事实由端口物化：工程本体来自 parameters.projectRevision，
    // 媒体输入按槽位落 inputs/；文本与工程引用输入不产生执行文件。
    const codeProject = op.kind === "render" && op.parameters.assembly === "code_project";
    const resolvedInputs: ExecutionInput["resolvedInputs"] = [];
    for (const [slot, ref] of op.inputs.entries()) {
      if (ref.kind === "text" || ref.kind === "project_revision") continue;
      const role = op.kind === "render" && !codeProject ? renderSlotRole(op.parameters, slot) : "none";
      const audio = role === "audio", image = role === "image";
      // 混音音乐槽额外接受本地登记 WAV；旁白槽仍是供应商 MP3 契约（与 prepare 边界一致）。
      const musicSlot = op.kind === "render" && op.parameters.assembly === "mixed_concat" ? op.parameters.music?.inputSlot : undefined;
      let id: string | undefined;
      if (ref.kind === "blob") id = ref.blobId;
      else if (ref.kind === "operation_output") id = operationsFor(this.db, run.id).find(o => o.id === ref.producerOperationId)?.output_blob_id ?? undefined;
      else {
        const revision = getRevisionRow(this.db, ref.artifactId, ref.revisionId);
        if (!revision || revision.digest !== ref.digest) throw new AgentError("CAPABILITY_UNAVAILABLE", "冻结内容不可用。");
        const content = JSON.parse(revision.content_json) as { format: string; blobId?: string };
        if (content.format === "media") id = content.blobId;
        else if (codeProject) throw new AgentError("INVALID_INPUT", "工程的数据输入必须是媒体修订或工程修订。");
        else if (op.kind === "render") throw new AgentError("INVALID_INPUT", audio ? "旁白槽只接受音频修订。" : image ? "图片片段只接受图片修订。" : "有序拼接只接受视频片段。");
      }
      if (id) {
        const blob = this.blobs.get(run.owner_id, id);
        this.blobs.verify(blob);
        // code_project 的媒体类型由端口按 MEDIA_INPUT_EXTENSION 落位，不支持的类型在执行处确定性失败。
        if (op.kind === "render" && !codeProject) {
          const accepted = audio ? blob.mime_type === "audio/mpeg" || slot === musicSlot && blob.mime_type === "audio/wav" : image ? blob.mime_type.startsWith("image/") : blob.mime_type === "video/mp4" || blob.mime_type === "video/webm";
          if (!accepted) throw new AgentError("INVALID_INPUT", audio ? slot === musicSlot ? "音乐槽只接受音频。" : "旁白槽只接受音频。" : image ? "图片片段只接受图片。" : "有序拼接只接受视频片段。");
        }
        resolvedInputs.push({ slot, blobId: id, digest: blob.digest });
      } else if (ref.kind !== "artifact_revision") throw new AgentError("CAPABILITY_UNAVAILABLE", "依赖输出尚未可用。");
    }
    return { runId: run.id, snapshotId: run.snapshot_id, operationId: op.operationId, attemptId: attempt.id,
      requestIdentity: attempt.request_identity, operation: op, resolvedInputs };
  }
  private recoveryQuery(runId: string, op: OperationSpec, a: AttemptRow): RecoveryQuery {
    const base = { runId, operationId: op.operationId, attemptId: a.id, requestIdentity: a.request_identity };
    return op.kind === "render" ? { ...base, kind: "local" } : { ...base, kind: "provider", providerTaskId: a.provider_task_id, accountBinding: op.model };
  }

  // 可供接收迟到的适配器观测；epoch 不匹配只登记证据，不能改运行或再提交。
  observe(lease: Lease, observation: ExecutionObservation, cancelling = false): void {
    this.db.transaction(() => {
      const run = runRow(this.db, lease.runId);
      const attempt = attemptsFor(this.db, run.id).find(a => a.id === observation.attemptId);
      if (!attempt) throw new AgentError("NOT_FOUND", "观测不属于这个运行。");
      const hash = digestOf(observation);
      this.db.prepare("INSERT OR IGNORE INTO ledger_observations(attempt_id,digest,observation_json) VALUES(?,?,?)").run(attempt.id, hash, canonicalJson(observation));
      if (!this.owns(lease)) return;
      const record = this.db.prepare("SELECT applied FROM ledger_observations WHERE attempt_id=? AND digest=?").get(attempt.id, hash) as { applied: number };
      if (record.applied) return;
      const previous = toRun(this.db, run);
      const op = JSON.parse(operationsFor(this.db, run.id).find(o => o.id === attempt.operation_id)!.spec_json) as OperationSpec;
      if (observation.providerTaskId && attempt.provider_task_id && observation.providerTaskId !== attempt.provider_task_id) throw new AgentError("INVALID_INPUT", "观测的供应商任务身份冲突。");
      let state = terminal(attempt.state) ? attempt.state : observation.state;
      if (state === "succeeded" && !terminal(attempt.state)) {
        try {
          if (!observation.blob) throw new AgentError("CAPABILITY_UNAVAILABLE", "输出尚未落盘。");
          const blob = this.blobs.get(run.owner_id, observation.blob.id);
          if (blob.conversation_id !== run.conversation_id || blob.digest !== observation.blob.digest || blob.mime_type !== observation.blob.mimeType) throw new AgentError("INVALID_INPUT", "输出身份不一致。");
          // code_project 的期望输出类型按冻结参数核对；其余 render 仍以视频为准。
          const expected = op.kind === "render" && op.parameters.assembly === "code_project"
            ? op.parameters.expectedMediaKind === "image" ? "image/" : op.parameters.expectedMediaKind === "audio" ? "audio/" : "video/"
            : op.kind === "render" || op.kind === "video" ? "video/" : op.kind === "speech" ? "audio/" : "image/";
          if (!blob.mime_type.startsWith(expected)) throw new AgentError("INVALID_INPUT", "输出类型不匹配。");
          this.blobs.verify(blob);
          this.publish(run, op, blob);
        } catch (error) {
          if (!(error instanceof AgentError)) throw error;
          state = "unknown";
        }
      }
      this.db.prepare("UPDATE production_attempts SET phase='observed',state=?,provider_task_id=COALESCE(provider_task_id,?) WHERE id=?")
        .run(state, observation.providerTaskId, attempt.id);
      mergeBilling(this.db, attempt, observation.billing, op.kind === "render");
      if (state === "succeeded") this.db.prepare("UPDATE production_operations SET state='succeeded' WHERE run_id=? AND id=?").run(run.id, op.operationId);
      else if (state === "failed" || state === "cancelled") {
        const current = attemptsFor(this.db, run.id).find(a => a.id === attempt.id)!;
        const retry = state === "failed" && !terminal(run.state) && run.state !== "cancel_requested" && current.billing_final && !current.billing_conflict && current.ordinal < op.maxCreateAttempts;
        this.db.prepare("UPDATE production_operations SET state=? WHERE run_id=? AND id=?").run(retry ? "pending" : state, run.id, op.operationId);
      }
      if (cancelling && !terminal(state)) this.db.prepare("UPDATE production_runs SET issue_json=? WHERE id=?")
        .run(canonicalJson({ code: "CANCEL_UNSUPPORTED", message: "尚未确认取消，已停止后续步骤，继续核对已提交任务。" }), run.id);
      this.db.prepare("UPDATE ledger_observations SET applied=1 WHERE attempt_id=? AND digest=?").run(attempt.id, hash);
      this.refresh(run.id, previous);
      this.crash("before-result-commit");
    })();
    this.crash("after-result-commit");
  }
  private publish(run: RunRow, op: OperationSpec, blob: BlobRow): void {
    const operation = operationsFor(this.db, run.id).find(o => o.id === op.operationId)!;
    if (operation.output_blob_id) {
      if (operation.output_blob_id !== blob.id) throw new AgentError("INVALID_INPUT", "输出槽位已绑定其他媒体。");
      return;
    }
    const artifactId = newAgentId("art"), revisionId = newAgentId("rev"), now = this.clock();
    const snapshot = snapshotFor(this.db, run);
    // 旧付费快照缺新组模型字段时在读取边界一次规范化为空集合与默认用途；不改写原 JSON、不补造认可事实。
    const reviewInputs = snapshot.spec.reviewInputs ?? [];
    const purpose = snapshot.spec.purpose ?? "production";
    // §11.7 来源1：来源按本操作实际输入解析——artifact_revision 数据输入、operation_output 沿
    // producer 产物既有 binding 继承、code_project 工程修订的 sourceRevisions（声明提供给工程的资源）。
    // 不把整条 run 的 inputSources 复制到每个产物；工程链去重后随 projectRevisions 留存。
    const sources = operationSources(this.db, run, op);
    const final = snapshot.spec.finalOutput.operationId === op.operationId;
    const kindLabel = op.kind === "speech" ? "配音" : op.kind === "image" ? "图片" : op.kind === "video" ? "视频片段"
      : op.kind === "render" && op.parameters.assembly === "code_project"
        ? { image: "图片", audio: "音频", video: "合成视频" }[op.parameters.expectedMediaKind]
      : "合成视频";
    const title = final ? run.title : `${run.title} · ${kindLabel} ${snapshot.spec.operations.filter(item => item.kind === op.kind).findIndex(item => item.operationId === op.operationId) + 1}`;
    const artifactKind = op.kind === "speech" ? "audio" : op.kind === "image" ? "image" : op.kind === "video" ? "video"
      : op.kind === "render" && op.parameters.assembly === "code_project" ? op.parameters.expectedMediaKind
      : "video";
    const content: MediaContent = { format: "media", blobId: blob.id, mimeType: blob.mime_type as MediaContent["mimeType"], durationMs: blob.duration_ms };
    if (op.kind === "render") {
      // 成片署名：按冻结输入的实际 blob 顺序聚合素材来源（去重、保持首次使用顺序），
      // 与修订同事务登记；本地生成或无来源输入的成品不带 sources。
      const sources = recordBlobSources(this.db, blob.id, mergeSources([
        aggregateSources(this.db, renderInputBlobIds(this.db, run.id, op)),
        op.parameters.assembly === "mixed_concat" && op.parameters.music && op.parameters.music.gain > 0 && op.musicSource ? [op.musicSource] : [],
      ]));
      if (sources.length > 0) content.sources = sources;
    }
    // 新写入只用新组模型 binding（§4.3）：本地运行按操作冻结目标；付费成片按受理冻结目标，
    // 首个成片（受理时还没有视频事项）按实际落位目标登记来源。旧固定阶段形状不再写。
    // 付费非成片输出保留无绑定修订。
    const localOperation = snapshot.kind === "local" ? JSON.parse(operation.spec_json) as LocalRenderOperation : null;
    const finalVideoDraft = final && (op.kind === "render" || op.kind === "video");
    // 本操作自己的工程在前，继承工程在后；projectRevision 仍只表示本操作执行的工程（§11.7 来源3）。
    const projectFields: Pick<CreationBinding, "projectRevision" | "projectRevisions"> =
      op.kind === "render" && op.parameters.assembly === "code_project"
        ? { projectRevision: op.parameters.projectRevision, projectRevisions: sources.projectRevisions }
        : sources.projectRevisions.length ? { projectRevisions: sources.projectRevisions } : {};
    let binding: CreationBinding | null = null;
    let videoTarget: FrozenReviewTarget | null = null;
    if (localOperation) {
      binding = {
        workId: run.work_id, groupId: localOperation.target.groupId, itemId: localOperation.target.itemId,
        inputSources: sources.inputSources, reviewInputs, purpose, runId: run.id,
        ...projectFields,
      };
    } else if (finalVideoDraft) {
      // 实际视频初稿只在文件落盘后登记；文本回复不能推进视频状态。
      // 旧付费快照的方案来源读本次已受理提案的固定持久关系（§10.1），不读 work 当前指针；
      // 新组模型提案的受理依据已随快照冻结（reviewInputs），没有方案关系可读。
      if (!("type" in snapshot.spec)) {
        const planDraft = proposalPlanSource(this.db, run.owner_id, run.conversation_id, run.proposal_id!);
        if (!planDraft) {
          // 旧受理门保证视频提案必有方案关系；到这里说明关系事实缺失：保留文件与费用事实，
          // 不创建无绑定成片、不把 run 标成功（observe 按既有失败语义登记）。
          throw new AgentError("CAPABILITY_UNAVAILABLE", "成片发布缺少方案关联事实，已保留输出文件待核对；不登记为视频初稿。");
        }
      }
      videoTarget = run.frozen_target_json ? JSON.parse(run.frozen_target_json) as FrozenReviewTarget : null;
    }
    const source: ContentSource = { kind: "artifact_revision", artifactId, revisionId, digest: digestOf(content) };
    // 草稿落位先于修订写入（§4.2.1 在途改稿、§11.6 S4）：本地与付费都按受理冻结的基准落位——
    // null 基准表示受理时确实无稿，完成时仍为空才落；准确基准只在当前仍是该版时更新。
    // 未落位（后继稿、目标已删除、旧历史运行缺冻结目标）时只保留 run 产出，不覆盖、不改挂别项。
    if (localOperation || finalVideoDraft) {
      const work = this.db.prepare("SELECT * FROM works WHERE id = ?").get(run.work_id) as WorkRow | undefined;
      if (work) {
        if (localOperation) {
          const state = parseCreationState(work);
          const item = state.groups.find(group => group.id === localOperation.target.groupId)
            ?.items.find(candidate => candidate.id === localOperation.target.itemId);
          const currentDraft = item?.draft?.kind === "artifact_revision" ? item.draft.revisionId : null;
          if (item && currentDraft === localOperation.target.baseRevisionId) {
            setReviewItemDraft(this.db, now, work, localOperation.target, source);
          }
        } else if (videoTarget) {
          setVideoOutput(this.db, now, work, source, videoTarget);
          // 归属记录受理冻结的身份：即使未落位，run 产出仍指向原目标可查。
          binding = { workId: run.work_id, groupId: videoTarget.groupId, itemId: videoTarget.itemId,
            inputSources: sources.inputSources, reviewInputs, purpose, runId: run.id, ...projectFields };
        }
      }
    }
    this.db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?)")
      .run(artifactId, run.conversation_id, run.owner_id, title, artifactKind, run.work_id, revisionId, maxArtifactSeq(this.db, run.conversation_id) + 1, now, now);
    this.db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,run_id,digest,content_json,creation_binding_json,created_at) VALUES(?,?,1,?,?,?,?,?)")
      .run(revisionId, artifactId, run.id, digestOf(content), canonicalJson(content), binding ? canonicalJson(binding) : null, now);
    this.db.prepare("INSERT INTO revision_blob_links(revision_id,blob_id) VALUES(?,?)").run(revisionId, blob.id);
    this.db.prepare("UPDATE production_operations SET output_blob_id=? WHERE run_id=? AND id=?").run(blob.id, run.id, op.operationId);
    insertEvent(this.db, now, { ownerId: run.owner_id, conversationId: run.conversation_id, kind: "artifact.delivered", entityId: artifactId, entityVersion: 1, notification: "new_output" });
  }
  // unknown 的用户说明按事实来源区分：本地无退出证据、供应商无任务身份，或仍在正常查询原任务。
  private unknownIssueMessage(runId: string, ops: OperationRow[], attempts: AttemptRow[]): string {
    const kindOf = new Map(ops.map(op => [op.id, (JSON.parse(op.spec_json) as OperationSpec).kind]));
    for (const attempt of attempts) {
      if (attempt.state !== "unknown") continue;
      const row = this.db.prepare("SELECT observation_json FROM ledger_observations WHERE attempt_id=? AND applied=1 ORDER BY id DESC LIMIT 1")
        .get(attempt.id) as { observation_json: string } | undefined;
      const message = row ? (JSON.parse(row.observation_json) as ExecutionObservation).message : null;
      if (message) return message;
      if (kindOf.get(attempt.operation_id) === "render") {
        if (!this.db.prepare("SELECT 1 FROM production_attempt_outputs WHERE attempt_id=?").get(attempt.id)) {
          return "本地渲染尚未取得退出证据，保留本地执行占用；不会重新渲染或重新提交。";
        }
      } else if (!attempt.provider_task_id && (this.port.queryRequiresProviderTaskId ?? false)) {
        return "缺少供应商任务身份，无法向供应商查询；结果与实际费用未取得；不会重新提交。";
      }
    }
    return "结果尚未核实，正在查询原任务；不会重复提交。";
  }

  // 失败说明保留供应商/本地的具体原因，不被统一的“制作未完成”吞掉。
  private failureIssueMessage(ops: OperationRow[], attempts: AttemptRow[]): string {
    const failedOp = ops.find(o => o.state === "failed" || o.state === "cancelled");
    const failedAttempt = failedOp && attempts.find(a => a.operation_id === failedOp.id && (a.state === "failed" || a.state === "cancelled"));
    const row = failedAttempt ? this.db.prepare("SELECT observation_json FROM ledger_observations WHERE attempt_id=? ORDER BY id DESC LIMIT 1").get(failedAttempt.id) as { observation_json: string } | undefined : undefined;
    const detail = row ? (JSON.parse(row.observation_json) as ExecutionObservation).message : null;
    return [detail?.slice(0, 1000), "本次制作未完成，已保留产生的内容。"].filter(Boolean).join(" ");
  }

  private fail(runId: string, code: NonNullable<Run["issue"]>["code"], message: string): void {
    const previous = toRun(this.db, runRow(this.db, runId));
    this.db.prepare("UPDATE production_runs SET state='failed',issue_json=? WHERE id=?").run(canonicalJson({ code, message }), runId);
    this.refresh(runId, previous);
  }
  private refresh(runId: string, prior?: Run, submittedConsumed = false): void {
    let run = runRow(this.db, runId);
    const before = prior ?? toRun(this.db, run);
    if (run.state === "cancel_requested" || terminal(run.state)) {
      this.db.prepare("UPDATE production_attempts SET state='cancelled' WHERE run_id=? AND phase='prepared'").run(runId);
      this.db.prepare(`UPDATE production_operations SET state='cancelled' WHERE run_id=? AND state='pending'
        AND NOT EXISTS(SELECT 1 FROM production_attempts a WHERE a.run_id=production_operations.run_id AND a.operation_id=production_operations.id AND a.phase<>'prepared' AND a.state NOT IN ('succeeded','failed','cancelled'))`).run(runId);
    }
    const ops = operationsFor(this.db, runId), attempts = attemptsFor(this.db, runId);
    let state = run.state, issue = run.issue_json;
    if (!terminal(state)) {
      const unknown = attempts.some(a => a.state === "unknown");
      // 取消收敛只等“还能产生新事实”的尝试：本地渲染进程要等停止信号与退出收据；
      // 无任务身份的 unknown（本端口体系查询不到更多证据，如 OpenAI 单次会话）不再永久阻塞。
      const renderOps = new Set(ops.filter(o => (JSON.parse(o.spec_json) as OperationSpec).kind === "render").map(o => o.id));
      const resolvable = (a: AttemptRow): boolean =>
        renderOps.has(a.operation_id) || a.provider_task_id !== null || !this.port.queryRequiresProviderTaskId;
      const inFlight = attempts.some(a => !terminal(a.state) && a.phase !== "prepared" && resolvable(a));
      const unresolvedUnknown = attempts.some(a => a.state === "unknown" && a.phase !== "prepared" && !resolvable(a));
      if (run.state === "cancel_requested") {
        if (submittedConsumed && !inFlight) {
          state = ops.every(o => o.state === "succeeded") ? "succeeded" : "cancelled";
          issue = null;
          // 收敛为已停止时仍有无法核实的尝试：如实保留“结果未确认、实际费用未取得”，
          // 不声称供应商已取消或免费；本通道已无再查询的渠道，保留事实待对账。
          if (state === "cancelled" && unresolvedUnknown) {
            issue = canonicalJson({ code: "CANCEL_UNSUPPORTED", message: "用户已停止后续步骤；已提交尝试的结果与实际费用未确认，保留事实待对账。" });
          }
        }
      } else if (unknown) {
        state = "unknown";
        issue = canonicalJson({ code: "PROVIDER_UNKNOWN", message: this.unknownIssueMessage(runId, ops, attempts) });
      } else if (ops.some(o => o.state === "failed" || o.state === "cancelled")) {
        state = "failed";
        issue = canonicalJson({ code: "PROVIDER_FAILED", message: this.failureIssueMessage(ops, attempts) });
      } else if (ops.every(o => o.state === "succeeded")) { state = "succeeded"; issue = null; }
      else { state = attempts.length ? "running" : "queued"; if (issue && JSON.parse(issue).code === "PROVIDER_UNKNOWN") issue = null; }
    }
    this.db.prepare("UPDATE production_runs SET state=?,issue_json=? WHERE id=?").run(state, issue, runId);
    if (terminal(state)) {
      this.db.prepare("DELETE FROM production_input_locks WHERE run_id=?").run(runId);
      this.db.prepare("UPDATE production_operations SET state='cancelled' WHERE run_id=? AND state='pending'").run(runId);
    }
    run = runRow(this.db, runId);
    const after = toRun(this.db, run);
    if (canonicalJson(after) === canonicalJson(before)) return;
    this.db.prepare("UPDATE production_runs SET revision=revision+1,updated_at=? WHERE id=?").run(this.clock(), runId);
    insertEvent(this.db, this.clock(), { ownerId: run.owner_id, conversationId: run.conversation_id, kind: "run.changed", entityId: runId, entityVersion: run.revision + 1 });
    if (terminal(state) && !terminal(before.state)) {
      // 费用说明按真实查询渠道区分（R2）：仍有会继续查询的账务未核尝试才说“正在核对”，
      // 没有渠道时如实说“实际费用未取得”，不把无从核对的待对账说成进行中的核对。
      // 本地免费运行没有付费快照与账务，不谈费用。
      const feeNote = run.proposal_id === null || finances(this.db, run).state !== "pending_reconciliation" ? ""
        : attempts.some(a => this.billingQueryAlive(a, renderOperationIds(ops))) ? "费用仍在核对。" : "实际费用未取得。";
      insertMessage(this.db, this.clock(), {
        id: newAgentId("msg"), ownerId: run.owner_id, conversationId: run.conversation_id, requestId: null,
        role: "system_notice", kind: "notice", state: "completed", text: `“${run.title}”${state === "succeeded" ? "已完成" : state === "cancelled" ? "已停止" : "未完成"}。${feeNote}反馈保留，不会自动改稿或重做。`,
        target: null, createdSeq: nextSeq(this.db, "messages", run.conversation_id), references: { ...emptyReferences(), runIds: [runId], artifacts: after.outputRevisions },
      });
    }
  }
}

// render 冻结输入引用的实际 blob（署名用）：ordered 按输入原顺序；narrated 按冻结画面顺序、旁白最后（§10）。
function renderOperationIds(operations: OperationRow[]): Set<string> {
  return new Set(operations.filter(o => (JSON.parse(o.spec_json) as OperationSpec).kind === "render").map(o => o.id));
}

// §11.7 来源1：本操作的直接来源——artifact_revision 数据输入、operation_output 沿 producer 产物
// 既有 binding 继承（来源与工程）、code_project 工程修订 content.sourceRevisions（声明提供给工程的
// 资源，digest 读冻结行）。工程链含本操作自己的工程（在前）与继承工程，按 revisionId 去重；
// 不另做来源猜测器，历史产出没有 binding 就没有可继承的事实。
function operationSources(db: AgentDatabase, run: RunRow, op: OperationSpec): { inputSources: ContentSource[]; projectRevisions: RevisionRef[] } {
  const inputSources: ContentSource[] = [];
  const projectRevisions: RevisionRef[] = [];
  const seenSources = new Set<string>();
  const seenProjects = new Set<string>();
  const pushSource = (artifactId: string, revisionId: string, digest: string) => {
    const key = `${artifactId}:${revisionId}`;
    if (seenSources.has(key)) return;
    seenSources.add(key);
    inputSources.push({ kind: "artifact_revision", artifactId, revisionId, digest });
  };
  const pushProject = (ref: RevisionRef) => {
    if (seenProjects.has(ref.revisionId)) return;
    seenProjects.add(ref.revisionId);
    projectRevisions.push(ref);
  };
  const projectParameters = op.kind === "render" && op.parameters.assembly === "code_project" ? op.parameters : null;
  if (projectParameters) pushProject(projectParameters.projectRevision);
  for (const input of op.inputs) {
    if (input.kind === "artifact_revision") {
      pushSource(input.artifactId, input.revisionId, input.digest);
    } else if (input.kind === "project_revision") {
      pushProject(input.projectRevision);
    } else if (input.kind === "operation_output") {
      const producer = db.prepare(`
        SELECT ar.creation_binding_json AS binding FROM production_operations po
        JOIN revision_blob_links l ON l.blob_id = po.output_blob_id
        JOIN artifact_revisions ar ON ar.id = l.revision_id AND ar.run_id = po.run_id
        WHERE po.run_id = ? AND po.id = ?`).get(run.id, input.producerOperationId) as { binding: string | null } | undefined;
      const producerBinding = producer?.binding ? JSON.parse(producer.binding) as CreationBinding : null;
      if (!producerBinding) continue;
      for (const source of producerBinding.inputSources) {
        if (source.kind === "artifact_revision") pushSource(source.artifactId, source.revisionId, source.digest);
      }
      if (producerBinding.projectRevision) pushProject(producerBinding.projectRevision);
      for (const ref of producerBinding.projectRevisions ?? []) pushProject(ref);
    }
  }
  if (projectParameters) {
    const projectRevision = getRevisionRow(db, projectParameters.projectRevision.artifactId, projectParameters.projectRevision.revisionId);
    const content = projectRevision ? JSON.parse(projectRevision.content_json) as { sourceRevisions?: RevisionRef[] } : null;
    for (const ref of content?.sourceRevisions ?? []) {
      // 封存时已验证来源修订存在且修订不可变；digest 读冻结行，缺行说明完整性破坏，如实失败。
      const sourceRevision = getRevisionRow(db, ref.artifactId, ref.revisionId);
      if (!sourceRevision) throw new AgentError("CAPABILITY_UNAVAILABLE", "冻结内容不可用。");
      pushSource(ref.artifactId, ref.revisionId, sourceRevision.digest);
    }
  }
  if (inputSources.length > 64 || projectRevisions.length > 64) {
    throw new AgentError("INVALID_INPUT", "本操作来源链超过 64 项，请减少本次使用的素材或工程。");
  }
  return { inputSources, projectRevisions };
}

function renderInputBlobIds(db: AgentDatabase, runId: string, op: OperationSpec): string[] {
  const bySlot: (string | undefined)[] = [];
  for (const [slot, input] of op.inputs.entries()) {
    if (input.kind === "blob") {
      bySlot[slot] = input.blobId;
    } else if (input.kind === "artifact_revision") {
      const row = db.prepare("SELECT content_json FROM artifact_revisions WHERE artifact_id=? AND id=?")
        .get(input.artifactId, input.revisionId) as { content_json: string } | undefined;
      const parsed = row ? JSON.parse(row.content_json) as { format?: string; blobId?: string } : undefined;
      if (parsed?.format === "media" && parsed.blobId) bySlot[slot] = parsed.blobId;
    } else if (input.kind === "operation_output") {
      const row = db.prepare("SELECT output_blob_id FROM production_operations WHERE run_id=? AND id=?")
        .get(runId, input.producerOperationId) as { output_blob_id: string | null };
      bySlot[slot] = row.output_blob_id ?? undefined;
    }
  }
  if (op.kind === "render" && op.parameters.assembly === "mixed_concat") {
    const parameters = op.parameters;
    return [...parameters.segments.map(segment => bySlot[segment.inputSlot]),
      ...(parameters.narration && parameters.narration.gain > 0 ? [bySlot[parameters.narration.inputSlot]] : [])].filter(Boolean) as string[];
  }
  if (op.kind === "render" && op.parameters.assembly === "narrated_concat") {
    return [...op.parameters.videoInputSlots.map(slot => bySlot[slot]), bySlot[op.parameters.narrationInputSlot]].filter(Boolean) as string[];
  }
  if (op.kind === "render" && op.parameters.assembly === "timed_narrated_concat") {
    return [...op.parameters.segments.map(segment => bySlot[segment.inputSlot]), bySlot[op.parameters.narrationInputSlot]].filter(Boolean) as string[];
  }
  return bySlot.filter(Boolean) as string[];
}
