import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type {
  RenderParameters,
  RevisionRef,
  SubtitleReceipt,
  RemixTimeline,
  LocalCreationReceipt,
  MediaContent,
} from "../src/shared/agent/generated/contracts.js";
import {
  getArtifactRow,
  insertRevision,
} from "../src/server/agent/artifact-store.js";
import { buildFrameApp } from "../src/server/agent/app.js";
import {
  emptyReferences,
  insertMessage,
  nextSeq,
} from "../src/server/agent/conversation-store.js";
import {
  parseCreationState,
  recordReviewConfirmation,
  requireWork,
} from "../src/server/agent/creative-work.js";
import { reviewedNarration } from "../src/server/agent/subtitle-service.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { runRow, snapshotFor } from "../src/server/agent/production-store.js";
import {
  projectCues,
  speechCues,
  subtitleAss,
  subtitleText,
  validateCues,
} from "../src/server/agent/subtitle-track.js";
import { digestOf, newAgentId } from "../src/server/agent/util.js";
import {
  finalVideoTarget,
  seedConfirmedWork,
} from "./helpers/creative-work-fixture.js";
import { buildLocalRuntime } from "./helpers/native-render.js";
import { admitLocalIntent } from "./helpers/tool-args.js";

const command = promisify(execFile);
test("CAP-03 字幕保留数字原稿、真实停顿、重复镜头的剪点和双语字符", () => {
  const track = speechCues(
    {
      words: [
        { text: "今天有", offsetMs: 50, durationMs: 380 },
        { text: "十二", offsetMs: 440, durationMs: 200 },
        { text: "位嘉宾", offsetMs: 650, durationMs: 450 },
      ],
      starts: [],
      ends: [],
    },
    1400,
    "今天有 12 位嘉宾！",
  );
  assert.deepEqual(track, [
    { id: "cue-1", startMs: 50, endMs: 1100, text: "今天有 12 位嘉宾！" },
  ]);
  const p: Extract<RenderParameters, { assembly: "mixed_concat" }> = {
    assembly: "mixed_concat",
    format: "mp4",
    width: 720,
    height: 1280,
    fps: 30,
    segmentIds: ["a", "b"],
    segments: [
      { kind: "video", inputSlot: 0, startMs: 200, durationMs: 600 },
      { kind: "video", inputSlot: 0, startMs: 1000, durationMs: 200 },
    ],
  };
  const projected = projectCues(track, "dry", p, new Map([[0, "dry"]]));
  assert.deepEqual(
    projected.map((c) => [c.startMs, c.endMs]),
    [
      [0, 600],
      [600, 700],
    ],
  );
  assert.match(
    subtitleText(projected, "vtt"),
    /00:00:00\.600 --> 00:00:00\.700/,
  );
  for (const style of [
    "clean_bottom",
    "cinema_bilingual",
    "social_pop_center",
  ] as const)
    for (const [w, h] of [
      [1280, 720],
      [720, 1280],
    ] as const) {
      const ass = subtitleAss(
        [
          {
            ...track[0],
            text: "电影 Frame 的中英混排与引号，".repeat(9) + "{定位}",
          },
        ],
        style,
        w,
        h,
      );
      assert.ok(
        ass.includes("Noto Sans CJK SC") &&
          ass.includes("\\N") &&
          ass.replaceAll("\\N", "").includes("\\{定位\\}"),
      );
    }
  assert.throws(() => validateCues([...track, ...track], 1300), {
    code: "INVALID_INPUT",
  });
});

test("CAP-03/05 字幕校对和认可后，不经 Pi、报价与授权，直接重合成同一事项", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-remix-"));
  const ffmpeg = process.env.FRAME_TEST_CAPTION_FFMPEG;
  const runtime = await buildLocalRuntime(
    dir,
    (blobs, db) =>
      new LocalRenderPort(db, blobs, () => new Date().toISOString(), {
        workRoot: path.join(dir, "media-work"),
        ...(ffmpeg ? { ffmpegPath: ffmpeg } : {}),
      }),
  );
  const service = runtime.service,
    owner = "editor",
    origin = "http://frame-remix.test";
  const app = buildFrameApp({
    agent: { service, uiOrigin: origin, resolveOwner: () => owner },
  });
  t.after(async () => {
    await app.close();
    await runtime.close();
    await rm(dir, { force: true, recursive: true });
  });
  const root = "/api/agent/v1",
    now = new Date().toISOString();
  const conversationId = service.createConversation(owner, {
    commandId: "room",
    title: "双语短片",
  }).conversation.id;
  const scope = { ownerId: owner, conversationId },
    db = runtime.database;
  const work = seedConfirmedWork(db, now, scope),
    current = () => requireWork(db, owner, conversationId, work.workId);
  assert.ok(work.content.kind === "artifact_revision");
  const approved = service.readRevision(
    owner,
    work.content.artifactId,
    work.content.revisionId,
  );
  assert.ok(approved.content.format === "markdown");
  assert.equal(
    reviewedNarration(
      db,
      current(),
      approved.content.text.replace(/[^\p{L}\p{N}]+/gu, ""),
    ),
    approved.content.text,
  );
  const audio = path.join(dir, "audio.wav"),
    vid = path.join(dir, "video.mp4"),
    musicFile = path.join(dir, "music.wav");
  const asrAudio = process.env.FRAME_TEST_CAPTION_AUDIO,
    duration = asrAudio ? 30000 : 3000,
    clickLimit = 8000;
  if (asrAudio) await copyFile(asrAudio, audio);
  else
    await command("ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=1",
      audio,
    ]);
  const source = process.env.FRAME_TEST_CAPTION_VIDEO;
  await command("ffmpeg", [
    "-loglevel",
    "error",
    ...(source
      ? ["-stream_loop", "-1", "-i", source]
      : ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24"]),
    "-an",
    "-t",
    String(duration / 1000 + 1),
    "-vf",
    "scale=640:360",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    vid,
  ]);
  await command("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:duration=2",
    musicFile,
  ]);
  const media = async (
    id: string,
    file: string,
    type: "audio/wav" | "video/mp4" | "image/png",
    ms: number | null,
    extras: Partial<MediaContent> = {},
  ) => {
    const blob = await runtime.production!.blobs.persistFromFileAsync(
      owner,
      conversationId,
      file,
      type,
      ms,
    );
    db.prepare(
      "INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?)",
    ).run(
      id,
      conversationId,
      owner,
      id,
      type.split("/")[0]!,
      nextSeq(db, "artifacts", conversationId),
      now,
      now,
    );
    const row = insertRevision(
      db,
      now,
      getArtifactRow(db, owner, id)!,
      null,
      {
        title: id,
        kind: type.split("/")[0]!,
        content: {
          format: "media",
          blobId: blob.id,
          mimeType: type,
          durationMs: ms,
          ...extras,
        },
      },
      null,
      "user_upload",
    );
    return {
      kind: "artifact_revision" as const,
      artifactId: id,
      revisionId: row.id,
      digest: row.digest,
    };
  };
  const visual = await media("source-video", vid, "video/mp4", duration + 1000);
  const voice = await media(
    "source-voice",
    audio,
    "audio/wav",
    asrAudio ? 30000 : 1000,
    asrAudio
      ? {}
      : {
          dub: {
            text: "开场，Frame。",
            voice: "zh-CN",
            rate: "+0%",
            granularity: "word",
            boundaries: [
              { text: "开场", offsetMs: 90, durationMs: 280 },
              { text: "Frame", offsetMs: 400, durationMs: 420 },
            ],
          },
        },
  );
  const music = await media("instrumental", musicFile, "audio/wav", 2000);
  const ref = (r: RevisionRef) => ({
    artifactId: r.artifactId,
    revisionId: r.revisionId,
  });
  const headers = { origin, "x-video-factory-request": "studio" };
  const post = (url: string, payload: object) =>
    app.inject({ method: "POST", url: root + url, headers, payload });
  const create = {
    commandId: "write-track",
    expectedRevision: current().revision,
    source: ref(voice),
    stylePreset: "clean_bottom",
  };
  const generated = await post(
    "/works/" + work.workId + "/subtitle-tracks",
    create,
  );
  assert.equal(generated.statusCode, 201, generated.body);
  const sr: SubtitleReceipt = generated.json(),
    v1 = service.readRevision(
      owner,
      sr.artifact.artifactId,
      sr.artifact.revisionId,
    );
  assert.ok(v1.content.format === "subtitles");
  t.diagnostic(
    JSON.stringify({ alignment: v1.content.alignment, cues: v1.content.cues }),
  );
  assert.deepEqual(
    (await post("/works/" + work.workId + "/subtitle-tracks", create)).json(),
    sr,
  );
  assert.equal(
    (
      await post("/works/" + work.workId + "/subtitle-tracks", {
        ...create,
        commandId: "stale",
      })
    ).statusCode,
    409,
  );
  assert.throws(
    () => service.readRevision("another-user", v1.artifactId, v1.revisionId),
    { code: "NOT_FOUND" },
  );
  const edit = {
    commandId: "correct-text",
    expectedRevision: 1,
    baseRevisionId: v1.revisionId,
    cues: v1.content.cues.map((c) => ({
      ...c,
      text: "镜头里的地球 Earth from orbit，字幕校对完毕。",
    })),
    stylePreset: "cinema_bilingual",
  };
  const editUrl = "/artifacts/" + v1.artifactId + "/subtitle-revisions";
  const saved = await post(editUrl, edit);
  assert.equal(saved.statusCode, 201, saved.body);
  const v2: SubtitleReceipt = saved.json();
  assert.deepEqual((await post(editUrl, edit)).json(), v2);
  assert.equal(
    (await post(editUrl, { ...edit, commandId: "conflict" })).statusCode,
    409,
  );
  const download = (r: RevisionRef, fmt: string) =>
    app.inject({
      url:
        root +
        "/artifacts/" +
        r.artifactId +
        "/revisions/" +
        r.revisionId +
        "/subtitles?format=" +
        fmt,
    });
  const before = await download(sr.artifact, "srt");
  assert.ok(before.body.includes(v1.content.cues[0].text));
  const vtt = await download(v2.artifact, "vtt");
  assert.ok(
    vtt.body.startsWith("WEBVTT") && vtt.body.includes("Earth from orbit"),
  );
  for (const response of [before, vtt]) {
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["cache-control"], "private, no-store");
  }
  service.accounts.bootstrap(owner,"local-fixture-owner");
  service.accounts.saveBudget(owner,{commandId:"no-paid-media",scope:"user",subjectId:owner,expectedRevision:0,conversationLimitMinor:0,dayLimitMinor:0,monthLimitMinor:0});
  const observed = await admitLocalIntent(runtime, scope, {
    workId: work.workId,
    title: "地球",
    scope: "原始素材",
    purpose: "draft",
    inputSources: [visual, voice, music],
    reviewInputs: [work.reviewInput],
    outputTarget: finalVideoTarget(),
    operations: [
      {
        operationId: "mix",
        outputSlot: "video",
        kind: "render",
        model: null,
        maxCreateAttempts: 1,
        inputs: [visual, voice, music],
        parameters: {
          assembly: "mixed_concat",
          format: "mp4",
          width: 1280,
          height: 720,
          fps: 24,
          segments: [
            {
              kind: "video",
              inputSlot: 0,
              startMs: 0,
              durationMs: duration / 2,
            },
            {
              kind: "video",
              inputSlot: 0,
              startMs: duration / 2,
              durationMs: duration / 2,
            },
          ],
          segmentIds: ["first", "last"],
          narration: { inputSlot: 1, timelineStartMs: 0, gain: 1 },
          music: {
            inputSlot: 2,
            sourceStartMs: 0,
            sourceDurationMs: 2000,
            timelineStartMs: 0,
            playDurationMs: duration,
            repeat: true,
            gain: 0.35,
            fadeInMs: 30,
            fadeOutMs: 90,
            duckUnderNarration: false,
          },
        },
      },
    ],
    finalOutput: { operationId: "mix", outputSlot: "video" },
    maxSpend: { currency: "CNY", amountMinor: 0 },
  });
  async function playable(id: string) {
    for (
      let i = 0;
      i < 8 && service.getRun(owner, id).state !== "succeeded";
      i++
    )
      await runtime.worker!.pollOnce();
    const run = service.getRun(owner, id);
    assert.equal(run.state, "succeeded", JSON.stringify(run.issue));
    return run.outputRevisions.at(-1)!;
  }
  const parent = observed.run.id,
    base = await playable(parent);
  const url = "/runs/" + parent,
    timeline: RemixTimeline = (
      await app.inject({
        url: root + url + "/remix-timeline?revisionId=" + base.revisionId,
      })
    ).json();
  assert.ok(timeline.available && timeline.musicGain === 0.35);
  const cuts = {
    commandId: "cut",
    expectedRevision: timeline.revision,
    baseRevisionId: base.revisionId,
    segments: [...timeline.segments].reverse().map((s) => ({
      id: s.id,
      startMs: s.startMs + 100,
      durationMs: s.durationMs,
    })),
    originalGain: 0.2,
    musicGain: 0.18,
    narrationGain: 0.92,
    duckUnderNarration: true,
    subtitles: {
      track: v2.artifact,
      mode: process.env.FRAME_TEST_CAPTION_MODE ?? "soft",
    },
  };
  const counts = () =>
    ["proposals", "authorizations", "user_actions", "tool_invocations"].map(
      (table) =>
        db
          .prepare("SELECT count(*) FROM " + table)
          .pluck()
          .get(),
    );
  const beforeCounts = counts();
  const unapproved = await post(url + "/remix-proposals", cuts);
  assert.equal(unapproved.statusCode, 400, unapproved.body);
  const group = parseCreationState(current()).groups.find((g) =>
    g.items.some(
      (i) =>
        i.draft?.kind === "artifact_revision" &&
        i.draft.revisionId === v2.artifact.revisionId,
    ),
  )!;
  const item = group.items.find((i) => i.role === "subtitle")!,
    messageId = newAgentId("msg");
  insertMessage(db, now, {
    id: messageId,
    ...scope,
    requestId: null,
    role: "user",
    kind: "chat",
    state: "completed",
    text: "认可校对后的字幕。",
    target: null,
    createdSeq: nextSeq(db, "messages", conversationId),
    references: { ...emptyReferences(), artifacts: [v2.artifact] },
  });
  recordReviewConfirmation(
    db,
    now,
    scope,
    {
      workId: work.workId,
      groupId: group.id,
      items: [{ itemId: item.id, source: item.draft! }],
      action: "approve",
    },
    { kind: "user_message", messageId },
  );
  const began = performance.now();
  const responses = await Promise.all([
    post(url + "/remix-proposals", cuts),
    post(url + "/remix-proposals", cuts),
  ]);
  assert.equal(responses[0]!.statusCode, 201, responses[0]!.body);
  assert.deepEqual(responses[0]!.json(), responses[1]!.json());
  const receipt: LocalCreationReceipt = responses[0]!.json();
  assert.equal(receipt.run.remixOf, parent);
  assert.equal(receipt.run.finance, null);
  const after = await playable(receipt.run.id);
  const output = service.readRevision(
    owner,
    after.artifactId,
    after.revisionId,
  );
  assert.equal(after.artifactId, base.artifactId);
  assert.equal(output.baseRevisionId, base.revisionId);
  assert.ok(output.content.format === "media" && output.content.subtitles);
  const outputBlobId = output.content.blobId;
  const playing = await app.inject({
    url: root + "/blobs/" + output.content.blobId + "/content",
    headers: { range: "bytes=0-31" },
  });
  assert.equal(playing.statusCode, 206, playing.body.slice(0, 40));
  const elapsed = Math.round(performance.now() - began);
  const file = runtime.service.readBlob(owner, output.content.blobId).path;
  const probe = await command("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "json",
    file,
  ]);
  const codecs = JSON.parse(probe.stdout).streams.map(
    (s: { codec_name: string }) => s.codec_name,
  );
  assert.ok(codecs.includes("h264") && codecs.includes("aac"));
  assert.equal(codecs.includes("mov_text"), cuts.subtitles.mode === "soft");
  assert.deepEqual(counts(), beforeCounts);
  assert.match((await download(after, "srt")).body, /Earth from orbit/);
  assert.deepEqual(
    service.readRevision(owner, base.artifactId, base.revisionId).revisionId,
    base.revisionId,
  );
  assert.equal(
    (await post(url + "/remix-proposals", { ...cuts, commandId: "obsolete" }))
      .statusCode,
    409,
  );
  t.diagnostic(
    JSON.stringify({
      duration,
      clickToPlayableMs: elapsed,
      codecs,
      modelToolCalls: 0,
      providerCharges: 0,
      parent,
      remix: receipt.run.id,
    }),
  );
  if (asrAudio)
    assert.ok(elapsed < clickLimit, `30s 720p 重新合成 ${elapsed}ms`);
  // 从刚确认的具体修订导出，和实际提交的剪辑参数逐条比较。
  const verifier=fileURLToPath(new URL("./helpers/inspect-edit-archive.py",import.meta.url));
  for(const format of ["fcpxml","otio","jianying"]){
    const exported=await app.inject({url:root+"/runs/"+receipt.run.id+"/export?format="+format+"&revisionId="+after.revisionId});
    assert.equal(exported.statusCode,200,exported.statusCode===200?format:exported.body);
    assert.equal(exported.headers["x-content-type-options"],"nosniff");
    assert.equal(exported.headers["cache-control"],"private, no-store");
    assert.match(String(exported.headers["content-disposition"]),/attachment/);
    const archive=path.join(dir,format+".zip");await writeFile(archive,exported.rawPayload);
    const inspected=await command(process.env.FRAME_TEST_NLE_PYTHON ?? "python3",[verifier,archive,format,String(duration),String(asrAudio?30000:1000),...(process.env.FRAME_TEST_NLE_PYTHON?["--native"]:[])]);
    t.diagnostic(inspected.stdout.trim());
    if(process.env.FRAME_TEST_EXPORT_DIR)await copyFile(archive,path.join(process.env.FRAME_TEST_EXPORT_DIR,format+".zip"));
  }
  assert.deepEqual(counts(),beforeCounts);

  // 导出兼容旧工程的边界样本，沿用真实 24 fps 成片，再用独立源文件冻结带尾音的旧时间线。
  const mixedVideo = path.join(dir, "source-30fps.mp4"), still = path.join(dir, "still.png");
  await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-frames:v", "31", "-c:v", "libx264", "-preset", "ultrafast", mixedVideo]);
  await command("ffmpeg", ["-v", "error", "-i", mixedVideo, "-frames:v", "1", still]);
  const mixedSource = await media("视频源-30fps", mixedVideo, "video/mp4", 1033);
  const stillSource = await media("静帧源", still, "image/png", null);
  const exportedRun = runRow(db, receipt.run.id), snapshot = snapshotFor(db, exportedRun);
  const render = snapshot.spec.operations.find(op => op.operationId === snapshot.spec.finalOutput.operationId);
  assert.ok(render?.kind === "render" && render.parameters.assembly === "mixed_concat");
  render.inputs = [mixedSource, stillSource, voice, music];
  render.parameters = {
    assembly: "mixed_concat", format: "mp4", width: 640, height: 360, fps: 24,
    segmentIds: ["mixed-video", "mixed-still"],
    segments: [
      { kind: "video", inputSlot: 0, startMs: 0, durationMs: 900 },
      { kind: "image", inputSlot: 1, durationMs: duration - 1200, kenBurns: "zoom_in" },
    ],
    narration: { inputSlot: 2, timelineStartMs: duration - 200, gain: 1 },
    music: { inputSlot: 3, timelineStartMs: duration - 250, playDurationMs: 250,
      sourceStartMs: 0, sourceDurationMs: 125, gain: 0.1, repeat: true, fadeInMs: 0, fadeOutMs: 60, duckUnderNarration: false },
  };
  const olderSnapshot = newAgentId("snap"), olderRun = newAgentId("run");
  db.transaction(() => {
    db.prepare("INSERT INTO production_snapshots VALUES(?,?,?,?)").run(olderSnapshot, JSON.stringify(snapshot.spec), digestOf(snapshot.spec), now);
    db.prepare("INSERT INTO production_runs(id,owner_id,conversation_id,work_id,snapshot_id,title,state,created_seq,created_at,updated_at) " +
      "SELECT ?,owner_id,conversation_id,work_id,?,title,'succeeded',created_seq+1,created_at,updated_at FROM production_runs WHERE id=?")
      .run(olderRun, olderSnapshot, receipt.run.id);
    db.prepare("INSERT INTO production_operations(run_id,id,spec_json,state,output_blob_id) VALUES(?,?,?,'succeeded',?)")
      .run(olderRun, render.operationId, JSON.stringify(render), outputBlobId);
  })();
  const mixed = await app.inject({ url: root + "/runs/" + olderRun + "/export?format=fcpxml" });
  assert.equal(mixed.statusCode, 200, mixed.statusCode === 200 ? "" : mixed.body);
  const mixedArchive = path.join(dir, "mixed-rate.zip");
  await writeFile(mixedArchive, mixed.rawPayload);
  const boundary = await command(process.env.FRAME_TEST_NLE_PYTHON ?? "python3", [verifier, mixedArchive, "fcpxml", String(duration), "200", "--mixed-rate"]);
  t.diagnostic(boundary.stdout.trim());
  if (process.env.FRAME_TEST_CAPTION_COPY)
    await copyFile(file, process.env.FRAME_TEST_CAPTION_COPY);
});
