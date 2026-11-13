import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, OFFLINE_QUOTE_CATALOG, type OfflineAgentOptions } from "../src/server/agent/offline.js";
import { attemptsFor, runRow, specFor } from "../src/server/agent/production-store.js";
import { ProductionWorker } from "../src/server/agent/production-worker.js";
import { FauxMediaPort } from "../src/server/agent/faux-media.js";
import { studioRoot } from "../src/server/agent/offline.js";
import { EventHub } from "../src/server/agent/event-log.js";
import { consumeSubmitPermit, issueSubmitPermit } from "../src/server/agent/submit-permit.js";
import { validatorFor } from "../src/server/agent/validate.js";
import { invalidateLegacyNarrationProposals, productionAudioFacts, productionNarrationText } from "../src/server/agent/artifact-store.js";
import { recordReviewConfirmation } from "../src/server/agent/creative-work.js";
import { persistSearchBatch } from "../src/server/agent/material-store.js";
import { canonicalJson, digestOf } from "../src/server/agent/util.js";
import { deliverReviewDrafts, finalVideoTarget, seedConfirmedWork, type ConfirmedReviewWork } from "./helpers/creative-work-fixture.js";
import { toolIntentOf } from "./helpers/tool-args.js";
import type { BillingFact, CreationBinding, ExecutionObservation, OperationRequest, ProductionIntent, Proposal, Run } from "../src/shared/agent/generated/contracts.js";

const origin = "http://127.0.0.1:4399";
const headers = { origin, "content-type": "application/json", "x-video-factory-request": "studio" };
let sequence = 0;
const cmd = () => `test-${++sequence}`;
const input = (text: string) => ({ commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null });

async function setup(media: OfflineAgentOptions["media"] = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-b-"));
  let time = Date.parse("2026-10-26T00:00:00Z");
  const clock = () => new Date(time).toISOString();
  const app = await assembleOfflineAgent({ dataDir: directory, uiOrigin: origin, clock, media: { autoStart: false, delayMs: 1000, ...media } });
  const conversation = app.service.createConversation("local-owner", { commandId: cmd(), title: "B 验证" }).conversation;
  app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "山路", kind: "prompt", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。" } }] })]), fauxAssistantMessage("已交付。")]);
  await app.service.sendMessage("local-owner", conversation.id, input("给我 prompt"));
  for (let i = 0; i < 100 && app.service.snapshot("local-owner", conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const artifact = app.service.snapshot("local-owner", conversation.id).artifacts.items[0]!;
  assert.ok(artifact);
  const revision = app.service.readRevision("local-owner", artifact.id, artifact.revisionId);
  // 视频提案落在已开始的创作内；正式整片需要真实组审阅认可（reviewInputs 引用准确 confirmationId）。
  const confirmed = seedConfirmedWork(app.database, clock(), { ownerId: "local-owner", conversationId: conversation.id }, "山路短片");
  const spec: ProductionIntent = {
    workId: confirmed.workId, title: "山路短片",
    inputSources: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }],
    reviewInputs: [confirmed.reviewInput], purpose: "production", scope: "正式整片",
    operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
      inputs: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }], maxCreateAttempts: 1,
      parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
    finalOutput: { operationId: "shot-1", outputSlot: "video-1" },
    outputTarget: finalVideoTarget(), maxSpend: { currency: "CNY", amountMinor: 1200 },
  };
  const proposal = async (overrides: Partial<ProductionIntent> = {}) =>
    (await app.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: { ...spec, ...overrides } })).proposal;
  const accept = (p: Proposal) => app.service.acceptProposal("local-owner", p.id, { commandId: cmd(), proposalDigest: p.digest });
  return { app, directory, conversation, artifact, revision, spec, proposal, accept, clock, confirmed,
    advance: () => { time += 5000; },
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function tick(f: Awaited<ReturnType<typeof setup>>, count = 1) { for (let i = 0; i < count; i++) { await f.app.worker!.pollOnce(); f.advance(); } }
function count(f: Awaited<ReturnType<typeof setup>>, table: string) { return (f.app.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }

type StoredItem = { id: string; role: string; draft: { kind: string; artifactId?: string; revisionId?: string } | null; approved: unknown };
type StoredState = { groups: { id: string; items: StoredItem[] }[] };
function workState(f: Awaited<ReturnType<typeof setup>>, workId: string): StoredState {
  const row = f.app.database.prepare("SELECT creation_state_json FROM works WHERE id=?").get(workId) as { creation_state_json: string };
  return JSON.parse(row.creation_state_json) as StoredState;
}
function videoItemOf(f: Awaited<ReturnType<typeof setup>>, workId: string): { group: string; item: StoredItem } {
  const found = workState(f, workId).groups.flatMap(group => group.items.map(item => ({ group: group.id, item })))
    .find(({ item }) => item.role === "video");
  assert.ok(found, "应有视频角色事项");
  return found;
}

it("已认可脚本直接准备制作：接口准备不新增认可，一次确认启动，视频先为草稿", async () => {
  const f = await setup(); try {
    const confirmations = count(f, "work_review_confirmations");
    const response = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/proposals`, headers,
      payload: { commandId: cmd(), spec: f.spec } });
    assert.equal(response.statusCode, 201, response.body);
    const p = response.json() as Proposal;
    assert.ok(validatorFor("Proposal")(p).ok);
    // 接口准备消费既有认可事实，不产生新认可；系统通知如实记录这次准备并立即闭合请求。
    assert.equal(count(f, "work_review_confirmations"), confirmations);
    const notice = f.app.service.snapshot("local-owner", f.conversation.id).messages.items
      .find(message => message.role === "system_notice" && message.text.includes("已通过接口准备提案"));
    assert.ok(notice, "应有本次准备的系统通知");
    assert.equal(count(f, "production_runs"), 0);
    const receipt = f.accept(p);
    await tick(f, 2);
    const run = f.app.service.getRun("local-owner", receipt.run.id);
    assert.equal(run.state, "succeeded");
    assert.equal(count(f, "authorizations"), 1);
    // 发布闭合：视频产出进入草稿；认可不被代填，新稿需重新认可后才可定稿。
    const video = videoItemOf(f, f.confirmed.workId);
    assert.equal(video.item.draft?.kind, "artifact_revision");
    assert.equal(video.item.approved, null);
  } finally { await f.close(); }
});

it("F2 逐字旁白在首次报价、同稿重报、换稿重认和两版作品库保持一致", async () => {
  const f = await setup({ delayMs: 0 }); try {
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    const l1 = "雨停之前，先喝一杯咖啡。", l2 = "窗外下雨，杯里回暖。";
    let confirmed: ConfirmedReviewWork = f.confirmed;
    // 换稿＝把脚本事项推进到带新逐字旁白的修订并重新认可；旧认可事实保留在历史里。
    const confirmScript = (narrationText: string) => {
      const base = confirmed.content;
      if (base.kind !== "artifact_revision") throw new Error("夹具脚本来源必须是修订");
      const seeded = deliverReviewDrafts(f.app.database, f.clock(), scope, {
        items: [{ mode: "revise", artifactId: base.artifactId, baseRevisionId: base.revisionId, title: "雨天方案", kind: "script",
          content: { format: "markdown", text: "固定机位，片头读旁白。", narrationText } }],
        reviewGroups: [{ workId: confirmed.workId,
          group: { mode: "existing", groupId: confirmed.groupId },
          items: [{ item: { mode: "existing", itemId: confirmed.itemId }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "production" }] }],
      });
      const revision = seeded.receipt.revisions[0]!;
      const digest = (f.app.database.prepare("SELECT digest FROM artifact_revisions WHERE artifact_id=? AND id=?")
        .get(revision.artifactId, revision.revisionId) as { digest: string }).digest;
      const source = { kind: "artifact_revision" as const, artifactId: revision.artifactId, revisionId: revision.revisionId, digest };
      const [recorded] = recordReviewConfirmation(f.app.database, f.clock(), scope, {
        workId: confirmed.workId, groupId: confirmed.groupId, items: [{ itemId: confirmed.itemId, source }], action: "approve",
      }, { kind: "user_message", messageId: seeded.messageId }).items;
      confirmed = { ...confirmed, content: source,
        reviewInput: { groupId: confirmed.groupId, itemId: confirmed.itemId, source, confirmationId: recorded!.confirmationId } };
      return revision;
    };
    const makeSpec = (text: string): ProductionIntent => ({ ...f.spec, reviewInputs: [confirmed.reviewInput],
      operations: [f.spec.operations[0]!, {
        kind: "speech", operationId: "voice", outputSlot: "audio", model: OFFLINE_QUOTE_CATALOG["speech:faux-speech"].binding,
        inputs: [{ kind: "text", text }], parameters: { voiceId: "narrator-main", format: "mp3" }, maxCreateAttempts: 1,
      }, {
        kind: "render", operationId: "film", outputSlot: "film", model: null, maxCreateAttempts: 1,
        inputs: [{ kind: "operation_output", producerOperationId: "shot-1", outputSlot: "video-1" },
          { kind: "operation_output", producerOperationId: "voice", outputSlot: "audio" }],
        parameters: { assembly: "narrated_concat", format: "mp4", width: 1280, height: 720, fps: 24,
          videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" },
      }], finalOutput: { operationId: "film", outputSlot: "film" }, maxSpend: { currency: "CNY", amountMinor: 1500 } });
    const first = confirmScript(l1);
    const proposalCount = count(f, "proposals");
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: makeSpec(l2) }), /旁白.*不一致/);
    assert.equal(count(f, "proposals"), proposalCount, "旁白不一致在落提案前拒绝");
    const p1 = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: makeSpec(l1) })).proposal;
    const confirmations = count(f, "work_review_confirmations");
    const same = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...makeSpec(l1), maxSpend: { currency: "CNY", amountMinor: 1600 } } })).proposal;
    assert.equal(count(f, "work_review_confirmations"), confirmations, "同稿重报消费同一认可，不重复认可");
    const run1 = f.accept(same).run;
    await tick(f, 4);
    assert.equal(f.app.service.getRun("local-owner", run1.id).state, "succeeded");
    const finalized: Record<string, string> = {};
    const finalize = async (runId: string) => {
      const video = videoItemOf(f, f.confirmed.workId);
      assert.equal(video.item.draft?.kind, "artifact_revision");
      const draft = video.item.draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
      assert.ok(f.app.service.getRun("local-owner", runId).outputRevisions.some(ref => ref.revisionId === draft.revisionId));
      const revision = f.app.service.readRevision("local-owner", draft.artifactId, draft.revisionId);
      finalized[runId] = draft.revisionId;
      await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("这版定稿"), reviewConfirmation: {
        workId: f.confirmed.workId, groupId: video.group,
        items: [{ itemId: video.item.id, source: { kind: "artifact_revision", artifactId: draft.artifactId, revisionId: draft.revisionId, digest: revision.digest } }],
        action: "finalize_video",
      } });
    };
    await finalize(run1.id);
    const oldAudio = f.app.service.getRun("local-owner", run1.id).outputRevisions
      .map(ref => f.app.service.readRevision("local-owner", ref.artifactId, ref.revisionId))
      .find(revision => revision.content.format === "media" && revision.content.mimeType.startsWith("audio/"))!;
    const reuse = makeSpec(l2);
    reuse.operations.splice(1, 1);
    // f.spec 的 inputSources 数组被多处浅拷贝共享：换数组不改共享引用。
    reuse.inputSources = [...reuse.inputSources,
      { kind: "artifact_revision", artifactId: oldAudio.artifactId, revisionId: oldAudio.revisionId, digest: oldAudio.digest }];
    reuse.operations[1]!.inputs[1] = { kind: "artifact_revision", artifactId: oldAudio.artifactId,
      revisionId: oldAudio.revisionId, digest: oldAudio.digest };
    assert.equal(productionNarrationText(f.app.database, reuse), l1, "复用音频追溯原生成操作，不读当前脚本");
    // 本地协议夹具，不执行这些占位媒体；真实字节和混音时序由ordered-audio套件验证。
    const external = f.app.production!.blobs.persist(scope.ownerId, scope.conversationId, Buffer.from("external-video-fixture"), "video/mp4", 6000);
    const music = f.app.production!.blobs.persist(scope.ownerId, scope.conversationId, Buffer.from("stereo-music-fixture"), "audio/mpeg", 8000);
    const voiceBlobId = oldAudio.content.format === "media" ? oldAudio.content.blobId : "";
    for (const [candidateId, blobId] of [["fixture-song", music.id], ["fixture-disguised-speech", voiceBlobId]]) {
      const source = { provider: "freetouse" as const, assetId: candidateId!, sourceUrl: `https://api.freetouse.com/v3/music/tracks/${candidateId}`,
        creatorName: "测试作者", creatorUrl: null, licenseUrl: "https://freetouse.com/license", acquiredAt: f.clock(), title: "本地音乐夹具",
        licenseName: "测试许可事实", attributionText: "本地合成测试信号", usageScope: "仅测试", licenseVersion: null };
      persistSearchBatch(f.app.database, f.clock, { ...scope, requestId: f.revision.requestId! }, {
        query: { kind: "audio", provider: "freetouse", query: "fixture", limit: 1 }, toolCallId: candidateId!, workId: null,
      }, [{ candidateId: candidateId!, downloadUrl: "https://eu.data.freetouse.com/fixture.mp3", candidate: {
        candidateId: candidateId!, provider: "freetouse", providerAssetId: candidateId!, kind: "audio", title: "本地音乐夹具",
        sourceUrl: source.sourceUrl, creatorName: source.creatorName, creatorUrl: null, previewUrl: null,
        width: null, height: null, durationMs: 8000, licenseUrl: source.licenseUrl, vocalKind: "song", lyricsLanguage: "en",
      } }]);
      const metadata = (f.app.database.prepare("SELECT metadata_json FROM material_candidates WHERE id=?").get(candidateId) as { metadata_json: string }).metadata_json;
      f.app.database.prepare("UPDATE material_candidates SET imported_blob_id=?, metadata_json=? WHERE id=?")
        .run(blobId, JSON.stringify({ ...JSON.parse(metadata), adoptedSource: source }), candidateId);
    }
    // 认可依据携带当时脚本：mixed 绑定 l1 的认可（复用配音即 l1），换稿后的拒绝分支单独换 l2 认可。
    const l1ReviewInput = confirmed.reviewInput;
    const mixed: ProductionIntent = { ...reuse,
      inputSources: [{ kind: "artifact_revision", artifactId: oldAudio.artifactId, revisionId: oldAudio.revisionId, digest: oldAudio.digest }],
      reviewInputs: [l1ReviewInput], operations: [{ kind: "render", operationId: "mix", outputSlot: "mixed", model: null, maxCreateAttempts: 1,
        inputs: [{ kind: "blob", blobId: external.id, digest: external.digest },
          { kind: "artifact_revision", artifactId: oldAudio.artifactId, revisionId: oldAudio.revisionId, digest: oldAudio.digest },
          { kind: "blob", blobId: music.id, digest: music.digest }],
        parameters: { assembly: "mixed_concat", format: "mp4", width: 1280, height: 720, fps: 24,
          segments: [{ kind: "video", inputSlot: 0, startMs: 0, durationMs: 3000 }, { kind: "video", inputSlot: 0, startMs: 3000, durationMs: 3000, originalGain: 0.4 }],
          segmentIds: ["mix-a", "mix-b"], music: { inputSlot: 2, candidateId: "fixture-song", sourceStartMs: 1000, sourceDurationMs: 6000,
            timelineStartMs: 0, playDurationMs: 6000, repeat: false, gain: 0.2, fadeInMs: 200, fadeOutMs: 400, duckUnderNarration: true },
          narration: { inputSlot: 1, timelineStartMs: 0, gain: 1 } },
      }], finalOutput: { operationId: "mix", outputSlot: "mixed" } };
    assert.equal(productionAudioFacts(f.app.database, mixed).knownNarrationText, l1, "未知原声和歌曲不清空已知独立L1");
    // 换稿：脚本推进到 l2 并重新认可后，引用 l2 认可的报价与 l1 复用配音不一致，必须在准备时拒绝。
    const second = confirmScript(l2);
    await assert.rejects(() => f.app.service.prepareProposal(scope.ownerId, scope.conversationId,
      { commandId: cmd(), spec: { ...mixed, reviewInputs: [confirmed.reviewInput] } }), /旁白.*不一致/);
    const musicProposal = (await f.app.service.prepareProposal(scope.ownerId, scope.conversationId, { commandId: cmd(), spec: mixed })).proposal;
    assert.equal(musicProposal.audioSummary?.narration?.text, l1);
    assert.equal(musicProposal.audioSummary?.music?.source.title, "本地音乐夹具");
    assert.equal(musicProposal.audioSummary?.original[0]?.textCoverage, "unknown");
    assert.ok(validatorFor("Proposal")(musicProposal).ok);
    const disguised = structuredClone(mixed);
    const disguisedRender = disguised.operations[0]!;
    if (disguisedRender.kind !== "render" || disguisedRender.parameters.assembly !== "mixed_concat") throw new Error("expected mixed render");
    disguisedRender.inputs[2] = { kind: "artifact_revision", artifactId: oldAudio.artifactId, revisionId: oldAudio.revisionId, digest: oldAudio.digest };
    disguisedRender.parameters.music = { ...disguisedRender.parameters.music!, candidateId: "fixture-disguised-speech", sourceStartMs: 0, sourceDurationMs: 1, playDurationMs: 1, fadeInMs: 0, fadeOutMs: 0 };
    await assert.rejects(() => f.app.service.prepareProposal(scope.ownerId, scope.conversationId, { commandId: cmd(), spec: disguised }), /已知配音不能放进音乐槽/);
    const noNarration = structuredClone(mixed);
    const noNarrationRender = noNarration.operations[0]!;
    if (noNarrationRender.kind !== "render" || noNarrationRender.parameters.assembly !== "mixed_concat") throw new Error("expected mixed render");
    delete noNarrationRender.parameters.narration;
    noNarrationRender.inputs.splice(1, 1);
    noNarrationRender.parameters.music!.inputSlot = 1;
    noNarration.inputSources = [];
    const noVoice = (await f.app.service.prepareProposal(scope.ownerId, scope.conversationId, { commandId: cmd(), spec: noNarration })).proposal;
    assert.equal(noVoice.audioSummary?.music?.duckUnderNarration, false, "没有独立配音时在digest前展开不避让");
    const nested = makeSpec(l1);
    nested.operations.push({ kind: "render", operationId: "join", outputSlot: "joined", model: null,
      inputs: [{ kind: "operation_output", producerOperationId: "film", outputSlot: "film" }],
      parameters: { assembly: "ordered_concat", audioMode: "preserve", format: "mp4", width: 1280, height: 720, fps: 24 }, maxCreateAttempts: 1 });
    nested.finalOutput = { operationId: "join", outputSlot: "joined" };
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: nested }), /旁白.*不一致/);
    // 模拟修复前已准备好、尚未受理的错绑报价（迁移期旧行带 plan_source_json）；换版不能继续受理这张旧单。
    const oldMismatch = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: reuse })).proposal;
    f.app.database.prepare("UPDATE proposals SET plan_source_json = ? WHERE id = ?")
      .run(canonicalJson({ kind: "artifact_revision", ...second, digest: f.app.service.readRevision("local-owner", second.artifactId, second.revisionId).digest }), oldMismatch.id);
    invalidateLegacyNarrationProposals(f.app.database, f.clock());
    assert.equal(f.app.service.readProposal("local-owner", oldMismatch.id).state, "stale");
    assert.throws(() => f.accept(oldMismatch), /失效|重新/);
    // 重做同一支视频按 F02 指向既有视频事项（existing），不再借 create 另开交付位置。
    const redo = videoItemOf(f, f.confirmed.workId);
    const run2 = f.accept((await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...makeSpec(l2), outputTarget: { group: { mode: "existing", groupId: redo.group }, item: { mode: "existing", itemId: redo.item.id } } } })).proposal).run;
    await tick(f, 4);
    assert.equal(f.app.service.getRun("local-owner", run2.id).state, "succeeded");
    const newAudio = f.app.service.getRun("local-owner", run2.id).outputRevisions
      .map(ref => f.app.service.readRevision("local-owner", ref.artifactId, ref.revisionId))
      .find(revision => revision.content.format === "media" && revision.content.mimeType.startsWith("audio/"))!;
    const correctReuse = structuredClone(reuse);
    const lastInput = correctReuse.inputSources[correctReuse.inputSources.length - 1]!;
    if (lastInput.kind !== "artifact_revision") throw new Error("expected audio input source");
    correctReuse.inputSources[correctReuse.inputSources.length - 1] = { kind: "artifact_revision", artifactId: newAudio.artifactId, revisionId: newAudio.revisionId, digest: newAudio.digest };
    correctReuse.operations[1]!.inputs[1] = { kind: "artifact_revision", artifactId: newAudio.artifactId,
      revisionId: newAudio.revisionId, digest: newAudio.digest };
    assert.equal(productionNarrationText(f.app.database, correctReuse), l2, "即使媒体字节去重，也必须沿准确的生成修订取词");
    await finalize(run2.id);
    const entries = f.app.service.listLibraryVideos("local-owner", undefined, undefined).items;
    assert.equal(entries.length, 2);
    for (const [runId, expected] of [[run1.id, l1], [run2.id, l2]] as const) {
      const frozen = specFor(f.app.database, runRow(f.app.database, runId));
      // 作品库只认 finalize_video 确认的准确成片修订；同一 faux 字节可能链接多个修订，不能按 blob 反查。
      const entry = entries.find(item => item.video.revisionId === finalized[runId])!;
      assert.ok(entry, "定稿确认的成片修订应已入库");
      assert.equal(entry.narrationText, expected);
      assert.equal(entry.plan, null, "新组模型运行没有旧方案绑定");
      assert.equal(entry.provenanceStatus, "recorded");
      assert.equal(entry.reviewSources.length, 1);
      const speech = frozen.operations.find(op => op.kind === "speech")!;
      assert.deepEqual(speech.inputs, [{ kind: "text", text: expected }]);
    }
    // 认可依据冻结在准备时：脚本换稿不回溯失效旧单，它的受理基础仍是当时的准确认可。
    assert.equal(f.app.service.readProposal("local-owner", p1.id).state, "ready");
    assert.equal(f.app.service.readProposal("local-owner", same.id).state, "accepted", "不修改已受理历史");
    assert.equal(count(f, "authorizations"), 2);
  } finally { await f.close(); }
});

it("F3 明确替换同范围预算后两个旧入口均拒绝，普通备选独立，新报价只受理一次", async () => {
  const f = await setup(); try {
    const quote = async (amountMinor: number) => (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor } } })).proposal;
    const old = await quote(2000), alternative = await quote(1800);
    // 范围比较保留 maxCreateAttempts，只允许授权上限变化；报价字段由服务端比较时剥离。
    const spec: ProductionIntent = { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 1300 } };
    f.app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("prepare_production", {
      spec: JSON.parse(JSON.stringify(toolIntentOf(spec))), replacesProposal: { proposalId: old.id, digest: old.digest },
    })]), fauxAssistantMessage("已替换报价，等你确认本次费用。")]);
    await f.app.service.sendMessage("local-owner", f.conversation.id, input("按13元准备，替换掉刚才20元那张报价"));
    for (let i = 0; i < 100 && app_activeRequestId(f); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const current = f.app.service.snapshot("local-owner", f.conversation.id).proposals.items.find(p => p.state === "ready" && p.spec.maxSpend.amountMinor === 1300);
    assert.ok(current, "新报价确实经生产工具创建");
    assert.equal(f.app.service.readProposal("local-owner", old.id).state, "stale");
    assert.equal(f.app.service.readProposal("local-owner", alternative.id).state, "ready", "未明确替换的备选保留");
    const button = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${old.id}/acceptances`, headers,
      payload: { commandId: cmd(), proposalDigest: old.digest } });
    assert.equal(button.json().code, "PROPOSAL_STALE");
    const message = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/messages`, headers,
      payload: { ...input("确认制作"), proposalRef: { proposalId: old.id, digest: old.digest } } });
    assert.equal(message.json().code, "PROPOSAL_STALE");
    assert.equal(count(f, "authorizations"), 0);
    assert.equal(count(f, "production_runs"), 0);
    const receipt = f.accept(current), replay = f.accept(current);
    assert.equal(replay.run.id, receipt.run.id);
    assert.equal(count(f, "authorizations"), 1);
    assert.equal(count(f, "production_runs"), 1);
  } finally { await f.close(); }
});

it("F3 替换额度不足保留撤旧事实，无效替换不改任何报价", async () => {
  const f = await setup(); try {
    const old = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 2000 } } })).proposal;
    const replacesProposal = { proposalId: old.id, digest: old.digest };
    const prepare = (extra: Record<string, unknown> = {}) => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 100 } }, replacesProposal, ...extra });
    await assert.rejects(() => prepare({ replacesProposal: { ...replacesProposal, digest: "f".repeat(64) } }), /替换|摘要/);
    await assert.rejects(() => prepare({ spec: { ...f.spec, inputSources: [], operations: [{ ...f.spec.operations[0]!, inputs: [{ kind: "text", text: "不同画面" }] }] } }), /范围|替换/);
    assert.equal(f.app.service.readProposal("local-owner", old.id).state, "ready");
    const low = (await prepare()).proposal;
    assert.equal(f.app.service.readProposal("local-owner", old.id).state, "stale");
    assert.equal(low.state, "stale");
    assert.match(low.priceDisclosure, /旧报价已撤.*本次报价未就绪/);
    assert.throws(() => f.accept(old), /失效/);
    assert.throws(() => f.accept(low), /失效/);
    assert.equal(count(f, "authorizations"), 0);
    assert.equal(count(f, "production_runs"), 0);
  } finally { await f.close(); }
});

it("B：HTTP 并发/重复确认只有一个授权、快照和运行；异内容冲突，消息入口复用同一 run", async () => {
  const f = await setup(); try {
    const p = await f.proposal(), payload = { commandId: cmd(), proposalDigest: p.digest };
    const requests = await Promise.all([payload, payload, { ...payload, commandId: cmd() }].map(body => f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${p.id}/acceptances`, headers, payload: body })));
    requests.forEach(r => { assert.equal(r.statusCode, 202); assert.equal(validatorFor("AdmissionReceipt")(r.json()).ok, true); });
    assert.equal(new Set(requests.map(r => r.json().run.id)).size, 1);
    assert.equal(count(f, "production_runs"), 1); assert.equal(count(f, "authorizations"), 1); assert.equal(count(f, "production_snapshots"), 1);
    const bad = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/proposals/${p.id}/acceptances`, headers, payload: { ...payload, proposalDigest: "f".repeat(64) } });
    assert.equal(bad.json().code, "IDEMPOTENCY_CONFLICT");
    const received = await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("按这份开始。"), proposalRef: { proposalId: p.id, digest: p.digest } });
    assert.equal(received.receipt.state, "completed"); assert.equal(received.receipt.runId, requests[0]!.json().run.id);
    assert.equal(f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId, null);
    assert.equal(count(f, "production_runs"), 1);
  } finally { await f.close(); }
});

it("B：绑定疑问/否定只聊天；准确确认在同事务保存原文与许可，不占 Pi", async () => {
  const f = await setup(); try {
    const p = await f.proposal();
    f.app.faux!.setResponses([fauxAssistantMessage("只讨论，没有制作。"), fauxAssistantMessage("请先引用提案。")]);
    await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("开始制作？"), proposalRef: { proposalId: p.id, digest: p.digest } });
    await f.app.service.sendMessage("local-owner", f.conversation.id, input("确认制作"));
    assert.equal(count(f, "production_runs"), 0);
    const confirmation = { ...input("确认制作"), proposalRef: { proposalId: p.id, digest: p.digest } };
    const accepted = await f.app.service.sendMessage("local-owner", f.conversation.id, confirmation);
    assert.ok(accepted.receipt.runId);
    const replay = await f.app.service.sendMessage("local-owner", f.conversation.id, confirmation);
    assert.equal(replay.receipt.runId, accepted.receipt.runId);
    assert.equal(count(f, "production_runs"), 1);
    const history = f.app.service.snapshot("local-owner", f.conversation.id).messages.items.slice().reverse();
    const confirmationIndex = history.findIndex(message => message.id === accepted.receipt.messageId);
    const admissionIndex = history.findIndex(message => message.role === "system_notice" && message.references.runIds.includes(accepted.receipt.runId!));
    assert.ok(confirmationIndex < admissionIndex, "确认消息应先于这次受理通知");
    const action = f.app.database.prepare("SELECT source,body_json FROM user_actions").get() as { source: string; body_json: string };
    assert.equal(action.source, "bound_confirmation_message"); assert.equal(JSON.parse(action.body_json).text, "确认制作");
    const conflict = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/messages`, headers,
      payload: { ...input("确认制作"), proposalRef: { proposalId: p.id, digest: p.digest }, skillId: "travel-prompt-kit" } });
    assert.equal(conflict.statusCode, 400);
  } finally { await f.close(); }
});

it("B：输入冻结不阻止后继改稿，run 用原输入，完成不覆盖已保存的下一版", async () => {
  const f = await setup(); try {
    const receipt = f.accept(await f.proposal());
    const target = { artifactId: f.artifact.id, revisionId: f.artifact.revisionId, workId: null };
    const feedback = f.app.service.addFeedback("local-owner", f.conversation.id, { commandId: cmd(), target, text: "下一版更安静" });
    assert.equal(feedback.receipt.disposition, "next_version");
    f.app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "revise", artifactId: target.artifactId, baseRevisionId: target.revisionId, title: "改稿", kind: "prompt", content: { format: "markdown", text: "在途时保存的下一版" } }] })]), fauxAssistantMessage("已保存为下一版；本次制作仍用原输入。")]);
    const modification = await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("改这份"), target });
    for (let i = 0; i < 100; i++) {
      const row = f.app.database.prepare("SELECT state FROM requests WHERE id=?").get(modification.receipt.requestId) as { state: string };
      if (row.state === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // A2/F03：冻结的是本次 run 的输入，不再禁止保存后继修订。
    assert.equal(f.app.service.readArtifactHead("local-owner", f.artifact.id).revisionNumber, 2, "在途改稿应保存成功");
    const delivered = f.app.database.prepare("SELECT state FROM tool_invocations WHERE request_id=? AND tool_name='deliver_artifacts'").get(modification.receipt.requestId) as { state: string };
    assert.equal(delivered.state, "committed", "后继修订有正常业务回执");
    await tick(f, 2);
    const run = f.app.service.getRun("local-owner", receipt.run.id);
    assert.equal(run.state, "succeeded"); assert.equal(run.finance!.state, "settled"); assert.equal(run.finance!.settledMinor, 1200);
    const frozen = specFor(f.app.database, runRow(f.app.database, receipt.run.id));
    assert.ok(frozen.inputSources.some(source => source.kind === "artifact_revision" && source.revisionId === target.revisionId), "快照仍引用冻结的 v1 输入");
    assert.equal(f.app.service.readArtifactHead("local-owner", f.artifact.id).revisionNumber, 2, "完成后不覆盖已保存的后继稿");
    assert.equal(run.outputRevisions.length, 1); assert.equal(count(f, "production_input_locks"), 0);
    assert.equal(validatorFor("Run")(run).ok, true);
    const rev = f.app.service.readRevision("local-owner", run.outputRevisions[0]!.artifactId, run.outputRevisions[0]!.revisionId);
    assert.equal(rev.content.format, "media");
  } finally { await f.close(); }
});

it("B：输入过期、价格版本变化、额度不足、跨用户都不受理；快照不可更新", async () => {
  const f = await setup(); try {
    const low = await f.proposal({ maxSpend: { currency: "CNY", amountMinor: 1 } });
    assert.throws(() => f.accept(low), /授权金额不足/);
    const p = await f.proposal();
    assert.throws(() => f.app.service.acceptProposal("other", p.id, { commandId: cmd(), proposalDigest: p.digest }), /没有找到/);
    const oldQuote = OFFLINE_QUOTE_CATALOG["video:faux-video"].quoteMinor;
    Object.assign(OFFLINE_QUOTE_CATALOG["video:faux-video"], { quoteMinor: 1201 });
    try { assert.throws(() => f.accept(p), /价格已变化/); } finally { Object.assign(OFFLINE_QUOTE_CATALOG["video:faux-video"], { quoteMinor: oldQuote }); }
    const accepted = f.accept(p);
    assert.throws(() => f.app.database.prepare("UPDATE production_snapshots SET spec_json='{}' WHERE id=?").run(accepted.run.snapshotId), /immutable snapshot/);
    // 在途只约束新制作受理（§4.2.1）：报价可以准备，受理被在途唯一约束拒绝。
    const inFlight = await f.proposal();
    assert.throws(() => f.accept(inFlight), /在制作中/);
    assert.equal(count(f, "production_runs"), 1);
  } finally { await f.close(); }
});

it("B：run 终止后同内容重提可再受理，视频发布一次闭合并署名本次运行", async () => {
  const f = await setup(); try {
    const first = f.accept(await f.proposal());
    // create 目标在受理时已分配视频事项；取消后同内容重提按 F02 指向同一事项，不另开交付位置。
    const allocated = videoItemOf(f, f.spec.workId!);
    f.app.service.cancelRun("local-owner", first.run.id, { commandId: cmd(), expectedRevision: first.run.revision });
    await tick(f);
    assert.equal(f.app.service.getRun("local-owner", first.run.id).state, "cancelled");
    const resent = await f.proposal({ outputTarget: { group: { mode: "existing", groupId: allocated.group }, item: { mode: "existing", itemId: allocated.item.id } } });
    const second = f.accept(resent);
    await tick(f, 2);
    assert.equal(f.app.service.getRun("local-owner", second.run.id).state, "succeeded");
    assert.equal(count(f, "production_runs"), 2); assert.equal(count(f, "authorizations"), 2);
    // 发布闭合：成片修订署名本次运行的受理目标与认可来源；用户认可不被代填。
    const video = videoItemOf(f, f.spec.workId!);
    assert.equal(video.item.draft?.kind, "artifact_revision", "视频初稿应进入草稿");
    assert.equal(video.item.approved, null);
    const published = f.app.database.prepare(
      "SELECT r.creation_binding_json AS binding FROM artifact_revisions r WHERE r.run_id=? AND r.creation_binding_json IS NOT NULL",
    ).get(second.run.id) as { binding: string };
    const binding = JSON.parse(published.binding) as CreationBinding;
    assert.equal(binding.workId, f.spec.workId);
    assert.equal(binding.groupId, video.group);
    assert.equal(binding.itemId, video.item.id);
    assert.equal(binding.runId, second.run.id);
    assert.equal(binding.purpose, "production");
    assert.deepEqual(binding.reviewInputs, [{ groupId: f.confirmed.groupId, itemId: f.confirmed.itemId, source: f.confirmed.content, confirmationId: f.confirmed.reviewInput.confirmationId }]);
  } finally { await f.close(); }
});

it("B：仅授权上限变化的重提独立受理并署名新运行；金额不足仍拒绝", async () => {
  const f = await setup(); try {
    const p1 = await f.proposal();
    const first = f.accept(p1);
    f.app.service.cancelRun("local-owner", first.run.id, { commandId: cmd(), expectedRevision: first.run.revision });
    await tick(f);
    const raised = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 1300 } } })).proposal;
    assert.notEqual(raised.digest, p1.digest);
    const second = f.accept(raised);
    await tick(f, 2);
    assert.equal(f.app.service.getRun("local-owner", second.run.id).state, "succeeded");
    const published = f.app.database.prepare(
      "SELECT r.creation_binding_json AS binding FROM artifact_revisions r WHERE r.run_id=? AND r.creation_binding_json IS NOT NULL",
    ).get(second.run.id) as { binding: string };
    const binding = JSON.parse(published.binding) as CreationBinding;
    assert.equal(binding.runId, second.run.id, "成片署名本次运行");
    // 低于必要报价的重提按既有预算规则拒绝。
    const low = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 1 } } })).proposal;
    assert.throws(() => f.accept(low), /授权金额不足/);
  } finally { await f.close(); }
});

it("B：submit 已受理但响应丢失，只查询原 identity，未知保持锁且不新增 attempt", async () => {
  const f = await setup({ loseSubmitResponse: true, recoverySupported: false }); try {
    const r = f.accept(await f.proposal()).run;
    await tick(f, 4);
    const unknown = f.app.service.getRun("local-owner", r.id);
    assert.equal(unknown.state, "unknown"); assert.equal(unknown.finance!.pendingUnknownMinor, 1200); assert.equal(unknown.finance!.reservedMinor, 0);
    assert.equal(count(f, "production_attempts"), 1);
    // 输入锁覆盖 spec 声明的实际输入修订：制作期间不可改（认可依据是事实记录，不锁稿）。
    assert.equal(count(f, "production_input_locks"), 1);
    assert.equal(attemptsFor(f.app.database, r.id)[0]!.phase, "observed");
  } finally { await f.close(); }
});

it("R4：执行异常保留诊断，无任务身份如实说明且只提交一次", async t => {
  const f = await setup();
  let submits = 0, queries = 0;
  const diagnostics = t.mock.method(console, "error", () => {});
  const worker = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, {
    queryRequiresProviderTaskId: true,
    submit: async () => { submits++; throw new Error("synthetic submit failure"); },
    query: async () => { queries++; throw new Error("synthetic recovery failure"); },
    cancel: async () => { throw new Error("must not cancel"); },
  });
  try {
    const r = f.accept(await f.proposal()).run;
    await worker.pollOnce(); f.advance(); await worker.pollOnce();
    const unknown = f.app.service.getRun("local-owner", r.id);
    assert.equal(unknown.state, "unknown");
    assert.match(unknown.issue?.message ?? "", /缺少供应商任务身份，无法向供应商查询/);
    assert.equal(submits, 1); assert.equal(queries, 1);
    assert.equal(count(f, "production_attempts"), 1);
    assert.equal(count(f, "production_input_locks"), 1);
    const attemptId = attemptsFor(f.app.database, r.id)[0]!.id;
    assert.equal(diagnostics.mock.calls.length, 2);
    assert.match(JSON.stringify(diagnostics.mock.calls.map(call => call.arguments)), /synthetic submit failure/);
    assert.match(JSON.stringify(diagnostics.mock.calls.map(call => call.arguments)), /synthetic recovery failure/);
    assert.ok(diagnostics.mock.calls.every(call => JSON.stringify(call.arguments).includes(attemptId)));
  } finally { await worker.close(); await f.close(); }
});

it("B：取消先于提交时没有 create；提交后不支持取消时继续核对，不能假称取消或退款", async () => {
  const f = await setup({ cancellationSupported: false }); try {
    const first = f.accept(await f.proposal()).run;
    f.app.service.cancelRun("local-owner", first.id, { commandId: cmd(), expectedRevision: first.revision });
    await tick(f);
    assert.equal(f.app.service.getRun("local-owner", first.id).state, "cancelled"); assert.equal(count(f, "production_attempts"), 0);
    const second = f.accept(await f.proposal()).run;
    await f.app.worker!.pollOnce();
    const running = f.app.service.getRun("local-owner", second.id);
    f.app.service.cancelRun("local-owner", second.id, { commandId: cmd(), expectedRevision: running.revision });
    await f.app.worker!.pollOnce();
    assert.equal(f.app.service.getRun("local-owner", second.id).state, "cancel_requested");
    assert.equal(f.app.service.getRun("local-owner", second.id).issue?.code, "CANCEL_UNSUPPORTED");
    f.advance(); await f.app.worker!.pollOnce();
    const completed = f.app.service.getRun("local-owner", second.id);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.issue, null, "F08：完成事实到达后清除当前取消/未知提示，历史观测保留");
    assert.equal(completed.outputRevisions.length, 1, "停止后完成的原结果照常保留");
    assert.equal(completed.finance!.settledMinor, 1200);
  } finally { await f.close(); }
});

it("B：两个媒体操作和本地合成按依赖执行，输出槽位固定，下载按归属及 Range", async () => {
  const f = await setup(); try {
    const second = { ...f.spec.operations[0]!, operationId: "shot-2", outputSlot: "video-2" };
    const p = await f.proposal({ operations: [f.spec.operations[0]!, second, { operationId: "render", outputSlot: "final", kind: "render", model: null,
      inputs: [{ kind: "operation_output", producerOperationId: "shot-1", outputSlot: "video-1" }, { kind: "operation_output", producerOperationId: "shot-2", outputSlot: "video-2" }], maxCreateAttempts: 1,
      parameters: { assembly: "ordered_concat", format: "mp4", width: 640, height: 360, fps: 24 } }], finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 2400 } });
    const r = f.accept(p).run;
    await tick(f, 6);
    const run = f.app.service.getRun("local-owner", r.id);
    assert.equal(run.state, "succeeded"); assert.equal(run.outputRevisions.length, 3); assert.equal(run.finance!.settledMinor, 2400);
    const revision = f.app.service.readRevision("local-owner", run.outputRevisions[2]!.artifactId, run.outputRevisions[2]!.revisionId);
    assert.equal(revision.content.format, "media"); if (revision.content.format !== "media") return;
    const url = `/api/agent/v1/blobs/${revision.content.blobId}/content`;
    const range = await f.app.app.inject({ method: "GET", url, headers: { range: "bytes=0-31" } });
    assert.equal(range.statusCode, 206); assert.equal(range.rawPayload.length, 32); assert.match(range.headers["content-type"]!, /video\/mp4/);
    assert.equal((await f.app.app.inject({ method: "GET", url, headers: { range: "bytes=9999999-" } })).statusCode, 416);
    assert.throws(() => f.app.service.readBlob("other", revision.content.format === "media" ? revision.content.blobId : ""), /没有找到/);
  } finally { await f.close(); }
});

it("B：账单乱序/同版冲突/退款按供应商版本合并，执行成功与财务结清分离", async () => {
  const f = await setup({ billing: null }); try {
    const r = f.accept(await f.proposal()).run;
    await tick(f, 2);
    let run = f.app.service.getRun("local-owner", r.id);
    assert.equal(run.state, "succeeded"); assert.equal(run.finance!.state, "pending_reconciliation"); assert.equal(count(f, "production_input_locks"), 0);
    const attempt = attemptsFor(f.app.database, r.id)[0]!;
    const observation = (revision: string, amount: number, final: boolean): ExecutionObservation => ({ observationId: cmd(), attemptId: attempt.id, state: "succeeded", providerTaskId: attempt.provider_task_id, blob: null,
      observedAt: f.clock(), message: null, billing: { kind: "authoritative", billingFactId: "bill-1", sourceRevision: revision, netAmount: { currency: "CNY", amountMinor: amount }, final, evidenceId: cmd() } });
    const apply = async (obs: ExecutionObservation) => {
      const worker = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, {
        submit: async () => { throw new Error("must not create"); }, cancel: async () => obs, query: async () => obs,
      });
      await worker.pollOnce(); await worker.close();
      return f.app.service.getRun("local-owner", r.id);
    };
    run = await apply(observation("9007199254740993", 1500, false)); assert.equal(run.finance!.settledMinor, 0);
    run = await apply(observation("9007199254740994", 1500, true)); assert.equal(run.finance!.settledMinor, 1500); assert.equal(run.finance!.state, "settled");
    // 后续可信更正可能晚于结清，从观测入口进入；调度不制造账单版本。
    const inject = (obs: ExecutionObservation) => {
      const row = runRow(f.app.database, r.id);
      f.app.database.prepare("INSERT INTO ledger_observations(attempt_id,digest,observation_json) VALUES(?,?,?)").run(attempt.id, cmd(), JSON.stringify(obs));
      // 模拟已收到新账务证据的待处理标记，保留原净额。
      f.app.database.prepare("UPDATE production_attempts SET billing_conflict=1 WHERE id=?").run(attempt.id);
      assert.equal(row.state, "succeeded");
    };
    inject(observation("9007199254740992", 2000, true)); run = await apply(observation("9007199254740995", 900, true));
    assert.equal(run.finance!.settledMinor, 900); assert.equal(run.finance!.state, "settled");
    inject(observation("9007199254740995", 800, true)); run = await apply(observation("9007199254740995", 900, true));
    assert.equal(run.finance!.settledMinor, 900); assert.equal(run.finance!.state, "pending_reconciliation");
    assert.equal(run.finance!.pendingUnknownMinor, 300, "已记账的 900 不能再次计入待核占用");
  } finally { await f.close(); }
});

it("B：一次性 SubmitPermit 无法伪造或重放", () => {
  const permit = issueSubmitPermit("att-1", 1);
  assert.throws(() => consumeSubmitPermit(JSON.parse(JSON.stringify(permit)), "att-1"), /许可/);
  consumeSubmitPermit(permit, "att-1");
  assert.throws(() => consumeSubmitPermit(permit, "att-1"), /许可/);
});

it("审计 F1：prepared 恢复先应用迟到费用更正，超额时不提交第二项", async () => {
  const f = await setup();
  const port = new FauxMediaPort(f.directory, f.app.database, f.app.production!.blobs, f.clock, { fixtureRoot: path.join(studioRoot, "fixtures/agent"), delayMs: 1000 });
  let submits = 0;
  const counted = { submit: async (...args: Parameters<typeof port.submit>) => { submits++; return port.submit(...args); }, query: port.query.bind(port), cancel: port.cancel.bind(port) };
  const crash = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, counted, { crash: point => { if (point === "after-attempt-prepared") throw new Error("prepared crash"); } });
  const resumed = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, counted);
  try {
    const r = f.accept(await f.proposal({ operations: [f.spec.operations[0]!, { ...f.spec.operations[0]!, operationId: "second", outputSlot: "second" }], maxSpend: { currency: "CNY", amountMinor: 2400 } })).run;
    await tick(f, 2);
    await assert.rejects(crash.pollOnce(), /prepared crash/);
    const first = attemptsFor(f.app.database, r.id)[0]!;
    const billing = JSON.parse(first.billing_json!) as Extract<BillingFact, { kind: "authoritative" }>;
    const correction: ExecutionObservation = { observationId: cmd(), attemptId: first.id, state: "succeeded", providerTaskId: first.provider_task_id, blob: null, observedAt: f.clock(), message: null,
      billing: { ...billing, sourceRevision: "3", netAmount: { currency: "CNY", amountMinor: 2500 }, evidenceId: "corrected-invoice" } };
    f.app.database.prepare("INSERT INTO ledger_observations(attempt_id,digest,observation_json) VALUES(?,?,?)").run(first.id, cmd(), JSON.stringify(correction));
    await resumed.pollOnce();
    const run = f.app.service.getRun("local-owner", r.id);
    assert.equal(submits, 0, "恢复已有 prepared 时也必须阻止超额提交");
    assert.equal(run.issue?.code, "BUDGET_EXHAUSTED");
    assert.equal(run.finance!.settledMinor, 2500); assert.equal(run.finance!.reservedMinor, 0);
    assert.equal(run.outputRevisions.length, 1);
    assert.equal(attemptsFor(f.app.database, r.id)[1]!.state, "cancelled");
  } finally { await crash.close(); await resumed.close(); port.close(); await f.close(); }
});

it("审计 F2：另一账单身份冲突不能由原身份更高版本自动消除", async () => {
  const f = await setup({ billing: null });
  try {
    const r = f.accept(await f.proposal()).run;
    await tick(f, 2);
    const a = attemptsFor(f.app.database, r.id)[0]!;
    for (const [billingFactId, sourceRevision, amount] of [["bill-A", "1", 1000], ["bill-B", "1", 1200], ["bill-A", "2", 1100]] as const) {
      const obs: ExecutionObservation = { observationId: cmd(), attemptId: a.id, state: "succeeded", providerTaskId: a.provider_task_id, blob: null, observedAt: f.clock(), message: null,
        billing: { kind: "authoritative", billingFactId, sourceRevision, netAmount: { currency: "CNY", amountMinor: amount }, final: true, evidenceId: cmd() } };
      f.app.database.prepare("INSERT INTO ledger_observations(attempt_id,digest,observation_json) VALUES(?,?,?)").run(a.id, cmd(), JSON.stringify(obs));
      const worker = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, { submit: async () => { throw new Error("must not submit"); }, query: async () => obs, cancel: async () => obs });
      await worker.pollOnce(); await worker.close();
    }
    const run = f.app.service.getRun("local-owner", r.id);
    assert.equal(run.finance!.settledMinor, 1100);
    assert.equal(run.finance!.state, "pending_reconciliation");
    assert.equal(attemptsFor(f.app.database, r.id)[0]!.billing_conflict, 1);
  } finally { await f.close(); }
});

it("B：后台最多两个媒体调用在途，未领取的第三项仍持久排队", async () => {
  const f = await setup();
  const port = new FauxMediaPort(f.directory, f.app.database, f.app.production!.blobs, f.clock, { fixtureRoot: path.join(studioRoot, "fixtures/agent"), delayMs: 1000 });
  let release = () => {}, entered = () => {}, active = 0, peak = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const both = new Promise<void>(resolve => { entered = resolve; });
  const worker = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, {
    submit: async (request, permit) => { active++; peak = Math.max(peak, active); if (active === 2) entered(); await gate; try { return await port.submit(request, permit); } finally { active--; } },
    query: query => port.query(query), cancel: query => port.cancel(query),
  });
  try {
    // 一条视频创作同时只允许一个在途制作；三条并发运行各占一条独立事项。
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    const works = [0, 1, 2].map(() => seedConfirmedWork(f.app.database, f.clock(), scope, "并发短片"));
    const runs: Run[] = [];
    for (const work of works) runs.push(f.accept(await f.proposal({ workId: work.workId, reviewInputs: [work.reviewInput] })).run);
    const pending = worker.pollOnce(); await both;
    assert.equal(count(f, "production_attempts"), 2);
    assert.equal(f.app.service.getRun("local-owner", runs[2]!.id).state, "queued");
    release(); await pending; f.advance(); await worker.pollOnce(); f.advance(); await worker.pollOnce();
    assert.equal(peak, 2); assert.equal(count(f, "production_attempts"), 3);
  } finally { release(); await worker.close(); port.close(); await f.close(); }
});

it("B：旧租约 worker 迟到仅存观测，新持有者核对同一尝试，不能回退完成状态", async () => {
  const f = await setup();
  const port = new FauxMediaPort(f.directory, f.app.database, f.app.production!.blobs, f.clock, { fixtureRoot: path.join(studioRoot, "fixtures/agent"), delayMs: 1000 });
  let release = () => {}, started = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const old = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, {
    submit: async (request, permit) => { const observation = await port.submit(request, permit); started(); await held; return observation; },
    query: query => port.query(query), cancel: query => port.cancel(query),
  });
  const current = new ProductionWorker(f.app.database, f.clock, new EventHub(), f.app.production!.blobs, port);
  try {
    const r = f.accept(await f.proposal()).run;
    const pending = old.pollOnce(); await entered;
    for (let i = 0; i < 13; i++) f.advance();
    await current.pollOnce();
    assert.equal(f.app.service.getRun("local-owner", r.id).state, "succeeded");
    release(); await pending;
    assert.equal(f.app.service.getRun("local-owner", r.id).state, "succeeded");
    assert.equal((f.app.database.prepare("SELECT COUNT(*) AS n FROM ledger_observations WHERE applied=0").get() as { n: number }).n, 1);
    await current.pollOnce();
    assert.equal(f.app.service.getRun("local-owner", r.id).outputRevisions.length, 1);
    assert.equal(f.app.service.getRun("local-owner", r.id).finance!.settledMinor, 1200);
    assert.equal((port.providerDb.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 1);
  } finally { release(); await old.close(); await current.close(); port.close(); await f.close(); }
});

it("B：失败的新尝试受次数与额度约束；已提交实际超额完整入账，后续操作不提交", async () => {
  const f = await setup({ outcome: "failed" }); try {
    const video = f.spec.operations[0]!;
    assert.ok(video.kind === "video");
    const p = await f.proposal({ operations: [{ ...video, maxCreateAttempts: 2 }], maxSpend: { currency: "CNY", amountMinor: 2400 } });
    const r = f.accept(p).run;
    await tick(f, 5);
    assert.equal(f.app.service.getRun("local-owner", r.id).state, "failed");
    assert.equal(count(f, "production_attempts"), 2); assert.equal(f.app.service.getRun("local-owner", r.id).finance!.settledMinor, 2400);
  } finally { await f.close(); }
  const g = await setup({ billing: { kind: "authoritative", billingFactId: "overspend", sourceRevision: "2", netAmount: { currency: "CNY", amountMinor: 2500 }, final: true, evidenceId: "invoice" } });
  try {
    const p = await g.proposal({ operations: [g.spec.operations[0]!, { ...g.spec.operations[0]!, operationId: "second", outputSlot: "second" }], maxSpend: { currency: "CNY", amountMinor: 2400 } });
    const r = g.accept(p).run;
    await tick(g, 4);
    const run = g.app.service.getRun("local-owner", r.id);
    assert.equal(run.state, "failed"); assert.equal(run.issue?.code, "BUDGET_EXHAUSTED");
    assert.equal(run.finance!.settledMinor, 2500); assert.equal(count(g, "production_attempts"), 1);
  } finally { await g.close(); }
});

// 等待 faux Pi 回合收尾（prepare_production 测试用）。
function app_activeRequestId(f: Awaited<ReturnType<typeof setup>>): string | null {
  return f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId;
}

it("G3-3 混音音乐槽接受本地 WAV：无 candidateId 不伪造来源，旁白槽仍拒 WAV", async () => {
  const f = await setup(); try {
    const external = f.app.production!.blobs.persist("local-owner", f.conversation.id, Buffer.from("external-video-fixture"), "video/mp4", 6000);
    // 本地登记的程序 WAV：与素材库无关，无采用候选。
    const localWav = f.app.production!.blobs.persist("local-owner", f.conversation.id, Buffer.from("local-chime-wav-fixture"), "audio/wav", 8000);
    const mixed: ProductionIntent = { ...f.spec,
      inputSources: [], reviewInputs: [f.confirmed.reviewInput],
      operations: [{ kind: "render", operationId: "mix", outputSlot: "mixed", model: null, maxCreateAttempts: 1,
        inputs: [{ kind: "blob", blobId: external.id, digest: external.digest },
          { kind: "blob", blobId: localWav.id, digest: localWav.digest }],
        parameters: { assembly: "mixed_concat", format: "mp4", width: 1280, height: 720, fps: 24,
          segments: [{ kind: "video", inputSlot: 0, startMs: 0, durationMs: 6000 }],
          segmentIds: ["walk-a"], music: { inputSlot: 1, sourceStartMs: 1000, sourceDurationMs: 6000,
            timelineStartMs: 0, playDurationMs: 6000, repeat: false, gain: 0.2, fadeInMs: 200, fadeOutMs: 400, duckUnderNarration: false } } }],
      finalOutput: { operationId: "mix", outputSlot: "mixed" } };
    const proposal = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: mixed })).proposal;
    assert.ok(proposal.audioSummary, "报价带声音事实摘要");
    assert.equal(proposal.audioSummary!.music, null, "本地音频无外部采用来源，不伪造 music 来源卡片");
    assert.ok(proposal.audioSummary!.original[0]!, "画面原声摘要仍在");
    assert.ok(validatorFor("Proposal")(proposal).ok);

    // 伪造外部候选 ID：候选不存在，如实拒绝（不静默放行）。
    const forged = structuredClone(mixed);
    const forgedRender = forged.operations[0]!;
    if (forgedRender.kind !== "render" || forgedRender.parameters.assembly !== "mixed_concat") throw new Error("expected mixed render");
    forgedRender.parameters.music = { ...forgedRender.parameters.music!, candidateId: "nonexistent-candidate" };
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: forged }), /没有找到这个会话里的音乐候选/);

    // 旁白槽仍是供应商 MP3 契约：本地 WAV 放旁白槽被拒（音乐槽与旁白槽分开构造，避免槽位重叠先触发）。
    const wavNarration = structuredClone(mixed);
    const narrationRender = wavNarration.operations[0]!;
    if (narrationRender.kind !== "render" || narrationRender.parameters.assembly !== "mixed_concat") throw new Error("expected mixed render");
    const narrationWav = f.app.production!.blobs.persist("local-owner", f.conversation.id, Buffer.from("local-narration-wav-fixture"), "audio/wav", 5000);
    narrationRender.inputs.push({ kind: "blob", blobId: narrationWav.id, digest: narrationWav.digest });
    narrationRender.parameters.narration = { inputSlot: 2, timelineStartMs: 0, gain: 1 };
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: wavNarration }), /旁白槽只接受音频素材/);

    // 报价的运行范围与来源事实保持一致：spec 内没有伪造的 musicSource。
    const mixedOperation = proposal.spec.operations[0]!;
    assert.ok(mixedOperation.kind === "render" && mixedOperation.parameters.assembly === "mixed_concat");
    assert.equal(mixedOperation.musicSource, undefined, "无 candidateId 时 spec 不带外部音乐来源");
  } finally { await f.close(); }
});

// §15.3 A1（F01）：正式批次只要含视频产出就走视频认可门，与操作顺序、finalOutput 位置无关；
// 未认可不落 run；认可实际消费版本后混批可受理；未采用的无关事项不产生义务；preview 仍是局部试做语义。
it("A1 混合批次认可门：video+image 未认可不落 run；认可实际版本后两种顺序均可受理；无关事项与 preview 不受阻", async () => {
  const f = await setup({ delayMs: 0 }); try {
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    // 脚本推进到 v2 但不认可：正式视频消费的必选依据处于未认可状态，v1 认可仍在历史里。
    const contentDraft = f.confirmed.content.kind === "artifact_revision" ? f.confirmed.content : null;
    assert.ok(contentDraft, "夹具内容稿应是产物修订");
    const seeded = deliverReviewDrafts(f.app.database, f.clock(), scope, {
      items: [{ mode: "revise", artifactId: contentDraft.artifactId, baseRevisionId: contentDraft.revisionId,
        title: "山路脚本", kind: "script", content: { format: "markdown", text: "清晨沿山路行进的固定镜头。（第二版）" } }],
      reviewGroups: [{ workId: f.confirmed.workId,
        group: { mode: "existing", groupId: f.confirmed.groupId },
        items: [{ item: { mode: "existing", itemId: f.confirmed.itemId }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "production" }] }],
    });
    const v2Row = seeded.receipt.revisions[0]!;
    const v2 = { kind: "artifact_revision" as const, artifactId: v2Row.artifactId, revisionId: v2Row.revisionId,
      digest: (f.app.database.prepare("SELECT digest FROM artifact_revisions WHERE artifact_id=? AND id=?")
        .get(v2Row.artifactId, v2Row.revisionId) as { digest: string }).digest };
    // 同 work 另一个未采用、未认可的必选事项：受理不应要求全 work 全认。
    deliverReviewDrafts(f.app.database, f.clock(), scope, {
      items: [{ mode: "create", title: "山路视觉方案", kind: "script", content: { format: "markdown", text: "# 视觉\n晨雾。" } }],
      reviewGroups: [{ workId: f.confirmed.workId,
        group: { mode: "create", key: "visual", title: "视觉方案", nextIntent: null },
        items: [{ item: { mode: "create", key: "storyboard", label: "画面", role: "storyboard", required: true },
          itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "production" }] }],
    });
    const mixed = (order: "video-first" | "image-first", reviewInputs: ProductionIntent["reviewInputs"]): ProductionIntent => {
      const video: OperationRequest = { operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
        inputs: [v2], maxCreateAttempts: 1,
        parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } };
      const image: OperationRequest = { operationId: "cover-1", outputSlot: "image-1", kind: "image", model: OFFLINE_QUOTE_CATALOG["image:faux-image"].binding,
        inputs: [{ kind: "text", text: "山路封面" }], maxCreateAttempts: 1, parameters: { aspectRatio: "16:9", resolution: "640x360" } };
      const operations: ProductionIntent["operations"] = order === "video-first" ? [video, image] : [image, video];
      return { workId: f.confirmed.workId, title: "山路短片",
        inputSources: [v2], reviewInputs, purpose: "production", scope: "正式整片加封面",
        operations,
        finalOutput: { operationId: "shot-1", outputSlot: "video-1" },
        outputTarget: finalVideoTarget(), maxSpend: { currency: "CNY", amountMinor: 1500 } };
    };
    // 空认可清单：两种顺序同样被受理门拦下（旧的“只看最后操作”缺陷不复存在）。
    for (const order of ["video-first", "image-first"] as const) {
      const noApproval = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
        { commandId: cmd(), spec: mixed(order, []) })).proposal;
      assert.equal(noApproval.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED", order);
      assert.match(noApproval.acceptanceBlocker!.message, /组审阅认可/);
      assert.throws(() => f.accept(noApproval), /组审阅认可/);
    }
    assert.equal(count(f, "production_runs"), 0);
    // 只报 v1 内容确认、实际消费未认 v2：覆盖推导按真实消费拦准确版本。
    const staleVersion = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: mixed("video-first", [f.confirmed.reviewInput]) })).proposal;
    assert.equal(staleVersion.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    assert.match(staleVersion.acceptanceBlocker!.message, /还未获得认可/);
    // 认可 v2 后，两种顺序的混批均可受理；无关的未认画面事项不阻塞。
    recordReviewConfirmation(f.app.database, f.clock(), scope, {
      workId: f.confirmed.workId, groupId: f.confirmed.groupId,
      items: [{ itemId: f.confirmed.itemId, source: v2 }], action: "approve",
    }, { kind: "user_message", messageId: seeded.messageId });
    for (const order of ["video-first", "image-first"] as const) {
      const admitted = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
        { commandId: cmd(), spec: mixed(order, [f.confirmed.reviewInput]) })).proposal;
      assert.equal(admitted.acceptanceBlocker, null, order);
      const run = f.accept(admitted);
      await tick(f, 8);
      assert.equal(f.app.service.getRun("local-owner", run.run.id).state, "succeeded", order);
    }
    assert.equal(count(f, "production_runs"), 2);
    // preview 混批：局部试做语义，不需要组认可。
    const previewSpec = mixed("video-first", []);
    previewSpec.purpose = "preview";
    const preview = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: previewSpec })).proposal;
    assert.equal(preview.acceptanceBlocker, null);
    f.accept(preview);
    assert.equal(count(f, "production_runs"), 3);
    assert.equal(count(f, "work_review_confirmations"), 2, "只有脚本 v1 夹具认可与本测试补的 v2 认可，画面事项未被代填");
  } finally { await f.close(); }
});

// §15.4 B（F02）：目标归属一次核对；旧 ready 缺目标按 blocker 指引重新准备、补目标走窄替换；
// 已有目标的替换不能换交付位置；同命令回放沿原 run，不重复分配或计费。
it("B：目标归属与窄替换：别work拒绝无残留；旧ready缺目标补目标替换成功；已有目标替换不能换位置；回放不重复分配", async () => {
  const f = await setup({ delayMs: 0 }); try {
    // —— 目标别 work：existing 组属于另一件作品，准备入口拒绝，不落提案。 ——
    const other = seedConfirmedWork(f.app.database, f.clock(), { ownerId: "local-owner", conversationId: f.conversation.id }, "另一部短片");
    const proposalsBefore = count(f, "proposals");
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(),
      spec: { ...f.spec, outputTarget: { group: { mode: "existing", groupId: other.groupId }, item: { mode: "existing", itemId: other.itemId } } } }),
      /输出目标所属的审阅组不存在/);
    assert.equal(count(f, "proposals"), proposalsBefore, "拒绝不落提案、无 run/授权残留");
    assert.equal(count(f, "production_runs"), 0);
    assert.equal(count(f, "authorizations"), 0);

    // —— 旧 ready 缺目标（字段上线前的历史事实）：受理门按 blocker 指引重新准备。 ——
    const modern = await f.proposal();
    const stored = JSON.parse(f.app.database.prepare("SELECT spec_json FROM proposals WHERE id=?").pluck().get(modern.id) as string);
    delete stored.outputTarget;
    const legacyDigest = digestOf(stored);
    f.app.database.prepare("UPDATE proposals SET spec_json=?, digest=? WHERE id=?").run(canonicalJson(stored), legacyDigest, modern.id);
    const legacyReady = f.app.service.snapshot("local-owner", f.conversation.id).proposals.items.find(p => p.id === modern.id)!;
    assert.equal(legacyReady.acceptanceBlocker?.code, "INPUT_CHANGED");
    assert.match(legacyReady.acceptanceBlocker!.message, /需要明确交付位置/);
    assert.throws(() => f.app.service.acceptProposal("local-owner", modern.id, { commandId: cmd(), proposalDigest: legacyDigest }),
      /需要明确交付位置/);
    // 唯一兼容例外：其余制作范围完全一致，补入已核对的新目标，明确替换旧报价。
    const replaced = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: f.spec, replacesProposal: { proposalId: modern.id, digest: legacyDigest } })).proposal;
    assert.equal(replaced.state, "ready");
    assert.equal(f.app.service.readProposal("local-owner", modern.id).state, "stale");

    // —— 同命令回放沿原 run：create 目标只在受理事务分配一次，不重复建组/计费。 ——
    const commandId = cmd();
    const admitted = f.app.service.acceptProposal("local-owner", replaced.id, { commandId, proposalDigest: replaced.digest });
    assert.equal(f.app.service.acceptProposal("local-owner", replaced.id, { commandId, proposalDigest: replaced.digest }).run.id, admitted.run.id);
    assert.equal(count(f, "authorizations"), 1);
    const allocated = videoItemOf(f, f.confirmed.workId);
    assert.equal(allocated.item.draft, null, "create 目标受理时分配身份、当时无稿");
    await tick(f, 4);
    assert.equal(f.app.service.getRun("local-owner", admitted.run.id).state, "succeeded");
    const landed = videoItemOf(f, f.confirmed.workId);
    assert.equal(landed.item.id, allocated.item.id);
    assert.ok(landed.item.draft?.kind === "artifact_revision", "产出文件落位后才登记草稿");

    // —— 已有目标的替换必须落在同一交付位置：借替换换目标被拒，指向原位置可替换。 ——
    const sameTarget = { group: { mode: "existing" as const, groupId: allocated.group }, item: { mode: "existing" as const, itemId: allocated.item.id } };
    const withTarget = await f.proposal({ outputTarget: sameTarget });
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(),
      spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 1300 }, outputTarget: finalVideoTarget("另一成片") },
      replacesProposal: { proposalId: withTarget.id, digest: withTarget.digest } }), /同一交付位置/);
    const relocated = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(),
      spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 1300 }, outputTarget: sameTarget },
      replacesProposal: { proposalId: withTarget.id, digest: withTarget.digest } })).proposal;
    assert.equal(relocated.state, "ready");
    assert.equal(f.app.service.readProposal("local-owner", withTarget.id).state, "stale");
  } finally { await f.close(); }
});
