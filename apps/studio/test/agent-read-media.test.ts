import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { probeImageFile, probeVideoFile } from "../src/server/agent/media-probe.js";
import { canonicalJson, digestOf, newAgentId } from "../src/server/agent/util.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../src/server/agent/offline.js";
import type { AgentRuntimeOptions } from "../src/server/agent/assembly.js";
import type { ProductionBlobs } from "../src/server/agent/production-blobs.js";

// G3-1 真实媒体输入：read_artifact 给模型的是真实媒体而不是"我看到了"的口头声明——
// 图片回真实图像块；视频未给时间点时回头/中/尾三个代表帧并写明已看范围；
// 给了 frameTimesMs 只抽对应时间画面。音频不装听感，只回可证实事实。
// 验证看模型实际输入（toolResult 内容块），媒体用真实 ffmpeg 产物。
// 断言一律在回合结束后针对捕获的内容块进行：Faux response 回调里抛错会被运行时
// 吞掉、只把回合变成 failed，看不到具体差异。

const run = promisify(execFile);
let sequence = 0;
const cmd = () => `g31-${++sequence}`;
const clock = () => "2026-11-08T00:00:00.000Z";

const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "g31-read-media" },
  name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
  verificationNote: "离线 Faux 文本", isDefault: true };

async function setup(): Promise<{ runtime: AgentRuntime; conversationId: string; blobs: ProductionBlobs; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-g31-"));
  const runtime = await createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock, catalog: () => ({}),
  } satisfies AgentRuntimeOptions);
  const conversationId = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "读媒体" }).conversation.id;
  return { runtime, conversationId, blobs: runtime.production!.blobs, directory };
}

interface Ref { artifactId: string; revisionId: string; digest: string; filePath: string; durationMs: number | null }

async function mediaRevision(
  blobs: ProductionBlobs, runtime: AgentRuntime, conversationId: string, file: string,
  mimeType: "image/png" | "video/mp4" | "audio/mpeg", durationMs: number | null,
): Promise<Ref> {
  const bytes = await readFile(file);
  const blob = blobs.persist("local-owner", conversationId, bytes, mimeType, durationMs);
  const content = { format: "media", blobId: blob.id, mimeType, durationMs };
  const artifactId = newAgentId("art"), revisionId = newAgentId("rev"), now = clock();
  const db = runtime.database;
  db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,1,?,?,?)")
    .run(artifactId, conversationId, "local-owner", "媒体片段",
      mimeType === "image/png" ? "image" : mimeType === "video/mp4" ? "video" : "audio", revisionId,
      (db.prepare("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM artifacts WHERE conversation_id=?").get(conversationId) as { n: number }).n, now, now);
  db.prepare("INSERT INTO artifact_revisions(id,artifact_id,revision_number,run_id,digest,content_json,created_at) VALUES(?,?,1,NULL,?,?,?)")
    .run(revisionId, artifactId, digestOf(content), canonicalJson(content), now);
  db.prepare("UPDATE artifacts SET head_revision_id=? WHERE id=?").run(revisionId, artifactId);
  return { artifactId, revisionId, digest: blob.digest, filePath: blobs.filePath(blob.digest), durationMs };
}

async function send(
  runtime: AgentRuntime, conversationId: string,
  steps: (ReturnType<typeof fauxAssistantMessage> | ((context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>))[],
) {
  runtime.host.faux!.setResponses(steps);
  const sent = await runtime.service.sendMessage("local-owner", conversationId, {
    commandId: cmd(), text: "请查看", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
  });
  for (let i = 0; i < 300 && runtime.service.snapshot("local-owner", conversationId).activeRequestId; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(runtime.service.snapshot("local-owner", conversationId).activeRequestId, null, "回合应已结束");
  const request = runtime.database.prepare("SELECT state FROM requests WHERE id=?").get(sent.receipt.requestId) as { state: string };
  const messages = runtime.database.prepare("SELECT role,state,text FROM messages WHERE request_id=? ORDER BY created_seq").all(sent.receipt.requestId) as { role: string; state: string; text: string }[];
  assert.equal(request.state, "completed", JSON.stringify(messages));
}

type ToolPart = { type: string; text?: string; data?: string; mimeType?: string };
type CapturedParts = { isError: boolean; parts: ToolPart[] };
const partsOf = (context: TranscriptContext): CapturedParts => {
  const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
  return { isError: result.isError, parts: result.content as ToolPart[] };
};
const textsOf = (parts: ToolPart[]) => parts.filter(part => part.type === "text").map(part => part.text ?? "");
const imagesOf = (parts: ToolPart[]) => parts.filter(part => part.type === "image");
const describeParts = (captured: CapturedParts) => JSON.stringify({
  isError: captured.isError,
  texts: textsOf(captured.parts),
  images: imagesOf(captured.parts).map(image => ({ mimeType: image.mimeType, bytes: Math.floor((image.data?.length ?? 0) * 3 / 4) })),
});

// 发一次 read_artifact 并返回模型实际收到的 toolResult 内容块；回合终态 completed 由 send 断言。
async function readArtifact(
  runtime: AgentRuntime, conversationId: string,
  input: { artifactId: string; revisionId: string; frameTimesMs?: number[] },
): Promise<CapturedParts> {
  let captured: CapturedParts | undefined;
  await send(runtime, conversationId, [
    fauxAssistantMessage([fauxToolCall("read_artifact", input)]),
    context => {
      captured = partsOf(context);
      return fauxAssistantMessage("看到了。");
    },
  ]);
  if (!captured) throw new Error("捕获回调未执行");
  return captured;
}

it("G3-1 read_artifact：图片回真实图像，视频无时间点回三个代表帧并写明已看范围，指定时间只抽对应画面", { timeout: 180_000 }, async () => {
  const directory = (await mkdtemp(path.join(tmpdir(), "frame-g31-media-")));
  try {
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x2e806e:s=160x90:d=1",
      "-frames:v", "1", path.join(directory, "still.png")]);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=duration=1:size=2400x1200:rate=4",
      "-frames:v", "1", path.join(directory, "large.png")]);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=duration=2:size=2400x1200:rate=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(directory, "clip.mp4")]);
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-ar", "32000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", path.join(directory, "voice.mp3")]);

    const { runtime, conversationId, blobs } = await setup();
    try {
      const imageRef = await mediaRevision(blobs, runtime, conversationId, path.join(directory, "still.png"), "image/png", null);
      const largeImageRef = await mediaRevision(blobs, runtime, conversationId, path.join(directory, "large.png"), "image/png", null);
      const clipFacts = await probeVideoFile(path.join(directory, "clip.mp4"));
      const videoRef = await mediaRevision(blobs, runtime, conversationId, path.join(directory, "clip.mp4"), "video/mp4", clipFacts.durationMs);
      const audioRef = await mediaRevision(blobs, runtime, conversationId, path.join(directory, "voice.mp3"), "audio/mpeg", 1000);

      // 图片：模型收到的是真实图像字节，不是描述。小图在 SDK 限内直通原字节。
      const imageBase64 = (await readFile(imageRef.filePath)).toString("base64");
      const smallImage = await readArtifact(runtime, conversationId, { artifactId: imageRef.artifactId, revisionId: imageRef.revisionId });
      {
        const images = imagesOf(smallImage.parts);
        assert.equal(smallImage.isError, false, describeParts(smallImage));
        assert.equal(images.length, 1, describeParts(smallImage));
        assert.equal(images[0]!.mimeType, "image/png");
        assert.equal(images[0]!.data, imageBase64, "小图直通原图字节");
        assert.equal(textsOf(smallImage.parts).length, 0, "小图未缩放，不带尺寸映射说明");
      }

      // 大图必须经 Pi 公共缩放能力进入模型，并携带原图/显示尺寸坐标说明。
      const largeCaptured = await readArtifact(runtime, conversationId, { artifactId: largeImageRef.artifactId, revisionId: largeImageRef.revisionId });
      {
        const images = imagesOf(largeCaptured.parts);
        assert.equal(largeCaptured.isError, false, describeParts(largeCaptured));
        assert.equal(images.length, 1, describeParts(largeCaptured));
        assert.match(textsOf(largeCaptured.parts).join("\n"), /original 2400x1200, displayed at 2000x1000/, describeParts(largeCaptured));
        const largeImagePath = path.join(directory, "presented-large-image");
        await writeFile(largeImagePath, Buffer.from(images[0]!.data!, "base64"));
        const largeImageFacts = await probeImageFile(largeImagePath);
        assert.deepEqual([largeImageFacts.width, largeImageFacts.height], [2000, 1000], "大图实际字节是缩放后尺寸");
      }

      // 视频未给时间点：头/中/尾三个代表帧，写明已看范围与总时长，不声称看过完整视频。
      // 尾代表帧取视频轨最后一帧：固定 0.9×时长会落在最后一帧之后，整个读取会报错。
      const intervalMs = Math.round(1000 / clipFacts.frameRate!);
      const lastFrameMs = clipFacts.videoDurationMs - intervalMs;
      const expectedTimes = [Math.round(clipFacts.videoDurationMs * 0.1), Math.round(clipFacts.videoDurationMs * 0.5), lastFrameMs];
      const frames = await readArtifact(runtime, conversationId, { artifactId: videoRef.artifactId, revisionId: videoRef.revisionId });
      {
        const texts = textsOf(frames.parts);
        const images = imagesOf(frames.parts);
        assert.equal(frames.isError, false, describeParts(frames));
        assert.match(texts[0]!, /^已看范围：头\/中\/尾 3 个代表帧（总时长 \d+ms）；要核对具体画面时用 frameTimesMs 指定毫秒时间点。$/, describeParts(frames));
        const labels = texts.flatMap(text => {
          const match = /^t=(\d+)ms（代表帧）$/.exec(text);
          return match ? [match[1]!] : [];
        });
        assert.deepEqual(labels, expectedTimes.map(String), `代表帧时间点应为 ${expectedTimes.join("/")}ms`);
        assert.equal(texts.filter(text => /original 2400x1200, displayed at 2000x1000/.test(text)).length, 3, "每帧都带视频原始画布的尺寸映射说明");
        assert.equal(images.length, 3, describeParts(frames));
        assert.ok(images.every(image => (image.mimeType === "image/png" || image.mimeType === "image/jpeg") && (image.data?.length ?? 0) > 0), describeParts(frames));
        assert.equal(new Set(images.map(image => image.data)).size, 3, "三个时间点抽出的是不同画面");
        for (const [index, image] of images.entries()) {
          const file = path.join(directory, `presented-frame-${index}`);
          await writeFile(file, Buffer.from(image.data!, "base64"));
          const facts = await probeImageFile(file);
          assert.deepEqual([facts.width, facts.height], [2000, 1000], `代表帧 ${index} 在 FFmpeg 限尺寸后经 SDK 缩放`);
        }
      }

      // 指定时间点：只抽对应画面，不再带代表帧标注与已看范围说明。
      const explicit = await readArtifact(runtime, conversationId, { artifactId: videoRef.artifactId, revisionId: videoRef.revisionId, frameTimesMs: [1000] });
      {
        const texts = textsOf(explicit.parts);
        const images = imagesOf(explicit.parts);
        assert.equal(explicit.isError, false, describeParts(explicit));
        assert.deepEqual(texts.filter(text => text.startsWith("t=")), ["t=1000ms"], "只带指定时间点标注");
        assert.equal(texts.some(text => text.includes("（代表帧）") || text.startsWith("已看范围")), false, "指定帧不冒充代表帧范围");
        assert.equal(texts.filter(text => /original 2400x1200, displayed at 2000x1000/.test(text)).length, 1, describeParts(explicit));
        assert.equal(images.length, 1, "只抽一帧");
        assert.ok((images[0]!.data?.length ?? 0) > 0);
      }

      // 音频：不装听感，只回可证实事实（内容为修订事实 JSON），不出现图像块。
      const audio = await readArtifact(runtime, conversationId, { artifactId: audioRef.artifactId, revisionId: audioRef.revisionId });
      {
        assert.equal(audio.isError, false, describeParts(audio));
        assert.equal(imagesOf(audio.parts).length, 0, "音频没有图像块可给");
        assert.match(textsOf(audio.parts).join(""), /audio\/mpeg/, "回的是修订事实");
      }
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
