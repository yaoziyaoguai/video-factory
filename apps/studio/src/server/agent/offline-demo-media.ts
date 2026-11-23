import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { recordBlobSources } from "./material-store.js";
import { insertEvent } from "./event-log.js";
import { canonicalJson, digestOf, newAgentId, type AgentClock } from "./util.js";
import type { LocalCreationSpec, LocalRenderOperation } from "../../shared/agent/generated/contracts.js";

// 离线演示口令的内置样片：按本地运行输出落库（1 条 succeeded production_run + 4 个操作槽），
// 不再插入顶层 artifacts，避免演示种子劫持快照自动选中或污染会话产物列表；
// 出处如实标注为本机演示样片，不冒充模型产物；同会话按运行标题幂等，跨会话共享字节。
// 样片清单与制作者声明见 src/client/agent/preview/assets/SOURCES.md，实测时长均为 20.000s。

export interface DemoSeedRef { runId: string; operationId: string; outputSlot: string }
export interface DemoMediaSeeds { trail: DemoSeedRef; trailSilent: DemoSeedRef; coffee: DemoSeedRef; coffeeSilent: DemoSeedRef }

interface DemoSample { key: keyof DemoMediaSeeds; file: string; outputSlot: string }

const DEMO_RUN_TITLE = "离线演示样片准备";

const DEMO_SAMPLES: readonly DemoSample[] = [
  { key: "trail", file: "trail-preview.mp4", outputSlot: "trail" },
  { key: "trailSilent", file: "trail-preview-silent.mp4", outputSlot: "trail_silent" },
  { key: "coffee", file: "coffee-preview.mp4", outputSlot: "coffee" },
  { key: "coffeeSilent", file: "coffee-preview-silent.mp4", outputSlot: "coffee_silent" },
];

// 离线路径不依赖 ffprobe；四条样片实测 20.000s，按实测值登记。
const DEMO_SAMPLE_DURATION_MS = 20_000;

export function seedDemoMedia(
  db: AgentDatabase, blobs: ProductionBlobs, clock: AgentClock,
  ownerId: string, conversationId: string, assetsRoot: string,
): DemoMediaSeeds {
  const seeds = {} as Record<keyof DemoMediaSeeds, DemoSeedRef>;
  db.transaction(() => {
    const run = db.prepare(
      "SELECT id FROM production_runs WHERE conversation_id = ? AND owner_id = ? AND title = ?",
    ).get(conversationId, ownerId, DEMO_RUN_TITLE) as { id: string } | undefined;
    if (run) {
      const operations = db.prepare("SELECT id, spec_json FROM production_operations WHERE run_id = ?")
        .all(run.id) as { id: string; spec_json: string }[];
      for (const operation of operations) {
        const slot = (JSON.parse(operation.spec_json) as { outputSlot: string }).outputSlot;
        const key = DEMO_SAMPLES.find(sample => sample.outputSlot === slot)?.key;
        if (key) seeds[key] = { runId: run.id, operationId: operation.id, outputSlot: slot };
      }
      const missing = DEMO_SAMPLES.filter(sample => !seeds[sample.key]);
      if (missing.length) throw new Error(`演示样片运行不完整，缺少槽位：${missing.map(sample => sample.outputSlot).join("、")}`);
      return;
    }
    const workId = (db.prepare(
      "SELECT id FROM works WHERE conversation_id = ? AND owner_id = ? ORDER BY rowid LIMIT 1",
    ).get(conversationId, ownerId) as { id: string } | undefined)?.id;
    if (!workId) throw new Error("演示样片运行需要先建立作品（start_work）再播种，当前会话没有作品。");
    // 演示样片只是登记好的本机字节，不声明真实合成语义；静音装配让声音事实投影为空。
    const renderOperation = (sample: DemoSample): LocalRenderOperation => ({
      operationId: sample.outputSlot, outputSlot: sample.outputSlot, inputs: [],
      kind: "render", model: null,
      parameters: { format: "mp4", width: 1280, height: 720, fps: 30, assembly: "ordered_concat", audioMode: "none" },
      target: { groupId: "demo-seed", itemId: sample.outputSlot, baseRevisionId: null },
    });
    const operations: LocalCreationSpec["operations"] = [renderOperation(DEMO_SAMPLES[0]!), ...DEMO_SAMPLES.slice(1).map(renderOperation)];
    const spec: LocalCreationSpec = {
      type: "local_creation", workId, title: DEMO_RUN_TITLE,
      requestSource: { requestId: "demo-sample-seed", messageId: "demo-sample-seed" },
      scope: "离线演示样片准备：本机样片按运行输出登记，供演示成片引用（见 SOURCES.md）",
      purpose: "production", inputSources: [], reviewInputs: [],
      operations,
      finalOutput: { operationId: DEMO_SAMPLES[0]!.outputSlot, outputSlot: DEMO_SAMPLES[0]!.outputSlot },
    };
    const now = clock();
    const runId = newAgentId("run"), snapshotId = newAgentId("snp");
    db.prepare("INSERT INTO production_snapshots(id,spec_json,digest,created_at) VALUES(?,?,?,?)")
      .run(snapshotId, canonicalJson(spec), digestOf(spec), now);
    const seq = (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM production_runs WHERE conversation_id=?")
      .get(conversationId) as { n: number }).n;
    db.prepare(
      `INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,proposal_id,source_request_id,title,frozen_target_json,state,created_seq,created_at,updated_at)
      VALUES(?,?,?,?,?,NULL,NULL,?,NULL,'succeeded',?,?,?)`,
    ).run(runId, ownerId, conversationId, workId, snapshotId, DEMO_RUN_TITLE, seq, now, now);
    for (const [index, sample] of DEMO_SAMPLES.entries()) {
      const bytes = readFileSync(path.join(assetsRoot, sample.file));
      const blob = blobs.persist(ownerId, conversationId, bytes, "video/mp4", DEMO_SAMPLE_DURATION_MS);
      recordBlobSources(db, blob.id, [{
        provider: "user_upload",
        assetId: blob.digest,
        sourceUrl: `/api/agent/v1/blobs/${blob.id}/content`,
        creatorName: null, creatorUrl: null, licenseUrl: null,
        licenseName: "本机演示样片（见 SOURCES.md）", acquiredAt: now, title: DEMO_RUN_TITLE,
      }]);
      db.prepare(
        "INSERT INTO production_operations(run_id,id,spec_json,state,output_blob_id) VALUES(?,?,?,'succeeded',?)",
      ).run(runId, sample.outputSlot, canonicalJson(operations[index]), blob.id);
      seeds[sample.key] = { runId, operationId: sample.outputSlot, outputSlot: sample.outputSlot };
    }
    insertEvent(db, now, { ownerId, conversationId, kind: "run.changed", entityId: runId, entityVersion: 1, notification: "quiet" });
    db.prepare("UPDATE conversations SET revision=revision+1,updated_at=? WHERE id=?").run(clock(), conversationId);
  })();
  return seeds;
}
