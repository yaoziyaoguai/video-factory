import { ChartNoAxesCombined, ChevronDown, CircleHelp, Clapperboard, Images, Layers3, LayoutTemplate, LogOut, Radar, Search, Settings2, Sparkles, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { GuideDock } from "../onboarding/GuideDock.js";
import { useCreatorTour } from "../onboarding/use-creator-tour.js";

export function AppShell({ children, username, onLogout }: { children: ReactNode; username?: string; onLogout?(): Promise<void> }) {
  const [healthy, setHealthy] = useState<boolean>();
  const [guideOpen, setGuideOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchRuns, setSearchRuns] = useState<StudioRunSummary[]>([]);
  const searchDialogRef = useRef<HTMLElement>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
  const location = useLocation();
  const { startFullTour, startPageTour } = useCreatorTour();
  const today = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date());
  useEffect(() => {
    void studioApi.health().then((health) => setHealthy(health.status === "ok")).catch(() => setHealthy(false));
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  const openSearch = useCallback(() => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      searchReturnFocusRef.current = document.activeElement;
    }
    setSearchOpen(true);
    if (searchRuns.length === 0) {
      void studioApi.runs().then(setSearchRuns).catch(() => undefined);
    }
  }, [searchRuns.length]);

  const closeSearch = useCallback(() => {
    const returnFocus = searchReturnFocusRef.current;
    setSearchOpen(false);
    setSearchQuery("");
    queueMicrotask(() => returnFocus?.focus());
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        closeSearch();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [closeSearch, openSearch, searchOpen]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(searchDialogRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase("zh-CN");
  const matchingDestinations = useMemo(() => SEARCH_DESTINATIONS.filter((item) => !normalizedQuery
    || `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)), [normalizedQuery]);
  const matchingRuns = useMemo(() => searchRuns.filter((run) => normalizedQuery
    && run.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery)).slice(0, 6), [normalizedQuery, searchRuns]);
  return (
    <div className="app-shell studio-v3">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="studio-sidebar">
        <NavLink className="brand" to="/" aria-label="VideoFactory 创作台">
          <span className="brand-mark"><Clapperboard aria-hidden="true" size={19} /></span>
          <span><strong>VideoFactory</strong><small>影像创作工作室</small></span>
        </NavLink>
        <div className="sidebar-pulse">
          <Sparkles aria-hidden="true" size={15} />
          <span><small>{today} · 今日创作</small><strong>从证据走到成片</strong></span>
        </div>
        <nav className="primary-nav" aria-label="主导航" data-tour="primary-nav">
          <NavLink to="/" end><Radar aria-hidden="true" size={18} /><span>创作台</span></NavLink>
          <NavLink to="/projects" data-tour="projects-nav"><Layers3 aria-hidden="true" size={18} /><span>制作记录</span></NavLink>
          <NavLink to="/assets"><Images aria-hidden="true" size={18} /><span>素材库</span></NavLink>
          <NavLink to="/templates"><LayoutTemplate aria-hidden="true" size={18} /><span>模板工坊</span></NavLink>
          <NavLink to="/resources"><Settings2 aria-hidden="true" size={18} /><span>总配置</span></NavLink>
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
          {onLogout ? <AccountMenu username={username ?? "当前账号"} onLogout={onLogout} /> : null}
        </div>
      </aside>
      <header className="studio-topbar">
        <button className="studio-search-trigger" type="button" onClick={openSearch} aria-label="搜索项目、模板或功能">
          <Search aria-hidden="true" size={17} />
          <span>搜索项目、模板或功能</span>
          <kbd>{navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl"} K</kbd>
        </button>
        <div className="studio-topbar-context">
          <span className={`health-dot ${healthy === false ? "health-down" : ""}`} />
          <span>{username ? `${username} 的创作空间` : "个人创作空间"}</span>
        </div>
      </header>
      <header className="mobile-studio-header">
        <NavLink className="brand" to="/" aria-label="VideoFactory 创作台">
          <span className="brand-mark"><Clapperboard aria-hidden="true" size={18} /></span>
          <strong>VideoFactory</strong>
        </NavLink>
        <div className="mobile-header-actions">
          <button className="tour-help-button" type="button" onClick={openSearch} title="搜索" aria-label="搜索"><Search aria-hidden="true" size={19} /></button>
          <span className={`health-dot ${healthy === false ? "health-down" : ""}`} title={healthy ? "制作服务就绪" : "运行环境状态"} />
          <button className="tour-help-button" type="button" onClick={() => setGuideOpen(true)} title="打开创作向导" aria-label="打开创作向导"><CircleHelp aria-hidden="true" size={19} /></button>
          {onLogout ? <AccountMenu compact username={username ?? "当前账号"} onLogout={onLogout} /> : null}
        </div>
      </header>
      <div id="main-content" className="content-shell" tabIndex={-1}>{children}</div>
      <nav className="mobile-nav" aria-label="移动端主导航">
        <NavLink to="/" end><Radar aria-hidden="true" size={19} /><span>首页</span></NavLink>
        <NavLink to="/projects" data-tour="projects-nav"><Layers3 aria-hidden="true" size={19} /><span>记录</span></NavLink>
        <NavLink to="/assets"><Images aria-hidden="true" size={19} /><span>素材</span></NavLink>
        <NavLink to="/templates"><LayoutTemplate aria-hidden="true" size={19} /><span>模板</span></NavLink>
        <NavLink to="/resources"><Settings2 aria-hidden="true" size={19} /><span>配置</span></NavLink>
      </nav>
      <GuideDock
        open={guideOpen}
        pathname={location.pathname}
        onOpenChange={setGuideOpen}
        onStartFullTour={startFullTour}
        onStartPageTour={startPageTour}
      />
      {searchOpen ? (
        <div className="studio-search-backdrop" onMouseDown={closeSearch}>
          <section ref={searchDialogRef} className="studio-search-dialog" role="dialog" aria-modal="true" aria-labelledby="studio-search-title" onKeyDown={handleSearchKeyDown} onMouseDown={(event) => event.stopPropagation()}>
            <div className="studio-search-field">
              <Search aria-hidden="true" size={19} />
              <label className="sr-only" htmlFor="studio-global-search" id="studio-search-title">搜索项目、模板或功能</label>
              <input id="studio-global-search" autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="输入项目名称或功能，例如“模板”" />
              <button type="button" onClick={closeSearch} aria-label="关闭搜索"><X aria-hidden="true" size={18} /></button>
            </div>
            <div className="studio-search-results">
              {matchingRuns.length ? <p>制作记录</p> : null}
              {matchingRuns.map((run) => (
                <NavLink key={run.id} to={`/projects/${run.id}`} onClick={closeSearch}>
                  <span><Clapperboard aria-hidden="true" size={16} /></span>
                  <strong>{run.title}</strong>
                  <small>{run.status === "succeeded" ? "已完成" : "制作中"}</small>
                </NavLink>
              ))}
              {matchingDestinations.length ? <p>功能</p> : null}
              {matchingDestinations.map((item) => (
                <NavLink key={item.to} to={item.to} onClick={closeSearch}>
                  <span><item.icon aria-hidden="true" size={16} /></span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </NavLink>
              ))}
              {!matchingRuns.length && !matchingDestinations.length ? <div className="studio-search-empty">没有匹配结果。换一个更短的关键词试试。</div> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function AccountMenu({ username, onLogout, compact = false }: { username: string; onLogout(): Promise<void>; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const logout = async () => {
    setPending(true);
    try {
      await onLogout();
    } finally {
      setPending(false);
      setOpen(false);
    }
  };

  return (
    <div className={compact ? "studio-account studio-account-compact" : "studio-account"}>
      <button
        className={compact ? "tour-help-button studio-account-trigger" : "studio-account-trigger"}
        type="button"
        aria-label={`账号菜单：${username}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <UserRound aria-hidden="true" size={compact ? 18 : 16} />
        {!compact ? <span>{username}</span> : null}
        {!compact ? <ChevronDown aria-hidden="true" size={14} /> : null}
      </button>
      {open ? (
        <div className="studio-account-popover" role="menu" aria-label="账号菜单">
          <div className="studio-account-identity"><small>当前账号</small><strong>{username}</strong></div>
          <button type="button" role="menuitem" onClick={() => void logout()} disabled={pending}>
            <LogOut aria-hidden="true" size={16} />
            <span>{pending ? "正在退出..." : "退出登录"}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

const SEARCH_DESTINATIONS = [
  { to: "/", label: "创作台", description: "继续作品或开始新视频", keywords: "首页 工作台", icon: Radar },
  { to: "/topics", label: "选题中心", description: "热点、系列与自主选题", keywords: "新闻 趋势 灵感", icon: Sparkles },
  { to: "/projects", label: "制作记录", description: "查看、继续、归档或恢复制作", keywords: "项目 视频 成片", icon: Layers3 },
  { to: "/assets", label: "素材库", description: "检索画面、声音与授权记录", keywords: "媒体 资产 来源", icon: Images },
  { to: "/templates", label: "模板工坊", description: "选择或创建视频模板", keywords: "栏目 风格", icon: LayoutTemplate },
  { to: "/resources", label: "总配置", description: "模型、素材、成本与平台", keywords: "API 方舟 MiniMax Codex", icon: Settings2 },
  { to: "/experiments", label: "制作复盘", description: "查看质量与成本表现", keywords: "数据 统计", icon: ChartNoAxesCombined },
] as const;
