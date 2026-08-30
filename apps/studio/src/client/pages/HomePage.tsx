import { ArrowRight, Flame, Lightbulb, ListVideo, Play, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function HomePage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setRuns(await studioApi.runs());
    } catch {
      setError("创作台暂时没有连接到制作服务。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentRun = useMemo(() => runs.find(needsAttention)
    ?? runs.find((run) => run.status === "running" || run.status === "pending")
    ?? runs[0], [runs]);
  const overview = useMemo(() => {
    const current = runs.filter((run) => !run.archivedAt);
    return {
      attention: current.filter(needsAttention).length,
      active: current.filter((run) => run.status === "running" || run.status === "pending").length,
      completed: current.filter((run) => run.status === "succeeded").length,
      adjustment: current.filter((run) => run.status === "failed" || run.status === "rejected").length,
    };
  }, [runs]);

  return (
    <main className="home-page">
      <header className="home-intro">
        <div>
          <p className="eyebrow">今日创作台</p>
          <h1>从一个想法，到一条成片。</h1>
          <p>选择一种开始方式。系统会沿同一条制作线推进，并在花钱前停下来等你确认。</p>
        </div>
        <time>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</time>
      </header>

      {error ? <div className="home-error" role="alert"><span>{error}</span><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重新连接</button></div> : null}

      {runs.length ? <section className="home-production-overview" aria-label="制作概况">
        <span><small>待你处理</small><strong>{overview.attention}</strong></span>
        <span><small>自动制作</small><strong>{overview.active}</strong></span>
        <span><small>已完成</small><strong>{overview.completed}</strong></span>
        <span><small>需调整</small><strong>{overview.adjustment}</strong></span>
      </section> : null}

      {currentRun ? (
        <section className="home-continuation" aria-labelledby="continue-title">
          <div className="home-section-number">01</div>
          <div className="home-continuation-copy">
            <p className="eyebrow">继续上次工作</p>
            <h2 id="continue-title">{currentRun.title}</h2>
            <div><StatusBadge status={currentRun.status} /><span>{continueMessage(currentRun)}</span></div>
          </div>
          {currentRun.videoContentUrl ? <video muted playsInline preload="metadata" src={`${currentRun.videoContentUrl}#t=0.1`} aria-hidden="true" /> : <div className="home-run-mark" aria-hidden="true"><Play size={24} /></div>}
          <Link className="button button-primary" to={`/projects/${currentRun.id}`}>{continueAction(currentRun)}<ArrowRight aria-hidden="true" size={16} /></Link>
        </section>
      ) : null}

      <section className="home-start" aria-labelledby="start-title">
        <header>
          <div className="home-section-number">{currentRun ? "02" : "01"}</div>
          <div><p className="eyebrow">开始一条新视频</p><h2 id="start-title">你今天从哪里出发？</h2></div>
        </header>
        <div className="home-start-options">
          <button type="button" onClick={() => navigate("/topics")}>
            <span className="home-option-icon is-hot"><Flame aria-hidden="true" size={21} /></span>
            <span><strong>从热点开始</strong><small>先看值得做、能拍出来的实时机会</small></span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
          <button type="button" onClick={() => navigate("/topics?mode=series")}>
            <span className="home-option-icon is-series"><ListVideo aria-hidden="true" size={21} /></span>
            <span><strong>继续一个系列</strong><small>沿固定栏目与观众承诺持续更新</small></span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
          <button type="button" onClick={() => navigate("/topics?mode=manual")}>
            <span className="home-option-icon is-idea"><Lightbulb aria-hidden="true" size={21} /></span>
            <span><strong>从自己的想法开始</strong><small>输入主题、照片或参考视频</small></span>
            <Plus aria-hidden="true" size={18} />
          </button>
        </div>
      </section>
    </main>
  );
}

function needsAttention(run: StudioRunSummary): boolean {
  return run.status === "needs_human"
    || run.status === "awaiting_spend_approval"
    || run.status === "approval_invalidated"
    || run.status === "stale";
}

function continueAction(run: StudioRunSummary): string {
  if (run.nextAction === "confirm_spend") return "确认费用";
  if (run.nextAction === "review") return "进入审片";
  if (run.nextAction === "regenerate") return "确认后继续";
  if (run.status === "succeeded") return "查看成片";
  if (run.status === "failed" || run.status === "rejected") return "重新调整";
  return "继续制作";
}

function continueMessage(run: StudioRunSummary): string {
  if (run.nextAction === "confirm_spend") return "下一个节点会产生费用，正在等你检查前序内容。";
  if (run.nextAction === "review") return "成片已经准备好，正在等你完整观看和判断。";
  if (run.nextAction === "regenerate") return "人工修改已经保存，正在等你确认后续重新生成。";
  if (run.status === "succeeded") return "这条视频已经完成，可以查看成片与发布包。";
  if (run.status === "failed" || run.status === "rejected") return "这条制作需要调整后重新开始。";
  return "制作正在自动推进，你随时可以进入查看。";
}
