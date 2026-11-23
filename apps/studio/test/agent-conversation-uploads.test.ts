import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { openAsBlob } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { probeImageFile, probeVideoFile } from "../src/server/agent/media-probe.js";
import { finalVideoTarget, seedConfirmedWork } from "./helpers/creative-work-fixture.js";
import { admitLocalIntent } from "./helpers/tool-args.js";
import { DEFAULT_ARK_VIDEO_PROFILE, arkVideoCatalogEntry, mediaBinding } from "../src/server/agent/media-config.js";
import { getArtifactRow, insertRevision } from "../src/server/agent/artifact-store.js";
import { parseCreationState, requireWork, writeWorkState } from "../src/server/agent/creative-work.js";
import { nextSeq } from "../src/server/agent/conversation-store.js";
import type { ProductionIntent, ReviewInputInput } from "../src/shared/agent/generated/contracts.js";
import { buildFrameApp } from "../src/server/agent/app.js";
import type { AgentRuntime } from "../src/server/agent/assembly.js";
import { buildLocalRuntime } from "./helpers/native-render.js";
import type { UploadMime, UploadReceipt } from "../src/shared/agent/generated/contracts.js";
import { newAgentId } from "../src/server/agent/util.js";

const run = promisify(execFile);
const origin = "http://frame-upload.test",
  owner = "local-owner";
describe("CAP-04 会话素材上传、Pi 与本地合成", () => {
  let dir: string,
    base: string,
    runtime: AgentRuntime,
    app: ReturnType<typeof buildFrameApp>,
    conversationId: string,
    revision: number;
  const binding = mediaBinding(DEFAULT_ARK_VIDEO_PROFILE, "test-images");
  const receipts = new Map<UploadMime, UploadReceipt>();
  const inputs: [string, UploadMime][] = [
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
    ["mp4", "video/mp4"],
    ["webm", "video/webm"],
    ["mp3", "audio/mpeg"],
    ["wav", "audio/wav"],
  ];
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "frame-upload-"));
    for (const [ext, mime] of inputs) {
      if (ext === "webp") {
        // 极小的无损 WebP 原件；测试机只需要解码器。
        await writeFile(
          path.join(dir, "source.webp"),
          Buffer.from(
            "UklGRj4AAABXRUJQVlA4TDEAAAAvf8JZAA/wS+zzsD90dv5jCWoaSYFwgH+11NTfRPR/AmphzejkP/7jv7HD//zP/w9EAA==",
            "base64",
          ),
        );
        continue;
      }
      const av = mime.startsWith("audio"),
        image = mime.startsWith("image");
      const args = [
        "-y",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        av ? "sine=frequency=480:duration=0.45" : "testsrc2=s=640x360:r=24:d=1.25",
      ];
      await run("ffmpeg", [
        ...args,
        ...(image ? ["-frames:v", "1"] : []),
        ...(ext === "webm" ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"] : []),
        path.join(dir, "source." + ext),
      ]);
    }
    runtime = await buildLocalRuntime(path.join(dir, "state"), undefined, {
      ["video:" + binding.modelId]: arkVideoCatalogEntry(DEFAULT_ARK_VIDEO_PROFILE, binding),
    });
    app = buildFrameApp({ agent: { service: runtime.service, resolveOwner: () => owner, uiOrigin: origin } });
    base = await app.listen({ host: "127.0.0.1", port: 0 });
    const cnv = runtime.service.createConversation(owner, { commandId: "init-upload", title: "素材创作" }).conversation;
    conversationId = cnv.id;
    revision = cnv.revision;
  });
  after(async () => {
    await app?.close();
    await runtime?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  function upload(
    name: string,
    file: Blob,
    commandId: string,
    expectedRevision: number,
    referer = origin,
    target = conversationId,
  ) {
    const form = new FormData();
    form.append("commandId", commandId);
    form.append("expectedRevision", String(expectedRevision));
    form.append("rights", "owned_or_licensed");
    form.append("file", file, name);
    return fetch(`${base}/api/agent/v1/conversations/${target}/uploads`, {
      method: "POST",
      headers: { origin: referer, "x-video-factory-request": "studio" },
      body: form,
    });
  }

  it("七种真实文件逐字节可读，视频首帧、授权、序号和重放有据可查", async () => {
    for (const [ext, mime] of inputs) {
      const file = path.join(dir, "source." + ext),
        bytes = await openAsBlob(file, { type: mime }),
        commandId = "send-" + ext;
      const response = await upload("素材." + ext, bytes, commandId, revision);
      const data = (await response.json()) as UploadReceipt;
      assert.equal(response.status, 201, JSON.stringify(data));
      assert.equal(data.attachment.facts.sizeBytes, (await stat(file)).size);
      assert.equal(data.attachment.mimeType, mime);
      assert.equal(data.conversation.revision, revision + 1);
      const replay = await upload("素材." + ext, bytes, commandId, revision);
      assert.equal(replay.status, 201);
      assert.deepEqual(await replay.json(), data);
      const artifact = runtime.service.readRevision(
        owner,
        data.attachment.source.artifactId,
        data.attachment.source.revisionId,
      );
      assert.ok(artifact.content.format === "media");
      assert.equal(artifact.content.sources?.[0]?.provider, "user_upload");
      assert.equal(artifact.content.sources?.[0]?.licenseUrl, null);
      const media = await fetch(`${base}/api/agent/v1/blobs/${data.attachment.blobId}/content`);
      assert.deepEqual(Buffer.from(await media.arrayBuffer()), await readFile(file));
      if (mime.startsWith("video")) {
        const frame = data.attachment.facts.firstFrame!;
        assert.equal(frame.width, 640);
        assert.equal(frame.height, 360);
        assert.equal(runtime.service.readBlob(owner, frame.blobId).digest, frame.digest);
        assert.equal(runtime.service.readBlob(owner, frame.blobId).mime_type, "image/jpeg");
      }
      receipts.set(mime, data);
      revision = data.conversation.revision;
    }
    assert.equal((runtime.database.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, 0);
  });

  it("错误格式、来源、旧版本、命令冲突与消息归属，均在持久写前拒绝", async () => {
    const stats = () =>
      ["artifacts", "artifact_revisions", "production_blobs", "command_receipts", "requests", "events"].map(
        (t) => (runtime.database.prepare("SELECT COUNT(*) AS n FROM " + t).get() as { n: number }).n,
      );
    const before = stats();
    for (const text of ["ordinary text", "a broken container", "a picture header only"]) {
      const res = await upload("broken.mp4", new Blob([text], { type: "video/mp4" }), newAgentId("cmd"), revision);
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { code: string }).code, "INVALID_INPUT");
    }
    const bytes = await openAsBlob(path.join(dir, "source.png"), { type: "image/png" });
    assert.equal((await upload("x.png", bytes, "stale-upload", revision - 1)).status, 409);
    assert.equal((await upload("renamed.png", bytes, "send-png", 2)).status, 409);
    assert.equal((await upload("x.png", bytes, "other-origin", revision, "https://different.invalid")).status, 403);
    assert.equal((await upload("empty.png", new Blob([], { type: "image/png" }), "empty-file", revision)).status, 400);
    assert.deepEqual(stats(), before);
    const other = runtime.service.createConversation(owner, {
      commandId: "other-upload",
      title: "其他对话",
    }).conversation;
    const count = stats();
    assert.throws(
      () =>
        runtime.service.sendMessage(owner, other.id, {
          commandId: "wrong-room",
          text: "看附件",
          mode: "new",
          target: null,
          skillId: null,
          steerRequestId: null,
          proposalRef: null,
          uploads: [receipts.get("image/png")!.attachment.source],
        }),
      { code: "NOT_FOUND" },
    );
    assert.deepEqual(stats(), count);
    assert.deepEqual(await readdir(runtime.production!.blobs.stagingRoot), []);
  });

  it("图片、音频、视频实际超过各自上限一字节时，清理输入且拒绝入库", async () => {
    for (const [name, mime, megabytes] of [
      ["large.png", "image/png", 30],
      ["large.wav", "audio/wav", 100],
      ["large.mp4", "video/mp4", 512],
    ] as const) {
      const file = path.join(dir, name);
      await writeFile(file, "");
      await truncate(file, megabytes * 1024 * 1024 + 1);
      const response = await upload(name, await openAsBlob(file, { type: mime }), "limit-" + name, revision);
      const body = (await response.json()) as { code: string };
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.code, "INVALID_INPUT");
      assert.equal(runtime.service.snapshot(owner, conversationId).conversation.revision, revision);
      assert.deepEqual(await readdir(runtime.production!.blobs.stagingRoot), []);
      await rm(file);
    }
  });
  it("图片进入 Pi 原生视觉块，视频与音频随本条消息带入真实元数据", async () => {
    const uploads = ["image/webp", "video/mp4", "audio/wav"].map(
      (mime) => receipts.get(mime as UploadMime)!.attachment,
    );
    let captured: TranscriptContext["messages"] = [];
    runtime.host.faux!.setResponses([
      (ctx) => {
        captured = ctx.messages;
        return fauxAssistantMessage("已查看所附素材。");
      },
    ]);
    const { receipt } = await runtime.service.sendMessage(owner, conversationId, {
      commandId: "see-upload",
      text: "",
      mode: "new",
      target: null,
      skillId: null,
      steerRequestId: null,
      proposalRef: null,
      uploads: uploads.map((a) => a.source),
    });
    for (let i = 0; i < 250 && runtime.service.snapshot(owner, conversationId).activeRequestId; i++)
      await new Promise((r) => setTimeout(r, 20));
    const msg = runtime.service.snapshot(owner, conversationId).messages.items.find((m) => m.id === receipt.messageId)!;
    assert.equal(msg.state, "completed");
    assert.deepEqual(msg.uploads, uploads);
    assert.deepEqual(
      msg.references.artifacts,
      uploads.map((a) => a.source),
    );
    const visual: import("@earendil-works/pi-ai").ImageContent[] = [];
    for (const message of captured) {
      if (Array.isArray(message.content)) for (const part of message.content) if (part.type === "image") visual.push(part);
    }
    assert.equal(visual.length, 1);
    const modelImage = path.join(dir, "from-pi");
    await writeFile(modelImage, Buffer.from(visual[0]!.data, "base64"));
    const decoded = await probeImageFile(modelImage);
    assert.deepEqual([decoded.width, decoded.height], [640, 360]);
    const transcript = JSON.stringify(captured);
    assert.ok(transcript.includes(uploads[1]!.blobId));
    assert.ok(transcript.includes("sampleRate"));
    assert.ok(transcript.includes("firstFrame"));
  });
  it("上传的实拍、品牌图片和干声直接混剪，实际成片有声且来源可追溯", async () => {
    const scope = { ownerId: owner, conversationId },
      work = seedConfirmedWork(runtime.database, "2026-11-01T00:00:00.000Z", scope);
    const attachments = (["video/mp4", "image/webp", "audio/wav"] as const).map(
      (mime) => receipts.get(mime)!.attachment,
    );
    const refs = attachments.map((a) => ({
      kind: "artifact_revision" as const,
      ...a.source,
      digest: runtime.service.readRevision(owner, a.source.artifactId, a.source.revisionId).digest,
    }));
    const { run: admitted } = await admitLocalIntent(runtime, scope, {
      workId: work.workId,
      title: "实拍混剪",
      scope: "本地原件",
      purpose: "production",
      inputSources: refs,
      reviewInputs: [work.reviewInput],
      outputTarget: finalVideoTarget(),
      operations: [
        {
          kind: "render",
          model: null,
          operationId: "mix",
          outputSlot: "movie",
          maxCreateAttempts: 1,
          inputs: refs,
          parameters: {
            assembly: "mixed_concat",
            format: "mp4",
            width: 640,
            height: 360,
            fps: 24,
            segments: [
              { kind: "video", inputSlot: 0, startMs: 0, durationMs: 800, originalGain: 0.4 },
              { kind: "image", inputSlot: 1, durationMs: 800 },
            ],
            segmentIds: ["live", "brand"],
            narration: { inputSlot: 2, timelineStartMs: 0, gain: 1 },
          },
        },
      ],
      finalOutput: { operationId: "mix", outputSlot: "movie" },
      maxSpend: { currency: "CNY", amountMinor: 0 },
    });
    for (let i = 0; i < 8 && runtime.service.getRun(owner, admitted.id).state !== "succeeded"; i++)
      await runtime.worker!.pollOnce();
    const result = runtime.service.getRun(owner, admitted.id);
    assert.equal(result.state, "succeeded", JSON.stringify(result.issue));
    const out = result.outputRevisions.at(-1)!;
    const { content } = runtime.service.readRevision(owner, out.artifactId, out.revisionId);
    assert.ok(content.format === "media");
    const facts = await probeVideoFile(runtime.service.readBlob(owner, content.blobId).path);
    assert.ok(facts.hasAudio);
    assert.ok(Math.abs(facts.durationMs - 1600) < 65);
    assert.equal(content.sources?.filter((source) => source.provider === "user_upload").length, 3);
  });
  it("两个请求并发上传时同一命令只登记一次，同版本的不同命令只有一个能提交", async () => {
    const file = await openAsBlob(path.join(dir, "source.jpg"), { type: "image/jpeg" });
    const send = (cmd: string, rev: number) => upload("新照片.jpg", file, cmd, rev);
    const start = runtime.service.snapshot(owner, conversationId).conversation.revision;
    const [a, b] = await Promise.all([send("same-new", start), send("same-new", start)]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.deepEqual(await a.json(), await b.json());
    const statuses = await Promise.all([send("race-1", start + 1), send("race-2", start + 1)]);
    assert.deepEqual(statuses.map((r) => r.status).sort(), [201, 409]);
    revision = start + 2;
    assert.deepEqual(await readdir(runtime.production!.blobs.stagingRoot), []);
  });

  it("分镜 v1 按准确认可自动绑定首帧；旧稿认可不会放行 v2，原视频首帧可直接进入提案", async () => {
    const scope = { ownerId: owner, conversationId },
      db = runtime.database,
      now = "2026-11-01T00:00:00.000Z";
    const work = seedConfirmedWork(db, now, scope);
    const picture = receipts.get("image/png")!.attachment,
      blob = runtime.service.readBlob(owner, picture.blobId);
    const id = newAgentId("art"),
      groupId = newAgentId("grp"),
      itemId = newAgentId("item");
    db.prepare(
      "INSERT INTO artifacts(id,owner_id,conversation_id,title,kind,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,'image',0,?,?,?)",
    ).run(id, owner, conversationId, "分镜 2", nextSeq(db, "artifacts", conversationId), now, now);
    function draft(base: string | null) {
      const row = insertRevision(
        db,
        now,
        getArtifactRow(db, owner, id)!,
        base,
        {
          title: "分镜 2",
          kind: "image",
          content: { format: "media", blobId: blob.id, mimeType: "image/png", durationMs: null },
        },
        null,
        "production_output",
      );
      const source = { kind: "artifact_revision" as const, artifactId: id, revisionId: row.id, digest: row.digest };
      const current = requireWork(db, owner, conversationId, work.workId),
        state = parseCreationState(current);
      const group = state.groups.find((g) => g.id === groupId);
      if (group) {
        group.items[0]!.draft = source;
        group.revision++;
      } else
        state.groups.push({
          id: groupId,
          title: "画面",
          nextIntent: null,
          revision: 1,
          items: [
            {
              id: itemId,
              label: "分镜 2",
              required: false,
              role: "storyboard",
              draft: source,
              approved: null,
              confirmationId: null,
              approvedAt: null,
            },
          ],
        });
      writeWorkState(db, now, current, state);
      return source;
    }
    const first = draft(null),
      prompt = { kind: "text" as const, text: "摄像机缓缓向前" };
    const intent: ProductionIntent = {
      workId: work.workId,
      title: "分镜镜头",
      scope: "按画稿制作",
      purpose: "draft",
      reviewInputs: [],
      inputSources: [first],
      outputTarget: finalVideoTarget(),
      operations: [
        {
          kind: "video",
          operationId: "shot",
          outputSlot: "movie",
          model: binding,
          maxCreateAttempts: 1,
          parameters: {
            aspectRatio: "16:9",
            durationSeconds: 5,
            resolution: "720p",
            audioMode: "none",
            firstFrameSlot: 1,
          },
          inputs: [prompt, first],
        },
      ],
      finalOutput: { operationId: "shot", outputSlot: "movie" },
      maxSpend: { currency: "CNY", amountMinor: 2000 },
    };
    const prepare = (spec: ProductionIntent) =>
      runtime.service.prepareProposal(owner, conversationId, { commandId: newAgentId("cmd"), spec });
    const candidate = (await prepare(intent)).proposal;
    assert.equal(candidate.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n;
    assert.throws(
      () =>
        runtime.service.acceptProposal(owner, candidate.id, {
          commandId: "block-unapproved",
          proposalDigest: candidate.digest,
        }),
      { code: "PROPOSAL_STALE" },
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM production_runs").get() as { n: number }).n, before);
    await runtime.service.sendMessage(owner, conversationId, {
      commandId: "approve-board",
      text: "认可分镜",
      target: null,
      skillId: null,
      mode: "new",
      steerRequestId: null,
      proposalRef: null,
      reviewConfirmation: { workId: work.workId, groupId, items: [{ itemId, source: first }], action: "approve" },
    });
    const record = parseCreationState(requireWork(db, owner, conversationId, work.workId)).groups.find(
      (g) => g.id === groupId,
    )!.items[0]!;
    const approval: ReviewInputInput = { groupId, itemId, source: first, confirmationId: record.confirmationId! };
    const video = intent.operations[0];
    assert.ok(video.kind === "video");
    const { firstFrameSlot: _, ...plain } = video.parameters;
    const auto = (
      await prepare({
        ...intent,
        reviewInputs: [approval],
        inputSources: [],
        operations: [{ ...video, parameters: plain, inputs: [prompt] }],
      })
    ).proposal;
    assert.equal(auto.acceptanceBlocker, null);
    const frozen = auto.spec.operations[0];
    assert.ok(frozen.kind === "video");
    assert.equal(frozen.parameters.firstFrameSlot, 1);
    assert.deepEqual(frozen.inputs[1], first);
    const second = draft(first.revisionId);
    const blocked = (
      await prepare({ ...intent, inputSources: [second], operations: [{ ...video, inputs: [prompt, second] }] })
    ).proposal;
    assert.equal(blocked.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    assert.equal(runtime.service.readProposal(owner, auto.id).acceptanceBlocker, null);
    const source = {
      kind: "artifact_revision" as const,
      ...picture.source,
      digest: runtime.service.readRevision(owner, picture.source.artifactId, picture.source.revisionId).digest,
    };
    const current = requireWork(db, owner, conversationId, work.workId),
      state = parseCreationState(current);
    const board = state.groups.find((g) => g.id === groupId)!.items[0]!;
    board.draft = source;
    writeWorkState(db, now, current, state);
    const { proposal: uploadedDraft } = await prepare({
      ...intent,
      inputSources: [source],
      operations: [{ ...video, inputs: [prompt, source] }],
    });
    assert.equal(uploadedDraft.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    const raw = { kind: "blob" as const, blobId: blob.id, digest: blob.digest };
    const { proposal: sharedBlob } = await prepare({
      ...intent,
      inputSources: [],
      operations: [{ ...video, inputs: [prompt, raw] }],
    });
    assert.equal(sharedBlob.acceptanceBlocker?.code, "INPUT_APPROVAL_REQUIRED");
    const still = receipts.get("video/mp4")!.attachment.facts.firstFrame!;
    const { proposal: fromUpload } = await prepare({
      ...intent,
      inputSources: [],
      operations: [{ ...video, inputs: [prompt, { kind: "blob", blobId: still.blobId, digest: still.digest }] }],
    });
    assert.equal(fromUpload.acceptanceBlocker, null);
    await assert.rejects(
      prepare({
        ...intent,
        inputSources: [first],
        operations: [{ ...video, parameters: { ...plain, lastFrameSlot: 1 } }],
      }),
      { code: "CAPABILITY_UNAVAILABLE" },
    );
  });
});
