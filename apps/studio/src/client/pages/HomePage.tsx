import { ArrowRight, Clapperboard, Flame, Lightbulb, ListVideo, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { creatorReviewAction, creatorRunStatusLabel, isHistoricalReadOnlyRun, runNeedsCreatorAction, runNodeLabel } from "../presentation.js";

export function HomePage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    try {
      setRuns(await studioApi.runs());
    } catch {
      setError("创作台暂时没有连接到制作服务。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 活跃口径与 ProductionStrip/Queue 一致：历史只读 running/pending 不算自动制作，也不抢占继续工作位。
  const currentRun = useMemo(() => runs.find(runNeedsCreatorAction)
    ?? runs.find((run) => !isHistoricalReadOnlyRun(run) && (run.status === "running" || run.status === "pending"))
    ?? runs[0], [runs]);
  const overview = useMemo(() => {
    const current = runs.filter((run) => !run.archivedAt);
    return {
      attention: current.filter(runNeedsCreatorAction).length,
      active: current.filter((run) => !isHistoricalReadOnlyRun(run) && (run.status === "running" || run.status === "pending")).length,
      completed: current.filter((run) => run.status === "succeeded").length,
      archived: runs.filter((run) => Boolean(run.archivedAt)).length,
    };
  }, [runs]);

  return (
    <main className="home-page">
      <header className="home-intro">
        <div>
          <h1>创作台</h1>
          <p>把想法写下来，把作品继续完成。</p>
        </div>
        <time>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</time>
      </header>

      {error ? <div className="home-error" role="alert"><span>{error}</span><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重新连接</button></div> : null}
      {loading ? <p className="home-loading" role="status">正在读取你的作品…你也可以先选择下面的创作入口。</p> : null}

      {currentRun ? (
        <section className={`home-continuation${currentRun.videoContentUrl ? " has-preview" : ""}`} aria-labelledby="continue-title">
          {currentRun.videoContentUrl ? <div className="home-work-preview"><video controls muted playsInline preload="metadata" src={`${currentRun.videoContentUrl}#t=0.1`} aria-label={`${currentRun.title} 预览`} /></div> : null}
          <div className="home-continuation-copy">
            <p className="home-work-label">{currentRun.status === "succeeded" ? "最近完成" : "继续上次工作"}</p>
            <h2 id="continue-title">{currentRun.title}</h2>
            <div className="home-work-status"><StatusBadge status={currentRun.status} {...(creatorRunStatusLabel(currentRun) ? { label: creatorRunStatusLabel(currentRun)! } : {})} /></div>
            <p className="home-work-message">{continueMessage(currentRun)}</p>
            <Link className="button button-primary" to={`/projects/${currentRun.id}`}>{continueAction(currentRun)}<ArrowRight aria-hidden="true" size={16} /></Link>
          </div>
        </section>
      ) : null}

      {runs.length ? <section className="home-production-overview" aria-label="制作概况">
        <span><small>待你处理</small><strong>{overview.attention}</strong></span>
        <span><small>自动制作</small><strong>{overview.active}</strong></span>
        <span><small>已完成</small><strong>{overview.completed}</strong></span>
        <span><small>已归档</small><strong>{overview.archived}</strong></span>
        <Link to="/projects">全部制作<ArrowRight aria-hidden="true" size={15} /></Link>
      </section> : null}

      <section className="home-start" aria-labelledby="start-title">
        <header>
          <div><h2 id="start-title">你今天从哪里出发？</h2><p>开始一条新视频</p></div>
        </header>
        <div className="home-start-options">
          <button type="button" onClick={() => navigate("/topics")}>
            <span className="home-option-icon is-hot"><Flame aria-hidden="true" size={21} /></span>
            <span><strong>从热点开始</strong><small>发现值得讲的当下话题</small></span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
          <button type="button" onClick={() => navigate("/topics?mode=series")}>
            <span className="home-option-icon is-series"><ListVideo aria-hidden="true" size={21} /></span>
            <span><strong>继续一个系列</strong><small>延续栏目，创作下一集</small></span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
          <button type="button" onClick={() => navigate("/topics?mode=manual")}>
            <span className="home-option-icon is-idea"><Lightbulb aria-hidden="true" size={21} /></span>
            <span><strong>从自己的想法开始</strong><small>写下主题，加入你的参考</small></span>
            <Plus aria-hidden="true" size={18} />
          </button>
          <button type="button" onClick={() => navigate("/cases")}>
            <span className="home-option-icon is-case"><Clapperboard aria-hidden="true" size={21} /></span>
            <span><strong>从案例 / 脚本开始</strong><small>借鉴好作品，写自己的版本</small></span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
        </div>
        <p className="home-start-note">选择一种开始方式。系统会沿同一条制作线推进；需要生成付费图片或视频时，会先报价并等你确认。</p>
      </section>
    </main>
  );
}

function continueAction(run: StudioRunSummary): string {
  if (isHistoricalReadOnlyRun(run)) return "基于这版重新制作";
  if (run.nextAction === "confirm_spend") return "确认费用";
  if (run.nextAction === "review") return creatorReviewAction(run);
  if (run.nextAction === "regenerate") return "确认后继续";
  if (run.status === "succeeded") return "查看成片";
  if (run.status === "failed" || run.status === "rejected") return "查看并继续处理";
  return "继续制作";
}

function continueMessage(run: StudioRunSummary): string {
  if (isHistoricalReadOnlyRun(run)) return "这是旧版制作记录；现有结果可以查看，继续调整会创建一个新版制作。";
  if (run.nextAction === "confirm_spend") return "下一步会产生费用，正在等你检查前面的内容。";
  if (run.nextAction === "review") return run.currentNodeId === "final-review" && run.videoContentUrl
    ? "成片已经准备好，正在等你完整观看和判断。"
    : `${runNodeLabel(run.currentNodeId)}等待你的判断，打开后可以查看产物、讨论或确认当前版本。`;
  if (run.nextAction === "regenerate") return "人工修改已经保存，正在等你确认后续重新生成。";
  if (run.status === "succeeded") return "这条视频已经完成，可以查看成片与发布包。";
  if (run.status === "failed" || run.status === "rejected") return "制作停在失败步骤；已保留的内容不会丢，打开后查看并继续处理。";
  if (run.status === "paused") return "制作已暂停。先查看已保留的结果，再决定是否恢复。";
  return "当前步骤正在制作，完成后会按流程等待你的确认。";
}
