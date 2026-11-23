import type {
  CreationBinding,
  InputRef,
  MixedConcatSegments,
  RemixCommand,
  RemixTimeline,
  RenderParameters,
  ToolRenderProject,
} from "../../shared/agent/generated/contracts.js";
import { rowToArtifactRevision } from "./artifact-store.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import type { ProductionBlobs } from "./production-blobs.js";
import {
  operationOutputRevision,
  operationsFor,
  runRow,
  snapshotFor,
} from "./production-store.js";
import { scopedRevision, validateSubtitleCommand } from "./subtitle-service.js";

export function frozenEdit(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  ownerId: string,
  runId: string,
  revisionId: string,
) {
  const run = runRow(db, runId);
  if (run.owner_id !== ownerId)
    throw new AgentError("NOT_FOUND", "没有找到这次制作。");
  const operationRows = operationsFor(db, runId);
  const operation = operationRows.find(
    (op) => op.output_revision_id === revisionId,
  );
  if (!operation || operation.state !== "succeeded") return null;
  const snapshot = snapshotFor(db, run).spec;
  const op = snapshot.operations.find(
    (item) => item.operationId === operation.id,
  );
  const output = operationOutputRevision(db, runId, operation.id);
  if (
    !op ||
    op.kind !== "render" ||
    !output?.creation_binding_json ||
    (op.parameters.assembly !== "mixed_concat" &&
      op.parameters.assembly !== "timed_narrated_concat")
  )
    return null;
  const scope = { ownerId, conversationId: run.conversation_id };
  const binding: CreationBinding = JSON.parse(output.creation_binding_json);
  const parameters = op.parameters;
  const inputs: InputRef[] = [],
    slots = new Map<number, string>(),
    lengths = new Map<number, number | null>(),
    labels = new Map<number, string>();
  for (const [slot, input] of op.inputs.entries()) {
    let ref: InputRef = input,
      blobId: string;
    if (input.kind === "operation_output") {
      const revision = operationOutputRevision(
        db,
        runId,
        input.producerOperationId,
      );
      if (revision) {
        ref = {
          kind: "artifact_revision",
          artifactId: revision.artifact_id,
          revisionId: revision.id,
          digest: revision.digest,
        };
      } else {
        const recorded = operationRows.find(
          (row) => row.id === input.producerOperationId,
        )?.output_blob_id;
        if (!recorded) return null;
        const blob = blobs.get(ownerId, recorded);
        ref = { kind: "blob", blobId: blob.id, digest: blob.digest };
      }
    }
    if (ref.kind === "artifact_revision") {
      const { artifact, content } = scopedRevision(db, scope, ref);
      if (content.format !== "media") return null;
      blobId = content.blobId;
      labels.set(slot, artifact.title);
    } else if (ref.kind === "blob") blobId = ref.blobId;
    else return null;
    const blob = blobs.get(ownerId, blobId);
    if (blob.conversation_id !== run.conversation_id)
      throw new AgentError("NOT_FOUND", "冻结素材不属于这次制作。");
    blobs.verify(blob);
    slots.set(slot, blob.id);
    lengths.set(slot, blob.duration_ms);
    inputs.push(ref);
  }
  const base = { artifactId: output.artifact_id, revisionId: output.id };
  const segments = parameters.segments.map((s, i) => ({
    id: parameters.segmentIds?.[i] ?? `cut-${i + 1}`,
    label: labels.get(s.inputSlot) ?? `镜头 ${i + 1}`,
    kind: s.kind,
    startMs: s.kind === "video" ? s.startMs : 0,
    durationMs: s.durationMs,
    sourceDurationMs: lengths.get(s.inputSlot)!,
    originalGain:
      s.kind === "image"
        ? null
        : parameters.assembly === "timed_narrated_concat"
          ? 0
          : "originalGain" in s && typeof s.originalGain === "number"
            ? s.originalGain
            : 1,
  }));
  const narration =
    parameters.assembly === "mixed_concat"
      ? parameters.narration
      : {
          inputSlot: parameters.narrationInputSlot,
          timelineStartMs: 0,
          gain: 1,
        };
  const music =
    parameters.assembly === "mixed_concat" ? parameters.music : undefined;
  const view: Extract<RemixTimeline, { available: true }> = {
    available: true,
    revision: run.revision,
    base,
    segments: segments as Extract<
      RemixTimeline,
      { available: true }
    >["segments"],
    narrationGain: narration?.gain ?? null,
    musicGain: music?.gain ?? null,
    duckUnderNarration: music?.duckUnderNarration ?? false,
    subtitles: parameters.subtitles ?? null,
  };
  return {
    run,
    view,
    scope,
    inputs,
    binding,
    parameters,
    slots,
    narration,
    music,
    output: rowToArtifactRevision(output),
  };
}

export function readTimeline(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  ownerId: string,
  runId: string,
  revisionId: string,
): RemixTimeline {
  try {
    return (
      frozenEdit(db, blobs, ownerId, runId, revisionId)?.view ?? {
        available: false,
      }
    );
  } catch (e) {
    if (
      e instanceof AgentError &&
      (e.code === "MEDIA_ARCHIVED" || e.code === "CAPABILITY_UNAVAILABLE")
    )
      return { available: false };
    throw e;
  }
}

export function remixIntent(
  frozen: NonNullable<ReturnType<typeof frozenEdit>>,
  input: RemixCommand,
): ToolRenderProject {
  const { view, parameters, inputs, binding, narration, music } = frozen;
  if (view.revision !== input.expectedRevision)
    throw new AgentError(
      "STALE_REVISION",
      "原制作状态已变化，请重新读取时间线。",
    );
  if (
    input.baseRevisionId !== view.base.revisionId ||
    input.segments.length !== view.segments.length ||
    new Set(input.segments.map((s) => s.id)).size !== view.segments.length
  )
    throw new AgentError("INVALID_INPUT", "请按新顺序提交每个原始镜头一次。");
  const segments = input.segments.map((cut) => {
    const i = view.segments.findIndex((s) => s.id === cut.id);
    if (i < 0) throw new AgentError("INVALID_INPUT", "剪点不属于这版时间线。");
    const was = view.segments[i]!,
      segment = parameters.segments[i]!;
    if (segment.kind === "image") {
      if (cut.startMs !== 0)
        throw new AgentError("INVALID_INPUT", "静帧从零开始计时。");
      return { ...segment, durationMs: cut.durationMs };
    }
    if (
      was.sourceDurationMs === null ||
      cut.startMs + cut.durationMs > was.sourceDurationMs
    )
      throw new AgentError("INVALID_INPUT", "入点和片长超出了原始视频。");
    return {
      ...segment,
      startMs: cut.startMs,
      durationMs: cut.durationMs,
      originalGain: input.originalGain ?? was.originalGain!,
    };
  }) as MixedConcatSegments;
  if (
    (input.narrationGain !== undefined && !narration) ||
    ((input.musicGain !== undefined || input.duckUnderNarration === true) &&
      !music)
  )
    throw new AgentError("INVALID_INPUT", "这版成片没有对应的独立音轨。");
  const duration = segments.reduce((sum, s) => sum + s.durationMs, 0);
  const playMs = music
    ? Math.min(music.playDurationMs, duration - music.timelineStartMs)
    : 0;
  if (music && playMs <= 0)
    throw new AgentError("INVALID_INPUT", "剪辑后音乐入点已超出画面。");
  const subtitles =
    input.subtitles === undefined ? parameters.subtitles : input.subtitles;
  const render: Extract<RenderParameters, { assembly: "mixed_concat" }> = {
    assembly: "mixed_concat",
    format: "mp4",
    width: parameters.width,
    height: parameters.height,
    fps: parameters.fps,
    ...(parameters.fitMode ? { fitMode: parameters.fitMode } : {}),
    segments,
    segmentIds: input.segments.map((s) => s.id) as [string, ...string[]],
    ...(narration
      ? {
          narration: {
            ...narration,
            gain: input.narrationGain ?? narration.gain,
          },
        }
      : {}),
    ...(music
      ? {
          music: {
            ...music,
            playDurationMs: playMs,
            gain: input.musicGain ?? music.gain,
            duckUnderNarration:
              input.duckUnderNarration ?? music.duckUnderNarration,
            fadeInMs: Math.min(music.fadeInMs, playMs),
            fadeOutMs: Math.min(
              music.fadeOutMs,
              playMs - Math.min(music.fadeInMs, playMs),
            ),
          },
        }
      : {}),
    ...(subtitles ? { subtitles } : {}),
  };
  const intent: ToolRenderProject = {
    workId: frozen.run.work_id,
    title: frozen.run.title,
    scope: "基于已冻结的片段和音轨微调",
    purpose: "draft",
    inputSources: inputs.filter((ref) => ref.kind === "artifact_revision"),
    reviewInputs: binding.reviewInputs,
    operations: [
      {
        operationId: "remix",
        outputSlot: "video",
        inputs,
        parameters: render,
        baseRevisionId: view.base.revisionId,
        target: {
          group: { mode: "existing", groupId: binding.groupId },
          item: { mode: "existing", itemId: binding.itemId },
        },
      },
    ],
  };
  validateSubtitleCommand("ToolRenderProject", intent);
  return intent;
}
