import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS, openAgentDatabase, type AgentDatabase } from "../src/server/agent/db.js";
import { assembleOfflineAgent } from "../src/server/agent/offline.js";
import {productionHarness} from "./helpers/production-harness.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { getRequestRow, insertQueuedRequest, saveAssistantMessage, storeCommandReceipt } from "../src/server/agent/conversation-store.js";
import { withStandaloneApproval } from "../src/server/agent/creative-work.js";
import { StudioAccountsStore } from "../src/server/agent/studio-accounts.js";
import { createPasswordHash } from "../src/server/auth.js";

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

test("NEW-02/06 v33 账号身份、修订与原命令回执迁移到 v34", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-accounts-v33-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = "2026-11-22T00:00:00.000Z", old = openAgentDatabase(directory);
  const password = "original-account-fixture";
  const hash = createPasswordHash(password);
  const metadata = { username: "member", role: "creator" as const, commandId: "old-create", expectedRevision: 1 };
  old.transaction(() => {
    old.exec("DROP TABLE studio_account_settings; ALTER TABLE studio_users DROP COLUMN disabled_at; ALTER TABLE studio_users DROP COLUMN session_version");
    old.prepare("DELETE FROM agent_schema_migrations WHERE version=34").run();
    const add = old.prepare("INSERT INTO studio_users VALUES(?,?,?,?)");
    add.run("admin", "admin", "admin", hash);
    add.run("usr-member", "member", "creator", hash);
    storeCommandReceipt(old, now, { ownerId: "admin", operation: "createStudioAccount", targetId: "team", commandId: metadata.commandId }, metadata, {
      revision: 2, accounts: [{id: "admin", username: "admin", role: "admin"}, {id: "usr-member", username: "member", role: "creator"}],
    });
  })();
  old.close();
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const store = new StudioAccountsStore(db, () => now);
  assert.equal(store.list().revision, 3);
  assert.equal(store.find("member")?.sessionVersion, 0);
  const updated = await store.update("admin", "member", { commandId: "rotate", expectedRevision: 3, password: "updated-account-fixture" }, () => true);
  assert.equal(updated.revision, 4);
  const oldReceipt = await store.create("admin", { ...metadata, password }, () => true);
  assert.equal(oldReceipt.revision, 2);
  assert.deepEqual(oldReceipt.accounts[1], { id: "usr-member", username: "member", role: "creator", disabledAt: null });
  assert.equal(store.list().revision, 4);
  await assert.rejects(store.create("admin", { ...metadata, password: "updated-account-fixture" }, () => true), { code: "IDEMPOTENCY_CONFLICT" });
});

test("CAP-07 v32 迁移只把未结算的供应商尝试排队，并命中三个索引", async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"frame-ledger-v32-")),time="2026-11-01T12:00:00.000Z";
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const pending=productionHarness(directory,time,undefined,false,{owner:"creator-1",conversation:"invoice-1",billing:null});
  const settled=productionHarness(directory,time,undefined,false,{owner:"creator-2",conversation:"invoice-2"});
  let keep="";
  try {
    for(const h of [settled,pending]){
      const id=h.accept().run.id;
      if(h===pending)keep=id;
      for(let i=0;i<6 && h.db.prepare("SELECT state FROM production_runs WHERE id=?").pluck().get(id)!=="succeeded";i++)await h.worker.pollOnce();
    }
  }finally{await settled.close();await pending.close();}
  const old=new Database(path.join(directory,"agent.db"));
  assert.deepEqual(old.prepare("SELECT a.run_id FROM pending_reconciliation q JOIN production_attempts a ON a.id=q.attempt_id").pluck().all(),[keep]);
  old.transaction(()=>{
    old.exec("DROP INDEX production_attempts_provider_task; DROP INDEX production_runs_budget_owner; DROP TABLE pending_reconciliation; DROP TABLE budget_policies; DROP TABLE studio_account_settings; DROP TABLE studio_users; ALTER TABLE production_attempts DROP COLUMN usage_json");
    old.prepare("DELETE FROM agent_schema_migrations WHERE version>=33").run();
  })();
  old.close();
  const db=openAgentDatabase(directory);t.after(()=>db.close());
  assert.deepEqual(db.prepare("SELECT a.run_id FROM pending_reconciliation q JOIN production_attempts a ON a.id=q.attempt_id").pluck().all(),[keep]);
  assert.deepEqual(db.prepare("SELECT owner_id FROM conversations ORDER BY rowid").pluck().all(),["creator-1","creator-2"]);
  for(const [sql,params,index] of [
    ["SELECT attempt_id FROM pending_reconciliation WHERE due_at<=? ORDER BY due_at", [time],"pending_reconciliation_due"],
    ["SELECT id FROM production_attempts WHERE provider_task_id=?",["task"],"production_attempts_provider_task"],
    ["SELECT id FROM production_runs WHERE owner_id=? AND proposal_id IS NOT NULL AND created_at>=?",["creator-1",time],"production_runs_budget_owner"]
  ] as const){
    const plan=plans(db,sql,[...params]);assert.ok(plan.includes(index),plan);t.diagnostic(plan);
  }
});

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

test("ISS-09 五个热查询走索引；万行库快照和助手落库、五千文件清扫实测", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-index-throughput-"));
  const app = await assembleOfflineAgent({ dataDir: directory, uiOrigin: "http://127.0.0.1:4399" });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const db = app.database, owner = "local-owner", time = new Date().toISOString();
  const c = app.service.createConversation(owner, { commandId: "measure", title: "长会话索引" }).conversation.id;
  const blobs = new ProductionBlobs(db, directory, () => time);
  for (const [sql, args, index] of [
    ["SELECT * FROM production_blobs WHERE owner_id=? AND conversation_id=? AND digest=?", [owner,c,"d"], "idx_production_blobs_scope_digest"],
    ["SELECT 1 FROM production_blobs WHERE digest=?", ["d"], "idx_production_blobs_digest"],
    ["SELECT DISTINCT proposal_id FROM tool_invocations WHERE request_id=? AND proposal_id IS NOT NULL", ["req-last"], "idx_tool_invocations_request"],
    ["SELECT id FROM material_search_batches WHERE request_id=? ORDER BY created_at,rowid", ["req-last"], "idx_material_search_batches_request"],
    ["SELECT id,artifact_id FROM artifact_revisions WHERE run_id=?", ["run-last"], "idx_artifact_revisions_run"],
  ] as const) {
    const plan = plans(db, sql, [...args]);
    assert.match(plan, new RegExp(`SEARCH .*USING (?:COVERING )?INDEX ${index}`), plan);
    t.diagnostic(plan.replaceAll("\n", " / "));
  }
  assert.match(plans(db, "SELECT DISTINCT digest FROM production_blobs"), /USING COVERING INDEX idx_production_blobs_digest/);
  assert.match(plans(db, "SELECT id FROM production_blobs WHERE owner_id=? AND created_at<? AND purged_at IS NULL", [owner,time]), /SEARCH .*USING INDEX production_blobs_live_owner_age/);
  assert.match(plans(db, "SELECT 1 FROM production_blobs WHERE digest=? AND purged_at IS NULL LIMIT 1", ["d"]), /SEARCH .*USING (?:COVERING )?INDEX production_blobs_live_digest/);
  const putArt = db.prepare(`INSERT INTO artifacts(id,owner_id,conversation_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at)
    VALUES (?,?,?,'稿件','script',?,100,?,?,?)`);
  const putRev = db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,request_id,run_id,digest,content_json,created_at) VALUES (?,?,?,?,?,?,?,?)");
  const putTool = db.prepare(`INSERT INTO tool_invocations(owner_id,request_id,tool_call_id,tool_name,args_digest,args_json,state,created_at,updated_at)
    VALUES (?,?,?,'read_artifact','d','{}','committed',?,?)`);
  const putBlob = db.prepare("INSERT INTO production_blobs(id,owner_id,conversation_id,digest,mime_type,size_bytes,created_at) VALUES (?,?,?,?,'application/octet-stream',?,?)");
  const content = JSON.stringify({ format: "markdown", text: "万行库实测" });
  const files: string[] = [];
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      const art = `art-${Math.floor(i / 100)}`, no = i % 100 + 1, req = `req-${i}`;
      if (no === 1) putArt.run(art, owner, c, `rev-${i + 99}`, i + 1, time, time);
      const bytes = Buffer.from(`素材-${i}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (i < 4998) { writeFileSync(blobs.filePath(digest), bytes); files.push(digest); }
      putRev.run(`rev-${i}`, art, no, req, `run-${i}`, digest, content, time);
      putTool.run(owner, req, `call-${i}`, time, time);
      putBlob.run(`blob-${i}`, owner, c, digest, bytes.length, time);
    }
  })();
  for (const table of ["tool_invocations", "artifact_revisions", "production_blobs"]) {
    assert.equal(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), 10000);
  }
  const addRequest = (i: number) => {
    insertQueuedRequest(db, time, { id: `req-${i}`, conversationId: c, ownerId: owner, commandId: `c-${i}`, text: "保存",
      target: null, skillId: null, modelId: null, queueSeq: i + 1, messageId: `input-${i}` });
    return getRequestRow(db, owner, `req-${i}`)!;
  };
  const snapshotMs: number[] = [], saveMs: number[] = [];
  for (let i = 0; i < 12; i++) {
    const request = addRequest(i);
    const begin = performance.now();
    const page = app.service.snapshot(owner, c);
    const middle = performance.now();
    db.transaction(() => saveAssistantMessage(db, time, request, "已核对", "completed"))();
    const end = performance.now();
    assert.equal(page.artifacts.items.length, 50);
    assert.equal(db.prepare("SELECT text FROM messages WHERE request_id=?").pluck().get(request.id), "已核对");
    if (i >= 2) { snapshotMs.push(middle - begin); saveMs.push(end - middle); }
  }
  const orphan = blobs.filePath("e".repeat(64)), fresh = blobs.filePath("f".repeat(64));
  writeFileSync(orphan, "old"); writeFileSync(fresh, "new");
  utimesSync(orphan, new Date(0), new Date(0));
  const start = performance.now();
  const deleted = await blobs.sweepOrphans();
  const sweepMs = performance.now() - start;
  assert.deepEqual(deleted, { files: 1, bytes: 3 });
  assert.equal(existsSync(orphan), false);
  assert.ok(existsSync(fresh) && existsSync(blobs.filePath(files[0]!)));
  const p95 = (values: number[]) => [...values].sort((a,b) => a-b)[Math.ceil(0.95 * values.length) - 1]!;
  t.diagnostic(JSON.stringify({ rowsPerTable: 10000, diskFiles: 5000, snapshotMs, saveMs, sweepMs }));
  assert.ok(p95(snapshotMs) < 5, `快照 P95 ${p95(snapshotMs)} ms`);
  assert.ok(p95(saveMs) < 5, `助手落库 P95 ${p95(saveMs)} ms`);
  assert.ok(sweepMs < 50, `5000 个真实文件扫描耗时 ${sweepMs} ms`);
});

test("ISS-12 v27 历史导入、工具与显式交付的来源按修订身份回填", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-origin-v27-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = new Database(path.join(directory, "agent.db"));
  const now = "2026-11-22T00:00:00.000Z";
  old.exec("CREATE TABLE agent_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const migration of MIGRATIONS.filter(m => m.version <= 27)) old.transaction(() => {
    for (const statement of migration.statements) old.exec(statement);
    migration.data?.(old);
    old.prepare("INSERT INTO agent_schema_migrations VALUES (?,?)").run(migration.version, now);
  })();
  old.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES ('c','o','旧稿',1,'pi',?,?)").run(now, now);
  insertQueuedRequest(old, now, { id: "req-1", ownerId: "o", conversationId: "c", commandId: "cmd", text: "旧稿",
    skillId: null, target: null, modelId: null, queueSeq: 1, messageId: "user" });
  const categories = ["import","project","dub","delivery","run","regular"];
  const refs = categories.map(id => ({ artifactId: "art-" + id, revisionId: id }));
  for (const [i,ref] of refs.entries()) {
    old.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,created_seq,created_at,updated_at) VALUES (?,'c','o','稿件','audio',?,?,?)")
      .run(ref.artifactId, i + 1, now, now);
    const content = i === 1 ? { format: "project" } : i < 4 ? { format: "media", dub: {} } : { format: "markdown" };
    old.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,request_id,run_id,digest,content_json,created_at) VALUES (?,?,1,'req-1',?,'same',?,?)")
      .run(ref.revisionId, ref.artifactId, i === 4 ? "run-1" : null, JSON.stringify(content), now);
  }
  old.prepare("INSERT INTO request_deliveries VALUES ('req-1','d','rc',?,?)").run(JSON.stringify({ revisions: [refs[3]] }), now);
  const insert = old.prepare(`INSERT INTO messages(id,conversation_id,owner_id,request_id,role,kind,state,text,references_json,library_selections_json,created_seq,created_at,updated_at)
    VALUES (?,'c','o','req-1',?,'chat','completed','原文',?,?,?,?,?)`);
  insert.run("user","user",JSON.stringify({ artifacts: [refs[0]] }),"[]",1,now,now);
  insert.run("assistant","assistant",JSON.stringify({ artifacts: refs, materialBatchIds: ["kept"] }),null,2,now,now);
  old.close();
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  assert.deepEqual(db.prepare("SELECT origin_kind FROM artifact_revisions ORDER BY rowid").pluck().all(),
    ["library_import","tool_auxiliary","tool_auxiliary","delivered","production_output","delivered"]);
  const row = db.prepare("SELECT references_json,text,revision FROM messages WHERE id='assistant'").get() as { references_json: string; text: string; revision: number };
  assert.deepEqual(JSON.parse(row.references_json), { artifacts: refs.slice(3), materialBatchIds: ["kept"] });
  assert.equal(row.text, "原文"); assert.equal(row.revision, 2);
  assert.deepEqual(JSON.parse(db.prepare("SELECT references_json FROM messages WHERE id='user'").pluck().get() as string).artifacts, [refs[0]]);
  assert.match(plans(db, "SELECT id FROM artifact_revisions WHERE request_id=? AND origin_kind IN ('delivered','production_output') ORDER BY rowid", ["req-1"]), /artifact_revisions_request/);
});
