import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, OFFLINE_QUOTE_CATALOG } from "../src/server/agent/offline.js";
import { saveEdgeTtsServiceSettings } from "../src/server/agent/free-service-settings.js";
import type { ArtifactRevision, DeliveryReceipt, DubFreeResult, ProductionIntent, RevisionRef } from "../src/shared/agent/generated/contracts.js";
import { finalVideoTarget, seedConfirmedWork } from "./helpers/creative-work-fixture.js";
import { retainedVideoMaterials } from "../src/server/agent/library-materials.js";

// G4-2 跨会话作品库选材：入口验证（真实 finalize_video + 定稿当时留存清单）、
// 准确音频修订的元数据/原字节与再次交付、currentContext 披露、消息持久化、伪造与越权拒绝。
// 配音外部客户端是本地桩、成片制作是既有 Faux 回放；不以本用例证明真实 TTS 或音画混合效果。

const origin = "http://127.0.0.1:4399";
let sequence = 0;
const cmd = () => `test-${++sequence}`;
const input = (text: string) => ({ commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null });

type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-lib-"));
  let time = Date.parse("2026-11-08T00:00:00Z");
  const clock = () => new Date(time).toISOString();
  const app = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, clock, media: { autoStart: false, delayMs: 0 } });
  const conversation = app.service.createConversation("local-owner", { commandId: cmd(), title: "库验证 A" }).conversation;
  app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "山路", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }] })]), fauxAssistantMessage("已交付。")]);
  await app.service.sendMessage("local-owner", conversation.id, input("给我 prompt"));
  for (let i = 0; i < 100 && app.service.snapshot("local-owner", conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const artifact = app.service.snapshot("local-owner", conversation.id).artifacts.items[0]!;
  assert.ok(artifact);
  const revision = app.service.readRevision("local-owner", artifact.id, artifact.revisionId);
  const confirmed = seedConfirmedWork(app.database, clock(), { ownerId: "local-owner", conversationId: conversation.id }, "山路短片");
  const spec: ProductionIntent = {
    workId: confirmed.workId, title: "山路短片",
    inputSources: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }],
    reviewInputs: [confirmed.reviewInput], purpose: "production", scope: "正式整片",
    operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
      inputs: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }], maxCreateAttempts: 1,
      parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
    finalOutput: { operationId: "shot-1", outputSlot: "video-1" }, outputTarget: finalVideoTarget(), maxSpend: { currency: "CNY", amountMinor: 1200 },
  };
  return {
    app, directory, conversation, artifact, revision, confirmed, spec, clock,
    advance: () => { time += 5000; },
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

type StoredItem = { id: string; role: string; draft: { kind: string; artifactId?: string; revisionId?: string } | null; approved: unknown };
type StoredState = { groups: { id: string; items: StoredItem[] }[] };
function videoItemOf(f: Fixture): { group: string; item: StoredItem } {
  const row = f.app.database.prepare("SELECT creation_state_json FROM works WHERE id=?").get(f.confirmed.workId) as { creation_state_json: string };
  const state = JSON.parse(row.creation_state_json) as StoredState;
  const found = state.groups.flatMap(group => group.items.map(item => ({ group: group.id, item })))
    .find(({ item }) => item.role === "video");
  assert.ok(found, "应有视频角色事项");
  return found;
}

it("G4-2 跨会话库选材：定稿准确音频在 B 读原字节并再次交付，来源认可不变且越权仍拒绝", async () => {
  const f = await setup(); try {
    const lastTool = <T,>(context: TranscriptContext): T => {
      const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
      assert.ok(result, `应收到工具结果：${JSON.stringify(context.messages.slice(-3))}`);
      const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
      assert.equal(result.isError, false, text);
      return JSON.parse(text.slice(text.indexOf("{"))) as T;
    };
    // 真实 dub_free/交付链，外部客户端仅返回 FFmpeg 生成的固定音频与边界。
    const audioBytes = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8",
      "-c:a", "libmp3lame", "-f", "mp3", "pipe:1"]);
    const pythonStub = path.join(f.directory, "dub-client.mjs");
    await writeFile(pythonStub, `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ audioB64: ${JSON.stringify(audioBytes.toString("base64"))},
  boundaries: [{ text: "山路", offsetMs: 0, durationMs: 300 }, { text: "晨光", offsetMs: 350, durationMs: 350 }] })));
`, { mode: 0o755 });
    saveEdgeTtsServiceSettings(f.app.database, f.clock, "local-owner", {
      commandId: cmd(), expectedRevision: 0, enabled: true, voice: "zh-CN-XiaoxiaoNeural", pythonCommand: pythonStub,
    });
    let generated!: DubFreeResult, audioDelivery!: DeliveryReceipt;
    f.app.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("dub_free", { text: "山路晨光", rate: "+10%" })]),
      context => {
        generated = lastTool<DubFreeResult>(context);
        return fauxAssistantMessage([fauxToolCall("deliver_artifacts", {
          items: [{ mode: "create", title: "山路配音", kind: "audio", content: { format: "local_output",
            source: { kind: "artifact_revision", artifactId: generated.artifactId, revisionId: generated.revisionId } } }],
          reviewGroups: [{ workId: f.confirmed.workId, group: { mode: "create", key: "audio", title: "声音", nextIntent: null },
            items: [{ item: { mode: "create", key: "voice", label: "配音", role: "voice", required: false },
              itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "production" }] }],
        })]);
      },
      context => { audioDelivery = lastTool<DeliveryReceipt>(context); return fauxAssistantMessage("配音已交付，请确认。"); },
    ]);
    await f.app.service.sendMessage("local-owner", f.conversation.id, input("生成配音并给我审阅"));
    for (let i = 0; i < 100 && f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(audioDelivery, `配音应经正式交付形成草稿：${JSON.stringify(f.app.service.snapshot("local-owner", f.conversation.id).messages.items)}`);
    const audioRef = audioDelivery.revisions[0]!;
    const audioRevision = f.app.service.readRevision("local-owner", audioRef.artifactId, audioRef.revisionId);
    assert.equal(audioRevision.content.format, "media");
    if (audioRevision.content.format !== "media") assert.fail("配音应为媒体修订");
    const audioContent = audioRevision.content;
    assert.ok(audioContent.dub, "正式配音应保留 dub");
    assert.equal(audioContent.dub.text, "山路晨光");
    assert.equal(audioContent.dub.rate, "+10%");
    const audioSource = { kind: "artifact_revision" as const, ...audioRef, digest: audioRevision.digest };
    const voiceTarget = audioDelivery.reviewTargets[0]!;
    await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("认可这一版配音"), reviewConfirmation: {
      workId: f.confirmed.workId, groupId: voiceTarget.groupId, items: [{ itemId: voiceTarget.itemId, source: audioSource }], action: "approve",
    } });
    f.spec.inputSources.push(audioSource);
    // 同字节的另一个合法产出不被成片消费，不能按 blob 猜成 shot-1，也不能混进留存。
    f.spec.operations.push({ ...f.spec.operations[0]!, operationId: "unused-shot", outputSlot: "unused-video" });
    f.spec.maxSpend = { currency: "CNY", amountMinor: 2400 };
    f.spec.operations.push({ operationId: "narrated", outputSlot: "final", kind: "render", model: null,
      inputs: [{ kind: "operation_output", producerOperationId: "shot-1", outputSlot: "video-1" }, audioSource], maxCreateAttempts: 1,
      parameters: { assembly: "narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24,
        videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" } });
    f.spec.finalOutput = { operationId: "narrated", outputSlot: "final" };
    f.spec.outputTarget = finalVideoTarget();

    // 会话 A：跑成视频草稿并定稿，留存清单绑定实际采用的准确音频修订。
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: f.spec })).proposal;
    const accepted = f.app.service.acceptProposal("local-owner", proposal.id, { commandId: cmd(), proposalDigest: proposal.digest });
    for (let i = 0; i < 12 && f.app.service.getRun("local-owner", accepted.run.id).state !== "succeeded"; i++) { await f.app.worker!.pollOnce(); f.advance(); }
    assert.equal(f.app.service.getRun("local-owner", accepted.run.id).state, "succeeded");
    // 成片正式交付同时记录本次图中实际采用的方案与音频；定稿留存取这份交付的准确来源清单。
    const producedVideo = videoItemOf(f);
    f.app.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", {
        items: [{ mode: "create", title: "山路有声成片", kind: "video", content: { format: "local_output",
          source: { kind: "run_output", runId: accepted.run.id, operationId: "narrated", outputSlot: "final" } } }],
        reviewGroups: [{ workId: f.confirmed.workId, group: { mode: "existing", groupId: producedVideo.group },
          items: [{ item: { mode: "existing", itemId: producedVideo.item.id }, itemIndex: 0,
            inputSources: f.spec.inputSources, reviewInputs: [], purpose: "production" }] }],
      })]), fauxAssistantMessage("成片已交付。"),
    ]);
    await f.app.service.sendMessage("local-owner", f.conversation.id, input("把完成的成片与实际来源一起交付"));
    for (let i = 0; i < 100 && f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const delivered = videoItemOf(f);
    assert.equal(delivered.item.draft?.kind, "artifact_revision");
    const producer = retainedVideoMaterials(f.app.database, "local-owner", delivered.item.draft as RevisionRef).producer;
    assert.ok(producer, "再次交付不能丢失 producer");
    assert.deepEqual({ runId: producer.runId, operationId: producer.operationId, outputSlot: producer.outputSlot },
      { runId: accepted.run.id, operationId: "narrated", outputSlot: "final" }, "再次交付仍指向准确 producer");
    const producedSource = producedVideo.item.draft as { artifactId: string; revisionId: string };
    const deliveredRef = delivered.item.draft as { artifactId: string; revisionId: string };
    const beforeWrongSlot = f.app.database.prepare("SELECT * FROM artifact_revisions ORDER BY rowid").all();
    f.app.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "revise", artifactId: deliveredRef.artifactId,
        baseRevisionId: deliveredRef.revisionId, title: "山路有声成片", kind: "video", content: { format: "local_output",
          source: { kind: "run_output", runId: accepted.run.id, operationId: "narrated", outputSlot: "wrong-slot" } } }] })]),
      context => {
        const denied = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        assert.equal(denied.isError, true, "仅 outputSlot 错误也必须拒绝");
        assert.deepEqual(f.app.database.prepare("SELECT * FROM artifact_revisions ORDER BY rowid").all(), beforeWrongSlot, "错误坐标不落新稿");
        return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "revise", artifactId: deliveredRef.artifactId,
          baseRevisionId: deliveredRef.revisionId, title: "山路有声成片", kind: "video", content: { format: "local_output",
            source: { kind: "artifact_revision", ...producedSource } } }] })]);
      },
      fauxAssistantMessage("准确版本已交付。"),
    ]);
    await f.app.service.sendMessage("local-owner", f.conversation.id, input("沿原成片准确来源更新当前草稿"));
    for (let i = 0; i < 100 && f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const video = videoItemOf(f);
    assert.equal(video.item.draft?.kind, "artifact_revision");
    const draft = video.item.draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
    const draftRevision = f.app.service.readRevision("local-owner", draft.artifactId, draft.revisionId);
    if (draftRevision.content.format !== "media") assert.fail("成片应为媒体修订");
    assert.equal(draftRevision.content.dub, undefined, "run_output 成片不编造源音频的 dub 坐标");
    await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("这版定稿"), reviewConfirmation: {
      workId: f.confirmed.workId, groupId: video.group,
      items: [{ itemId: video.item.id, source: { kind: "artifact_revision", artifactId: draft.artifactId, revisionId: draft.revisionId, digest: draftRevision.digest } }],
      action: "finalize_video",
    } });
    const library = f.app.service.listLibraryVideos("local-owner", undefined, undefined).items;
    assert.equal(library.length, 1);
    assert.equal(library[0]!.video.revisionId, draft.revisionId);
    assert.equal(library[0]!.provenanceStatus, "recorded");
    const outputs = f.app.database.prepare(`SELECT o.id,o.output_blob_id,r.artifact_id,r.id AS revision_id
      FROM production_operations o JOIN artifact_revisions r ON r.id=o.output_revision_id WHERE o.run_id=?`).all(accepted.run.id) as
      { id: string; output_blob_id: string; artifact_id: string; revision_id: string }[];
    const shot = outputs.find(row => row.id === "shot-1")!, unusedShot = outputs.find(row => row.id === "unused-shot")!;
    assert.ok(shot && unusedShot);
    assert.equal(shot.output_blob_id, unusedShot.output_blob_id, "合法两操作可共享完全相同的媒体字节");
    assert.notEqual(shot.revision_id, unusedShot.revision_id, "同字节输出仍保留各自准确修订");
    const shotRef = { artifactId: shot.artifact_id, revisionId: shot.revision_id };
    assert.deepEqual(library[0]!.materials.map(item => {
      assert.ok("revisionId" in item.source, "本场景的素材都是准确产物修订");
      return item.source.revisionId;
    }), [shot.revision_id, f.revision.revisionId, audioRef.revisionId], "采用的生成片段保留，未消费的同字节产物不混入");
    const shotBytes = readFileSync(f.app.service.readBlob("local-owner", shot.output_blob_id).path);
    const originalPage = f.app.service.snapshot("local-owner", f.conversation.id);
    const originalConfirmations = f.app.database.prepare("SELECT * FROM work_review_confirmations WHERE conversation_id=? ORDER BY id").all(f.conversation.id);
    const originalBlob = f.app.service.readBlob("local-owner", audioContent.blobId);
    assert.deepEqual(readFileSync(originalBlob.path), audioBytes);
    const blobCount = (f.app.database.prepare("SELECT COUNT(*) AS n FROM production_blobs").get() as { n: number }).n;

    // 会话 B（同 owner 跨会话）：真实发送库选材，read_artifact 读取物化修订后再正式交付。
    const other = f.app.service.createConversation("local-owner", { commandId: cmd(), title: "库验证 B" }).conversation;
    const captured: unknown[] = [];
    let selectedAudio!: RevisionRef, redelivery!: DeliveryReceipt;
    f.app.faux!.appendResponses([
      context => {
        captured.push(context.messages);
        const selectedMessage = f.app.service.snapshot("local-owner", other.id).messages.items.find(message => message.librarySelections?.length)!;
        selectedAudio = selectedMessage.references.artifacts[1]!;
        return fauxAssistantMessage([fauxToolCall("read_artifact", { artifactId: selectedAudio.artifactId, revisionId: selectedAudio.revisionId })]);
      },
      context => {
        const read = lastTool<ArtifactRevision>(context);
        assert.deepEqual({ artifactId: read.artifactId, revisionId: read.revisionId }, selectedAudio);
        assert.deepEqual(read.content, audioContent, "B 读取准确音频修订的原文、语音、语速与边界");
        assert.equal(read.content.format, "media");
        if (read.content.format !== "media") assert.fail("引用音频应是媒体修订");
        assert.deepEqual(readFileSync(f.app.service.readBlob("local-owner", read.content.blobId).path), audioBytes, "B 读取原音频字节");
        return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "错误跨会话引用", kind: "audio",
          content: { format: "local_output", source: { kind: "artifact_revision", ...audioRef } } }] })]);
      },
      context => {
        const denied = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        assert.equal(denied.isError, true, "知道 A 的准确修订仍不能绕过 B 的库物化");
        assert.match(denied.content.filter(part => part.type === "text").map(part => part.text).join(""), /不属于当前会话/);
        const selectedClip = f.app.service.snapshot("local-owner", other.id).messages.items.find(message => message.librarySelections?.length)!.references.artifacts[2]!;
        return fauxAssistantMessage([fauxToolCall("read_artifact", { ...selectedClip })]);
      },
      context => {
        const readResult = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        assert.notEqual(readResult.isError, true, JSON.stringify(readResult.content));
        assert.ok(readResult.content.some(part => part.type === "image"), "视频 read_artifact 返回可解码帧，不是音频式 JSON");
        const selectedClip = f.app.service.snapshot("local-owner", other.id).messages.items.find(message => message.librarySelections?.length)!.references.artifacts[2]!;
        const read = f.app.service.readRevision("local-owner", selectedClip.artifactId, selectedClip.revisionId);
        assert.equal(read.content.format, "media");
        if (read.content.format !== "media") assert.fail("生成片段物化后仍是媒体");
        assert.equal(read.content.blobId, shot.output_blob_id);
        assert.deepEqual(readFileSync(f.app.service.readBlob("local-owner", read.content.blobId).path), shotBytes, "跨会话读到准确生成片段原字节");
        return fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "改编配音", kind: "audio",
          content: { format: "local_output", source: { kind: "artifact_revision", ...selectedAudio } } }] })]);
      },
      context => { redelivery = lastTool<DeliveryReceipt>(context); return fauxAssistantMessage("原音频已作为新的配音草稿交付。"); },
    ]);
    const selections = [{
      sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
      source: { kind: "artifact_revision" as const, artifactId: f.artifact.id, revisionId: f.revision.revisionId },
    }, { sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
      source: { kind: "artifact_revision" as const, ...audioRef },
    }, { sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
      source: { kind: "artifact_revision" as const, ...shotRef },
    }];
    await f.app.service.sendMessage("local-owner", other.id, { ...input("用这条片子的原方案做改编"), librarySelections: selections });
    for (let i = 0; i < 100 && f.app.service.snapshot("local-owner", other.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));

    // 刷新后仍知所选：消息原样持久化 librarySelections，references 指向物化修订。
    const page = f.app.service.snapshot("local-owner", other.id);
    const userMessage = page.messages.items.find(message => message.role === "user" && message.text.includes("改编"))!;
    assert.ok(userMessage);
    assert.deepEqual(userMessage.librarySelections, selections);
    assert.equal(userMessage.references.artifacts.length, 3);
    const reference = userMessage.references.artifacts[0]!;
    const copy = f.app.service.readRevision("local-owner", reference.artifactId, reference.revisionId);
    const copyHead = page.artifacts.items.find(item => item.id === reference.artifactId)!;
    assert.equal(copyHead.kind, "prompt");
    assert.ok(copyHead.title.includes("作品库引用"));
    assert.deepEqual(copy.content, f.revision.content);
    assert.equal(copy.baseRevisionId, null);
    assert.ok(redelivery, `当前会话合法库音频应能再次正式交付：${JSON.stringify(page.messages.items.slice(-3))}`);
    const redelivered = f.app.service.readRevision("local-owner", redelivery.revisions[0]!.artifactId, redelivery.revisions[0]!.revisionId);
    assert.deepEqual(redelivered.content, audioContent, "B 新草稿仍共享原 blob 且保留配音元数据");
    assert.ok(f.app.database.prepare("SELECT 1 FROM revision_blob_links WHERE revision_id=? AND blob_id=?").get(redelivered.revisionId, audioContent.blobId));
    assert.equal((f.app.database.prepare("SELECT COUNT(*) AS n FROM production_blobs").get() as { n: number }).n, blobCount, "库复用与再次交付不复制或迁移 blob");
    assert.deepEqual(f.app.service.readBlob("local-owner", audioContent.blobId), originalBlob);

    // 原会话全部 artifact head、审阅认可和原字节保持不变。
    const originalAfter = f.app.service.snapshot("local-owner", f.conversation.id);
    assert.deepEqual(originalAfter.artifacts.items, originalPage.artifacts.items);
    assert.deepEqual(originalAfter.works, originalPage.works);
    assert.deepEqual(f.app.database.prepare("SELECT * FROM work_review_confirmations WHERE conversation_id=? ORDER BY id").all(f.conversation.id), originalConfirmations);
    assert.deepEqual(readFileSync(originalBlob.path), audioBytes);

    // currentContext 披露：模型看到 librarySelections 与物化修订清单。
    assert.ok(captured.length >= 1, "应捕获模型请求上下文");
    const transcript = JSON.stringify(captured[0]);
    assert.ok(transcript.includes("librarySelections"), "currentContext 应披露库选材");
    assert.ok(transcript.includes(reference.artifactId), "currentContext 的 artifacts 清单应含物化修订");
    assert.ok(transcript.includes("山路（作品库引用）") || transcript.includes("作品库引用"), "物化标题应可见");

    // 伪造 sourceVideo：同一视频 artifact 的未定稿修订不能作为来源。
    // sendMessage 是同步方法：同步 throw 与异步拒绝都要捕获成同一个错误对象。
    const rejection = (send: () => unknown): Promise<Error> => {
      try {
        return Promise.resolve(send()).then(() => { throw new Error("应当被拒绝"); }, error => error as Error);
      } catch (error) {
        return Promise.resolve(error as Error);
      }
    };
    const forged = await rejection(() => f.app.service.sendMessage("local-owner", other.id, {
      ...input("再带一次"),
      librarySelections: [{ sourceVideo: { artifactId: draft.artifactId, revisionId: "rev-forged" },
        source: { kind: "artifact_revision", artifactId: f.artifact.id, revisionId: f.revision.revisionId } }],
    }));
    assert.match(forged.message, /还没有定稿入库/);

    // 素材不在留存清单：定稿成片修订本身不在 inputSources 里，不能借道作品库。
    const notInManifest = await rejection(() => f.app.service.sendMessage("local-owner", other.id, {
      ...input("再带一次"),
      librarySelections: [{ sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
        source: { kind: "artifact_revision", artifactId: draft.artifactId, revisionId: draft.revisionId } }],
    }));
    assert.match(notInManifest.message, /不在定稿当时的留存清单里/);

    // 越权：其他 owner 即使知道准确修订号，也没有这条定稿记录。
    const stranger = f.app.service.createConversation("other-owner", { commandId: cmd(), title: "越权" }).conversation;
    const crossOwner = await rejection(() => f.app.service.sendMessage("other-owner", stranger.id, {
      ...input("借用素材"),
      librarySelections: [{ sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
        source: { kind: "artifact_revision", artifactId: f.artifact.id, revisionId: f.revision.revisionId } }],
    }));
    assert.match(crossOwner.message, /还没有定稿入库/);
    assert.equal(f.app.service.snapshot("local-owner", other.id).messages.items
      .filter(message => message.librarySelections?.length).length, 1, "失败发送不落消息");
  } finally { await f.close(); }
});
