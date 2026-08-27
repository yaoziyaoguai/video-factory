import path from "node:path";
import { realpathSync } from "node:fs";
import { StudioInputError } from "../shared/api.js";

const MAX_OUTPUT_BYTES = 1_000_000;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function validateNodeOverrideOutput(options: {
  output: unknown;
  reference: unknown;
  nodeId: string;
  runRoot: string;
  allowPathChanges?: boolean;
}): void {
  if (!isRecord(options.reference)) {
    throw new StudioInputError(`节点“${options.nodeId}”尚无可编辑的结构化交付。`);
  }
  if (!isRecord(options.output)) {
    throw new StudioInputError("节点交付必须是 JSON 对象，不能是文字、数组或空值。");
  }
  const serialized = JSON.stringify(options.output);
  if (serialized.length > MAX_OUTPUT_BYTES) {
    throw new StudioInputError("节点交付超过 1 MB，请缩小内容后再保存。");
  }
  validateShape(options.output, options.reference, "output", options.runRoot, options.allowPathChanges === true);
}

function validateShape(
  value: unknown,
  reference: unknown,
  field: string,
  runRoot: string,
  allowPathChanges: boolean,
  fileReference = false,
): void {
  if (reference === null) {
    if (value !== null) throw typeError(field, "null");
    return;
  }
  if (Array.isArray(reference)) {
    if (!Array.isArray(value)) throw typeError(field, "数组");
    if (reference.length > 0) {
      value.forEach((item, index) => {
        // 外部工具的数组可能包含不同结构，例如 ffprobe 的视频流与音频流。
        // 已有条目按相同位置校验；新增条目沿用首项结构，保留脚本场景等同构数组的扩展能力。
        validateShape(item, reference[index] ?? reference[0], `${field}[${index}]`, runRoot, allowPathChanges);
      });
    }
    return;
  }
  if (isRecord(reference)) {
    if (!isRecord(value)) throw typeError(field, "对象");
    for (const key of Object.keys(value)) {
      if (BLOCKED_KEYS.has(key)) throw new StudioInputError(`${field}.${key} 不是允许的字段。`);
      if (!(key in reference)) throw new StudioInputError(`${field}.${key} 不是当前交付支持的字段。`);
    }
    for (const [key, referenceValue] of Object.entries(reference)) {
      if (!(key in value)) throw new StudioInputError(`${field}.${key} 是必填字段。`);
      validateShape(
        value[key],
        referenceValue,
        `${field}.${key}`,
        runRoot,
        allowPathChanges,
        isFileReferenceKey(key),
      );
    }
    return;
  }
  if (typeof value !== typeof reference) throw typeError(field, primitiveLabel(reference));
  if (typeof value === "number" && !Number.isFinite(value)) throw new StudioInputError(`${field} 必须是有限数字。`);
  if (typeof value === "string" && fileReference) {
    validateRunPath(value, field, runRoot);
    if (!allowPathChanges && value !== reference) {
      throw new StudioInputError(`${field} 是文件引用，不能在 JSON 编辑器中改指；请使用对应的素材替换能力。`);
    }
  }
}

function validateRunPath(value: string, field: string, runRoot: string): void {
  if (!path.isAbsolute(value)) throw new StudioInputError(`${field} 必须使用当前制作中的绝对文件路径。`);
  let resolvedRoot: string;
  let resolvedValue: string;
  try {
    resolvedRoot = realpathSync(runRoot);
    resolvedValue = realpathSync(value);
  } catch {
    throw new StudioInputError(`${field} 指向的当前制作文件不存在。`);
  }
  const relative = path.relative(resolvedRoot, resolvedValue);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StudioInputError(`${field} 必须指向当前制作目录中的文件。`);
  }
}

function isFileReferenceKey(key: string): boolean {
  return key === "uri"
    || key.endsWith("Path")
    || key.endsWith("Root")
    || key.endsWith("_path")
    || key.endsWith("_root")
    || key.endsWith("_file");
}

function primitiveLabel(value: unknown): string {
  if (typeof value === "string") return "文字";
  if (typeof value === "number") return "数字";
  if (typeof value === "boolean") return "布尔值";
  return typeof value;
}

function typeError(field: string, expected: string): StudioInputError {
  return new StudioInputError(`${field} 的结构不正确，应为${expected}。`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
