import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { assembleOfflineAgent } from "../src/server/agent/offline.js";
import { createWork } from "../src/server/agent/creative-work.js";
import { validatorFor } from "../src/server/agent/validate.js";
import { deliverReviewDrafts } from "./helpers/creative-work-fixture.js";
import type { ReviewApprovalHistoryPage } from "../src/shared/agent/generated/contracts.js";

it("认可历史分页固定水位、保留准确旧版；跨拥有者与事项游标不可读取", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-review-history-"));
  const app = await assembleOfflineAgent({ dataDir: directory, uiOrigin: "http://127.0.0.1:4395", fauxScenario: false });
  const owner = "local-owner";
  let sequence = 0;
  const commandId = () => `history-${++sequence}`;
  try {
    const conversation = app.service.createConversation(owner, { commandId: commandId(), title: "认可历史" }).conversation;
    const scope = { ownerId: owner, conversationId: conversation.id };
    const work = createWork(app.database, new Date().toISOString(), scope, "视频 A");
    const initial = deliverReviewDrafts(app.database, new Date().toISOString(), scope, {
      items: [{ mode: "create", title: "脚本", kind: "script", content: { format: "markdown", text: "第一版" } }],
      reviewGroups: [{ workId: work.id, group: { mode: "create", key: "script", title: "脚本", nextIntent: null }, items: [{ item: { mode: "create", key: "script", label: "脚本", role: "content", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }],
    });
    const group = app.service.readWork(owner, work.id).reviewGroups[0]!;
    const item = group.items[0]!;
    let ref = initial.receipt.revisions[0]!;
    const approve = async () => {
      const revision = app.service.readRevision(owner, ref.artifactId, ref.revisionId);
      await app.service.sendMessage(owner, conversation.id, { commandId: commandId(), text: "认可这一版", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
        reviewConfirmation: { workId: work.id, groupId: group.id, action: "approve", items: [{ itemId: item.id, source: { kind: "artifact_revision", ...ref, digest: revision.digest } }] } });
    };
    const revise = () => {
      ref = deliverReviewDrafts(app.database, new Date().toISOString(), scope, {
        items: [{ mode: "revise", artifactId: ref.artifactId, baseRevisionId: ref.revisionId, title: "脚本", kind: "script", content: { format: "markdown", text: `修订 ${sequence}` } }],
        reviewGroups: [{ workId: work.id, group: { mode: "existing", groupId: group.id }, items: [{ item: { mode: "existing", itemId: item.id }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }],
      }).receipt.revisions[0]!;
    };
    for (let version = 1; version <= 22; version++) { if (version > 1) revise(); await approve(); }
    const before = app.service.readWork(owner, work.id);
    const url = `/api/agent/v1/works/${work.id}/groups/${group.id}/items/${item.id}/approvals`;
    const firstResponse = await app.app.inject({ method: "GET", url });
    assert.equal(firstResponse.statusCode, 200);
    const first = firstResponse.json<ReviewApprovalHistoryPage>();
    assert.equal(validatorFor("ReviewApprovalHistoryPage")(first).ok, true);
    assert.equal(first.items[0]!.revisionNumber, 22);
    assert.equal(first.items.length, 20); assert.ok(first.nextCursor);
    assert.equal(first.items[0]!.source.kind, "artifact_revision");
    assert.deepEqual(first.items[0]!.source, before.reviewGroups[0]!.items[0]!.approved);
    revise(); await approve();
    const secondResponse = await app.app.inject({ method: "GET", url: `${url}?cursor=${encodeURIComponent(first.nextCursor)}` });
    const second = secondResponse.json<ReviewApprovalHistoryPage>();
    assert.equal(secondResponse.statusCode, 200); assert.equal(validatorFor("ReviewApprovalHistoryPage")(second).ok, true);
    assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(entry => entry.confirmationId)).size, 22);
    assert.deepEqual(second.items[1]!.source.kind === "artifact_revision" ? second.items[1]!.source.revisionId : null, initial.receipt.revisions[0]!.revisionId);
    const beforeRead = JSON.stringify(app.service.readWork(owner, work.id));
    app.service.listReviewApprovalHistory(owner, work.id, group.id, item.id);
    assert.equal(JSON.stringify(app.service.readWork(owner, work.id)), beforeRead, "浏览历史不更改当前认可");
    assert.throws(() => app.service.listReviewApprovalHistory("another-owner", work.id, group.id, item.id), /没有找到/);
    const wrongItem = await app.app.inject({ method: "GET", url: url.replace(`/items/${item.id}/`, "/items/unknown/") });
    assert.equal(wrongItem.statusCode, 404);
    const badCursor = await app.app.inject({ method: "GET", url: `${url}?cursor=invalid` });
    assert.equal(badCursor.statusCode, 400);
    for (const cursor of [Buffer.from("null").toString("base64url"), "x".repeat(513)]) {
      assert.equal((await app.app.inject({ method: "GET", url: `${url}?cursor=${cursor}` })).statusCode, 400);
    }
    assert.equal((await app.app.inject({ method: "GET", url: `${url}?cursor=a&cursor=b` })).statusCode, 400);
    const foreignCursor = Buffer.from(JSON.stringify({ v: 1, c: `${work.id}:${group.id}:other`, k: "review_approvals", p: 1, w: 2 })).toString("base64url");
    assert.equal((await app.app.inject({ method: "GET", url: `${url}?cursor=${foreignCursor}` })).statusCode, 403);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
