import type { Multipart } from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  MediaContent,
  MediaProvenance,
  RevisionRef,
  UploadAttachment,
  UploadFacts,
  UploadForm,
  UploadMime,
  UploadReceipt,
} from "../../shared/agent/generated/contracts.js";
import { getArtifactRow, insertRevision } from "./artifact-store.js";
import {
  checkCommandReceipt,
  nextSeq,
  requireConversation,
  rowToConversation,
  storeCommandReceipt,
} from "./conversation-store.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent, type EventHub } from "./event-log.js";
import { readModelImage, resizeImageForModel } from "./image-projection.js";
import { recordBlobSources } from "./material-store.js";
import {
  decodeUploadedVideo,
  extractVideoFrames,
  InvalidAudioOutput,
  InvalidImageFile,
  InvalidVideoFile,
  probeAudioOutputFile,
  probeImageFile,
  probeVideoFile,
} from "./media-probe.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { newAgentId, type AgentClock } from "./util.js";
import { validatorFor } from "./validate.js";

const mimeByExt = new Map<string, UploadMime>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
]);
const MiB = 1024 * 1024;
export const uploadLimits = {
  files: 1,
  fields: 3,
  parts: 5,
  fileSize: 512 * MiB + 1,
  fieldSize: 1024,
  fieldNameSize: 40,
};

async function receiveFile(parts: AsyncIterableIterator<Multipart>, file: string, signal: AbortSignal) {
  const fields = new Map<string, string>();
  let media: { fileName: string; mimeType: UploadMime } | undefined;
  for await (const part of parts) {
    if (part.type === "field") {
      if (
        !["commandId", "expectedRevision", "rights"].includes(part.fieldname) ||
        fields.has(part.fieldname) ||
        part.valueTruncated ||
        typeof part.value !== "string"
      )
        throw new AgentError("INVALID_INPUT", "上传字段不完整或重复。");
      fields.set(part.fieldname, part.value);
      continue;
    }
    const fileName = part.filename;
    const mimeType = mimeByExt.get(path.extname(fileName).toLowerCase());
    const declared = part.mimetype === "audio/x-wav" || part.mimetype === "audio/wave" ? "audio/wav" : part.mimetype;
    if (
      media ||
      part.fieldname !== "file" ||
      !mimeType ||
      (declared !== "application/octet-stream" && declared !== mimeType) ||
      fileName.length > 240 ||
      /[\\/\u0000-\u001f]/u.test(fileName)
    ) {
      part.file.resume();
      throw new AgentError(
        "INVALID_INPUT",
        "请上传单个 JPG、PNG、WebP、MP4、WebM、MP3 或 WAV 文件，并保留对应扩展名。",
      );
    }
    const limit = (mimeType.startsWith("image/") ? 30 : mimeType.startsWith("audio/") ? 100 : 512) * MiB;
    let size = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > limit) done();
        else done(null, chunk);
      },
    });
    await pipeline(part.file, measure, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
    if (!size || size > limit || part.file.truncated)
      throw new AgentError("INVALID_INPUT", `文件为空或超过本类型 ${limit / MiB} MiB 上限。`);
    media = { fileName, mimeType };
  }
  if (!media) throw new AgentError("INVALID_INPUT", "请选择要上传的素材文件。");
  const revisionField = fields.get("expectedRevision");
  const form = {
    commandId: fields.get("commandId"),
    expectedRevision: revisionField && /^[1-9]\d*$/.test(revisionField) ? Number(revisionField) : null,
    rights: fields.get("rights"),
    file: media.fileName,
  };
  const verdict = validatorFor("UploadForm")(form);
  if (!verdict.ok) throw new AgentError("INVALID_INPUT", "请确认素材使用权，并携带有效的上传命令和会话版本。");
  return { ...media, form: form as UploadForm };
}

async function inspectUpload(file: string, mime: UploadMime, signal: AbortSignal) {
  try {
    if (mime.startsWith("image/")) {
      const { mimeType, width, height } = await probeImageFile(file, signal);
      return { kind: "image", mimeType, durationMs: null, facts: { width, height } } as const;
    }
    if (mime.startsWith("audio/")) {
      const { mimeType, durationMs, sampleRate, channels } = await probeAudioOutputFile(file, signal);
      return { kind: "audio", mimeType, durationMs, facts: { sampleRate, channels } } as const;
    }
    const { mimeType, durationMs, width, height, hasAudio } = await probeVideoFile(file, "ffprobe", signal);
    await decodeUploadedVideo(file, mimeType, signal);
    return { kind: "video", mimeType, durationMs, facts: { width, height, hasAudio } } as const;
  } catch (error) {
    if (error instanceof InvalidAudioOutput || error instanceof InvalidVideoFile || error instanceof InvalidImageFile)
      throw new AgentError("INVALID_INPUT", error.message);
    throw error;
  }
}

export async function uploadConversationMedia(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  clock: AgentClock,
  hub: EventHub,
  ownerId: string,
  conversationId: string,
  parts: AsyncIterableIterator<Multipart>,
  signal: AbortSignal,
): Promise<UploadReceipt> {
  requireConversation(db, ownerId, conversationId);
  const result = await blobs.withStagingDirectory(async (directory) => {
    const file = path.join(directory, "original");
    const { fileName, mimeType, form } = await receiveFile(parts, file, signal);
    const prepared = await blobs.prepareFile(file);
    const key = { ownerId, operation: "uploadConversationMedia", targetId: conversationId, commandId: form.commandId };
    const body = { ...form, mimeType, sizeBytes: prepared.sizeBytes, digest: prepared.digest };
    const prior = checkCommandReceipt<UploadReceipt>(db, key, body);
    if (prior.kind === "replay") return prior.receipt;
    if (requireConversation(db, ownerId, conversationId).revision !== form.expectedRevision)
      throw new AgentError("STALE_REVISION", "会话版本已更新，请重试上传。");
    const detected = await inspectUpload(file, mimeType, signal);
    if (
      detected.mimeType !== mimeType ||
      (detected.durationMs !== null && (detected.durationMs < 1 || detected.durationMs > 86400000))
    ) {
      throw new AgentError("INVALID_INPUT", "素材的实际格式与文件类型不符，或时长超过 24 小时。");
    }
    let frame:
      { prepared: Awaited<ReturnType<ProductionBlobs["prepareFile"]>>; width: number; height: number } | undefined;
    if (detected.kind === "video") {
      const jpeg = path.join(directory, "first.jpg");
      const [bytes] = await extractVideoFrames(file, [0], signal, "reference");
      await writeFile(jpeg, bytes!, { flag: "wx", mode: 0o600 });
      const { width, height } = await probeImageFile(jpeg, signal);
      frame = { prepared: await blobs.prepareFile(jpeg), width, height };
    }
    signal.throwIfAborted();
    return blobs.withRegistration(ownerId, conversationId, (register) => {
      const replay = checkCommandReceipt<UploadReceipt>(db, key, body);
      if (replay.kind === "replay") return replay.receipt;
      const current = requireConversation(db, ownerId, conversationId);
      if (current.revision !== form.expectedRevision)
        throw new AgentError("STALE_REVISION", "会话版本已更新，请重试上传。");
      const now = clock();
      const blob = register(prepared, mimeType, detected.durationMs);
      const id = newAgentId("art");
      const source: MediaProvenance = {
        provider: "user_upload",
        assetId: prepared.digest,
        sourceUrl: `/api/agent/v1/blobs/${blob.id}/content`,
        creatorName: null,
        creatorUrl: null,
        licenseUrl: null,
        licenseName: "上传者声明有权使用",
        acquiredAt: now,
        title: fileName,
      };
      const facts: UploadFacts = { fileName, sizeBytes: prepared.sizeBytes, rights: form.rights, ...detected.facts };
      if (frame) {
        const still = register(frame.prepared, "image/jpeg", null);
        facts.firstFrame = { blobId: still.id, digest: still.digest, width: frame.width, height: frame.height };
        recordBlobSources(db, still.id, [source]);
      }
      const validFacts = validatorFor("UploadFacts")(facts);
      if (!validFacts.ok) throw new AgentError("INVALID_INPUT", "素材的尺寸、采样率或声道数超出可登记范围。");
      const sources = recordBlobSources(db, blob.id, [source]);
      db.prepare(
        `INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,head_revision_id,head_revision_number,created_seq,created_at,updated_at)
        VALUES(?,?,?,?,?,NULL,0,?,?,?)`,
      ).run(
        id,
        conversationId,
        ownerId,
        fileName.slice(0, 120),
        detected.kind,
        nextSeq(db, "artifacts", conversationId),
        now,
        now,
      );
      const revision = insertRevision(
        db,
        now,
        getArtifactRow(db, ownerId, id)!,
        null,
        {
          title: fileName.slice(0, 120),
          kind: detected.kind,
          content: {
            format: "media",
            blobId: blob.id,
            mimeType,
            durationMs: detected.durationMs,
            sources,
            upload: facts,
          },
        },
        null,
        "user_upload",
      );
      db.prepare("UPDATE conversations SET revision=revision+1,updated_at=? WHERE id=?").run(now, conversationId);
      const conversation = rowToConversation(requireConversation(db, ownerId, conversationId));
      insertEvent(db, now, {
        ownerId,
        conversationId,
        kind: "artifact.delivered",
        entityId: id,
        entityVersion: 1,
        notification: "quiet",
      });
      insertEvent(db, now, {
        ownerId,
        conversationId,
        kind: "conversation.changed",
        entityId: conversationId,
        entityVersion: conversation.revision,
      });
      const receipt: UploadReceipt = {
        conversation,
        attachment: {
          source: { artifactId: id, revisionId: revision.id },
          blobId: blob.id,
          mimeType,
          durationMs: detected.durationMs,
          facts,
        },
      };
      storeCommandReceipt(db, now, key, body, receipt);
      return receipt;
    });
  });
  hub.notifyCommitted(conversationId);
  return result;
}

export function resolveUploads(
  db: AgentDatabase,
  ownerId: string,
  conversationId: string,
  refs: readonly RevisionRef[],
): UploadAttachment[] {
  const select = db.prepare(`SELECT r.content_json FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id
    WHERE r.id=? AND a.id=? AND a.owner_id=? AND a.conversation_id=? AND r.origin_kind='user_upload'`);
  return refs.map((source) => {
    const row = select.get(source.revisionId, source.artifactId, ownerId, conversationId) as
      { content_json: string } | undefined;
    if (!row) throw new AgentError("NOT_FOUND", "未找到当前会话中的这份上传素材。");
    const content = JSON.parse(row.content_json) as MediaContent;
    if (!content.upload) throw new Error("上传修订缺少探测事实。");
    return {
      source,
      blobId: content.blobId,
      mimeType: content.mimeType,
      durationMs: content.durationMs,
      facts: content.upload,
    };
  });
}

export async function imagesForUploads(
  blobs: ProductionBlobs,
  ownerId: string,
  uploads: readonly UploadAttachment[],
): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const upload of uploads) {
    if (!upload.mimeType.startsWith("image/")) continue;
    const blob = blobs.get(ownerId, upload.blobId);
    const file = blobs.filePath(blob.digest);
    const { bytes, mimeType } = await readModelImage(file, upload.mimeType, blob.size_bytes);
    const resized = await resizeImageForModel(bytes, mimeType);
    images.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
  }
  return images;
}
