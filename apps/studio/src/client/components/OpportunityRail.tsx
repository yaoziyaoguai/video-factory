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
    <aside className="opportunity-rail" aria-label="机会雷达" data-tour="opportunity-rail">
      <header className="panel-heading opportunity-rail-heading">
        <div>
          <span>机会雷达</span>
          <h2>候选机会</h2>
        </div>
        <button className="icon-button icon-button-dark" type="button" onClick={onCreate} title="录入机会" aria-label="录入机会">
          <Plus aria-hidden="true" size={17} />
        </button>
      </header>
      <div className="opportunity-count"><RadioTower aria-hidden="true" size={14} />{opportunities.length} 条机会</div>
      <div className="opportunity-list">
        {opportunities.map((opportunity, index) => (
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
              <small>{opportunity.evidence.length} 条证据 · {scoreSourceLabel(opportunity.scoreProvenance.source)}</small>
            </span>
            <span className="opportunity-card-score">{opportunity.score.final}分</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function statusLabel(status: StudioOpportunity["status"]): string {
  return ({ draft: "草稿", shortlisted: "候选", approved: "已投产", rejected: "已放弃", tested: "已复盘" })[status];
}

function formatFreshness(value: string): string {
  const elapsedHours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  if (elapsedHours < 1) return "刚刚更新";
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  return `${Math.floor(elapsedHours / 24)} 天前`;
}
