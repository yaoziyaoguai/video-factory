import type {
  RenderParameters,
  SpeechBoundary,
  SubtitleCue,
  SubtitleCues,
  SubtitleStyle,
} from "../../shared/agent/generated/contracts.js";
import { AgentError } from "./errors.js";

export type CutParameters = Extract<
  RenderParameters,
  { assembly: "timed_narrated_concat" | "mixed_concat" }
>;
export interface SpeechTiming {
  words: SpeechBoundary[];
  starts: number[];
  ends: number[];
}
const tokenChars = /[\p{L}\p{N}]/u;
const key = (text: string) =>
  Array.from(text.normalize("NFKC").toLowerCase())
    .filter((char) => tokenChars.test(char))
    .join("");

export function validateCues(
  cues: SubtitleCue[],
  duration: number,
): asserts cues is SubtitleCues {
  if (!cues.length)
    throw new AgentError("INVALID_INPUT", "音轨中没有可用的字幕。");
  const ids = new Set<string>();
  let end = 0;
  for (const cue of cues) {
    if (
      !cue.text.trim() ||
      ids.has(cue.id) ||
      cue.startMs < end ||
      cue.endMs <= cue.startMs ||
      cue.endMs > duration
    )
      throw new AgentError(
        "INVALID_INPUT",
        "字幕须有内容、编号唯一、按时间排列，且在源音轨时长内。",
      );
    ids.add(cue.id);
    end = cue.endMs;
  }
}

// 保留配音原稿中的标点、空格和大小写，时间只取服务返回的边界。
function originalWords(words: SpeechBoundary[], script: string): string[] {
  const chars = Array.from(script);
  const positions: number[] = [];
  let normalized = "";
  chars.forEach((c, i) => {
    const part = key(c);
    normalized += part;
    for (let n = 0; n < part.length; n++) positions.push(i);
  });
  // 用可逐字定位的词作锚点。数字、缩写被语音服务口语化时，中间仍取用户原稿。
  const starts = new Map<number, number>([
    [0, 0],
    [words.length, chars.length],
  ]);
  let cursor = 0;
  for (const [i, word] of words.entries()) {
    const token = key(word.text),
      found = token ? normalized.indexOf(token, cursor) : -1;
    if (found < 0) continue;
    if (i > 0) starts.set(i, positions[found]!);
    cursor = found + token.length;
    if (i + 1 < words.length && !starts.has(i + 1))
      starts.set(i + 1, positions[cursor] ?? chars.length);
  }
  const aligned = Array<string>(words.length).fill("");
  const anchors = [...starts.entries()].sort(([a], [b]) => a - b);
  for (let i = 0; i < anchors.length - 1; i++) {
    const [word, from] = anchors[i]!,
      to = anchors[i + 1]![1];
    aligned[word] = chars.slice(from, to).join("");
  }
  return aligned;
}

export function speechCues(
  timing: SpeechTiming,
  duration: number,
  script?: string,
): SubtitleCues {
  const words = timing.words.filter(
    (w) => w.durationMs > 0 && w.offsetMs < duration,
  );
  const labels =
    script === undefined
      ? words.map((w) => w.text)
      : originalWords(words, script);
  const cues: SubtitleCue[] = [];
  let from = 0,
    label = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!,
      next = words[i + 1];
    const piece = labels[i]!;
    if (
      label &&
      /[\p{Script=Latin}\d]$/u.test(label) &&
      /^[\p{Script=Latin}\d]/u.test(piece)
    )
      label += " ";
    label += piece;
    const end = Math.min(duration, word.offsetMs + word.durationMs);
    if (
      next &&
      next.offsetMs - end < 420 &&
      (!/[。！？.!?][”’"']?\s*$/u.test(piece) ||
        /^(Mr|Ms|Mrs|Dr)\.$/i.test(piece.trim())) &&
      label.length < 66 &&
      end - words[from]!.offsetMs < 5200
    )
      continue;
    const first = words[from]!.offsetMs;
    const nearest = (value: number, edges: number[], other: number) => {
      const matches = edges.filter(
        (e) =>
          Math.abs(e - value) <= 380 &&
          (value <= other ? e < other : e > other),
      );
      return matches.reduce(
        (best, e) => (Math.abs(e - value) < Math.abs(best - value) ? e : best),
        matches[0] ?? value,
      );
    };
    const onset =
      from === 0 &&
      first === 0 &&
      timing.starts[0] !== undefined &&
      timing.starts[0] < end
        ? timing.starts[0]
        : nearest(first, timing.starts, end);
    const start = Math.max(cues.at(-1)?.endMs ?? 0, onset);
    const finish = Math.min(
      duration,
      nearest(end, timing.ends, start),
      next?.offsetMs ?? duration,
    );
    if (finish > start && label.trim())
      cues.push({
        id: `cue-${cues.length + 1}`,
        startMs: start,
        endMs: finish,
        text: label.trim(),
      });
    label = "";
    from = i + 1;
  }
  validateCues(cues, duration);
  return cues;
}

export function projectCues(
  cues: SubtitleCue[],
  sourceBlob: string,
  parameters: Pick<CutParameters, "segments" | "assembly"> & {
    narrationInputSlot?: number;
    narration?: { inputSlot: number; timelineStartMs: number };
  },
  slots: ReadonlyMap<number, string>,
): SubtitleCue[] {
  const narrator =
    parameters.assembly === "timed_narrated_concat"
      ? { inputSlot: parameters.narrationInputSlot!, timelineStartMs: 0 }
      : parameters.narration;
  if (narrator && slots.get(narrator.inputSlot) === sourceBlob)
    return cues.map((c) => ({
      ...c,
      startMs: c.startMs + narrator.timelineStartMs,
      endMs: c.endMs + narrator.timelineStartMs,
    }));
  let offset = 0,
    used = false;
  const projected: SubtitleCue[] = [];
  for (const [i, segment] of parameters.segments.entries()) {
    if (
      segment.kind === "video" &&
      slots.get(segment.inputSlot) === sourceBlob
    ) {
      used = true;
      for (const cue of cues) {
        const start = Math.max(cue.startMs, segment.startMs),
          end = Math.min(cue.endMs, segment.startMs + segment.durationMs);
        if (end > start)
          projected.push({
            ...cue,
            id: `s${i}-${cue.id}`,
            startMs: offset + start - segment.startMs,
            endMs: offset + end - segment.startMs,
          });
      }
    }
    offset += segment.durationMs;
  }
  if (!used)
    throw new AgentError(
      "INVALID_INPUT",
      "字幕音源不在这版剪辑的旁白或原声片段中。",
    );
  return projected;
}

function timestamp(ms: number, sep: string) {
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}

export function subtitleText(
  cues: SubtitleCue[],
  format: "srt" | "vtt",
): string {
  const vtt = format === "vtt",
    sep = vtt ? "." : ",";
  const text = (s: string) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replace(/\r\n?/g, "\n")
      .replace(/\n{2,}/g, "\n");
  return (
    (vtt ? "WEBVTT\n\n" : "") +
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${timestamp(c.startMs, sep)} --> ${timestamp(c.endMs, sep)}\n${text(c.speaker ? c.speaker + "：" + c.text : c.text)}\n`,
      )
      .join("\n")
  );
}

function wrapAss(text: string, columns: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = "",
      width = 0;
    for (const { segment } of new Intl.Segmenter("zh", {
      granularity: "grapheme",
    }).segment(raw)) {
      const units = /^[\x00-\x7F]$/.test(segment) ? 0.63 : 1.04;
      if (width + units > columns && line) {
        lines.push(line.trimEnd());
        line = "";
        width = 0;
      }
      line += segment;
      width += units;
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

export function subtitleAss(
  cues: SubtitleCue[],
  style: SubtitleStyle,
  width: number,
  height: number,
): string {
  const size = Math.round(
    Math.min(width, height) * (style === "social_pop_center" ? 0.064 : 0.052),
  );
  const margin = Math.round(width * 0.075),
    vertical = Math.round(height * 0.07);
  const mid = style === "social_pop_center",
    cinema = style === "cinema_bilingual";
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Frame,Noto Sans CJK SC,${size},${mid ? "&H005AEBFF" : "&H00FFFFFF"},&H00FFFFFF,&H00101010,&H80000000,${mid ? -1 : 0},0,0,0,100,100,0,0,1,${cinema ? 2 : 3},1,${mid ? 5 : 2},${margin},${margin},${vertical},1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;
  const stamp = (n: number) => timestamp(n, ".").slice(1, -1);
  return (
    header +
    cues
      .map((c) => {
        const lines = wrapAss(
          c.speaker ? c.speaker + "：" + c.text : c.text,
          (width - 2 * margin) / size,
        );
        const resize = Math.min(
          size,
          Math.floor(
            (height - 2 * vertical) / (1.65 * Math.max(1, lines.length)),
          ),
        );
        // 全角括号隔离 ASS 覆盖指令；反斜线与下一字符分隔以保留原文显示。
        const escaped = lines
          .map((s) =>
            s
              .replaceAll("\\", "\\\u2060")
              .replaceAll("{", "\\{")
              .replaceAll("}", "\\}"),
          )
          .join("\\N");
        return `Dialogue: 0,${stamp(c.startMs)},${stamp(c.endMs)},Frame,,0,0,0,,${resize < size ? "{\\fs" + resize + "}" : ""}${escaped}`;
      })
      .join("\n") +
    "\n"
  );
}
