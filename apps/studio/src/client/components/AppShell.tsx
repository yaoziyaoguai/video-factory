import { ChartNoAxesCombined, ChevronDown, CircleHelp, Clapperboard, Images, Layers3, LogOut, Moon, Radar, Search, Settings2, Sun, UserRound } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { studioApi } from "../api.js";
import { GuideDock } from "../onboarding/GuideDock.js";
import { useCreatorTour } from "../onboarding/use-creator-tour.js";
import { useStudioAppearance } from "../studio-appearance.js";
import { StudioSearchDialog } from "./StudioSearchDialog.js";

const navigation = [
  { to: "/", label: "创作台", icon: Radar },
  { to: "/projects", label: "制作记录", icon: Layers3 },
  { to: "/assets", label: "素材库", icon: Images },
  { to: "/resources", label: "创作设置", icon: Settings2 },
  { to: "/experiments", label: "制作复盘", icon: ChartNoAxesCombined },
] as const;

export function AppShell({ children, username, onLogout }: { children: ReactNode; username?: string; onLogout?(): Promise<void> }) {
  const [healthy, setHealthy] = useState<boolean>();
  const [guideOpen, setGuideOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [appearance, setAppearance] = useStudioAppearance();
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const topicMode = new URLSearchParams(location.search).get("mode");
  const isTrendWorkspace = location.pathname === "/topics" && !["series", "manual", "custom"].includes(topicMode ?? "");
  const isCreationEntry = location.pathname === "/topics" || location.pathname === "/cases";
  const previousPath = useRef(location.pathname);
  const { startFullTour, startPageTour } = useCreatorTour();
  const workspaceLabel = location.pathname.startsWith("/projects/") ? "作品工作区"
    : ({ "/": "创作台", "/projects": "制作记录", "/assets": "素材库", "/resources": "创作设置", "/experiments": "制作复盘", "/topics": "选题与构思", "/cases": "案例与脚本" }[location.pathname] ?? "创作空间");
  useEffect(() => {
    void studioApi.health().then((health) => setHealthy(health.status === "ok")).catch(() => setHealthy(false));
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (previousPath.current !== location.pathname) {
      contentRef.current?.focus({ preventScroll: true });
      previousPath.current = location.pathname;
    }
  }, [location.pathname]);

  const openSearch = useCallback(() => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      searchReturnFocusRef.current = document.activeElement;
    }
    setSearchOpen(true);
  }, []);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!document.querySelector('[role="dialog"]')) openSearch();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openSearch]);

  return (
    <div className={`app-shell studio-v3 studio-creation-shell${location.pathname === "/" ? " studio-home-shell" : " studio-content-shell"}${location.pathname.startsWith("/projects/") ? " studio-production-shell" : ""}${isTrendWorkspace ? " studio-trend-shell" : ""}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="studio-masthead">
        <NavLink className="brand" to="/" aria-label="VideoFactory 创作台">
          <span className="brand-mark"><Clapperboard aria-hidden="true" size={25} strokeWidth={1.5} /></span>
          <span className="home-brand-copy"><strong>VideoFactory</strong><small>让好故事被看见</small></span>
        </NavLink>
        <nav className="primary-nav" aria-label="主导航" data-tour="primary-nav">
          {navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive || (to === "/" && isCreationEntry) ? "active" : undefined} aria-label={label} title={label} {...(to === "/projects" ? { "data-tour": "projects-nav" } : {})}>
            {({ isActive }) => <>{isActive || (to === "/" && isCreationEntry) ? <motion.span className="studio-nav-marker" layoutId="studio-nav-marker" /> : null}<Icon aria-hidden="true" size={21} strokeWidth={1.6} /><span>{label}</span></>}
          </NavLink>)}
        </nav>
        <div className="studio-topbar">
          <div className="studio-wordmark">VideoFactory<span>影像创作</span></div>
          <div className="studio-workspace-context" aria-label="当前工作区"><span>工作室</span><span aria-hidden="true">/</span><strong>{workspaceLabel}</strong></div>
          <div className="studio-masthead-tools">
            <button className="studio-search-trigger" type="button" onClick={openSearch} aria-label="搜索项目、选题或功能" title="搜索项目、选题或功能">
              <Search aria-hidden="true" size={18} /><span>搜索作品、选题…</span><kbd>{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"} K</kbd>
            </button>
            <div className="studio-appearance" role="group" aria-label="界面外观">
              <button type="button" aria-label="日光外观" title="日光外观" aria-pressed={appearance === "light"} onClick={() => setAppearance("light")}><Sun aria-hidden="true" size={17} /></button>
              <button type="button" aria-label="暗房外观" title="暗房外观" aria-pressed={appearance === "dark"} onClick={() => setAppearance("dark")}><Moon aria-hidden="true" size={17} /></button>
            </div>
            <button className="tour-help-button" type="button" onClick={() => setGuideOpen(true)} title="打开创作向导" aria-label="打开创作向导"><CircleHelp aria-hidden="true" size={20} /><span>向导</span></button>
            {onLogout ? <AccountMenu username={username ?? "当前账号"} onLogout={onLogout} /> : null}
          </div>
        </div>
        <div className="home-sidebar-note"><Clapperboard aria-hidden="true" size={22} strokeWidth={1.3} /><p>好的生活<br />值得被记录</p><small>用影像，让平凡的日常<br />发出微光。</small></div>
        <div className="studio-status" role="status" aria-label="基础工具检查" title="仅检查 Python、FFmpeg、FFprobe 的可执行文件是否可访问，不代表模型、配音与成片合成能力可用。">
          <span aria-hidden="true" className={`health-dot ${healthy === undefined ? "health-checking" : healthy === false ? "health-down" : ""}`} />
          <span>{healthy === undefined ? "检查基础工具" : healthy ? "基础工具可用" : "基础工具需检查"}</span>
        </div>
      </header>
      <div id="main-content" ref={contentRef} className="content-shell" tabIndex={-1}>{children}</div>
      <GuideDock open={guideOpen} pathname={location.pathname} onOpenChange={setGuideOpen} onStartFullTour={startFullTour} onStartPageTour={startPageTour} />
      <StudioSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} returnFocus={searchReturnFocusRef} content={contentRef} />
    </div>
  );
}

function AccountMenu({ username, onLogout }: { username: string; onLogout(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => { window.removeEventListener("keydown", closeOnEscape); document.removeEventListener("pointerdown", closeOutside); };
  }, [open]);
  const logout = async () => {
    setPending(true);
    try { await onLogout(); } finally { setPending(false); setOpen(false); }
  };
  return (
    <div ref={menuRef} className="studio-account" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      <button ref={triggerRef} className="studio-account-trigger" type="button" aria-label={`账号菜单：${username}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <UserRound aria-hidden="true" size={19} /><span>{username}</span><ChevronDown aria-hidden="true" size={14} />
      </button>
      {open ? <div className="studio-account-popover" role="menu" aria-label="账号菜单">
        <div className="studio-account-identity"><small>当前账号</small><strong>{username}</strong></div>
        <button type="button" role="menuitem" onClick={() => void logout()} disabled={pending}><LogOut aria-hidden="true" size={16} /><span>{pending ? "正在退出..." : "退出登录"}</span></button>
      </div> : null}
    </div>
  );
}
