import { AlertCircle, ArrowRight, Link2, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { useMemo } from "react";
import type { StudioCandidateInboxItem, StudioTopicGenerationReceipt } from "../../shared/api.js";
import { canonicalizeSourceUrl } from "../../shared/api.js";
import { creatorFacingTechnicalText, platformLabel, proposalSourceLabel, TOPIC_CATEGORY_LABELS } from "../presentation.js";

interface HotTopicBoardProps {
  candidates: StudioCandidateInboxItem[];
  topicGeneration?: StudioTopicGenerationReceipt;
  adoptingId?: string;
  /** 已有一轮更新在跑：这里的"重新生成"走的是同一个刷新入口，不能再放一次。 */
  refreshBusy?: boolean;
  onAdopt: (candidate: StudioCandidateInboxItem) => Promise<void>;
  onSupplementSources?: (candidate: StudioCandidateInboxItem) => void;
  onRetry?: () => void;
}

// 待制作区一次只回答"今天先做哪一条"：Top 5 个热点足够覆盖一轮选题，
// 每个热点默认给 2 个方向，多出来的方向回候选收件箱里看，避免这里又变成一张长列表。
const HOT_TOPIC_LIMIT = 5;
const DIRECTIONS_PER_TOPIC_LIMIT = 2;

interface HotTopic {
  key: string;
  headline: string;
  sourceLabel: string;
  directions: StudioCandidateInboxItem[];
}

export function HotTopicBoard({ candidates, topicGeneration, adoptingId, refreshBusy, onAdopt, onSupplementSources, onRetry }: HotTopicBoardProps) {
  const topics = useMemo(() => buildHotTopics(candidates), [candidates]);
  // 总编模型轮失败时整块看板都是规则线索：这时"每个热点已给出可用方向"是假话，
  // 必须在不依赖用户逐行辨认的前提下先说清整块看板的性质。
  // 不能只信 receipt：历史缓存可能没有 generationReceipt，那时看板仍是规则线索，
  // 按候选本身判断才不会因为缺一个字段就退回假话。
  const ruleFallback = topicGeneration?.source === "rule-fallback"
    || (candidates.length > 0 && candidates.every(isRuleLead));
  if (topics.length === 0) return null;
  return (
    <section className="hot-topic-board" aria-labelledby="hot-topic-board-title" data-tour="hot-topic-board">
      <header className="hot-topic-board-heading">
        <div>
          <p className="eyebrow">今日热点机会</p>
          <h3 id="hot-topic-board-title">综合选题分最高的 {topics.length} 个热点</h3>
        </div>
        <span>{ruleFallback
          ? "排序只说明这一轮的相对优先级，不是播放量预测；本轮没有总编给出的创作角度，下面是榜单原始线索"
          : "排序只说明这一轮的相对优先级，不是播放量预测；每个热点已给出可用方向，选一个直接进入制作路径"}</span>
      </header>
      {ruleFallback ? (
        <div className="hot-topic-fallback" role="status">
          <AlertCircle aria-hidden="true" size={16} />
          <div>
            <strong>本轮总编没有给出选题建议</strong>
            <p>{topicGeneration ? ruleFallbackReason(topicGeneration) : "这些候选是本地规则按榜单信号生成的，没有经过选题总编。"}</p>
            <p>下面的热点来自榜单信号，没有经过总编判断，也没有创作角度与观众需求评分——它们只是线索。你仍然可以选其中任意一条开工。</p>
          </div>
          {onRetry ? <button className="button button-secondary" type="button" disabled={refreshBusy === true} onClick={onRetry}>重新生成</button> : null}
        </div>
      ) : null}
      <ol className="hot-topic-list">
        {topics.map((topic, index) => (
          <li className="hot-topic" key={topic.key}>
            <header className="hot-topic-heading">
              <span className="hot-topic-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{topic.headline}</strong>
                {/* 规则线索没有方向可数：写"2 个方向"等于替总编认领了它没给过的东西。 */}
                <small>{topic.sourceLabel} · {topic.directions.length} {ruleFallback ? "条线索" : "个方向"}</small>
              </div>
            </header>
            <ul className="hot-direction-list">
              {topic.directions.map((item) => (
                <DirectionRow
                  key={item.id}
                  item={item}
                  adopting={adoptingId === item.id}
                  disabled={adoptingId !== undefined}
                  onAdopt={onAdopt}
                  {...(onSupplementSources ? { onSupplementSources } : {})}
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DirectionRow({ item, adopting, disabled, onAdopt, onSupplementSources }: {
  item: StudioCandidateInboxItem;
  adopting: boolean;
  disabled: boolean;
  onAdopt: (candidate: StudioCandidateInboxItem) => Promise<void>;
  onSupplementSources?: (candidate: StudioCandidateInboxItem) => void;
}) {
  const action = directionAction(item, onSupplementSources !== undefined);
  return (
    <li className="hot-direction">
      <div className="hot-direction-copy">
        <strong>{item.title}</strong>
        {/* 规则线索的 hook 是把榜单标题套进问句模板生成的，不是总编想出来的角度。
            把它当"方向"印出来会让用户以为这条有人想过——这里如实说没有角度。 */}
        {isRuleLead(item)
          ? <p>总编本轮没有为这条给出创作角度。</p>
          : <p>{item.hook}</p>}
        <small>
          {editorialVerdictLabel(item)} · {TOPIC_CATEGORY_LABELS[item.category]} · {item.audience}
          {item.score.audienceDemand === undefined ? null : ` · 观众需求 ${Math.round(item.score.audienceDemand)}`}
          {" · "}<Sparkles aria-hidden="true" size={11} />{proposalSourceLabel(item.providerId)}
        </small>
      </div>
      <div className="hot-direction-action">
        <span className="hot-direction-score" aria-label={`${editorialScoreLabel(item)} ${Math.round(editorialScoreValue(item))}`}>
          <small>{editorialScoreLabel(item)}</small>{Math.round(editorialScoreValue(item))}
        </span>
        {action.supplement && onSupplementSources ? (
          <button className="button button-secondary" type="button" disabled={disabled} onClick={() => onSupplementSources(item)}>
            <Link2 aria-hidden="true" size={15} />补充来源
          </button>
        ) : null}
        <button
          className="button button-primary"
          type="button"
          data-tour="hot-direction-produce"
          disabled={disabled || action.kind === "blocked"}
          aria-label={`${action.label} ${item.title}`}
          onClick={() => void onAdopt(item)}
        >
          {adopting ? "正在采用..." : action.label}
          {action.kind === "blocked" ? <XCircle aria-hidden="true" size={15} /> : <ArrowRight aria-hidden="true" size={15} />}
        </button>
      </div>
      {action.note ? <p className="hot-direction-note"><ShieldAlert aria-hidden="true" size={13} />{action.note}</p> : null}
    </li>
  );
}

// note 显式带上 undefined：reason 列表可能为空，exactOptionalPropertyTypes 下
// "可能没有 note" 与 "note 可能是 undefined" 是两种类型。
type DirectionAction = {
  kind: "adopt" | "blocked";
  label: string;
  note?: string | undefined;
  /** 来源不足时同时给出"补充来源"这条恢复路径，但采用按钮保持可用。 */
  supplement?: boolean | undefined;
};

// 门槛只作建议：除了系列顺序这种事实性依赖，没有任何模型或审计结论能拦下"进入制作"。
// 按钮文案必须预告点下去会发生什么，不能让"进入制作"变成一次核验弹窗的惊喜。
function directionAction(item: StudioCandidateInboxItem, canSupplement: boolean): DirectionAction {
  if (item.seriesSequence?.status === "blocked") {
    return { kind: "blocked", label: `等待第 ${item.seriesSequence.blockedByEpisodeNumber} 集`, note: "本方向属于系列后续单集，前集定版后自动解锁。" };
  }
  if (item.verification.status === "blocked") {
    return {
      kind: "adopt",
      label: "仍然进入制作",
      note: `建议先补来源：${item.verification.reasons[0] ?? "当前有效来源不足。"}（只是建议，不影响你现在开工）`,
      supplement: canSupplement,
    };
  }
  // 规则线索没有总编结论，不能把"还没评估"说成"总编不建议生产"——那样等于替总编表态。
  if (isRuleLead(item)) {
    return { kind: "adopt", label: "仍然进入制作", note: `总编本轮没有评估这条：${item.editorialDecision.reasons[0] ?? "未经选题总编判断。"}（是否开工由你决定）` };
  }
  if (item.editorialDecision.verdict === "skip") {
    return { kind: "adopt", label: "仍然进入制作", note: `总编不建议生产：${item.editorialDecision.reasons[0] ?? "未给出理由。"}（是否开工由你决定）` };
  }
  if (item.verification.status === "review_required") {
    return { kind: "adopt", label: "核验后进入制作", note: item.verification.reasons[0] };
  }
  return { kind: "adopt", label: "进入制作" };
}

function editorialScoreLabel(item: StudioCandidateInboxItem): string {
  if (item.editorialDecision.pendingEditorReview) return "内容潜力";
  return "总编评分";
}

function editorialScoreValue(item: StudioCandidateInboxItem): number {
  return item.editorialDecision.pendingEditorReview ? item.score.final : item.editorialDecision.score;
}

// 热点身份 = 首个非人工来源的原始链接。canonical signal group 里同一事件在不同平台
// 指向同一篇文章，用链接分组才能把"同一件事的多个角度"收拢成一个热点。
function hotTopicKey(candidate: StudioCandidateInboxItem): string {
  for (const evidence of candidate.evidence) {
    if (isManualEvidence(evidence) || !evidence.evidenceUrl) continue;
    try {
      return canonicalizeSourceUrl(evidence.evidenceUrl);
    } catch {
      // 历史证据里可能存有不完全合法的链接；退回下一条而不是把候选丢掉。
    }
  }
  return `candidate:${candidate.id}`;
}

function buildHotTopics(candidates: StudioCandidateInboxItem[]): HotTopic[] {
  const groups = new Map<string, StudioCandidateInboxItem[]>();
  // 排序必须用界面上显示的那个分：规则保底候选还没有总编评分，
  // 按 editorialDecision.score（恒为 0）排会让标题里的"综合选题分最高"和列表顺序自相矛盾。
  for (const candidate of [...candidates].sort((left, right) => editorialScoreValue(right) - editorialScoreValue(left))) {
    const key = hotTopicKey(candidate);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  return [...groups.entries()].slice(0, HOT_TOPIC_LIMIT).map(([key, items]) => {
    const primary = items[0]!;
    const evidence = primary.evidence.find((entry) => !isManualEvidence(entry));
    return {
      key,
      // 热点名取榜单原始标题：方向标题是总编改写过的角度，拿它当热点名会让 2 个方向看起来像 2 个热点。
      headline: evidence?.keyword ?? primary.title,
      sourceLabel: evidence ? `${platformLabel(evidence.platform)} · 热度 ${evidence.strength}` : "自有人工来源",
      directions: items.slice(0, DIRECTIONS_PER_TOPIC_LIMIT),
    };
  });
}

function isManualEvidence(evidence: { source: string; platform: string }): boolean {
  return evidence.source === "manual-supplement" || evidence.platform === "manual";
}

// 规则线索的 verdict 是本地规则算出来的"skip"，不是总编的判断：
// 直接印"暂不生产"会让用户以为是总编否掉了这条。
function editorialVerdictLabel(item: StudioCandidateInboxItem): string {
  if (isRuleLead(item)) return "待总编评估";
  return {
    produce_video: "建议视频",
    produce_image_story: "建议图文成片",
    skip: "暂不建议制作",
  }[item.editorialDecision.verdict];
}

// pendingEditorReview 只在候选由本地规则产出时为真（editorial-decision.ts 按 providerId 标记），
// 所以它就是"这条没有经过总编"的权威标记，不需要再去猜 providerId 的写法。
function isRuleLead(item: StudioCandidateInboxItem): boolean {
  return item.editorialDecision.pendingEditorReview === true;
}

// 只说"总编没给建议"不够：用户无从判断是模型不可用、超时，还是输出被合同拦下。
// failureReason 来自服务端的失败叙述，可能带机器诊断尾巴，过一遍创作者措辞表再显示。
function ruleFallbackReason(receipt: StudioTopicGenerationReceipt): string {
  const category = {
    model_unavailable: "总编模型当前不可用。",
    accepted_unknown: "选题结果未通过格式校验，本轮未能采用。",
    contract_rejected: "选题结果未满足本次任务要求，本轮未能采用。",
    model_error: "总编这轮执行出错。",
  }[receipt.failureCategory ?? "model_error"];
  const reason = creatorFacingTechnicalText(receipt.failureReason);
  return reason ? `${category}原因：${reason}` : category;
}
