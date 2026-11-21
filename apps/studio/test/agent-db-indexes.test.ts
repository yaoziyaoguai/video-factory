import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { withStandaloneApproval } from "../src/server/agent/creative-work.js";

async function seeded(): Promise<{ db: AgentDatabase; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-db-index-"));
  const db = openAgentDatabase(directory);
  db.prepare(`INSERT INTO conversations(id, owner_id, title, created_seq, pi_session_id, created_at, updated_at)
    VALUES ('conv-1', 'owner-1', 't', 1, 'pi-1', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`).run();
  return { db, directory };
}

function plans(db: AgentDatabase, sql: string, args: unknown[] = []): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(row => row.detail).join("\n");
}

function insertReviewConfirmation(db: AgentDatabase, row: {
  id: string; scope: "work_item" | "standalone_artifact"; action: string; subjectJson: string;
  workId?: string | null; groupId?: string | null; itemId?: string | null;
}): void {
  db.prepare(`INSERT INTO work_review_confirmations(id, owner_id, conversation_id, subject_scope, work_id, group_id, item_id, action, subject_json, source_kind, source_id, created_at)
    VALUES (?, 'owner-1', 'conv-1', ?, ?, ?, ?, ?, ?, 'user_message', ?, ?)`).run(
    row.id, row.scope, row.workId ?? null, row.groupId ?? null, row.itemId ?? null, row.action, row.subjectJson, `${row.id}-msg`, `2026-11-20T00:00:0${row.id.length % 10}.000Z`);
}

// 审计第二阶段：确认表 subject_json 内嵌键的等值查找此前是全表 json_extract 扫描；
// 迁移 v26 的表达式索引必须让这些热查询真正走上索引（EXPLAIN QUERY PLAN 可证）。
test("确认表 revisionId/artifactId 表达式索引被热查询使用", async t => {
  const { db, directory } = await seeded();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

  // 独立稿审批（creative-work.ts withStandaloneApproval）。
  const standaloneSql = `SELECT id, subject_json, created_at FROM work_review_confirmations
    WHERE subject_scope = 'standalone_artifact' AND action = 'approve' AND json_extract(subject_json, '$.artifactId') = ?
    ORDER BY rowid DESC LIMIT 1`;
  assert.match(plans(db, standaloneSql, ["artifact-1"]), /work_review_confirmations_standalone_artifact/,
    "独立稿审批查询应使用部分表达式索引");

  // listLibrary 的 finalize_video 去重关联子查询（agent-service.ts）。
  const librarySql = `SELECT rowid AS pos, conversation_id, work_id, subject_json FROM work_review_confirmations
    WHERE owner_id = ? AND subject_scope = 'work_item' AND action = 'finalize_video'
      AND rowid = (SELECT MIN(f2.rowid) FROM work_review_confirmations f2
                   WHERE f2.owner_id = work_review_confirmations.owner_id AND f2.action = 'finalize_video'
                     AND json_extract(f2.subject_json, '$.revisionId') = json_extract(work_review_confirmations.subject_json, '$.revisionId'))`;
  assert.match(plans(db, librarySql, ["owner-1"]), /work_review_confirmations_revision/,
    "listLibrary 关联子查询应使用 revisionId 表达式索引");

  // stage 确认表的同形子查询。
  const stageSql = `SELECT rowid FROM work_stage_confirmations
    WHERE rowid = (SELECT MIN(f2.rowid) FROM work_stage_confirmations f2
                   WHERE json_extract(f2.subject_json, '$.revisionId') = json_extract(work_stage_confirmations.subject_json, '$.revisionId'))`;
  assert.match(plans(db, stageSql), /work_stage_confirmations_revision/,
    "stage 确认子查询应使用 revisionId 表达式索引");
});

test("withStandaloneApproval 语义不变：同稿多次审批取最新一条", async t => {
  const { db, directory } = await seeded();
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

  insertReviewConfirmation(db, { id: "c-old", scope: "standalone_artifact", action: "approve",
    subjectJson: JSON.stringify({ kind: "artifact_revision", artifactId: "artifact-1", revisionId: "rev-old" }) });
  insertReviewConfirmation(db, { id: "c-new", scope: "standalone_artifact", action: "approve",
    subjectJson: JSON.stringify({ kind: "artifact_revision", artifactId: "artifact-1", revisionId: "rev-new" }) });
  insertReviewConfirmation(db, { id: "c-other", scope: "standalone_artifact", action: "approve",
    subjectJson: JSON.stringify({ kind: "artifact_revision", artifactId: "artifact-2", revisionId: "rev-x" }) });

  const approved = withStandaloneApproval(db, { kind: "script", workId: null, id: "artifact-1" } as never);
  assert.equal(approved.standaloneApproval?.revisionId, "rev-new");
  const unapproved = withStandaloneApproval(db, { kind: "script", workId: null, id: "artifact-3" } as never);
  assert.equal(unapproved.standaloneApproval, undefined);
});
