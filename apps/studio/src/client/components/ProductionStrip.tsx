import { ArrowUpRight, CircleCheck, LoaderCircle } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { runNodeLabel } from "../presentation.js";

export function ProductionStrip({ runs }: { runs: StudioRunSummary[] }) {
  const activeRun = runs.find((run) => run.status === "needs_human")
    ?? runs.find((run) => run.status === "running" || run.status === "pending");

  if (!activeRun) {
    return null;
  }

  const needsReview = activeRun.status === "needs_human";
  return (
    <aside className={`production-strip ${needsReview ? "production-strip-review" : ""}`} aria-label="当前生产">
      <span className="production-strip-icon">
        {needsReview ? <CircleCheck aria-hidden="true" size={17} /> : <LoaderCircle aria-hidden="true" size={17} />}
      </span>
      <div>
        <span>{needsReview ? "等你审片" : "正在制作"}</span>
        <strong>{activeRun.title}</strong>
      </div>
      <small>{runNodeLabel(activeRun.currentNodeId)}</small>
      <Link to={`/projects/${activeRun.id}`} aria-label={`查看生产：${activeRun.title}`}>
        {needsReview ? "现在审片" : "查看进度"}<ArrowUpRight aria-hidden="true" size={15} />
      </Link>
    </aside>
  );
}
