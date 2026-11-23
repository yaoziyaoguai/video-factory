import path from "node:path";
import { openAgentDatabase } from "../../src/server/agent/db.js";
import { ProductionBlobs } from "../../src/server/agent/production-blobs.js";
import { ProductionService, type ProductionCrashHook } from "../../src/server/agent/production-service.js";
import { ProductionWorker } from "../../src/server/agent/production-worker.js";
import { FauxMediaPort } from "../../src/server/agent/faux-media.js";
import { EventHub } from "../../src/server/agent/event-log.js";
import { applyPrepareProposal, rowToProposal } from "../../src/server/agent/artifact-store.js";
import { emptyReferences, insertMessage, insertQueuedRequest, nextQueueSeq, nextSeq } from "../../src/server/agent/conversation-store.js";
import { canonicalJson, digestOf, newAgentId } from "../../src/server/agent/util.js";
import { OFFLINE_QUOTE_CATALOG, studioRoot } from "../../src/server/agent/offline.js";
import { ensureConfirmedWork, finalVideoTarget, type ConfirmedReviewWork } from "./creative-work-fixture.js";

export function productionHarness(directory: string, time: string, crash?: ProductionCrashHook, render = false, options: { owner?:string; conversation?:string; billing?: import("../../src/shared/agent/generated/contracts.js").BillingFact|null } = {}) {
  const db = openAgentDatabase(directory), clock = () => time, hub = new EventHub();
  const blobs = new ProductionBlobs(db, directory, clock);
  const port = new FauxMediaPort(directory, db, blobs, clock, { fixtureRoot: path.join(studioRoot, "fixtures/agent"), delayMs: 0, ...(options.billing!==undefined?{billing:options.billing}:{}) });
  const service = new ProductionService(db, clock, hub, () => OFFLINE_QUOTE_CATALOG, blobs, crash);
  const worker = new ProductionWorker(db, clock, hub, blobs, port, { ...(crash ? { crash } : {}) });
  const scope = { ownerId: options.owner ?? "owner", conversationId: options.conversation ?? "conversation" };
  const artifactId=options.conversation?`artifact-${scope.conversationId}`:"artifact",revisionId=options.conversation?`revision-${scope.conversationId}`:"revision";
  let proposal = db.prepare("SELECT * FROM proposals WHERE owner_id=? AND conversation_id=? LIMIT 1").get(scope.ownerId,scope.conversationId) as Parameters<typeof rowToProposal>[0] | undefined;
  let confirmedWork: ConfirmedReviewWork | undefined;
  if (!proposal) db.transaction(() => {
    db.prepare("INSERT INTO conversations(id,owner_id,title,created_seq,pi_session_id,created_at,updated_at) VALUES(?,?,'故障验证',(SELECT COALESCE(MAX(created_seq),0)+1 FROM conversations WHERE owner_id=?),?,?,?)").run(scope.conversationId,scope.ownerId,scope.ownerId,newAgentId('pi'),time, time);
    const content = { format: "markdown", text: "故障验证固定输入" };
    db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,'输入','prompt',?,1,1,?,?)").run(artifactId,scope.conversationId,scope.ownerId,revisionId,time,time);
    db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,digest,content_json,created_at) VALUES(?,?,1,?,?,?)").run(revisionId,artifactId,digestOf(content), canonicalJson(content), time);
    // 正式视频提案须落在已开始的创作内，且带真实组审阅认可（reviewInputs）。
    confirmedWork = ensureConfirmedWork(db, time, scope, "故障验证");
    // 与 HTTP prepareProposal 同形的纯命令记法：真实闭合 request + system_notice 作为 requestSource。
    const requestId = newAgentId("req"), messageId = newAgentId("msg");
    insertMessage(db, time, {
      id: messageId, conversationId: scope.conversationId, ownerId: scope.ownerId, requestId,
      role: "system_notice", kind: "notice", state: "completed", text: "已通过接口准备提案“故障验证”。",
      target: null, createdSeq: nextSeq(db, "messages", scope.conversationId), references: emptyReferences(),
    });
    insertQueuedRequest(db, time, {
      id: requestId, conversationId: scope.conversationId, ownerId: scope.ownerId, commandId: requestId,
      text: "", target: null, skillId: null, modelId: null,
      queueSeq: nextQueueSeq(db, scope.conversationId), messageId,
    });
    db.prepare("UPDATE requests SET state='completed', delivery_closed=1 WHERE id=?").run(requestId);
    const result = applyPrepareProposal(db, time, scope, {
      workId: confirmedWork.workId, title: "故障验证",
      inputSources: [{ kind: "artifact_revision", artifactId, revisionId, digest: digestOf(content) }],
      reviewInputs: [confirmedWork.reviewInput], purpose: "production", scope: "故障验证整片",
      operations: [{ operationId: "video", outputSlot: "clip", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
        inputs: [{ kind: "artifact_revision", artifactId, revisionId, digest: digestOf(content) }], maxCreateAttempts: 1,
        parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } },
        ...(render ? [{ operationId: "render", outputSlot: "final", kind: "render" as const, model: null, maxCreateAttempts: 1 as const,
          inputs: [{ kind: "operation_output" as const, producerOperationId: "video", outputSlot: "clip" }] as [{ kind: "operation_output"; producerOperationId: string; outputSlot: string }],
          parameters: { assembly: "ordered_concat" as const, format: "mp4" as const, width: 640, height: 360, fps: 24 as const } }] : [])],
      finalOutput: render ? { operationId: "render", outputSlot: "final" } : { operationId: "video", outputSlot: "clip" },
      outputTarget: finalVideoTarget(),
      maxSpend: { currency: "CNY", amountMinor: 1200 },
    }, OFFLINE_QUOTE_CATALOG, { requestId, messageId });
    proposal = result.proposal;
  })();
  const value = rowToProposal(proposal!, db);
  return { db, service, worker, port, proposal: value,
    accept: () => service.accept(scope.ownerId, value.id, { commandId: "original-confirmation", proposalDigest: value.digest }),
    close: async () => { await worker.close(); hub.close(); port.close(); db.close(); } };
}
