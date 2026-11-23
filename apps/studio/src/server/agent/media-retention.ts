import type { AgentDatabase } from "./db.js";
import { getRevisionRow } from "./artifact-store.js";
import { parseCreationState } from "./creative-work.js";
import { retainedVideoMaterials } from "./library-materials.js";
import { checkCommandReceipt, storeCommandReceipt } from "./conversation-store.js";
import { AgentError } from "./errors.js";
import type { ProductionBlobs } from "./production-blobs.js";
import type { AgentClock } from "./util.js";
import type { ArtifactRevision, CleanupStorage, RevisionRef, StorageCleanupReceipt, StorageUsage } from "../../shared/agent/generated/contracts.js";

type LiveBlob = { id: string; digest: string; size_bytes: number; created_at: string; shared: number };
const DAY = 86_400_000;

export function mediaRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return 30;
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 36_500) throw new Error("FRAME_MEDIA_RETENTION_DAYS 须为 1 至 36500 之间的整数。");
  return days;
}

function protectedBlobs(db: AgentDatabase, ownerId: string, cutoff: string) {
  const finals = new Set<string>(), drafts = new Set<string>();
  function pin(target: Set<string>) {
    const visited = new Set<string>();
    function revision(ref: RevisionRef) {
      if (visited.has(ref.revisionId)) return;
      visited.add(ref.revisionId);
      const row = getRevisionRow(db, ref.artifactId, ref.revisionId);
      if (!row) return;
      const content = JSON.parse(row.content_json) as ArtifactRevision["content"];
      if (content.format === "file" || content.format === "media") target.add(content.blobId);
      if (content.format === "media" && content.upload?.firstFrame) target.add(content.upload.firstFrame.blobId);
      if (content.format === "subtitles") revision(content.source);
      if (content.format === "media" && content.subtitles) revision(content.subtitles.track);
      if (content.format === "project") {
        for (const file of content.files) target.add(file.blobId);
        for (const input of content.sourceRevisions) revision(input);
      }
      if (row.creation_binding_json) {
        const binding = JSON.parse(row.creation_binding_json) as Partial<NonNullable<ArtifactRevision["creationBinding"]>>;
        if (binding.adoptedFrom) revision(binding.adoptedFrom);
        if (binding.projectRevision) revision(binding.projectRevision);
        for (const project of binding.projectRevisions ?? []) revision(project);
        for (const source of binding.inputSources ?? []) if (source.kind === "artifact_revision") revision(source);
        for (const input of binding.reviewInputs ?? []) if (input.source.kind === "artifact_revision") revision(input.source);
      }
    }
    return revision;
  }
  const pinFinal = pin(finals), pinDraft = pin(drafts);
  const confirmations = db.prepare(`SELECT action,subject_json FROM work_review_confirmations WHERE owner_id=?
    UNION ALL SELECT action,subject_json FROM work_stage_confirmations WHERE owner_id=?`).all(ownerId, ownerId) as { action: string; subject_json: string }[];
  const finalized = new Set<string>();
  for (const row of confirmations) {
    const ref = JSON.parse(row.subject_json) as Partial<RevisionRef>;
    if (!ref.artifactId || !ref.revisionId) continue;
    const revision = { artifactId: ref.artifactId, revisionId: ref.revisionId };
    if (row.action !== "finalize_video") { pinDraft(revision); continue; }
    if (finalized.has(ref.revisionId)) continue;
    finalized.add(ref.revisionId);
    pinFinal(revision);
    const { materials, projects } = retainedVideoMaterials(db, ownerId, revision);
    for (const project of projects) pinFinal(project);
    for (const { source } of materials) {
      if ("blobId" in source) finals.add(source.blobId);
      else pinFinal(source);
    }
  }
  const works = db.prepare("SELECT creation_state_json FROM works WHERE owner_id=? AND creation_state_json IS NOT NULL").all(ownerId) as { creation_state_json: string }[];
  for (const work of works) for (const group of parseCreationState(work).groups) for (const item of group.items) {
    for (const source of [item.approved, item.draft]) if (source?.kind === "artifact_revision") pinDraft(source);
  }
  // 刚创建的新修订也可能使用一个月前的同字节文件；按两个年龄中较新者保留。
  const recent = db.prepare(`SELECT r.artifact_id AS artifactId,r.id AS revisionId FROM artifacts a JOIN artifact_revisions r ON r.artifact_id=a.id
    WHERE a.owner_id=? AND (r.created_at>=? OR (a.work_id IS NULL AND a.head_revision_id=r.id)) AND a.kind NOT IN ('script','analysis','prompt')`)
    .all(ownerId, cutoff) as RevisionRef[];
  for (const revision of recent) pinDraft(revision);
  // 只有在途运行的冻结输入与产出受保护：账单对账只读写 SQLite、不读这些文件，
  // 未对账状态不应阻止终态运行的超龄草稿释放磁盘。
  const active = db.prepare(`SELECT r.id,s.spec_json FROM production_runs r JOIN production_snapshots s ON s.id=r.snapshot_id
    WHERE r.owner_id=? AND r.state IN ('queued','running','unknown','cancel_requested')`).all(ownerId) as { id: string; spec_json: string }[];
  const frozenRefs = db.prepare("SELECT DISTINCT key,atom FROM json_tree(?) WHERE key IN ('blobId','revisionId') AND type='text'");
  const revisionOwner = db.prepare("SELECT a.id FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE r.id=? AND a.owner_id=?");
  const outputs = db.prepare(`SELECT output_blob_id AS id FROM production_operations WHERE run_id=? AND output_blob_id IS NOT NULL
    UNION SELECT o.blob_id FROM production_attempt_outputs o JOIN production_attempts a ON a.id=o.attempt_id WHERE a.run_id=? AND o.blob_id IS NOT NULL`);
  for (const run of active) {
    for (const row of frozenRefs.all(run.spec_json) as { key: string; atom: string }[]) {
      if (row.key === "blobId") drafts.add(row.atom);
      else {
        const artifact = revisionOwner.get(row.atom, ownerId) as { id: string } | undefined;
        if (artifact) pinDraft({ artifactId: artifact.id, revisionId: row.atom });
      }
    }
    for (const output of outputs.all(run.id, run.id) as { id: string }[]) drafts.add(output.id);
  }
  return { finals, drafts };
}

function storagePlan(db: AgentDatabase, ownerId: string, cutoff: string) {
  const { finals, drafts } = protectedBlobs(db, ownerId, cutoff);
  const rows = db.prepare(`SELECT b.id,b.digest,b.size_bytes,b.created_at, EXISTS(SELECT 1 FROM production_blobs other
    WHERE other.digest=b.digest AND other.owner_id<>b.owner_id AND other.purged_at IS NULL) AS shared
    FROM production_blobs b WHERE b.owner_id=? AND b.purged_at IS NULL`).all(ownerId) as LiveBlob[];
  const groups = new Map<string, { bytes: number; final: boolean; keep: boolean; shared: boolean }>();
  const candidates: string[] = [];
  for (const row of rows) {
    const group = groups.get(row.digest) ?? { bytes: row.size_bytes, final: false, keep: false, shared: Boolean(row.shared) };
    group.final ||= finals.has(row.id);
    if (finals.has(row.id) || drafts.has(row.id) || row.created_at >= cutoff) group.keep = true;
    else candidates.push(row.id);
    groups.set(row.digest, group);
  }
  const revision = db.prepare("SELECT revision FROM storage_cleanups WHERE owner_id=?").pluck().get(ownerId) as number | undefined;
  const usage: StorageUsage = { revision: revision ?? 0, finalBytes: 0, draftBytes: 0, reclaimableBytes: 0 };
  const files: string[] = [];
  for (const [digest, group] of groups) {
    if (group.final) usage.finalBytes += group.bytes;
    else usage.draftBytes += group.bytes;
    if (!group.keep && !group.shared) { usage.reclaimableBytes += group.bytes; files.push(digest); }
  }
  return { usage, candidates, files };
}

export class MediaRetention {
  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs, private readonly clock: AgentClock,
    private readonly days: number) {}

  usage(ownerId: string): StorageUsage {
    return this.db.transaction(() => storagePlan(this.db, ownerId, this.cutoff(this.clock())).usage)();
  }

  sweepUnpinnedDraftBlobs(ownerId: string, command?: CleanupStorage): StorageCleanupReceipt {
    const db = this.db, now = this.clock(), cutoff = this.cutoff(now);
    const key = command ? { ownerId, operation: "cleanupStorage", targetId: ownerId, commandId: command.commandId } : null;
    return this.blobs.withArchive(stage => {
      if (key && command) {
        const replay = checkCommandReceipt<StorageCleanupReceipt>(db, key, command);
        if (replay.kind === "replay") return replay.receipt;
      }
      const plan = storagePlan(db, ownerId, cutoff);
      if (command && command.expectedRevision !== plan.usage.revision) throw new AgentError("STALE_REVISION", "清理记录已更新，请刷新存储用量。");
      const mark = db.prepare("UPDATE production_blobs SET purged_at=? WHERE owner_id=? AND id=? AND purged_at IS NULL");
      for (const id of plan.candidates) mark.run(now, ownerId, id);
      let freedBytes = 0, freedFiles = 0;
      for (const digest of plan.files) {
        const bytes = stage(digest);
        if (bytes !== null) { freedFiles++; freedBytes += bytes; }
      }
      if (command || plan.candidates.length) db.prepare(`INSERT INTO storage_cleanups(owner_id,revision) VALUES(?,1)
        ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1`).run(ownerId);
      const result = { usage: storagePlan(db, ownerId, cutoff).usage, freedBytes, freedFiles };
      if (key && command) storeCommandReceipt(db, now, key, command, result);
      return result;
    });
  }

  private cutoff(now: string) { return new Date(Date.parse(now) - this.days * DAY).toISOString(); }
}
