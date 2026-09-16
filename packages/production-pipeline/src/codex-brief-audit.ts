import { CodexBridgeClient, requestOptionsForDeadline, type CodexTaskExecution } from "./codex-chat.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";
import type { ProductionBrief } from "./contracts.js";

/**
 * 内容简报的独立复核角色。这个名字必须逐字出现在 `ROLE_AUDIT_ASSESSMENT_PLANS` 里：
 * 表外的角色会被 {@link validateRoleAuditTargets} 直接拒绝——这是"新工位必须自己声明评什么"的守卫。
 * 刻意不复用「选题总编」：它声明 collection: "ideas"，会要求候选包成 `{ideas:[...]}`，
 * 等于逼我们把一份简报伪装成选题集合去换一次审计。
 */
export const BRIEF_AUDIT_ROLE = "内容简报";
/**
 * 简报复核的能力键，同时也是这个角色 agent 的 id（`validateCandidates` 要求同一角色的候选共享 id）。
 * 它必须**逐字等于** Studio provider catalog 里的一个 provider id：`brief.models` 的键就是能力键，
 * 而 `assertProvidersAvailable` 会拿每个键回查目录里的模型档案——目录里没有的键，整份简报都开不了工。
 * 所以这里复用「AI 独立质量复核」那一条：简报复核跑的就是 role-audit，与其它角色各自那一轮复核
 * 是同一项服务。与 `CREATIVE_TREATMENT_PROVIDER_ID` 同一写法。
 */
export const BRIEF_AUDIT_PROVIDER_ID = "codex-role-auditor-v1";
export const BRIEF_AUDIT_AGENT_CONTRACT_VERSION = "brief-audit-v1|role-audit-v9|brief-projection-v1";

const DEFAULT_BRIEF_AUDIT_TIMEOUT_MS = 660_000;
const DEFAULT_BRIEF_AUDIT_MAX_ATTEMPTS = 2;

/**
 * 送审的是简报的窄投影，不是整份 {@link ProductionBrief}：`role-audit` 的 candidate 与 context
 * 各有 192KB 上限，而 brief.articleSources 带着整段正文。投影同时划清了审计的视野——它要评的是
 * 这份任务书写得清不清楚，宿主内部字段（providers、模板快照、费用台账）不参与这个判断。
 */
export type BriefAuditCandidate = Record<string, unknown>;

// 维度走 REPORT_AUDIT_DIMENSIONS（证据/覆盖/一致/可执行）：审的是一份给人看的任务书，
// 不是创意作品，吸引点/递进/兑现/表达在这里量不到东西。
export const BRIEF_AUDIT_CRITERIA = [
  "承诺具体：标题、角度、受众三者互相支持，说得出这条片子要回答观众的什么问题，不靠形容词堆砌。",
  "覆盖完整：时长、平台与内容体量彼此匹配；锁定承诺、系列事实、视觉意图等已知约束都写进了简报，没留下要下游猜的空白。",
  "内部一致：角度、受众、平台、时长与预算之间没有互相打架的说法；改写过的字段没有留下与新说法矛盾的旧措辞。",
  "可执行：构思与剧本能只凭这份简报开工；来源、事实与示意表达分得开，未证实的部分没有被写成已证实。",
] as const;

export interface BriefAuditAgentInput {
  brief: ProductionBrief;
  agentLoopCheckpoint?: RoleAgentLoopCheckpoint;
  agentLoopCheckpointForModel?: (modelId: string) => RoleAgentLoopCheckpoint;
  selectedModelId?: string;
  wallClockDeadlineAtMs?: number;
}

export interface BriefAuditAgent {
  readonly id: string;
  readonly modelId?: string;
  auditBrief(input: BriefAuditAgentInput): Promise<CodexTaskExecution<BriefAuditCandidate>>;
}

export interface CodexBriefAuditAgentOptions {
  client?: CodexBridgeClient;
  auditClient?: Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared">;
  socketPath?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  modelId?: string;
}

export class CodexBriefAuditAgent implements BriefAuditAgent {
  readonly id = BRIEF_AUDIT_PROVIDER_ID;
  readonly modelId: string;
  private readonly auditClient: Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared">;

  constructor(options: CodexBriefAuditAgentOptions) {
    this.modelId = options.modelId?.trim() || "codex-default";
    if (options.client) {
      this.auditClient = options.auditClient ?? options.client;
      return;
    }
    if (!options.socketPath) {
      throw new Error("CodexBriefAuditAgent requires a CodexBridgeClient or a socketPath.");
    }
    const client = new CodexBridgeClient({
      socketPath: options.socketPath,
      timeoutMs: options.timeoutMs ?? DEFAULT_BRIEF_AUDIT_TIMEOUT_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_BRIEF_AUDIT_MAX_ATTEMPTS,
      ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });
    this.auditClient = options.auditClient ?? client;
  }

  /**
   * 只审不产：`maxIterations: 1` 加上 `initialCandidate`，循环第一轮直接用已校验的简报投影进审计
   * （role-agent-loop 里 pendingCandidate 的分支），`produce` 一次也不会被调用。裁决不是状态——
   * `pass` 与 `repair` 都以正常返回交给调用方，采不采用由人定。
   */
  async auditBrief(input: BriefAuditAgentInput): Promise<CodexTaskExecution<BriefAuditCandidate>> {
    const candidate = briefAuditProjection(input.brief);
    return runRoleAgentLoop<BriefAuditCandidate>({
      role: BRIEF_AUDIT_ROLE,
      contractVersion: BRIEF_AUDIT_AGENT_CONTRACT_VERSION,
      criteria: [...BRIEF_AUDIT_CRITERIA],
      maxIterations: 1,
      initialCandidate: candidate,
      produce: () => {
        // 不可达：initialCandidate 播种了第 1 轮，maxIterations 也是 1。留一句显式原因，
        // 万一日后有人调大轮次，失败点要指向真正的问题，而不是一个沉默的空实现。
        throw new Error("Brief audit never produces a candidate; it only audits the submitted brief.");
      },
      audit: ({ role, iteration, criteria, candidate: submitted, previousAudit, validationFailure, requestId, requestOptions, preparedOperation }) => preparedOperation
        ? this.auditClient.observePrepared(preparedOperation, requestOptions)
        : this.auditClient.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: briefAuditContext(submitted),
        candidate: submitted,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      }, requestId, undefined, { ...requestOptionsForDeadline(input.wallClockDeadlineAtMs), ...requestOptions }),
      validate: (value) => requireBriefAuditCandidate(value),
      ...(input.agentLoopCheckpoint ? { checkpoint: input.agentLoopCheckpoint } : {}),
    });
  }
}

/**
 * 审计的角色视野：它评的是这份简报本身，下游做得对不对不在这里判——那是构思/剧本自己那一轮的
 * 独立复核要管的事。写清楚"不管什么"是为了让"建议先改"落在简报真能改的地方。
 */
function briefAuditContext(submitted: BriefAuditCandidate): Record<string, unknown> {
  return {
    roleScope: {
      owns: ["标题与角度", "受众与平台", "时长与内容体量", "简报里已写明的来源与约束"],
      doesNotOwn: ["构思怎么讲", "分镜与素材获取", "配音与渲染成品", "费用与授权"],
    },
    brief: submitted,
  };
}

export function briefAuditProjection(brief: ProductionBrief): BriefAuditCandidate {
  return {
    title: brief.title,
    angle: brief.angle,
    audience: brief.audience,
    nicheSlug: brief.nicheSlug,
    platform: brief.platform,
    durationSeconds: brief.durationSeconds,
    ...(brief.durationRange ? { durationRange: { ...brief.durationRange } } : {}),
    ...(brief.budgetIntentionCny !== undefined ? { budgetIntentionCny: brief.budgetIntentionCny } : {}),
    ...(brief.editorial ? { editorial: brief.editorial } : {}),
    ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
    ...(brief.visualIntent ? { visualIntent: brief.visualIntent } : {}),
    ...(brief.visualPlan ? { visualPlan: brief.visualPlan } : {}),
    // 锁定的观众承诺在 seriesContext.episode.viewerPromise 里，随系列事实一起送审；
    // productionCapabilities 是宿主按运行时算出来的，不属于创作者写下的简报，不进这一轮。
    ...(brief.seriesContext ? { seriesContext: brief.seriesContext } : {}),
    // 来源只给元数据：段落正文动辄上百 KB，会顶到 role-audit 的载荷上限；而判断"简报有没有把
    // 未证实的当作已证实"要看的是 readStatus，不是正文本身。
    ...(brief.articleSources?.length
      ? {
        articleSources: brief.articleSources.map((source) => ({
          sourceId: source.sourceId,
          pageTitle: source.pageTitle,
          finalUrl: source.finalUrl,
          readStatus: source.readStatus,
          paragraphCount: source.paragraphs.length,
          truncated: source.truncated,
        })),
      }
      : {}),
  };
}

function requireBriefAuditCandidate(value: unknown): BriefAuditCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Brief audit candidate must be a JSON object.");
  }
  return value as BriefAuditCandidate;
}
