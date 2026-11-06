import type { AgentDatabase } from "./db.js";
import type { BillingFact, ExecutionObservation, Finance, MediaContent, OperationSpec, ProductionSpec, Run, RunSegment } from "../../shared/agent/generated/contracts.js";
import { canonicalJson } from "./util.js";
import { AgentError } from "./errors.js";
import { productionAudioFacts } from "./artifact-store.js";

export interface RunRow {
  id: string; owner_id: string; conversation_id: string; work_id: string; snapshot_id: string;
  proposal_id: string; title: string; state: Run["state"]; revision: number; created_seq: number;
  issue_json: string | null; lease_owner: string | null; execution_epoch: number; lease_until: string | null;
  created_at: string; updated_at: string;
}
export interface OperationRow {
  run_id: string; id: string; spec_json: string; state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  output_blob_id: string | null;
}
export interface AttemptRow {
  id: string; run_id: string; operation_id: string; ordinal: number; request_identity: string;
  phase: "prepared" | "submit_started" | "observed";
  state: "prepared" | ExecutionObservation["state"];
  provider_task_id: string | null; reserve_minor: number; billing_json: string | null;
  billed_minor: number; billing_final: number; billing_conflict: number;
}
export const terminal = (state: string): boolean => ["succeeded", "failed", "cancelled"].includes(state);
export const quoteMinor = (op: OperationSpec): number => op.quotePerAttempt.amountMinor ?? 0;
export function runRow(db: AgentDatabase, id: string): RunRow {
  const row = db.prepare("SELECT * FROM production_runs WHERE id=?").get(id) as RunRow | undefined;
  if (!row) throw new AgentError("NOT_FOUND", "没有找到这个运行。");
  return row;
}
export function specFor(db: AgentDatabase, run: RunRow): ProductionSpec {
  return JSON.parse((db.prepare("SELECT spec_json FROM production_snapshots WHERE id=?").get(run.snapshot_id) as { spec_json: string }).spec_json) as ProductionSpec;
}
export function operationsFor(db: AgentDatabase, runId: string): OperationRow[] {
  return db.prepare("SELECT * FROM production_operations WHERE run_id=? ORDER BY rowid").all(runId) as OperationRow[];
}
export function attemptsFor(db: AgentDatabase, runId: string): AttemptRow[] {
  return db.prepare("SELECT * FROM production_attempts WHERE run_id=? ORDER BY ordinal, rowid").all(runId) as AttemptRow[];
}

// —— C1 尝试效果收据 ——

export interface AttemptOutputRow {
  attempt_id: string;
  provider_task_id: string | null;
  blob_id: string | null;
  digest: string | null;
  exit_code: number | null;
  exit_kind: "completed" | "failed" | "terminated" | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

export function attemptOutput(db: AgentDatabase, attemptId: string): AttemptOutputRow | undefined {
  return db.prepare("SELECT * FROM production_attempt_outputs WHERE attempt_id=?").get(attemptId) as AttemptOutputRow | undefined;
}

// 收据只前进不后退：已有身份/成品不被空值覆盖；唯一键 attemptId 定位未发布输出。
export function recordAttemptOutput(
  db: AgentDatabase, now: string, attemptId: string,
  patch: {
    providerTaskId?: string; blobId?: string; digest?: string;
    exitCode?: number; exitKind?: "completed" | "failed" | "terminated"; detail?: string;
  },
): void {
  db.prepare(
    `INSERT INTO production_attempt_outputs(attempt_id, provider_task_id, blob_id, digest, exit_code, exit_kind, detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       provider_task_id = COALESCE(provider_task_id, excluded.provider_task_id),
       blob_id = COALESCE(blob_id, excluded.blob_id),
       digest = COALESCE(digest, excluded.digest),
       exit_code = COALESCE(exit_code, excluded.exit_code),
       exit_kind = COALESCE(exit_kind, excluded.exit_kind),
       detail = COALESCE(detail, excluded.detail),
       updated_at = excluded.updated_at`,
  ).run(attemptId, patch.providerTaskId ?? null, patch.blobId ?? null, patch.digest ?? null,
    patch.exitCode ?? null, patch.exitKind ?? null, patch.detail ?? null, now, now);
}

// 尚未确认退出的本地渲染尝试：跨重启继续占用本地并发名额，直到出现退出/成品收据。
export function heldLocalAttemptRuns(db: AgentDatabase): { runId: string }[] {
  return db.prepare(
    `SELECT DISTINCT a.run_id AS runId FROM production_attempts a
     JOIN production_operations o ON o.run_id = a.run_id AND o.id = a.operation_id
     JOIN production_runs r ON r.id = a.run_id
     WHERE (a.phase = 'submit_started' OR a.state NOT IN ('succeeded','failed','cancelled'))
       AND a.phase <> 'prepared'
       AND r.state NOT IN ('succeeded','failed','cancelled')
       AND json_extract(o.spec_json, '$.kind') = 'render'
       AND NOT EXISTS(SELECT 1 FROM production_attempt_outputs t WHERE t.attempt_id = a.id)`,
  ).all() as { runId: string }[];
}

// 账单是累计净额，不能相加，也不能取 max（金钱更正可以向下）。原始观测另行保留。
export function mergeBilling(db: AgentDatabase, attempt: AttemptRow, billing: BillingFact | null, local: boolean): void {
  if (local) {
    db.prepare("UPDATE production_attempts SET billing_final=1, billed_minor=0 WHERE id=?").run(attempt.id);
    return;
  }
  if (!billing || billing.kind !== "authoritative") return;
  const prior = attempt.billing_json ? JSON.parse(attempt.billing_json) as Extract<BillingFact, { kind: "authoritative" }> : null;
  if (prior) {
    if (prior.billingFactId !== billing.billingFactId) {
      db.prepare("UPDATE production_attempts SET billing_conflict=1 WHERE id=?").run(attempt.id); return;
    }
    const order = BigInt(billing.sourceRevision) - BigInt(prior.sourceRevision);
    if (order < 0n) return;
    if (order === 0n) {
      if (prior.netAmount.amountMinor !== billing.netAmount.amountMinor || prior.final !== billing.final) {
        db.prepare("UPDATE production_attempts SET billing_conflict=1 WHERE id=?").run(attempt.id);
      }
      return;
    }
  }
  // 同一账单的新版本可以更正金额，但不能解释另一个账单身份为何也属于本次尝试。
  const identityConflict = db.prepare(`SELECT 1 FROM ledger_observations WHERE attempt_id=?
    AND json_extract(observation_json,'$.billing.kind')='authoritative'
    AND json_extract(observation_json,'$.billing.billingFactId')<>? LIMIT 1`).get(attempt.id, billing.billingFactId);
  db.prepare("UPDATE production_attempts SET billing_json=?, billed_minor=?, billing_final=?, billing_conflict=? WHERE id=?")
    .run(canonicalJson(billing), billing.final ? billing.netAmount.amountMinor : attempt.billed_minor, Number(billing.final), Number(!!identityConflict), attempt.id);
}

export function finances(db: AgentDatabase, run: RunRow): Finance {
  const spec = specFor(db, run), attempts = attemptsFor(db, run.id);
  const settled = attempts.reduce((sum, a) => sum + a.billed_minor, 0);
  let reserved = 0, unknown = 0, needsReconciliation = false;
  for (const a of attempts) {
    if (a.billing_final && !a.billing_conflict) continue;
    if (a.phase === "prepared" && terminal(a.state)) continue;
    const remaining = Math.max(0, a.reserve_minor - a.billed_minor);
    if (a.state === "unknown" || a.billing_conflict || (terminal(a.state) && a.phase !== "prepared")) {
      unknown += remaining; needsReconciliation = true;
    } else reserved += remaining;
  }
  // 运行封套只是一次占用，prepared 是内部划拨；执行结束释放没有提交的剩余份额。
  if (!terminal(run.state)) reserved += Math.max(0, spec.maxSpend.amountMinor - settled - reserved - unknown);
  return {
    state: needsReconciliation ? "pending_reconciliation" : terminal(run.state) && !reserved && !unknown ? "settled" : "reserved",
    currency: "CNY", reservedMinor: reserved, pendingUnknownMinor: unknown, settledMinor: settled,
    priceKind: spec.operations.some(op => op.priceKind === "estimate") ? "estimate" : "bounded",
  };
}

// 操作步骤的只读投影：顺序即冻结规格顺序（production_operations 按插入序），
// media 只在输出落盘（output_blob_id）后给出真实媒体事实，不猜 RevisionRef。
// mime_type 在写入 production_blobs 时已按合同校验，这里只做类型还原。
function runOperations(db: AgentDatabase, runId: string): Run["operations"] {
  const blobs = new Map((db.prepare("SELECT id, mime_type, duration_ms FROM production_blobs WHERE id IN (SELECT output_blob_id FROM production_operations WHERE run_id=? AND output_blob_id IS NOT NULL)").all(runId) as { id: string; mime_type: string; duration_ms: number | null }[]).map(row => [row.id, row]));
  return operationsFor(db, runId).map(operation => {
    const spec = JSON.parse(operation.spec_json) as OperationSpec;
    const blob = operation.output_blob_id ? blobs.get(operation.output_blob_id) : undefined;
    return {
      operationId: operation.id,
      kind: spec.kind,
      state: operation.state,
      media: blob ? { format: "media" as const, blobId: blob.id, mimeType: blob.mime_type as MediaContent["mimeType"], durationMs: blob.duration_ms } : null,
    };
  });
}

export function toRun(db: AgentDatabase, row: RunRow): Run {
  const runOrder = (db.prepare("SELECT rowid AS ordinal FROM production_runs WHERE id=?").get(row.id) as { ordinal: number }).ordinal;
  const audioSummary = productionAudioFacts(db, specFor(db, row), runOrder).audioSummary;
  return {
    id: row.id, conversationId: row.conversation_id, workId: row.work_id, snapshotId: row.snapshot_id,
    proposalId: row.proposal_id, title: row.title, revision: row.revision, state: row.state,
    finance: finances(db, row), inputRevisions: specFor(db, row).inputRevisions,
    outputRevisions: (db.prepare("SELECT artifact_id AS artifactId, id AS revisionId FROM artifact_revisions WHERE run_id=? ORDER BY rowid").all(row.id)) as Run["outputRevisions"],
    operations: runOperations(db, row.id),
    segments: runSegments(db, row), ...(audioSummary ? { audioSummary } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at, issue: row.issue_json ? JSON.parse(row.issue_json) as Run["issue"] : null,
  };
}

// 片段只读投影（B2.4）：实际片段→冻结 render 输入槽→operation_output 或既有 blob/修订→
// 准确 plan section→内容 section。范围以 finalOutput render 的视觉输入为准；render 未带
// segmentIds 或提案无方案来源时为空数组，不虚构联动。输入是另一项 render 结果时作为一个整体
// 片段（operation_output 解析到那项 render 的输出 blob），不递归展开。
export function runSegments(db: AgentDatabase, row: RunRow): RunSegment[] {
  const spec = specFor(db, row);
  const finalOperation = spec.operations.find(op => op.operationId === spec.finalOutput.operationId);
  if (!finalOperation || finalOperation.kind !== "render") return [];
  const parameters = finalOperation.parameters;
  const segmentIds = parameters.segmentIds;
  if (!segmentIds) return [];
  const proposal = db.prepare("SELECT plan_source_json FROM proposals WHERE id = ?").get(row.proposal_id) as { plan_source_json: string | null } | undefined;
  const planSource = proposal?.plan_source_json ? JSON.parse(proposal.plan_source_json) as { kind: string; artifactId?: string; revisionId?: string } : null;
  if (!planSource || planSource.kind !== "artifact_revision" || !planSource.artifactId || !planSource.revisionId) return [];
  const planRevision = db.prepare("SELECT content_json, creation_binding_json FROM artifact_revisions WHERE artifact_id = ? AND id = ?")
    .get(planSource.artifactId, planSource.revisionId) as { content_json: string; creation_binding_json: string | null } | undefined;
  if (!planRevision) return [];
  const planContent = JSON.parse(planRevision.content_json) as { format?: string; sections?: { id: string; title: string; sourceSectionIds?: string[] }[] };
  if (planContent.format !== "markdown" || !planContent.sections) return [];
  const planBinding = planRevision.creation_binding_json
    ? JSON.parse(planRevision.creation_binding_json) as { source?: { kind: string; artifactId?: string; revisionId?: string; digest?: string; messageId?: string; text?: string; author?: string } | null }
    : null;
  const sectionsById = new Map(planContent.sections.map(section => [section.id, section]));
  const operationsById = new Map(operationsFor(db, row.id).map(operation => [operation.id, operation]));
  const blobFacts = (blobId: string): { mime_type: string; duration_ms: number | null } | undefined =>
    db.prepare("SELECT mime_type, duration_ms FROM production_blobs WHERE id = ?").get(blobId) as { mime_type: string; duration_ms: number | null } | undefined;

  // 视觉时间线与 renderSlotRole 同一事实来源：ordered=inputs 顺序；narrated=videoInputSlots；timed=segments。
  type SlotEntry = { slot: number; startMs: number | null; durationMs: number | null };
  let timeline: SlotEntry[];
  if (parameters.assembly === "narrated_concat") {
    timeline = parameters.videoInputSlots.map(slot => ({ slot, startMs: null, durationMs: null }));
  } else if (parameters.assembly === "timed_narrated_concat" || parameters.assembly === "mixed_concat") {
    timeline = parameters.segments.map(segment => ({
      slot: segment.inputSlot,
      startMs: segment.kind === "video" ? segment.startMs : null,
      durationMs: segment.durationMs,
    }));
  } else {
    timeline = finalOperation.inputs.map((_, slot) => ({ slot, startMs: null, durationMs: null }));
  }
  if (timeline.length !== segmentIds.length) return [];

  const segments: RunSegment[] = [];
  for (let index = 0; index < timeline.length; index++) {
    const entry = timeline[index]!;
    const segmentId = segmentIds[index]!;
    const section = sectionsById.get(segmentId);
    if (!section) continue;
    const input = finalOperation.inputs[entry.slot];
    if (!input) continue;
    let media: MediaContent | null = null;
    let revision: RunSegment["revision"] = null;
    let state: RunSegment["state"] = "succeeded";
    if (input.kind === "operation_output") {
      const producer = operationsById.get(input.producerOperationId);
      state = producer?.state ?? "pending";
      if (producer?.output_blob_id) {
        const facts = blobFacts(producer.output_blob_id);
        if (facts) media = { format: "media", blobId: producer.output_blob_id, mimeType: facts.mime_type as MediaContent["mimeType"], durationMs: facts.duration_ms };
      }
    } else if (input.kind === "artifact_revision") {
      revision = { artifactId: input.artifactId, revisionId: input.revisionId };
      const revisionRow = db.prepare("SELECT content_json FROM artifact_revisions WHERE artifact_id = ? AND id = ?")
        .get(input.artifactId, input.revisionId) as { content_json: string } | undefined;
      const content = revisionRow ? JSON.parse(revisionRow.content_json) as { format?: string; blobId?: string; mimeType?: string; durationMs?: number | null } : undefined;
      if (content?.format === "media" && content.blobId) {
        media = { format: "media", blobId: content.blobId, mimeType: content.mimeType as MediaContent["mimeType"], durationMs: content.durationMs ?? null };
      }
    } else if (input.kind === "blob") {
      const facts = blobFacts(input.blobId);
      if (facts) media = { format: "media", blobId: input.blobId, mimeType: facts.mime_type as MediaContent["mimeType"], durationMs: facts.duration_ms };
    } else {
      continue; // text 输入不在视觉时间线上
    }
    const bindingSource = planBinding?.source ?? null;
    const citesContent = (section.sourceSectionIds?.length ?? 0) > 0;
    let content: RunSegment["content"] = null;
    if (citesContent && bindingSource) {
      content = bindingSource as RunSegment["content"];
    }
    segments.push({
      segmentId, title: section.title,
      plan: { artifactId: planSource.artifactId, revisionId: planSource.revisionId },
      content, sourceSectionIds: section.sourceSectionIds ?? [],
      media, revision, state, startMs: entry.startMs, durationMs: entry.durationMs,
    });
  }
  return segments;
}
