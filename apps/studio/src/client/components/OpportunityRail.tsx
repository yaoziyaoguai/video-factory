import { Plus, RadioTower } from "lucide-react";
import type { StudioOpportunity } from "../../shared/api.js";
import { platformLabel, scoreSourceLabel } from "../presentation.js";

interface OpportunityRailProps {
  opportunities: StudioOpportunity[];
  selectedId?: string;
  onSelect: (opportunityId: string) => void;
  onCreate: () => void;
}

export function OpportunityRail({ opportunities, selectedId, onSelect, onCreate }: OpportunityRailProps) {
  return (
    <aside className="opportunity-rail" aria-label="待制作选题" data-tour="opportunity-rail">
      <header className="panel-heading opportunity-rail-heading">
        <div>
          <span>制作区</span>
          <h2>待制作选题</h2>
        </div>
        <button className="icon-button icon-button-dark" type="button" onClick={onCreate} title="录入机会" aria-label="录入机会">
          <Plus aria-hidden="true" size={17} />
        </button>
      </header>
      <div className="opportunity-count"><RadioTower aria-hidden="true" size={14} />{opportunities.length} 条已进入</div>
      <div className="opportunity-list">
        {opportunities.map((opportunity, index) => {
          // 已采用的历史热点不满足当前来源政策时，旧分数只能标为历史内容潜力；来源不足只是提醒，不拦开工。
          const sourceBlocked = opportunity.verification?.status === "blocked";
          return (
            <button
              className={`opportunity-card ${selectedId === opportunity.id ? "is-active" : ""}`}
              type="button"
              key={opportunity.id}
              onClick={() => onSelect(opportunity.id)}
            >
              <span className="opportunity-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="opportunity-card-copy">
                <strong>{opportunity.title}</strong>
                <small>{platformLabel(opportunity.platform)} · {statusLabel(opportunity.status)} · {formatFreshness(opportunity.updatedAt)}</small>
                <small>{sourceBlocked ? "待补来源 · 仍可开工" : `${opportunity.evidence.length} 条来源线索 · ${scoreSourceLabel(opportunity.scoreProvenance.source)}`}</small>
              </span>
              <span className="opportunity-card-score">{sourceBlocked ? <small className="opportunity-card-score-label">历史内容潜力</small> : null}{opportunity.score.final}分</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function statusLabel(status: StudioOpportunity["status"]): string {
  return ({ draft: "待制作", shortlisted: "待制作", approved: "制作中", rejected: "已放弃", tested: "已复盘" })[status];
}

function formatFreshness(value: string): string {
  const elapsedHours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  if (elapsedHours < 1) return "刚刚更新";
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  return `${Math.floor(elapsedHours / 24)} 天前`;
}
