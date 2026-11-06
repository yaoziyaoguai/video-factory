import path from "node:path";
import { openAgentDatabase } from "../../src/server/agent/db.js";
import { ProductionBlobs } from "../../src/server/agent/production-blobs.js";
import { ProductionService, type ProductionCrashHook } from "../../src/server/agent/production-service.js";
import { ProductionWorker } from "../../src/server/agent/production-worker.js";
import { FauxMediaPort } from "../../src/server/agent/faux-media.js";
import { EventHub } from "../../src/server/agent/event-log.js";
import { applyPrepareProposal, rowToProposal } from "../../src/server/agent/artifact-store.js";
import { canonicalJson, digestOf } from "../../src/server/agent/util.js";
import { OFFLINE_QUOTE_CATALOG, studioRoot } from "../../src/server/agent/offline.js";
import { bindPreparedPlan, ensurePlanStageWork, type PlanStageWork } from "./creative-work-fixture.js";

export function productionHarness(directory: string, time: string, crash?: ProductionCrashHook, render = false) {
  const db = openAgentDatabase(directory), clock = () => time, hub = new EventHub();
  const blobs = new ProductionBlobs(db, directory, clock);
  const port = new FauxMediaPort(directory, db, blobs, clock, { fixtureRoot: path.join(studioRoot, "fixtures/agent"), delayMs: 0 });
  const service = new ProductionService(db, clock, hub, () => OFFLINE_QUOTE_CATALOG, blobs, crash);
  const worker = new ProductionWorker(db, clock, hub, blobs, port, { ...(crash ? { crash } : {}) });
  const scope = { ownerId: "owner", conversationId: "conversation" };
  let proposal = db.prepare("SELECT * FROM proposals LIMIT 1").get() as Parameters<typeof rowToProposal>[0] | undefined;
  let planWork: PlanStageWork | undefined;
  if (!proposal) db.transaction(() => {
    db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES('conversation','owner','故障验证',1,'s1',?,?)").run(time, time);
    const content = { format: "markdown", text: "故障验证固定输入" };
    db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES('artifact','conversation','owner','输入','prompt','revision',1,1,?,?)").run(time, time);
    db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,created_at) VALUES('revision','artifact',1,?,?,?)").run(digestOf(content), canonicalJson(content), time);
    // B04：视频提案须落在已进入方案阶段的事项内，受理另需方案主稿关联。
    planWork = ensurePlanStageWork(db, time, scope, "故障验证");
    const result = applyPrepareProposal(db, time, scope, {
      workId: planWork.workId, title: "故障验证", inputRevisions: [{ artifactId: "artifact", revisionId: "revision" }],
      operations: [{ operationId: "video", outputSlot: "clip", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
        inputs: [{ kind: "artifact_revision", artifactId: "artifact", revisionId: "revision", digest: digestOf(content) }], maxCreateAttempts: 1,
        parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } },
        ...(render ? [{ operationId: "render", outputSlot: "final", kind: "render" as const, model: null, maxCreateAttempts: 1 as const,
          inputs: [{ kind: "operation_output" as const, producerOperationId: "video", outputSlot: "clip" }] as [{ kind: "operation_output"; producerOperationId: string; outputSlot: string }],
          parameters: { assembly: "ordered_concat" as const, format: "mp4" as const, width: 640, height: 360, fps: 24 } }] : [])],
      finalOutput: render ? { operationId: "render", outputSlot: "final" } : { operationId: "video", outputSlot: "clip" },
      maxSpend: { currency: "CNY", amountMinor: 1200 },
    }, OFFLINE_QUOTE_CATALOG);
    proposal = result.proposal;
  })();
  const value = rowToProposal(proposal!, db);
  // 重启复用同一数据库时绑定已存在；只在缺失时补一份方案主稿关联。
  const bound = db.prepare("SELECT 1 FROM artifact_revisions WHERE creation_binding_json LIKE ? LIMIT 1").get(`%"proposalId":"${value.id}"%`);
  if (!bound) bindPreparedPlan(db, time, scope, value, planWork ?? ensurePlanStageWork(db, time, scope, "故障验证"));
  return { db, service, worker, port, proposal: value,
    accept: () => service.accept("owner", value.id, { commandId: "original-confirmation", proposalDigest: value.digest }),
    close: async () => { await worker.close(); hub.close(); port.close(); db.close(); } };
}
