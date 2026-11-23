import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CreateSubtitleTrack,
  CreationBinding,
  MediaContent,
  RenderSubtitles,
  RevisionRef,
  SaveSubtitleRevision,
  SubtitleReceipt,
  SubtitleTrack,
} from "../../shared/agent/generated/contracts.js";
import {
  getArtifactRow,
  getRevisionRow,
  insertRevision,
  rowToArtifactRevision,
  type ArtifactRow,
} from "./artifact-store.js";
import {
  checkCommandReceipt,
  nextSeq,
  storeCommandReceipt,
} from "./conversation-store.js";
import {
  getWorkRow,
  parseCreationState,
  requireWork,
  setReviewItemDraft,
  writeWorkState,
  type WorkRow,
} from "./creative-work.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { insertEvent } from "./event-log.js";
import { probeVideoFile } from "./media-probe.js";
import type { ProductionBlobs } from "./production-blobs.js";
import {
  projectCues,
  speechCues,
  validateCues,
  type CutParameters,
  type SpeechTiming,
} from "./subtitle-track.js";
import { canonicalJson, newAgentId, type AgentClock } from "./util.js";
import { validatorFor } from "./validate.js";

type Scope = { ownerId: string; conversationId: string };
const runAsr = promisify(execFile);
export function validateSubtitleCommand(schema: string, input: unknown) {
  const result = validatorFor(schema)(input);
  if (!result.ok) throw new AgentError("INVALID_INPUT", result.message);
}
export function scopedRevision(
  db: AgentDatabase,
  scope: Scope,
  ref: RevisionRef,
) {
  const artifact = getArtifactRow(db, scope.ownerId, ref.artifactId);
  const row =
    artifact?.conversation_id === scope.conversationId
      ? getRevisionRow(db, ref.artifactId, ref.revisionId)
      : undefined;
  if (!artifact || !row)
    throw new AgentError("NOT_FOUND", "没有找到当前会话中的这一版素材。");
  return { artifact, row, content: rowToArtifactRevision(row).content };
}
export function subtitleMedia(
  db: AgentDatabase,
  scope: Scope,
  ref: RevisionRef,
) {
  const { content, row } = scopedRevision(db, scope, ref);
  if (
    content.format !== "media" ||
    !(
      content.mimeType.startsWith("audio/") ||
      content.mimeType.startsWith("video/")
    ) ||
    content.durationMs === null
  )
    throw new AgentError("INVALID_INPUT", "请选择有时长的原声视频或配音修订。");
  return { content, duration: content.durationMs, row };
}

export function resolvedSubtitle(
  db: AgentDatabase,
  scope: Scope,
  workId: string,
  config: RenderSubtitles,
) {
  const { artifact, content, row } = scopedRevision(db, scope, config.track);
  if (
    content.format !== "subtitles" ||
    artifact.work_id !== workId ||
    !row.creation_binding_json
  )
    throw new AgentError("INVALID_INPUT", "请选择这件作品内已认可的字幕修订。");
  const binding: CreationBinding = JSON.parse(row.creation_binding_json);
  const subject = {
    kind: "artifact_revision",
    ...config.track,
    digest: row.digest,
  };
  const approved = db
    .prepare(
      "SELECT 1 FROM work_review_confirmations WHERE owner_id=? AND conversation_id=? AND work_id=? AND group_id=? AND item_id=? AND subject_json=? AND action IN ('approve','approve_and_continue')",
    )
    .get(
      scope.ownerId,
      scope.conversationId,
      workId,
      binding.groupId,
      binding.itemId,
      canonicalJson(subject),
    );
  if (!approved)
    throw new AgentError(
      "INVALID_INPUT",
      "这一版字幕尚未认可，请先在字幕审阅项认可这一版。",
    );
  return {
    track: content,
    sourceBlob: subtitleMedia(db, scope, content.source).content.blobId,
    subject,
  };
}

export function renderedCues(
  db: AgentDatabase,
  scope: Scope,
  workId: string,
  parameters: CutParameters,
  slots: ReadonlyMap<number, string>,
) {
  if (!parameters.subtitles)
    throw new AgentError("NOT_FOUND", "这版成片没有字幕轨。");
  const { track, sourceBlob } = resolvedSubtitle(
    db,
    scope,
    workId,
    parameters.subtitles,
  );
  return {
    style: track.stylePreset,
    cues: projectCues(track.cues, sourceBlob, parameters, slots),
  };
}

async function alignMedia(
  file: string,
  content: MediaContent,
  duration: number,
  approvedText: string | undefined,
  signal?: AbortSignal,
) {
  if (content.dub?.boundaries.length)
    return {
      alignment: "tts_word" as const,
      cues: speechCues(
        { words: content.dub.boundaries, starts: [], ends: [] },
        duration,
        approvedText ?? content.dub.text,
      ),
    };
  if (
    content.mimeType.startsWith("video/") &&
    !(await probeVideoFile(file, undefined, signal)).hasAudio
  )
    throw new AgentError("INVALID_INPUT", "这段视频没有可识别的声音轨。");
  const home = process.env.FRAME_ASR_HOME ?? "/opt/frame-asr";
  let stdout: string;
  try {
    ({ stdout } = await runAsr(
      join(home, "bin", "python"),
      ["-I", join(home, "transcribe.py"), join(home, "model"), file],
      { signal, timeout: 15 * 60_000, maxBuffer: 20 * 1024 * 1024 },
    ));
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT")
      throw new AgentError("CAPABILITY_UNAVAILABLE", "本地识音模型尚未安装。");
    if (signal?.aborted) throw error;
    if (typeof e.code === "number" || e.code === "ETIMEDOUT")
      throw new AgentError(
        "TEMPORARILY_UNAVAILABLE",
        "本地语音识别未完成。识别进程退出：" + String(e.code),
      );
    throw error;
  }
  const timing: SpeechTiming = JSON.parse(stdout);
  if (
    !Array.isArray(timing.words) ||
    !Array.isArray(timing.starts) ||
    !Array.isArray(timing.ends) ||
    !timing.words.every(
      (w) =>
        typeof w.text === "string" &&
        Number.isInteger(w.offsetMs) &&
        Number.isInteger(w.durationMs),
    )
  )
    throw new Error("本地转录器返回了不完整的词边界。");
  return {
    alignment: "local_asr" as const,
    cues: speechCues(timing, duration),
  };
}

export function reviewedNarration(
  db: AgentDatabase,
  work: WorkRow | null,
  spoken: string,
): string {
  if (!work) return spoken;
  const normalize = (s: string) =>
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const normalized = normalize(spoken);
  for (const group of parseCreationState(work).groups)
    for (const item of group.items) {
      if (!item.approved || !["plan", "content", "voice"].includes(item.role))
        continue;
      const source = item.approved;
      let original: string | undefined;
      if (source.kind === "message_text") original = source.text;
      else {
        const revision = scopedRevision(
          db,
          { ownerId: work.owner_id, conversationId: work.conversation_id },
          source,
        );
        if (revision.content.format === "markdown")
          original = revision.content.narrationText ?? revision.content.text;
      }
      if (original && normalize(original) === normalized) return original;
    }
  return spoken;
}

export function registerSubtitle(
  db: AgentDatabase,
  now: string,
  scope: Scope,
  work: WorkRow | null,
  source: RevisionRef,
  track: SubtitleTrack,
  requestId: string | null,
): SubtitleReceipt {
  const media = subtitleMedia(db, scope, source);
  validateCues(track.cues, media.duration);
  validateSubtitleCommand("SubtitleTrack", track);
  const title =
      `字幕 · ${scopedRevision(db, scope, source).artifact.title}`.slice(
        0,
        120,
      ),
    id = newAgentId("art");
  const state = work ? parseCreationState(work) : null;
  let binding: CreationBinding | null = null;
  if (work && state) {
    const group = {
      id: newAgentId("grp"),
      title: "字幕",
      revision: 1,
      nextIntent: null,
      items: [
        {
          id: newAgentId("item"),
          label: title,
          role: "subtitle" as const,
          required: false,
          draft: null,
          approved: null,
          confirmationId: null,
          approvedAt: null,
        },
      ],
    };
    const existing = state.groups.find(
      (g) =>
        g.title === "字幕" && g.items.every((item) => item.role === "subtitle"),
    );
    if (existing) {
      existing.items.push(group.items[0]!);
      existing.revision++;
    } else state.groups.push(group);
    binding = {
      workId: work.id,
      groupId: existing?.id ?? group.id,
      itemId: group.items[0]!.id,
      inputSources: [
        { kind: "artifact_revision", ...source, digest: media.row.digest },
      ],
      reviewInputs: [],
      purpose: "draft",
    };
  }
  db.prepare(
    "INSERT INTO artifacts(id,conversation_id,owner_id,title,kind,work_id,head_revision_number,created_seq,created_at,updated_at) VALUES(?,?,?,?,'script',?,0,?,?,?)",
  ).run(
    id,
    scope.conversationId,
    scope.ownerId,
    title,
    work?.id ?? null,
    nextSeq(db, "artifacts", scope.conversationId),
    now,
    now,
  );
  const revision = insertRevision(
    db,
    now,
    getArtifactRow(db, scope.ownerId, id)!,
    null,
    { kind: "script", title, content: track },
    requestId,
    "tool_auxiliary",
    binding,
  );
  if (work && state && binding) {
    const item = state.groups
      .find((g) => g.id === binding.groupId)!
      .items.find((i) => i.id === binding.itemId)!;
    item.draft = {
      kind: "artifact_revision",
      artifactId: id,
      revisionId: revision.id,
      digest: revision.digest,
    };
    writeWorkState(db, now, work, state);
  }
  insertEvent(db, now, {
    ...scope,
    kind: "artifact.delivered",
    entityId: id,
    entityVersion: revision.revision_number,
    notification: "new_output",
  });
  return {
    artifact: { artifactId: id, revisionId: revision.id },
    revisionNumber: revision.revision_number,
    workId: work?.id ?? null,
  };
}

export async function createSubtitle(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  clock: AgentClock,
  ownerId: string,
  workId: string,
  input: CreateSubtitleTrack,
  request?: { id: string; check: () => void },
  signal?: AbortSignal,
) {
  validateSubtitleCommand("CreateSubtitleTrack", input);
  const work = getWorkRow(db, ownerId, workId);
  if (!work) throw new AgentError("NOT_FOUND", "没有找到这件作品。");
  const scope = { ownerId, conversationId: work.conversation_id },
    key = {
      ownerId,
      operation: "createSubtitleTrack",
      targetId: workId,
      commandId: input.commandId,
    };
  const commandBody = request
    ? { source: input.source, stylePreset: input.stylePreset }
    : input;
  const prior = checkCommandReceipt<SubtitleReceipt>(db, key, commandBody);
  if (prior.kind === "replay") return prior.receipt;
  const current = () => {
    const live = requireWork(db, ownerId, work.conversation_id, workId);
    if (live.revision !== input.expectedRevision)
      throw new AgentError(
        "STALE_REVISION",
        "作品已有新版本，请刷新后再生成字幕。",
      );
    return live;
  };
  current();
  const media = subtitleMedia(db, scope, input.source);
  const blob = blobs.get(ownerId, media.content.blobId);
  blobs.verify(blob);
  const timing = await alignMedia(
    blobs.filePath(blob.digest),
    media.content,
    media.duration,
    media.content.dub
      ? reviewedNarration(db, work, media.content.dub.text)
      : undefined,
    signal,
  );
  return db.transaction(() => {
    const again = checkCommandReceipt<SubtitleReceipt>(db, key, commandBody);
    if (again.kind === "replay") return again.receipt;
    request?.check();
    const receipt = registerSubtitle(
      db,
      clock(),
      scope,
      current(),
      input.source,
      {
        format: "subtitles",
        source: input.source,
        stylePreset: input.stylePreset,
        ...timing,
      },
      request?.id ?? null,
    );
    storeCommandReceipt(db, clock(), key, commandBody, receipt);
    return receipt;
  })();
}

export function editSubtitles(
  db: AgentDatabase,
  clock: AgentClock,
  artifact: ArtifactRow,
  input: SaveSubtitleRevision,
) {
  validateSubtitleCommand("SaveSubtitleRevision", input);
  const scope = {
    ownerId: artifact.owner_id,
    conversationId: artifact.conversation_id,
  };
  const key = {
    ownerId: scope.ownerId,
    operation: "saveSubtitleRevision",
    targetId: artifact.id,
    commandId: input.commandId,
  };
  return db.transaction(() => {
    const replay = checkCommandReceipt<SubtitleReceipt>(db, key, input);
    if (replay.kind === "replay") return replay.receipt;
    if (
      artifact.head_revision_number !== input.expectedRevision ||
      artifact.head_revision_id !== input.baseRevisionId
    )
      throw new AgentError(
        "STALE_REVISION",
        "字幕已有后继稿，请基于当前版本校对。",
      );
    const { row, content } = scopedRevision(db, scope, {
      artifactId: artifact.id,
      revisionId: input.baseRevisionId,
    });
    if (content.format !== "subtitles")
      throw new AgentError("INVALID_INPUT", "此修订不是字幕稿。");
    validateCues(input.cues, subtitleMedia(db, scope, content.source).duration);
    const binding: CreationBinding | null = row.creation_binding_json
      ? JSON.parse(row.creation_binding_json)
      : null;
    const now = clock(),
      revision = insertRevision(
        db,
        now,
        artifact,
        row.id,
        {
          title: artifact.title,
          kind: "script",
          content: {
            ...content,
            cues: input.cues,
            stylePreset: input.stylePreset,
          },
        },
        null,
        "delivered",
        binding,
      );
    if (binding)
      setReviewItemDraft(
        db,
        now,
        requireWork(db, scope.ownerId, scope.conversationId, binding.workId),
        binding,
        {
          kind: "artifact_revision",
          artifactId: artifact.id,
          revisionId: revision.id,
          digest: revision.digest,
        },
      );
    insertEvent(db, now, {
      ...scope,
      kind: "artifact.delivered",
      entityId: artifact.id,
      entityVersion: revision.revision_number,
      notification: "new_output",
    });
    const receipt = {
      artifact: { artifactId: artifact.id, revisionId: revision.id },
      revisionNumber: revision.revision_number,
      workId: artifact.work_id,
    };
    storeCommandReceipt(db, now, key, input, receipt);
    return receipt;
  })();
}
