import { ArrowUpRight, CircleCheck, CircleDollarSign, LoaderCircle, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { runNodeLabel } from "../presentation.js";

export function ProductionStrip({ runs }: { runs: StudioRunSummary[] }) {
  const activeRun = runs.find((run) => run.status === "awaiting_spend_approval" || run.status === "approval_invalidated")
    ?? runs.find((run) => run.status === "stale")
    ?? runs.find((run) => run.status === "needs_human")
    ?? runs.find((run) => run.status === "running" || run.status === "pending");

  if (!activeRun) {
    return null;
  }

  const needsReview = activeRun.status === "needs_human";
  const needsSpend = activeRun.status === "awaiting_spend_approval" || activeRun.status === "approval_invalidated";
  const needsRegenerate = activeRun.status === "stale";
  const needsAction = needsReview || needsSpend || needsRegenerate;
  const label = needsSpend ? "待确认费用" : needsRegenerate ? "待确认重生成" : needsReview ? "等你审片" : "正在制作";
  return (
    <aside className={`production-strip ${needsAction ? "production-strip-review" : ""} ${activeRun.videoContentUrl ? "has-preview" : ""}`} aria-label="当前生产">
      {activeRun.videoContentUrl ? (
        <span className="production-strip-preview" aria-hidden="true">
          <video muted playsInline preload="metadata" src={activeRun.videoContentUrl} tabIndex={-1} />
          <i>{activeRun.durationSeconds}s</i>
        </span>
      ) : (
        <span className="production-strip-icon">
          {needsSpend
            ? <CircleDollarSign aria-hidden="true" size={17} />
            : needsRegenerate
              ? <RotateCcw aria-hidden="true" size={17} />
              : needsReview
                ? <CircleCheck aria-hidden="true" size={17} />
                : <LoaderCircle aria-hidden="true" size={17} />}
        </span>
      )}
      <div>
        <span>{label}</span>
        <strong>{activeRun.title}</strong>
      </div>
      <small>{runNodeLabel(activeRun.currentNodeId)}</small>
      <Link to={`/projects/${activeRun.id}`} aria-label={`查看生产：${activeRun.title}`}>
        {needsSpend ? "确认费用" : needsRegenerate ? "处理修改" : needsReview ? "现在审片" : "查看进度"}<ArrowUpRight aria-hidden="true" size={15} />
      </Link>
    </aside>
  );
}
