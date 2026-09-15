import { ArrowRight, Link2, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { useMemo } from "react";
import type { StudioCandidateInboxItem, StudioEditorialVerdict } from "../../shared/api.js";
import { canonicalizeSourceUrl } from "../../shared/api.js";
import { platformLabel, proposalSourceLabel, TOPIC_CATEGORY_LABELS } from "../presentation.js";

interface HotTopicBoardProps {
  candidates: StudioCandidateInboxItem[];
  adoptingId?: string;
  onAdopt: (candidate: StudioCandidateInboxItem) => Promise<void>;
  onSupplementSources?: (candidate: StudioCandidateInboxItem) => void;
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

export function HotTopicBoard({ candidates, adoptingId, onAdopt, onSupplementSources }: HotTopicBoardProps) {
  const topics = useMemo(() => buildHotTopics(candidates), [candidates]);
  if (topics.length === 0) return null;
  return (
    <section className="hot-topic-board" aria-labelledby="hot-topic-board-title" data-tour="hot-topic-board">
      <header className="hot-topic-board-heading">
        <div>
          <p className="eyebrow">今日热点机会</p>
          <h3 id="hot-topic-board-title">最可能出爆款的 {topics.length} 个热点</h3>
        </div>
        <span>每个热点已给出可用方向；选一个方向直接进入制作路径</span>
      </header>
      <ol className="hot-topic-list">
        {topics.map((topic, index) => (
          <li className="hot-topic" key={topic.key}>
            <header className="hot-topic-heading">
              <span className="hot-topic-index">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{topic.headline}</strong>
                <small>{topic.sourceLabel} · {topic.directions.length} 个方向</small>
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
        <p>{item.hook}</p>
        <small>
          {editorialVerdictLabel(item.editorialDecision.verdict)} · {TOPIC_CATEGORY_LABELS[item.category]} · {item.audience} · <Sparkles aria-hidden="true" size={11} />{proposalSourceLabel(item.providerId)}
        </small>
      </div>
      <div className="hot-direction-action">
        <span className="hot-direction-score" aria-label={`总编评分 ${Math.round(item.editorialDecision.score)}`}>
          <small>{editorialScoreLabel(item)}</small>{Math.round(editorialScoreValue(item))}
        </span>
        {action.kind === "supplement" && onSupplementSources ? (
          <button className="button button-secondary" type="button" disabled={disabled} onClick={() => onSupplementSources(item)}>
            <Link2 aria-hidden="true" size={15} />{action.label}
          </button>
        ) : (
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
        )}
      </div>
      {action.note ? <p className="hot-direction-note"><ShieldAlert aria-hidden="true" size={13} />{action.note}</p> : null}
    </li>
  );
}

// note 显式带上 undefined：reason 列表可能为空，exactOptionalPropertyTypes 下
// "可能没有 note" 与 "note 可能是 undefined" 是两种类型。
type DirectionAction =
  | { kind: "adopt"; label: string; note?: string | undefined }
  | { kind: "supplement"; label: string; note?: string | undefined }
  | { kind: "blocked"; label: string; note?: string | undefined };

// 方向按钮只有三种真实结果：能采用、需要先补来源、当前不建议生产。
// 按钮文案必须预告点下去会发生什么，不能让"进入制作"变成一次核验弹窗的惊喜。
function directionAction(item: StudioCandidateInboxItem, canSupplement: boolean): DirectionAction {
  if (item.seriesSequence?.status === "blocked") {
    return { kind: "blocked", label: `等待第 ${item.seriesSequence.blockedByEpisodeNumber} 集`, note: "本方向属于系列后续单集，前集定版后自动解锁。" };
  }
  if (item.verification.status === "blocked") {
    return canSupplement
      ? { kind: "supplement", label: "补充来源", note: item.verification.reasons[0] }
      : { kind: "blocked", label: "等待补充来源", note: item.verification.reasons[0] };
  }
  if (item.editorialDecision.verdict === "skip") {
    return { kind: "blocked", label: "当前不建议生产", note: item.editorialDecision.reasons[0] };
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
  for (const candidate of [...candidates].sort((left, right) => right.editorialDecision.score - left.editorialDecision.score)) {
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

function editorialVerdictLabel(verdict: StudioEditorialVerdict): string {
  return {
    produce_video: "建议视频",
    produce_image_story: "建议图文成片",
    skip: "暂不生产",
  }[verdict];
}
