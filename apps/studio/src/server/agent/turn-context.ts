import { stmt, type AgentDatabase } from "./db.js";
import type { RequestRow } from "./conversation-store.js";
import { projectProposal, productionAudioFacts, type AudioInputs, type ProposalRow } from "./artifact-store.js";
import { parseStoredQuery } from "./material-store.js";
import type { MaterialBatchIndexItem, ProductionSpec } from "../../shared/agent/generated/contracts.js";

import { contextIndexColumns, contextProductionIndex, type ContextIndexRow } from "./production-index.js";
import { enabledStockServices } from "./stock-providers.js";

export const confirmationWorkQuery = `SELECT work_id FROM (
  SELECT work_id FROM work_review_confirmations WHERE subject_scope='work_item' AND source_kind='user_message' AND source_id=@sourceId
  UNION ALL SELECT work_id FROM work_stage_confirmations WHERE source_kind='user_message' AND source_id=@sourceId
) LIMIT 1`;

type ContextMessage = { references_json: string; target_json: string | null; feedback_json: string | null;
  library_selections_json: string | null; review_context_json: string | null; review_confirmation_json: string | null };

export function readTurnEnvelope(db: AgentDatabase, requestId: string, sourceId: string, epoch: number) {
  const row = stmt(db, `SELECT r.id,r.owner_id,r.conversation_id,r.message_id,r.target_json AS request_target,r.delivery_closed,
      m.references_json,m.target_json,m.feedback_json,m.library_selections_json,m.review_context_json,m.review_confirmation_json,${contextIndexColumns},
      (SELECT json_group_array(json_object('id',service_id,'enabled',json_extract(config_json,'$.enabled'),'configured',api_key IS NOT NULL))
        FROM free_service_settings) AS services,
      (${confirmationWorkQuery}) AS confirmed_work,
      (SELECT json_group_array(DISTINCT proposal_id) FROM tool_invocations
        WHERE request_id=r.id AND proposal_id IS NOT NULL) AS prepared,
      (SELECT json_group_array(DISTINCT l.artifact_id) FROM production_input_locks l
        JOIN production_runs run ON run.id=l.run_id WHERE run.conversation_id=r.conversation_id) AS locks,
      (SELECT json_group_array(json_object('work',p.work_id,'source_key',p.source_key,'path',p.path))
        FROM library_input_preparations p JOIN works w ON w.id=p.work_id WHERE w.conversation_id=r.conversation_id) AS inputs,
      (SELECT json_group_array(json_object('batchId',id,'requestId',request_id,'messageId',message_id,
        'query',query_json,'retrievedAt',retrieved_at,'resultCount',json_array_length(results_json))) FROM
        (SELECT id,request_id,message_id,query_json,retrieved_at,results_json FROM material_search_batches
         WHERE conversation_id=r.conversation_id ORDER BY created_at DESC,rowid DESC LIMIT 100)) AS batches
    FROM requests r JOIN messages m ON m.id=@sourceId AND m.conversation_id=r.conversation_id
    WHERE r.id=@requestId AND r.execution_epoch=@epoch AND r.state='running' AND r.stop_requested=0`)
    .get({ requestId, sourceId, epoch }) as (ContextMessage & ContextIndexRow & Pick<RequestRow, "id" | "owner_id" | "message_id" | "delivery_closed"> &
      { conversation_id: string; services: string; request_target: string | null; confirmed_work: string | null; prepared: string; locks: string; inputs: string; batches: string }) | undefined;
  if (!row) return null;
  return {
    request: { ...row, target_json: row.request_target }, message: row,
    productionIndex: contextProductionIndex(row, row.conversation_id),
    services: enabledStockServices(JSON.parse(row.services) as { id: string; enabled: boolean; configured: boolean }[]),
    confirmedWork: row.confirmed_work, prepared: JSON.parse(row.prepared) as string[], locks: JSON.parse(row.locks) as string[],
    inputs: JSON.parse(row.inputs) as { work: string; source_key: string; path: string }[],
    batches: (JSON.parse(row.batches) as (Omit<MaterialBatchIndexItem, "query"> & { query: string })[])
      .map(batch => ({ ...batch, query: parseStoredQuery(batch.query) })),
  };
}

// 只沿冻结提案实际用到的输入和更早的生产记录取声音证据。SQLite 在一次读取中递归，
// 后面的声音判断与制作索引、作品库共用 productionAudioFacts。
function batchAudioInputs(db: AgentDatabase, ownerId: string, conversationId: string, proposalIds: string[]): AudioInputs {
  const results = stmt(db, `WITH RECURSIVE specs(spec,ord) AS (
    SELECT p.spec_json,coalesce(r.rowid,9007199254740991) FROM json_each(@ids) k JOIN proposals p ON p.id=k.value
      LEFT JOIN production_runs r ON r.id=p.accepted_run_id WHERE p.conversation_id=@conversationId AND p.owner_id=@ownerId
    UNION
    SELECT s.spec_json,r.rowid FROM specs f JOIN json_each(f.spec,'$.operations') op JOIN json_each(op.value,'$.inputs') i
      LEFT JOIN artifact_revisions a ON a.id=json_extract(i.value,'$.revisionId') AND a.artifact_id=json_extract(i.value,'$.artifactId')
      JOIN production_operations o ON o.output_blob_id=coalesce(json_extract(i.value,'$.blobId'),json_extract(a.content_json,'$.blobId'))
      JOIN production_runs r ON r.id=o.run_id AND r.rowid<f.ord AND (a.run_id IS NULL OR r.id=a.run_id)
      JOIN production_snapshots s ON s.id=r.snapshot_id WHERE r.owner_id=@ownerId
  ), inputs AS MATERIALIZED (
    SELECT DISTINCT json_extract(i.value,'$.blobId') AS blob,a.id AS rev,a.artifact_id,a.content_json,a.run_id
      FROM specs f JOIN json_each(f.spec,'$.operations') op JOIN json_each(op.value,'$.inputs') i
      LEFT JOIN artifact_revisions a ON a.id=json_extract(i.value,'$.revisionId') AND a.artifact_id=json_extract(i.value,'$.artifactId')
  ), blobs AS (SELECT coalesce(blob,json_extract(content_json,'$.blobId')) AS id FROM inputs)
  SELECT DISTINCT 'revision' AS kind,rev AS id,artifact_id AS parent,content_json AS value,run_id AS run,NULL AS ord FROM inputs WHERE rev IS NOT NULL
  UNION ALL SELECT 'duration',b.id,NULL,NULL,NULL,b.duration_ms FROM production_blobs b WHERE b.id IN (SELECT id FROM blobs)
  UNION ALL SELECT DISTINCT 'producer',o.id,o.output_blob_id,s.spec_json,r.id,r.rowid FROM specs f JOIN production_runs r ON r.rowid=f.ord
    JOIN production_snapshots s ON s.id=r.snapshot_id JOIN production_operations o ON o.run_id=r.id
    WHERE o.output_blob_id IN (SELECT id FROM blobs)`)
    .all({ ids: JSON.stringify(proposalIds), ownerId, conversationId }) as
      { kind: string; id: string; parent: string; value: string; run: string | null; ord: number | null }[];
  const revisions = new Map<string, { artifactId: string; content_json: string; run_id: string | null }>();
  const durations = new Map<string, number | null>();
  const producers = new Map<string, { id: string; run_id: string; run_order: number; spec_json: string }[]>();
  for (const row of results) {
    if (row.kind === "revision") revisions.set(row.id, { artifactId: row.parent, content_json: row.value, run_id: row.run });
    if (row.kind === "duration") durations.set(row.id, row.ord);
    if (row.kind === "producer") {
      const list = producers.get(row.parent) ?? [];
      list.push({ id: row.id, run_id: row.run!, run_order: row.ord!, spec_json: row.value });
      producers.set(row.parent, list);
    }
  }
  return {
    revision: (artifactId, revisionId) => { const row = revisions.get(revisionId); return row?.artifactId === artifactId ? row : undefined; },
    duration: blobId => durations.get(blobId) ?? null,
    producers: (blobId, before, runId) => (producers.get(blobId) ?? []).filter(p => p.run_order < before && (runId === null || p.run_id === runId)),
  };
}

export function referencedTurnProposals(db: AgentDatabase, ownerId: string, conversationId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = stmt(db, `SELECT p.*,r.rowid AS accepted_ordinal FROM json_each(?) k JOIN proposals p ON p.id=k.value
    LEFT JOIN production_runs r ON r.id=p.accepted_run_id WHERE p.owner_id=? AND p.conversation_id=? ORDER BY k.key`)
    .all(JSON.stringify(ids), ownerId, conversationId) as (ProposalRow & { accepted_ordinal: number | null })[];
  const proposals = rows.map(row => {
    const spec = JSON.parse(row.spec_json) as ProductionSpec;
    const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId);
    return { row, spec, mixed: final?.kind === "render" && final.parameters.assembly === "mixed_concat" };
  });
  const mixedIds = proposals.filter(p => p.mixed).map(p => p.row.id);
  const audio = mixedIds.length ? batchAudioInputs(db, ownerId, conversationId, mixedIds) : undefined;
  return proposals.map(({ row, spec, mixed }) => projectProposal(row, spec,
    mixed ? productionAudioFacts(db, spec, row.accepted_ordinal ?? Number.MAX_SAFE_INTEGER, audio).audioSummary : undefined, null));
}
