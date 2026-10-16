import { ArrowRight, BookOpen, Clapperboard, Clock3, FileText, Film, Flame, Layers3, Lightbulb, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { creatorReviewAction, creatorRunStatusLabel, isHistoricalReadOnlyRun, platformLabel, runNeedsCreatorAction, runNodeLabel } from "../presentation.js";

const creationEntries = [
  { id: "trends", title: "热点选题", description: "发现值得创作的热点，\n把握当下的讨论与情绪。", action: "从热点开始", detail: "", destination: "/topics", icon: Flame },
  { id: "series", title: "系列策划", description: "用系列，记录更完整的故事，\n让内容持续发生。", action: "继续一个系列", detail: "延续栏目，创作下一集", destination: "/topics?mode=series", icon: Layers3 },
  { id: "idea", title: "我的想法", description: "从一个灵感开始，\n把脑海中的想法变成作品。", action: "从自己的想法开始", detail: "写下主题，加入你的参考", destination: "/topics?mode=manual", icon: Lightbulb },
  { id: "reference", title: "参考案例", description: "借鉴优秀作品，\n发现更多创作可能。", action: "从案例 / 脚本开始", detail: "借鉴好作品，写自己的版本", destination: "/cases", icon: BookOpen },
] as const;

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
  const recentRuns = useMemo(() => [...runs]
    .filter((run) => run.id !== currentRun?.id && !run.archivedAt && !isHistoricalReadOnlyRun(run))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, 3), [currentRun?.id, runs]);
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
      <header className="home-hero">
        <img className="home-hero-image" src="/media/home/studio-hero.webp" alt="" fetchPriority="high" width={1920} height={900} />
        <div className="home-hero-copy">
          <p className="home-greeting">{greeting()}，</p>
          <h1><span className="home-sr-only">创作台 · </span>继续创作你的下一个视频</h1>
          <p className="home-hero-description">从热点、系列、自己的想法或参考案例开始，把灵感变成一部完整的作品。</p>
        </div>
        <p className="home-hero-note" aria-hidden="true">每一个普通的日常<br />都有动人的角度<span /></p>
      </header>

      <section className={`home-creation${!loading && !error && !currentRun ? " is-new-workspace" : ""}`} aria-labelledby="start-title">
        <h2 id="start-title" className="home-sr-only">你今天从哪里出发？</h2>
        <div className="home-entry-grid">
          {creationEntries.map(({ id, title, description, action, detail, destination, icon: Icon }) => (
            <button className={`home-entry home-entry-${id}`} key={id} type="button" aria-labelledby={`home-entry-title-${id} home-entry-action-${id}`} aria-describedby={detail ? `home-entry-detail-${id}` : `home-entry-description-${id}`} onClick={() => navigate(destination)}>
              <img className="home-entry-image" src={`/media/home/entry-${id}.webp`} alt="" width={700} height={1000} decoding="async" />
              <span className="home-entry-heading">
                <span className="home-entry-topline" aria-hidden="true"><span className="home-entry-symbol"><Icon size={17} strokeWidth={1.8} /></span><ArrowRight className="home-entry-arrow" size={21} /></span>
                <strong id={`home-entry-title-${id}`}>{title}</strong>
                <span className="home-entry-description" id={`home-entry-description-${id}`}>{description}</span>
              </span>
              <span className="home-entry-footer"><span id={`home-entry-action-${id}`}>{action}</span>{detail ? <small id={`home-entry-detail-${id}`}>{detail}</small> : null}</span>
            </button>
          ))}
        </div>
        <p className="home-start-note">需要生成付费图片或视频时，会先报价并等你确认。</p>
      </section>

      <section className="home-workdesk" aria-labelledby="home-workdesk-title">
        <header className="home-workdesk-heading">
          <h2 id="home-workdesk-title">最近的制作 <ArrowRight aria-hidden="true" size={20} /></h2>
          {!loading && !error ? <section className="home-production-overview" aria-label="制作概况">
            <span><small>待你处理</small><strong>{overview.attention}</strong></span>
            <span><small>自动制作</small><strong>{overview.active}</strong></span>
            <span><small>已完成</small><strong>{overview.completed}</strong></span>
            <span><small>已归档</small><strong>{overview.archived}</strong></span>
            <Link to="/projects">全部制作<ArrowRight aria-hidden="true" size={15} /></Link>
          </section> : null}
        </header>
        {error ? <div className="home-error" role="alert"><span>{error}</span><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重新连接</button></div> : null}
        {loading ? <p className="home-loading" role="status">正在读取你的作品…你也可以先选择上面的创作入口。</p> : null}

      {currentRun ? (
        <section className={`home-continuation${currentRun.videoContentUrl ? " has-preview" : ""}`} aria-labelledby="continue-title">
          <HomeScreening run={currentRun} key={currentRun.id} />
          <div className="home-continuation-copy">
            <div className="home-work-topline"><p className="home-work-label">{currentRun.status === "succeeded" ? "最近完成" : "继续上次工作"}</p><StatusBadge status={currentRun.status} {...(creatorRunStatusLabel(currentRun) ? { label: creatorRunStatusLabel(currentRun)! } : {})} /></div>
            <p className="home-work-stage"><FileText aria-hidden="true" size={21} />{isHistoricalReadOnlyRun(currentRun) ? "旧版制作记录" : runNodeLabel(currentRun.currentNodeId)}</p>
            <h2 id="continue-title">{currentRun.title}</h2>
            <p className="home-work-message">{continueMessage(currentRun)}</p>
            <div className="home-work-spec"><span><Clock3 aria-hidden="true" size={15} />目标 {currentRun.durationSeconds} 秒</span><span>{platformLabel(currentRun.platform)}</span>{currentRun.runPurpose === "test" ? <span>测试记录</span> : null}</div>
            <Link className="button button-primary" to={`/projects/${currentRun.id}`}>{continueAction(currentRun)}<ArrowRight aria-hidden="true" size={16} /></Link>
          </div>
        </section>
      ) : !loading && !error ? (
        <section className="home-empty-work" aria-labelledby="first-work-title">
          <span className="home-empty-icon" aria-hidden="true"><Clapperboard size={30} strokeWidth={1.3} /></span>
          <div><h3 id="first-work-title">第一部作品，从一个想法开始</h3><p>选择上方入口开始创作，脚本、画面与每次确认都会保留在这里。</p></div>
          <Link to="/topics?mode=manual"><Plus aria-hidden="true" size={18} />开始创作</Link>
        </section>
      ) : null}

      {!loading && !error && recentRuns.length > 0 ? <section className="home-recent" aria-labelledby="home-recent-title">
        <header><h2 id="home-recent-title">留在工作台上的</h2><Link to="/projects">全部制作<ArrowRight aria-hidden="true" size={15} /></Link></header>
        <div className="home-recent-list">{recentRuns.map((run) => <Link to={`/projects/${run.id}`} key={run.id} className="home-recent-run">
          <span className="home-recent-icon" aria-hidden="true">{run.videoContentUrl ? <Film size={23} /> : <FileText size={23} />}</span>
          <span className="home-recent-copy"><strong>{run.title}</strong><small>{isHistoricalReadOnlyRun(run) ? "旧版制作记录" : runNodeLabel(run.currentNodeId)} · 目标 {run.durationSeconds} 秒</small></span>
          <StatusBadge status={run.status} {...(creatorRunStatusLabel(run) ? { label: creatorRunStatusLabel(run)! } : {})} />
          <ArrowRight aria-hidden="true" size={17} />
        </Link>)}</div>
      </section> : null}
      </section>
    </main>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6 || hour >= 18) return "晚上好";
  if (hour < 12) return "上午好";
  return "下午好";
}

function HomeScreening({ run }: { run: StudioRunSummary }) {
  const [failedSource, setFailedSource] = useState<string>();
  const hasPreview = Boolean(run.videoContentUrl);
  const previewFailed = hasPreview && failedSource === run.videoContentUrl;
  return <div className={`home-screening${hasPreview ? " has-media" : " is-waiting"}`}>
    <div className="home-screening-header"><span><Clapperboard aria-hidden="true" size={18} />放映室</span><span>{hasPreview ? "已有视频" : "尚无成片"}</span></div>
    {hasPreview && !previewFailed ? <div className="home-work-preview"><video controls muted playsInline preload="metadata" src={`${run.videoContentUrl}#t=0.1`} aria-label={`${run.title} 预览`} onError={() => setFailedSource(run.videoContentUrl)} /></div> : <div className="home-screening-copy" {...(previewFailed ? { role: "status" } : {})}>
      <Film aria-hidden="true" size={30} strokeWidth={1.4} />
      <strong>{previewFailed ? "视频暂时未能加载" : "画面留给下一步"}</strong>
      <p>{previewFailed ? "制作记录仍保留，可以打开作品查看已有结果。" : "这条制作还没有可播放的成片。先继续当前步骤，已有内容会保留在作品中。"}</p>
      {previewFailed ? <button type="button" className="home-preview-retry" onClick={() => setFailedSource(undefined)}><RefreshCw aria-hidden="true" size={15} />重新加载预览</button> : null}
    </div>}
    <div className="home-screening-footer"><span>{hasPreview ? "完整画面 · 由你播放" : "工作室光圈 · 装饰"}</span><span>{hasPreview ? "保留原始比例" : "已有结果以制作记录为准"}</span></div>
  </div>;
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
  if (run.status === "approval_invalidated") return "之前的费用确认已失效。先查看发生变化的内容，再决定是否重新确认费用。";
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
