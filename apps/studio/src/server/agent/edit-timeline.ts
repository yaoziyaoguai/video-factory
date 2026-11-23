import type { MediaContent } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import {
  archiveBlob,
  attribution,
  zipStream,
  type ArchiveEntry,
} from "./export-bundle.js";
import { blobSources } from "./material-store.js";
import {
  probeAudioOutputFile,
  probeImageFile,
  probeVideoFile,
} from "./media-probe.js";
import type { ProductionBlobs, BlobRow } from "./production-blobs.js";
import { operationsFor, runRow, snapshotFor } from "./production-store.js";
import { codeProjectInputPath } from "./creative-runner.js";
import { digestOf } from "./util.js";

interface Asset {
  id: string;
  name: string;
  path: string;
  disk: string;
  duration: number | null;
  width: number;
  height: number;
  audio: boolean;
  kind: "video" | "audio" | "image";
  blobId: string;
  rate: number | null;
}
interface Cut {
  asset: Asset;
  at: number;
  start: number;
  length: number;
  gain: number;
  fadeIn?: number;
  fadeOut?: number;
  duck?: boolean;
  fit?: string;
  motion?: string;
}
interface Timeline {
  name: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
  visual: Cut[];
  voice: Cut[];
  music: Cut[];
  assets: Asset[];
}

async function timeline(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  owner: string,
  runId: string,
  revisionId?: string,
): Promise<Timeline> {
  const run = runRow(db, runId);
  if (run.owner_id !== owner)
    throw new AgentError("NOT_FOUND", "没有找到这次制作。");
  const spec = snapshotFor(db, run).spec,
    rows = operationsFor(db, run.id);
  const row = revisionId
    ? rows.find((r) => r.output_revision_id === revisionId)
    : rows.find((r) => r.id === spec.finalOutput.operationId);
  if (!row?.output_blob_id || row.state !== "succeeded")
    throw new AgentError("NOT_FOUND", "没有找到可导出的成片修订。");
  const base = blobs.get(owner, row.output_blob_id);
  if (!base.mime_type.startsWith("video/"))
    throw new AgentError("INVALID_INPUT", "请选择视频成片。");
  const final = await probeVideoFile(blobs.filePath(base.digest));
  const op = spec.operations.find((o) => o.operationId === row.id)!;
  const all = new Map<string, Asset>(),
    slots: Asset[] = [];
  async function asset(blob: BlobRow, name: string) {
    const existing = all.get(blob.id);
    if (existing) return existing;
    blobs.verify(blob);
    const disk = blobs.filePath(blob.digest);
    const kind = blob.mime_type.startsWith("video/")
      ? "video"
      : blob.mime_type.startsWith("audio/")
        ? "audio"
        : "image";
    const facts =
      kind === "video"
        ? await probeVideoFile(disk)
        : kind === "image"
          ? await probeImageFile(disk)
          : null;
    const suffix = codeProjectInputPath(
      0,
      blob.mime_type as MediaContent["mimeType"],
    )
      .split(".")
      .at(-1)!;
    const result: Asset = {
      id: "m" + (all.size + 1),
      name,
      path: "media/" + blob.digest + "." + suffix,
      disk,
      kind,
      rate:
        facts && "nominalFrameRate" in facts
          ? (facts.nominalFrameRate ?? facts.frameRate)
          : null,
      width: facts?.width ?? 0,
      height: facts?.height ?? 0,
      duration:
        kind === "video" && facts && "videoDurationMs" in facts
          ? facts.videoDurationMs
          : kind === "audio"
            ? (await probeAudioOutputFile(disk)).durationMs
            : blob.duration_ms,
      audio:
        kind === "audio" || !!(facts && "hasAudio" in facts && facts.hasAudio),
      blobId: blob.id,
    };
    all.set(blob.id, result);
    return result;
  }
  const pars = op.kind === "render" ? op.parameters : undefined;
  const visual: Cut[] = [],
    voice: Cut[] = [],
    music: Cut[] = [];
  let at = 0;
  function picture(
    a: Asset,
    start: number,
    length: number,
    gain: number,
    fit?: string,
    motion?: string,
  ) {
    visual.push({
      asset: a,
      at,
      start,
      length,
      gain,
      ...(fit ? { fit } : {}),
      ...(motion ? { motion } : {}),
    });
    at += length;
  }
  if (!pars || pars.assembly === "code_project")
    picture(await asset(base, run.title), 0, final.durationMs, 1);
  else {
    for (const [i, ref] of op.inputs.entries()) {
      const blob = archiveBlob(
        db,
        blobs,
        owner,
        run.conversation_id,
        ref,
        runId,
      );
      const name =
        ref.kind === "artifact_revision"
          ? (db
              .prepare("SELECT title FROM artifacts WHERE id=? AND owner_id=?")
              .pluck()
              .get(ref.artifactId, owner) as string)
          : "素材 " + (i + 1);
      slots.push(await asset(blob, name));
    }
    if (pars.assembly === "ordered_concat")
      for (const [i, a] of slots.entries())
        picture(
          a,
          0,
          a.duration!,
          pars.audioMode === "preserve" ? 1 : 0,
          pars.visualStyles?.find((style) => style.inputSlot === i)?.fitMode ??
            pars.fitMode,
        );
    else if (pars.assembly === "narrated_concat")
      for (const slot of pars.videoInputSlots) {
        const a = slots[slot]!;
        picture(
          a,
          0,
          a.duration!,
          0,
          pars.visualStyles?.find((style) => style.inputSlot === slot)
            ?.fitMode ?? pars.fitMode,
        );
      }
    else
      for (const s of pars.segments)
        picture(
          slots[s.inputSlot]!,
          s.kind === "video" ? s.startMs : 0,
          s.durationMs,
          pars.assembly === "mixed_concat" && s.kind === "video"
            ? "originalGain" in s
              ? (s.originalGain ?? 1)
              : 1
            : 0,
          s.fitMode ?? pars.fitMode,
          s.kind === "image" ? s.kenBurns : undefined,
        );
    if (
      pars.assembly === "narrated_concat" &&
      frame(final.videoDurationMs - at, pars.fps) > 0
    ) {
      // 最后一帧停留来自已经冻结的成片，源镜头不必虚构额外的可播放时段。
      picture(
        await asset(base, "旁白尾帧停留"),
        at,
        final.videoDurationMs - at,
        0,
      );
    }
    const narrator =
      pars.assembly === "mixed_concat"
        ? pars.narration
        : "narrationInputSlot" in pars
          ? { inputSlot: pars.narrationInputSlot, timelineStartMs: 0, gain: 1 }
          : undefined;
    if (narrator) {
      const a = slots[narrator.inputSlot]!;
      voice.push({
        asset: a,
        at: narrator.timelineStartMs,
        start: 0,
        length: Math.min(
          a.duration!,
          final.durationMs - narrator.timelineStartMs,
        ),
        gain: narrator.gain,
      });
    }
    if (pars.assembly === "mixed_concat" && pars.music) {
      const m = pars.music,
        a = slots[m.inputSlot]!;
      for (let done = 0; done < m.playDurationMs;) {
        const len = Math.min(m.sourceDurationMs, m.playDurationMs - done);
        music.push({
          asset: a,
          at: m.timelineStartMs + done,
          start: m.sourceStartMs,
          length: len,
          gain: m.gain,
          fadeIn: done === 0 ? m.fadeInMs : 0,
          fadeOut: done + len === m.playDurationMs ? m.fadeOutMs : 0,
          duck: m.duckUnderNarration,
        });
        done += len;
        if (!m.repeat) break;
      }
    }
  }
  const rate =
    pars && pars.assembly !== "code_project"
      ? pars.fps
      : (final.nominalFrameRate ?? final.frameRate);
  if (rate === null || rate <= 0)
    throw new AgentError("INVALID_INPUT", "成片的帧率不可读取。");
  const fps = rate;
  return {
    name: run.title,
    fps,
    width: final.width,
    height: final.height,
    duration: final.durationMs,
    visual,
    voice,
    music,
    assets: [...all.values()],
  };
}

const escapeXml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;");
const frame = (ms: number, fps: number) => Math.round((ms * fps) / 1000);
function frameFraction(rate: number): [number, number] {
  if (Number.isInteger(rate)) return [1, rate];
  for (const base of [24, 30, 48, 60, 120])
    if (Math.abs(rate - (base * 1000) / 1001) < 0.001)
      return [1001, base * 1000];
  return [1_000_000, Math.round(rate * 1_000_000)];
}
function fcpxml(t: Timeline) {
  const [num, den] = frameFraction(t.fps),
    time = (f: number) => (f === 0 ? "0s" : f * num + "/" + den + "s");
  const sequenceFrames = frame(t.duration, t.fps);
  const startFrame = (c: Cut) => frame(c.at, t.fps);
  const endFrame = (c: Cut) => frame(c.at + c.length, t.fps);
  const fmt = `<format id="f0" frameDuration="${time(1)}" width="${t.width}" height="${t.height}" colorSpace="1-1-1 (Rec. 709)"/>`;
  const sourceFormats = t.assets
    .filter((a) => a.kind !== "audio")
    .map(
      (a) =>
        `<format id="f${a.id}" frameDuration="${frameFraction(a.rate ?? t.fps).join("/")}s" width="${a.width}" height="${a.height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    )
    .join("");
  const assets = t.assets
    .map((a) => {
      let duration = "3600s";
      if (a.duration !== null) {
        const rate = a.rate ?? t.fps;
        const [numerator, denominator] = frameFraction(rate);
        duration = a.kind === "audio" ? a.duration + "/1000s"
          : Math.max(1, frame(a.duration, rate)) * numerator + "/" + denominator + "s";
      }
      return `<asset id="${a.id}" name="${escapeXml(a.name)}" start="0s" duration="${duration}" hasVideo="${a.kind === "audio" ? 0 : 1}" hasAudio="${a.audio ? 1 : 0}"${a.kind === "audio" ? "" : ' format="f' + a.id + '"'}><media-rep kind="original-media" src="${a.path}"/></asset>`;
    })
    .join("");
  function clip(c: Cut, lane: number, anchor = 0, children = "") {
    const length = (lane ? Math.min(sequenceFrames, endFrame(c)) : endFrame(c)) - startFrame(c);
    if (length <= 0) return "";
    const db = c.gain > 0 ? (20 * Math.log10(c.gain)).toFixed(3) : "-96";
    const fades = [
      ["fadeIn", c.fadeIn],
      ["fadeOut", c.fadeOut],
    ]
      .map(([tag, ms]) =>
        typeof ms === "number" && ms > 0
          ? `<${tag} type="linear" duration="${ms}/1000s"/>`
          : "",
      )
      .join("");
    const vol =
      c.asset.audio && (c.gain !== 1 || fades)
        ? `<adjust-volume amount="${db}dB">${fades ? `<param name="amount" value="${db}dB">${fades}</param>` : ""}</adjust-volume>`
        : "";
    const conform =
      c.asset.kind !== "audio" && c.fit
        ? `<adjust-conform type="${c.fit === "cover_crop" ? "fill" : "fit"}"/>`
        : "";
    return `<asset-clip ref="${c.asset.id}" name="${escapeXml(c.asset.name)}" offset="${time(frame(c.at, t.fps) + anchor)}" start="${time(frame(c.start, t.fps))}" duration="${time(length)}"${lane ? ' lane="' + lane + '"' : ""}${c.asset.kind === "audio" ? ' srcEnable="audio"' : c.gain === 0 ? ' srcEnable="video"' : ""}>${conform}${vol}${children}</asset-clip>`;
  }
  const anchoredAudio = (begin: number, end: number, anchor: number) =>
    [t.voice, t.music].map((tracks, index) => tracks
      .filter(track => startFrame(track) >= begin && startFrame(track) < end)
      .map(track => clip(track, -1 - index, anchor)).join("")).join("");
  let pictureEnd = 0;
  const items = t.visual.map(c => {
    const begin = startFrame(c), end = endFrame(c);
    pictureEnd = end;
    return clip(c, 0, 0, anchoredAudio(begin, end, frame(c.start, t.fps) - begin));
  }).join("");
  // 相连音频的起点要在其锚点范围内。尾部还有成片时长时，用实际序列空段承接。
  const tail = pictureEnd < sequenceFrames
    ? `<gap name="片尾" offset="${time(pictureEnd)}" start="0s" duration="${time(sequenceFrames - pictureEnd)}">${anchoredAudio(pictureEnd, sequenceFrames, -pictureEnd)}</gap>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>${fmt}${sourceFormats}${assets}</resources><library><event name="Frame"><project name="${escapeXml(t.name)}"><sequence format="f0" duration="${time(sequenceFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${items}${tail}</spine></sequence></project></event></library></fcpxml>`;
}
function otio(t: Timeline) {
  const rt = (n: number) => ({
    OTIO_SCHEMA: "RationalTime.1",
    rate: t.fps,
    value: n,
  });
  const range = (start: number, len: number) => ({
    OTIO_SCHEMA: "TimeRange.1",
    start_time: rt(start),
    duration: rt(len),
  });
  function track(name: string, kind: string, cuts: Cut[]) {
    const children: object[] = [];
    let before = 0;
    for (const c of cuts) {
      const begin = frame(c.at, t.fps),
        end = frame(c.at + c.length, t.fps);
      if (end <= begin) continue;
      if (begin > before)
        children.push({
          OTIO_SCHEMA: "Gap.1",
          name: "",
          metadata: {},
          source_range: range(0, begin - before),
          effects: [],
          markers: [],
        });
      const a = c.asset;
      children.push({
        OTIO_SCHEMA: "Clip.2",
        name: a.name,
        metadata: {
          Frame: {
            gain: c.gain,
            fit: c.fit,
            motion: c.motion,
            duckUnderNarration: c.duck,
            fadeInMs: c.fadeIn,
            fadeOutMs: c.fadeOut,
          },
        },
        source_range: range(frame(c.start, t.fps), end - begin),
        effects: [],
        markers: [],
        active_media_reference_key: "DEFAULT_MEDIA",
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: "ExternalReference.1",
            name: a.name,
            target_url: a.path,
            metadata: {},
            available_range:
              a.duration === null ? null : range(0, frame(a.duration, t.fps)),
          },
        },
      });
      before = end;
    }
    return {
      OTIO_SCHEMA: "Track.1",
      name,
      kind,
      metadata: {},
      source_range: null,
      effects: [],
      markers: [],
      children,
    };
  }
  return JSON.stringify(
    {
      OTIO_SCHEMA: "Timeline.1",
      name: t.name,
      metadata: {},
      global_start_time: rt(0),
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        name: "tracks",
        metadata: {},
        source_range: null,
        markers: [],
        effects: [],
        children: [
          track("画面", "Video", t.visual),
          ...(t.voice.length ? [track("旁白", "Audio", t.voice)] : []),
          ...(t.music.length ? [track("音乐", "Audio", t.music)] : []),
        ],
      },
    },
    null,
    2,
  );
}
function jianying(t: Timeline) {
  const id = (parts: unknown) => {
    const s = digestOf(parts);
    return [
      s.slice(0, 8),
      s.slice(8, 12),
      s.slice(12, 16),
      s.slice(16, 20),
      s.slice(20, 32),
    ]
      .join("-")
      .toUpperCase();
  };
  const material = (a: Asset) => ({
    id: id(a.blobId),
    type:
      a.kind === "audio"
        ? "extract_music"
        : a.kind === "image"
          ? "photo"
          : "video",
    path: a.path,
    material_name: a.name,
    name: a.name,
    duration: (a.duration ?? t.duration) * 1000,
    width: a.width,
    height: a.height,
    has_audio: a.audio,
    local_material_id: "",
    category_name: "local",
    source_platform: 0,
  });
  const fades = t.music
    .filter((c) => c.fadeIn || c.fadeOut)
    .map((c) => ({
      id: id(["fade", c.at]),
      type: "audio_fade",
      fade_type: 0,
      fade_in_duration: (c.fadeIn ?? 0) * 1000,
      fade_out_duration: (c.fadeOut ?? 0) * 1000,
    }));
  function track(
    name: string,
    type: "audio" | "video",
    cuts: Cut[],
    order: number,
  ) {
    return {
      id: id([name, order]),
      name,
      type,
      flag: 0,
      attribute: 0,
      is_default_name: false,
      segments: cuts.map((c, i) => ({
        id: id([order, i, c.asset.id]),
        material_id: id(c.asset.blobId),
        target_timerange: { start: c.at * 1000, duration: c.length * 1000 },
        source_timerange: { start: c.start * 1000, duration: c.length * 1000 },
        speed: 1,
        volume: c.gain,
        visible: true,
        reverse: false,
        render_index: order * 10000,
        track_render_index: order,
        extra_material_refs: c.fadeIn || c.fadeOut ? [id(["fade", c.at])] : [],
        common_keyframes: [],
        keyframe_refs: [],
        clip: {
          alpha: 1,
          flip: { horizontal: false, vertical: false },
          rotation: 0,
          scale: { x: 1, y: 1 },
          transform: { x: 0, y: 0 },
        },
        enable_video_mask: true,
      })),
    };
  }
  const projectId = id([
      t.name,
      t.visual.map((c) => [c.asset.id, c.start, c.at]),
    ]),
    platform = {
      app_id: 3704,
      app_source: "lv",
      app_version: "5.9.0",
      os: "windows",
    };
  const draft = {
    id: projectId,
    name: t.name,
    version: 360000,
    new_version: "110.0.0",
    platform,
    last_modified_platform: platform,
    duration: t.duration * 1000,
    fps: t.fps,
    canvas_config: { width: t.width, height: t.height, ratio: "original" },
    materials: {
      videos: t.assets.filter((a) => a.kind !== "audio").map(material),
      audios: t.assets.filter((a) => a.kind === "audio").map(material),
      speeds: [],
      audio_fades: fades,
      canvases: [],
      texts: [],
      effects: [],
      transitions: [],
    },
    tracks: [
      track("画面", "video", t.visual, 0),
      ...(t.voice.length ? [track("旁白", "audio", t.voice, 1)] : []),
      ...(t.music.length ? [track("音乐", "audio", t.music, 2)] : []),
    ],
    keyframes: {
      videos: [],
      audios: [],
      texts: [],
      adjusts: [],
      effects: [],
      filters: [],
      handwrites: [],
      stickers: [],
    },
    config: {},
    color_space: 0,
  };
  return [
    { name: "draft_content.json", text: JSON.stringify(draft) },
    {
      name: "draft_meta_info.json",
      text: JSON.stringify({
        draft_id: projectId,
        draft_name: t.name,
        draft_fold_path: ".",
        draft_root_path: ".",
        tm_duration: t.duration * 1000,
        draft_materials: [],
      }),
    },
  ];
}

export async function exportTimeline(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  owner: string,
  runId: string,
  format: string,
  revisionId?: string,
) {
  if (!["fcpxml", "otio", "jianying"].includes(format))
    throw new AgentError("INVALID_INPUT", "请选择 FCPXML、OTIO 或剪映草稿。");
  const t = await timeline(db, blobs, owner, runId, revisionId),
    prefix = format === "fcpxml" ? "Frame.fcpxmld/" : "";
  // 不同用户素材条目可能指向同一原件；编辑资源保留各自名称，原字节只打包一次。
  const mediaFiles = new Map(t.assets.map((a) => [a.path, a.disk]));
  const entries: ArchiveEntry[] = Array.from(mediaFiles, ([name, file]) => ({
    name: prefix + name,
    file,
  }));
  if (format === "fcpxml")
    entries.push({ name: prefix + "Info.fcpxml", text: fcpxml(t) });
  else if (format === "otio")
    entries.push({ name: "Frame.otio", text: otio(t) });
  else entries.push(...jianying(t));
  const cutInfo = ({ asset, ...timing }: Cut) => ({
    media: asset.path,
    ...timing,
  });
  entries.push({
    name: prefix + "Frame-timeline.json",
    text: JSON.stringify(
      {
        fps: t.fps,
        width: t.width,
        height: t.height,
        durationMs: t.duration,
        visual: t.visual.map(cutInfo),
        narration: t.voice.map(cutInfo),
        music: t.music.map(cutInfo),
      },
      null,
      2,
    ),
  });
  entries.push({
    name: "ATTRIBUTION.txt",
    text: attribution(t.assets.map((a) => blobSources(db, a.blobId))),
  });
  return zipStream(entries);
}
