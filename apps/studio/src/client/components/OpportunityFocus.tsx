import { ArrowUpRight, Clock3, Link2, Search, Target } from "lucide-react";
import type { StudioOpportunity, StudioVisualSource } from "../../shared/api.js";
import { planVisualDirection } from "../../shared/visual-plan.js";
import { scoreSourceLabel, TOPIC_CATEGORY_LABELS } from "../presentation.js";

export function OpportunityFocus({ opportunity }: { opportunity: StudioOpportunity }) {
  const visualPlan = opportunity.visualPlan ?? planVisualDirection({
    title: opportunity.title,
    hook: opportunity.hook,
    ...(opportunity.category ? { category: opportunity.category } : {}),
  });
  return (
    <section className="opportunity-focus" aria-labelledby="opportunity-title" data-tour="opportunity-focus">
      <header className="focus-heading">
        <div>
          <p className="eyebrow">当前选题</p>
          <h2 id="opportunity-title">{opportunity.title}</h2>
          <p>{opportunity.painPoint}</p>
        </div>
        <div className="focus-score-block">
          <div className="focus-score" aria-label={`机会总分 ${opportunity.score.final}`}>
            <strong>{Math.round(opportunity.score.final)}</strong>
            <span>机会分</span>
          </div>
          <small>{scoreSourceLabel(opportunity.scoreProvenance.source)}<br />{formatScoreTime(opportunity.scoreProvenance.scoredAt)}</small>
        </div>
      </header>

      <section className="visual-contact-sheet visual-plan" aria-label="镜头方向示意" data-tour="visual-direction">
          <header className="contact-sheet-heading">
            <div><span>视觉方案 · A01</span><h2>可执行镜头计划</h2></div>
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
            <h2 id="evidence-heading">信号证据</h2>
          </div>
          <span>{opportunity.evidence.length} 条</span>
        </div>
        <div className="evidence-list">
          {opportunity.evidence.map((evidence, index) => (
            <article className="evidence-row" key={`${evidence.source}-${evidence.keyword}-${index}`}>
              <span className="evidence-strength">{evidence.strength}</span>
              <div>
                <strong>{evidence.keyword}</strong>
                <small><Clock3 aria-hidden="true" size={12} />{formatEvidenceTime(evidence.collectedAt)}</small>
              </div>
              {evidence.evidenceUrl ? (
                <a href={evidence.evidenceUrl} target="_blank" rel="noreferrer" aria-label={`查看 ${evidence.source} 证据`}>
                  <Link2 aria-hidden="true" size={14} />{evidence.source}<ArrowUpRight aria-hidden="true" size={13} />
                </a>
              ) : <span className="evidence-source">{evidence.source}</span>}
            </article>
          ))}
        </div>
      </section>
    </section>
  );
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
