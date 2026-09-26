import { CodexBridgeClient, type CodexTaskExecution, type RoleAudit } from "./codex-chat.js";
import { runRoleAgentLoop, validateRoleAudit, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export interface PublishCopy {
  title: string;
  description: string;
  hashtags: string[];
}

export const PUBLISH_COPY_AGENT_CONTRACT_VERSION = "publish-editor-v3|role-audit-v9|publish-copy-validator-v1|single-initial-audit-v1";

export interface PublishCopyInput {
  selectedModelId?: string;
  platform: string;
  brief: {
    title: string;
    angle: string;
    audience: string;
    nicheSlug: string;
  };
  narrations: string[];
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
}

// 接口层返回 unknown：pipeline 侧后续对接时须独立做 validatePublishCopy 硬校验。
export interface PublishCopyWriter {
  id: string;
  write(input: PublishCopyInput): Promise<unknown>;
  writeDetailed?(input: PublishCopyInput): Promise<CodexTaskExecution<unknown>>;
  /** 明确修订：只产一次所授权的修订，不调用本版独立审计。 */
  revise?(input: PublishCopyRevisionInput): Promise<PublishCopy>;
  /** 主动再审：只审当前精确稿一次，不产稿、不推进。 */
  auditCurrent?(input: PublishCopyAuditInput): Promise<PublishCopyAuditExecution>;
}

export type PublishCopyBrief = PublishCopyInput["brief"];

export interface PublishCopyRevisionInput {
  selectedModelId?: string;
  platform: string;
  brief: PublishCopyBrief;
  narrations: string[];
  currentCopy: PublishCopy;
  /** 用户实际发送的修订意见；最终修订要求只以这份文本为准。 */
  instruction: string;
}

export interface PublishCopyAuditInput {
  selectedModelId?: string;
  platform: string;
  brief: PublishCopyBrief;
  narrations: string[];
  copy: PublishCopy;
}

export interface PublishCopyAuditExecution {
  audit: RoleAudit;
}

// 与首审同一套标准：主动再审不是另立一套宽松规则。
const PUBLISH_COPY_AUDIT_CRITERIA = [
  "标题选择一个成片已经表达并兑现的具体对象、问题、变化或结果；没有新增事实、因果或收益承诺。",
  "目标观众读完标题能说出将看到什么、为何与自己有关；仅有方法论、情绪形容词或万能导语时指出具体缺口。",
  "描述补充标题未说明的价值或必要范围，表达自然且符合平台语气、长度和既有格式，不机械复述标题。",
  "话题标签准确覆盖主题和目标受众，遵守数量与格式；去除重复、空白和无关热词，不把热词堆积当作传播力。",
];

export interface CodexPublishCopyWriterOptions {
  client?: CodexBridgeClient;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

// 覆盖单并发 broker 中一个在途任务与本任务的执行时间；生产任务在 broker 队列中优先。
const DEFAULT_PUBLISH_COPY_TIMEOUT_MS = 660_000;
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
    }, undefined, input.selectedModelId ? { model: input.selectedModelId } : {});
    return validatePublishCopy(rawCopy);
  }

  async writeDetailed(input: PublishCopyInput): Promise<CodexTaskExecution<PublishCopy>> {
    validatePublishCopyInput(input);
    const request = {
      platform: input.platform,
      brief: input.brief,
      narrations: input.narrations,
    };
    return runRoleAgentLoop({
      role: "发行编辑",
      contractVersion: PUBLISH_COPY_AGENT_CONTRACT_VERSION,
      criteria: PUBLISH_COPY_AUDIT_CRITERIA,
      maxIterations: 1,
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("publish-copy", {
        ...request,
        ...(revision ? { revision } : {}),
      }, requestId, session, { ...requestOptions, ...(input.selectedModelId ? { model: input.selectedModelId } : {}) }),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["title", "description", "hashtags"],
            doesNotOwn: ["脚本事实", "画面内容", "平台实际发布结果"],
          },
          upstreamFacts: request,
          currentRoleContract: { titleMaxCharacters: 30, descriptionMaxCharacters: 100, hashtagCount: { min: 1, max: 5 }, hashtagMaxCharacters: 16 },
          downstreamBoundary: "只交付发布文案，不得改写脚本事实，也不得把尚未发布的数据作为通过条件。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      }, requestId, session, { ...requestOptions, ...(input.selectedModelId ? { model: input.selectedModelId } : {}) }),
      validate: validatePublishCopy,
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
  }

  // 明确修订只产稿：单次 publish-copy 任务经 revision 通道携带当前稿与用户指令，
  // 不进入产审循环，也不发任何 role-audit。结构无效时直接抛错，不发布可采用稿。
  async revise(input: PublishCopyRevisionInput): Promise<PublishCopy> {
    validatePublishCopyInput(input);
    const currentCopy = validatePublishCopy(input.currentCopy);
    const instruction = input.instruction.trim();
    if (!instruction || [...instruction].length > 4_000) {
      throw new Error("Publish copy revision instruction must be 1 to 4000 characters.");
    }
    const rawCopy = await this.client.runTask("publish-copy", {
      platform: input.platform,
      brief: input.brief,
      narrations: input.narrations,
      revision: { instruction, currentCopy },
    }, undefined, input.selectedModelId ? { model: input.selectedModelId } : {});
    return validatePublishCopy(rawCopy);
  }

  // 主动再审只审当前精确稿：单次 role-audit 与首审同一套标准，零产稿、零推进。
  async auditCurrent(input: PublishCopyAuditInput): Promise<PublishCopyAuditExecution> {
    validatePublishCopyInput(input);
    const copy = validatePublishCopy(input.copy);
    const output = await this.client.runTask("role-audit", {
      role: "发行编辑",
      iteration: 1,
      criteria: PUBLISH_COPY_AUDIT_CRITERIA,
      context: {
        roleScope: {
          owns: ["title", "description", "hashtags"],
          doesNotOwn: ["脚本事实", "画面内容", "平台实际发布结果"],
        },
        upstreamFacts: {
          platform: input.platform,
          brief: input.brief,
          narrations: input.narrations,
        },
        currentRoleContract: { titleMaxCharacters: 30, descriptionMaxCharacters: 100, hashtagCount: { min: 1, max: 5 }, hashtagMaxCharacters: 16 },
        downstreamBoundary: "只交付发布文案，不得改写脚本事实，也不得把尚未发布的数据作为通过条件。",
      },
      candidate: copy,
    }, undefined, input.selectedModelId ? { model: input.selectedModelId } : {});
    return { audit: validateRoleAudit(output, { role: "发行编辑", candidate: copy }) };
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
    || input.narrations.length > 24
    || input.narrations.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("Publish copy narrations must contain 3 to 24 non-empty entries.");
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
