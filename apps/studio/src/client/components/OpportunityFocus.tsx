import { AlertTriangle, ArrowUpRight, Clock3, Link2, Search, Target } from "lucide-react";
import type { StudioOpportunity, StudioVisualSource } from "../../shared/api.js";
import { resolveOpportunityVisualPlan } from "../../shared/visual-plan.js";
import { scoreSourceLabel, TOPIC_CATEGORY_LABELS } from "../presentation.js";

interface OpportunityFocusProps {
  opportunity: StudioOpportunity;
  onSupplementSources?: () => void;
}

export function OpportunityFocus({ opportunity, onSupplementSources }: OpportunityFocusProps) {
  const sourceBlocked = opportunity.verification?.status === "blocked";
  // 没有已保存方案时这里只展示创作参考；NewRunDialog 不会把它悄悄提交成用户要求。
  const visualPlan = resolveOpportunityVisualPlan(opportunity);
  const hasSavedVisualPlan = opportunity.visualPlan !== undefined;
  return (
    <section className="opportunity-focus" aria-labelledby="opportunity-title" data-tour="opportunity-focus">
      <header className="focus-heading">
        <div>
          <p className="eyebrow">当前选题</p>
          <h2 id="opportunity-title">{opportunity.title}</h2>
          <p>{opportunity.painPoint}</p>
          {sourceBlocked ? <div className="opportunity-readiness-warning" role="status">
            <AlertTriangle aria-hidden="true" size={16} />
            <span>
              <strong>来源提醒（不影响你开工）</strong>
              <small>{opportunity.verification?.reasons[0] ?? `目前只有 ${opportunity.verification?.independentSources ?? 0}/${opportunity.verification?.requiredSources ?? 2} 个独立来源。`}可以补齐来源并重新核验；是否投入制作由你决定。</small>
              {onSupplementSources ? (
                <button className="button button-secondary opportunity-supplement-sources" type="button" onClick={onSupplementSources}><Link2 aria-hidden="true" size={15} />补充原始来源</button>
              ) : null}
            </span>
          </div> : null}
        </div>
        <div className="focus-score-block">
          <div className="focus-score" aria-label={`${sourceBlocked ? "历史机会评分" : "机会总分"} ${opportunity.score.final}`}>
            <strong>{Math.round(opportunity.score.final)}</strong>
            <span>{sourceBlocked ? "历史分" : "机会分"}</span>
          </div>
          <small>{sourceBlocked ? "历史内容潜力，仅供参考" : scoreSourceLabel(opportunity.scoreProvenance.source)}<br />{formatScoreTime(opportunity.scoreProvenance.scoredAt)}</small>
        </div>
      </header>

      <section className="visual-contact-sheet visual-plan" aria-label="镜头方向示意" data-tour="visual-direction">
          <header className="contact-sheet-heading">
            <div><span>镜头方向预览</span><h2>{hasSavedVisualPlan ? "已保存的镜头方向" : "可参考的镜头方向"}</h2></div>
            <p>{visualPlan.strategy}</p>
          </header>
          <div className="visual-beat-list">
            {visualPlan.beats.map((beat, index) => (
              <article key={beat.id} className="visual-beat">
                <span className="visual-beat-number">镜头 {String(index + 1).padStart(2, "0")}</span>
                <div><header><strong>{beat.role}</strong><small>{beat.duration} · {visualSourceLabel(beat.source)}</small></header><p>{beat.description}</p><span className="visual-query"><Search aria-hidden="true" size={13} />素材搜索：{beat.searchQuery}</span></div>
              </article>
            ))}
          </div>
      </section>

      <div className="score-band" aria-label="机会评分维度">
        <Score label="人群" value={opportunity.score.audienceReach} />
        <Score label="视觉" value={opportunity.score.visualFeasibility} />
        <Score label="成本" value={opportunity.score.productionCostEfficiency} />
        <Score label="新鲜" value={opportunity.score.novelty} />
        <Score label="系列" value={opportunity.score.seriesPotential} />
        <Score label="安全" value={100 - opportunity.score.complianceRisk} />
      </div>

      <div className="creative-stage">
        <span className="stage-kicker"><Target aria-hidden="true" size={14} />开场命题</span>
        <blockquote>{opportunity.hook}</blockquote>
        <div className="stage-meta">
          <span>{opportunity.audience}</span>
          <span>{opportunity.seriesName ?? (opportunity.category ? TOPIC_CATEGORY_LABELS[opportunity.category] : opportunity.origin === "trend" ? "热点选题" : "独立选题")}</span>
        </div>
      </div>

      <section className="evidence-panel" aria-labelledby="evidence-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">依据</span>
            <h2 id="evidence-heading">来源线索</h2>
          </div>
          <span>{opportunity.evidence.length} 条</span>
        </div>
        <div className="evidence-list">
          {opportunity.evidence.map((evidence, index) => (
            <article className="evidence-row" key={`${evidence.source}-${evidence.keyword}-${index}`}>
              <span className="evidence-strength" aria-label={isManualEvidence(evidence) ? "用户补充来源" : `榜单热度或排名信号 ${evidence.strength}`}>{isManualEvidence(evidence) ? "补" : evidence.strength}</span>
              <div>
                <strong>{isManualEvidence(evidence) ? "用户补充来源" : evidence.keyword}</strong>
                <small><Clock3 aria-hidden="true" size={12} />{formatEvidenceTime(evidence.collectedAt)}</small>
              </div>
              {evidence.evidenceUrl ? (
                <a href={evidence.evidenceUrl} target="_blank" rel="noreferrer" aria-label={`查看 ${evidence.source} 来源`}>
                  <Link2 aria-hidden="true" size={14} />{isManualEvidence(evidence) ? "用户补充" : evidence.source}<ArrowUpRight aria-hidden="true" size={13} />
                </a>
              ) : <span className="evidence-source">{evidence.source}</span>}
            </article>
          ))}
        </div>
        {opportunity.articleSources?.length ? <div className="candidate-score-explainer candidate-article-reading">
          <strong>原文阅读</strong>
          {opportunity.articleSources.map((source) => <p key={source.sourceId}>{articleReadStatusLabel(source.readStatus)} · {source.pageTitle || source.finalUrl}{source.readStatus === "failed" ? "。读取服务未能完成，不代表文章没有事实依据。" : null}</p>)}
          {opportunity.articleFacts?.map((fact, index) => <p key={`${fact.sourceId}-${index}`}>已读事实：{fact.statement}（{fact.paragraphIds.join("、")}）</p>)}
          {opportunity.articleUncertainties?.map((uncertainty, index) => <p key={index}>仍待核验：{uncertainty}</p>)}
        </div> : null}
      </section>
    </section>
  );
}

function articleReadStatusLabel(status: NonNullable<StudioOpportunity["articleSources"]>[number]["readStatus"]): string {
  return { read: "已读取正文", partial: "已读取部分正文", title_only: "仅有标题", blocked: "原文受限", failed: "原文读取失败" }[status];
}

function visualSourceLabel(source: StudioVisualSource): string {
  return { creator: "创作者拍摄", stock: "素材库", screen: "屏幕录制", "local-card": "主动排版画面", generated: "AI 生成画面" }[source];
}

function Score({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{Math.round(value)}%</strong></div>;
}

function formatEvidenceTime(value?: string): string {
  if (!value) return "未记录采集时间";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatScoreTime(value: string): string {
  return `评分于 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value))}`;
}

function isManualEvidence(evidence: { source: string; platform: string }): boolean {
  return evidence.source === "manual-supplement" || evidence.platform === "manual";
}
