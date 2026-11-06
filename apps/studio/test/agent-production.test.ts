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
import { persistSearchBatch } from "../src/server/agent/material-store.js";
import { canonicalJson } from "../src/server/agent/util.js";
import { bindPreparedPlan, deliverPlanDraft, deliverStageDrafts, seedPlanStageWork, type PlanStageWork } from "./helpers/creative-work-fixture.js";
import type { BillingFact, ExecutionObservation, ProductionIntent, Proposal, Run } from "../src/shared/agent/generated/contracts.js";

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
  // B04：新视频必须落在已进入方案阶段的创作事项内；受理还需方案主稿与本提案关联。
  const planWork = seedPlanStageWork(app.database, clock(), { ownerId: "local-owner", conversationId: conversation.id }, "山路短片");
  const spec: ProductionIntent = { workId: planWork.workId, title: "山路短片", inputRevisions: [{ artifactId: artifact.id, revisionId: artifact.revisionId }],
    operations: [{ operationId: "shot-1", outputSlot: "video-1", kind: "video", model: OFFLINE_QUOTE_CATALOG["video:faux-video"].binding,
      inputs: [{ kind: "artifact_revision", artifactId: artifact.id, revisionId: artifact.revisionId, digest: revision.digest }], maxCreateAttempts: 1,
      parameters: { durationSeconds: 3, aspectRatio: "16:9", resolution: "640x360", audioMode: "none" } }],
    finalOutput: { operationId: "shot-1", outputSlot: "video-1" }, maxSpend: { currency: "CNY", amountMinor: 1200 } };
  const proposal = async (overrides: Partial<ProductionIntent> = {}, work: PlanStageWork = planWork) => {
    const prepared = (await app.service.prepareProposal("local-owner", conversation.id, { commandId: cmd(), spec: { ...spec, ...overrides } })).proposal;
    // 原样重提在 prepare 事务已继承方案关联（§10.1），不再交付新方案稿；只有未关联的新提案走真实交付绑定。
    const bound = app.database.prepare("SELECT plan_source_json FROM proposals WHERE id=?").get(prepared.id) as { plan_source_json: string | null };
    if (!bound.plan_source_json) bindPreparedPlan(app.database, clock(), { ownerId: "local-owner", conversationId: conversation.id }, prepared, work);
    return prepared;
  };
  const accept = (p: Proposal) => app.service.acceptProposal("local-owner", p.id, { commandId: cmd(), proposalDigest: p.digest });
  return { app, directory, conversation, artifact, revision, spec, proposal, accept, clock, planWork,
    advance: () => { time += 5000; },
    close: async () => { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}
async function tick(f: Awaited<ReturnType<typeof setup>>, count = 1) { for (let i = 0; i < count; i++) { await f.app.worker!.pollOnce(); f.advance(); } }
function count(f: Awaited<ReturnType<typeof setup>>, table: string) { return (f.app.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }
// 只统计方案主稿（stage=plan）绑定；视频成片绑定（stage=video）不算方案稿。
function boundPlanCount(f: Awaited<ReturnType<typeof setup>>) {
  return (f.app.database.prepare(
    `SELECT COUNT(*) AS n FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id
     WHERE a.conversation_id=? AND json_extract(r.creation_binding_json,'$.stage')='plan'`,
  ).get(f.conversation.id) as { n: number }).n;
}
function planStageOf(f: Awaited<ReturnType<typeof setup>>, workId: string) {
  const row = f.app.database.prepare("SELECT creation_state_json FROM works WHERE id=?").get(workId) as { creation_state_json: string };
  type Draft = { kind: string; revisionId?: string } | null;
  return JSON.parse(row.creation_state_json) as {
    plan: { proposalId: string | null; draft: Draft };
    video: { draft: Draft; approved: Draft };
  };
}

it("已认可方案直接准备制作，不重交同稿；一次确认启动，视频先为草稿", async () => {
  const f = await setup(); try {
    deliverPlanDraft(f.app.database, f.clock(), { ownerId: "local-owner", conversationId: f.conversation.id }, f.planWork, null);
    const work = f.app.service.snapshot("local-owner", f.conversation.id).works[0]!;
    const source = work.stages.plan.draft!;
    assert.equal(source.kind, "artifact_revision");
    if (source.kind !== "artifact_revision") throw new Error("expected plan revision");
    await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("认可方案，暂不制作"),
      stageConfirmation: { workId: work.id, action: "approve_plan", subject: source } });
    const confirmationCount = count(f, "work_stage_confirmations");
    const response = await f.app.app.inject({ method: "POST", url: `/api/agent/v1/conversations/${f.conversation.id}/proposals`, headers,
      payload: { commandId: cmd(), spec: f.spec, planSource: { artifactId: source.artifactId, revisionId: source.revisionId } } });
    assert.equal(response.statusCode, 201, response.body);
    const p = response.json() as Proposal;
    const prepared = f.app.service.snapshot("local-owner", f.conversation.id).works[0]!;
    assert.equal(prepared.stages.plan.proposalId, p.id);
    assert.deepEqual(prepared.stages.plan.draft, source);
    assert.deepEqual(prepared.stages.plan.approved, source);
    assert.equal(count(f, "work_stage_confirmations"), confirmationCount);
    assert.equal(boundPlanCount(f), 1);
    assert.equal(count(f, "production_runs"), 0);
    const receipt = f.accept(p);
    await tick(f, 2);
    const run = f.app.service.getRun("local-owner", receipt.run.id);
    assert.equal(run.state, "succeeded");
    assert.equal(count(f, "authorizations"), 1);
    const finished = f.app.service.snapshot("local-owner", f.conversation.id).works[0]!;
    assert.equal(finished.stages.video.draft?.kind, "artifact_revision");
    assert.equal(finished.stages.video.approved, null);
  } finally { await f.close(); }
});

it("F2 逐字旁白在首次报价、同稿重报、新稿绑定和两版作品库保持一致", async () => {
  const f = await setup({ delayMs: 0 }); try {
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    const l1 = "雨停之前，先喝一杯咖啡。", l2 = "窗外下雨，杯里回暖。";
    const makeSpec = (text: string): ProductionIntent => ({ ...f.spec, inputRevisions: [...f.spec.inputRevisions],
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
    const first = deliverStageDrafts(f.app.database, f.clock(), scope, {
      items: [{ mode: "create", title: "雨天方案", kind: "script", content: { format: "markdown", text: "固定机位，片头读旁白。", narrationText: l1 } }],
      stageDrafts: [{ workId: f.planWork.workId, stage: "plan", itemIndex: 0, source: f.planWork.content, proposalRef: null }],
    }).revisions[0]!;
    const proposalCount = count(f, "proposals");
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource: first, spec: makeSpec(l2) }), /旁白.*不一致|新方案/);
    assert.equal(count(f, "proposals"), proposalCount, "首次错绑在落提案前拒绝");
    const p1 = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource: first, spec: makeSpec(l1) })).proposal;
    const confirmations = count(f, "work_stage_confirmations"), plans = boundPlanCount(f);
    const same = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource: first, spec: { ...makeSpec(l1), maxSpend: { currency: "CNY", amountMinor: 1600 } } })).proposal;
    assert.equal(boundPlanCount(f), plans);
    assert.equal(count(f, "work_stage_confirmations"), confirmations);
    assert.equal(planStageOf(f, f.planWork.workId).plan.draft?.revisionId, first.revisionId);
    const run1 = f.accept(same).run;
    await tick(f, 4);
    assert.equal(f.app.service.getRun("local-owner", run1.id).state, "succeeded");
    const finalize = async (runId: string) => {
      const video = f.app.service.snapshot("local-owner", f.conversation.id).works.find(work => work.id === f.planWork.workId)!.stages.video.draft!;
      assert.equal(video.kind, "artifact_revision");
      if (video.kind !== "artifact_revision") throw new Error("expected video revision");
      assert.ok(f.app.service.getRun("local-owner", runId).outputRevisions.some(ref => ref.revisionId === video.revisionId));
      const revision = f.app.service.readRevision("local-owner", video.artifactId, video.revisionId);
      await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("这版定稿"), stageConfirmation: {
        workId: f.planWork.workId, action: "finalize_video", subject: { ...video, digest: revision.digest },
      } });
    };
    await finalize(run1.id);
    const unbound = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: makeSpec(l2) })).proposal;
    assert.throws(() => f.accept(unbound), /尚未与当前方案主稿关联/);
    const bindNew = (narrationText: string) => f.app.database.transaction(() => deliverStageDrafts(f.app.database, f.clock(), scope, {
      items: [{ mode: "revise", artifactId: first.artifactId, baseRevisionId: first.revisionId, title: "雨天方案", kind: "script",
        content: { format: "markdown", text: "画面不变，只换旁白。", narrationText } }],
      stageDrafts: [{ workId: f.planWork.workId, stage: "plan", itemIndex: 0, source: f.planWork.content,
        proposalRef: { proposalId: unbound.id, digest: unbound.digest } }],
    }))();
    assert.throws(() => bindNew(l1), /旁白.*不一致|新方案/);
    assert.equal(f.app.service.readArtifactHead("local-owner", first.artifactId).revisionId, first.revisionId);
    const second = bindNew(l2).revisions[0]!;
    const oldAudio = f.app.service.getRun("local-owner", run1.id).outputRevisions
      .map(ref => f.app.service.readRevision("local-owner", ref.artifactId, ref.revisionId))
      .find(revision => revision.content.format === "media" && revision.content.mimeType.startsWith("audio/"))!;
    const reuse = makeSpec(l2);
    reuse.operations.splice(1, 1);
    reuse.inputRevisions.push({ artifactId: oldAudio.artifactId, revisionId: oldAudio.revisionId });
    reuse.operations[1]!.inputs[1] = { kind: "artifact_revision", artifactId: oldAudio.artifactId,
      revisionId: oldAudio.revisionId, digest: oldAudio.digest };
    assert.equal(productionNarrationText(f.app.database, reuse), l1, "复用音频追溯原生成操作，不读当前方案");
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
    const mixed: ProductionIntent = { ...reuse, inputRevisions: [{ artifactId: oldAudio.artifactId, revisionId: oldAudio.revisionId }],
      operations: [{ kind: "render", operationId: "mix", outputSlot: "mixed", model: null, maxCreateAttempts: 1,
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
    await assert.rejects(() => f.app.service.prepareProposal(scope.ownerId, scope.conversationId,
      { commandId: cmd(), planSource: second, spec: mixed }), /旁白.*不一致|新方案/);
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
    noNarration.inputRevisions = [];
    const noVoice = (await f.app.service.prepareProposal(scope.ownerId, scope.conversationId, { commandId: cmd(), spec: noNarration })).proposal;
    assert.equal(noVoice.audioSummary?.music?.duckUnderNarration, false, "没有独立配音时在digest前展开不避让");
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource: second, spec: reuse }), /旁白.*不一致|新方案/);
    const nested = makeSpec(l1);
    nested.operations.push({ kind: "render", operationId: "join", outputSlot: "joined", model: null,
      inputs: [{ kind: "operation_output", producerOperationId: "film", outputSlot: "film" }],
      parameters: { assembly: "ordered_concat", audioMode: "preserve", format: "mp4", width: 1280, height: 720, fps: 24 }, maxCreateAttempts: 1 });
    nested.finalOutput = { operationId: "join", outputSlot: "joined" };
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource: second, spec: nested }), /旁白.*不一致|新方案/);
    // 模拟修复前已准备好、尚未受理的错绑报价；换版不能继续受理这张旧单。
    const oldMismatch = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: reuse })).proposal;
    f.app.database.prepare("UPDATE proposals SET plan_source_json = ? WHERE id = ?")
      .run(canonicalJson({ kind: "artifact_revision", ...second, digest: f.app.service.readRevision("local-owner", second.artifactId, second.revisionId).digest }), oldMismatch.id);
    invalidateLegacyNarrationProposals(f.app.database, f.clock());
    assert.equal(f.app.service.readProposal("local-owner", oldMismatch.id).state, "stale");
    assert.throws(() => f.accept(oldMismatch), /失效|重新/);
    const run2 = f.accept(unbound).run;
    await tick(f, 4);
    assert.equal(f.app.service.getRun("local-owner", run2.id).state, "succeeded");
    const newAudio = f.app.service.getRun("local-owner", run2.id).outputRevisions
      .map(ref => f.app.service.readRevision("local-owner", ref.artifactId, ref.revisionId))
      .find(revision => revision.content.format === "media" && revision.content.mimeType.startsWith("audio/"))!;
    const correctReuse = structuredClone(reuse);
    correctReuse.inputRevisions[correctReuse.inputRevisions.length - 1] = { artifactId: newAudio.artifactId, revisionId: newAudio.revisionId };
    correctReuse.operations[1]!.inputs[1] = { kind: "artifact_revision", artifactId: newAudio.artifactId,
      revisionId: newAudio.revisionId, digest: newAudio.digest };
    assert.equal(productionNarrationText(f.app.database, correctReuse), l2, "即使媒体字节去重，也必须沿准确的生成修订取词");
    await finalize(run2.id);
    const entries = f.app.service.listLibraryVideos("local-owner", undefined, undefined).items;
    assert.equal(entries.length, 2);
    for (const [runId, plan, expected] of [[run1.id, first, l1], [run2.id, second, l2]] as const) {
      const entry = entries.find(item => item.plan?.revisionId === plan.revisionId)!;
      assert.ok(f.app.service.getRun("local-owner", runId).outputRevisions.some(ref => ref.revisionId === entry.video.revisionId));
      assert.equal(entry.plan?.revisionId, plan.revisionId);
      assert.equal(entry.narrationText, expected);
      const content = f.app.service.readRevision("local-owner", plan.artifactId, plan.revisionId).content;
      assert.ok(content.format === "markdown");
      assert.equal(content.narrationText, expected);
      const frozen = specFor(f.app.database, runRow(f.app.database, runId));
      const speech = frozen.operations.find(op => op.kind === "speech")!;
      assert.deepEqual(speech.inputs, [{ kind: "text", text: expected }]);
      assert.deepEqual(frozen.operations[0]!.inputs, f.spec.operations[0]!.inputs, "未受影响画面来源不变");
    }
    assert.equal(f.app.service.readProposal("local-owner", p1.id).state, "stale", "方案修改仍使旧待确认提案失效");
    const oldWork = seedPlanStageWork(f.app.database, f.clock(), scope, "换版前的旧方案");
    const oldPlan = deliverPlanDraft(f.app.database, f.clock(), scope, oldWork, null).revisions[0]!;
    await assert.rejects(() => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource: oldPlan, spec: { ...makeSpec(l1), workId: oldWork.workId } }), /唯一.*旁白|新方案/);
    const oldQuote = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...makeSpec(l1), workId: oldWork.workId } })).proposal;
    const oldSource = f.app.service.snapshot("local-owner", f.conversation.id).works.find(work => work.id === oldWork.workId)!.stages.plan.draft!;
    // 仅在隔离库构造换版前的已绑定旧行，重现同一缺字段修订绑定不同台词的历史事实。
    f.app.database.prepare("UPDATE proposals SET plan_source_json = ? WHERE id = ?").run(canonicalJson(oldSource), oldQuote.id);
    const unique = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource: oldPlan, spec: { ...makeSpec(l1), workId: oldWork.workId } })).proposal;
    assert.equal(unique.state, "ready", "旧修订唯一可证旁白可以沿用，不升级全部旧稿");
    const different = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...makeSpec(l2), workId: oldWork.workId } })).proposal;
    f.app.database.prepare("UPDATE proposals SET plan_source_json = ? WHERE id = ?").run(canonicalJson(oldSource), different.id);
    assert.throws(() => f.accept(different), /唯一.*旁白|新方案/);
    invalidateLegacyNarrationProposals(f.app.database, f.clock());
    for (const quote of [oldQuote, unique, different]) assert.equal(f.app.service.readProposal("local-owner", quote.id).state, "stale");
    assert.equal(f.app.service.readProposal("local-owner", same.id).state, "accepted", "不修改已受理历史");
    assert.equal(f.app.service.readProposal("local-owner", unbound.id).state, "accepted");
    assert.equal(count(f, "authorizations"), 2);
  } finally { await f.close(); }
});

it("F3 明确替换同范围预算后两个旧入口均拒绝，普通备选独立，新报价只受理一次", async () => {
  const f = await setup(); try {
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    const planSource = deliverPlanDraft(f.app.database, f.clock(), scope, f.planWork, null).revisions[0]!;
    const quote = async (amountMinor: number) => (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource, spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor } } })).proposal;
    const old = await quote(2000), alternative = await quote(1800);
    const spec = { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 1300 },
      operations: f.spec.operations.map(({ maxCreateAttempts: _attempts, ...op }) => op) };
    f.app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("prepare_production", {
      spec, planSource, replacesProposal: { proposalId: old.id, digest: old.digest },
    } as never)]), fauxAssistantMessage("已替换报价，等你确认本次费用。")]);
    await f.app.service.sendMessage("local-owner", f.conversation.id, input("按13元准备，替换掉刚才20元那张报价"));
    for (let i = 0; i < 100 && f.app.service.snapshot("local-owner", f.conversation.id).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const currentId = f.app.service.snapshot("local-owner", f.conversation.id).works.find(work => work.id === f.planWork.workId)!.stages.plan.proposalId!;
    const current = f.app.service.readProposal("local-owner", currentId);
    assert.equal(current.spec.maxSpend.amountMinor, 1300, "新报价确实经生产工具创建");
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
    const scope = { ownerId: "local-owner", conversationId: f.conversation.id };
    const planSource = deliverPlanDraft(f.app.database, f.clock(), scope, f.planWork, null).revisions[0]!;
    const old = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource, spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 2000 } } })).proposal;
    const replacesProposal = { proposalId: old.id, digest: old.digest };
    const prepare = (extra: Record<string, unknown> = {}) => f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), planSource, spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 100 } }, replacesProposal, ...extra });
    await assert.rejects(() => prepare({ replacesProposal: { ...replacesProposal, digest: "f".repeat(64) } }), /替换|摘要/);
    await assert.rejects(() => prepare({ spec: { ...f.spec, inputRevisions: [], operations: [{ ...f.spec.operations[0]!, inputs: [{ kind: "text", text: "不同画面" }] }] } }), /范围|替换/);
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

it("B：输入锁阻止在途改稿，意见记录为下一版；其他聊天继续，完成不自动改稿", async () => {
  const f = await setup(); try {
    const receipt = f.accept(await f.proposal());
    const target = { artifactId: f.artifact.id, revisionId: f.artifact.revisionId, workId: null };
    const feedback = f.app.service.addFeedback("local-owner", f.conversation.id, { commandId: cmd(), target, text: "下一版更安静" });
    assert.equal(feedback.receipt.disposition, "next_version");
    f.app.faux!.setResponses([fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "revise", artifactId: target.artifactId, baseRevisionId: target.revisionId, title: "改稿", kind: "prompt", content: { format: "markdown", text: "不能写入" } }] })]), fauxAssistantMessage("锁定内容没有改动。")]);
    const modification = await f.app.service.sendMessage("local-owner", f.conversation.id, { ...input("改这份"), target });
    for (let i = 0; i < 100; i++) {
      const row = f.app.database.prepare("SELECT state FROM requests WHERE id=?").get(modification.receipt.requestId) as { state: string };
      if (row.state === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(f.app.service.readArtifactHead("local-owner", f.artifact.id).revisionNumber, 1);
    const rejected = f.app.database.prepare("SELECT state FROM tool_invocations WHERE request_id=? AND tool_name='deliver_artifacts'").get(modification.receipt.requestId) as { state: string };
    assert.equal(rejected.state, "registered", "被拒绝的修订没有业务提交回执");
    await tick(f, 2);
    const run = f.app.service.getRun("local-owner", receipt.run.id);
    assert.equal(run.state, "succeeded"); assert.equal(run.finance.state, "settled"); assert.equal(run.finance.settledMinor, 1200);
    assert.equal(f.app.service.readArtifactHead("local-owner", f.artifact.id).revisionNumber, 1);
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
    // R1.3 在途冻结决议替换旧断言（旧：先给在途事项绑定新方案主稿、再断言受理 RUN_BUSY）：
    // queued 起同一事项的主稿写入口本身被拒，不再出现“已绑定的下一版方案等待受理”的中间态。
    await assert.rejects(() => f.proposal({ workId: accepted.run.workId }), /正在制作中/);
    assert.equal(count(f, "production_runs"), 1);
  } finally { await f.close(); }
});

it("B：run 终止后原样重提继承准确关系：页面指针、受理、视频发布一次闭合", async () => {
  const f = await setup(); try {
    // 真实失败路径（jb-rerun）：首提案已绑定并受理，run 到终态后模型只重新 prepare 同内容提案。
    // prepare 事务继承方案关联并把 work 当前提案指针移到新提案；不制造新方案稿、不要求重新认可。
    const first = f.accept(await f.proposal());
    f.app.service.cancelRun("local-owner", first.run.id, { commandId: cmd(), expectedRevision: first.run.revision });
    await tick(f);
    assert.equal(f.app.service.getRun("local-owner", first.run.id).state, "cancelled");
    const resent = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: f.spec })).proposal;
    // 受理前：work 当前提案指针已指向新提案（网页开始入口据此出现），方案主稿数量未增加。
    const before = planStageOf(f, f.spec.workId!);
    assert.equal(before.plan.proposalId, resent.id);
    assert.equal(boundPlanCount(f), 1);
    const second = f.accept(resent);
    await tick(f, 2);
    assert.equal(f.app.service.getRun("local-owner", second.run.id).state, "succeeded");
    assert.equal(count(f, "production_runs"), 2); assert.equal(count(f, "authorizations"), 2);
    assert.equal(boundPlanCount(f), 1);
    // 发布闭合：成片修订署名本次提案（新 id 与 digest）、进入视频草稿；用户认可不被代填。
    const after = planStageOf(f, f.spec.workId!);
    assert.ok(after.video.draft && after.video.draft.kind === "artifact_revision", "视频初稿应进入草稿");
    assert.equal(after.video.approved, null);
    const published = f.app.database.prepare(
      "SELECT r.creation_binding_json AS binding FROM artifact_revisions r WHERE r.run_id=? AND r.creation_binding_json IS NOT NULL",
    ).get(second.run.id) as { binding: string };
    const binding = JSON.parse(published.binding) as { stage: string; proposalRef: { proposalId: string; digest: string }; source: { revisionId: string } };
    assert.equal(binding.stage, "video");
    assert.equal(binding.proposalRef.proposalId, resent.id);
    assert.equal(binding.proposalRef.digest, resent.digest);
    assert.equal(binding.source.revisionId, before.plan.draft?.kind === "artifact_revision" ? before.plan.draft.revisionId : null);
    // 改了内容（除授权上限外的任何字段）的重提不继承：无准确关联，按未关联拒绝。
    const changed = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, title: "山路短片（改）" } })).proposal;
    assert.throws(() => f.accept(changed), /尚未与当前方案主稿关联/);
  } finally { await f.close(); }
});

it("B：仅授权上限变化的重提保留文稿关系，新提案独立受理并署名新 digest；金额不足仍拒绝", async () => {
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
    const binding = JSON.parse(published.binding) as { proposalRef: { proposalId: string; digest: string } };
    assert.equal(binding.proposalRef.proposalId, raised.id);
    assert.equal(binding.proposalRef.digest, raised.digest);
    assert.equal(boundPlanCount(f), 1);
    // 低于必要报价的重提即使继承了关系也按既有预算规则拒绝。
    const low = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, maxSpend: { currency: "CNY", amountMinor: 1 } } })).proposal;
    assert.throws(() => f.accept(low), /授权金额不足/);
  } finally { await f.close(); }
});

it("B：方案主稿换稿后，同内容重提不再关联旧稿，受理拒绝；同提案不能改绑另一稿", async () => {
  const f = await setup(); try {
    const first = await f.proposal();
    // 关系一旦建立不可通过另一轮交稿改绑另一稿（此时 first 仍 ready，排除失效干扰）。
    assert.throws(() => bindPreparedPlan(f.app.database, f.clock(), { ownerId: "local-owner", conversationId: f.conversation.id },
      first, f.planWork), /该提案已关联另一份方案主稿/);
    // 方案阶段内换稿：新提案（不同 spec）绑定了一份更新的方案主稿，旧稿不再是当前稿。
    const newer = (await f.app.service.prepareProposal("local-owner", f.conversation.id,
      { commandId: cmd(), spec: { ...f.spec, title: "山路短片（新方案）" } })).proposal;
    bindPreparedPlan(f.app.database, f.clock(), { ownerId: "local-owner", conversationId: f.conversation.id }, newer, f.planWork);
    const resent = (await f.app.service.prepareProposal("local-owner", f.conversation.id, { commandId: cmd(), spec: f.spec })).proposal;
    assert.throws(() => f.accept(resent), /尚未与当前方案主稿关联/);
  } finally { await f.close(); }
});

it("B：submit 已受理但响应丢失，只查询原 identity，未知保持锁且不新增 attempt", async () => {
  const f = await setup({ loseSubmitResponse: true, recoverySupported: false }); try {
    const r = f.accept(await f.proposal()).run;
    await tick(f, 4);
    const unknown = f.app.service.getRun("local-owner", r.id);
    assert.equal(unknown.state, "unknown"); assert.equal(unknown.finance.pendingUnknownMinor, 1200); assert.equal(unknown.finance.reservedMinor, 0);
    assert.equal(count(f, "production_attempts"), 1);
    // 输入锁同时覆盖 spec 输入与方案主稿：主稿在制作期间同样不可改（admit 的有限来源锁定）。
    assert.equal(count(f, "production_input_locks"), 2);
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
    assert.equal(count(f, "production_input_locks"), 2);
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
    assert.equal(completed.finance.settledMinor, 1200);
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
    assert.equal(run.state, "succeeded"); assert.equal(run.outputRevisions.length, 3); assert.equal(run.finance.settledMinor, 2400);
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
    assert.equal(run.state, "succeeded"); assert.equal(run.finance.state, "pending_reconciliation"); assert.equal(count(f, "production_input_locks"), 0);
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
    run = await apply(observation("9007199254740993", 1500, false)); assert.equal(run.finance.settledMinor, 0);
    run = await apply(observation("9007199254740994", 1500, true)); assert.equal(run.finance.settledMinor, 1500); assert.equal(run.finance.state, "settled");
    // 后续可信更正可能晚于结清，从观测入口进入；调度不制造账单版本。
    const inject = (obs: ExecutionObservation) => {
      const row = runRow(f.app.database, r.id);
      f.app.database.prepare("INSERT INTO ledger_observations(attempt_id,digest,observation_json) VALUES(?,?,?)").run(attempt.id, cmd(), JSON.stringify(obs));
      // 模拟已收到新账务证据的待处理标记，保留原净额。
      f.app.database.prepare("UPDATE production_attempts SET billing_conflict=1 WHERE id=?").run(attempt.id);
      assert.equal(row.state, "succeeded");
    };
    inject(observation("9007199254740992", 2000, true)); run = await apply(observation("9007199254740995", 900, true));
    assert.equal(run.finance.settledMinor, 900); assert.equal(run.finance.state, "settled");
    inject(observation("9007199254740995", 800, true)); run = await apply(observation("9007199254740995", 900, true));
    assert.equal(run.finance.settledMinor, 900); assert.equal(run.finance.state, "pending_reconciliation");
    assert.equal(run.finance.pendingUnknownMinor, 300, "已记账的 900 不能再次计入待核占用");
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
    assert.equal(run.finance.settledMinor, 2500); assert.equal(run.finance.reservedMinor, 0);
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
    assert.equal(run.finance.settledMinor, 1100);
    assert.equal(run.finance.state, "pending_reconciliation");
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
    const works = [0, 1, 2].map(() => seedPlanStageWork(f.app.database, f.clock(), { ownerId: "local-owner", conversationId: f.conversation.id }, "并发短片"));
    const runs: Run[] = [];
    for (const work of works) runs.push(f.accept(await f.proposal({ workId: work.workId }, work)).run);
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
    assert.equal(f.app.service.getRun("local-owner", r.id).finance.settledMinor, 1200);
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
    assert.equal(count(f, "production_attempts"), 2); assert.equal(f.app.service.getRun("local-owner", r.id).finance.settledMinor, 2400);
  } finally { await f.close(); }
  const g = await setup({ billing: { kind: "authoritative", billingFactId: "overspend", sourceRevision: "2", netAmount: { currency: "CNY", amountMinor: 2500 }, final: true, evidenceId: "invoice" } });
  try {
    const p = await g.proposal({ operations: [g.spec.operations[0]!, { ...g.spec.operations[0]!, operationId: "second", outputSlot: "second" }], maxSpend: { currency: "CNY", amountMinor: 2400 } });
    const r = g.accept(p).run;
    await tick(g, 4);
    const run = g.app.service.getRun("local-owner", r.id);
    assert.equal(run.state, "failed"); assert.equal(run.issue?.code, "BUDGET_EXHAUSTED");
    assert.equal(run.finance.settledMinor, 2500); assert.equal(count(g, "production_attempts"), 1);
  } finally { await g.close(); }
});
