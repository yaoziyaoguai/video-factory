import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { assembleOfflineAgent, OFFLINE_QUOTE_CATALOG } from "../src/server/agent/offline.js";
import { createWork } from "../src/server/agent/creative-work.js";
import { deliverReviewDrafts } from "./helpers/creative-work-fixture.js";
import type { ContentSource, ProductionIntent } from "../src/shared/agent/generated/contracts.js";

// 事务/角色/来源机制用例；媒体端口替身不充当V02/V08真实制作验收。
it("DGR-06 候选不入库，预览一步同字节定稿原子化并保留原预览与制作来源", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-adopt-"));
  const app = await assembleOfflineAgent({ dataDir: directory, uiOrigin: "http://127.0.0.1:4395", media: { autoStart: false, delayMs: 0 } });
  const owner = "local-owner";
  let sequence = 0;
  const commandId = () => `adopt-${++sequence}`;
  try {
    const conversationId = app.service.createConversation(owner, { commandId: commandId(), title: "预览采用" }).conversation.id;
    const scope = { ownerId: owner, conversationId };
    const work = createWork(app.database, new Date().toISOString(), scope, "自然动画");
    const content = deliverReviewDrafts(app.database, new Date().toISOString(), scope, {
      items: [{ mode: "create", title: "背景内容", kind: "script", content: { format: "markdown", text: "绿色背景的蓝色方块。" } }],
      reviewGroups: [{ workId: work.id, group: { mode: "create", key: "basis", title: "内容", nextIntent: null },
        items: [{ item: { mode: "create", key: "script", label: "内容依据", role: "content", required: true },
          itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }],
    });
    const basis = content.receipt.revisions[0]!;
    const basisRevision = app.service.readRevision(owner, basis.artifactId, basis.revisionId);
    const source: ContentSource = { kind: "artifact_revision", ...basis, digest: basisRevision.digest };
    const spec: ProductionIntent = {
      workId: work.id, title: "局部预览", inputSources: [source], reviewInputs: [], purpose: "preview", scope: "只看局部",
      operations: [{ operationId: "clip", outputSlot: "preview", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
        inputs: [source], maxCreateAttempts: 1,
        parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
      finalOutput: { operationId: "clip", outputSlot: "preview" }, maxSpend: { currency: "CNY", amountMinor: 1200 },
      outputTarget: { group: { mode: "create", key: "preview", title: "预览", nextIntent: null },
        item: { mode: "create", key: "clip", label: "局部预览", role: "clip", required: true } },
    };
    const proposal = (await app.service.prepareProposal(owner, conversationId, { commandId: commandId(), spec })).proposal;
    const accepted = app.service.acceptProposal(owner, proposal.id, { commandId: commandId(), proposalDigest: proposal.digest });
    for (let i = 0; i < 12; i++) await app.worker!.pollOnce();
    const run = app.service.getRun(owner, accepted.run.id);
    assert.equal(run.state, "succeeded");
    const originalRef = run.outputRevisions[0]!;
    const original = app.service.readRevision(owner, originalRef.artifactId, originalRef.revisionId);
    const originalHead = app.service.readArtifactHead(owner, originalRef.artifactId);
    const currentWork = () => app.service.readWork(owner, work.id);
    const clipGroup = currentWork().reviewGroups.find(group => group.items.some(item => item.role === "clip"))!;
    const clip = clipGroup.items.find(item => item.role === "clip")!;
    const counts = () => ["artifacts", "artifact_revisions", "production_runs", "production_attempts", "work_review_confirmations"].map(table =>
      (app.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    const makeMessage = () => ({ commandId: commandId(), text: "以这版定稿并入库", target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null,
      reviewConfirmation: { kind: "adopt_preview" as const, workId: work.id, groupId: clipGroup.id, itemId: clip.id,
        source: originalRef, action: "finalize_video" as const } });
    const beforeRejected = counts();
    assert.throws(() => app.service.sendMessage(owner, conversationId, makeMessage()), /内容依据/);
    assert.deepEqual(counts(), beforeRejected, "缺必要认可不能留半个最终稿");
    const basisGroup = currentWork().reviewGroups.find(group => group.items.some(item => item.role === "content"))!;
    await app.service.sendMessage(owner, conversationId, { commandId: commandId(), text: "认可内容", target: null, skillId: null,
      proposalRef: null, mode: "new", steerRequestId: null,
      reviewConfirmation: { workId: work.id, groupId: basisGroup.id, items: [{ itemId: basisGroup.items[0]!.id, source }], action: "approve" } });
    const candidate = deliverReviewDrafts(app.database, new Date().toISOString(), scope, {
      items: [{ mode: "create", title: "成片候选", kind: "video", content: { format: "local_output", source: { kind: "artifact_revision", ...originalRef } } }],
      reviewGroups: [{ workId: work.id, group: { mode: "create", key: "candidate", title: "候选", nextIntent: null },
        items: [{ item: { mode: "create", key: "video", label: "成片候选", role: "video", required: true },
          itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }],
    });
    const candidateRevision = app.service.readRevision(owner, candidate.receipt.revisions[0]!.artifactId, candidate.receipt.revisions[0]!.revisionId);
    assert.deepEqual(candidateRevision.content, original.content);
    assert.deepEqual(candidateRevision.creationBinding?.adoptedFrom, originalRef);
    assert.equal(candidateRevision.creationBinding?.runId, run.id);
    assert.equal(app.service.listLibraryVideos(owner, undefined, 20).items.length, 0, "候选仍是草稿");
    const beforeAdopt = counts();
    const message = makeMessage();
    const receipt = await app.service.sendMessage(owner, conversationId, message);
    assert.equal(receipt.status, 202);
    assert.deepEqual(counts().slice(2, 4), beforeAdopt.slice(2, 4), "不新建run或attempt");
    const library = app.service.listLibraryVideos(owner, undefined, 20).items;
    assert.equal(library.length, 1);
    const final = app.service.readRevision(owner, library[0]!.video.artifactId, library[0]!.video.revisionId);
    assert.deepEqual(final.content, original.content, "媒体内容和blob完全共享");
    assert.equal(final.digest, original.digest);
    assert.deepEqual(final.creationBinding?.inputSources, original.creationBinding?.inputSources);
    assert.deepEqual(final.creationBinding?.adoptedFrom, originalRef);
    assert.equal(final.creationBinding?.runId, run.id);
    assert.equal(library[0]!.originMessageId, receipt.receipt.messageId, "库返回本次真实采用消息");
    assert.deepEqual(app.service.readArtifactHead(owner, originalRef.artifactId), originalHead);
    assert.deepEqual(app.service.readRevision(owner, originalRef.artifactId, originalRef.revisionId), original);
    assert.equal(currentWork().reviewGroups.find(group => group.id === clipGroup.id)!.items.find(item => item.id === clip.id)!.approved, null);
    const afterAdopt = counts();
    const replay = await app.service.sendMessage(owner, conversationId, message);
    assert.equal(replay.receipt.replayed, true);
    assert.deepEqual(counts(), afterAdopt, "同命令重放不重复派生");
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
