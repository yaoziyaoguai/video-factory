import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assembleOfflineAgent, type OfflineAgentAssembly } from "../src/server/agent/offline.js";
import { SCENARIO_REVISE, SCENARIO_WORK_DEMO } from "../src/server/agent/offline-scenario.js";
import type { MessageInput } from "../src/shared/agent/generated/contracts.js";

// UIUX-10 演示口令全链路：离线装配（fauxScenario + 媒体替身）里发送口令，
// 断言真实业务工具在隔离库建出三件对齐作品、可播放样片成片与静音 v2 修订。

const origin = "http://127.0.0.1:4500";
const input = (text: string, extra: Partial<MessageInput> = {}): MessageInput => ({
  commandId: `cmd-${crypto.randomUUID()}`, text, target: null, skillId: null, proposalRef: null,
  mode: "new", steerRequestId: null, ...extra,
});

async function waitFor(check: () => boolean, ms = 10000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("等待业务请求完成超时");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("UIUX-10 演示口令全链路：三件作品、样片成片与静音修订真实落库", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "frame-offline-demo-"));
  const a = await assembleOfflineAgent({ dataDir, uiOrigin: origin, fauxScenario: true, media: {} });
  t.after(async () => { await a.close(); await rm(dataDir, { recursive: true, force: true }); });
  const id = a.service.createConversation("local-owner", { commandId: `cmd-${crypto.randomUUID()}`, title: "演示" }).conversation.id;

  await a.service.sendMessage("local-owner", id, input(SCENARIO_WORK_DEMO));
  await waitFor(() => !a.database.prepare("SELECT id FROM requests WHERE conversation_id=? AND state IN ('queued','running')").get(id));

  const snapshot = a.service.snapshot("local-owner", id);
  assert.deepEqual(snapshot.works.map(work => work.title).sort(), ["咖啡手记", "城市夜色", "山径晨光"]);
  // 审阅组如交付所述：两件带 content+video，城市夜色只有 content。
  const rolesByWork = new Map(snapshot.works.map(work => [work.title,
    work.reviewGroups.flatMap(group => group.items.map(item => item.role)).sort()]));
  assert.deepEqual(rolesByWork.get("山径晨光"), ["content", "video"]);
  assert.deepEqual(rolesByWork.get("城市夜色"), ["content"]);
  assert.deepEqual(rolesByWork.get("咖啡手记"), ["content", "video"]);

  // 样片种子按本地运行输出登记：1 条 succeeded 演示运行 + 4 个操作槽，不产生顶层演示样片产物。
  const revisionContent = (revisionId: string) =>
    JSON.parse((a.database.prepare("SELECT content_json FROM artifact_revisions WHERE id=?")
      .get(revisionId) as { content_json: string }).content_json) as { blobId: string; durationMs: number; sources?: { licenseName: string }[] };
  const artifactRow = (title: string) =>
    a.database.prepare("SELECT id, head_revision_id FROM artifacts WHERE conversation_id=? AND title=?").get(id, title) as { id: string; head_revision_id: string };
  const run = a.database.prepare("SELECT id, state FROM production_runs WHERE conversation_id=? AND title=?")
    .get(id, "离线演示样片准备") as { id: string; state: string } | undefined;
  assert.ok(run, "缺少演示样片运行");
  assert.equal(run.state, "succeeded");
  const operations = a.database.prepare("SELECT id, spec_json, state, output_blob_id FROM production_operations WHERE run_id=?")
    .all(run.id) as { id: string; spec_json: string; state: string; output_blob_id: string }[];
  assert.equal(operations.length, 4);
  assert.equal(operations.some(operation => !operation.output_blob_id || operation.state !== "succeeded"), false);
  const blobBySlot = new Map(operations.map(operation => [(JSON.parse(operation.spec_json) as { outputSlot: string }).outputSlot, operation.output_blob_id]));
  assert.deepEqual([...blobBySlot.keys()].sort(), ["coffee", "coffee_silent", "trail", "trail_silent"]);
  const straySeeds = a.database.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE conversation_id=? AND title LIKE '演示样片%'").get(id) as { n: number };
  assert.equal(straySeeds.n, 0, "演示种子不得以顶层产物出现，否则会劫持快照自动选中");
  const origins = a.database.prepare(
    `SELECT COUNT(*) AS n FROM artifact_revisions r JOIN artifacts a ON a.id = r.artifact_id
    WHERE a.conversation_id=? AND r.origin_kind='user_upload'`,
  ).get(id) as { n: number };
  assert.equal(origins.n, 0);
  for (const script of ["山径晨光 · 脚本", "城市夜色 · 脚本", "咖啡手记 · 脚本"]) assert.ok(artifactRow(script), `缺少 ${script}`);

  const cut = artifactRow("山径晨光 · 成片 v1");
  assert.ok(cut);
  const coffeeCut = artifactRow("咖啡手记 · 成片 v1");
  assert.ok(coffeeCut);
  const v1 = revisionContent(cut.head_revision_id);
  assert.equal(v1.blobId, blobBySlot.get("trail"), "成片 v1 字节来自演示运行的有声样片操作槽");
  assert.equal(v1.durationMs, 20000);
  assert.equal(v1.sources?.[0]?.licenseName, "本机演示样片（见 SOURCES.md）",
    "运行输出未沿发布修订携带署名时，应回退读取 blob 级素材来源");
  // blob 内容路由可播放：回真实 mp4 字节与类型。
  const blob = a.database.prepare("SELECT digest, size_bytes FROM production_blobs WHERE id=?").get(v1.blobId) as { digest: string; size_bytes: number };
  const response = await a.app.inject({ method: "GET", url: `/api/agent/v1/blobs/${v1.blobId}/content`, headers: { origin } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "video/mp4");
  assert.equal(response.rawPayload.length, blob.size_bytes);

  // 绑定成片 v1 发修订口令：静音孪生做 v2，字节不同、时长一致。
  await a.service.sendMessage("local-owner", id, input(SCENARIO_REVISE, {
    target: { artifactId: cut.id, revisionId: cut.head_revision_id, workId: null },
  }));
  await waitFor(() => !a.database.prepare("SELECT id FROM requests WHERE conversation_id=? AND state IN ('queued','running')").get(id));
  const revised = artifactRow("山径晨光 · 成片 · 静音版");
  assert.equal(revised.id, cut.id, "修订落在原成片产物上，只推头修订");
  const v2 = revisionContent(revised.head_revision_id);
  assert.equal(v2.blobId, blobBySlot.get("trail_silent"));
  assert.notEqual(v2.blobId, v1.blobId, "两版必须指向不同字节，编辑差异可证明");
  assert.equal(v2.durationMs, v1.durationMs);
});
