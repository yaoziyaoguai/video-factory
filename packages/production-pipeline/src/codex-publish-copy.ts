import { CodexBridgeClient } from "./codex-chat.js";

export interface PublishCopy {
  title: string;
  description: string;
  hashtags: string[];
}

export interface PublishCopyInput {
  platform: string;
  brief: {
    title: string;
    angle: string;
    audience: string;
    nicheSlug: string;
  };
  narrations: string[];
}

// 接口层返回 unknown：pipeline 侧后续对接时须独立做 validatePublishCopy 硬校验。
export interface PublishCopyWriter {
  id: string;
  write(input: PublishCopyInput): Promise<unknown>;
}

export interface CodexPublishCopyWriterOptions {
  client?: CodexBridgeClient;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

// 330s > broker 285s 任务 deadline：broker 先终止 codex，客户端拿到带上下文的终态错误且不重放。
const DEFAULT_PUBLISH_COPY_TIMEOUT_MS = 330_000;
const DEFAULT_PUBLISH_COPY_MAX_ATTEMPTS = 2;

// id 固定为 codex-publish-copy-v1：发布包记录 copy.source 时按该 id 标注来源。
export class CodexPublishCopyWriter implements PublishCopyWriter {
  readonly id = "codex-publish-copy-v1";
  private readonly client: CodexBridgeClient;

  constructor(options: CodexPublishCopyWriterOptions) {
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.socketPath) {
        throw new Error("CodexPublishCopyWriter requires a CodexBridgeClient or a socketPath.");
      }
      this.client = new CodexBridgeClient({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs ?? DEFAULT_PUBLISH_COPY_TIMEOUT_MS,
        maxAttempts: options.maxAttempts ?? DEFAULT_PUBLISH_COPY_MAX_ATTEMPTS,
        ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
        ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      });
    }
  }

  // 模型输出为 unknown：先经 validatePublishCopy 硬校验，malformed/不合法直接抛错，没有任何 fallback。
  async write(input: PublishCopyInput): Promise<PublishCopy> {
    validatePublishCopyInput(input);
    const rawCopy = await this.client.runTask("publish-copy", {
      platform: input.platform,
      brief: input.brief,
      narrations: input.narrations,
    });
    return validatePublishCopy(rawCopy);
  }
}

export function validatePublishCopy(value: unknown): PublishCopy {
  const input = record(value, "Publish copy");
  const title = text(input.title, "Publish copy title");
  if (charCount(title) > 30) {
    throw new Error("Publish copy title must be 1 to 30 characters.");
  }
  const description = text(input.description, "Publish copy description");
  if (charCount(description) > 100) {
    throw new Error("Publish copy description must be 1 to 100 characters.");
  }
  if (!Array.isArray(input.hashtags) || input.hashtags.length < 1 || input.hashtags.length > 5) {
    throw new Error("Publish copy hashtags must be an array of 1 to 5 strings.");
  }
  const hashtags = input.hashtags.map((entry, index) => {
    const tag = text(entry, `Publish copy hashtags[${index}]`);
    if (charCount(tag) > 16) {
      throw new Error(`Publish copy hashtags[${index}] must be 1 to 16 characters.`);
    }
    if (tag.startsWith("#")) {
      throw new Error(`Publish copy hashtags[${index}] must not start with '#'.`);
    }
    if (/\s/.test(tag)) {
      throw new Error(`Publish copy hashtags[${index}] must not contain whitespace.`);
    }
    return tag;
  });
  const seen = new Set<string>();
  for (const tag of hashtags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      throw new Error("Publish copy hashtags must not contain duplicates (case-insensitive) after trimming.");
    }
    seen.add(key);
  }
  return { title, description, hashtags };
}

// 发送前对输入做门禁：越界输入零调用，不消耗模型额度。
function validatePublishCopyInput(input: PublishCopyInput): void {
  if (typeof input.platform !== "string" || !input.platform.trim()) {
    throw new Error("Publish copy platform must be a non-empty string.");
  }
  for (const key of ["title", "angle", "audience", "nicheSlug"] as const) {
    if (typeof input.brief[key] !== "string" || !input.brief[key].trim()) {
      throw new Error(`Publish copy brief.${key} must be a non-empty string.`);
    }
  }
  if (!Array.isArray(input.narrations)
    || input.narrations.length < 3
    || input.narrations.length > 10
    || input.narrations.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("Publish copy narrations must contain 3 to 10 non-empty entries.");
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

// 与 JSON Schema 的 maxLength 同口径：按 Unicode code point 计数。
function charCount(value: string): number {
  return [...value].length;
}
