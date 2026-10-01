// narration-text-v1 纯函数子模块（浏览器安全）：不引入任何 Node 内置模块。
// 供客户端（分段编辑器/时间编辑器）与 narration-plan.ts 共用同一实现，不允许两端各写一份。
import { NARRATION_TEXT_TRIM_CODEPOINTS, isNarrationWordCodePoint } from "./narration-text-rules.js";

export class NarrationTextV2Error extends Error {}

export const TRIM_CODEPOINT_SET_V2 = new Set(NARRATION_TEXT_TRIM_CODEPOINTS);

export function rejectSurrogate(text: string): void {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new NarrationTextV2Error("narration-text-v1 拒绝孤立代理码点（surrogate）。");
    }
  }
}

export function trimV2(text: string): string {
  rejectSurrogate(text);
  // 在码点序列上求边界，避免 UTF-16 索引与码点索引混用截断补充平面字符。
  const units = Array.from(text);
  let start = 0;
  let end = units.length;
  while (start < end && TRIM_CODEPOINT_SET_V2.has(units[start]!.codePointAt(0)!)) start += 1;
  while (end > start && TRIM_CODEPOINT_SET_V2.has(units[end - 1]!.codePointAt(0)!)) end -= 1;
  return units.slice(start, end).join("");
}

export function isWordyV2(text: string): boolean {
  return Array.from(text).some((character) => isNarrationWordCodePoint(character.codePointAt(0)!));
}

/** 规范 JSON：键 ASCII 排序、数组保序、无多余空白；拒绝非安全数值/浮点/孤立代理。 */
export function canonicalJsonV2(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item)) throw new NarrationTextV2Error("narration-text-v1 仅接受安全整数。");
      return item;
    }
    if (typeof item === "string") { rejectSurrogate(item); return item; }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      const keys = Object.keys(item as Record<string, unknown>);
      // 键限定 ASCII：JS 按 UTF-16 排序、Python 按码点排序，非 ASCII 键可能两端不同序。
      for (const key of keys) {
        if (!/^[ -~]+$/.test(key)) {
          throw new NarrationTextV2Error("canonical JSON 对象键必须是 ASCII，保证两端字节一致。");
        }
      }
      return Object.fromEntries(keys.sort()
        .map((key) => [key, walk((item as Record<string, unknown>)[key])]));
    }
    throw new NarrationTextV2Error("narration-text-v1 仅接受 JSON 类型。");
  };
  return JSON.stringify(walk(value));
}

export function sentenceBoundaryCandidatesV2(canonicalText: string): number[] {
  const closers = "”’\"'」』）》】)]}";
  const ends = "。！？!?；;";
  const units = Array.from(canonicalText);
  const isTrimWhitespace = (unit: string | undefined) => !!unit && TRIM_CODEPOINT_SET_V2.has(unit.codePointAt(0)!);
  const isLeftAbsorbed = (unit: string | undefined) =>
    !!unit && (ends.includes(unit) || closers.includes(unit) || isTrimWhitespace(unit));
  const candidates: number[] = [];
  for (let index = 0; index < units.length; index += 1) {
    const character = units[index]!;
    const isEnd = ends.includes(character);
    const isDot = character === ".";
    if (!isEnd && !isDot) continue;
    if (isDot) {
      // ASCII 句点仅在后接规范空白、闭符号或末尾才候选，不能切 3.14。
      const next = units[index + 1];
      if (next !== undefined && !(isTrimWhitespace(next) || closers.includes(next))) continue;
    }
    // 连续句末标点、紧接闭符号与规范空白归左段，边界放在其后。
    let boundary = index + 1;
    while (boundary < units.length && isLeftAbsorbed(units[boundary])) boundary += 1;
    if (boundary > 0 && boundary < units.length) candidates.push(boundary);
  }
  return [...new Set(candidates)].sort((a, b) => a - b);
}

export function secondsToFramesV2(seconds: string): number {
  // 只接受十进制秒字符串；HTTP 计划帧数是整数帧语义，走独立校验，不经本函数透传。
  if (typeof seconds !== "string") {
    throw new NarrationTextV2Error("时间输入必须是非负十进制秒字符串；HTTP 帧数走独立整数校验，不经本函数。");
  }
  if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(seconds)) {
    throw new NarrationTextV2Error("时间输入必须是非负十进制秒（至多6位小数）。");
  }
  // 十进制有理数：字符串定点乘 30 后四舍五入（半帧向上），不经二进制浮点。
  const [integerPart = "0", fractionPart = ""] = seconds.split(".");
  const digits = (fractionPart + "000000").slice(0, 6);
  const scaled = BigInt(integerPart) * 30n * 1000000n
    + BigInt(digits) * 30n;
  const frames = (scaled + 500000n) / 1000000n;
  if (frames > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NarrationTextV2Error("转换结果超出安全整数范围。");
  }
  return Number(frames);
}
