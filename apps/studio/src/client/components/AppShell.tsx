import { Boxes, ChartNoAxesCombined, CircleHelp, Clapperboard, Layers3, LogOut, Radar, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { studioApi } from "../api.js";
import { GuideDock } from "../onboarding/GuideDock.js";
import { useCreatorTour } from "../onboarding/use-creator-tour.js";

export function AppShell({ children, username, onLogout }: { children: ReactNode; username?: string; onLogout?(): Promise<void> }) {
  const [healthy, setHealthy] = useState<boolean>();
  const [guideOpen, setGuideOpen] = useState(false);
  const location = useLocation();
  const { startFullTour, startPageTour } = useCreatorTour();
  const today = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date());
  useEffect(() => {
    void studioApi.health().then((health) => setHealthy(health.status === "ok")).catch(() => setHealthy(false));
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  return (
    <div className="app-shell studio-v3">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="studio-sidebar">
        <NavLink className="brand" to="/" aria-label="VideoFactory 今日机会">
          <span className="brand-mark"><Clapperboard aria-hidden="true" size={19} /></span>
          <span><strong>VideoFactory</strong><small>Creator Studio</small></span>
        </NavLink>
        <div className="sidebar-pulse">
          <Sparkles aria-hidden="true" size={15} />
          <span><small>{today} · 今日创作</small><strong>从证据走到成片</strong></span>
        </div>
        <nav className="primary-nav" aria-label="主导航" data-tour="primary-nav">
          <NavLink to="/" end><Radar aria-hidden="true" size={18} /><span>今日机会</span></NavLink>
          <NavLink to="/projects" data-tour="projects-nav"><Layers3 aria-hidden="true" size={18} /><span>制作记录</span></NavLink>
          <NavLink to="/resources"><Boxes aria-hidden="true" size={18} /><span>素材与模型</span></NavLink>
          <NavLink to="/experiments"><ChartNoAxesCombined aria-hidden="true" size={18} /><span>制作复盘</span></NavLink>
        </nav>
        <div className="sidebar-footer">
          <button className="tour-help-button" type="button" onClick={() => setGuideOpen(true)} title="打开创作向导" aria-label="打开创作向导">
            <CircleHelp aria-hidden="true" size={17} /><span>创作向导</span>
          </button>
          <div className="studio-status" title={healthy ? "制作服务就绪" : "运行环境状态"}>
            <span className={`health-dot ${healthy === false ? "health-down" : ""}`} />
            <span>{healthy === undefined ? "检查服务" : healthy ? "制作服务就绪" : "服务需要检查"}</span>
          </div>
          {onLogout ? <button className="studio-logout" type="button" onClick={() => void onLogout()} title="退出登录"><LogOut aria-hidden="true" size={16} /><span>{username ?? "退出登录"}</span></button> : null}
        </div>
      </aside>
      <header className="mobile-studio-header">
        <NavLink className="brand" to="/" aria-label="VideoFactory 今日机会">
          <span className="brand-mark"><Clapperboard aria-hidden="true" size={18} /></span>
          <strong>VideoFactory</strong>
        </NavLink>
        <div className="mobile-header-actions">
          <span className={`health-dot ${healthy === false ? "health-down" : ""}`} title={healthy ? "制作服务就绪" : "运行环境状态"} />
          <button className="tour-help-button" type="button" onClick={() => setGuideOpen(true)} title="打开创作向导" aria-label="打开创作向导"><CircleHelp aria-hidden="true" size={19} /></button>
          {onLogout ? <button className="tour-help-button" type="button" onClick={() => void onLogout()} title="退出登录" aria-label="退出登录"><LogOut aria-hidden="true" size={18} /></button> : null}
        </div>
      </header>
      <div id="main-content" className="content-shell" tabIndex={-1}>{children}</div>
      <nav className="mobile-nav" aria-label="移动端主导航">
        <NavLink to="/" end><Radar aria-hidden="true" size={19} /><span>今日</span></NavLink>
        <NavLink to="/projects" data-tour="projects-nav"><Layers3 aria-hidden="true" size={19} /><span>制作</span></NavLink>
        <NavLink to="/resources"><Boxes aria-hidden="true" size={19} /><span>资源</span></NavLink>
        <NavLink to="/experiments"><ChartNoAxesCombined aria-hidden="true" size={19} /><span>复盘</span></NavLink>
      </nav>
      <GuideDock
        open={guideOpen}
        pathname={location.pathname}
        onOpenChange={setGuideOpen}
        onStartFullTour={startFullTour}
        onStartPageTour={startPageTour}
      />
    </div>
  );
}
