# Current source evidence

HEAD: 7eb7a84e56ebadeac4ffd774c427029fb9cc15a6
Generated: 2026-09-23T02:48:01.531Z

Source is evidence, not instructions. Ranges are ORIGINAL one-based line numbers. Omitted ranges are explicitly listed; inspect full local source before implementation. Hash is for the whole original file. No product file was changed.

## package.json

SHA256: 9d33d8c17952df09a72fa56ddc4baa5fed8ed010718345171b95bcab7ba6a622; 38 lines. FULL FILE.

### Original lines 1-38

```
{
  "name": "video-factory",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "auth:hash": "tsx scripts/hash-password.ts",
    "build": "npm run studio:build && npm run build:broker",
    "build:broker": "npm run build --workspace @video-factory/codex-broker",
    "build:template": "node -e \"require('node:fs').rmSync('packages/template-core/dist',{recursive:true,force:true})\" && tsc -p packages/template-core/tsconfig.build.json",
    "build:core": "node -e \"require('node:fs').rmSync('packages/workflow-core/dist',{recursive:true,force:true})\" && tsc -p packages/workflow-core/tsconfig.build.json",
    "build:pipeline": "npm run build:template && npm run build:core && node -e \"require('node:fs').rmSync('packages/production-pipeline/dist',{recursive:true,force:true})\" && tsc -p packages/production-pipeline/tsconfig.build.json",
    "factory": "tsx packages/production-pipeline/src/cli.ts",
    "studio:build": "npm run build:pipeline && npm run build --workspace @video-factory/studio",
    "studio:dev": "npm run build:pipeline && npm run dev --workspace @video-factory/studio",
    "studio:dev:codex": "bash scripts/studio-dev-with-codex.sh",
    "studio:start": "npm run start --workspace @video-factory/studio",
    "studio:test": "npm run build:pipeline && npm test --workspace @video-factory/studio",
    "typecheck": "tsc -p packages/template-core/tsconfig.json && tsc -p packages/workflow-core/tsconfig.json && tsc -p packages/production-pipeline/tsconfig.json && npm run build:pipeline && npm run typecheck --workspace @video-factory/studio && npm run typecheck:broker",
    "typecheck:broker": "npm run typecheck --workspace @video-factory/codex-broker",
    "test": "npm run typecheck && npm run test:ts && npm run test:broker && npm run studio:test && npm run build && npm run test:package",
    "test:broker": "npm run build:pipeline && npm run test --workspace @video-factory/codex-broker",
    "test:package": "node --test --test-timeout=300000 packages/*/test/*.test.mjs",
    "test:e2e": "npm run build:core && VIDEO_FACTORY_E2E=1 node --test --import tsx packages/production-pipeline/test/e2e.real.test.ts",
    "test:ts": "npm run build:core && node --test --test-timeout=300000 --import tsx packages/*/test/*.test.ts"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "jsdom": "^29.1.1",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0"
  }
}

```

## apps/studio/package.json

SHA256: 528f02c5776ee519a14f7dcb5e918dd9763323d0dddcd3495d9a5188a4f33049; 47 lines. FULL FILE.

### Original lines 1-47

```
{
  "name": "@video-factory/studio",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build && tsc -p tsconfig.server.build.json",
    "dev": "concurrently --kill-others --names api,web --prefix-colors blue,green \"npm:dev:server\" \"npm:dev:client\"",
    "dev:client": "vite --host 127.0.0.1",
    "dev:server": "STUDIO_DEV=1 tsx watch src/server/main.ts",
    "start": "node dist/server/server/main.js",
    "test": "vitest run && node --import tsx --test --test-timeout=300000 test/model-connections.test.ts test/audio-review-service.test.ts test/api-contract.test.ts test/auth.test.ts test/candidate-inbox.test.ts test/case-api.test.ts test/case-source.test.ts test/codex-provider-settings.test.ts test/cost-studio.test.ts test/creator-settings-store.test.ts test/editorial-decision.test.ts test/local-capabilities.test.ts test/opportunity-store.test.ts test/production-authorization-api.test.ts test/production-joint-rework.test.ts test/production-planning-editing.test.ts test/production-planning-stages.test.ts test/production-worker.test.ts test/publishing-studio.test.ts test/reference-video-store.test.ts test/resource-governance-studio.test.ts test/review-media-preprocessor.test.ts test/role-agent-assembly.test.ts test/scene-resource-revision.test.ts test/series-planner.test.ts test/series-planning-agent.test.ts test/series-store.test.ts test/server.test.ts test/studio-service.test.ts test/template-catalog.test.ts test/template-store.test.ts test/text-task-production-recovery.test.ts test/text-task-recovery-receipt.cross.test.ts test/topic-taxonomy.test.ts test/trend-article-reader.test.ts test/trend-gateway.test.ts test/trend-opportunity-agent.test.ts test/trend-studio.test.ts test/visual-plan.test.ts",
    "typecheck": "tsc -p tsconfig.server.json && tsc -p tsconfig.client.json"
  },
  "dependencies": {
    "@fastify/static": "^10.1.3",
    "@fontsource-variable/manrope": "^5.3.0",
    "@fontsource-variable/noto-sans-sc": "^5.3.0",
    "@fontsource-variable/noto-serif-sc": "^5.3.0",
    "@mozilla/readability": "^0.6.0",
    "@video-factory/production-pipeline": "0.1.0",
    "@video-factory/template-core": "0.1.0",
    "@video-factory/workflow-core": "0.1.0",
    "driver.js": "^1.8.0",
    "fastify": "^5.12.1",
    "jsdom": "^29.1.1",
    "lucide-react": "^1.33.0",
    "proper-lockfile": "^4.1.2",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "react-router-dom": "^7.13.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.5",
    "@types/jsdom": "^21.1.7",
    "@types/proper-lockfile": "^4.1.4",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^5.1.4",
    "concurrently": "^10.0.5",
    "vite": "^8.2.2",
    "vitest": "^4.1.11"
  }
}

```

## apps/studio/src/client/main.tsx

SHA256: 55531e08f67aed861a7444a4f75a9c627c028e1dcf510cfc85495a680ba8d157; 26 lines. FULL FILE.

### Original lines 1-26

```
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/manrope";
import "@fontsource-variable/noto-sans-sc";
import "driver.js/dist/driver.css";
import { App } from "./App.js";
import "./styles.css";
import "./studio-v3.css";
import "./creator-tour.css";
import "./auth.css";
import "./studio-cplus.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Studio root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

```

## apps/studio/src/client/App.tsx

SHA256: 93bbeeb599ae66b3876a3c003448222562c7701edad0a31e65e3c6a0dab589e9; 49 lines. FULL FILE.

### Original lines 1-49

```
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { AppShell } from "./components/AppShell.js";
import { ExperimentsPage } from "./pages/ExperimentsPage.js";
import { AssetsPage } from "./pages/AssetsPage.js";
import { CasesPage } from "./pages/CasesPage.js";
import { HomePage } from "./pages/HomePage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ResourcesPage } from "./pages/ResourcesPage.js";
import { RunPage } from "./pages/RunPage.js";
import { TodayPage } from "./pages/TodayPage.js";
import { TemplatesPage } from "./pages/TemplatesPage.js";

export function App() {
  return (
    <AuthGate>
      {({ username, logout }) => (
        <AppShell {...(username ? { username } : {})} {...(logout ? { onLogout: logout } : {})}>
          <StudioRoutes />
        </AppShell>
      )}
    </AuthGate>
  );
}

function StudioRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/topics" element={<TodayPage />} />
      <Route path="/cases" element={<CasesPage />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/:runId" element={<RunPage />} />
      <Route path="/assets" element={<AssetsPage />} />
      <Route path="/templates" element={<TemplatesPage />} />
      <Route path="/resources" element={<ResourcesPage />} />
      <Route path="/experiments" element={<ExperimentsPage />} />
      <Route path="/runs/:runId" element={<LegacyRunRedirect />} />
      <Route path="/providers" element={<Navigate to="/resources" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function LegacyRunRedirect() {
  const { runId } = useParams();
  return <Navigate to={runId ? `/projects/${runId}` : "/projects"} replace />;
}

```

## apps/studio/src/client/components/AppShell.tsx

SHA256: a28c7c53ddf71346311dec0fe564215121405083024af529381ff354360ea973; 314 lines. FULL FILE.

### Original lines 1-314

```
import { ChartNoAxesCombined, ChevronDown, CircleHelp, Clapperboard, Images, Layers3, LayoutTemplate, LogOut, Radar, Search, Settings2, Sparkles, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { StudioOpportunity, StudioRunSummary, StudioTemplate } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { GuideDock } from "../onboarding/GuideDock.js";
import { useCreatorTour } from "../onboarding/use-creator-tour.js";
import { statusLabel } from "./StatusBadge.js";

export function AppShell({ children, username, onLogout }: { children: ReactNode; username?: string; onLogout?(): Promise<void> }) {
  const [healthy, setHealthy] = useState<boolean>();
  const [guideOpen, setGuideOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchRuns, setSearchRuns] = useState<StudioRunSummary[]>([]);
  const [searchTemplates, setSearchTemplates] = useState<StudioTemplate[]>([]);
  const [searchOpportunities, setSearchOpportunities] = useState<StudioOpportunity[]>([]);
  const [searchLoaded, setSearchLoaded] = useState(false);
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
    // 搜索范围 = 制作记录 + 选题机会 + 当前有效模板 + 功能入口；首次打开时一次性装配。
    if (!searchLoaded) {
      setSearchLoaded(true);
      void Promise.all([
        studioApi.runs().then(setSearchRuns).catch(() => undefined),
        studioApi.templates().then((catalog) => setSearchTemplates(catalog.templates)).catch(() => undefined),
        studioApi.opportunities().then(setSearchOpportunities).catch(() => undefined),
      ]);
    }
  }, [searchLoaded]);

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
  const matchingOpportunities = useMemo(() => searchOpportunities
    // 只有还没进入制作的选题留在选题中心；已有制作记录的机会通过制作记录搜到。
    .filter((item) => (item.status === "draft" || item.status === "shortlisted")
      && !searchRuns.some((run) => run.opportunityId === item.id))
    .filter((item) => normalizedQuery
      && `${item.title} ${item.hook} ${item.audience}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    .slice(0, 5), [normalizedQuery, searchOpportunities, searchRuns]);
  const matchingTemplates = useMemo(() => searchTemplates.filter((item) => normalizedQuery
    && `${item.name} ${item.description}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)).slice(0, 5), [normalizedQuery, searchTemplates]);
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
          <NavLink to="/templates"><LayoutTemplate aria-hidden="true" size={18} /><span>模板资料</span></NavLink>
          <NavLink to="/resources"><Settings2 aria-hidden="true" size={18} /><span>创作设置</span></NavLink>
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
        <button className="studio-search-trigger" type="button" onClick={openSearch} aria-label="搜索项目、选题、模板或功能">
          <Search aria-hidden="true" size={17} />
          <span>搜索项目、选题、模板或功能</span>
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
        <NavLink to="/templates"><LayoutTemplate aria-hidden="true" size={19} /><span>模板资料</span></NavLink>
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
              <label className="sr-only" htmlFor="studio-global-search" id="studio-search-title">搜索项目、选题、模板或功能</label>
              <input id="studio-global-search" autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索制作记录、选题、模板或功能" />
              <button type="button" onClick={closeSearch} aria-label="关闭搜索"><X aria-hidden="true" size={18} /></button>
            </div>
            <div className="studio-search-results">
              {matchingRuns.length ? <p>制作记录</p> : null}
              {matchingRuns.map((run) => (
                <NavLink key={run.id} to={`/projects/${run.id}`} onClick={closeSearch}>
                  <span><Clapperboard aria-hidden="true" size={16} /></span>
                  <div className="studio-search-result-copy">
                    <strong>{run.title}</strong>
                    <small>{formatSearchRunTime(run.startedAt)}</small>
                  </div>
                  <small>{statusLabel(run.status)}</small>
                </NavLink>
              ))}
              {matchingOpportunities.length ? <p>选题机会</p> : null}
              {matchingOpportunities.map((item) => (
                <NavLink key={item.id} to={opportunitySearchTarget(item)} onClick={closeSearch}>
                  <span><Sparkles aria-hidden="true" size={16} /></span>
                  <div className="studio-search-result-copy">
                    <strong>{item.title}</strong>
                    <small>{opportunityOriginLabel(item.origin)} · 待制作</small>
                  </div>
                  <small>去继续</small>
                </NavLink>
              ))}
              {matchingTemplates.length ? <p>模板</p> : null}
              {matchingTemplates.map((item) => (
                <NavLink key={item.id} to={`/templates?template=${encodeURIComponent(item.id)}`} onClick={closeSearch}>
                  <span><LayoutTemplate aria-hidden="true" size={16} /></span>
                  <div className="studio-search-result-copy">
                    <strong>{item.name}</strong>
                    <small>{item.builtIn ? "内置模板" : item.status === "draft" ? "草稿" : "已发布"}</small>
                  </div>
                  <small>打开</small>
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
              {!matchingRuns.length && !matchingOpportunities.length && !matchingTemplates.length && !matchingDestinations.length ? <div className="studio-search-empty">没有匹配的制作记录、选题机会、模板或功能。换一个更短的关键词试试。</div> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function formatSearchRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// 选题机会按来源跳到对应入口，并用 opportunity 参数直接选中该机会。
function opportunitySearchTarget(opportunity: StudioOpportunity): string {
  if (opportunity.origin === "series") return `/topics?mode=series&opportunity=${encodeURIComponent(opportunity.id)}`;
  if (opportunity.origin === "manual") return `/topics?mode=custom&opportunity=${encodeURIComponent(opportunity.id)}`;
  return `/topics?opportunity=${encodeURIComponent(opportunity.id)}`;
}

function opportunityOriginLabel(origin: StudioOpportunity["origin"] | undefined): string {
  if (origin === "series") return "系列";
  if (origin === "manual") return "自有想法";
  return "热点";
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
  { to: "/resources#voice-casting", label: "声音演员与配音设置", description: "选择声音演员，调整语速、停顿与音色", keywords: "声音 配音 音色 演员 语速 停顿", icon: Settings2 },
  { to: "/", label: "创作台", description: "继续作品或开始新视频", keywords: "首页 工作台", icon: Radar },
  { to: "/topics", label: "选题中心", description: "热点、系列与自主选题", keywords: "新闻 趋势 灵感", icon: Sparkles },
  { to: "/projects", label: "制作记录", description: "查看、继续、归档或恢复制作", keywords: "项目 视频 成片", icon: Layers3 },
  { to: "/assets", label: "素材库", description: "检索画面、声音与授权记录", keywords: "媒体 资产 来源", icon: Images },
  { to: "/templates", label: "模板资料", description: "管理暂不参与制作的模板资料", keywords: "栏目 风格", icon: LayoutTemplate },
  { to: "/resources", label: "创作设置", description: "模型、素材、费用与发布平台", keywords: "总配置 API 方舟 MiniMax Codex", icon: Settings2 },
  { to: "/experiments", label: "制作复盘", description: "查看质量与费用表现", keywords: "数据 统计", icon: ChartNoAxesCombined },
] as const;

```

## apps/studio/src/client/pages/HomePage.tsx

SHA256: 9a119a0db50a539a323ddb8f5111816d7c140362b6d13058f43f8119d9160462; 128 lines. FULL FILE.

### Original lines 1-128

```
import { ArrowRight, Clapperboard, Flame, Lightbulb, ListVideo, Play, Plus, RefreshCw } from "lucide-react";
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
          <p className="eyebrow">今日创作台</p>
          <h1>从一个想法，到一条成片。</h1>
          <p>选择一种开始方式。系统会沿同一条制作线推进；需要生成付费图片或视频时，会先报价并等你确认。</p>
        </div>
        <time>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</time>
      </header>

      {error ? <div className="home-error" role="alert"><span>{error}</span><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重新连接</button></div> : null}

      {runs.length ? <section className="home-production-overview" aria-label="制作概况">
        <span><small>待你处理</small><strong>{overview.attention}</strong></span>
        <span><small>自动制作</small><strong>{overview.active}</strong></span>
        <span><small>已完成</small><strong>{overview.completed}</strong></span>
        <span><small>已归档</small><strong>{overview.archived}</strong></span>
      </section> : null}

      {currentRun ? (
        <section className="home-continuation" aria-labelledby="continue-title">
          <div className="home-section-number">01</div>
          <div className="home-continuation-copy">
            <p className="eyebrow">继续上次工作</p>
            <h2 id="continue-title">{currentRun.title}</h2>
            <div><StatusBadge status={currentRun.status} {...(creatorRunStatusLabel(currentRun) ? { label: creatorRunStatusLabel(currentRun)! } : {})} /><span>{continueMessage(currentRun)}</span></div>
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
            <span><strong>从自己的想法开始</strong><small>输入主题，需要时添加参考视频</small></span>
            <Plus aria-hidden="true" size={18} />
          </button>
          <button type="button" onClick={() => navigate("/cases")}>
            <span className="home-option-icon is-case"><Clapperboard aria-hidden="true" size={21} /></span>
            <span><strong>从案例 / 脚本开始</strong><small>发现值得借鉴的视频和脚本，开始自己的创作</small></span>
            <ArrowRight aria-hidden="true" size={18} />
          </button>
        </div>
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
  if (run.status === "failed" || run.status === "rejected") return "重新调整";
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
  if (run.status === "failed" || run.status === "rejected") return "这条制作需要调整后重新开始。";
  if (run.status === "paused") return "制作已暂停。先查看已保留的结果，再决定是否恢复。";
  return "当前步骤正在制作，完成后会按流程等待你的确认。";
}

```

## apps/studio/src/client/pages/ProductionPage.tsx

SHA256: 37ede3536e6f06b2e9cec9642b3fb295c79654f239617fc2b78a2aac1d5f16cd; 107 lines. FULL FILE.

### Original lines 1-107

```
import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { StudioCreatorSettings, StudioProductionInput, StudioProvider, StudioRunSummary } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { ProductionQueue } from "../components/ProductionQueue.js";

export function ProductionPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [creatorSettings, setCreatorSettings] = useState<StudioCreatorSettings>();
  const [runsLoading, setRunsLoading] = useState(true);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [runsError, setRunsError] = useState<string>();
  const [providersError, setProvidersError] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();

  const load = useCallback(async () => {
    setRunsLoading(true);
    setProvidersLoading(true);
    setSettingsLoading(true);
    setRunsError(undefined);
    setProvidersError(undefined);
    setSettingsError(undefined);
    await Promise.all([
      studioApi.runs().then(setRuns).catch((caught: unknown) => setRunsError(errorMessage(caught))).finally(() => setRunsLoading(false)),
      studioApi.providers().then(setProviders).catch((caught: unknown) => setProvidersError(errorMessage(caught))).finally(() => setProvidersLoading(false)),
      // 读取失败必须留下可见错误并阻断开工；成功返回（含未自定义的系统默认）才允许带入默认值。
      studioApi.settings().then(setCreatorSettings).catch((caught: unknown) => setSettingsError(errorMessage(caught))).finally(() => setSettingsLoading(false)),
    ]);
  }, []);

  // 原地重读创作设置：成功后用服务端保存值解除阻塞，不要求刷新整页。
  const retrySettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError(undefined);
    try {
      setCreatorSettings(await studioApi.settings());
    } catch (caught: unknown) {
      setSettingsError(errorMessage(caught));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function start(input: StudioProductionInput) {
    const result = await studioApi.start(input);
    setDialogOpen(false);
    navigate(`/projects/${result.runId}`);
  }

  async function remove(run: StudioRunSummary) {
    await studioApi.deleteRun(run.id);
    setRuns((current) => current.filter((item) => item.id !== run.id));
  }

  async function archive(targets: StudioRunSummary[]) {
    await studioApi.archiveRuns(targets.map((run) => run.id));
    const archivedAt = new Date().toISOString();
    const ids = new Set(targets.map((run) => run.id));
    setRuns((current) => current.map((run) => ids.has(run.id) ? { ...run, archivedAt } : run));
  }

  async function restore(targets: StudioRunSummary[]) {
    await studioApi.restoreRuns(targets.map((run) => run.id));
    const ids = new Set(targets.map((run) => run.id));
    setRuns((current) => current.map((run) => {
      if (!ids.has(run.id)) return run;
      const { archivedAt: _archivedAt, ...restored } = run;
      return restored;
    }));
  }

  return (
    <>
      {providersError ? (
        <div className="page-error" role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <span><strong>生产能力状态未知</strong>{providersError}</span>
          <button className="icon-button" type="button" onClick={() => void load()} title="重试"><RefreshCw aria-hidden="true" size={17} /></button>
        </div>
      ) : null}
      {settingsError ? (
        <div className="page-error" role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <span>未能读取你的创作设置，为避免用错声音/平台/时长，暂未开工。{settingsError}</span>
          <button className="button button-secondary" type="button" onClick={() => void retrySettings()}><RefreshCw aria-hidden="true" size={16} />重新读取</button>
        </div>
      ) : null}
      <ProductionQueue runs={runs} loading={runsLoading} {...(runsError ? { error: runsError } : {})} onRetry={() => void load()} onCreate={() => setDialogOpen(true)} onArchive={archive} onRestore={restore} onDelete={remove} />
      <NewRunDialog open={dialogOpen} providers={providersLoading ? [] : providers} initialDataReady={!providersLoading && !settingsLoading && !settingsError} {...(creatorSettings ? { creatorSettings } : {})} {...(settingsError ? { settingsError } : {})} onRetrySettings={() => void retrySettings()} onClose={() => setDialogOpen(false)} onSubmit={start} />
    </>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

```

## apps/studio/src/client/components/ProductionQueue.tsx

SHA256: 9634e99250a4d33eda33d22d0ca2fe4182c7a157cefc574020121f325a6c946d; 289 lines. OMITTED: 241-289.

### Original lines 1-240

```
import { Archive, ArchiveRestore, ArrowRight, Check, Clapperboard, Film, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { StudioRunSummary } from "../../shared/api.js";
import { StatusBadge } from "./StatusBadge.js";
import { creatorReviewAction, creatorRunStatusLabel, isHistoricalReadOnlyRun, platformLabel, RUN_NODE_ORDER, runNeedsCreatorAction, runNodeLabel } from "../presentation.js";

interface ProductionQueueProps {
  runs: StudioRunSummary[];
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  onCreate: () => void;
  onArchive?: (runs: StudioRunSummary[]) => Promise<void>;
  onRestore?: (runs: StudioRunSummary[]) => Promise<void>;
  onDelete?: (run: StudioRunSummary) => Promise<void>;
}

type QueueFilter = "all" | "active" | "review" | "done";
type QueueView = "current" | "archive";

export function ProductionQueue({ runs, loading, error, onRetry, onCreate, onArchive, onRestore, onDelete }: ProductionQueueProps) {
  const [view, setView] = useState<QueueView>("current");
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<StudioRunSummary>();
  const [operationError, setOperationError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12);
  const sortedRuns = useMemo(() => [...runs].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)), [runs]);
  const currentRuns = useMemo(() => sortedRuns.filter((run) => !run.archivedAt), [sortedRuns]);
  const archivedRuns = useMemo(() => sortedRuns.filter((run) => Boolean(run.archivedAt)), [sortedRuns]);
  const visibleRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const base = view === "archive" ? archivedRuns : currentRuns;
    const searched = base.filter((run) => run.title.toLocaleLowerCase().includes(normalizedQuery));
    if (view === "archive") return searched;
    const filtered = searched.filter((run) => matchesFilter(run, filter));
    if (filter !== "all" || normalizedQuery) return filtered;
    // 待你处理的记录（含被打回的作品）不能被“最近完成”截断，否则会从默认视图消失。
    const active = filtered.filter((run) => !isTerminal(run) || runNeedsCreatorAction(run));
    const recentCompleted = filtered.filter((run) => isTerminal(run) && !runNeedsCreatorAction(run)).slice(0, 6);
    return [...active, ...recentCompleted];
  }, [archivedRuns, currentRuns, filter, query, view]);
  const displayedRuns = visibleRuns.slice(0, visibleCount);
  const selectableRuns = visibleRuns.filter((run) => view === "archive" || isTerminal(run));
  const selectedRuns = selectableRuns.filter((run) => selectedIds.has(run.id));
  const activeCount = currentRuns.filter((run) => !isHistoricalReadOnlyRun(run) && (run.status === "pending" || run.status === "running")).length;
  const reviewCount = currentRuns.filter(runNeedsCreatorAction).length;
  const finishedCount = currentRuns.filter((run) => run.status === "succeeded").length;

  useEffect(() => setVisibleCount(12), [filter, query, view]);
  useEffect(() => {
    setSelectedIds(new Set());
    setOperationError(undefined);
  }, [filter, query, view]);

  return (
    <main className="page queue-page">
      <header className="page-header">
        <div>
          <h1>制作记录</h1>
          <p className="page-summary">{reviewCount > 0 ? `${reviewCount} 条制作等你处理。打开作品，接着上次的方案继续。` : "打开作品继续制作，或开始一个新想法。"}</p>
        </div>
        <button className="button button-primary project-create-button" type="button" onClick={onCreate} data-tour="project-create">
          <Plus aria-hidden="true" size={17} />
          新建制作
        </button>
      </header>

      <section className="queue-section" aria-labelledby="today-heading" data-tour="project-queue">
        <div className="project-archive-heading">
          <h2 id="today-heading" className="sr-only">{view === "current" ? "当前制作" : "已归档"}</h2>
          <div className="project-edition" data-tour="project-overview">
            <div><strong>{activeCount}</strong><span>制作中</span></div>
            <div><strong>{reviewCount}</strong><span>待你处理</span></div>
            <div><strong>{finishedCount}</strong><span>近期完成</span></div>
          </div>
          <div className="queue-view-switch" role="group" aria-label="制作记录视图">
            <button type="button" aria-pressed={view === "current"} onClick={() => setView("current")}>当前</button>
            <button type="button" aria-pressed={view === "archive"} onClick={() => setView("archive")}>归档 <span>{archivedRuns.length}</span></button>
          </div>
        </div>
        <div className="project-controls" aria-label="制作记录工具" data-tour="project-controls">
          {view === "current" ? (
            <div className="project-filters" role="group" aria-label="制作筛选">
              {([
                ["all", "重点"],
                ["active", "制作中"],
                ["review", "待你处理"],
                ["done", "已结束"],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={filter === value} aria-label={`筛选：${label}`} onClick={() => setFilter(value)}>{label}</button>
              ))}
            </div>
          ) : <p className="archive-caption">归档只整理列表，不会移动成片或素材。</p>}
          <label className="project-search"><Search aria-hidden="true" size={14} /><span className="sr-only">搜索制作记录</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "archive" ? "搜索归档" : "搜索标题"} /></label>
        </div>
        {selectedRuns.length > 0 ? (
          <div className="queue-selection" role="status">
            <span><Check aria-hidden="true" size={15} />已选 {selectedRuns.length} 条</span>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void organize(selectedRuns)}>
              {view === "archive" ? <ArchiveRestore aria-hidden="true" size={16} /> : <Archive aria-hidden="true" size={16} />}
              {busy ? "正在整理..." : view === "archive" ? "恢复到当前" : "批量归档"}
            </button>
            <button className="icon-button" type="button" aria-label="取消选择" disabled={busy} onClick={() => setSelectedIds(new Set())}><X aria-hidden="true" size={16} /></button>
          </div>
        ) : null}
        {operationError ? <p className="form-error queue-operation-error" role="alert">{operationError}</p> : null}
        {loading ? (
          <div className="queue-placeholder">正在读取制作记录...</div>
        ) : error ? (
          <div className="queue-error" role="alert">
            <Film aria-hidden="true" size={25} />
            <h3>制作记录读取失败</h3>
            <p>{error}</p>
            {onRetry ? <button className="button button-secondary" type="button" onClick={onRetry}>重试</button> : null}
          </div>
        ) : runs.length === 0 ? (
          <div className="empty-state">
            <Film aria-hidden="true" size={25} />
            <h3>还没有制作记录</h3>
            <p>从第一条短视频开始，系统会在这里保留全过程记录。</p>
            <button className="button button-secondary" type="button" onClick={onCreate}><Plus aria-hidden="true" size={17} />新建制作</button>
          </div>
        ) : visibleRuns.length === 0 ? (
          <div className="queue-placeholder">{view === "archive" ? "归档还是空的" : "没有符合当前筛选条件的制作记录"}</div>
        ) : (
          <div className="production-archive" role="list" aria-label={view === "archive" ? "已归档视频制作记录" : "当前视频制作记录"}>
            {displayedRuns.map((run, index) => (
              <article className="project-folio" role="listitem" key={run.id} {...(index === 0 ? { "data-tour": "project-item" } : {})}>
                {(view === "archive" || isTerminal(run)) ? (
                  <label className="queue-select-run">
                    <input type="checkbox" checked={selectedIds.has(run.id)} onChange={() => toggleSelected(run.id)} />
                    <span className="sr-only">选择制作记录：{run.title}</span>
                  </label>
                ) : null}
                <div className={`project-preview is-${run.status}`}>
                  {run.videoContentUrl ? (
                    <video aria-label={`${run.title} 成片预览`} muted playsInline preload="metadata" src={`${run.videoContentUrl}#t=0.1`} />
                  ) : (
                    <div className="project-preview-placeholder" aria-hidden="true"><Clapperboard size={22} /><strong>{String(index + 1).padStart(2, "0")}</strong></div>
                  )}
                  <span>目标 {run.durationSeconds} 秒</span>
                </div>
                <div className="project-folio-copy">
                  <div className="project-folio-meta">
                    <span>{run.runPurpose === "test" ? "测试记录 · " : ""}{platformLabel(run.platform)} · 9:16</span>
                    <time dateTime={run.archivedAt ?? run.startedAt}>{run.archivedAt ? `归档于 ${formatTime(run.archivedAt)}` : formatTime(run.startedAt)}</time>
                  </div>
                  <h3><Link to={`/projects/${run.id}`}>{run.title}</Link></h3>
                  <div className="project-folio-state"><StatusBadge status={run.status} {...(creatorRunStatusLabel(run) ? { label: creatorRunStatusLabel(run)! } : {})} /><span>{isHistoricalReadOnlyRun(run) ? "旧版制作记录" : runNodeLabel(run.currentNodeId)}</span>{run.videoContentUrl ? <span>已有成片可预览</span> : null}</div>
                  {isHistoricalReadOnlyRun(run) ? null : <RunProgress currentNodeId={run.currentNodeId} status={run.status} {...(run.workflowNodeIds ? { workflowNodeIds: run.workflowNodeIds } : {})} />}
                  <div className="project-folio-actions">
                    <Link className="project-folio-action" to={`/projects/${run.id}`} aria-label={runAction(run) ? `${actionLabel(runAction(run)!, run)}：${run.title}` : `查看制作：${run.title}`}>
                      {runAction(run) ? actionLabel(runAction(run)!, run) : run.status === "succeeded" ? "查看成片" : "打开制作记录"}
                      <ArrowRight aria-hidden="true" size={16} />
                    </Link>
                    {view === "current" && onArchive && isTerminal(run) ? (
                      <button className="icon-button" type="button" title="归档" aria-label={`归档制作记录：${run.title}`} disabled={busy} onClick={() => void organize([run])}><Archive aria-hidden="true" size={16} /></button>
                    ) : null}
                    {view === "archive" && onRestore ? (
                      <button className="icon-button" type="button" title="恢复到当前" aria-label={`恢复制作记录：${run.title}`} disabled={busy} onClick={() => void organize([run])}><ArchiveRestore aria-hidden="true" size={16} /></button>
                    ) : null}
                    {view === "archive" && onDelete ? (
                      <button className="icon-button project-delete" type="button" title="永久删除" aria-label={`永久删除制作记录：${run.title}`} onClick={() => { setOperationError(undefined); setDeleteTarget(run); }}><Trash2 aria-hidden="true" size={16} /></button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        {displayedRuns.length < visibleRuns.length ? <button className="project-load-more" type="button" onClick={() => setVisibleCount((count) => count + 12)}>再显示 {Math.min(12, visibleRuns.length - displayedRuns.length)} 条</button> : null}
      </section>
      {deleteTarget ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="reject-dialog delete-run-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-run-title">
            <header className="dialog-header">
              <div><p className="eyebrow">永久删除</p><h2 id="delete-run-title">确定删除“{deleteTarget.title}”吗？</h2></div>
              <button className="icon-button" type="button" aria-label="关闭" disabled={busy} onClick={() => setDeleteTarget(undefined)}><X aria-hidden="true" size={18} /></button>
            </header>
            <p className="delete-run-warning">这会删除该项目的脚本、制作文件、成片，以及调用与费用明细，无法恢复。仅想整理列表时请保留在归档中。</p>
            {operationError ? <p className="form-error" role="alert">{operationError}</p> : null}
            <footer className="dialog-actions">
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => setDeleteTarget(undefined)}>保留归档</button>
              <button className="button button-danger" type="button" disabled={busy} onClick={() => void confirmDelete()}>{busy ? "正在删除..." : "永久删除"}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );

  function toggleSelected(runId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  async function organize(targets: StudioRunSummary[]): Promise<void> {
    const operation = view === "archive" ? onRestore : onArchive;
    if (!operation || targets.length === 0) return;
    setBusy(true);
    setOperationError(undefined);
    try {
      await operation(targets);
      setSelectedIds(new Set());
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || !onDelete) return;
    setBusy(true);
    setOperationError(undefined);
    try {
      await onDelete(deleteTarget);
      setDeleteTarget(undefined);
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
}

function matchesFilter(run: StudioRunSummary, filter: QueueFilter): boolean {
  return filter === "all"
    || (filter === "active" && !isHistoricalReadOnlyRun(run) && (run.status === "pending" || run.status === "running"))
    || (filter === "review" && runNeedsCreatorAction(run))
    || (filter === "done" && isTerminal(run));
}
```

## apps/studio/src/client/pages/RunPage.tsx

SHA256: dfc466238e9ff05f1696214969eb5ff1cd64fb1ca6b07216b7deb884c4651a92; 624 lines. FULL FILE.

### Original lines 1-624

```
import { AlertCircle, ArrowLeft, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { StudioCostRunDetail, StudioCreativeReviewCommandInput, StudioCreativeReviewSnapshot, StudioCreatorSettings, StudioDecisionInput, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioPaidNodeSummary, StudioPaidReconciliationInput, StudioProductionInput, StudioProvider, StudioReworkDraft, StudioRunDetail, StudioNarrationRevisionInput,
  StudioSceneResourceRevisionInput, StudioSceneRevisionInput, StudioSpendAuthorizationInput, StudioSpendRejectionInput, StudioVisualReinspectionInput } from "../../shared/api.js";
import { studioApi, subscribeToRun } from "../api.js";
import { currentScriptArtifact, sceneNarrationText } from "../scene-narration.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { RunWorkbench } from "../components/RunWorkbench.js";
import { CreativeDiscussionPanel } from "../components/CreativeDiscussionPanel.js";
import { MultiPlatformPublishDialog } from "../components/MultiPlatformPublishDialog.js";

export function preferRunSnapshot(current: StudioRunDetail | undefined, next: StudioRunDetail): StudioRunDetail {
  if (!current) return next;
  if (next.revision < current.revision) return current;
  const adopted = next.revision > current.revision ? next : {
    ...next,
    // SSE 是轻量状态通知；同 revision 下不能用它抹掉 GET 详情里才有的规划与恢复证据。
    ...(next.planningStages === undefined && current.planningStages !== undefined
      ? { planningStages: current.planningStages }
      : {}),
    ...(next.taskRecovery === undefined && current.taskRecovery !== undefined
      ? { taskRecovery: current.taskRecovery }
      : {}),
    ...(next.productionPlanDigest === undefined && current.productionPlanDigest !== undefined
      ? { productionPlanDigest: current.productionPlanDigest }
      : {}),
  };
  return withCarriedAgentLoopProgress(current, adopted);
}

/**
 * 把上一次快照里已有的角色审计进度按 nodeId 补回来。SSE 推的是未经富化的 run 详情
 * （富化只在权威 GET 那条路上做），而边界暂停会把 revision 推高——于是"新 revision 赢"
 * 的分支整体采用 SSE 载荷，审计意见在用户正要拿主意的那一刻消失，要等十秒心跳才回来。
 * 只在两次快照属于同一次节点执行（startedAt 相同）时才补：节点重跑会拿到新的
 * startedAt，旧建议不会被复活成当前结论。
 */
function withCarriedAgentLoopProgress(current: StudioRunDetail, next: StudioRunDetail): StudioRunDetail {
  if (!next.nodes.some((node) => node.agentLoopProgress === undefined)) return next;
  const previousByNodeId = new Map(current.nodes.map((node) => [node.id, node]));
  return {
    ...next,
    nodes: next.nodes.map((node) => {
      if (node.agentLoopProgress !== undefined) return node;
      const previous = previousByNodeId.get(node.id);
      if (previous?.agentLoopProgress === undefined || previous.startedAt !== node.startedAt) return node;
      return { ...node, agentLoopProgress: previous.agentLoopProgress };
    }),
  };
}

export function RunPage() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<StudioRunDetail>();
  const [loading, setLoading] = useState(true);
  const [decisionPending, setDecisionPending] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionWarning, setConnectionWarning] = useState<string>();
  const [connectionHeartbeatAt, setConnectionHeartbeatAt] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartProviders, setRestartProviders] = useState<StudioProvider[]>([]);
  const [restartSettings, setRestartSettings] = useState<StudioCreatorSettings>();
  const [restartDraft, setRestartDraft] = useState<StudioReworkDraft>();
  const [costDetail, setCostDetail] = useState<StudioCostRunDetail>();
  const [costError, setCostError] = useState<string>();
  const [nodeMutationPending, setNodeMutationPending] = useState(false);
  const [runProviders, setRunProviders] = useState<StudioProvider[]>([]);
  const [pausePending, setPausePending] = useState(false);
  const [paidNodeSummary, setPaidNodeSummary] = useState<StudioPaidNodeSummary>();
  const [paidOperationError, setPaidOperationError] = useState<string>();
  const [creativeReview, setCreativeReview] = useState<StudioCreativeReviewSnapshot>();
  const [creativeCommandPending, setCreativeCommandPending] = useState(false);
  const creativeReviewRequest = useRef(0);
  const authoritativeRunRequest = useRef(0);
  const currentRunId = useRef(runId);
  currentRunId.current = runId;
  useEffect(() => {
    currentRunId.current = runId;
    setCreativeCommandPending(false);
    return () => {
      currentRunId.current = "";
      creativeReviewRequest.current += 1;
      authoritativeRunRequest.current += 1;
    };
  }, [runId]);
  const costRefreshTimer = useRef<number | undefined>(undefined);
  const snapshotRefreshPending = useRef(false);
  const paidSummaryRequest = useRef(0);
  const reconciliationRequests = useRef(new Map<string, {
    reconciliationId: string;
    expectedRunRevision: number;
  }>());
  const uncertainPaidNodeId = run?.nodes.find((node) => node.outcomeUncertain === true)?.id;

  const refreshCosts = useCallback(async () => {
    try {
      setCostDetail(await studioApi.runCosts(runId));
      setCostError(undefined);
    } catch (caught) {
      setCostError(`调用与费用明细读取失败：${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }, [runId]);

  const refreshPaidNode = useCallback(async (nodeId: string | undefined) => {
    const requestId = ++paidSummaryRequest.current;
    if (!nodeId) {
      setPaidNodeSummary(undefined);
      setPaidOperationError(undefined);
      return;
    }
    setPaidNodeSummary(undefined);
    try {
      const summary = await studioApi.paidOperation(runId, nodeId);
      if (requestId !== paidSummaryRequest.current) return;
      setPaidNodeSummary(summary);
      setPaidOperationError(undefined);
    } catch (caught) {
      if (requestId !== paidSummaryRequest.current) return;
      setPaidNodeSummary(undefined);
      setPaidOperationError(`付费任务证据读取失败：${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }, [runId]);

  const refreshRunSnapshot = useCallback(async (surfaceError = false) => {
    if (snapshotRefreshPending.current) return;
    snapshotRefreshPending.current = true;
    const requestId = ++authoritativeRunRequest.current;
    try {
      const nextRun = await studioApi.run(runId);
      if (currentRunId.current !== runId || requestId !== authoritativeRunRequest.current) return;
      setRun((current) => preferRunSnapshot(current, nextRun));
    } catch (caught) {
      // 心跳补偿仍保持安静；终态事件关闭 SSE 后若权威详情读取失败，必须让用户知道可以重读，
      // 不能继续展示可能缺少诊断的轻量事件快照。
      if (surfaceError && currentRunId.current === runId) {
        setError(`最终状态详情读取失败：${caught instanceof Error ? caught.message : String(caught)}。请刷新页面重读，不会重新执行模型或付费任务。`);
      }
    } finally {
      snapshotRefreshPending.current = false;
    }
  }, [runId]);

  useEffect(() => {
    if (!run || !isTerminal(run.status)) return;
    // 终态事件会关闭 SSE；关闭前立即补读一次权威详情，避免诊断只在手动刷新后出现。
    void refreshRunSnapshot(true);
    void refreshCosts();
  }, [runId, isTerminal(run?.status), refreshRunSnapshot, refreshCosts]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [runResult, costResult, providerResult] = await Promise.allSettled([studioApi.run(runId), studioApi.runCosts(runId), studioApi.providers()]);
      if (runResult.status === "rejected") throw runResult.reason;
      setRun(runResult.value);
      setCostDetail(costResult.status === "fulfilled" ? costResult.value : undefined);
      setRunProviders(providerResult.status === "fulfilled" ? providerResult.value : []);
      setCostError(costResult.status === "rejected"
        ? `调用与费用明细读取失败：${costResult.reason instanceof Error ? costResult.reason.message : String(costResult.reason)}`
        : undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (run?.activeIntervention?.kind !== "creative_review") {
      setCreativeReview(undefined);
      return;
    }
    let active = true;
    const requestId = ++creativeReviewRequest.current;
    void studioApi.creativeReview(runId).then((snapshot) => {
      if (active && requestId === creativeReviewRequest.current) setCreativeReview(snapshot);
    }).catch((caught) => {
      if (active) setError(`创作方案读取失败：${caught instanceof Error ? caught.message : String(caught)}`);
    });
    return () => { active = false; };
  }, [runId, run]);

  useEffect(() => {
    void refreshPaidNode(uncertainPaidNodeId);
  }, [refreshPaidNode, uncertainPaidNodeId]);

  useEffect(() => {
    if (!run || run.status === "succeeded" || run.status === "failed" || run.status === "rejected") {
      return;
    }
    return subscribeToRun(
      runId,
      (nextRun) => {
        setRun((current) => preferRunSnapshot(current, nextRun));
        setConnectionHeartbeatAt(new Date().toISOString());
        if (costRefreshTimer.current === undefined) {
          costRefreshTimer.current = window.setTimeout(() => {
            costRefreshTimer.current = undefined;
            void refreshCosts();
          }, 1_000);
        }
        setConnectionWarning(undefined);
      },
      () => setConnectionWarning("实时连接暂时中断，正在自动重连。你也可以刷新页面读取最新进度。"),
      (at) => {
        setConnectionHeartbeatAt(at);
        setConnectionWarning(undefined);
        void refreshRunSnapshot();
      },
    );
  }, [runId, run !== undefined, isTerminal(run?.status), refreshRunSnapshot]);

  useEffect(() => () => {
    if (costRefreshTimer.current !== undefined) window.clearTimeout(costRefreshTimer.current);
  }, [runId]);

  async function decide(input: StudioDecisionInput) {
    setDecisionPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.decide(runId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDecisionPending(false);
    }
  }

  async function commandCreativeReview(input: StudioCreativeReviewCommandInput) {
    setCreativeCommandPending(true);
    setError(undefined);
    try {
      // POST 响应丢失也只观察同一 commandId；不把受理当成完成，不另造请求身份。
      try { await studioApi.commandCreativeReview(runId, input); } catch (submitError) {
        try { await studioApi.creativeReviewCommand(runId, input.commandId); } catch { throw submitError; }
      }
      const observe = async () => {
        for (let attempt = 0; attempt < 900; attempt += 1) {
          if (currentRunId.current !== runId) throw new Error("已离开原作品；操作仍保留在原作品中，请返回查询。");
          const operation = await studioApi.creativeReviewCommand(runId, input.commandId);
          if (operation.status === "running" || operation.status === "unknown") {
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
            continue;
          }
          const requestId = ++creativeReviewRequest.current;
          const nextRun = await studioApi.run(runId);
          const review = nextRun.activeIntervention?.kind === "creative_review"
            ? await studioApi.creativeReview(runId) : undefined;
          if (currentRunId.current !== runId) throw new Error("已离开原作品；请返回查看操作结果。");
          if (requestId === creativeReviewRequest.current) setCreativeReview(review);
          setRun((current) => preferRunSnapshot(current, nextRun));
          if (operation.status === "failed") {
            throw Object.assign(new Error("这次创作操作未成功，当前稿已保留。请查看失败原因和恢复选项；不会自动重复生成。"), { commandCompleted: true });
          }
          return;
        }
        throw new Error("原创作任务仍在处理。请稍后查询，不要重复生成。");
      };
      await observe();
    } catch (caught) {
      throw caught;
    } finally {
      if (currentRunId.current === runId) setCreativeCommandPending(false);
    }
  }

  async function requestSceneRevision(input: StudioSceneRevisionInput) {
    setDecisionPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.requestSceneRevision(runId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDecisionPending(false);
    }
  }

  async function requestSceneResourceRevision(input: StudioSceneResourceRevisionInput) {
    setDecisionPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.requestSceneResourceRevision(runId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDecisionPending(false);
    }
  }

  async function requestNarrationRevision(input: StudioNarrationRevisionInput) {
    setDecisionPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.requestNarrationRevision(runId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDecisionPending(false);
    }
  }

  async function loadSceneNarration(scenePosition: number): Promise<string> {
    // 脚本是旁白与字幕共同的来源。按当前有效版本取交付，改的才是屏幕上正在放的那一版。
    const artifact = run ? currentScriptArtifact(run) : undefined;
    if (!artifact?.contentUrl) throw new Error("当前制作没有可读的脚本交付，取不到这一镜的原文。");
    return sceneNarrationText(await studioApi.resourceJson(artifact.contentUrl), scenePosition);
  }

  async function reinspectVisualReview(input: StudioVisualReinspectionInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.reinspectVisualReview(runId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function beginRestart() {
    setError(undefined);
    try {
      const [providers, settings, draft] = await Promise.all([
        studioApi.providers(),
        studioApi.settings(),
        studioApi.reworkDraft(runId),
      ]);
      setRestartProviders(providers);
      setRestartSettings(settings);
      setRestartDraft(draft);
      setRestarting(true);
    } catch (caught) {
      setError(`无法读取重新制作所需配置：${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  async function restartProduction(input: StudioProductionInput) {
    const result = await studioApi.start(input);
    setRestarting(false);
    navigate(`/projects/${result.runId}`);
  }

  async function overrideNode(nodeId: string, input: StudioNodeOverrideInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.overrideNode(runId, nodeId, input);
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function overrideNodeInput(nodeId: string, input: StudioNodeInputOverrideInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.overrideNodeInput(runId, nodeId, input);
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function configureNode(nodeId: string, input: StudioNodeExecutionConfigurationInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.configureNode(runId, nodeId, input);
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function authorizeSpend(nodeId: string, input: StudioSpendAuthorizationInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.authorizeSpend(runId, nodeId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function rejectSpend(nodeId: string, input: StudioSpendRejectionInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.rejectSpend(runId, nodeId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function regenerateStale() {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.regenerateStale(runId));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function requestPause() {
    setPausePending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.requestPause(runId);
      setRun((current) => preferRunSnapshot(current, nextRun));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setPausePending(false);
    }
  }

  async function resumePaused() {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.resumePaused(runId));
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function retryFailedNode(nodeId: string) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.retryFailedNode(runId, nodeId));
      setRun((current) => preferRunSnapshot(current, nextRun));
      setConnectionWarning(undefined);
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function queryOriginalTextTask() {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.queryOriginalTextTask(runId);
      setRun((current) => preferRunSnapshot(current, nextRun));
      setConnectionWarning(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function retrieveOriginalTextTask() {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.retrieveOriginalTextTask(runId));
      setRun((current) => preferRunSnapshot(current, nextRun));
      setConnectionWarning(undefined);
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function reconcilePaidNode(nodeId: string, input: StudioPaidReconciliationDraft) {
    if (!run) return;
    const reconciliationKey = `${runId}:${nodeId}:${paidNodeSummary?.operationId ?? "unknown"}:${JSON.stringify(input)}`;
    let reconciliationRequest = reconciliationRequests.current.get(reconciliationKey);
    if (!reconciliationRequest) {
      reconciliationRequest = {
        reconciliationId: createReconciliationId(),
        expectedRunRevision: run.revision,
      };
      reconciliationRequests.current.set(reconciliationKey, reconciliationRequest);
    }
    setNodeMutationPending(true);
    setError(undefined);
    try {
      let nextRun = await withMutationProgress(() => studioApi.reconcilePaidOperation(runId, nodeId, {
        expectedRunRevision: reconciliationRequest.expectedRunRevision,
        reconciliationId: reconciliationRequest.reconciliationId,
        ...input,
      }));
      reconciliationRequests.current.delete(reconciliationKey);
      if (run.continuation?.supported === true && nodeId === "voice" && input.outcome === "confirmed_charged") {
        nextRun = await withMutationProgress(() => studioApi.retryFailedNode(runId, nodeId));
      }
      setRun((current) => preferRunSnapshot(current, nextRun));
      setConnectionWarning(undefined);
      await Promise.all([
        refreshCosts(),
        refreshPaidNode(nextRun.nodes.find((node) => node.outcomeUncertain === true)?.id),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function withMutationProgress(operation: () => Promise<StudioRunDetail>): Promise<StudioRunDetail> {
    const poll = window.setInterval(() => {
      void refreshRunSnapshot();
      void refreshCosts();
    }, 750);
    try {
      return await operation();
    } finally {
      window.clearInterval(poll);
    }
  }

  if (loading) {
    return <div className="page-loading"><LoaderCircle aria-hidden="true" size={22} />正在读取制作详情...</div>;
  }
  if (!run) {
    return (
      <main className="page missing-page">
        <AlertCircle aria-hidden="true" size={24} />
        <h1>没有找到这条制作记录</h1>
        <p>{error ?? "请返回制作记录并重新选择。"}</p>
        <Link className="button button-secondary" to="/projects"><ArrowLeft aria-hidden="true" size={17} />返回制作记录</Link>
      </main>
    );
  }
  return (
    <>
      <div className="run-back-row"><Link to="/projects"><ArrowLeft aria-hidden="true" size={16} />制作记录</Link></div>
      {connectionWarning && !isTerminal(run.status) ? <div className="inline-error" role="status"><AlertCircle aria-hidden="true" size={16} />{connectionWarning}</div> : null}
      {error ? <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{error}</div> : null}
      {costError ? <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{costError}</div> : null}
      {paidOperationError ? <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{paidOperationError}</div> : null}
      <RunWorkbench run={run} creativeDiscussion={creativeReview ? <CreativeDiscussionPanel key={`${run.id}:${creativeReview.stage}`} review={creativeReview} busy={creativeCommandPending || creativeReview.phase === "checking"} onCommand={commandCreativeReview} /> : undefined} providers={runProviders} decisionPending={decisionPending} onDecision={decide} onRequestSceneRevision={requestSceneRevision} onRequestSceneResourceRevision={requestSceneResourceRevision} onRequestNarrationRevision={requestNarrationRevision} onLoadSceneNarration={loadSceneNarration} onReinspectVisualReview={reinspectVisualReview} onOpenPublish={() => setPublishing(true)} onRestart={() => void beginRestart()} {...(costDetail ? { costDetail } : {})} {...(paidNodeSummary ? { paidNodeSummary } : {})} {...(connectionHeartbeatAt ? { connectionHeartbeatAt } : {})} nodeMutationPending={nodeMutationPending} pausePending={pausePending} onOverrideNode={overrideNode} onOverrideNodeInput={overrideNodeInput} onConfigureNode={configureNode} onAuthorizeSpend={authorizeSpend} onRejectSpend={rejectSpend} onRegenerateStale={regenerateStale} onRequestPause={requestPause} onResumePaused={resumePaused} onQueryOriginalTextTask={queryOriginalTextTask} onRetrieveOriginalTextTask={retrieveOriginalTextTask} onRetryFailedNode={retryFailedNode} onReconcilePaidNode={reconcilePaidNode} />
      {publishing ? <MultiPlatformPublishDialog runId={run.id} onClose={() => setPublishing(false)} /> : null}
      <NewRunDialog
        open={restarting}
        providers={restartProviders}
        {...(restartSettings ? { creatorSettings: restartSettings } : {})}
        {...(restartDraft ? {
          initialValues: restartDraft.input,
          inheritedNodeIds: restartDraft.inheritedNodeIds,
          requiredAffectedScenePositions: restartDraft.requiredAffectedScenePositions,
          ...(restartDraft.inheritedReferenceVideo ? { inheritedReferenceVideo: restartDraft.inheritedReferenceVideo } : {}),
        } : {})}
        onClose={() => setRestarting(false)}
        onSubmit={restartProduction}
      />
    </>
  );
}

function isTerminal(status: StudioRunDetail["status"] | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected";
}

type StudioPaidReconciliationDraft = Omit<StudioPaidReconciliationInput, "expectedRunRevision" | "reconciliationId">;

function createReconciliationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `paid-reconciliation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

```

## apps/studio/src/client/components/RunWorkbench.tsx

SHA256: 2e34cefaee7d249eb5aaed3639cfaa47d84e4164508a1a49a10349768933c361; 1781 lines. OMITTED: 818-1546, 1781-1781.

### Original lines 1-817

```
import { Activity, AlertTriangle, Check, Clock3, Download, Pause, Play, RotateCcw, Send, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StudioCostRunDetail, StudioDecisionInput, StudioNarrationRevisionInput, StudioSceneResourceRevisionInput, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioPaidNodeSummary, StudioPaidReconciliationInput, StudioProvider, StudioRunDetail, StudioSceneRevisionInput, StudioSpendAuthorizationInput, StudioSpendRejectionInput, StudioVisualReinspectionInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { StatusBadge } from "./StatusBadge.js";
import { agentLoopPendingNote, agentLoopPhaseLabel, creatorFacingTechnicalText, creatorRunStatusLabel, humanizeCreativeText, platformLabel, providerLabel, catalogModelLabel, runNodeLabel, RUN_NODE_LABELS, sourceAssetReviewBreakdown } from "../presentation.js";
import { NodeWorkspace, revealNodeWorkspace } from "./NodeWorkspace.js";
import { RunCostDetailPanel } from "./CostDashboard.js";
import { AudioReviewPanel } from "./AudioReviewPanel.js";

interface RunWorkbenchProps {
  creativeDiscussion?: ReactNode;
  run: StudioRunDetail;
  providers?: StudioProvider[];
  decisionPending: boolean;
  onDecision: (input: StudioDecisionInput) => Promise<void>;
  onRequestSceneRevision?: (input: StudioSceneRevisionInput) => Promise<void>;
  /** 重取某一镜的素材：在这一镜已通过语义筛选的候选里改选下一名，画面换一版。 */
  onRequestSceneResourceRevision?: (input: StudioSceneResourceRevisionInput) => Promise<void>;
  onRequestNarrationRevision?: (input: StudioNarrationRevisionInput) => Promise<void>;
  /** 取这一镜当前的旁白/字幕原文；改字要看得到原文，否则只能凭记忆重打一遍。 */
  onLoadSceneNarration?: (scenePosition: number) => Promise<string>;
  onReinspectVisualReview?: (input: StudioVisualReinspectionInput) => Promise<void>;
  onOpenPublish?: () => void;
  onRestart?: () => void;
  costDetail?: StudioCostRunDetail;
  nodeMutationPending?: boolean;
  pausePending?: boolean;
  onOverrideNode?: (nodeId: string, input: StudioNodeOverrideInput) => Promise<void>;
  onOverrideNodeInput?: (nodeId: string, input: StudioNodeInputOverrideInput) => Promise<void>;
  onConfigureNode?: (nodeId: string, input: StudioNodeExecutionConfigurationInput) => Promise<void>;
  onAuthorizeSpend?: (nodeId: string, input: StudioSpendAuthorizationInput) => Promise<void>;
  onRejectSpend?: (nodeId: string, input: StudioSpendRejectionInput) => Promise<void>;
  onRegenerateStale?: () => Promise<void>;
  onRequestPause?: () => Promise<void>;
  onResumePaused?: () => Promise<void>;
  onQueryOriginalTextTask?: () => Promise<void>;
  onRetrieveOriginalTextTask?: () => Promise<void>;
  onRetryFailedNode?: (nodeId: string) => Promise<void>;
  paidNodeSummary?: StudioPaidNodeSummary;
  onReconcilePaidNode?: (nodeId: string, input: StudioPaidReconciliationDraft) => Promise<void>;
  connectionHeartbeatAt?: string;
}

export function RunWorkbench({ run, creativeDiscussion, providers = [], decisionPending, onDecision, onRequestSceneRevision, onRequestSceneResourceRevision, onRequestNarrationRevision, onLoadSceneNarration, onReinspectVisualReview, onOpenPublish, onRestart, costDetail, nodeMutationPending = false, pausePending = false, onOverrideNode, onOverrideNodeInput, onConfigureNode, onAuthorizeSpend, onRejectSpend, onRegenerateStale, onRequestPause, onResumePaused, onQueryOriginalTextTask, onRetrieveOriginalTextTask, onRetryFailedNode, paidNodeSummary, onReconcilePaidNode, connectionHeartbeatAt }: RunWorkbenchProps) {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, { decision: "accept" | "reject" | "accept_risk"; reason: string }>>({});
  const [replanningVoice, setReplanningVoice] = useState(false);
  const [voiceDurationSeconds, setVoiceDurationSeconds] = useState("");
  const [hasPendingPlanningConfiguration, setHasPendingPlanningConfiguration] = useState(false);
  const [decisionSnapshot, setDecisionSnapshot] = useState<Pick<StudioDecisionInput, "expectedRunRevision" | "interventionId" | "reviewEvidenceId"> & { acceptIncomplete?: true }>();
  const previewRef = useRef<HTMLVideoElement>(null);
  const closeRejectDecision = () => {
    setRejecting(false);
    setDecisionSnapshot(undefined);
  };
  const closeApproveDecision = () => {
    setApproving(false);
    setDecisionSnapshot(undefined);
  };
  const rejectDialogRef = useDialogFocus<HTMLElement>(rejecting, closeRejectDecision, decisionPending);
  const approveDialogRef = useDialogFocus<HTMLElement>(approving, closeApproveDecision, decisionPending);
  const closeVoiceTimingDecision = () => {
    setReplanningVoice(false);
    setDecisionSnapshot(undefined);
  };
  const voiceTimingDialogRef = useDialogFocus<HTMLElement>(replanningVoice, closeVoiceTimingDecision, decisionPending);
  const readOnly = run.continuation?.supported === false;
  const video = run.artifacts.find((artifact) => artifact.id === run.videoArtifactId);
  // 边界停点：这一步已做完、产物已存，只等用户决定是否进入下一步。按钮文案必须按
  // 它真正的后果说话——把中间节点的放行写成「批准进入发布包」会让用户以为点下去就发了。
  const boundaryGate = run.activeIntervention?.boundary === "node-complete";
  const boundaryOptions = boundaryGate ? run.activeIntervention?.options ?? [] : [];
  // 停点放行的是下一步，而下一步还没跑、没有任何产物，于是它从前落不进 creatorNodes：
  // 用户看得到「进入下一步」，却找不到地方配置那一步怎么跑——简报之后最典型，创作规划
  // 用哪个模型只能等它自己跑起来才有地方改。带可调执行的下一步在停点上一并露出。
  const nextGateNode = boundaryGate ? nextConfigurableNode(run) : undefined;
  const creatorNodes = run.nodes.filter((node) => node.id === nextGateNode?.id || nodeHasCreatorContent(node, run));
  const activeSpendNode = readOnly ? undefined : creatorNodes.find((node) => node.status === "awaiting_spend_approval" || node.status === "approval_invalidated");
  const currentArtifactNode = !video?.contentUrl && !creativeDiscussion && run.activeIntervention?.kind !== "creative_review"
    ? creatorNodes.find((node) => node.id === run.activeIntervention?.nodeId && node.id !== activeSpendNode?.id)
    : undefined;
  const remainingCreatorNodes = creatorNodes.filter((node) => node.id !== activeSpendNode?.id && node.id !== currentArtifactNode?.id);
  const showReviewSurface = Boolean(readOnly || video?.contentUrl || (run.activeIntervention && run.activeIntervention.kind !== "creative_review") || isStoppedStatus(run.status));
  const uncertainPaidNode = run.nodes.find((node) => node.outcomeUncertain === true);
  const visiblePaidNodeSummary = paidNodeSummary?.nodeId === uncertainPaidNode?.id ? paidNodeSummary : undefined;
  const uncertainPaidNodeProviderId = (uncertainPaidNode?.executionReceipt ?? uncertainPaidNode?.plannedExecution)?.providerId;
  const sourcePreflightDecision = run.activeIntervention?.nodeId === "asset-source-review";
  const visualReview = sourcePreflightDecision ? undefined : visualReviewDecision(run);
  const sourceReviewEvidenceId = sourceReviewDecisionEvidenceId(run);
  const sourceReviewDecision = run.activeIntervention?.kind === "source_review_decision";
  const sourceReviewRetry = run.activeIntervention?.kind === "source_review_retry";
  const sourceReviewIncompleteRisk = sourceReviewRetry
    && run.activeIntervention?.reviewStatus === "incomplete"
    && run.activeIntervention.providerOutcomeKnown === true;
  const voiceTiming = voiceTimingConflict(run);
  const visualReviewRequiresRevision = visualReview?.recommendation === "revise" || visualReview?.recommendation === "reject";
  const singleVisualReview = visualReview?.mode === "single";
  // 停下来的这一步的独立复核进度。SSE 载荷里没有它，由 preferRunSnapshot 从上一帧补回来，
  // 否则用户点开决策面板的瞬间看到的是一片空白，要等十秒心跳才出现建议。
  const waitingNodeId = run.activeIntervention?.nodeId;
  const waitingNodeProgress = waitingNodeId
    ? run.nodes.find((node) => node.id === waitingNodeId)?.agentLoopProgress
    : undefined;
  const flawedReviewBranches = (visualReview?.independentReviews ?? []).filter((branch) => branch.auditVerdict === "repair");
  // 逐条表态与成片证据只属于「消费成片审片证据」的停点（视觉审片/终审/发布包）；
  // 其它停点（素材预检、配音等）不携带无关的成片证据，与服务端分派保持同一合同。
  const renderedReviewStop = ["visual-review", "final-review", "publish-package"]
    .includes(run.activeIntervention?.nodeId ?? "");
  const reviewItems = renderedReviewStop ? visualReview?.reviewItems ?? [] : [];
  const undisposedReviewItems = reviewItems.filter((item) => item.itemKey && !reviewDecisions[item.itemKey]);
  const acceptedReviewItems = reviewItems.filter((item) => item.itemKey && reviewDecisions[item.itemKey]?.decision === "accept");
  const unexplainedReviewItems = reviewItems.filter((item) => (
    item.itemKey && reviewDecisions[item.itemKey]?.decision === "reject" && !reviewDecisions[item.itemKey]?.reason.trim()
  ));
  const setReviewDecision = (itemKey: string, decision: "accept" | "reject" | "accept_risk") => {
    setReviewDecisions((previous) => ({ ...previous, [itemKey]: { decision, reason: previous[itemKey]?.reason ?? "" } }));
  };
  const setReviewReason = (itemKey: string, reason: string) => {
    setReviewDecisions((previous) => ({ ...previous, [itemKey]: { decision: previous[itemKey]?.decision ?? "reject", reason } }));
  };
  const assetVersionId = run.nodes.find((node) => node.id === "assets")?.outputState?.effectiveVersionId;
  const isCostReplan = run.status === "stale" && hasDirectorCostFeedback(run);
  const sourceAssetFailure = run.failure && isSourceAssetReviewFailure(run.failure)
    ? sourceAssetReviewBreakdown(run.failure)
    : undefined;
  const taskRecoveryPanel = run.taskRecovery ? <section className="task-recovery-panel" aria-label="原模型任务恢复" role="status">
    <strong>{run.taskRecovery.resultAvailable ? "原任务结果可以取回" : "已保留原模型任务"}</strong>
    <p>{run.taskRecovery.summary}</p>
    {run.taskRecovery.lastVerifiedAt ? <p><time dateTime={run.taskRecovery.lastVerifiedAt}>上次确认：{formatRecoveryTime(run.taskRecovery.lastVerifiedAt)}</time></p> : null}
    {run.taskRecovery.observationError ? <p className="run-failure-summary">最近查询：{run.taskRecovery.observationError}</p> : null}
    {run.taskRecovery.terminalError ? <p className="run-failure-summary">原任务失败原因：{run.taskRecovery.terminalError}</p> : null}
    <div className="task-recovery-actions">
      {run.taskRecovery.allowedActions.includes("query_original_task") && onQueryOriginalTextTask ? <button
        className="button button-secondary"
        type="button"
        disabled={nodeMutationPending}
        onClick={() => void onQueryOriginalTextTask()}
      ><Activity aria-hidden="true" size={16} />{nodeMutationPending ? "正在查询原任务..." : "查询原任务"}</button> : null}
      {run.taskRecovery.allowedActions.includes("retrieve_and_continue") && onRetrieveOriginalTextTask ? <button
        className="button button-primary"
        type="button"
        disabled={nodeMutationPending}
        onClick={() => void onRetrieveOriginalTextTask()}
      ><Play aria-hidden="true" size={16} />{nodeMutationPending ? "正在取回..." : "取回结果并继续"}</button> : null}
    </div>
  </section> : null;

  const renderNodeWorkspace = (node: StudioRunDetail["nodes"][number]) => <NodeWorkspace
    key={node.id}
    node={node}
    nodes={run.nodes}
    providers={providers}
    runStatus={run.status}
    artifacts={run.artifacts.filter((artifact) => node.artifactIds.includes(artifact.id) || artifact.producerNodeId === node.id)}
    busy={nodeMutationPending}
    runId={run.id}
    runRevision={run.revision}
    acceptedPlanDigest={run.productionPlanDigest ?? ""}
    readOnly={readOnly}
    {...(node.id === "creative-planning" && run.planningStages ? { planningStages: run.planningStages } : {})}
    {...(node.id === "creative-planning" ? { onPendingPlanningConfigurationChange: setHasPendingPlanningConfiguration } : {})}
    pauseBusy={pausePending}
    pauseRequested={run.pauseRequested === true}
    {...(onRequestPause ? { onRequestPause } : {})}
    onOverride={onOverrideNode ?? (async () => undefined)}
    onInputOverride={onOverrideNodeInput ?? (async () => undefined)}
    onConfigure={onConfigureNode ?? (async () => undefined)}
    onAuthorize={onAuthorizeSpend ?? (async () => undefined)}
    onRejectSpend={onRejectSpend ?? (async () => undefined)}
  />;

  useEffect(() => {
    if (!run.activeIntervention) {
      setApproving(false);
      setRejecting(false);
      setRejectNote("");
      setApprovalNote("");
      setReviewDecisions({});
      setReplanningVoice(false);
      setVoiceDurationSeconds("");
      setDecisionSnapshot(undefined);
    }
  }, [run.activeIntervention]);

  const openDecision = (kind: "approve" | "reject") => {
    if (!run.activeIntervention) return;
    setDecisionSnapshot({
      expectedRunRevision: run.revision,
      interventionId: run.activeIntervention.id,
      // 成片审片证据只在消费它的停点随决定提交；其余停点不携带无关证据（与服务端分派一致）。
      reviewEvidenceId: sourceReviewDecision || sourceReviewRetry
        ? sourceReviewEvidenceId ?? run.activeIntervention.evidenceId ?? null
        : renderedReviewStop
          ? visualReview?.evidenceId ?? null
          : null,
      ...(kind === "approve" && sourceReviewIncompleteRisk ? { acceptIncomplete: true as const } : {}),
    });
    if (kind === "approve") setApproving(true);
    else setRejecting(true);
  };

  const openVoiceTimingDecision = () => {
    if (!run.activeIntervention || !voiceTiming) return;
    setDecisionSnapshot({
      expectedRunRevision: run.revision,
      interventionId: run.activeIntervention.id,
      reviewEvidenceId: null,
    });
    setVoiceDurationSeconds(String(voiceTiming.requiredSeconds));
    setReplanningVoice(true);
  };

  return (
    <main className={`page run-page${creativeDiscussion ? " has-creative-discussion" : ""}`}>
      <header className="run-header" data-tour="run-header">
        <div>
          <h1>{run.title}</h1>
          <div className="run-title-meta"><span>{platformLabel(run.platform)} · 目标 {run.durationSeconds} 秒</span><details className="run-brief-context"><summary>创作目标与受众</summary><p className="page-summary">{run.angle} · {run.audience}</p></details></div>
        </div>
        <StatusBadge status={run.status} {...(creatorRunStatusLabel(run) ? { label: creatorRunStatusLabel(run)! } : {})} />
      </header>

      <div className="run-workspace-toolbar">
      <nav className="run-section-nav" aria-label="作品工作区">
        <a href="#run-current">当前步骤与产物</a>
        {remainingCreatorNodes.length > 0 ? <a href="#run-artifacts">已保留的内容与设置</a> : null}
        {costDetail ? <a href="#run-costs">调用与费用</a> : null}
      </nav>

      {!readOnly ? <details className="run-progress-disclosure" open={creativeDiscussion ? undefined : true}>
        <summary>制作进度{run.progress ? <span>{run.progress.completedNodes} / {run.progress.totalNodes} 步完成</span> : null}</summary>
      {run.phases && run.progress ? <ProductionProgress run={run} /> : (
        <section className="workflow-track" aria-label="生产工作流" data-tour="run-workflow">
          {run.nodes.map((node, index) => (
            <div className={`workflow-node node-${node.status}`} key={node.id}>
              <span className="node-index">{node.status === "succeeded" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
              <span>{node.role ? `${node.role} · ${stepNameFor(node, node.label)}` : stepNameFor(node, node.label)}</span>
            </div>
          ))}
        </section>
      )}
      </details> : null}
      </div>

      <div id="run-current" className="run-current-workspace">
      {creativeDiscussion}
      {!creativeDiscussion && run.activeIntervention?.kind === "creative_review" ? <p className="workspace-loading" role="status">正在读取当前方案与讨论。读取完成后才能确认此版本。</p> : null}
      {run.status === "needs_human" && run.activeIntervention ? <CurrentDecisionBar run={run} /> : null}
      {activeSpendNode ? <section className="current-production-action" aria-labelledby="current-production-action-title">
        <header>
          <div><p className="eyebrow">当前需要处理</p><h2 id="current-production-action-title">现在需要你：确认{stepNameFor(activeSpendNode, activeSpendNode.label)}</h2></div>
          <StatusBadge status={run.status} />
        </header>
        <p>先核对当前方案、可复用素材与服务端报价，再单独确认本次费用。授权只针对本次制作范围，后续仍保留逐步确认。</p>
        {renderNodeWorkspace(activeSpendNode)}
      </section> : run.status === "running" ? <section className="current-production-action is-running" aria-live="polite">
        <header><div><p className="eyebrow">自动制作中</p><h2>{runningNodeLabel(run)}</h2></div><StatusBadge status={run.status} /></header>
        <p>{creatorFacingTechnicalText(run.currentAction?.label) ?? runStateMessage(run)}</p>
        {run.progress ? <div className="run-live-metrics">
          <span><Activity aria-hidden="true" size={15} /><strong>{run.progress.completedNodes} / {run.progress.totalNodes}</strong> 个步骤完成</span>
          <span><Clock3 aria-hidden="true" size={15} />{run.progress.currentNodeElapsedSeconds !== undefined ? "当前步骤" : "累计处理"} <strong>{formatDuration(run.progress.currentNodeElapsedSeconds ?? run.progress.elapsedSeconds)}</strong></span>
          <span>{etaLabel(run.progress)}</span>
          <span>制作状态更新于 {formatClock(run.progress.lastUpdatedAt)}</span>
          {costDetail ? <span>已记录费用 <strong>¥{costDetail.totals.actualCostCny.toFixed(2)}</strong>{costDetail.totals.actualPendingCount ? ` · ${costDetail.totals.actualPendingCount} 笔待确认是否扣费` : ""}</span> : null}
          {connectionHeartbeatAt ? <span className="run-connection-live"><i aria-hidden="true" />制作服务连接刚刚确认</span> : null}
        </div> : null}
        {activeNodeModel(run, providers) ? <p className="run-active-provider">当前能力：{activeNodeModel(run, providers)}</p> : null}
        {onRequestPause ? <button className="button button-ghost run-pause-button" type="button" disabled={pausePending || run.pauseRequested === true} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{run.pauseRequested ? "当前步骤完成后暂停" : "暂停后检查或修改"}</button> : null}
      </section> : null}

      {taskRecoveryPanel}

      {showReviewSurface ? <div className={`review-layout${!video?.contentUrl && !currentArtifactNode ? " review-layout-no-media" : ""}`}>
        {video?.contentUrl ? <section className="video-stage" aria-labelledby="preview-title" data-tour="run-preview">
          <div className="section-heading stage-heading">
            <div><p className="eyebrow">最终画面</p><h2 id="preview-title">成片预览</h2></div>
            {video?.contentUrl ? (
              <a className="icon-button" href={video.contentUrl} download title="下载成片">
                <Download aria-hidden="true" size={18} />
              </a>
            ) : null}
          </div>
          <div className="video-frame">
            {video?.contentUrl ? (
              <video ref={previewRef} title="成片预览" src={`${video.contentUrl}#t=0.1`} controls playsInline preload="auto" />
            ) : (
              <div className="video-unavailable">视频将在渲染完成后出现在这里</div>
            )}
          </div>
          <p className="preview-provenance">当前成片 · {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(video.createdAt))} 生成。先观看实际内容，再结合复核意见判断。</p>
          </section> : currentArtifactNode ? <section className="current-artifact-surface" aria-label="当前步骤产物">
          <header className="section-heading"><div><h2>{runNodeLabel(currentArtifactNode.id)}</h2><p>当前已保留的产物与设置。核对后再决定是否进入下一步。</p></div></header>
          {renderNodeWorkspace(currentArtifactNode)}
        </section> : null}

        <aside className="review-panel" aria-label="审片与产物" data-tour="run-review">
          {run.creativeSummary ? <details className="creative-summary run-creative-summary" role="region" aria-label="创作目标摘要">
            <summary><strong>系统整理的创作目标</strong><small>展开核对</small></summary>
            <p>根据本次简报推导；如有偏差，请在打回后修改标题、角度、受众或画面要求。</p>
            <dl>
              <div><dt>给谁看</dt><dd>{run.creativeSummary.audience}</dd></div>
              <div><dt>开头承诺</dt><dd>{run.creativeSummary.openingPromise}</dd></div>
              <div><dt>画面方向参考</dt><dd>{run.creativeSummary.requiredVisual}</dd></div>
              <div><dt>结尾收益</dt><dd>{run.creativeSummary.payoff}</dd></div>
            </dl>
          </details> : null}
          {visualReview ? <section className="independent-review-panel" aria-label={singleVisualReview ? "独立质量复核结果" : "双模型审片结果"}>
            <header><strong>{singleVisualReview
              ? `成片独立质量复核：${visualReview.independentReviews.length} 份已完成`
              : `成片双审：${visualReview.independentReviews.length}/2 已完成`}</strong><small>{singleVisualReview
              ? "该模型审查同一版成片"
              : visualReview.independentReviews.length === 2
                ? visualReview.evidenceId ? "两者查看同一份成片证据" : "独立审查同一版成片"
                : "审片结果不完整，不能按完整双审处理"}</small></header>
            <div className="merged-review-summary">
              <span>视觉结论 · {visualReviewRecommendationLabel(visualReview.recommendation)}</span>
              <p>{creatorFacingTechnicalText(visualReview.summary)}</p>
            </div>
            {flawedReviewBranches.length > 0 ? <p className="review-audit-caveat" role="note">
              <strong>有 {flawedReviewBranches.length} 份意见自己的独立审计没通过</strong>
              <span>{flawedReviewBranches.map((branch) => `${providerLabel(branch.providerId) ?? branch.providerId} · ${catalogModelLabel(providers, branch.modelId) ?? branch.modelId}`).join("、")}。审计查的是这份审片报告本身站不站得住，所以它说明的是"这些意见有瑕疵、请重点核对"，不是"作品有问题"。审计只出建议，作品能不能发由你定。</span>
            </p> : null}
            <div className="independent-review-list">
              {visualReview.independentReviews.map((review) => <article key={`${review.providerId}:${review.modelId}`}>
                <header><strong>{providerLabel(review.providerId) ?? review.providerId}</strong><span>{visualReviewRecommendationLabel(review.recommendation)}</span></header>
                <small>{catalogModelLabel(providers, review.modelId) ?? review.modelId}{review.score !== undefined ? ` · ${review.score} 分` : ""}{` · ${review.findingCount} 项问题`}{review.auditVerdict === "repair" ? " · 独立审计未通过" : ""}</small>
                <p>{creatorFacingTechnicalText(review.summary)}</p>
              </article>)}
              {!singleVisualReview && visualReview.independentReviews.length < 2 ? <p role="status">缺少 {2 - visualReview.independentReviews.length} 个可验证的独立审片结果，请重新审查当前成片。</p> : null}
            </div>
          </section> : null}
          {visualReview ? <AudioReviewPanel value={visualReview.audioReview} /> : null}
          {!visualReview && video?.contentUrl ? <section className="review-advisory" role="status" aria-label="机器审片状态">
            <strong>可播放首版</strong>
            <p>机器视觉审片尚未完成。你可以播放和下载当前视频；这不代表正式发布已通过。</p>
          </section> : null}
          {readOnly ? (
            <section className="run-state-panel" role="status">
              <p className="eyebrow">历史制作记录</p>
              <h2>这条旧版制作仅供查看</h2>
              <p>{run.continuation?.reason}</p>
              {visiblePaidNodeSummary ? <PaidOperationPanel
                summary={visiblePaidNodeSummary}
                providers={providers}
                busy={nodeMutationPending}
                settlementOnly
                {...(uncertainPaidNodeProviderId ? { providerIdHint: uncertainPaidNodeProviderId } : {})}
                {...(onReconcilePaidNode ? { onReconcile: onReconcilePaidNode } : {})}
              /> : null}
              {onRestart ? <button className="button button-primary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />基于这版重新制作</button> : null}
            </section>
          ) : run.activeIntervention?.kind === "source_review_retry" && run.activeIntervention ? (
            <section className="intervention-panel" aria-label="试片审查暂停">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                <h2>{sourceReviewIncompleteRisk ? "试片审查没有完成，等你决定" : "试片审查还没完成，制作已暂停"}</h2>
              </div>
              <p>{creatorFacingTechnicalText(run.activeIntervention.reason) ?? run.activeIntervention.reason}</p>
              <p>{sourceReviewIncompleteRisk
                ? "审查没有给出评分，但已生成画面、来源和费用事实已确认。你可以接受这个风险继续生成首版；这不会把审查改成通过，也不会重新购买已成功素材。"
                : "已生成的画面与已花费的费用都保留。重试只续未完成的审查分支，不会重新购买成功素材；付费结果或来源事实不明确时，只能补查或终止。"}</p>
              <div className="decision-actions">
                {sourceReviewIncompleteRisk ? <button
                  className="button button-primary"
                  type="button"
                  disabled={decisionPending || !sourceReviewEvidenceId && !run.activeIntervention.evidenceId}
                  onClick={() => openDecision("approve")}
                ><Check aria-hidden="true" size={17} />接受未完成审查，继续生成首版</button> : null}
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={nodeMutationPending || !onRetryFailedNode}
                  onClick={() => { if (onRetryFailedNode) void onRetryFailedNode(run.activeIntervention!.nodeId); }}
                ><RotateCcw aria-hidden="true" size={17} />重试审查（复用已生成画面）</button>
                <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                  <XCircle aria-hidden="true" size={17} />终止制作
                </button>
              </div>
            </section>
          ) : run.activeIntervention?.kind === "source_review_decision" && run.activeIntervention ? (
            <section className="intervention-panel" aria-label="试片质量意见">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                <h2>试片提出质量意见，等你决定</h2>
              </div>
              <p>{creatorFacingTechnicalText(run.activeIntervention.reason) ?? run.activeIntervention.reason}</p>
              <p>这是一份完整的试片审查意见，不是系统替你否决作品。已生成画面和费用都会保留；继续时只复用这份已确认的试片，后续素材是否会产生费用仍以当前报价为准。</p>
              <div className="decision-actions">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={decisionPending || !sourceReviewEvidenceId}
                  onClick={() => sourceReviewEvidenceId && void onDecision({
                    action: "request_changes",
                    expectedRunRevision: run.revision,
                    interventionId: run.activeIntervention!.id,
                    reviewEvidenceId: sourceReviewEvidenceId,
                  })}
                ><RotateCcw aria-hidden="true" size={17} />调整方案</button>
                <button className="button button-primary" type="button" disabled={decisionPending || !sourceReviewEvidenceId} onClick={() => openDecision("approve")}>
                  <Check aria-hidden="true" size={17} />承担这些质量意见后继续
                </button>
                <button className="button button-secondary" type="button" disabled={decisionPending || !sourceReviewEvidenceId} onClick={() => openDecision("reject")}>
                  <XCircle aria-hidden="true" size={17} />终止制作
                </button>
              </div>
            </section>
          ) : run.activeIntervention?.kind !== "creative_review" && run.activeIntervention?.kind !== "source_review_retry" && run.activeIntervention ? (
            <section className="intervention-panel">
              <div className="attention-heading">
                <AlertTriangle aria-hidden="true" size={18} />
                {/* 边界停点由界面按 nodeId 说步骤名（服务端只有英文节点标识），否则用户看不出停在哪一步。 */}
                <h2>{boundaryGate ? `${runNodeLabel(run.activeIntervention.nodeId)}做完了，等你放行` : "需要你的判断"}</h2>
              </div>
              <p>{creatorFacingTechnicalText(run.activeIntervention.reason)}</p>
              {waitingNodeProgress ? <div className={`agent-loop-progress is-stacked is-${waitingNodeProgress.phase}`} role="status">
                <strong>{agentLoopPhaseLabel(waitingNodeProgress)}</strong>
                {waitingNodeProgress.latestAudit ? <>
                  <span>独立复核 {waitingNodeProgress.latestAudit.score} 分：{creatorFacingTechnicalText(humanizeCreativeText(waitingNodeProgress.latestAudit.summary))}</span>
                  {waitingNodeProgress.latestAudit.issues?.length ? <ul className="agent-audit-issues">
                    {waitingNodeProgress.latestAudit.issues.map((issue, index) => <li key={`${issue.criterion}:${index}`}>
                      <strong>{creatorFacingTechnicalText(humanizeCreativeText(issue.criterion))}
                        {/* 审计自己的措辞是 blocking/advisory；对用户它始终只是建议，所以写"建议先改"而不是"阻断"。 */}
                        <span className="agent-audit-issue-severity">{issue.severity === "blocking" ? "建议先改" : "可选"}</span>
                      </strong>
                      <span>{creatorFacingTechnicalText(humanizeCreativeText(issue.evidence))}</span>
                      <span>建议：{creatorFacingTechnicalText(humanizeCreativeText(issue.repairInstruction))}</span>
                    </li>)}
                  </ul> : null}
                </> : <span>{agentLoopPendingNote(waitingNodeProgress)}</span>}
                <span>实际模型调用：创作 {waitingNodeProgress.producerModelCallCount ?? 0} 次，审计 {waitingNodeProgress.auditModelCallCount ?? 0} 次。查询、刷新和等待不计为新调用。</span>
              </div> : null}
              {visualReviewRequiresRevision && visualReview ? <div className="agent-review-decision">
                <strong>视觉审片建议修改后再审</strong>
                <p>{creatorFacingTechnicalText(visualReview.summary)}</p>
                <div className="agent-review-facts">
                  {visualReview.lowestScores.map((score) => <span key={score.key}>{score.label} <strong>{score.value}</strong></span>)}
                  <span><strong>{visualReview.findingCount}</strong> 项已确认缺陷</span>
                  {visualReview.pendingInspectionCount ? <span><strong>{visualReview.pendingInspectionCount}</strong> 项待补查</span> : null}
                  {visualReview.infoCount ? <span><strong>{visualReview.infoCount}</strong> 项提示</span> : null}
                  <span>模型自评把握程度 <strong>{Math.round(visualReview.confidence * 100)}%</strong></span>
                </div>
                {onRequestSceneRevision && assetVersionId && visualReview.reviewArtifactId
                  ? <div className="scene-revision-list">
                    {visualReview.findings.map((finding) => <SceneRevisionFinding
                      key={`${finding.timecodeMs}:${finding.findingIndex}`}
                      finding={finding}
                      busy={decisionPending}
                      onSeek={() => {
                        if (!previewRef.current) return;
                        previewRef.current.currentTime = finding.timecodeMs / 1_000;
                      }}
                      onSubmit={(input) => onRequestSceneRevision({
                        expectedRunRevision: run.revision,
                        expectedAssetVersionId: assetVersionId,
                        reviewArtifactId: visualReview.reviewArtifactId!,
                        findingIndex: finding.findingIndex,
                        ...input,
                      })}
                      {...(onRequestSceneResourceRevision ? {
                        onReselectAsset: (input) => onRequestSceneResourceRevision({
                          expectedRunRevision: run.revision,
                          reviewArtifactId: visualReview.reviewArtifactId!,
                          findingIndex: finding.findingIndex,
                          ...input,
                        }),
                      } : {})}
                      {...(onLoadSceneNarration ? { onLoadNarration: onLoadSceneNarration } : {})}
                      {...(onRequestNarrationRevision ? {
                        onSubmitNarration: (input) => onRequestNarrationRevision({
                          expectedRunRevision: run.revision,
                          ...input,
                        }),
                      } : {})}
                    />)}
                  </div>
                  : null}
                {visualReview.pendingInspectionCount > 0 && visualReview.evidenceId && onReinspectVisualReview ? (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={nodeMutationPending || decisionPending}
                    onClick={() => void onReinspectVisualReview({
                      expectedRunRevision: run.revision,
                      reviewEvidenceId: visualReview.evidenceId!,
                    })}
                  >
                    <RotateCcw aria-hidden="true" size={17} />补查现有成片（不重买素材）
                  </button>
                ) : null}
                <p className="agent-review-guidance">补查会重跑整轮审片、不会重新购买画面或配音，因此<strong>其它镜头（包括上一轮已通过的镜头）的结论也可能变化</strong>；判定与上一轮不同的条目会标出「判定变动」，并给出两轮原文。批准前你要对本轮每一条结论逐条表态：采纳的必须先返修，不采纳的要写明理由。</p>
              </div> : null}
              {nextGateNode ? <div className="boundary-next-step">
                <span>下一步「{stepNameFor(nextGateNode, nextGateNode.label)}」还没开始。放行后它会直接按现在保存的模型和设置开始跑；要改就在放行前改。</span>
                <button className="button button-ghost" type="button" onClick={() => revealNodeWorkspace(nextGateNode.id)}>去配置「{stepNameFor(nextGateNode, nextGateNode.label)}」</button>
              </div> : null}
              <div className="decision-actions">
                {boundaryGate ? <>
                  {/* 尊重 runner 实际接受的闸门：options 里没有的动作不发按钮，否则按钮会与
                      服务端校验漂移（点了必然报"does not allow action"）。 */}
                  {boundaryOptions.includes("approve") ? (
                    <button
                      className="button button-primary"
                      type="button"
                      disabled={decisionPending}
                      onClick={() => openDecision("approve")}
                    >
                      <Check aria-hidden="true" size={17} />做完了，进入下一步
                    </button>
                  ) : null}
                  {boundaryOptions.includes("reject") ? (
                    <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                      <XCircle aria-hidden="true" size={17} />终止制作
                    </button>
                  ) : null}
                </> : voiceTiming ? <>
                  <button className="button button-primary" type="button" disabled={decisionPending} onClick={openVoiceTimingDecision}>
                    <RotateCcw aria-hidden="true" size={17} />调整方案
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <XCircle aria-hidden="true" size={17} />终止制作
                  </button>
                </> : visualReviewRequiresRevision ? <>
                  {/* 这一支原来写「修改后再审」，但它提交的是 reject——一个把这条视频当场终止的终态，
                      没有任何返修会因此发生。想返修的人会点它，然后拿到一条停止制作的视频。
                      现在按它的实际后果说话；要返修请用下面每条结论旁的返工入口。 */}
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <XCircle aria-hidden="true" size={17} />终止制作
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("approve")}>
                    <Check aria-hidden="true" size={17} />仍要批准（说明理由）
                  </button>
                </> : <>
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={decisionPending}
                    onClick={() => openDecision("approve")}
                  >
                    <Check aria-hidden="true" size={17} />批准进入发布包
                  </button>
                  <button className="button button-secondary" type="button" disabled={decisionPending} onClick={() => openDecision("reject")}>
                    <XCircle aria-hidden="true" size={17} />终止制作
                  </button>
                </>}
              </div>
            </section>
          ) : (
            <section className={`run-state-panel${run.failure ? " has-failure" : ""}`}>
              {run.failure ? <>
                <p className="eyebrow">{sourceAssetFailure
                  ? (sourceReviewIncomplete(run.failure) ? "制作已暂停，画面与费用都已保留" : "制作已安全停止")
                  : `停在 ${run.failure.nodeLabel}`}</p>
                <h2>{sourceAssetFailure
                  ? (sourceReviewIncomplete(run.failure) ? "试片审查还没完成" : "画面预检未通过")
                  : `${run.failure.nodeLabel}没有完成`}</h2>
                {sourceAssetFailure ? <>
                  <div className="run-failure-breakdown">
                    <strong>结论</strong>
                    <ul>{sourceAssetFailure.conclusion.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                  </div>
                  {sourceAssetFailure.sceneFindings.length > 0 ? <div className="run-failure-breakdown">
                    <strong>逐镜问题</strong>
                    <ul>{sourceAssetFailure.sceneFindings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
                  </div> : null}
                  <div className="run-failure-impact">
                    <strong>已保留的内容</strong>
                    {sourceAssetFailure.preservedContent.map((fact) => <span key={fact}>{fact}</span>)}
                  </div>
                  <div className="run-failure-breakdown">
                    <strong>下一步</strong>
                    <ul className="run-recovery-list">
                      {sourceAssetFailure.nextSteps.map((action) => <li key={action}>{action}</li>)}
                    </ul>
                  </div>
                </> : <>
                  <p className="run-failure-summary">{run.failure.summary}</p>
                  {(["asset-source-review", "visual-review"].includes(run.failure.nodeId) || run.failure.category === "infrastructure" || /源素材视觉预检|媒体处理失败|ASSET_SEARCH_SOURCES_UNAVAILABLE|图库候选检索全部来源失败/.test(run.failure.technicalDetail ?? "")) && run.failure.technicalDetail
                    ? <details className="run-technical-details"><summary>查看技术详情</summary><p className="run-failure-summary"><strong>失败原因：</strong>{creatorFacingTechnicalText(run.failure.technicalDetail)}</p></details>
                    : null}
                  <div className="run-failure-impact">
                    <strong>{run.resultAvailability?.label ?? "前序结果已保留"}</strong>
                    <span>{run.failure.impact}</span>
                  </div>
                  <p className="run-saved-work">已保留前面 {run.failure.savedNodeCount} 个步骤的结果</p>
                  <ul className="run-recovery-list">
                    {run.failure.recoveryActions.map((action) => <li key={action}>{action}</li>)}
                  </ul>
                </>}
              </> : <>
                <h2>当前状态</h2>
                <p>{runStateMessage(run)}</p>
              </>}
              {visiblePaidNodeSummary ? <PaidOperationPanel
                summary={visiblePaidNodeSummary}
                providers={providers}
                busy={nodeMutationPending}
                {...(uncertainPaidNodeProviderId ? { providerIdHint: uncertainPaidNodeProviderId } : {})}
                {...(onReconcilePaidNode ? { onReconcile: onReconcilePaidNode } : {})}
              /> : null}
              {run.status === "succeeded" && onOpenPublish ? <button className="button button-primary" type="button" onClick={onOpenPublish}><Send aria-hidden="true" size={16} />准备各平台发布包</button> : null}
              {run.status === "succeeded" && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />基于这版重新制作</button> : null}
              {hasPendingPlanningConfiguration && (run.status === "failed" || run.status === "rejected") ? <p className="run-failure-summary">模型选择尚未保存。请先保存模型，或恢复为当前模型后再重试。</p> : null}
              {(run.status === "failed" || run.status === "rejected") && (run.failure?.retryable !== false || run.taskRecovery?.allowedActions.includes("retry_failed_step")) && !hasUncertainPaidOutcome(run) && (!run.taskRecovery || run.taskRecovery.allowedActions.includes("retry_failed_step")) && onRetryFailedNode && retryableNodeId(run) ? <button className="button button-primary" type="button" disabled={nodeMutationPending || hasPendingPlanningConfiguration} onClick={() => void onRetryFailedNode(retryableNodeId(run)!)}><RotateCcw aria-hidden="true" size={16} />{sourceAssetFailure && run.status === "rejected" ? "重新检查已有试片" : run.failure?.nodeId === "visual-review" ? "重试视觉审片" : "重试失败步骤"}</button> : null}
              {(run.status === "failed" || run.status === "rejected") && !hasUncertainPaidOutcome(run) && (!run.taskRecovery || run.taskRecovery.allowedActions.includes("adjust_plan")) && onRestart ? <button className="button button-secondary" type="button" onClick={onRestart}><RotateCcw aria-hidden="true" size={16} />调整方案后重新制作</button> : null}
              {run.status === "stale" && onRegenerateStale ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onRegenerateStale()}><RotateCcw aria-hidden="true" size={16} />{isCostReplan ? "按降本意见重新规划并报价" : "按人工版本继续生成"}</button> : null}
              {run.status === "paused" && onResumePaused ? <button className="button button-primary" type="button" disabled={nodeMutationPending} onClick={() => void onResumePaused()}><Play aria-hidden="true" size={16} />继续自动制作</button> : null}
            </section>
          )}

        </aside>
      </div> : null}

      </div>
      {remainingCreatorNodes.length ? <section id="run-artifacts" className="role-workspaces" aria-labelledby="role-workspaces-title">
        <header className="section-heading"><div><p className="eyebrow">创作内容</p><h2 id="role-workspaces-title">逐项预览与修改</h2><p>这里只呈现会影响作品、并且适合人工调整的内容。路径、版本和运行参数不会占用你的注意力。</p></div><span>{remainingCreatorNodes.length} 项</span></header>
        <div className="node-workspace-list">
          {remainingCreatorNodes.map(renderNodeWorkspace)}
        </div>
      </section> : null}

      {costDetail ? <div id="run-costs"><RunCostDetailPanel detail={costDetail} providers={providers} /></div> : null}

      {replanningVoice && voiceTiming ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={voiceTimingDialogRef} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="voice-timing-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">调整统一方案</p><h2 id="voice-timing-title">调整配音时长</h2></div>
              <button className="icon-button" type="button" onClick={closeVoiceTimingDecision} disabled={decisionPending} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <p>自然配音需要 {voiceTiming.requiredSeconds} 秒，当前镜头只有 {voiceTiming.plannedSeconds} 秒。接受新时长后，系统会重排统一时间轴并重新检查素材、画面和成片。</p>
            <label className="field field-wide">
              <span>{`镜头 ${voiceTiming.scenePosition} 时长（秒）`}</span>
              <input
                type="number"
                min={voiceTiming.requiredSeconds}
                max={180}
                step="0.001"
                value={voiceDurationSeconds}
                onChange={(event) => setVoiceDurationSeconds(event.target.value)}
                data-dialog-initial-focus
              />
            </label>
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={closeVoiceTimingDecision} disabled={decisionPending}>取消</button>
              <button
                className="button button-primary"
                type="button"
                disabled={decisionPending || !decisionSnapshot || !Number.isFinite(Number(voiceDurationSeconds)) || Number(voiceDurationSeconds) < voiceTiming.requiredSeconds}
                onClick={() => decisionSnapshot && void onDecision({
                  action: "request_changes",
                  ...decisionSnapshot,
                  voiceTiming: {
                    scenePosition: voiceTiming.scenePosition,
                    durationSeconds: Number(voiceDurationSeconds),
                  },
                })}
              ><RotateCcw aria-hidden="true" size={17} />接受新时长并继续制作</button>
            </footer>
          </section>
        </div>
      ) : null}
      {rejecting ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={rejectDialogRef} className="reject-dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">终态操作</p><h2 id="reject-title">终止这条视频的制作</h2></div>
              <button className="icon-button" type="button" onClick={closeRejectDecision} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            <p className="agent-review-guidance">终止是终态：这条视频会停止制作，<strong>不会自动返修</strong>，也不会产出发布包。若只是某一镜不合适，请关掉这个窗口，用审片结论旁边的返工入口（换一版素材 / 改这一镜旁白 / 用已有镜头替换）处理。</p>
            <label className="field field-wide">
              <span>终止原因</span>
              <textarea value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} placeholder="说明为什么这条视频不值得继续制作" rows={4} data-dialog-initial-focus />
            </label>
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={closeRejectDecision}>取消</button>
              <button
                className="button button-danger"
                type="button"
                disabled={!rejectNote.trim() || decisionPending || !decisionSnapshot}
                  onClick={() => decisionSnapshot && void onDecision({ action: "reject", note: rejectNote.trim(), ...decisionSnapshot })}
              >
                <XCircle aria-hidden="true" size={17} />确认终止
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {approving ? (
        <div className="dialog-backdrop" role="presentation">
          <section ref={approveDialogRef} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="approve-title" tabIndex={-1}>
            <header className="dialog-header">
              <div><p className="eyebrow">{sourcePreflightDecision ? "素材预检" : sourceReviewIncompleteRisk ? "未完成审查" : sourceReviewDecision ? "试片质量意见" : boundaryGate ? "节点放行" : "最终决定"}</p><h2 id="approve-title">{sourcePreflightDecision
                ? "接受当前素材风险，继续制作"
                : sourceReviewIncompleteRisk
                ? "接受未完成审查，继续生成首版"
                : sourceReviewDecision
                ? "确认承担这些质量意见后继续"
                : boundaryGate
                ? `确认放行「${runNodeLabel(run.activeIntervention?.nodeId ?? "")}」`
                : reviewItems.length > 0 ? "逐条表态后批准成片" : "确认批准成片"}</h2></div>
              <button className="icon-button" type="button" onClick={closeApproveDecision} disabled={decisionPending} title="关闭"><X aria-hidden="true" size={19} /></button>
            </header>
            {/* 边界停点批准的是"这一步的产出可以往下走"，不生成发布包、不结束终审，也和机器质检无关。
                这里原来一律讲终审的话——用户点下去之前读到的最后一段话是错的。 */}
            <div className="decision-dialog-copy"><Check aria-hidden="true" size={22} /><p>{sourcePreflightDecision
              ? <><strong>你接受的是当前素材预检的质量风险，不是宣布审查通过。</strong><span>若复核未完成，仍如实保留“未完成、无评分”。继续配音与渲染时仍受原费用授权限制；这不是成片定版。</span></>
              : sourceReviewIncompleteRisk
              ? <><strong>你接受的是“审查没有结论”的事实，不是把它改成通过。</strong><span>已生成画面和费用事实会保留，继续只运行后续配音与渲染；不会重新购买已成功素材，最终仍显示为可播放首版而非正式发布通过。</span></>
              : sourceReviewDecision
              ? <><strong>你确认的是：已看过这份试片意见，愿意按当前方案继续。</strong><span>系统不会重新购买已生成试片；其它尚未生成的素材仍会先依据当前报价和授权处理。</span></>
              : boundaryGate
              ? <><strong>放行后这一步的结果就固定下来，制作按现在保存的设置继续往下走。</strong><span>想换模型、参数或输入，请先关掉这个窗口去配置；放行之后要改，就得让这一步连同下游重做。</span></>
              : <><strong>{reviewItems.length > 0
                ? `审片提出 ${reviewItems.length} 条结论，请逐条看过并表态。`
                : "批准后将生成发布包。"}</strong><span>这会结束人工终审；请确认已经完整观看画面、字幕并听过声音。</span></>}</p></div>
            {/* 逐条表态管的是审片结论。机器质检是判过或不过的闸门——它不通过时流程走不到终审，
                所以这里没有它的条目，操作员不必怀疑自己漏签了什么。边界停点上两件事都不涉及。 */}
            {boundaryGate || sourcePreflightDecision ? null : <p className="review-disposition-note">技术质检不适用逐条表态：它由机器判定通过或不过，没过就到不了这一步，不在这里逐条签。</p>}
            {reviewItems.length > 0 ? <div className="review-disposition-list">
              <p className="review-disposition-guide">采纳=现在返修；不采纳=认为意见不成立，需写理由；接受风险=认可问题，但保留本版和原始评分。</p>
              {reviewItems.map((item, index) => {
                const itemKey = item.itemKey!;
                const choice = reviewDecisions[itemKey];
                const previousReason = reviewItems
                  .slice(0, index)
                  .map((candidate) => candidate.itemKey ? reviewDecisions[candidate.itemKey]?.reason.trim() : undefined)
                  .filter((reason): reason is string => Boolean(reason))
                  .at(-1);
                return <article className={`review-disposition-item is-${choice?.decision ?? "undecided"}`} key={itemKey}>
                  <header>
                    <strong>{item.scenePosition ? `镜头 ${item.scenePosition}` : `第 ${index + 1} 条`} · {reviewItemTimecode(item)}</strong>
                    <span>{reviewEvidenceStatusLabel(item)}</span>
                  </header>
                  <p>{creatorFacingTechnicalText(item.description)}</p>
                  <small>{creatorFacingTechnicalText(item.suggestion)}</small>
                  <FindingVerdictChange finding={item} />
                  <div className="review-disposition-choices">
                    <button className="button button-ghost" type="button" aria-pressed={choice?.decision === "accept_risk"}
                      onClick={() => setReviewDecision(itemKey, "accept_risk")}>接受风险，保留本版</button>
                    <button
                      className="button button-ghost"
                      type="button"
                      aria-pressed={choice?.decision === "reject"}
                      onClick={() => setReviewDecision(itemKey, "reject")}
                    >不采纳，维持现状</button>
                    <button
                      className="button button-ghost"
                      type="button"
                      aria-pressed={choice?.decision === "accept"}
                      onClick={() => setReviewDecision(itemKey, "accept")}
                    >采纳，先返修</button>
                  </div>
                  {choice?.decision === "accept" ? <p className="review-disposition-hint" role="status">已采纳：这条结论需要先返修，本轮不能批准。</p> : null}
                  {choice?.decision === "reject" ? <label className="field field-wide">
                    <span>不采纳理由</span>
                    <textarea
                      value={choice.reason}
                      onChange={(event) => setReviewReason(itemKey, event.target.value)}
                      placeholder="写明你核对后的判断，例如：已逐帧看过，这里是有意为之"
                      rows={2}
                      maxLength={500}
                      {...(index === 0 ? { "data-dialog-initial-focus": true } : {})}
                    />
                    {previousReason ? <button className="button button-ghost" type="button" onClick={() => setReviewReason(itemKey, previousReason)}>与上一条相同</button> : null}
                  </label> : null}
                </article>;
              })}
            </div> : null}
            <label className="field field-wide decision-override-field">
              <span>批准备注（选填）</span>
              <textarea value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder="想补充的整体判断" rows={2} />
            </label>
            {reviewItems.length > 0 && (undisposedReviewItems.length > 0 || acceptedReviewItems.length > 0) ? <p className="review-disposition-blocker" role="status">
              {undisposedReviewItems.length > 0 ? `还有 ${undisposedReviewItems.length} 条没有表态。` : ""}
              {acceptedReviewItems.length > 0 ? `其中 ${acceptedReviewItems.length} 条已采纳、还等着返修。` : ""}
            </p> : null}
            <footer className="dialog-actions">
              <button className="button button-ghost" type="button" onClick={closeApproveDecision} disabled={decisionPending}>{boundaryGate ? "先不放行" : "再看一遍"}</button>
              <button
                className="button button-primary"
                type="button"
                disabled={decisionPending || !decisionSnapshot
                  || undisposedReviewItems.length > 0
                  || acceptedReviewItems.length > 0
                  || unexplainedReviewItems.length > 0}
                onClick={() => decisionSnapshot && void onDecision({
                  action: "approve",
                  ...decisionSnapshot,
                  ...(approvalNote.trim() ? { note: approvalNote.trim() } : {}),
                  ...(reviewItems.length > 0 ? {
                    reviewDispositions: reviewItems.map((item) => {
                      const choice = reviewDecisions[item.itemKey!]!;
                      return choice.decision === "accept"
                        ? { itemKey: item.itemKey!, decision: "accept" as const }
                        : { itemKey: item.itemKey!, decision: choice.decision, ...(choice.reason.trim() ? { reason: choice.reason.trim() } : {}) };
                    }),
                  } : {}),
                })}
              ><Check aria-hidden="true" size={17} />{decisionPending
                ? "正在批准..."
                : sourceReviewDecision || sourcePreflightDecision || sourceReviewIncompleteRisk ? "确认承担并继续"
                  : boundaryGate ? "确认放行，进入下一步"
                  : reviewItems.length > 0 ? "逐条表态已完成，生成发布包" : "确认批准并生成发布包"}</button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function formatRecoveryTime(value: string): string {
```

### Original lines 1547-1780

```
function ProductionProgress({ run }: { run: StudioRunDetail }) {
  if (!run.progress || !run.phases) return null;
  return <section className="production-progress" aria-label="制作进度" data-tour="run-workflow">
    <header>
      <div><strong>制作阶段</strong><small>已完成 {run.progress.completedNodes} / {run.progress.totalNodes} 个步骤</small></div>
      <span>{creatorRunStatusLabel(run) ?? runNodeLabel(run.currentNodeId)}</span>
    </header>
    <div className="production-phases">
      {run.phases.map((phase, index) => <article className={`production-phase is-${phase.status}`} key={phase.id}>
        <span className="production-phase-index">{phase.status === "completed" ? <Check aria-hidden="true" size={13} /> : index + 1}</span>
        <div><strong>{phase.label}</strong><small>{phase.completedNodes}/{phase.totalNodes} 步骤</small></div>
      </article>)}
    </div>
  </section>;
}

function CurrentDecisionBar({ run }: { run: StudioRunDetail }) {
  const intervention = run.activeIntervention;
  if (!intervention) return null;
  const nodeName = runNodeLabel(intervention.nodeId);
  const incomplete = intervention.kind === "source_review_retry" && intervention.reviewStatus === "incomplete";
  const hardStop = intervention.kind === "source_review_retry" && intervention.reviewStatus === "unknown_or_unsafe";
  const state = incomplete ? "需要处理" : hardStop ? "需要处理" : "等你确认";
  const consequence = incomplete
    ? "接受后只继续后续制作，保留“审查未完成、无评分”事实。"
    : hardStop
      ? "付费、来源或媒体事实不明确，只能补查或终止。"
      : intervention.boundary === "node-complete"
        ? "放行后进入下一节点，不会重跑当前节点。"
        : "你的决定会被记录，已生成的版本和费用事实会保留。";
  return <section className={`current-decision-bar${hardStop ? " is-hard-stop" : incomplete ? " is-incomplete" : ""}`} aria-label="当前决定" role="status">
    <div className="current-decision-heading">
      <div><p className="eyebrow">当前决定</p><h2>{nodeName} · {state}</h2></div>
      <span className="current-decision-status">{state}</span>
    </div>
    <p>{consequence}</p>
    <dl>
      <div><dt>是否重跑</dt><dd>{intervention.boundary === "node-complete" ? "不重跑当前节点" : incomplete ? "可只重试审查" : "按页面提供的补查/终止动作"}</dd></div>
      <div><dt>费用影响</dt><dd>{hardStop ? "不自动新增费用" : "如需付费会重新报价并等你授权"}</dd></div>
      <div><dt>当前版本</dt><dd>已生成内容保留</dd></div>
    </dl>
  </section>;
}

function isStoppedStatus(status: StudioRunDetail["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected" || status === "paused" || status === "stale";
}

function hasDirectorCostFeedback(run: StudioRunDetail): boolean {
  const director = run.nodes.find((node) => node.id === "visual-direction");
  const effectiveInput = director?.inputState?.versions.find(
    (version) => version.id === director.inputState?.effectiveVersionId,
  )?.value;
  if (typeof effectiveInput !== "object" || effectiveInput === null || Array.isArray(effectiveInput)) return false;
  const costFeedback = (effectiveInput as Record<string, unknown>).costFeedback;
  return Array.isArray(costFeedback) ? costFeedback.length > 0 : typeof costFeedback === "object" && costFeedback !== null;
}

function retryableNodeId(run: StudioRunDetail): string | undefined {
  return run.nodes.find((node) => node.status === "failed")?.id
    ?? (run.failure && isSourceAssetReviewFailure(run.failure)
      ? run.nodes.find((node) => node.status === "rejected" && ["assets", "asset-source-review"].includes(node.id))?.id
      : undefined);
}

function hasUncertainPaidOutcome(run: StudioRunDetail): boolean {
  return run.nodes.some((node) => node.outcomeUncertain === true);
}

function isSourceAssetReviewFailure(failure: NonNullable<StudioRunDetail["failure"]>): boolean {
  return failure.nodeId === "asset-source-review"
    || (["assets", "asset-source-review"].includes(failure.nodeId)
      && /源素材视觉预检|试片未通过|试片审查暂未完成/.test(failure.technicalDetail ?? ""));
}

// 「审查没跑完」（复核服务不可用、模型没给出可用结论）和「审查未通过」（复核给出了否定
// 结论）是两回事：前者没有任何裁决，主动权在用户手里——等服务恢复或直接重试都行，措辞
// 必须说"暂停"而不是"未通过"，否则复核基础设施的一次故障就被渲染成作品被否。
function sourceReviewIncomplete(failure: NonNullable<StudioRunDetail["failure"]>): boolean {
  return isSourceAssetReviewFailure(failure)
    && /试片审查暂未完成|复审尚未完成/.test(failure.technicalDetail ?? "");
}

function runningNodeLabel(run: StudioRunDetail): string {
  const current = run.nodes.find((node) => node.id === run.currentAction?.nodeId)
    ?? run.nodes.find((node) => node.id === run.currentNodeId)
    ?? run.nodes.find((node) => node.status === "running")
    ?? run.nodes.find((node) => node.status === "pending");
  if (current?.id === "script") {
    const providerId = (current.executionReceipt ?? current.plannedExecution)?.providerId;
    return providerId === "codex-screenwriter-v1"
      ? "编剧与独立质量复核正在修改脚本"
      : "编剧正在生成结构化脚本";
  }
  return current ? `${current.role ?? "制作角色"}正在处理${stepNameFor(current, current.label)}` : "系统正在推进制作";
}

/**
 * 顶栏这一行回答的是"现在是谁在工作"，所以两半都必须站在界面自己的词汇里——名字走
 * capacityNameFor，模型走 recordedModelName，两处各自处理回执里的内部标识。
 */
function activeNodeModel(run: StudioRunDetail, providers: StudioProvider[]): string | undefined {
  const current = run.nodes.find((node) => node.id === run.currentAction?.nodeId)
    ?? run.nodes.find((node) => node.status === "running");
  if (!current) return undefined;
  const execution = current.executionReceipt ?? current.plannedExecution;
  if (!execution) return undefined;
  const name = stepNameFor(current, execution.providerLabel);
  const model = recordedModelName(execution.modelId, providers);
  return model ? `${name} · ${model}` : name;
}

/**
 * 界面里的步骤名。候选名来自回执（`providerLabel`）或节点自身（`label`），两者都可能是流水线
 * 内部的英文标识——`brief` 是 "Validate brief"，导演方案是 "Direct visual plan"，终审是
 * "Human final review"。带中文的候选名才是界面词汇（「AI 视觉导演」这类 provider 名），保留它
 * 能说清"是哪一台在跑"；英文的一律换成界面按 nodeId 维护的中文步骤名，否则拼进中文句子里
 * 就是半截中英混排。NodeWorkspace 一直是这么渲染的，只有本组件漏了。
 */
function stepNameFor(
  node: StudioRunDetail["nodes"][number],
  candidateLabel: string | undefined,
): string {
  const label = candidateLabel?.trim();
  if (label && /[一-鿿]/.test(label)) return label;
  return RUN_NODE_LABELS[node.id] ?? node.role?.trim() ?? runNodeLabel(node.id);
}

function recordedModelName(modelId: string | undefined, providers: StudioProvider[]): string | undefined {
  const id = modelId?.trim();
  // 本地编排节点（brief、创作规划）自己不调模型，模型在它下面的阶段里。回执记的 "inline" 是个
  // 字面量、不是模型，所以整段模型名都不显示：把"这一步不直接调模型"说成"我们没记下来"，
  // 用户会以为记录丢了。
  if (!id || id === "inline") return undefined;
  return catalogModelLabel(providers, id) ?? "模型名称未记录";
}

function etaLabel(progress: NonNullable<StudioRunDetail["progress"]>): string {
  if (progress.eta) return `预计还需 ${formatDuration(progress.eta.lowSeconds)}–${formatDuration(progress.eta.highSeconds)}`;
  if (progress.etaUnavailableReason === "waiting_for_human") return "等待你的确认，不计算 ETA";
  if (progress.etaUnavailableReason === "future_human_gate") return "后续有人工或费用确认，暂不估算整条耗时";
  if (progress.etaUnavailableReason === "insufficient_history") return `暂无法估算剩余时间；已处理 ${formatDuration(progress.elapsedSeconds)}`;
  return "当前流程已停止计时";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "刚刚" : new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function runStateMessage(run: StudioRunDetail): string {
  if (run.status === "succeeded") {
    return "制作已完成，发布包可以下载使用。";
  }
  if (run.status === "rejected") {
    const humanDecision = run.decisions.at(-1);
    if (humanDecision) {
      return humanDecision.note ?? "成片已被人工打回，审片意见已保留。请回到今日机会重新发起制作。";
    }
    const rejectedReason = run.nodes.find((node) => node.status === "rejected")?.error;
    return creatorFacingTechnicalText(rejectedReason)
      ?? "成片未通过机器质检，请查看质检报告后重新发起制作。";
  }
  if (run.status === "failed") {
    if (hasUncertainPaidOutcome(run)) {
      return "付费服务可能已经受理请求，但结果尚未确认。系统已停止重试和重新制作，请先到服务商控制台核对任务与账单。";
    }
    return safeRunError(run.nodes.find((node) => node.status === "failed")?.error);
  }
  if (run.status === "awaiting_spend_approval") return "即将生成付费图片或视频，请先检查前面的内容、模型和本次报价。";
  if (run.status === "needs_human") return "正在等待你的意见或确认；你可以继续讨论，确认后才会进入下一步。";
  if (run.status === "approval_invalidated") return "输入、模型、报价或重试次数发生了变化，之前的费用确认已失效，请重新检查。";
  if (run.status === "stale" && hasDirectorCostFeedback(run)) {
    return "你已把上一份画面报价退回导演，降本意见已经保存。继续后会先调整方案，再给你一份新报价。";
  }
  if (run.status === "stale") return "上游内容已被人工修改；系统会重新检查每一步是否仍然适用，只重做失效的部分，保留仍然有效的成果。";
  if (run.status === "paused") return "制作已经安全暂停。现在可以修改已完成角色的输入或交付；不修改也可以直接继续。";
  if (run.pauseRequested) return "已请求暂停；当前步骤会先安全完成，系统将在下一步开始前停下。";
  return "制作正在自动执行，详情页会实时更新；连接中断时会明确提示。";
}

// 边界停点之后、还没开始跑的第一个带可调执行的节点。机械步骤（渲染、技术质检、终审）
// 在服务端就不下发 executionConfiguration，自然落选——露出一个没有可调项的面板只是空壳。
function nextConfigurableNode(run: StudioRunDetail): StudioRunDetail["nodes"][number] | undefined {
  const waitingIndex = run.nodes.findIndex((node) => node.id === run.activeIntervention?.nodeId);
  if (waitingIndex < 0) return undefined;
  return run.nodes
    .slice(waitingIndex + 1)
    .find((node) => node.status === "pending" && node.executionConfiguration !== undefined);
}

function nodeHasCreatorContent(node: StudioRunDetail["nodes"][number], run: StudioRunDetail): boolean {
  if (NON_CREATIVE_WORKSPACE_NODE_IDS.has(node.id)) return false;
  if (["awaiting_spend_approval", "approval_invalidated", "needs_human", "stale", "failed", "rejected"].includes(node.status)) return true;
  if (hasContent(node.output)) return true;
  if (node.outputState?.versions.some((version) => hasContent(version.output) || version.artifactIds.length > 0)) return true;
  return node.artifactIds.some((artifactId) => run.artifacts.some((artifact) => artifact.id === artifactId && Boolean(artifact.contentUrl)));
}

const NON_CREATIVE_WORKSPACE_NODE_IDS = new Set(["render", "technical-review", "final-review"]);

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasContent);
  return true;
}

// 只滤掉"英文开头 + failed/error"这一类是不够的：桥接失败消息常常以中文叙述开头，
// 中间夹着 stage=/reasonCode=/诊断： 这类机器诊断，旧判据会把它原样放行到界面上。
const TECHNICAL_DIAGNOSTIC_PATTERN = /诊断：|\b(?:stage|httpStatus|failureKind|reasonCode|fieldPath|taskKind|requestIdHash|accepted)=/;

function safeRunError(message?: string): string {
  if (!message) return "制作失败，请检查对应能力和本地运行环境。";
  if (message.includes("应用重启")) return message;
  if (/\/(Users|home|private|tmp)\//.test(message)
    || /^[A-Za-z].*(failed|error|invalid|missing)/i.test(message)
    || TECHNICAL_DIAGNOSTIC_PATTERN.test(message)) {
    return "这一步执行失败。技术细节已保留在本地服务日志中，请检查对应能力后重试。";
  }
  return message;
}
```

## apps/studio/src/client/components/CreativeDiscussionPanel.tsx

SHA256: 8a789d63736773dea15da9db9022227110a4d7c8e1ed86480caacb8839e4eebb; 507 lines. FULL FILE.

### Original lines 1-507

```
import { ArrowLeft, Check, FilePenLine, MessageCircle, RotateCcw, Save, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { StudioCreativeReviewCommandInput, StudioCreativeReviewSnapshot } from "../../shared/api.js";

interface CreativeDiscussionPanelProps {
  review: StudioCreativeReviewSnapshot;
  busy: boolean;
  onCommand(input: StudioCreativeReviewCommandInput): Promise<void>;
}

// 与 PlanningStagesPanel 的阶段名保持一致。这里曾经把 treatment 写成"导演方案"、
// 把 director 写成"分镜与画面方案"，于是同一个停点的标题和提示各说各的名字。
const STAGE_LABEL = { treatment: "前期构思", script: "脚本", director: "导演方案" } as const;

export function CreativeDiscussionPanel({ review, busy, onCommand }: CreativeDiscussionPanelProps) {
  const storageKey = `vf:creative-draft:${review.runId}:${review.stage}`;
  const commandStorageKey = `vf:creative-command:${review.runId}:${review.stage}`;
  const currentStorageKey = useRef(storageKey);
  currentStorageKey.current = storageKey;
  const [message, setMessage] = useState(() => window.localStorage.getItem(storageKey) ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const [mobileTab, setMobileTab] = useState<"draft" | "discussion">("draft");
  const hasBlockingIssues = review.blockingIssues.length > 0;
  // 草稿一变 publishCreativeDraft 必然清空 checkResult，所以在场的 repair 一定是针对当前草稿的。
  // 复核是"提议"而不是"否决"：此时确认仍然可用，但必须由人显式承担，并把被接受的意见记进
  // confirmation.acknowledgedRepair，事后能查到是谁在什么结论下放行的。
  const awaitingRepair = review.checkResult?.verdict === "repair";
  const incompleteCheck = review.checkResult?.status === "incomplete";
  const qualityAdvisories = review.qualityAdvisories ?? [];
  const needsStockConsent = review.stage === "director" && qualityAdvisories.length > 0;
  const commandBase = useMemo(() => ({
    expectedRunRevision: review.runRevision,
    expectedReviewRevision: review.reviewRevision,
    stage: review.stage,
    baseDraftSha256: review.draftSha256,
  }), [review]);

  useEffect(() => {
    setMessage(window.localStorage.getItem(storageKey) ?? "");
    setSelectedIds([]);
  }, [storageKey]);

  useEffect(() => {
    if (message) window.localStorage.setItem(storageKey, message);
    else window.localStorage.removeItem(storageKey);
  }, [message, storageKey]);

  async function submit(input: StudioCreativeReviewCommandInput, clearMessage = false) {
    setError(undefined);
    const pending = readPendingCommand(commandStorageKey);
    const command = pending && sameCommandBody(pending, input) ? pending : input;
    window.localStorage.setItem(commandStorageKey, JSON.stringify(command));
    try {
      await onCommand(command);
      window.localStorage.removeItem(commandStorageKey);
      if (clearMessage && currentStorageKey.current === storageKey) setMessage((current) => current === message ? "" : current);
    } catch (caught) {
      if (caught instanceof Error && "commandCompleted" in caught && caught.commandCompleted === true) {
        window.localStorage.removeItem(commandStorageKey);
      }
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  }

  function sendMessage() {
    const text = message.trim();
    if (!text || busy || !review.allowedActions.includes("discuss")) return;
    void submit({
      action: "discuss",
      commandId: crypto.randomUUID(),
      ...commandBase,
      message: text,
      ...(selectedIds.length ? { selection: creativeSelection(review.stage, selectedIds) } : {}),
    }, true).catch(() => undefined);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== "Enter" || !event.ctrlKey) return;
    event.preventDefault();
    sendMessage();
  }

  function confirmDraft() {
    if (busy || hasUnsavedEdits || !review.allowedActions.includes("confirm")) return;
    if ((awaitingRepair || incompleteCheck || needsStockConsent) && !window.confirm([
      ...(awaitingRepair ? ["独立复核对当前这一版提出了意见，还没有通过。"] : []),
      ...(incompleteCheck ? ["独立复核没有得到有效结论。这不是审查通过，也没有质量评分；你可以承担未完成复核的风险采用本版。"] : []),
      ...(needsStockConsent ? ["当前示意素材匹配得分较低或视觉核验未完成。接受后先制作首版，原始评分与问题会保留；不会扩大费用授权，也不会将示意画面用作真实事件证据。"] : []),
      "继续会保留你的采用决定。确定仍然确认吗？",
    ].join("\n\n"))) return;
    void submit({
      action: "confirm",
      commandId: crypto.randomUUID(),
      ...commandBase,
      // 把界面上这一条复核的身份原样带回去：确认要指向人看到的意见，不能指向服务端
      // 此刻恰好记着的那一条。
      ...(review.checkResult ? { expectedCheckIdentity: review.checkResult.checkIdentity } : {}),
      ...(awaitingRepair ? { acknowledgeRepair: true } : {}),
      ...(incompleteCheck ? { acknowledgeIncomplete: true as const } : {}),
      ...(needsStockConsent ? { acceptQualityFallback: true as const } : {}),
    }).catch(() => undefined);
  }

  function returnToStage(target: StudioCreativeReviewSnapshot["returnTargets"][number]) {
    if (busy || hasUnsavedEdits || !review.allowedActions.includes("return_to_stage") || !window.confirm(`${target.impact}\n\n确定${target.label}吗？`)) return;
    void submit({
      action: "return_to_stage",
      commandId: crypto.randomUUID(),
      ...commandBase,
      targetStage: target.stage,
      acknowledgeImpact: true,
    }).catch(() => undefined);
  }

  async function saveEditedDraft(document: Record<string, unknown>) {
    if (busy || !review.allowedActions.includes("edit_draft")) throw new Error("当前版本暂不允许保存，请等待操作完成。");
    await submit({
      action: "edit_draft",
      commandId: crypto.randomUUID(),
      ...commandBase,
      document,
    });
  }

  return (
    <section className="creative-discussion-panel" aria-labelledby="creative-review-title">
      <header className="creative-discussion-header">
        <div>
          <h2 id="creative-review-title">{hasBlockingIssues ? "当前导演方案需要你决定" : `${STAGE_LABEL[review.stage]}已生成，等你确认`}</h2>
          {hasBlockingIssues ? <p>自动选材尚未通过，具体原因见下方。已保留你确认的方案，不会自动改成生成画面；请在讨论区说明允许怎样调整，或补充素材。</p> : null}
        </div>
        <span className={`creative-review-phase phase-${review.phase}`}>
          {review.phase === "checking" ? "正在处理原操作" : `第 ${review.reviewRevision} 版讨论`}
        </span>
      </header>

      <div className="creative-mobile-tabs" role="group" aria-label="方案与讨论">
        <button type="button" aria-pressed={mobileTab === "draft"} aria-controls="creative-draft" onClick={() => setMobileTab("draft")}>当前方案</button>
        <button type="button" aria-pressed={mobileTab === "discussion"} aria-controls="creative-chat" onClick={() => setMobileTab("discussion")}>讨论{review.messages.length > 0 ? ` · ${review.messages.length}` : ""}</button>
      </div>

      <div className="creative-discussion-layout">
        <article id="creative-draft" tabIndex={0} className={mobileTab === "draft" ? "creative-draft-surface is-mobile-active" : "creative-draft-surface"} aria-label={`当前${STAGE_LABEL[review.stage]}`}>
          <CreativeDraftEditor storageKey={`${storageKey}:edit`} draftIdentity={`${review.draftArtifactId}:${review.draftSha256}`} stage={review.stage} draft={review.draft} busy={busy || review.phase === "checking" || !review.allowedActions.includes("edit_draft")} onSave={saveEditedDraft} onDirtyChange={setHasUnsavedEdits} />
          <CreativeDraft stage={review.stage} value={review.draft} />
          {incompleteCheck ? <section className="creative-check-result" role="status"><strong>独立复核未完成 · 无评分</strong><p>{review.checkResult?.summary}</p></section> : null}
          {needsStockConsent ? <section className="creative-check-result" role="status">
            <strong>可以先制作首版，但请了解素材风险</strong>
            <ul>{qualityAdvisories.map((issue, index) => <li key={index}>镜头 {issue.scenePositions.join("、")}：{issue.reason}</li>)}</ul>
            <p>接受不会改分、不会伪装成已核验，也不增加费用授权。你仍可以先讨论调整方案。</p>
          </section> : null}
          <details className="creative-selection-disclosure"><summary>指定讨论范围{selectedIds.length > 0 ? ` · 已选 ${selectedIds.length} 项` : "（可选）"}</summary><CreativeSelection
            stage={review.stage}
            draft={review.draft}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
          /></details>
          {review.previousDraft !== undefined ? <details><summary>查看上一版</summary><CreativeDraft stage={review.stage} value={review.previousDraft} /></details> : null}
          {review.checkResult?.verdict === "repair" ? <section className="creative-check-result" role="status">
            <strong>有 {review.checkResult.issues.length} 处需要调整，尚未进入下一步</strong>
            <p>{review.checkResult.summary}</p>
            <ul>{review.checkResult.issues.map((issue, index) => <li key={`${issue.criterion}:${index}`}>
              <strong>{issue.criterion}</strong><span>{issue.repairInstruction}</span>
              {/* 复核已经定位到具体条目，人不必再把字段级意见翻译成散文重述一遍；
                  只预填不发送，改不改、怎么改仍由人按下发送键决定。 */}
              <div className="creative-check-actions">
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => {
                  setMessage([
                    "只按下面这一条意见修改，不要扩大改动范围。",
                    "",
                    `意见：${issue.criterion}`,
                    `复核给的修复指令：${issue.repairInstruction}`,
                    `依据：${issue.evidence}`,
                    "",
                    "如果这条指令给了多个可选分支，请按最保守的一支执行，并说明你选了哪一支。",
                  ].join("\n"));
                  setMobileTab("discussion");
                }}>按这条意见改</button>
                <button type="button" className="button button-ghost" disabled={busy} onClick={() => {
                  setMessage([
                    "这条意见我不接受，理由如下：",
                    "",
                    "",
                    "请保留当前做法，不要按这条意见改；如果你认为该判断成立，请说明依据。",
                    "",
                    `（原意见：${issue.criterion}）`,
                  ].join("\n"));
                  setMobileTab("discussion");
                }}>这条我不同意</button>
              </div>
            </li>)}</ul>
          </section> : null}
          {/* 停在这里是因为自动循环推不动了，不是这一版做完了。不说出来，人会以为一切正常。 */}
          {review.stopDetail ? <section className="creative-check-result" role="status">
            <strong>自动检查已停止，需要你决定</strong>
            <p>{review.stopDetail}</p>
          </section> : null}
          {hasBlockingIssues ? <section className="creative-check-result" role="status">
            <strong>素材选择需要你处理</strong>
            <ul>{review.blockingIssues.map((issue, index) => <li key={`${issue.reason}:${index}`}>
              <strong>{issue.scenePositions.length > 0 ? `镜头 ${issue.scenePositions.join("、")}` : "当前方案"}</strong>
              <span>{issue.reason}。{issue.requiredChange}</span>
            </li>)}</ul>
          </section> : null}
          {review.proposals.map((proposal) => <section className="creative-proposal" key={proposal.proposalId}>
            <header><strong>备选方案</strong><small>{proposal.changeSummary.join("；") || "可与当前方案比较"}</small></header>
            <CreativeDraft stage={review.stage} value={proposal.document} />
            <button type="button" className="button button-secondary" disabled={busy || hasUnsavedEdits || !review.allowedActions.includes("adopt_proposal")} onClick={() => void submit({ action: "adopt_proposal", commandId: crypto.randomUUID(), ...commandBase, proposalId: proposal.proposalId }).catch(() => undefined)}>采用这个备选</button>
          </section>)}
        </article>

        <section id="creative-chat" className={mobileTab === "discussion" ? "creative-chat-surface is-mobile-active" : "creative-chat-surface"} aria-label="与当前角色讨论">
          <header className="creative-chat-heading"><MessageCircle aria-hidden="true" size={17} /><strong>一起打磨这一版</strong></header>
          <div className="creative-message-list" aria-live="polite">
            {review.messages.length === 0 ? <p className="creative-empty-chat"><MessageCircle aria-hidden="true" size={18} />还没有讨论。可以问为什么这样安排，或直接说想改成什么样。</p> : null}
            {review.messages.map((entry) => <p key={entry.id} className={`creative-message message-${entry.role}`}><span>{entry.role === "user" ? "你" : "创作角色"}</span>{entry.text}</p>)}
          </div>
          <div className="creative-quick-prompts" aria-label="讨论提示">
            {["解释这个安排", "开头不够吸引", "给我另一个方向，但先不要替换"].map((text) => <button type="button" key={text} disabled={busy} onClick={() => setMessage(text)}>{text}</button>)}
          </div>
          <label className="creative-composer">
            <span>聊聊你的想法</span>
            <textarea value={message} maxLength={4000} onChange={(event) => setMessage(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="例如：为什么这样开场？或者：把开头改得更直接一些。" />
            <small>Ctrl + Enter 发送；普通换行不会发送。</small>
          </label>
          <button type="button" className="button button-secondary" disabled={busy || !message.trim() || !review.allowedActions.includes("discuss")} onClick={sendMessage}><Send aria-hidden="true" size={16} />{busy ? "正在处理…" : "发送"}</button>
        </section>
      </div>

      {error ? <p className="form-error" role="alert">{error} 输入内容已保留，请查看最新方案后再试。</p> : null}
      {review.returnTargets.length > 0 ? <aside className="creative-return-actions" aria-label="返回前期方案">
        <strong>需要调整更早的决定？</strong>
        <p>返回后只让受影响的后续方案失效，历史稿件和已可用素材会保留。</p>
        {review.returnTargets.map((target) => <button key={target.stage} type="button" className="button button-secondary" disabled={busy || hasUnsavedEdits || !review.allowedActions.includes("return_to_stage")} title={target.impact} onClick={() => returnToStage(target)}><ArrowLeft aria-hidden="true" size={16} />{target.label}</button>)}
      </aside> : null}
      <footer className="creative-review-actions">
        <div className="creative-confirm-context"><strong>{hasUnsavedEdits ? "有未保存的手动修改" : `确认对象：当前${STAGE_LABEL[review.stage]}`}</strong><small>{hasUnsavedEdits ? "先保存或放弃修改，再确认采用；不会提交编辑器里的未保存文字。" : "确认时独立复核，不会购买素材；有意见由你决定，后续步骤仍需确认。"}</small></div>
        <button type="button" className="button button-ghost" disabled={busy || hasUnsavedEdits || review.previousDraft === undefined || !review.allowedActions.includes("undo_draft")} onClick={() => void submit({ action: "undo_draft", commandId: crypto.randomUUID(), ...commandBase }).catch(() => undefined)}><RotateCcw aria-hidden="true" size={16} />撤销本轮修改</button>
        <button type="button" className="button button-primary" disabled={busy || hasUnsavedEdits || !review.allowedActions.includes("confirm")} onClick={confirmDraft}><Check aria-hidden="true" size={16} />{needsStockConsent ? "接受素材风险，先制作首版" : incompleteCheck ? "接受复核未完成，采用本版" : awaitingRepair ? "看过意见，仍然确认" : hasBlockingIssues ? "修改后重新检查" : "确认当前方案，继续"}</button>
      </footer>
    </section>
  );
}

function CreativeSelection({ stage, draft, selectedIds, onChange }: {
  stage: StudioCreativeReviewSnapshot["stage"];
  draft: unknown;
  selectedIds: string[];
  onChange(ids: string[]): void;
}) {
  const options = selectionOptions(stage, draft);
  if (options.length === 0) return null;
  return <fieldset className="creative-selection"><legend>讨论范围（可选）</legend>{options.map((option) => <label key={option.id}>
    <input type="checkbox" checked={selectedIds.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...selectedIds, option.id] : selectedIds.filter((id) => id !== option.id))} />
    {option.label}
  </label>)}</fieldset>;
}

function selectionOptions(stage: StudioCreativeReviewSnapshot["stage"], draft: unknown): Array<{ id: string; label: string }> {
  if (!isRecord(draft)) return [];
  if (stage === "treatment") return Array.isArray(draft.progression) ? draft.progression.flatMap((item, index) => isRecord(item) ? [{ id: String(item.beatId ?? `beat-${index + 1}`), label: `内容推进 ${index + 1}：${String(item.purpose ?? "")}` }] : []) : [];
  if (stage === "script") return Array.isArray(draft.scenes) ? draft.scenes.flatMap((item, index) => isRecord(item) ? [{ id: String(item.id ?? `scene-${index + 1}`), label: `第 ${Number(item.position ?? index + 1)} 段` }] : []) : [];
  return Array.isArray(draft.shots) ? draft.shots.flatMap((item, index) => isRecord(item) ? [{ id: `scene-${Number(item.scenePosition ?? index + 1)}`, label: `镜头 ${Number(item.scenePosition ?? index + 1)}` }] : []) : [];
}

function creativeSelection(stage: StudioCreativeReviewSnapshot["stage"], ids: string[]) {
  return {
    kind: stage === "treatment" ? "beat" as const : "scene" as const,
    ids,
    scenePositions: stage === "treatment" ? [] : ids.map((id) => Number(id.replace(/^scene-/, ""))).filter(Number.isInteger),
  };
}

function readPendingCommand(key: string): StudioCreativeReviewCommandInput | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as StudioCreativeReviewCommandInput | null;
    return value && typeof value === "object" && typeof value.commandId === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function sameCommandBody(left: StudioCreativeReviewCommandInput, right: StudioCreativeReviewCommandInput): boolean {
  const withoutCommandLeft = { ...left, commandId: "" };
  const rightWithoutId = { ...right, commandId: "" };
  return JSON.stringify(withoutCommandLeft) === JSON.stringify(rightWithoutId);
}

function CreativeDraft({ stage, value }: { stage: StudioCreativeReviewSnapshot["stage"]; value: unknown }) {
  if (!isRecord(value)) return <p>当前方案暂时无法读取，请刷新后重试。</p>;
  if (stage === "treatment") return <div className="creative-readable-draft">
    <DraftField label="观众看完能得到什么" value={value.viewerPromise} />
    <DraftField label="开头" value={isRecord(value.hook) ? `${String(value.hook.narrationIntent ?? "")} ${String(value.hook.visualIntent ?? "")}` : value.hook} />
    <DraftList label="内容推进" value={Array.isArray(value.progression) ? value.progression.map((beat) => isRecord(beat) ? `${String(beat.purpose ?? "")}：${String(beat.viewerGain ?? "")}` : String(beat)) : []} />
    <DraftField label="结尾兑现" value={value.payoff} />
    <DraftList label="视觉方向" value={value.visualPrinciples} />
    <DraftList label="声音方向" value={value.soundPrinciples} />
  </div>;
  if (stage === "script") return <div className="creative-readable-draft"><DraftField label="叙事推进（制作参考）" value={value.narrativeArc} />{Array.isArray(value.scenes) ? value.scenes.map((scene, index) => isRecord(scene) ? <section className="creative-scene" key={String(scene.id ?? index)}><strong>第 {Number(scene.position ?? index + 1)} 段 · {Number(scene.duration ?? 0)} 秒</strong><div className="creative-audience-copy"><small>旁白 · 观众听到的内容</small><p>{String(scene.narration ?? "")}</p></div><div className="creative-production-note"><small>画面描述 · 制作参考，尚未生成</small><p>{String(scene.visual_prompt ?? "")}</p></div></section> : null) : null}</div>;
  return <div className="creative-readable-draft">{isRecord(value.visualBible) ? <DraftField label="全片视觉规则" value={`${String(value.visualBible.narrativeApproach ?? "")} · ${String(value.visualBible.pacing ?? "")} · ${String(value.visualBible.continuity ?? "")}`} /> : null}{Array.isArray(value.shots) ? value.shots.map((shot, index) => isRecord(shot) ? <section className="creative-scene" key={String(shot.scenePosition ?? index)}><strong>镜头 {Number(shot.scenePosition ?? index + 1)} · {String(shot.deliveryType ?? "待定路线")}</strong><p>{String(shot.visibleAction ?? shot.generationPrompt ?? shot.query ?? "")}</p><small>预计时长与获取路线将在当前方案确认后进入报价；画面尚未生成。</small></section> : null) : null}</div>;
}

function DraftField({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return <section><strong>{label}</strong><p>{String(value)}</p></section>;
}

function DraftList({ label, value }: { label: string; value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return <section><strong>{label}</strong><ul>{value.map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 人工修订编辑器（v1）：只暴露各阶段合同里的**文字性字段**——叙述、承诺、视觉规则的措辞、
 * 每段/每镜的描述文字。镜头增删、路线更换这类结构性改动会牵动排序/报价/画面证据，仍然走
 * 讨论或重新生成；文字修订在这里改完保存，走与 AI 修订完全相同的制度：换稿 → 停点重现 →
 * 确认时自动跑一轮新的独立复核。
 */
function CreativeDraftEditor({ storageKey, draftIdentity, stage, draft, busy, onSave, onDirtyChange }: {
  storageKey: string;
  draftIdentity: string;
  stage: StudioCreativeReviewSnapshot["stage"];
  draft: unknown;
  busy: boolean;
  onSave(document: Record<string, unknown>): Promise<void>;
  onDirtyChange(dirty: boolean): void;
}) {
  const [edited, setEdited] = useState<{ baseKey: string; document: Record<string, unknown> } | null>(() => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      return isRecord(stored) && typeof stored.baseKey === "string" && isRecord(stored.document)
        ? { baseKey: stored.baseKey, document: stored.document } : null;
    } catch { return null; }
  });
  const [open, setOpen] = useState(edited !== null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "failed">();
  const draftKey = JSON.stringify({ stage, draftIdentity, draft });
  const stale = edited !== null && edited.baseKey !== draftKey;
  useEffect(() => {
    onDirtyChange(edited !== null);
    // 本地文字只用于恢复编辑，不作为服务端采用版本或确认依据。
    try {
      if (edited) window.localStorage.setItem(storageKey, JSON.stringify(edited));
      else window.localStorage.removeItem(storageKey);
    } catch { /* 存储不可用时仍保留当前页内的文字。 */ }
  }, [edited, onDirtyChange, storageKey]);
  useEffect(() => {
    if (!edited) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited]);
  const fields = useMemo(() => editableTextFields(stage, edited?.document ?? draft), [stage, edited, draft]);
  if (!isRecord(draft) || fields.length === 0) return null;
  const current = edited?.document ?? draft;
  const dirty = edited !== null;
  return <details className="creative-draft-editor" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><FilePenLine aria-hidden="true" size={14} />手动修订这份稿件{dirty ? " · 有未保存修改" : ""}</summary>
    {/* 收起时不渲染字段：可读稿和编辑器里会出现相同文字，展开才挂载避免同一屏两份同文。 */}
    {open ? <>
      <p className="creative-edit-state" role="status">{stale ? "当前方案已更新。你的未保存文字仍在下方，可先复制留存；请放弃旧稿修改、重新读取当前版本后再编辑。旧稿不能覆盖新稿。" : saving ? "正在保存修订，等待服务端确认…" : saveState === "failed" ? "保存未完成，输入仍保留。请查看错误后重试。" : dirty ? "修改尚未生效；保存后仍等你确认采用，确认时重新独立复核。" : saveState === "saved" ? "修订已保存。请核对当前稿，再确认采用。" : "可直接修改文字。保存不会自动采用或购买素材；确认采用时重新独立复核。"}</p>
      {fields.map((field) => <label key={field.key} className="creative-edit-field">
        <span>{field.label}</span>
        <textarea
          value={field.value}
          disabled={busy || saving}
          onChange={(event) => { setSaveState(undefined); setEdited({ baseKey: edited?.baseKey ?? draftKey, document: field.apply(structuredClone(current), event.target.value) }); }}
        />
      </label>)}
      <div className="creative-edit-actions">
        {dirty ? <button type="button" className="button button-ghost" disabled={busy || saving} onClick={() => { setEdited(null); setSaveState(undefined); }}>放弃修改</button> : null}
        <button
          type="button"
          className="button button-primary"
          disabled={busy || saving || !dirty || stale}
          onClick={async () => {
            if (!edited || stale || saving || busy) return;
            setSaving(true);
            try { await onSave(edited.document); setEdited(null); setSaveState("saved"); }
            catch { setSaveState("failed"); }
            finally { setSaving(false); }
          }}
        ><Save aria-hidden="true" size={15} />{saving || busy ? "正在处理…" : "保存修订"}</button>
      </div>
    </> : null}
  </details>;
}

interface EditableTextField {
  key: string;
  label: string;
  value: string;
  apply(draft: Record<string, unknown>, value: string): Record<string, unknown>;
}

function editableTextFields(stage: StudioCreativeReviewSnapshot["stage"], draft: unknown): EditableTextField[] {
  if (!isRecord(draft)) return [];
  const text = (key: string, label: string, get: (draft: Record<string, unknown>) => unknown, set: (draft: Record<string, unknown>, value: string) => void): EditableTextField | null => {
    const raw = get(draft);
    if (raw === undefined || raw === null) return null;
    return { key, label, value: String(raw), apply: (next, value) => { set(next, value); return next; } };
  };
  const list = (key: string, label: string, field: string): EditableTextField | null => {
    const items = draft[field];
    if (!Array.isArray(items) || items.length === 0) return null;
    return {
      key,
      label,
      value: items.map((item) => String(item)).join("\n"),
      apply: (next, value) => { next[field] = value.split("\n").map((line) => line.trim()).filter(Boolean); return next; },
    };
  };
  if (stage === "treatment") {
    const fields: EditableTextField[] = [];
    const viewer = text("viewerPromise", "观众看完能得到什么", (d) => d.viewerPromise, (d, v) => { d.viewerPromise = v; });
    if (viewer) fields.push(viewer);
    if (isRecord(draft.hook)) {
      for (const [field, fieldLabel] of [["narrationIntent", "开头的叙述意图"], ["visualIntent", "开头的画面意图"]] as const) {
        if (draft.hook[field] === undefined || draft.hook[field] === null) continue;
        fields.push({
          key: `hook.${field}`,
          label: fieldLabel,
          value: String(draft.hook[field]),
          apply: (next, value) => { next.hook = { ...(next.hook as Record<string, unknown>), [field]: value }; return next; },
        });
      }
    }
    fields.push(...collectionTextFields(draft, "progression", "内容推进", [
      ["purpose", "这一段的作用"],
      ["viewerGain", "观众得到什么"],
    ], (item) => String(item.beatId ?? "")));
    const payoff = text("payoff", "结尾兑现", (d) => d.payoff, (d, v) => { d.payoff = v; });
    if (payoff) fields.push(payoff);
    const principles = list("visualPrinciples", "视觉方向（每行一条）", "visualPrinciples");
    if (principles) fields.push(principles);
    const sound = list("soundPrinciples", "声音方向（每行一条）", "soundPrinciples");
    if (sound) fields.push(sound);
    return fields;
  }
  if (stage === "script") {
    const fields: EditableTextField[] = [];
    const arc = text("narrativeArc", "叙事推进", (d) => d.narrativeArc, (d, v) => { d.narrativeArc = v; });
    if (arc) fields.push(arc);
    fields.push(...collectionTextFields(draft, "scenes", "分镜", [
      ["narration", "旁白"],
      ["visual_prompt", "画面描述"],
    ], (item) => String(item.id ?? item.position ?? "")));
    return fields;
  }
  // director：v1 只开放视觉规则的文字修订；逐镜计划的结构与路线仍走讨论/重新生成。
  if (!isRecord(draft.visualBible)) return [];
  const fields: EditableTextField[] = [];
  for (const [field, label] of [
    ["viewerPromise", "观众承诺"],
    ["narrativeApproach", "叙事方式"],
    ["pacing", "节奏"],
    ["composition", "构图"],
    ["camera", "镜头运动"],
    ["color", "色彩"],
    ["continuity", "连续性"],
    ["sound", "声音"],
  ] as const) {
    const item = text(`visualBible.${field}`, `全片视觉规则 · ${label}`, (d) => isRecord(d.visualBible) ? d.visualBible[field] : undefined, (d, value) => { d.visualBible = { ...(d.visualBible as Record<string, unknown>), [field]: value }; });
    if (item) fields.push(item);
  }
  return fields;
}

function collectionTextFields(
  draft: Record<string, unknown>,
  collectionField: string,
  label: string,
  itemFields: Array<[field: string, label: string]>,
  itemKey: (item: Record<string, unknown>) => string = (item) => String(item.position ?? ""),
): EditableTextField[] {
  const items = draft[collectionField];
  if (!Array.isArray(items)) return [];
  const fields: EditableTextField[] = [];
  items.forEach((item, index) => {
    if (!isRecord(item)) return;
    const keyOf = itemKey(item) || String(index + 1);
    for (const [field, fieldLabel] of itemFields) {
      if (item[field] === undefined || item[field] === null) continue;
      fields.push({
        key: `${collectionField}.${keyOf}.${field}`,
        label: `${label} ${index + 1} · ${fieldLabel}`,
        value: String(item[field]),
        apply: (next, value) => {
          const collection = [...(next[collectionField] as unknown[])];
          collection[index] = { ...(collection[index] as Record<string, unknown>), [field]: value };
          next[collectionField] = collection;
          return next;
        },
      });
    }
  });
  return fields;
}

```

## apps/studio/src/client/components/NodeWorkspace.tsx

SHA256: 8f0ea45ab46f274d05ac5a8d1ef90b2d6d5586c39084c823f70d8eee5e205311; 1353 lines. OMITTED: 121-349, 722-1353.

### Original lines 1-120

```
import { AlertTriangle, Check, ChevronDown, CircleDollarSign, Clock3, FilePenLine, Pause, Save, Settings2, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioArtifact, StudioNode, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioProductionQuote, StudioProvider, StudioRunStatus, StudioSpendAuthorizationInput, StudioSpendRejectionInput } from "../../shared/api.js";
import { selectableModelsForCapability } from "../../shared/model-compatibility.js";
import { studioApi } from "../api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { agentLoopPendingNote, agentLoopPhaseLabel, catalogModelLabel, creatorFacingTechnicalText, humanizeCreativeText, providerLabel, providerModelLabel, reasoningEffortLabel } from "../presentation.js";
import { hasCreatorDocumentContent } from "../creator-document-policy.js";
import { NodeDeliveryPreview } from "./NodeDeliveryPreview.js";
import { unsplashPublicUrl } from "./UnsplashAttribution.js";
import { hasStockAttribution, StockAttribution } from "./StockAttribution.js";
import { NodeStructuredEditor } from "./NodeStructuredEditor.js";
import { PlanningStagesPanel } from "./PlanningStagesPanel.js";
import type { StudioPlanningEditableStage, StudioPlanningStage } from "../../shared/api.js";

// 编辑器内的输入草稿类型：不含并发 token。wire DTO（含 expectedRunRevision/expectedVersionId）
// 只在保存时由保存逻辑用打开编辑器时捕获的基线构造。
type StudioNodeInputDraft = { input: unknown };

interface NodeWorkspaceProps {
  node: StudioNode;
  nodes?: StudioNode[];
  providers?: StudioProvider[];
  runStatus: StudioRunStatus;
  /** C2：制作范围授权需要 run 身份与当前方案 digest。 */
  runId: string;
  runRevision: number;
  acceptedPlanDigest: string;
  artifacts: StudioArtifact[];
  busy: boolean;
  readOnly?: boolean;
  pauseBusy?: boolean;
  pauseRequested?: boolean;
  /** joint-v1 创作规划节点的真实阶段投影；其他节点不传。 */
  planningStages?: StudioPlanningStage[];
  onPendingPlanningConfigurationChange?: (pending: boolean) => void;
  onRequestPause?: () => Promise<void>;
  onOverride: (nodeId: string, input: StudioNodeOverrideInput) => Promise<void>;
  onInputOverride?: (nodeId: string, input: StudioNodeInputOverrideInput) => Promise<void>;
  onConfigure?: (nodeId: string, input: StudioNodeExecutionConfigurationInput) => Promise<void>;
  onAuthorize: (nodeId: string, input: StudioSpendAuthorizationInput) => Promise<void>;
  onRejectSpend?: (nodeId: string, input: StudioSpendRejectionInput) => Promise<void>;
}

export function NodeWorkspace({ node, nodes = [node], providers = [], runStatus, runId, runRevision, acceptedPlanDigest, artifacts, busy, readOnly = false, pauseBusy = false, pauseRequested = false, planningStages, onPendingPlanningConfigurationChange, onRequestPause, onOverride, onInputOverride = async () => undefined, onConfigure = async () => undefined, onAuthorize, onRejectSpend = async () => undefined }: NodeWorkspaceProps) {
  const shouldOpenForAttention = node.status === "awaiting_spend_approval" || node.status === "approval_invalidated" || node.status === "failed";
  const [workspaceOpen, setWorkspaceOpen] = useState(shouldOpenForAttention);
  const [inputReviewOpen, setInputReviewOpen] = useState(shouldOpenForAttention);
  const [editing, setEditing] = useState(false);
  const [editingInput, setEditingInput] = useState(false);
  const [editingDocument, setEditingDocument] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [rejectingSpend, setRejectingSpend] = useState(false);
  const [spendRejectionReason, setSpendRejectionReason] = useState<StudioSpendRejectionInput["reason"]>("too_expensive");
  const [targetEstimatedCostCny, setTargetEstimatedCostCny] = useState("");
  const [scopeMaximumCny, setScopeMaximumCny] = useState("");
  const [scopeAuthorizing, setScopeAuthorizing] = useState(false);
  // C2：已向服务端取得、正在向用户展示的报价；授权只接受这份报价。
  const [pendingQuote, setPendingQuote] = useState<{ quote: StudioProductionQuote; preparedAtRevision: number }>();
  const [spendRejectionNote, setSpendRejectionNote] = useState("");
  const [draft, setDraft] = useState(() => pretty(node.output ?? effectiveOutput(node) ?? {}));
  const [inputDraft, setInputDraft] = useState(() => pretty(effectiveInput(node) ?? {}));
  const [editingPlanningStageId, setEditingPlanningStageId] = useState<StudioPlanningEditableStage>();
  // 输入草稿基线绑定打开编辑器时观察到的 run revision 与输入版本：保存时使用基线，
  // 后台 props 刷新不得把旧草稿的提交基准无声升级到新版本。
  const [inputEditBaseline, setInputEditBaseline] = useState<{ runRevision: number; versionId: string }>();
  const [error, setError] = useState<string>();
  const [documentPreview, setDocumentPreview] = useState<unknown>();
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string>();
  const [terminalOverride, setTerminalOverride] = useState<StudioNodeOverrideInput>();
  const [terminalInputOverride, setTerminalInputOverride] = useState<StudioNodeInputDraft>();
  const spendDialogRef = useDialogFocus<HTMLElement>(authorizing, () => {
    setError(undefined);
    setAuthorizing(false);
  }, busy);
  const spendRejectionDialogRef = useDialogFocus<HTMLElement>(rejectingSpend, () => {
    setError(undefined);
    setRejectingSpend(false);
  }, busy);
  const terminalDialogRef = useDialogFocus<HTMLElement>(terminalOverride !== undefined, () => setTerminalOverride(undefined), busy);
  const terminalInputDialogRef = useDialogFocus<HTMLElement>(terminalInputOverride !== undefined, () => setTerminalInputOverride(undefined), busy);
  const receipt = node.executionReceipt;
  const execution = receipt ?? node.plannedExecution;
  const effectiveVersion = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId);
  const effectiveInputVersion = node.inputState?.versions.find((version) => version.id === node.inputState?.effectiveVersionId);
  const editableArtifact = useMemo(
    () => selectEditableArtifact(node.id, artifacts, effectiveVersion?.artifactIds),
    [artifacts, effectiveVersion?.artifactIds, node.id],
  );
  const audioArtifact = useMemo(
    () => {
      if (node.id !== "voice") return undefined;
      const candidates = artifacts.filter((artifact) => artifact.contentUrl
        && artifact.contentType?.startsWith("audio/")
        && (artifact.producerNodeId === "voice" || artifact.kind === "voiceover"))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const effectiveIds = effectiveVersion?.artifactIds ?? [];
      return candidates.filter((artifact) => effectiveIds.includes(artifact.id)).at(-1) ?? candidates.at(-1);
    },
    [artifacts, effectiveVersion?.artifactIds, node.id],
  );
  const audioIsCurrent = Boolean(audioArtifact
    && runStatus !== "stale"
    && (effectiveVersion?.artifactIds?.length
      ? effectiveVersion.artifactIds.includes(audioArtifact.id)
      : effectiveVersion?.source !== "human"));
  const visualArtifacts = useMemo(
    () => selectMaterializedVisualArtifacts(node, artifacts, effectiveVersion?.artifactIds),
    [artifacts, effectiveVersion?.artifactIds, node],
  );
  const currentVisualArtifactIds = effectiveVersion?.artifactIds?.length ? effectiveVersion.artifactIds : node.artifactIds;
  const visualsAreCurrent = Boolean(visualArtifacts.length
    && runStatus !== "stale"
    && !node.outputState?.stale
    && visualArtifacts.every((artifact) => currentVisualArtifactIds.includes(artifact.id)));
  const spendInputs = useMemo(() => node.spendPlan?.inputVersionIds.map((versionId) => {
    const inputOwner = nodes.find((candidate) => candidate.inputState?.versions.some((version) => version.id === versionId));
    const outputOwner = nodes.find((candidate) => candidate.outputState?.versions.some((version) => version.id === versionId));
    const owner = inputOwner ?? outputOwner;
```

### Original lines 350-721

```
      const quote = await studioApi.prepareProductionQuote(runId, {
        expectedRunRevision: runRevision,
        acceptedPlanDigest: acceptedPlanDigest,
        ...(maximum !== undefined ? { requestedMaximumCny: maximum } : {}),
      });
      setPendingQuote({ quote, preparedAtRevision: runRevision });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScopeAuthorizing(false);
    }
  }

  async function acceptPendingScopeQuote() {
    if (!pendingQuote) return;
    setError(undefined);
    setScopeAuthorizing(true);
    try {
      await studioApi.authorizeProductionScope(runId, {
        expectedRunRevision: pendingQuote.preparedAtRevision,
        quoteId: pendingQuote.quote.quoteId,
        acceptedPlanDigest: pendingQuote.quote.acceptedPlanDigest,
        idempotencyKey: `scope-${runId}-${pendingQuote.quote.quoteId}`,
      });
      setPendingQuote(undefined);
      setAuthorizing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScopeAuthorizing(false);
    }
  }

  // C2：funding 三动作之"同意追加并继续"——追加额只能来自服务端保存的 funding request
  // （prepare 在已有活动授权时生成），客户端不能自报差额。
  async function acceptFundingAmendment() {
    const assessment = node.spendAssessment;
    if (!assessment || assessment.action !== "request_approval") return;
    setError(undefined);
    setScopeAuthorizing(true);
    try {
      const quote = await studioApi.prepareProductionQuote(runId, {
        expectedRunRevision: runRevision,
        acceptedPlanDigest: acceptedPlanDigest,
        requestedMaximumCny: assessment.resultingMaximumCents / 100,
      });
      if (!quote.fundingRequestId || !quote.fundingAuthorizationId) {
        throw new Error("服务端没有生成追加请求，请刷新后重新获取。");
      }
      await studioApi.amendProductionScope(runId, quote.fundingAuthorizationId, {
        expectedRunRevision: runRevision,
        fundingRequestId: quote.fundingRequestId,
        idempotencyKey: `amend-${runId}-${quote.fundingRequestId}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setScopeAuthorizing(false);
    }
  }

  async function rejectSpend() {
    if (!node.spendPlan) return;
    setError(undefined);
    const target = targetEstimatedCostCny.trim() ? Number(targetEstimatedCostCny) : undefined;
    if (target !== undefined && (!Number.isFinite(target) || target < 0 || target > 100_000)) {
      setError("下一版降本目标必须在 0 到 100000 元之间。");
      return;
    }
    if (target !== undefined && target >= node.spendPlan.estimatedCostCny) {
      setError(`下一版降本目标必须低于当前报价 ¥${node.spendPlan.estimatedCostCny.toFixed(2)}。`);
      return;
    }
    try {
      await onRejectSpend(node.id, {
        spendPlanId: node.spendPlan.id,
        reason: spendRejectionReason,
        ...(target !== undefined ? { targetEstimatedCostCny: target } : {}),
        ...(spendRejectionNote.trim() ? { note: spendRejectionNote.trim() } : {}),
      });
      setRejectingSpend(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <details
      id={`node-workspace-${node.id}`}
      className={`node-workspace is-${node.status}`}
      name="creator-workspaces"
      aria-label={`${node.label} · ${node.role ?? "制作角色"}`}
      open={workspaceOpen}
      onToggle={(event) => {
        setWorkspaceOpen(event.currentTarget.open);
        revealExpandedWorkspace(event.currentTarget);
      }}
    >
      <summary>
        <span className="node-workspace-state">{node.status === "succeeded" ? <Check aria-hidden="true" size={14} /> : <span />}</span>
        <span className="node-workspace-title"><strong>{node.label}</strong><small>{node.role ?? "制作角色"}</small></span>
        {capability ? <span className="node-workspace-provenance">{capability}</span> : <span />}
        {node.outputState?.stale ? <span className="node-stale-label"><AlertTriangle aria-hidden="true" size={14} />旧结果</span> : null}
        <ChevronDown className="node-workspace-chevron" aria-hidden="true" size={17} />
      </summary>
      <div className="node-workspace-body">
        {readOnly ? <p className="node-workspace-warning"><AlertTriangle aria-hidden="true" size={16} />旧版工作流结果只读；要继续修改，请基于这版重新制作。</p> : null}
        {node.agentLoopProgress ? <div className={`agent-loop-progress is-${node.agentLoopProgress.phase}`} role="status">
          <strong>{agentLoopPhaseLabel(node.agentLoopProgress)}</strong>
          {node.agentLoopProgress.latestAudit ? <span>上一轮 {node.agentLoopProgress.latestAudit.score} 分：{creatorFacingTechnicalText(humanizeCreativeText(node.agentLoopProgress.latestAudit.summary))}</span> : <span>{agentLoopPendingNote(node.agentLoopProgress)}</span>}
          <span>实际模型调用：创作 {node.agentLoopProgress.producerModelCallCount ?? 0} 次，审计 {node.agentLoopProgress.auditModelCallCount ?? 0} 次{(node.agentLoopProgress.structuredRepairModelCallCount ?? 0) > 0 ? `（其中结构修复 ${node.agentLoopProgress.structuredRepairModelCallCount} 次）` : ""}。查询、刷新和等待不计为新调用。</span>
        </div> : null}
        {fallbackReason ? <p className="node-workspace-warning" role="alert"><AlertTriangle aria-hidden="true" size={16} /><span><strong>{fallbackHeading}</strong>：{fallbackReason}</span></p> : null}
        {node.outputState?.stale ? <p className="node-workspace-warning" role="alert"><AlertTriangle aria-hidden="true" size={16} />这一步的结果已经过期，后续成片不会继续采用它。请检查人工版本后重新生成；仍然适用的部分会自动保留，不会全部重做。</p> : null}
        {node.executionConfiguration && !showPlanningStages ? <NodeExecutionConfigurationEditor
          node={node}
          providers={providers}
          runStatus={runStatus}
          runRevision={runRevision}
          busy={busy}
          readOnly={readOnly}
          paidRecoveryLocked={paidRecoveryLocked}
          onSave={(input) => onConfigure(node.id, input)}
        /> : null}
        {executionTiming ? <details className="node-execution-timing">
          <summary><Clock3 aria-hidden="true" size={15} /><span><strong>这一步为什么用了这些时间</strong><small>{executionTiming.summary}</small></span><ChevronDown aria-hidden="true" size={15} /></summary>
          <div>
            <p>内容先生成，再由独立模型做质量复核；复核未通过时会按意见修订。只有首选模型暂时不可用时，才会切换到替补模型。</p>
            <div className="node-evidence-row">
              {executionTiming.items.map((item) => <span key={item.label}><b>{item.label}</b>{item.value}</span>)}
            </div>
          </div>
        </details> : null}
        {canRequestPause ? <div className="node-pause-edit">
          <span>{pauseRequested ? "已请求暂停；当前任务安全结束后会停在下一步开始前。" : "想修改这一步？系统会先让当前任务安全结束，再停下来。"}</span>
          <button className="button button-ghost" type="button" disabled={pauseBusy || pauseRequested} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{pauseRequested ? "等待暂停" : "暂停后修改"}</button>
        </div> : null}

        {showPlanningStages && planningStages ? (
          <PlanningStagesPanel
            stages={planningStages}
            providers={providers}
            busy={busy}
            readOnly={readOnly || runStatus === "running"}
            {...(onPendingPlanningConfigurationChange ? { onPendingChange: onPendingPlanningConfigurationChange } : {})}
            // 节点还没有输入版本时（例如停在简报、规划尚未启动）没有可编辑的输入，
            // 给了按钮也只是点了没反应——那就先不给。
            {...(canEditInput ? { onEditStageInput: beginPlanningStageInputEdit } : {})}
            onConfigureStage={async (input) => {
              setError(undefined);
              try {
                await onConfigure(node.id, {
                  ...input,
                  expectedRunRevision: runRevision,
                  ...(terminal ? { confirmTerminalEdit: true } : {}),
                });
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : String(caught));
                throw caught;
              }
            }}
          />

        ) : null}

        {canEditInput && hasReviewableInput ? <details className="node-input-adjustment" open={inputReviewOpen} onToggle={(event) => setInputReviewOpen(event.currentTarget.open)}>
          <summary><FilePenLine aria-hidden="true" size={15} />查看和调整这个角色收到的内容</summary>
          <div className="node-input-review">
            {inputSources.length ? <section className="node-input-sources" aria-label={`${node.role ?? "制作角色"}收到的前序内容`}>
              <header><strong>来自前序步骤</strong><small>修改会在原步骤保存为新版本，并让后续旧结果失效。</small></header>
              <div>
                {inputSources.map((source) => <article key={source.node.id}>
                  <span><strong>{source.node.role ?? "制作角色"} · {source.node.label}</strong><small>{source.versionLabel}{source.node.outputState?.stale ? " · 前序内容已变化" : ""}</small></span>
                  <button className="button button-ghost" type="button" aria-label={`${source.canEdit ? "查看与修改" : "查看"} ${source.node.role ?? "制作角色"} · ${source.node.label}`} onClick={() => revealNodeWorkspace(source.node.id)}>{source.canEdit ? "查看与修改" : "查看"}</button>
                </article>)}
              </div>
            </section> : null}
            {hasEditableInput ? <section ref={inputEditorSectionRef} className="node-output-preview">
              <header><div><strong>{editingPlanningStageId ? `正在修改创作规划「${editingPlanningStageId === "treatment" ? "前期构思" : editingPlanningStageId === "script" ? "脚本" : "导演方案"}」阶段的输入` : "本步骤专用设置"}</strong><small>{inputSourceLabel(effectiveInputVersion?.source)}{node.inputState?.stale ? " · 前序内容已变化，需复核" : ""}{editingPlanningStageId ? " · 保存后从该阶段开始重新规划" : ""}</small></div>{!editingInput ? <button className="button button-ghost" type="button" onClick={() => beginInputEditing()}><FilePenLine aria-hidden="true" size={15} />编辑输入</button> : null}</header>
              {effectiveInputVersion?.source === "reconstructed" ? <p className="node-version-note">旧任务没有保存当时的原始输入；这里展示的是按当前上游内容推断出的可编辑版本。</p> : null}
              {editingInput ? <NodeStructuredEditor nodeId={`${node.id}-input`} value={safeParse(inputDraft)} assetProviderIds={assetProviderIds} assetProviders={editableAssetProviders} onChange={(value) => { setError(undefined); setInputDraft(pretty(value)); }} /> : <NodeDeliveryPreview nodeId={`${node.id}-input`} value={effectiveInput(node)} />}
              {editingInput ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={cancelInputEditing}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride()}><Save aria-hidden="true" size={15} />保存人工输入</button></footer> : null}
            </section> : null}
          </div>
        </details> : null}

        {node.spendPlan ? (
          <section className="spend-gate" aria-label={`${node.label}费用确认`}>
            <div><CircleDollarSign aria-hidden="true" size={20} /><span><strong>执行前费用确认</strong><small>预计 ¥{node.spendPlan.estimatedCostCny.toFixed(2)}，最高 ¥{node.spendPlan.maxCostCny.toFixed(2)} · 最多 {node.spendPlan.maxAttempts} 次</small>{node.spendPlan.items?.map((item) => <small key={item.id}><span>{item.label} · {providerLabel(item.providerId) ?? "画面服务"} · {providerModelLabel(providers.find((provider) => provider.id === item.providerId), item.modelId)}</span> · ¥{item.estimatedCostCny.toFixed(2)}</small>)}</span></div>
            {node.spendAuthorizationId ? <span className="spend-authorized"><ShieldCheck aria-hidden="true" size={15} />已授权</span> : readOnly ? <small>历史报价仅供查看</small> : node.spendAssessment?.action === "request_approval" ? (
              <div className="spend-gate-actions spend-funding" aria-label="费用缺口">
                <p><strong>{spendAssessmentHeadline(node.spendAssessment)}</strong></p>
                <dl className="spend-quote-summary">
                  <div><dt>已批准</dt><dd>¥{(node.spendAssessment.approvedAmountCents / 100).toFixed(2)}</dd></div>
                  <div><dt>已发生/在途</dt><dd>¥{((node.spendAssessment.settledCents + node.spendAssessment.reservedCents + node.spendAssessment.pendingUnknownCents) / 100).toFixed(2)}</dd></div>
                  <div><dt>本次方案最高需要</dt><dd>¥{(node.spendAssessment.requestedMaximumCents / 100).toFixed(2)}</dd></div>
                  {node.spendAssessment.reason === "amount" ? <div><dt>需要追加</dt><dd>¥{(node.spendAssessment.additionalCents / 100).toFixed(2)}（追加后累计 ¥{(node.spendAssessment.resultingMaximumCents / 100).toFixed(2)}）</dd></div> : null}
                </dl>
                <small>既有成果已保留；追加只覆盖当前方案所需，授权额仍是上限。也可以调整方案，或先不继续。</small>
                <div className="spend-gate-buttons">
                  {node.spendAssessment.reason === "amount" ? <button className="button button-primary" type="button" disabled={busy || scopeAuthorizing} onClick={() => void acceptFundingAmendment()}>
                    <ShieldCheck aria-hidden="true" size={16} />{scopeAuthorizing ? "正在确认…" : `同意追加 ¥${(node.spendAssessment.additionalCents / 100).toFixed(2)} 并继续`}
                  </button> : null}
                  {node.id === "assets" ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => { setError(undefined); setRejectingSpend(true); }}>调整方案</button> : null}
                  {onRequestPause ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing || pauseRequested} onClick={() => void onRequestPause()}><Pause aria-hidden="true" size={15} />{pauseRequested ? "已请求暂停" : "暂不继续"}</button> : null}
                </div>
              </div>
            ) : pendingQuote ? (
              <div className="spend-gate-actions">
                <dl className="spend-quote-summary" aria-label="服务端费用报价">
                  <div><dt>预计费用</dt><dd>¥{pendingQuote.quote.estimatedCostCny.toFixed(2)}</dd></div>
                  <div><dt>最高授权</dt><dd>¥{pendingQuote.quote.maximumCostCny.toFixed(2)}</dd></div>
                  <div><dt>制作内容</dt><dd>{pendingQuote.quote.scopeSummary.content}</dd></div>
                  {pendingQuote.quote.scopeSummary.assets.map((asset) => (
                    <div key={asset.assetKey}>
                      <dt>{asset.label}</dt>
                      <dd>¥{asset.estimatedCostCny.toFixed(2)} · 最多 {asset.maxCreateAttempts} 次 · {asset.allowedModels.map((model) => providerModelLabel(providers.find((provider) => provider.id === model.providerId), model.modelId) ?? model.modelId).join("、")}</dd>
                    </div>
                  ))}
                  {pendingQuote.quote.scopeSummary.excludedAssets?.map((asset) => (
                    <div key={asset.id}>
                      <dt>{asset.label}</dt>
                      <dd>¥0.00 · {asset.note}</dd>
                    </div>
                  ))}
                  {pendingQuote.quote.scopeSummary.excludedAssets?.length ? <div><dt>本片镜数</dt><dd>付费 {pendingQuote.quote.scopeSummary.assets.length} 个 · 免收费 {pendingQuote.quote.scopeSummary.excludedAssets.length} 个 · 合计 {pendingQuote.quote.scopeSummary.assets.length + pendingQuote.quote.scopeSummary.excludedAssets.length} 个</dd></div> : null}
                  {pendingQuote.quote.scopeSummary.uncertainty.map((note) => <div key={note}><dt>不确定项</dt><dd>{note}</dd></div>)}
                </dl>
                <small>授权后执行本次范围，范围内的有限修复共用此额度；后续方案仍需按流程确认。授权额是上限，不是必须花满的目标。</small>
                <div className="spend-gate-buttons">
                  {node.id === "assets" ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => { setError(undefined); setRejectingSpend(true); }}>这份报价不合适</button> : null}
                  <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => setPendingQuote(undefined)}>重新填写额度</button>
                  <button className="button button-primary" type="button" disabled={busy || scopeAuthorizing} onClick={() => void acceptPendingScopeQuote()}>
                    <ShieldCheck aria-hidden="true" size={16} />{scopeAuthorizing ? "正在确认…" : `确认并授权（最高 ¥${pendingQuote.quote.maximumCostCny.toFixed(2)}）`}
                  </button>
                </div>
              </div>
            ) : (
              <div className="spend-gate-actions">
                <label className="field spend-scope-maximum">
                  <span>本次最高授权额（元，可不填）</span>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder={`默认 ¥${node.spendPlan.maxCostCny.toFixed(2)}`}
                    value={scopeMaximumCny}
                    onChange={(event) => { setScopeMaximumCny(event.target.value); setPendingQuote(undefined); }}
                  />
                  <small>先获取报价，确认金额后再授权；授权额是上限，不是目标。</small>
                </label>
                {node.id === "assets" ? <button className="button button-ghost" type="button" disabled={busy || scopeAuthorizing} onClick={() => { setError(undefined); setRejectingSpend(true); }}>这份报价不合适</button> : null}
                <button className="button button-primary" type="button" disabled={busy || scopeAuthorizing || !acceptedPlanDigest} onClick={() => void prepareProductionScopeQuote()}>
                  <ShieldCheck aria-hidden="true" size={16} />{scopeAuthorizing ? "正在获取报价…" : "获取费用报价"}
                </button>
              </div>
            )}
          </section>
        ) : null}

        <section className="node-output-preview node-creator-delivery">
          <header><div><strong>{node.role ?? "制作角色"}的交付</strong><small>{deliveryEditHint(node.id, effectiveVersion?.source, hasDelivery, node.status, runStatus, pauseRequested)}</small></div>{canEdit && hasDelivery && !editing && (!editableArtifact || documentPreview !== undefined) ? <button className="button button-ghost" type="button" onClick={beginEditing}><FilePenLine aria-hidden="true" size={15} />编辑交付</button> : null}</header>
          {node.id === "assets" && visualArtifacts.length ? <div className={visualsAreCurrent ? "node-visual-preview" : "node-visual-preview is-stale"}>
            <header><strong>{visualsAreCurrent ? "实际素材画面" : "上次生成的素材画面"}</strong><small>{visualArtifacts.length} 个可预览素材{visualsAreCurrent ? "" : " · 将重新检查适用性，只重做不再适用的部分"}</small></header>
            <div>
              {visualArtifacts.map((artifact, index) => <figure key={artifact.id}>
                {artifact.contentType?.startsWith("video/")
                  ? <video aria-label={`${artifact.scenePosition ? `镜头 ${artifact.scenePosition}` : `素材 ${index + 1}`} 画面预览`} src={artifact.contentUrl} controls playsInline preload="metadata" />
                  : <img alt={`${artifact.scenePosition ? `镜头 ${artifact.scenePosition}` : `素材 ${index + 1}`} 画面预览`} src={artifact.providerId === "unsplash-stock-v1" ? unsplashPublicUrl(artifact.previewUrl, "images.unsplash.com") : artifact.contentUrl} loading="lazy" />}
                <figcaption><span>{artifact.scenePosition ? `镜头 ${artifact.scenePosition}` : `素材 ${index + 1}`}</span><small>{hasStockAttribution(artifact.providerId) ? <StockAttribution provider={artifact.providerId} creator={artifact.creator} creatorUrl={artifact.creatorUrl} licenseNote={artifact.licenseNote} /> : providerLabel(artifact.providerId) ?? "素材来源未记录"}</small></figcaption>
              </figure>)}
            </div>
          </div> : null}
          {editing ? <NodeStructuredEditor nodeId={node.id} value={safeParse(draft)} assetProviderIds={assetProviderIds} assetProviders={editableAssetProviders} onChange={(value) => { setError(undefined); setDraft(pretty(value)); }} /> : documentLoading ? <p className="node-document-state">正在读取详细内容...</p> : documentError ? <p className="node-workspace-error" role="alert">详细内容读取失败：{documentError}</p> : <NodeDeliveryPreview nodeId={node.id} value={documentPreview ?? node.output ?? effectiveOutput(node)} />}
          {audioArtifact?.contentUrl ? <div className={audioIsCurrent ? "node-audio-preview" : "node-audio-preview is-stale"}><div><strong>{audioIsCurrent ? "实际配音试听" : "上次生成的配音"}</strong>{!audioIsCurrent ? <small>当前文字已修改或上游已变化；继续生成后会更新声音。</small> : null}</div><audio aria-label={audioIsCurrent ? "实际配音试听" : "上次生成的配音试听"} src={audioArtifact.contentUrl} controls preload="metadata" /></div> : null}
          {editing ? <footer><button className="button button-ghost" type="button" disabled={busy} onClick={cancelEditing}><X aria-hidden="true" size={15} />取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride()}><Save aria-hidden="true" size={15} />保存为人工版本</button></footer> : null}
        </section>

        {error ? <p className="node-workspace-error" role="alert">{error}</p> : null}
      </div>

      {authorizing && node.spendPlan ? <div className="node-confirm-layer" role="presentation">
        <section ref={spendDialogRef} role="dialog" aria-modal="true" aria-label="确认本次费用" tabIndex={-1}>
          <CircleDollarSign aria-hidden="true" size={24} />
          <h3>确认执行 {node.label}</h3>
          {node.id === "assets" ? <p>每种生成路线先检查一镜，通过后继续制作。试片会直接用于成片，只计费一次；检查未通过就停止后续付费生成。全部素材还会在配音和剪辑前复查。</p> : null}
          <p>这次授权只对下面已经审阅的输入版本、{node.spendPlan.items?.length
            ? `报价中列出的 ${node.spendPlan.items.length} 个画面任务`
            : providerModelLabel(providers.find((provider) => provider.id === node.spendPlan?.providerId), node.spendPlan.modelId)}和本次最高授权额 ¥{node.spendPlan.maxCostCny.toFixed(2)} 有效。任何内容、模型、报价或重试次数变化都会让授权自动失效。</p>
          {node.spendPlan.items?.length ? <div className="spend-input-versions" aria-label="本次授权的画面任务">
            {node.spendPlan.items.map((item) => <div key={item.id}><span><strong>{item.label} · {providerLabel(item.providerId) ?? "画面服务"}</strong><small>{providerModelLabel(providers.find((provider) => provider.id === item.providerId), item.modelId)} · ¥{item.estimatedCostCny.toFixed(2)}</small></span></div>)}
          </div> : null}
          <div className="spend-input-versions" aria-label="本次付费所使用的上游版本">
            {spendInputs.map((input) => <div key={input.versionId}><span><strong>{input.role} · {input.label}</strong><small>{input.source === "human" ? "人工版本" : "自动版本"}</small></span></div>)}
          </div>
          <div><button className="button button-ghost" type="button" onClick={() => { setError(undefined); setAuthorizing(false); }}>返回检查</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void authorize()}>确认并执行</button></div>
        </section>
      </div> : null}
      {rejectingSpend && node.spendPlan ? <div className="node-confirm-layer" role="presentation">
        <section ref={spendRejectionDialogRef} role="dialog" aria-modal="true" aria-label="保存费用反馈" tabIndex={-1}>
          <CircleDollarSign aria-hidden="true" size={24} />
          <h3>把这份报价退回导演</h3>
          <p>这里只保存反馈，不会立即调用导演。你可以先修改方案或画面来源，再手动重新规划；新方案会重新报价并再次等待你确认。</p>
          <label className="field"><span>不接受这份报价的原因</span><select value={spendRejectionReason} onChange={(event) => setSpendRejectionReason(event.target.value as StudioSpendRejectionInput["reason"])}>
            <option value="too_expensive">总价太高，希望降低费用</option>
            <option value="provider_mix">画面来源或素材组合不合适</option>
            <option value="plan_not_approved">前面的画面方案不认可</option>
            <option value="other">其他原因</option>
          </select></label>
          <label className="field"><span>下一版优先尝试降到多少元（可选；达不到仍会给你新报价）</span><input aria-label="下一版降本目标（可选）" type="number" min={0} max={100000} step={0.01} value={targetEstimatedCostCny} onChange={(event) => { setError(undefined); setTargetEstimatedCostCny(event.target.value); }} /></label>
          <label className="field"><span>具体调整意见（可选）</span><textarea aria-label="具体调整意见（可选）" rows={3} maxLength={1000} value={spendRejectionNote} onChange={(event) => { setError(undefined); setSpendRejectionNote(event.target.value); }} /></label>
          <div><button className="button button-ghost" type="button" onClick={() => { setError(undefined); setRejectingSpend(false); }}>返回检查</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void rejectSpend()}>保存反馈</button></div>
        </section>
      </div> : null}
      {terminalOverride !== undefined ? <div className="node-confirm-layer" role="presentation">
        <section ref={terminalDialogRef} role="dialog" aria-modal="true" aria-labelledby={`terminal-edit-${node.id}`} tabIndex={-1}>
          <AlertTriangle aria-hidden="true" size={24} />
          <h3 id={`terminal-edit-${node.id}`}>创建已结束制作的人工修订版？</h3>
          <p>这不会在后台自动调用付费服务。保存后，后续结果会标为过期，只有你再次点击重新生成才会继续。</p>
          <div><button className="button button-ghost" type="button" onClick={() => setTerminalOverride(undefined)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveOverride(true, terminalOverride)}>确认创建修订版</button></div>
        </section>
      </div> : null}
      {terminalInputOverride !== undefined ? <div className="node-confirm-layer" role="presentation">
        <section ref={terminalInputDialogRef} role="dialog" aria-modal="true" aria-labelledby={`terminal-input-edit-${node.id}`} tabIndex={-1}>
          <AlertTriangle aria-hidden="true" size={24} />
          <h3 id={`terminal-input-edit-${node.id}`}>创建已结束制作的人工输入版本？</h3>
          <p>保存后，本步骤和全部后续结果会过期；系统不会自动调用任何付费服务。</p>
          <div><button className="button button-ghost" type="button" onClick={() => setTerminalInputOverride(undefined)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void saveInputOverride(true, terminalInputOverride)}>确认创建输入版本</button></div>
        </section>
      </div> : null}
    </details>
  );
}

// C1/C2：结构化评估的创作者文案——只说发生了什么、保留了什么、下一步；金额之外的
// 原因（scope/attempts/quality）加钱解决不了，不提供"只加钱继续"的入口。
function spendAssessmentHeadline(assessment: NonNullable<StudioNode["spendAssessment"]>): string {
  if (assessment.reason === "amount") {
    return "当前授权余额不够完成这份方案。";
  }
  if (assessment.reason === "attempts") {
    return "部分镜头的重试次数已达到你批准的上限，无法继续自动修复。";
  }
  if (assessment.reason === "quality") {
    return "方案效果在授权后发生了变化，需要你重新确认后才能继续。";
  }
  if (assessment.reason === "scope") {
    return "这份方案有内容不在已批准的范围里，需要你重新确认。";
  }
  return "当前费用凭证不足以继续这份方案。";
}

function revealExpandedWorkspace(workspace: HTMLDetailsElement): void {
  if (
    !workspace.open
    || typeof window === "undefined"
    || typeof window.matchMedia !== "function"
    || !window.matchMedia("(max-width: 700px)").matches
  ) return;
  window.requestAnimationFrame(() => workspace.scrollIntoView({ block: "start" }));
}

export function revealNodeWorkspace(nodeId: string): void {
  if (typeof document === "undefined") return;
  const workspace = document.getElementById(`node-workspace-${nodeId}`);
  if (!(workspace instanceof HTMLDetailsElement)) return;
  if (!workspace.open) workspace.querySelector<HTMLElement>(":scope > summary")?.click();
  if (typeof workspace.scrollIntoView === "function") workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  window.requestAnimationFrame(() => workspace.querySelector<HTMLElement>("summary")?.focus());
}

function safeParse(value: string): unknown {
```

## apps/studio/src/client/components/NewRunDialog.tsx

SHA256: b2b8bb097756eae9185782d105789329f13abe1e965af161c2511be398c3f57e; 1763 lines. OMITTED: 181-389, 451-665, 1268-1763.

### Original lines 1-180

```
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  FileText,
  Film,
  Image,
  Mic2,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultStudioDurationRange, DEFAULT_STUDIO_VOICE_DIRECTION, type StudioCreatorSettings, type StudioProductionInput, type StudioProvider, type StudioReferenceVideo, type StudioReworkDraft, type StudioReworkFinding } from "../../shared/api.js";
import { STUDIO_DIRECTOR_PROFILES, type StudioDirectorProfileId } from "../../shared/director-profiles.js";
import { selectableModelsForCapability } from "../../shared/model-compatibility.js";
import { visualSourceCompatibilityIssue } from "../../shared/visual-source-compatibility.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { VoiceStudio } from "./VoiceStudio.js";
import { studioApi } from "../api.js";
import { creatorFacingTechnicalText, providerLabel } from "../presentation.js";

interface NewRunDialogProps {
  open: boolean;
  providers: StudioProvider[];
  initialDataReady?: boolean;
  initialValues?: Partial<StudioProductionInput>;
  inheritedNodeIds?: StudioReworkDraft["inheritedNodeIds"];
  requiredAffectedScenePositions?: StudioReworkDraft["requiredAffectedScenePositions"];
  inheritedReferenceVideo?: StudioReworkDraft["inheritedReferenceVideo"];
  creatorSettings?: StudioCreatorSettings;
  settingsError?: string;
  onRetrySettings?: () => void;
  onClose: () => void;
  onSubmit: (input: StudioProductionInput) => Promise<void>;
}

type BindingKey = keyof StudioProductionInput["providers"];
type RecipeId = StudioProductionInput["economics"]["recipeId"];

interface CapabilityDefinition {
  key: BindingKey;
  capability: string;
  label: string;
  description: string;
  role: string;
  preferred: string;
  icon: LucideIcon;
  optional?: boolean;
}

interface InheritedSelectionIssue {
  id: string;
  label: string;
  value: string;
  reason: string;
  action: string;
}

type ReferenceVideoSelection = StudioReferenceVideo | (NonNullable<StudioReworkDraft["inheritedReferenceVideo"]> & {
  inheritedFromRework: true;
});

const CAPABILITIES: CapabilityDefinition[] = [
  { key: "script", capability: "script.draft", label: "脚本生成", role: "编剧", description: "结构、钩子与分镜文案", preferred: "codex-screenwriter-v1", icon: FileText },
  { key: "director", capability: "storyboard.plan", label: "导演方案", role: "导演", description: "统一全片视觉规则并逐镜决定画面", preferred: "api-visual-director-v1", icon: Clapperboard },
  { key: "assets", capability: "asset.prepare", label: "画面素材", role: "素材导演", description: "按导演方案逐镜寻找或生成画面", preferred: "ai-shot-router-v1", icon: Image },
  { key: "voice", capability: "voice.synthesize", label: "配音", role: "声音导演", description: "旁白音色与语速", preferred: "macos-say-v1", icon: Mic2 },
  { key: "render", capability: "video.render", label: "视频渲染", role: "剪辑师", description: "9:16 合成、字幕与音轨", preferred: "python-ffmpeg-v1", icon: Film },
  { key: "technicalReview", capability: "quality.review", label: "机器质检", role: "技术质检", description: "分辨率、时长与产物校验", preferred: "python-technical-review-v1", icon: ScanSearch },
  { key: "visualReview", capability: "quality.review.visual", label: "视觉审片", role: "视觉审片员", description: "构图、连续性、节奏与文字可读性（可选增强）", preferred: "deepseek-visual-review-v1", icon: ScanSearch, optional: true },
];

const RECIPES: Array<{
  id: RecipeId;
  label: string;
  description: string;
  allowMeteredProviders: boolean;
  recommended?: boolean;
}> = [
  {
    id: "free-stock",
    label: "仅免费画面",
    description: "导演只使用已启用的免费图库或你主动允许的本地编辑画面",
    allowMeteredProviders: false,
    recommended: true,
  },
  {
    id: "keyshot-ai",
    label: "允许 AI 生成画面，按实际镜头报价",
    description: "导演可建议生成关键图片或视频，每次调用前都会给出报价并等你确认",
    allowMeteredProviders: true,
  },
];

const PRODUCTION_PLATFORMS = ["douyin", "xiaohongshu", "bilibili"] as const;

function isProductionPlatform(value: string | undefined): value is typeof PRODUCTION_PLATFORMS[number] {
  return PRODUCTION_PLATFORMS.some((platform) => platform === value);
}

function canonicalRecipeId(recipeId: RecipeId | undefined): RecipeId {
  return recipeId === "keyshot-ai" || recipeId === "cinematic-ai" ? "keyshot-ai" : "free-stock";
}

export function NewRunDialog({ open, providers, initialDataReady = true, initialValues, inheritedNodeIds, requiredAffectedScenePositions, inheritedReferenceVideo, creatorSettings, settingsError, onRetrySettings, onClose, onSubmit }: NewRunDialogProps) {
  const defaults = useMemo(
    () => providerDefaults(providers, creatorSettings?.roleProviderDefaults),
    [creatorSettings?.roleProviderDefaults, providers],
  );
  const [bindings, setBindings] = useState<StudioProductionInput["providers"]>(defaults);
  const effectiveBindings = useMemo(
    () => initialValues?.rework ? bindings : availableProviderBindings(bindings, defaults, providers),
    [bindings, defaults, initialValues?.rework, providers],
  );
  const [activeKey, setActiveKey] = useState<BindingKey>("assets");
  const [recipeId, setRecipeId] = useState<RecipeId>("free-stock");
  const [directorProfileId, setDirectorProfileId] = useState<StudioDirectorProfileId>("auto");
  const [platform, setPlatform] = useState("douyin");
  const [durationSeconds, setDurationSeconds] = useState(24);
  const [durationRange, setDurationRange] = useState<StudioProductionInput["durationRange"]>(() => (
    initialValues?.durationRange ?? defaultStudioDurationRange(initialValues?.durationSeconds ?? 24)
  ));
  const [durationRangeDrafts, setDurationRangeDrafts] = useState<Partial<Record<"minSeconds" | "maxSeconds", string>>>({});
  const durationRangeTouched = useRef(false);
  const visualIntentTouched = useRef(false);
  const [assetProviderIds, setAssetProviderIds] = useState<string[]>([]);
  const [modelSelections, setModelSelections] = useState<Record<string, string>>({});
  const [voiceDirection, setVoiceDirection] = useState<StudioProductionInput["voiceDirection"]>(() => defaultVoiceDirection(providers));
  const [budgetIntention, setBudgetIntention] = useState(String(initialValues?.budgetIntentionCny ?? ""));
  const [semanticRankEnabled, setSemanticRankEnabled] = useState(true);
  const [acceptUnreviewedFirstCut, setAcceptUnreviewedFirstCut] = useState(false);
  const [referenceVideo, setReferenceVideo] = useState<ReferenceVideoSelection>();
  const releasedReferenceId = useRef<string | undefined>(undefined);
  const formScrollRef = useRef<HTMLDivElement>(null);
  const assetSourcePoolRef = useRef<HTMLElement>(null);
  const scrollToAssetSourcesOnOpen = useRef(false);
  const initialScrollResetPending = useRef(false);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [referenceError, setReferenceError] = useState<string>();
  const [briefSummaryValues, setBriefSummaryValues] = useState(() => ({
    title: initialValues?.title ?? "",
    angle: initialValues?.angle ?? "",
    audience: initialValues?.audience ?? "",
  }));
  const [visualBriefValues, setVisualBriefValues] = useState(() => ({
    visualProof: initialValues?.visualProof ?? "",
    strategy: initialValues?.visualIntent ?? "",
  }));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [inheritedSettingsOpen, setInheritedSettingsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [voiceSelectionAvailable, setVoiceSelectionAvailable] = useState<boolean>();
  const [rework, setRework] = useState<StudioProductionInput["rework"]>(() => creatorFacingRework(
    initialValues?.rework,
    requiredAffectedScenePositions,
  ));
  const initializedForOpen = useRef(false);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, submitting);
  const activeCapability = CAPABILITIES.find((item) => item.key === activeKey) ?? CAPABILITIES[1]!;
  const groupedReworkFindings = useMemo(() => groupReworkFindingsByScene(rework?.findings), [rework?.findings]);
  const reworkScope = useMemo(() => summarizeReworkScope(rework), [rework]);
  const requiredReworkScenePositions = useMemo(() => requiredScenePositionsForRework(
    initialValues?.rework,
    requiredAffectedScenePositions,
  ), [initialValues?.rework, requiredAffectedScenePositions]);
  const reworkTargetStepLabels = useMemo(() => reworkFindingTargetStepLabels(groupedReworkFindings), [groupedReworkFindings]);
  const editorial = initialValues?.editorial;
  const imageStory = editorial?.verdict === "produce_image_story";
  const activeProviders = providers.filter((provider) => {
    if (provider.capability !== activeCapability.capability || provider.kind === "test") return false;
    return activeKey !== "assets" || provider.id === "ai-shot-router-v1";
  });
  const assetSources = providers.filter((provider) => {
```

### Original lines 390-450

```
    });
    visualIntentTouched.current = false;
    setReferenceUploading(false);
    setReferenceError(undefined);
    setActiveKey("assets");
    setAdvancedOpen(false);
    scrollToAssetSourcesOnOpen.current = false;
    setInheritedSettingsOpen(false);
    setError(undefined);
    setVoiceSelectionAvailable(undefined);
    setRework(creatorFacingRework(initialValues?.rework, requiredAffectedScenePositions));
  }, [creatorSettings, defaults, imageStory, inheritedReferenceVideo, initialDataReady, initialValues, open, providers, requiredAffectedScenePositions]);

  useLayoutEffect(() => {
    if (!open || !initialScrollResetPending.current || !initializedForOpen.current) return;
    if (formScrollRef.current) formScrollRef.current.scrollTop = 0;
    initialScrollResetPending.current = false;
  }, [open, initialDataReady]);

  useEffect(() => {
    if (!open || !advancedOpen || !inheritedSettingsOpen || !scrollToAssetSourcesOnOpen.current) return;
    scrollToAssetSourcesOnOpen.current = false;
    const sourcePool = assetSourcePoolRef.current;
    if (typeof sourcePool?.scrollIntoView === "function") sourcePool.scrollIntoView({ block: "nearest" });
  }, [advancedOpen, inheritedSettingsOpen, open]);

  useEffect(() => {
    if (!open || !referenceVideo || !isUploadedReferenceVideo(referenceVideo)) return;
    const uploadId = referenceVideo.uploadId;
    return () => {
      if (releasedReferenceId.current !== uploadId) void studioApi.deleteReferenceVideo(uploadId).catch(() => undefined);
    };
  }, [open, referenceVideo]);

  if (!open) return null;

  if (!initialDataReady && !initializedForOpen.current) {
    // 设置读取失败与仍在加载是两种不同状态：失败时允许打开查看原因并原地重读，但表单不初始化、不能提交。
    const settingsFailed = Boolean(settingsError);
    return (
      <div className="dialog-backdrop" role="presentation">
        <section ref={dialogRef} className="run-dialog recipe-dialog" role="dialog" aria-modal="true" aria-labelledby="new-run-loading-title" aria-busy={settingsFailed ? undefined : "true"} tabIndex={-1}>
          <header className="dialog-header recipe-dialog-header">
            <div>
              <p className="eyebrow">制作方案</p>
              <h2 id="new-run-loading-title">{settingsFailed ? "创作设置读取失败" : "正在准备新制作"}</h2>
            </div>
            <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭新建制作">
              <X aria-hidden="true" size={19} />
            </button>
          </header>
          {settingsFailed ? (
            <div className="page-error" role="alert">
              <AlertCircle aria-hidden="true" size={18} />
              <span>未能读取你的创作设置，为避免用错声音/平台/时长，暂未开工。{settingsError}</span>
              {onRetrySettings ? <button className="button button-secondary" type="button" onClick={onRetrySettings}><RefreshCw aria-hidden="true" size={16} />重新读取</button> : null}
            </div>
          ) : <div className="page-loading">正在读取制作配置...</div>}
        </section>
      </div>
    );
```

### Original lines 666-1267

```
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section ref={dialogRef} className="run-dialog recipe-dialog" role="dialog" aria-modal="true" aria-labelledby="new-run-title" tabIndex={-1}>
        <header className="dialog-header recipe-dialog-header">
          <div>
            <p className="eyebrow">制作方案</p>
            <h2 id="new-run-title">{rework ? "调整方案后重新制作" : "新建制作"}</h2>
            <p>{rework ? "已载入上一版可用设置；真实母片复用与最终方案仍需重新规划验证。下面的修改要求会真正交给对应制作步骤执行。" : "先生成前期构思，再与你讨论定稿。脚本与分镜也会分别等你确认；付费图片和视频另行报价。"}</p>
          </div>
          <div className="dialog-budget" aria-label="费用方式">
            <span>{meteredSelected ? "图片 / 视频按实际方案报价" : "图片 / 视频无现金报价"}</span>
            <strong>{meteredSelected ? "逐项人工确认" : "无需现金确认"}</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭新建制作">
            <X aria-hidden="true" size={19} />
          </button>
        </header>

        <form className="run-form recipe-form" onSubmit={(event) => event.preventDefault()} key={initialValues?.title ?? "blank-production"}>
          <div ref={formScrollRef} className="recipe-form-scroll" style={{ overflowAnchor: "none" }}>
            {rework ? <section className="rework-brief-section" aria-labelledby="rework-scope-title" tabIndex={-1} data-dialog-initial-focus>
              <div className="compact-section-heading">
                <div><span>返工</span><h3 id="rework-scope-title">本轮变更范围</h3></div>
                <small>先确认重做镜头，再填写怎么改</small>
              </div>
              {reworkScope?.fullScenePositions ? <>
                <p className="rework-scope-guidance" id="rework-scope-guidance">勾选决定哪些镜头进入本轮画面重新规划与生成，并直接影响图片 / 视频报价。审片或失败记录明确要求的镜头标为必改，不能移除；下方文字只说明怎么改，不代替这里的镜头选择。</p>
                <fieldset className="rework-scene-scope" aria-describedby="rework-scope-guidance">
                  <legend className="sr-only">本轮要重新规划 / 生成的镜头</legend>
                  <strong>本轮要重新规划 / 生成的镜头</strong>
                  <div>{reworkScope.fullScenePositions.map((position) => {
                    const required = requiredReworkScenePositions.includes(position);
                    return (
                      <label className={required ? "is-required" : undefined} key={position}>
                        <input
                          type="checkbox"
                          aria-label={`第 ${position} 镜`}
                          checked={reworkScope.adjustedScenePositions.includes(position)}
                          disabled={required}
                          onChange={() => setRework((current) => toggleReworkScene(current, position))}
                        />
                        <span>第 {position} 镜</span>
                        {required ? <small aria-hidden="true">必改</small> : null}
                      </label>
                    );
                  })}</div>
                </fieldset>
                <div className="rework-finding-list" aria-label="本轮变更范围摘要">
                  <div className="rework-rejection-note"><strong>{reworkScope.adjustedScenePositions.length > 0
                    ? `本轮选择 ${reworkScope.adjustedScenePositions.length} 个镜头：${reworkScope.adjustedScenePositions.join("、")}`
                    : "本轮未选择需要重新规划 / 生成的镜头"}</strong></div>
                  {reworkScope.plannedReuseScenePositions.length > 0 ? <div className="rework-rejection-note"><strong>其余 {reworkScope.plannedReuseScenePositions.length} 个镜头计划沿用：{reworkScope.plannedReuseScenePositions.join("、")}</strong></div> : null}
                  <p className="rework-boundary-note">是否能直接复用上一版母片，以重新规划后的画面方案和真实报价为准。</p>
                </div>
              </> : <div className="rework-finding-list" aria-label="本轮变更范围摘要">
                <div className="rework-rejection-note"><strong>全片需复核；具体重做范围以重新规划后的方案为准。</strong></div>
                <p className="rework-boundary-note">上一版没有可验证的完整镜头全集，因此这里不会猜测镜头编号。重新规划确认范围后，再对实际需要生成的图片 / 视频报价。</p>
              </div>}
            </section> : null}
            {inheritedSelectionIssues.length > 0 ? <section className="rework-selection-alert" role="alert" aria-live="assertive" aria-labelledby="rework-selection-alert-title">
              <div>
                <AlertCircle aria-hidden="true" size={18} />
                <div><strong id="rework-selection-alert-title">上一版有 {inheritedSelectionIssues.length} 项已失效，暂不能开工</strong><span>系统保留了上一版原值，没有替你静默更换。请逐项明确选择替代方案。</span></div>
              </div>
              <ul>{inheritedSelectionIssues.map((issue) => <li key={issue.id}>
                <strong>{issue.label}：{issue.value}</strong>
                <span>{issue.reason}；{issue.action}</span>
              </li>)}</ul>
              {inheritedSelectionIssues.some((issue) => issue.id.startsWith("source-")) ? <button className="button button-ghost" type="button" onClick={() => {
                const sourceIds = sourceIdsForRecipe(selectedRecipe, providers);
                setAssetProviderIds(imageStory
                  ? includeLocalEditorialSource(sourceIds, providers)
                  : sourceIds);
                openAssetSourceControls();
              }}>用当前策略的可用来源替换</button> : null}
            </section> : null}
            {rework ? <section className="rework-brief-section" aria-labelledby="rework-brief-title">
              <div className="compact-section-heading">
                <div><span>返工</span><h3 id="rework-brief-title">按反馈修改</h3></div>
                <small>已预填到对应制作步骤，可在开工前调整</small>
              </div>
              {rework.rejectionReason ? <div className="rework-rejection-note"><strong>本次重做原因</strong><span>{creatorFacingTechnicalText(rework.rejectionReason)}</span></div> : null}
              {groupedReworkFindings.sceneGroups.length > 0 || groupedReworkFindings.wholeFilmFindings.length > 0 ? <div className="rework-finding-list" aria-label="需要处理的问题">
                {groupedReworkFindings.sceneGroups.map((group) => <article className="rework-finding" key={`scene-${group.scenePosition}`}>
                  <header><strong>第 {group.scenePosition} 镜</strong><span>{group.findings.length} 个问题</span></header>
                  {group.findings.map((sceneFinding) => <div className="rework-finding-item" key={sceneFinding.findingId}>
                    <p>{reworkFindingCategoryLabel(sceneFinding.category)} · {reworkFindingStageLabel(sceneFinding) ? `${reworkFindingStageLabel(sceneFinding)} · ` : ""}{formatTimecode(sceneFinding.timecodeMs)}</p>
                    <p>{creatorFacingTechnicalText(sceneFinding.description)}</p>
                    <small>建议：{creatorFacingTechnicalText(sceneFinding.suggestion)}</small>
                  </div>)}
                </article>)}
                {groupedReworkFindings.wholeFilmFindings.length > 0 ? <article className="rework-finding" key="rework-whole-film">
                  <header><strong>全片问题</strong><span>{groupedReworkFindings.wholeFilmFindings.length} 个问题</span></header>
                  {groupedReworkFindings.wholeFilmFindings.map((sceneFinding) => <div className="rework-finding-item" key={sceneFinding.findingId}>
                    <p>{reworkFindingCategoryLabel(sceneFinding.category)} · {reworkFindingStageLabel(sceneFinding) ? `${reworkFindingStageLabel(sceneFinding)} · ` : ""}{formatTimecode(sceneFinding.timecodeMs)}</p>
                    <p>{creatorFacingTechnicalText(sceneFinding.description)}</p>
                    <small>建议：{creatorFacingTechnicalText(sceneFinding.suggestion)}</small>
                  </div>)}
                </article> : null}
              </div> : null}
              {reworkTargetStepLabels.length > 0 ? <p className="rework-boundary-note">审片反馈将预填到：{reworkTargetStepLabels.join("、")}。</p> : null}
              {!advancedOpen ? <button className="button button-ghost" type="button" onClick={openAssetSourceControls}>调整来源</button> : null}
              <div className="rework-instruction-grid">
                <label className="field">
                  <span>脚本修改要求</span>
                  <textarea value={creatorFacingTechnicalText(rework.nodeInstructions.script)} placeholder="留空表示沿用上一版脚本，不重跑编剧" onChange={(event) => setRework((current) => current ? { ...current, nodeInstructions: { ...current.nodeInstructions, script: event.target.value } } : current)} />
                </label>
                <label className="field">
                  <span>导演方案修改要求</span>
                  <textarea required value={creatorFacingTechnicalText(rework.nodeInstructions.visualDirection)} onChange={(event) => setRework((current) => current ? { ...current, nodeInstructions: { ...current.nodeInstructions, visualDirection: event.target.value } } : current)} />
                </label>
                <label className="field">
                  <span>画面素材修改要求</span>
                  <textarea required value={creatorFacingTechnicalText(rework.nodeInstructions.assets)} onChange={(event) => setRework((current) => current ? { ...current, nodeInstructions: { ...current.nodeInstructions, assets: event.target.value } } : current)} />
                </label>
              </div>
              <p className="rework-boundary-note">{reworkBaselineSummary(rework)}</p>
              <ul className="rework-boundary-note">
                <li>{rework.previousScript
                  ? rework.nodeInstructions.script.trim()
                    ? "脚本：以上一版脚本为修改基线，并按审片反馈调整。"
                    : "脚本：沿用上一版脚本，本轮不重跑编剧。"
                  : "脚本：上一版脚本未产出，本轮需要重新生成脚本。"}</li>
                <li>{rework.previousDirectorPlan ? "导演：以上一版导演方案为修改基线，按反馈复核所列镜头。" : "导演：上一版导演方案未产出，本轮需要重新规划画面方案。"}</li>
                <li>声音：声音设置已预填；脚本文字变化时，配音可能重新生成。</li>
                <li>报价：下一轮会对实际需要重新生成的图片和视频逐项报价；最终项目和金额以费用确认页为准。</li>
              </ul>
              {inheritedNodeIds && inheritedNodeIds.length > 0 ? <p className="rework-boundary-note">已带入上一版基线资料：{inheritedNodeIds.filter((nodeId) => nodeId !== "template").map((nodeId) => REWORK_BASELINE_NODE_LABELS[nodeId] ?? nodeId).join("、")}；这些资料用于对照和预填，不代表声音成品或素材母片已经复用，也不代表免费。</p> : null}
            </section> : null}
            {rework ? <div className={inheritedSettingsOpen ? "advanced-production is-open" : "advanced-production"}>
              <button className="advanced-production-toggle" type="button" aria-expanded={inheritedSettingsOpen} onClick={() => setInheritedSettingsOpen((current) => !current)}>
                <span>查看继承设置</span><small>上一版预填与本轮可调整设置</small><ChevronDown aria-hidden="true" size={17} />
              </button>
            </div> : null}
            <details className="inherited-production-summary">
              <summary><span>继承制作设置</span><small>优先使用免费路线；收费画面仍需逐项报价确认</small></summary>
              <p>角色、模型、声音和画面来源会继承创作设置与本次入口内容。开始后可在对应节点工作区单独调整，不会改动全局默认。</p>
            </details>

            <div hidden={Boolean(rework) && !inheritedSettingsOpen}>
            <section className="brief-section" aria-labelledby="brief-section-title">
              <div className="compact-section-heading">
                <div><span>01</span><h3 id="brief-section-title">内容简报</h3></div>
                <small>所有字段都可在生产前调整</small>
              </div>
              <div className="brief-fields">
                <label className="field field-wide">
                  <span>视频标题</span>
                  <input name="title" required data-dialog-initial-focus={rework ? undefined : true} defaultValue={initialValues?.title ?? ""} placeholder="一句能让人停下来的具体承诺" onChange={(event) => {
                    const title = event.target.value;
                    setBriefSummaryValues((current) => ({ ...current, title }));
                  }} />
                </label>
                <label className="field field-wide">
                  <span>内容角度</span>
                  <input name="angle" required defaultValue={initialValues?.angle ?? ""} placeholder="这条视频用什么独特角度讲清问题" onChange={(event) => {
                    const angle = event.target.value;
                    setBriefSummaryValues((current) => ({ ...current, angle }));
                  }} />
                </label>
                <label className="field">
                  <span>目标受众</span>
                  <input name="audience" required defaultValue={initialValues?.audience ?? ""} placeholder="这条视频最想帮助谁" onChange={(event) => setBriefSummaryValues((current) => ({ ...current, audience: event.target.value }))} />
                </label>
                <label className="field field-compact">
                  <span>目标平台</span>
                  <select name="platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>
                    {!platform ? <option value="" disabled>请选择目标平台</option> : null}
                    <option value="douyin">抖音</option>
                    <option value="xiaohongshu">小红书</option>
                    <option value="bilibili">哔哩哔哩</option>
                  </select>
                </label>
                <label className="field field-compact">
                  <span>建议时长</span>
                  <select name="durationSeconds" value={String(durationSeconds)} onChange={(event) => changeSuggestedDuration(Number(event.target.value))}>
                    {![20, 24, 30, 36, 40, 42, 45, 60].includes(durationSeconds) ? <option value={durationSeconds}>{durationSeconds} 秒</option> : null}
                    {[20, 24, 30, 36, 40, 42, 45, 60]
                      .map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
                  </select>
                </label>
                {durationRange ? <details className="brief-extra-options duration-range-options">
                  <summary>时长范围 <span>{durationRange.minSeconds}–{durationRange.maxSeconds} 秒</span></summary>
                  <div className="brief-extra-fields">
                  <label className="field field-compact">
                    <span>最短时长</span>
                    <input type="number" min={20} max={durationRange.maxSeconds} step={1}
                      value={durationRangeDrafts.minSeconds ?? durationRange.minSeconds}
                      onChange={(event) => setDurationRangeDrafts((current) => ({ ...current, minSeconds: event.target.value }))}
                      onBlur={() => commitDurationDraft("minSeconds")} />
                  </label>
                  <label className="field field-compact">
                    <span>最长时长</span>
                    <input type="number" min={durationRange.minSeconds} max={180} step={1}
                      value={durationRangeDrafts.maxSeconds ?? durationRange.maxSeconds}
                      onChange={(event) => setDurationRangeDrafts((current) => ({ ...current, maxSeconds: event.target.value }))}
                      onBlur={() => commitDurationDraft("maxSeconds")} />
                  </label>
                  </div>
                </details> : null}
                <details className="brief-extra-options visual-intent-options">
                  <summary>画面要求与证据（可选）<span>{visualBriefValues.visualProof.trim() || visualBriefValues.strategy.trim() ? "已填写，展开查看" : "留空，由创作角色提案"}</span></summary>
                  <div className="brief-extra-fields">
                <label className="field field-wide">
                  <span>必须让观众看到的证据（可选）</span>
                  <textarea
                    rows={3}
                    value={visualBriefValues.visualProof}
                    placeholder="例如：同一个操作修改前后的真实结果并列出现，观众可以直接核对差异"
                    onChange={(event) => setVisualBriefValues((current) => ({ ...current, visualProof: event.target.value }))}
                  />
                </label>
                <label className="field field-wide">
                  <span>视觉论证方式（可选）</span>
                  <textarea
                    aria-label="视觉论证方式（可选）"
                    rows={3}
                    value={visualBriefValues.strategy}
                    placeholder="例如：用同一主体贯穿全片，先展示问题，再用过程和结果兑现开头承诺"
                    onChange={(event) => {
                      visualIntentTouched.current = true;
                      setVisualBriefValues((current) => ({ ...current, strategy: event.target.value }));
                    }}
                  />
                  {initialValues?.visualPlan && !visualBriefValues.strategy.trim() ? (
                    <small>可参考的方向：{initialValues.visualPlan.strategy}。只有你填写或明确采用后，才会成为制作要求。</small>
                  ) : null}
                </label>
                  </div>
                </details>
              </div>
              {Object.values(briefSummaryValues).some((value) => value.trim()) || visualBriefValues.visualProof.trim() || visualBriefValues.strategy.trim() ? <CreativeSummary summary={creativeSummary} /> : null}
              {imageStory ? (
                <div className="editorial-brief-note" role="note">
                  <strong>总编建议 · 图文成片</strong>
                  <span>{editorial?.reasons[0]}</span>
                  <small>{editorial?.guardrails[0]}</small>
                </div>
              ) : null}
            </section>
            </div>

            <section className="director-casting-section" aria-labelledby="director-casting-title">
              <div className="compact-section-heading">
                <div><span>02</span><h3 id="director-casting-title">导演角色</h3></div>
                <small>角色定创作立场，AI 仍逐镜做决定</small>
              </div>
              <div className="director-casting-control">
                <label className="field">
                  <span>导演角色</span>
                  <select value={directorProfileId} onChange={(event) => setDirectorProfileId(event.target.value as StudioDirectorProfileId)}>
                    {STUDIO_DIRECTOR_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                  </select>
                </label>
                {(() => {
                  const profile = STUDIO_DIRECTOR_PROFILES.find((item) => item.id === directorProfileId) ?? STUDIO_DIRECTOR_PROFILES[0]!;
                  return <div className="director-profile-note"><strong>{profile.inspiration}</strong><span>{profile.summary}</span><small>擅长：{profile.bestFor}</small></div>;
                })()}
              </div>
            </section>

            <section className="reference-style-section" aria-labelledby="reference-style-title">
              <div className="compact-section-heading">
                <div><span>02B</span><h3 id="reference-style-title">参考视频风格</h3></div>
                <small>可选，不复制参考内容</small>
              </div>
              <div className={referenceVideo ? "reference-video-control has-file" : "reference-video-control"}>
                <label className={referenceGrammarProvider ? "reference-video-picker" : "reference-video-picker is-disabled"}>
                  <input
                    aria-label="参考视频"
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm"
                    disabled={!referenceGrammarProvider || referenceUploading}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      void uploadReferenceVideo(file);
                    }}
                  />
                  <Upload aria-hidden="true" size={19} />
                  <span><strong>{referenceUploading ? "正在安全上传..." : referenceVideo ? referenceVideo.label : "选择 MP4、MOV 或 WebM"}</strong><small>{referenceVideo ? `${formatBytes(referenceVideo.sizeBytes)} · ${isUploadedReferenceVideo(referenceVideo) ? "上传完成" : "沿用上一版参考视频"}` : "不超过 30 MB；未开工上传最多保留 7 天"}</small></span>
                </label>
                {referenceVideo ? <button className="icon-button reference-video-remove" type="button" title={isUploadedReferenceVideo(referenceVideo) ? "删除参考视频" : "不再沿用参考视频"} aria-label={isUploadedReferenceVideo(referenceVideo) ? "删除参考视频" : "不再沿用参考视频"} disabled={referenceUploading} onClick={() => void removeReferenceVideo()}><X aria-hidden="true" size={17} /></button> : null}
              </div>
              <p className="reference-style-note"><Film aria-hidden="true" size={16} /><span><strong>{referenceGrammarProvider ? creatorProviderName(referenceGrammarProvider) : "参考视频分析当前不可用"}</strong>只提炼节奏、构图、运镜、色彩、转场和声音结构；开工后原片作为私密运行输入留档，不进入发布包，分析结果可预览和编辑。</span></p>
              {referenceError ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />{referenceError}</p> : null}
            </section>

            <section className="recipe-section" aria-labelledby="recipe-section-title" data-tour="production-recipes">
              <div className="compact-section-heading">
                <div><span>03</span><h3 id="recipe-section-title">画面来源策略</h3></div>
                <small>决定导演可用能力，不设全片费用上限</small>
              </div>
              <fieldset className="recipe-options">
                <legend className="sr-only">制作配方</legend>
                {RECIPES.map((recipe) => {
                  const lockedByEditorial = imageStory && recipe.allowMeteredProviders;
                  const available = !lockedByEditorial && recipeAvailable(recipe, providers);
                  return (
                  <label key={recipe.id} className={available ? "recipe-option" : "recipe-option is-disabled"}>
                    <input type="radio" name="recipe" value={recipe.id} checked={recipeId === recipe.id} disabled={!available} onChange={() => applyRecipe(recipe.id)} />
                    <span className="recipe-option-body">
                      <span className="recipe-name">{recipe.recommended ? <Check aria-hidden="true" size={14} /> : <Sparkles aria-hidden="true" size={14} />}<strong>{recipe.label}</strong></span>
                      <small>{lockedByEditorial
                        ? `${recipe.description} · 图解类选题只使用来源画面和本地编辑画面`
                        : available ? recipe.description : `${recipe.description} · 需要先配置对应能力`}</small>
                    </span>
                  </label>
                  );
                })}
              </fieldset>
              <label className="field budget-intention-field">
                <span>本片预算意向（元，可不填）</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="不填则不设预期"
                  value={budgetIntention}
                  onChange={(event) => setBudgetIntention(event.target.value)}
                  aria-label="本片预算意向"
                />
                <small>只影响导演的方案取舍参考，不是付款授权；实际花费仍会在确认方案时逐次报价并等你确认。</small>
              </label>
            </section>

            <div hidden={Boolean(rework) && !inheritedSettingsOpen}>
            <div className={advancedOpen ? "advanced-production is-open" : "advanced-production"}>
              <button className="advanced-production-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
                <span>更多：素材来源与制作细节</span><small>通常在后续节点工作区调整</small><ChevronDown aria-hidden="true" size={17} />
              </button>
              {advancedOpen ? <>
              <section className="production-team-section" aria-labelledby="production-team-title">
                <div className="compact-section-heading">
                  <div><span>04</span><h3 id="production-team-title">自动制作设置</h3></div>
                  <small>这里的覆盖只影响本次制作</small>
                </div>
                <p className="production-settings-guidance">默认使用创作设置中的模型与能力。开工后可以在对应节点的工作区调整；只有需要在开工前覆盖时，才在这里修改。</p>
                <div className="production-role-grid">
                  {providers.find((provider) => provider.id === "sound-review-v1" && provider.available) ? <label className="field"><span>声音审片本次模型</span><select
                    aria-label="声音审片本次模型" value={modelSelections["sound-review-v1"] ?? ""}
                    onChange={(event) => setModelSelections((current) => withModelSelection(current, "sound-review-v1", event.target.value))}>
                    <option value="">继承角色默认</option>
                    {providers.find((provider) => provider.id === "sound-review-v1")?.modelProfiles?.filter((model) => model.available).map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
                  </select><small>将直接审听成片音轨；费用按你的模型服务账号计算。</small></label> : null}
                  {CAPABILITIES.map((item) => {
                    const candidates = roleProviderCandidates(item, providers);
                    const requestedProviderId = effectiveBindings[item.key];
                    const selected = providers.find((provider) => provider.id === requestedProviderId);
                    const Icon = item.icon;
                    const models = selectableModelsForCapability(selected?.modelProfiles, item.capability);
                    const selectedModelId = selected ? modelSelections[selected.id] : undefined;
                    const inheritedProviderUnavailable = Boolean(requestedProviderId && !candidates.some((provider) => provider.id === requestedProviderId));
                    const inheritedModelUnavailable = Boolean(selectedModelId && !models.some((model) => model.id === selectedModelId));
                    return <article className={selected?.available ? "production-role" : "production-role is-unavailable"} key={item.key}>
                      <header>
                        <span className="production-role-icon"><Icon aria-hidden="true" size={17} /></span>
                        <span><strong>{item.role}</strong><small>{item.label}</small></span>
                        <em>{roleExecutionLabel(item, selected)}</em>
                      </header>
                      <label className="field production-role-provider">
                        <span>{item.role}能力</span>
                        <select
                          aria-label={`${item.role}能力`}
                          value={requestedProviderId ?? ""}
                          disabled={item.key === "voice" || (candidates.length < 2 && !inheritedProviderUnavailable)}
                          onChange={(event) => {
                            const provider = providers.find((candidate) => candidate.id === event.target.value);
                            if (!provider) return;
                            setBindings((current) => ({ ...current, [item.key]: provider.id }));
                          }}
                        >
                          {!requestedProviderId ? <option value="">未配置</option> : null}
                          {inheritedProviderUnavailable ? <option value={requestedProviderId} disabled>上一版：{selected ? creatorProviderName(selected) : requestedProviderId}（不可用）</option> : null}
                          {candidates.map((provider) => <option value={provider.id} key={provider.id}>{creatorProviderName(provider)}</option>)}
                        </select>
                      </label>
                      {models.length > 0 && selected ? <label className="field production-role-model">
                        <span>{item.role}本次模型</span>
                        <select
                          aria-label={`${item.role}本次模型`}
                          value={selectedModelId ?? ""}
                          onChange={(event) => setModelSelections((current) => withModelSelection(current, selected.id, event.target.value))}
                        >
                          <option value="">继承推荐：{effectiveModelId(selected) ?? "由系统按当前配置选择"}</option>
                          {inheritedModelUnavailable && selectedModelId ? <option value={selectedModelId} disabled>上一版：{selectedModelId}（不可用）</option> : null}
                          {models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
                        </select>
                        {(item.key === "script" || item.key === "director" || item.key === "visualReview") && models.length > 1
                          ? <small>你选的是首选；只有确认请求未被受理时，兼容候选才会接管。若请求可能已受理但结果不确定，流程会暂停核对，不会切换模型。</small>
                          : null}
                      </label> : <p>{item.key === "voice" ? "音色与语速在下方声音导演中调整。" : selected?.description ?? item.description}</p>}
                      {item.key === "assets" ? <div className="production-role-source-models">
                        <strong>本次画面来源与模型</strong>
                        {selectedAssetSources.map((provider) => {
                          const models = selectableModelsForCapability(provider.modelProfiles, provider.capability);
                          const selectedModelId = modelSelections[provider.id];
                          const inheritedModelUnavailable = Boolean(selectedModelId && !models.some((model) => model.id === selectedModelId));
                          return <label className="field" key={provider.id}>
                          <span>{creatorProviderName(provider)}</span>
                          {models.length ? <select aria-label={`${creatorProviderName(provider)}开工模型`} value={selectedModelId ?? ""} onChange={(event) => setModelSelections((current) => withModelSelection(current, provider.id, event.target.value))}>
                            <option value="">使用推荐：{effectiveModelId(provider) ?? "自动选择"}</option>
                            {inheritedModelUnavailable && selectedModelId ? <option value={selectedModelId} disabled>上一版：{selectedModelId}（不可用）</option> : null}
                            {models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
                          </select> : <small>{providerBillingLabel(provider)}</small>}
                        </label>;})}
                        <button className="button button-ghost" type="button" onClick={toggleAssetSourceControls}>{advancedOpen ? "收起来源" : "调整来源"}</button>
                      </div> : null}
                      <small className="production-role-billing">{selected
                        ? item.key === "assets"
                          ? meteredSelected
                            ? "画面方案本身不收费 · 按实际生成需求报价 · 生成前逐笔人工确认"
                            : "画面方案本身不收费 · 当前方案不调用付费生成"
                          : `${providerBillingLabel(selected)} · ${effectiveModelId(selected) ?? "不使用模型"}`
                        : "尚未选择制作方式"}</small>
                    </article>;
                  })}
                </div>
                <div className={roleAuditProvider ? "production-auditor" : "production-auditor is-unavailable"}>
                  <span><ScanSearch aria-hidden="true" size={18} /></span>
                  <div><strong>{roleAuditProvider ? creatorProviderName(roleAuditProvider) : "独立质量复核未接通"}</strong><small>由独立 AI 逐步检查输入、交付格式和后续使用是否一致。</small></div>
                  <em>{roleAuditProvider ? `${effectiveModelId(roleAuditProvider) ?? "实际使用模型"} · 深入质量复核 · 最多三轮` : "开工前请先恢复独立质量复核能力"}</em>
                </div>
              </section>
              <section className="workflow-config" aria-labelledby="workflow-config-title">
              <div className="workflow-stage-panel">
                <div className="compact-section-heading workflow-heading">
                  <div><span>A</span><h3 id="workflow-config-title">制作步骤</h3></div>
                  <small>点击步骤更换能力</small>
                </div>
                <div className="workflow-stage-list">
                  {CAPABILITIES.map((item, index) => {
                    const selected = providers.find((provider) => provider.id === effectiveBindings[item.key]);
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.key}
                        className={activeKey === item.key ? "workflow-stage is-active" : "workflow-stage"}
                        type="button"
                        onClick={() => setActiveKey(item.key)}
                        aria-pressed={activeKey === item.key}
                      >
                        <span className="stage-index">{String(index + 1).padStart(2, "0")}</span>
                        <Icon aria-hidden="true" size={17} />
                        <span><strong>{item.label}<em>{item.role}</em></strong><small>{selected ? creatorProviderName(selected) : "未配置"}</small></span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="provider-browser">
                <header className="provider-browser-header">
                  <div><p>{activeCapability.label}</p><h3>{activeCapability.description}</h3></div>
                  <span>{activeProviders.filter((provider) => provider.available).length} 项可用</span>
                </header>
                <div className="provider-choice-list">
                  {activeProviders.map((provider) => {
                    const selected = effectiveBindings[activeKey] === provider.id;
                    return (
                      <label key={provider.id} className={selected ? "provider-choice is-selected" : "provider-choice"}>
                        <input
                          type="radio"
                          name={`provider-${activeKey}`}
                          value={provider.id}
                          checked={selected}
                          disabled={!provider.available}
                          onChange={() => selectProvider(provider)}
                        />
                        <span className="provider-choice-main">
                          <span className="provider-choice-title">
                            <strong>{creatorProviderName(provider)}</strong>
                            <span className={provider.billing === "metered" ? "cost-tag is-metered" : "cost-tag"}>
                              {providerBillingLabel(provider)}
                            </span>
                          </span>
                          <span>{creatorFacingTechnicalText(provider.description) ?? "由系统按当前配置使用"}</span>
                          <span className="provider-mode-list">{(provider.modes ?? []).map((mode) => <small key={mode}>{creatorFacingTechnicalText(mode)}</small>)}</span>
                        </span>
                        <span className="provider-choice-status">
                          {provider.available ? <Check aria-hidden="true" size={15} /> : <AlertCircle aria-hidden="true" size={15} />}
                          {provider.available ? "可用" : provider.status === "planned" ? "待接入" : "待配置"}
                        </span>
                        {!provider.available && provider.requirement ? <small className="provider-requirement">{creatorFacingTechnicalText(provider.requirement)}</small> : null}
                      </label>
                    );
                  })}
                </div>
              </div>
              </section>
              <section ref={assetSourcePoolRef} className="asset-source-pool" aria-labelledby="asset-source-pool-title">
                <div className="compact-section-heading">
                  <div><span>B</span><h3 id="asset-source-pool-title">导演可用素材池</h3></div>
                  <small>{assetProviderIds.length} 项已启用，最终组合由 AI 生成</small>
                </div>
                <div className="asset-source-options">
                  {assetSources.map((provider) => {
                    const checked = assetProviderIds.includes(provider.id);
                    const disabled = !provider.available
                      || (provider.billing === "metered" && !selectedRecipe.allowMeteredProviders)
                      || (provider.id === "local-editorial-v1" && imageStory);
                    return <label key={provider.id} className={checked ? "asset-source-option is-selected" : "asset-source-option"}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleAssetProvider(provider)}
                      />
                      <span><strong>{creatorProviderName(provider)}</strong><small>{creatorFacingTechnicalText(provider.description) ?? "由系统按当前配置使用"}</small></span>
                      <em>{providerBillingLabel(provider)}</em>
                    </label>;
                  })}
                </div>
                {selectedAssetSources.some((provider) => selectableModelsForCapability(provider.modelProfiles, provider.capability).length) ? <div className="asset-model-overrides" aria-label="本次生成模型">
                  <div><strong>本次模型</strong><small>只覆盖这条制作，创作设置不会被修改</small></div>
                  {selectedAssetSources.filter((provider) => selectableModelsForCapability(provider.modelProfiles, provider.capability).length).map((provider) => {
                    const selectedModel = provider.modelProfiles?.find((model) => model.id === effectiveModelId(provider));
                    return <label className="field" key={provider.id}>
                      <span>{creatorProviderName(provider)}</span>
                      <select aria-label={`${creatorProviderName(provider)} 本次模型`} value={modelSelections[provider.id] ?? ""} onChange={(event) => setModelSelections((current) => {
                        const next = { ...current };
                        if (event.target.value) next[provider.id] = event.target.value;
                        else delete next[provider.id];
                        return next;
                      })}>
                        <option value="">使用推荐：{effectiveModelId(provider) ?? "自动选择"}</option>
                        {selectableModelsForCapability(provider.modelProfiles, provider.capability).map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
                      </select>
                      <small>{selectedModel?.description}{selectedModel?.estimatedCnyPerClip !== undefined ? ` · 当前模型参考单价约 ¥${formatMoney(selectedModel.estimatedCnyPerClip)}/镜头，实际以逐项报价为准` : ""}</small>
                    </label>;
                  })}
                </div> : null}
              </section>
              </> : null}
            </div>

            <VoiceStudio
              sectionLabel="05"
              value={voiceDirection}
              preserveUnavailableSelection={Boolean(initialValues?.rework)}
              onSelectionAvailabilityChange={setVoiceSelectionAvailable}
              onChange={(next, providerId) => {
                setVoiceDirection(next);
                setBindings((current) => ({ ...current, voice: providerId }));
              }}
            />
            </div>

            <section className="production-guardrails" aria-label="开工前检查">
              <label className={effectiveSemanticRank ? "visual-review-control is-enabled" : "visual-review-control"}>
                <input type="checkbox" checked={effectiveSemanticRank} disabled={!semanticRankCompatible} onChange={(event) => setSemanticRankEnabled(event.target.checked)} />
                <span><Sparkles aria-hidden="true" size={17} /><strong>AI 候选画面排序</strong></span>
                <small>{semanticRankCompatible ? "先预览图库候选并给出逐镜排序；失败时保留素材源原顺序，下载前仍可人工调整" : "需要先启用 AI 视觉导演与逐镜画面选择"}</small>
              </label>
              {visualReviewUnavailable ? <label className="visual-review-control is-optional-risk">
                <input
                  type="checkbox"
                  checked={acceptUnreviewedFirstCut}
                  onChange={(event) => setAcceptUnreviewedFirstCut(event.target.checked)}
                />
                <span><ScanSearch aria-hidden="true" size={17} /><strong>先生成首版，稍后审片</strong></span>
                <small>视觉审片当前不可用。勾选后仍可生成和播放首版，但不会显示正式审片通过或发布包已通过。</small>
              </label> : <label className="visual-review-control is-enabled">
                <input type="checkbox" checked readOnly disabled />
                <span><ScanSearch aria-hidden="true" size={17} /><strong>视觉审片 · DeepSeek</strong></span>
                <small>{`${creatorProviderName(visualReviewProvider!)} 负责中途预检；最终成片由视觉审片模型对同一组抽帧独立审查，不上传音轨`}</small>
              </label>}
              <div className="segmented-control review-control" aria-label="终审模式"><span>人工终审</span><small>发布前必须由你完整审片并批准</small></div>
              <div className="budget-control">
                <span><strong>费用确认方式</strong></span>
                <small>{[
                  meteredSelected ? "图片和视频按实际方案逐项报价，人工确认后才执行" : "图片和视频不会产生现金报价",
                  automaticVoiceProvider ? "配音自动计入已记录费用，不弹现金报价；失败会停在配音步骤" : "",
                  subscriptionVisualReview ? "视觉审片使用订阅额度，不产生现金报价；质量问题会停在审片步骤" : "",
                ].filter(Boolean).join("；")}</small>
              </div>
            </section>

            {missingProductionRoles.length > 0 ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />缺少正式生产能力：{missingProductionRoles.join("、")}。请先在创作设置中完成配置。<a className="button button-ghost" href={capabilitySettingsHref}>打开创作设置</a></p> : null}
            {visualSourceIssue ? <p className="form-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{visualSourceIssue.message}</p> : null}
            {error ? <p className="form-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          </div>

          <footer className="dialog-actions recipe-dialog-actions">
            <div><strong>{selectedRecipe.label}</strong><span>下一步：生成前期构思并等你确认。{visualReviewUnavailable ? "当前已选择先生成首版，审片结果稍后补齐。" : meteredSelected ? "图片 / 视频另行报价授权。" : roleAuditProvider?.billing === "subscription" ? "订阅能力不产生现金报价。" : "图片 / 视频无现金报价。"}</span></div>
            <button className="button button-ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="button" onClick={(event) => {
              if (event.currentTarget.form?.reportValidity()) void submit(event.currentTarget.form);
            }} disabled={submitting || referenceUploading || productionBlocked || (visualReviewUnavailable && !acceptUnreviewedFirstCut)} data-tour="production-start">
              <Check aria-hidden="true" size={17} />
              {submitting ? "正在创建..." : "开始制作"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

```

## apps/studio/src/client/pages/ResourcesPage.tsx

SHA256: 406b9762cc26132a3ef2e7cc114c6d084c87676d40df8698573c6030daceab4e; 1051 lines. OMITTED: 1-112, 216-299, 549-753, 866-1051.

### Original lines 113-215

```
export function ResourcesPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // 初始分区跟随 URL hash：刷新或从“查看缺失能力”等入口直达时，直接落在正确分区。
  const [activeSection, setActiveSection] = useState<ResourceSectionId>(() => resourceSectionFromHash(location.hash));
  // 从导演台“查看缺失能力”进入时（?missing=capability 列表），高亮真正缺失的制作角色。
  const missingCapabilities = useMemo(
    () => new Set((searchParams.get("missing") ?? "").split(",").map((value) => value.trim()).filter(Boolean)),
    [searchParams],
  );
  const arrivalSectionRef = useRef<ResourceSectionId>(activeSection);
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [trendSources, setTrendSources] = useState<StudioTrendSource[]>([]);
  const [services, setServices] = useState<StudioTrendService[]>([]);
  const [signals, setSignals] = useState<StudioTrendSignal[]>([]);
  const [capabilities, setCapabilities] = useState<StudioLocalCapability[]>([]);
  const [publishTargets, setPublishTargets] = useState<StudioPublishTarget[]>([]);
  const [resourceManifest, setResourceManifest] = useState<StudioResourceManifest>();
  const [providerLoading, setProviderLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [providerError, setProviderError] = useState<string>();
  const [manifestLimit, setManifestLimit] = useState(8);
  const [manifestRecordLimit, setManifestRecordLimit] = useState(8);
  const [trendError, setTrendError] = useState<string>();
  const [serviceError, setServiceError] = useState<string>();
  const [publishError, setPublishError] = useState<string>();
  const [manifestError, setManifestError] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const [settings, setSettings] = useState<StudioCreatorSettings>();
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<SettingsNotice>();
  const [voiceDirection, setVoiceDirection] = useState<StudioVoiceDirection>({
    profileId: "macos:Tingting",
    rate: 185,
    pauseScale: 1,
    masteringPreset: "natural",
  });
  const [defaultRecipeId, setDefaultRecipeId] = useState<StudioProductionRecipeId>("free-stock");
  const [roleProviderDefaults, setRoleProviderDefaults] = useState<StudioRoleProviderDefaults>({});
  const [modelDefaults, setModelDefaults] = useState<Record<string, string>>({});
  const [productionDefaults, setProductionDefaults] = useState<StudioProductionDefaults>(DEFAULT_STUDIO_PRODUCTION_DEFAULTS);
  const [topicStrategy, setTopicStrategy] = useState<StudioTopicStrategy>(DEFAULT_STUDIO_TOPIC_STRATEGY);

  useEffect(() => {
    const syncSection = () => setActiveSection(resourceSectionFromHash(window.location.hash));
    window.addEventListener("hashchange", syncSection);
    return () => window.removeEventListener("hashchange", syncSection);
  }, []);

  useEffect(() => {
    const sectionId = resourceSectionFromHash(location.hash);
    setActiveSection(sectionId);
    if (!location.hash) return;
    const section = document.getElementById(sectionId);
    section?.setAttribute("tabindex", "-1");
    section?.focus({ preventScroll: true });
  }, [location.hash]);

  // 携带 hash 直达时把键盘焦点落到该分区，而不是停留在页面顶部。
  useEffect(() => {
    if (arrivalSectionRef.current === "creation-defaults") return;
    const section = document.getElementById(arrivalSectionRef.current);
    section?.setAttribute("tabindex", "-1");
    section?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (settingsNotice?.kind !== "success") return;
    const timer = window.setTimeout(() => {
      setSettingsNotice((current) => current === settingsNotice ? undefined : current);
    }, 4_000);
    return () => window.clearTimeout(timer);
  }, [settingsNotice]);

  function showSection(sectionId: ResourceSectionId) {
    setSettingsNotice((current) => current?.kind === "success" ? undefined : current);
    setActiveSection(sectionId);
    window.history.replaceState(null, "", `#${sectionId}`);
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }

  const load = useCallback(async () => {
    setProviderLoading(true);
    setTrendLoading(true);
    setProviderError(undefined);
    setTrendError(undefined);
    setServiceError(undefined);
    setPublishError(undefined);
    setManifestError(undefined);
    setSettingsError(undefined);
    const providerRequest = studioApi.providers()
      .then((values) => setProviders(values))
      .catch((error) => setProviderError(errorMessage(error)))
      .finally(() => setProviderLoading(false));
    const signalRequest = studioApi.trendSignals(undefined, 16)
      .then((values) => setSignals(values))
      .catch(() => setSignals([]))
      .finally(() => setTrendLoading(false));
    const trendRequest = studioApi.trendSources()
      .then((values) => setTrendSources(values))
      .catch((error) => setTrendError(errorMessage(error)));
```

### Original lines 300-548

```
    topicStrategy.positioning?.trim()
    && topicStrategy.targetAudience?.trim()
    && topicStrategy.preferredDirections?.trim()
    && topicStrategy.excludedDirections?.trim(),
  );
  const readyFoundation = foundationProviders.filter(isProductionReady).length;
  const usablePublishTargets = publishTargets.filter((target) => target.status === "ready" || target.status === "manual_only").length;
  const rightsManifestItems = useMemo(() => resourceManifest?.items.filter(isRightsManifestItem) ?? [], [resourceManifest]);
  const needsReviewItems = useMemo(() => resourceManifest?.needsReviewItems
    ?? rightsManifestItems.filter((item) => item.reviewStatus === "needs_review" && item.reviewDecision?.action !== "rejected"),
  [resourceManifest?.needsReviewItems, rightsManifestItems]);
  const reviewableManifestItems = useMemo(() => [
    ...needsReviewItems,
    ...rightsManifestItems.filter((item) => item.reviewDecision?.action === "rejected"),
  ], [needsReviewItems, rightsManifestItems]);
  const productionRecordItems = useMemo(() => resourceManifest?.items.filter((item) => (
    item.category === "document" || item.category === "other"
  )) ?? [], [resourceManifest]);
  const reviewableManifestRuns = useMemo(() => groupManifestItems(reviewableManifestItems), [reviewableManifestItems]);
  const productionRecordRuns = useMemo(() => groupManifestItems(productionRecordItems), [productionRecordItems]);
  const reviewableNeedsReviewCount = resourceManifest?.needsReviewCount ?? needsReviewItems.length;

  return (
    <main className="page resources-page" data-active-section={activeSection}>
      <header className="page-header resources-header">
        <div>
          <p className="eyebrow">创作控制室</p>
          <h1>创作设置</h1>
          <p className="page-summary">为下一条视频确定默认创作方式，并检查热点、模型、声音、画面和发布出口是否真正可用。</p>
        </div>
        <button
          aria-label="刷新能力状态"
          className="icon-button"
          type="button"
          onClick={() => void load()}
          title="刷新能力状态"
        >
          <RefreshCw aria-hidden="true" size={17} />
        </button>
      </header>

      <section className="resource-masthead" aria-label="能力概览" data-tour="resource-overview">
        <div><span>热点服务</span><strong>{serviceError ? "—" : `${readyServices}/${services.length}`}</strong></div>
        <div><span>画面来源</span><strong>{providerError ? "—" : readyVisual}</strong></div>
        <div><span>制作能力</span><strong>{providerError ? "—" : `${readyFoundation}/${foundationProviders.length}`}</strong></div>
        <div className="resource-budget"><UploadCloud aria-hidden="true" size={17} /><span>发布出口</span><strong>{publishError ? "—" : usablePublishTargets}</strong></div>
      </section>

      <nav className="configuration-index" aria-label="配置分区">
        <a href="#creation-defaults" aria-current={activeSection === "creation-defaults" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("creation-defaults"); }}><SlidersHorizontal aria-hidden="true" size={15} />创作默认</a>
        <a href="#model-settings" aria-current={activeSection === "model-settings" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("model-settings"); }}><Settings2 aria-hidden="true" size={15} />模型设置</a>
        <a href="#topic-strategy" aria-current={activeSection === "topic-strategy" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("topic-strategy"); }}><Sparkles aria-hidden="true" size={15} />选题策略</a>
        <a href="#trend-connections" aria-current={activeSection === "trend-connections" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("trend-connections"); }}><RadioTower aria-hidden="true" size={15} />热点信号</a>
        <a href="#voice-casting" aria-current={activeSection === "voice-casting" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("voice-casting"); }}><Sparkles aria-hidden="true" size={15} />声音演员</a>
        <a href="#visual-providers" aria-current={activeSection === "visual-providers" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("visual-providers"); }}><Film aria-hidden="true" size={15} />画面来源</a>
        <a href="#production-roles" aria-current={activeSection === "production-roles" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("production-roles"); }}><Clapperboard aria-hidden="true" size={15} />制作分工</a>
        <a href="#resource-manifest" aria-current={activeSection === "resource-manifest" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("resource-manifest"); }}><ListChecks aria-hidden="true" size={15} />来源与授权</a>
        <a href="#publish-channels" aria-current={activeSection === "publish-channels" ? "page" : undefined} onClick={(event) => { event.preventDefault(); showSection("publish-channels"); }}><UploadCloud aria-hidden="true" size={15} />发布渠道</a>
      </nav>

      <section id="creation-defaults" className="resource-section configuration-defaults" data-resource-section data-active={activeSection === "creation-defaults" ? "true" : undefined} data-tour="configuration-defaults">
        <ResourceHeading eyebrow="创作基线" title="新建制作默认值" meta="保存后自动带入下一条视频，创建时仍可单独调整" />
        {settingsError ? <ResourceError title="创作默认值读取失败" message={settingsError} retry={load} /> : !settings ? <div className="region-loading">正在读取创作默认值...</div> : <div className="configuration-sheet">
          <div className="configuration-intro">
            <Settings2 aria-hidden="true" size={22} />
            <div><strong>先定创作习惯，再开始生产</strong><p>默认使用人工终审和仅免费画面；启用付费关键镜头后，图片、视频会按实际导演方案逐项报价并等待人工确认。</p><small>{productionEnvironmentSummary(capabilities)}</small></div>
          </div>
          <div className="configuration-fields">
            <label className="field"><span>画面来源策略</span><select aria-label="默认画面来源策略" value={defaultRecipeId} onChange={(event) => setDefaultRecipeId(event.target.value as StudioProductionRecipeId)}>{RECIPE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label className="field"><span>导演角色</span><select aria-label="默认导演角色" value={productionDefaults.directorProfileId} onChange={(event) => setProductionDefaults((current) => ({ ...current, directorProfileId: event.target.value as StudioProductionDefaults["directorProfileId"] }))}>
              <option value="auto">自动选导演</option><option value="documentary-observer">纪实观察</option><option value="quiet-humanism">静观生活</option><option value="urban-poetic">都市诗意</option><option value="chromatic-storytelling">色彩叙事</option><option value="geometric-control">几何秩序</option><option value="suspense-staging">悬念调度</option>
            </select></label>
            <label className="field"><span>目标平台</span><select aria-label="默认目标平台" value={productionDefaults.platform} onChange={(event) => setProductionDefaults((current) => ({ ...current, platform: event.target.value as StudioProductionDefaults["platform"] }))}><option value="douyin">抖音</option><option value="xiaohongshu">小红书</option><option value="bilibili">哔哩哔哩</option></select></label>
            <label className="field"><span>默认时长</span><select aria-label="默认视频时长" value={String(productionDefaults.durationSeconds)} onChange={(event) => setProductionDefaults((current) => ({ ...current, durationSeconds: Number(event.target.value) as StudioProductionDefaults["durationSeconds"] }))}><option value="20">20 秒</option><option value="24">24 秒</option><option value="30">30 秒</option><option value="45">45 秒</option></select></label>
          </div>
          <div className="segmented-control configuration-review-mode" aria-label="终审方式"><span>人工终审</span><small>发布前不可跳过的安全检查</small></div>
          <div className="configuration-save-row"><span>{productionHasChanges ? "有未保存的创作默认值" : "当前默认值已保存"}</span><button className="button button-primary" type="button" disabled={settingsSaving || !productionHasChanges} onClick={() => void saveDefaults({ defaultRecipeId, productionDefaults }, "创作默认值已保存，将从下一条新制作生效。")}><Save aria-hidden="true" size={16} />{productionHasChanges ? "保存创作默认" : "已保存"}</button></div>
        </div>}
      </section>
      {settingsNotice ? <p className={`resource-settings-notice is-${settingsNotice.kind}`} role={settingsNotice.kind === "error" ? "alert" : "status"}>{settingsNotice.message}</p> : null}

      <section id="model-settings" className="resource-section model-settings" data-resource-section data-active={activeSection === "model-settings" ? "true" : undefined}>
        <ResourceHeading eyebrow="全局接入" title="模型设置" meta="模型本身只配置一次；角色默认在制作分工中设置" />
        <ModelLibrary providers={providers} onChanged={load} />
      </section>

      <section id="topic-strategy" className="resource-section topic-strategy-config" data-resource-section data-active={activeSection === "topic-strategy" ? "true" : undefined} data-tour="topic-strategy">
        <ResourceHeading eyebrow="总编规则" title="什么题值得做" meta="系统综合判断下列准入条件；你只需维护账号定位、内容边界和来源标准，不需要调整评分权重" />
        <div className="topic-rubric" aria-label="视频选题准入标准">
          {[['明确观众收益', '必需', '说清谁会看，以及看完能解决什么具体问题'], ['前两秒钩子', '必需', '开场立即给出具体承诺或值得停留的理由'], ['画面不可替代', '必需', '有可见行动、对比或现场，而不只是把文字换成口播'], ['创作增量', '必需', '提供通稿之外的新解释、验证或选择依据'], ['可追溯来源', '必需', '事实能回到有效原始链接，并满足下方来源标准'], ['成本与价值匹配', '综合', '预计画面成本要与观看价值和制作必要性相称'], ['风险与形式匹配', '综合', '公共或高风险事件优先证据表达，不用生成画面虚构现场']].map(([label, gate, detail]) => <article key={label}><span>{gate}</span><strong>{label}</strong><small>{detail}</small></article>)}
        </div>
        <div className="topic-instruction-editor">
          <div className="topic-strategy-fields">
            <label className="field"><span>账号内容定位</span><input required aria-label="账号内容定位" maxLength={500} value={topicStrategy.positioning ?? ""} onChange={(event) => setTopicStrategy((current) => ({ ...current, positioning: event.target.value }))} /><small>必填。一句话说明这个账号长期替观众解决什么问题。</small></label>
            <label className="field"><span>核心观众</span><input required aria-label="核心观众" maxLength={500} value={topicStrategy.targetAudience ?? ""} onChange={(event) => setTopicStrategy((current) => ({ ...current, targetAudience: event.target.value }))} /><small>必填。写真实处境和认知需求，不写“所有人”。</small></label>
            <label className="field"><span>优先寻找</span><textarea required aria-label="优先题材" rows={5} maxLength={1000} value={topicStrategy.preferredDirections ?? ""} onChange={(event) => setTopicStrategy((current) => ({ ...current, preferredDirections: event.target.value }))} /><small>必填。每行一个方向；它决定总编主动寻找什么。</small></label>
            <label className="field"><span>明确避开</span><textarea required aria-label="避开题材" rows={5} maxLength={1000} value={topicStrategy.excludedDirections ?? ""} onChange={(event) => setTopicStrategy((current) => ({ ...current, excludedDirections: event.target.value }))} /><small>必填。每行一个红线；不适合做成视频的热点应直接放弃。</small></label>
            <label className="field"><span>进入推荐前的来源标准</span><select aria-label="候选来源标准" value={topicStrategy.sourcePolicy ?? DEFAULT_STUDIO_TOPIC_STRATEGY.sourcePolicy} onChange={(event) => setTopicStrategy((current) => ({ ...current, sourcePolicy: event.target.value as NonNullable<StudioTopicStrategy["sourcePolicy"]> }))}><option value="primary_or_two_independent">不少于两个不同域名的有效链接</option><option value="traceable_source">至少一个格式有效的原始链接</option></select><small>系统会校验链接格式、来源域名和非搜索结果页；高风险事实仍会要求人工打开核验。</small></label>
            <label className="field"><span>其他具体原则</span><textarea aria-label="其他选题原则" rows={3} maxLength={2000} value={topicStrategy.customInstruction} onChange={(event) => setTopicStrategy((current) => ({ ...current, customInstruction: event.target.value }))} placeholder="例如：优先能在 30 秒内通过实验或前后对比兑现承诺的题材" /><small>只补充上面没有覆盖的具体判断，不要重复系统底线。</small></label>
          </div>
          <div className="configuration-save-row"><span>{!topicStrategyComplete ? "请先补全四项必填规则" : topicHasChanges ? "有未保存的总编规则" : "总编规则已保存"}</span><button className="button button-primary" type="button" disabled={settingsSaving || !topicHasChanges || !topicStrategyComplete} onClick={() => void saveDefaults({ topicStrategy: normalizeTopicStrategy(topicStrategy) }, "总编规则已保存，下一次刷新候选时生效。") }><Save aria-hidden="true" size={16} />{topicHasChanges ? "保存总编规则" : "已保存"}</button></div>
        </div>
      </section>

      <section id="trend-connections" className="resource-section signal-desk" data-resource-section data-active={activeSection === "trend-connections" ? "true" : undefined} data-tour="resource-trends">
        <ResourceHeading eyebrow="信号台" title="热点接入" meta="最近一次采集 · 来源可追溯" />
        {trendError ? <ResourceError title="热点源状态未知" message={trendError} retry={load} /> : null}
        {serviceError ? <ResourceError title="热点服务状态未知" message={serviceError} retry={load} /> : null}
        {!trendError ? (
          <div className="signal-desk-layout">
            <div className="service-ledger" aria-label="热点服务">
              {trendLoading ? <div className="region-loading">正在读取热点...</div> : services.map((service) => {
                const serviceUrl = browserServiceUrl(service.baseUrl);
                return <article key={service.id} className="service-row">
                  <span className={`service-light is-${service.status}`} />
                  <div><strong>{service.label}</strong><small>{serviceKind(service.kind)}</small></div>
                  <span>{service.itemCount === undefined ? SERVICE_STATUS[service.status] : `${service.itemCount} 条`}</span>
                  {serviceUrl
                    ? <a href={serviceUrl} target="_blank" rel="noreferrer" title={`打开 ${service.label}`}><ArrowUpRight aria-hidden="true" size={15} /></a>
                    : <span aria-label={service.status === "stopped" ? `${service.label} 未配置地址` : `${service.label} 内部服务已连接`} />}
                </article>;
              })}
              {trendSources.filter((source) => source.status !== "ready").slice(0, 3).map((source) => (
                <article key={source.id} className="service-row is-muted">
                  <span className="service-light is-degraded" />
                  <div><strong>{source.label}</strong><small>{trendSourceStatusText(source)}</small></div>
                  <span>{source.status === "needs_config" ? "尚未接入" : "人工"}</span>
                </article>
              ))}
            </div>
            <ol className="live-signal-list" aria-label="已采集热点信号">
              {signals.length > 0 ? signals.slice(0, 12).map((signal, index) => (
                <li key={signal.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{signal.title}</strong><small>{platformLabel(signal.platform)} · {sourceLabel(signal.sourceId)} · 原榜第 {signal.rank}</small></div>
                  {signal.heat ? <output>{compactNumber(signal.heat)}</output> : null}
                  {signal.url ? <a href={signal.url} target="_blank" rel="noreferrer" title="查看原始热点"><ArrowUpRight aria-hidden="true" size={14} /></a> : null}
                </li>
              )) : <li className="signal-empty"><RadioTower aria-hidden="true" size={18} /><span>等待第一批热点信号</span></li>}
            </ol>
          </div>
        ) : null}
      </section>

      <div id="voice-casting" className="resource-voice-studio" data-resource-section data-active={activeSection === "voice-casting" ? "true" : undefined} data-tour="resource-voice">
        <VoiceStudio title="声音演员表" sectionLabel="声音" value={voiceDirection} onChange={(next) => setVoiceDirection(next)} />
        <div className="resource-default-action">
          <div><strong>当前制作默认</strong><span>{voiceHasChanges ? "有未保存的声音调整" : "已保存"}</span></div>
          <button className="button button-secondary" type="button" disabled={settingsSaving || !voiceHasChanges} onClick={() => void saveDefaults({ voiceDirection }, "声音已设为新建制作的默认值。") }><Save aria-hidden="true" size={16} />{voiceHasChanges ? "设为制作默认" : "已是制作默认"}</button>
        </div>
      </div>

      <section id="visual-providers" className="resource-section visual-library" data-resource-section data-active={activeSection === "visual-providers" ? "true" : undefined} data-tour="resource-visual">
        <ResourceHeading eyebrow="画面资源" title="图库与画面生成" meta={`${readyVisual} 项已配置 · 图库搜索与 AI 生成分开展示`} />
        <p className="resource-note">免费图库可以减少生成费用，但仍须核对素材内容和授权。密钥在本机配置，不会显示在网页中；新来源配置后需重新启动本地服务。</p>
        {providerLoading ? <div className="region-loading">正在读取画面能力...</div> : providerError ? (
          <ResourceError title="画面能力状态未知" message={providerError} retry={load} />
        ) : <>
          <div className="visual-capability-groups">{visualProviderGroups.map((group) => <section key={group.id} className="visual-capability-group" aria-labelledby={`visual-capability-${group.id}`}>
            <header><div><strong id={`visual-capability-${group.id}`}>{group.label}</strong><small>{group.description}</small></div><span>{group.providers.filter(isProductionReady).length}/{group.providers.length} 可用</span></header>
            <div className="provider-ledger">{group.providers.map((provider) => <ProviderRow
              key={provider.id}
              provider={provider}
            />)}</div>
          </section>)}</div>
          <details className="stock-source-research">
            <summary>国内与付费图库（尚未接入）</summary>
            <p>以下已完成初步官方调研，尚不能在制作中自动选用。商务开通、合同价格和下载授权确定后，才能接入采购；普通网站会员不等于接口权限。</p>
            <ul>
              <li><a href="https://699pic.com/vip/api" target="_blank" rel="noreferrer">摄图网 OpenAPI</a>：图片、视频；公开接口文档完整，优先考虑。需合作方账号、授权主体和合同价格。</li>
              <li><a href="https://open.hellorf.com/" target="_blank" rel="noreferrer">站酷海洛开放平台</a>：图片、视频；提供测试与正式应用、购买记录及授权书接口。需商务申请。</li>
              <li><a href="https://ibaotu.com/" target="_blank" rel="noreferrer">包图网</a>：国内图片、实拍视频采购备选；自动接入权限尚未核实，不抓取网站下载。</li>
              <li><a href="https://developer.adobe.com/stock/docs/getting-started/" target="_blank" rel="noreferrer">Adobe Stock</a>：企业 API 候选，普通个人订阅不等于 API 权限。</li>
            </ul>
            <p>个人非商业用途也可使用相应许可的素材；不会仅因“禁止商用”排除。另需核对剪辑、公开发布和署名要求；带水印预览不能当作正式素材。</p>
          </details>
        </>}
      </section>

      <section id="production-roles" className="resource-section foundation-registry" data-resource-section data-active={activeSection === "production-roles" ? "true" : undefined}>
        <ResourceHeading eyebrow="制作角色" title="按角色配置生产能力" meta="文本模型在新建或返工时选择；只有付费图片、视频会在执行前逐镜报价并确认" />
        <div className="model-defaults-intro"><div><strong>角色默认不是固定绑定</strong><p>节点本次选择优先于本条视频选择，再优先于这里的默认值。新建制作会保存当时的选择；更改默认值不改写正在制作的视频。</p><a href="#model-settings">去添加或管理模型接入</a></div></div>
        {settingsError ? <ResourceError title="角色默认读取失败" message={settingsError} retry={load} /> : settings ? <>
          <div className="model-default-groups" aria-label="角色与执行模型默认值">{modelDefaultGroups.map((group) => <section className="model-default-group" key={group.category.id} aria-labelledby={`model-default-${group.category.id}`}>
            <header><div><h3 id={`model-default-${group.category.id}`}>{group.category.label}</h3><p>{group.category.description}</p></div></header>
            <div className="model-default-cards">{group.providers.map((provider) => <ModelDefaultCard key={provider.id} provider={provider} selectedModelId={modelDefaults[provider.id]} onChange={(modelId) => setModelDefaults((current) => setModelDefault(current, provider.id, modelId))} />)}</div>
          </section>)}</div>
        </> : null}
        {providerLoading ? <div className="region-loading">正在读取制作能力...</div> : providerError ? null : (
          <>
            <div className="role-configuration-grid" aria-label="制作角色配置">
              {PRODUCTION_ROLE_DEFINITIONS.map((definition) => {
                const selected = resolveRoleProvider(definition, providers, roleProviderDefaults);
                return <RoleProviderCard
                  key={definition.key}
                  definition={definition}
                  providers={providers}
                  selectedProvider={selected}
                  selectedModelId={selected ? modelDefaults[selected.id] : undefined}
                  onModelChange={(modelId) => { if (selected) setModelDefaults((current) => setModelDefault(current, selected.id, modelId)); }}
                  {...(missingCapabilities.has(definition.capability) ? { missing: true } : {})}
                  onProviderChange={(providerId) => setRoleProviderDefaults((current) => ({ ...current, [definition.key]: providerId }))}
                />;
              })}
            </div>
            <div className="automatic-agent-roster" aria-label="自动参与的 AI 角色">
              <header><strong>自动参与的 AI 角色</strong><span>系统会在对应制作步骤自动调用这些角色，不需要逐条选择。</span></header>
              <div>{AUTOMATIC_AGENT_ROLES.map((role) => <AutomaticAgentRole key={role.capability} label={role.label} provider={preferredAutomaticProvider(role.capability, providers)} />)}</div>
            </div>
          </>
        )}
        {settings ? <div className="configuration-save-row foundation-save-row"><span>{roleHasChanges || modelDefaultsHaveChanges ? "有未保存的角色或模型调整" : "角色配置已同步"}</span><button className="button button-primary" type="button" disabled={settingsSaving || (!roleHasChanges && !modelDefaultsHaveChanges)} onClick={() => void saveDefaults({ ...(roleHasChanges ? { roleProviderDefaults } : {}), ...(modelDefaultsHaveChanges ? { modelDefaults } : {}) }, "角色配置已保存，仅影响后续新建制作。") }><Save aria-hidden="true" size={16} />{roleHasChanges || modelDefaultsHaveChanges ? "保存角色配置" : "已保存"}</button></div> : null}
      </section>

      <section id="resource-manifest" className="resource-section resource-manifest-section" data-resource-section data-active={activeSection === "resource-manifest" ? "true" : undefined} data-tour="resource-manifest">
        <ResourceHeading eyebrow="发布前核对" title="素材来源与授权" meta={resourceManifest ? `${rightsManifestItems.length} 项素材 · ${reviewableNeedsReviewCount} 项待确认` : "核对画面、声音、字体和最终成片"} />
        {manifestError ? <ResourceError title="资源清单读取失败" message={manifestError} retry={load} /> : !resourceManifest ? <div className="region-loading">正在汇总资源清单...</div> : <>
          <div className="resource-manifest-summary" aria-label="资源分类统计">
            {(["visual", "voice", "font"] as const).map((category) => <div key={category}><span>{resourceCategoryLabel(category)}</span><strong>{rightsManifestItems.filter((item) => item.category === category).length}</strong></div>)}
            <div className={reviewableNeedsReviewCount ? "needs-review" : ""}><span>待确认</span><strong>{reviewableNeedsReviewCount}</strong></div>
          </div>
          {resourceManifest.legacyRunsWithoutManifest ? <p className="resource-manifest-legacy">有 {resourceManifest.legacyRunsWithoutManifest} 条旧任务生成于资源清单上线前，不会补写或伪造历史授权信息。</p> : null}
          {resourceManifest.reconstructedRunCount ? <p className="resource-manifest-legacy" role="status">有 {resourceManifest.reconstructedRunCount} 条发生过付费调用但未完成清单的任务，已按现存来源证据恢复；只有证据不足的素材需要确认。</p> : null}
          {resourceManifest.unreadableManifestCount ? <p className="resource-manifest-legacy" role="status">有 {resourceManifest.unreadableManifestCount} 条资源清单损坏或不可信，已隔离；其余任务仍可正常查看。</p> : null}
          {resourceManifest.truncatedRunCount ? <p className="resource-manifest-legacy" role="status">当前仅汇总最近 500 条制作，另有 {resourceManifest.truncatedRunCount} 条较早记录未进入本页统计。</p> : null}
          <ManifestRunGroups groups={reviewableManifestRuns.slice(0, manifestLimit)} onReview={reviewResource} />
          {reviewableManifestItems.length === 0 ? <div className="resource-manifest-empty"><ListChecks aria-hidden="true" size={18} /><span>当前没有需要确认或返工的素材。</span></div> : null}
          {reviewableManifestRuns.length > manifestLimit ? <button className="button button-secondary" type="button" onClick={() => setManifestLimit((current) => current + 8)}>显示更多素材视频（还剩 {reviewableManifestRuns.length - manifestLimit} 条）</button> : null}
          {productionRecordItems.length ? <details className="resource-manifest-records">
            <summary><span><strong>制作过程记录</strong><small>脚本、方案和质检报告默认收起，不混入授权待办</small></span><b>{productionRecordItems.length} 项</b></summary>
            <ManifestRunGroups groups={productionRecordRuns.slice(0, manifestRecordLimit)} record />
            {productionRecordRuns.length > manifestRecordLimit ? <button className="button button-secondary" type="button" onClick={() => setManifestRecordLimit((current) => current + 8)}>显示更多制作记录（还剩 {productionRecordRuns.length - manifestRecordLimit} 条）</button> : null}
          </details> : null}
        </>}
      </section>

      <section id="publish-channels" className="resource-section publishing-registry" data-resource-section data-active={activeSection === "publish-channels" ? "true" : undefined} data-tour="configuration-publishing">
        <ResourceHeading eyebrow="交付出口" title="发布渠道" meta="未取得官方权限的平台只生成发布包，不会冒充自动发布" />
        {publishError ? <ResourceError title="发布渠道状态未知" message={publishError} retry={load} /> : (
          <div className="publishing-ledger" aria-label="发布渠道列表">
            {publishTargets.map((target) => <PublishTargetRow key={target.id} target={target} />)}
          </div>
        )}
        <div className="compliance-baseline"><ShieldCheck aria-hidden="true" size={18} /><div><strong>不可跳过的发布检查</strong><span>人工终审、素材授权、事实核验、页面可见的 AI 标识和文件内标记会在发送前再次检查。</span></div></div>
      </section>
    </main>
  );
}

```

### Original lines 754-865

```
function ModelDefaultCard({ provider, selectedModelId, onChange }: {
  provider: StudioProvider;
  selectedModelId: string | undefined;
  onChange: (modelId: string) => void;
}) {
  const models = provider.modelProfiles?.filter((model) => model.available) ?? [];
  const recommended = models.find((model) => model.id === provider.defaultModelId)
    ?? models.find((model) => model.recommended)
    ?? models[0];
  const inheritedModelUnavailable = Boolean(selectedModelId && !models.some((model) => model.id === selectedModelId));
  return <article className="model-default-card">
    <div><strong>{creatorProviderLabel(provider)}</strong><small>{provider.capability === "voice.synthesize" ? "声音生成" : capabilityLabel(provider.capability)}</small></div>
    <label className="field">
      <span>{creatorProviderLabel(provider)}默认模型</span>
      <select aria-label={`${creatorProviderLabel(provider)}默认模型`} value={selectedModelId ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">系统推荐：{recommended?.label ?? "自动选择"}</option>
        {inheritedModelUnavailable && selectedModelId ? <option value={selectedModelId} disabled>原默认：{selectedModelId}（当前不可用）</option> : null}
        {models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
      </select>
    </label>
    <footer><span>{billingLabel(provider.billing)}</span><span>{providerReadinessLabel(provider, isProductionReady(provider))}</span></footer>
  </article>;
}

function groupProvidersForModelDefaults(providers: StudioProvider[]): Array<{
  category: typeof MODEL_DEFAULT_CATEGORIES[number];
  providers: StudioProvider[];
}> {
  return MODEL_DEFAULT_CATEGORIES.map((category) => ({
    category,
    providers: providers.filter((provider) => provider.kind !== "test"
      && !PRODUCTION_ROLE_DEFINITIONS.some((role) => role.selectable !== false && role.capability === provider.capability)
      && (provider.modelProfiles?.some((model) => model.available) ?? false)
      && modelDefaultCategoryFor(provider) === category.id),
  })).filter((group) => group.providers.length > 0);
}

function modelDefaultCategoryFor(provider: StudioProvider): ModelDefaultCategoryId {
  const taskTypes = provider.modelProfiles?.flatMap((model) => model.taskTypes) ?? [];
  if (provider.capability === "voice.synthesize") return "voice";
  if (taskTypes.includes("text-to-video") || taskTypes.includes("image-to-video")) return "video";
  if (taskTypes.includes("text-to-image")) return "image";
  if (taskTypes.includes("visual-review") || taskTypes.includes("audio-review") || provider.capability === "quality.review.visual") return "multimodal";
  return "text";
}

function setModelDefault(current: Record<string, string>, providerId: string, modelId: string): Record<string, string> {
  const next = { ...current };
  if (modelId) next[providerId] = modelId;
  else delete next[providerId];
  return next;
}

function RoleProviderCard({ definition, providers, selectedProvider, selectedModelId, onModelChange, missing = false, onProviderChange }: {
  definition: ProductionRoleDefinition;
  providers: StudioProvider[];
  selectedProvider: StudioProvider | undefined;
  selectedModelId?: string | undefined;
  onModelChange: (modelId: string) => void;
  missing?: boolean;
  onProviderChange: (providerId: string) => void;
}) {
  const candidates = providers.filter((provider) => provider.capability === definition.capability && provider.kind !== "test");
  const models = selectedProvider?.modelProfiles?.filter((model) => model.available) ?? [];
  const activeModel = models.find((model) => model.id === (selectedModelId ?? selectedProvider?.defaultModelId))
    ?? models.find((model) => model.recommended)
    ?? models[0];
  const backupModels = models.filter((model) => model.id !== activeModel?.id);
  const ready = Boolean(selectedProvider && isProductionReady(selectedProvider));
  const singleFinalReviewAvailable = definition.key === "visualReview"
    && selectedProvider?.id === "deepseek-visual-review-v1"
    && isProductionReady(selectedProvider);
  return <article className={`role-configuration${ready ? "" : " is-unavailable"}${missing ? " is-missing" : ""}`}>
    <header>
      <span>{definition.label}{missing ? <b className="role-missing-flag">当前缺失</b> : null}</span>
      <em className={`role-mode is-${definition.mode}`}>{roleModeLabel(definition.mode)}</em>
    </header>
    <p>{definition.responsibility}</p>
    {definition.selectable === false && definition.configurationAnchor ? <div className="role-linked-configuration">
      <span>当前角色能力</span>
      <strong>{selectedProvider ? creatorProviderLabel(selectedProvider) : "尚未配置"}</strong>
      <a href={`#${definition.configurationAnchor}`}>{definition.configurationLabel}<ArrowUpRight aria-hidden="true" size={14} /></a>
    </div> : <>
      <label className="field">
        <span>{definition.label}首选能力</span>
        <select
          aria-label={`${definition.label}首选能力`}
          value={selectedProvider?.id ?? ""}
          disabled={candidates.filter(isProductionReady).length < 2}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          {!selectedProvider ? <option value="">未配置</option> : null}
          {candidates.map((provider) => <option key={provider.id} value={provider.id} disabled={!isProductionReady(provider)}>{creatorProviderLabel(provider)}{isProductionReady(provider) ? "" : " · 不可用"}</option>)}
        </select>
      </label>
      {models.length ? <label className="field"><span>{definition.label}默认模型</span><select aria-label={`${definition.label}默认模型`} value={selectedModelId ?? ""} onChange={(event) => onModelChange(event.target.value)}>
        <option value="">使用系统推荐</option>
        {selectedModelId && !models.some((model) => model.id === selectedModelId) ? <option value={selectedModelId} disabled>原选择已不可用</option> : null}
        {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select><small>仅作为新制作默认；本条视频和节点仍可改选。</small></label> : null}
      <div className="role-runtime-summary"><span>默认选择：{activeModel?.label ?? selectedProvider?.label ?? "尚未配置"}</span>{backupModels.length ? <span>故障替补：{backupModels.map((model) => model.label).join("、")}</span> : null}</div>
      {singleFinalReviewAvailable
        ? <p className="role-fallback-note">中途画面预检优先使用首选模型；只有确认请求尚未开始，或原请求已明确结束于连接故障、服务不可用、限流、超时或无输出时才切换。结果不确定会暂停核对。最终成片由所选模型基于抽帧证据完成独立质量复核，审片意见会保留给你确认；声音审片单独记录。</p>
        : candidates.filter((provider) => provider.id !== selectedProvider?.id && isProductionReady(provider)).length > 0
          ? <p className="role-fallback-note">只有确认首选请求尚未开始，或原请求已明确结束于连接故障、服务不可用、限流、超时或无输出时，其余可用能力才会依次接管。若请求结果不确定，流程会暂停核对，不会切换模型或重复生成。</p>
        : null}
    </>}
    <footer><span>{selectedProvider ? billingLabel(selectedProvider.billing) : "无可用能力"}</span><strong>{selectedProvider ? providerReadinessLabel(selectedProvider, ready) : "需要配置"}</strong></footer>
  </article>;
}

function AutomaticAgentRole({ label, provider }: { label: string; provider: StudioProvider | undefined }) {
```

## apps/studio/src/client/components/ModelLibrary.tsx

SHA256: 67ce2ea574240b8bad987a7eb0f1e721dae818be1488bbc00c3a02cae477596e; 128 lines. FULL FILE.

### Original lines 1-128

```
import { useEffect, useMemo, useState } from "react";
import type { ModelConnection, ModelConnectionInput, ModelUnderstandingCapability } from "@video-factory/production-pipeline";
import type { StudioProvider } from "../../shared/api.js";
import { studioApi } from "../api.js";

type Group = "text" | "generate" | "understand";
interface ModelItem { id: string; label: string; modelId: string; protocol: string; capabilities: string[]; groups: Group[]; available: boolean; custom?: ModelConnection }
const GROUPS: Array<{ id: Group; label: string }> = [
  { id: "text", label: "文本生成" }, { id: "generate", label: "内容生成" }, { id: "understand", label: "内容理解" },
];
const CAPABILITIES = { text: "文本生成", image: "图像理解 / 视频抽帧", audio: "真实音频理解" };

export function modelLibraryItems(providers: StudioProvider[], connections: ModelConnection[]): ModelItem[] {
  const items = new Map<string, ModelItem>();
  for (const provider of providers) {
    if (provider.kind === "test") continue;
    for (const model of provider.modelProfiles ?? []) {
      if (model.id === "codex-default") continue;
      if (connections.some((item) => item.id === model.id)) continue;
      const group: Group = provider.capability === "voice.synthesize" || model.taskTypes.some((type) => ["text-to-image", "text-to-video", "image-to-video", "digital-human"].includes(type)) ? "generate"
        : ["quality.review.visual", "reference.grammar", "asset.rank.semantic"].includes(provider.capability) || model.taskTypes.includes("visual-review") ? "understand" : "text";
      const capability = group === "text" ? "文本生成" : group === "understand" ? "图像理解 / 视频抽帧"
        : provider.capability === "voice.synthesize" ? "语音生成" : model.taskTypes.includes("text-to-image") ? "图片生成" : "视频生成";
      const id = `${model.providerFamily}:${model.id}`;
      const existing = items.get(id);
      if (existing) {
        existing.available ||= model.available;
        existing.groups = [...new Set([...existing.groups, group])];
        existing.capabilities = [...new Set([...existing.capabilities, capability])];
      } else items.set(id, {
        id, label: model.label, modelId: model.id, available: model.available, groups: [group], capabilities: [capability],
        protocol: model.providerFamily === "deepseek" ? "OpenAI Chat Completions（DeepSeek 参数）" : model.providerFamily === "openai" ? "Codex CLI（旧接入）" : "专用供应商接口 / 本地引擎",
      });
    }
  }
  for (const model of connections) items.set(model.id, {
    id: model.id, label: model.label, modelId: model.modelId, available: model.enabled, custom: model,
    protocol: model.protocol === "anthropic-messages" ? "Anthropic Messages" : "OpenAI Chat Completions",
    groups: [...(model.capabilities.includes("text") ? ["text" as const] : []), ...(model.capabilities.some((capability) => capability !== "text") ? ["understand" as const] : [])],
    capabilities: model.capabilities.map((capability) => CAPABILITIES[capability]),
  });
  return [...items.values()];
}

export function ModelLibrary({ providers, onChanged }: { providers: StudioProvider[]; onChanged: () => Promise<void> }) {
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [group, setGroup] = useState<Group>("text");
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    studioApi.models().then(({ models }) => { if (active) { setConnections(models); setReady(true); } })
      .catch(() => { if (active) setError("模型接入管理暂不可用；以下保留当前运行时的模型目录。请更新并启动模型服务后再添加。"); });
    return () => { active = false; };
  }, []);
  const items = useMemo(() => modelLibraryItems(providers, connections), [providers, connections]);
  return <div className="model-library">
    <div className="model-defaults-intro"><div><strong>先接入模型，再让角色选用</strong><p>同一接入可用于多个角色；模型能力与接入协议分别管理。角色默认不锁定本条视频的选择。</p><a href="#production-roles">去设置角色默认</a></div>
      <button type="button" className="button button-primary" disabled={!ready || busy} onClick={() => setFormOpen(!formOpen)}>{formOpen ? "收起添加表单" : "添加模型"}</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {formOpen ? <ModelConnectionForm busy={busy} onSave={async (input) => {
      setBusy(true); setError(""); setNotice("");
      try {
        const result = await studioApi.addModel(input);
        setConnections(result.models); setFormOpen(false);
        await onChanged();
        setNotice("模型接入已保存，未发起付费测试。现在可在角色默认或制作中选择；实际能力以执行结果为准。");
      } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败，请重试。"); }
      finally { setBusy(false); }
    }} /> : null}
    <div className="segmented-control" role="group" aria-label="模型能力分类">{GROUPS.map((item) => <button type="button" key={item.id} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}</div>
    <h3>{GROUPS.find((item) => item.id === group)!.label}</h3>
    {group === "generate" ? <p>图片、视频、配音沿用已接入的供应商接口。新协议需要适配，不能把文本接口冒充生成接口。</p> : null}
    {group === "understand" ? <p>视频抽帧不等于连续视频理解；真实声音审片必须发送音轨，转写文字不能代替审听。</p> : null}
    <div className="model-default-cards" aria-label="全局模型目录">{items.filter((item) => item.groups.includes(group)).map((item) => <article className="model-default-card" key={item.id}>
      <div><strong>{item.label}</strong><small>{item.modelId}</small></div>
      <p>{item.capabilities.join(" · ")}</p><small>协议：{item.protocol}</small>
      {item.custom ? <small>接口：{item.custom.baseUrl} · 密钥已保存，不回显</small> : null}
      <footer><span>{item.available ? item.custom ? "已配置，未代表实测通过" : "运行时已配置" : "未启用"}</span><span>费用以供应商账号为准</span></footer>
      {item.custom ? <button className="button button-secondary" type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          setConnections((await (item.custom!.enabled ? studioApi.disableModel(item.id) : studioApi.enableModel(item.id))).models);
          await onChanged(); setNotice("接入状态已更新，原请求记录保留。恢复始终查询原请求，不会改用其他身份重复消费。");
        } catch { setError("更新失败，请刷新后重试。"); } finally { setBusy(false); }
      }}>{item.custom.enabled ? "停用此接入" : "重新启用"}</button> : null}
    </article>)}</div>
    {!items.some((item) => item.groups.includes(group)) ? <p className="model-default-empty">尚未接入这一类模型。</p> : null}
  </div>;
}

function ModelConnectionForm({ busy, onSave }: { busy: boolean; onSave: (input: ModelConnectionInput) => Promise<void> }) {
  const [protocol, setProtocol] = useState<ModelConnectionInput["protocol"]>("openai-chat-completions");
  const [capabilities, setCapabilities] = useState<ModelUnderstandingCapability[]>(["text"]);
  return <form className="configuration-sheet" aria-label="添加模型接入" onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const effort = String(form.get("reasoningEffort") ?? "");
    const budget = String(form.get("thinkingBudget") ?? "");
    void onSave({
      label: String(form.get("label")), protocol, baseUrl: String(form.get("baseUrl")), modelId: String(form.get("modelId")), apiKey: String(form.get("apiKey")),
      capabilities, maxOutputTokens: Number(form.get("maxOutputTokens")),
      ...(effort ? { reasoningEffort: effort as ModelConnectionInput["reasoningEffort"] & string } : {}),
      ...(budget ? { thinkingBudget: Number(budget) } : {}),
    });
  }}><div className="configuration-fields">
    <label className="field"><span>接入名称</span><input name="label" required maxLength={100} placeholder="例如：我的视觉模型" /></label>
    <label className="field"><span>接口协议</span><select value={protocol} onChange={(event) => {
      const next = event.target.value as ModelConnectionInput["protocol"]; setProtocol(next);
      if (next === "anthropic-messages") setCapabilities((current) => current.filter((item) => item !== "audio"));
    }}><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
    <label className="field"><span>接口根地址（含版本路径）</span><input type="url" name="baseUrl" required placeholder="https://api.example.com/v1" /></label>
    <label className="field"><span>模型 ID（供应商原名）</span><input name="modelId" required maxLength={160} /></label>
    <label className="field"><span>API Key</span><input type="password" name="apiKey" required autoComplete="new-password" maxLength={4096} /></label>
    <label className="field"><span>最大输出 token（按模型文档填写）</span><input type="number" name="maxOutputTokens" required min={1} max={262144} /></label>
    {protocol === "openai-chat-completions" ? <label className="field"><span>推理强度（仅填写该接口支持的值）</span><select name="reasoningEffort"><option value="">服务商默认，不发送此参数</option>{["low", "medium", "high", "xhigh", "max"].map((item) => <option key={item}>{item}</option>)}</select></label>
      : <label className="field"><span>Thinking budget（留空遵循服务商默认）</span><input type="number" name="thinkingBudget" min={1024} /></label>}
  </div><fieldset><legend>模型实际支持的能力</legend>{(Object.keys(CAPABILITIES) as ModelUnderstandingCapability[]).map((capability) => <label key={capability}>
    <input type="checkbox" checked={capabilities.includes(capability)} disabled={capability === "audio" && protocol === "anthropic-messages"} onChange={(event) => setCapabilities((current) => event.target.checked ? [...current, capability] : current.filter((item) => item !== capability))} />{CAPABILITIES[capability]}
  </label>)}</fieldset><p>勾选是你的能力声明，不等于已实测。成片声音审片需同时支持音频与图像输入，以便判断音画配合；Anthropic 此适配器不提供音频输入。保存不会调用模型。</p>
    <button className="button button-primary" disabled={busy || !capabilities.length} type="submit">{busy ? "保存中…" : "保存模型接入"}</button>
  </form>;
}

```

## apps/studio/src/client/components/StatusBadge.tsx

SHA256: 5befbc655e38ec93e9dc630233587a98e2c81a37d0623df3787fbef4b9e77fe9; 40 lines. FULL FILE.

### Original lines 1-40

```
import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, XCircle } from "lucide-react";
import type { StudioRunStatus } from "../../shared/api.js";

const STATUS_LABELS: Record<StudioRunStatus, string> = {
  pending: "排队中",
  running: "制作中",
  succeeded: "已完成",
  failed: "失败",
  needs_human: "等你确认",
  rejected: "已打回",
  paused: "已暂停",
  stale: "待重新生成",
  awaiting_spend_approval: "待确认费用",
  approval_invalidated: "费用确认已失效",
};

export function StatusBadge({ status, label }: { status: StudioRunStatus; label?: string }) {
  const Icon = label === "历史只读"
    ? CircleDashed
    : status === "running"
    ? LoaderCircle
    : status === "succeeded"
      ? CircleCheck
      : status === "needs_human" || status === "awaiting_spend_approval" || status === "approval_invalidated"
        ? CircleAlert
        : status === "failed" || status === "rejected"
          ? XCircle
          : CircleDashed;
  return (
    <span className={`status-badge${label === "历史只读" ? " status-historical" : ` status-${status}`}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={2} />
      {label ?? STATUS_LABELS[status]}
    </span>
  );
}

export function statusLabel(status: StudioRunStatus): string {
  return STATUS_LABELS[status];
}

```

## apps/studio/src/client/pages/AssetsPage.tsx

SHA256: f3a2f37f2ac16575b408c9c7118d2fef2108fc995bd3c8eba30c668502c277f1; 380 lines. FULL FILE.

### Original lines 1-380

```
import {
  Database,
  ChevronDown,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Layers3,
  Music2,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  StudioAssetMediaKind,
  StudioAssetOrigin,
  StudioAssetReuseStatus,
  StudioIndexedAsset,
  StudioIndexedAssetUsage,
  StudioResourceManifest,
  StudioRunSummary,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { creatorFacingTechnicalText, providerLabel } from "../presentation.js";
import { statusLabel } from "../components/StatusBadge.js";
import { unsplashPublicUrl } from "../components/UnsplashAttribution.js";
import { hasStockAttribution, StockAttribution } from "../components/StockAttribution.js";

type AssetFilter = "all" | StudioAssetMediaKind | "reusable" | "needs_review";
type AssetCollection = "creative" | "records";

export function AssetsPage() {
  const [manifest, setManifest] = useState<StudioResourceManifest>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [origin, setOrigin] = useState<"all" | StudioAssetOrigin>("all");
  const [provider, setProvider] = useState("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"work" | "asset">("work");
  const [collection, setCollection] = useState<AssetCollection>("creative");
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [expandedWorkKeys, setExpandedWorkKeys] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [manifestResult, runsResult] = await Promise.allSettled([studioApi.resourceManifest(), studioApi.runs()]);
      if (manifestResult.status === "rejected") throw manifestResult.reason;
      setManifest(manifestResult.value);
      setRuns(runsResult.status === "fulfilled" ? runsResult.value : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "素材库暂时无法读取。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const collectionAssets = useMemo(() => (manifest?.assetIndex.assets ?? []).filter((asset) => (
    collection === "creative" ? isCreativeAsset(asset) : !isCreativeAsset(asset)
  )), [collection, manifest?.assetIndex.assets]);

  const assets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return collectionAssets.filter((asset) => {
      const matchesFilter = filter === "all"
        || (filter === "reusable" ? asset.reuseStatus === "ready"
          : filter === "needs_review" ? asset.reuseStatus === "review_required"
            : asset.mediaKind === filter);
      if (!matchesFilter || (origin !== "all" && asset.origin !== origin) || (provider !== "all" && asset.providerId !== provider)) return false;
      if (!normalized) return true;
      return [
        asset.query,
        asset.providerId,
        asset.creator,
        ...asset.tags,
        ...asset.usages.map((usage) => usage.runTitle),
        ...asset.usages.map((usage) => usage.providerId),
      ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN").includes(normalized);
    });
  }, [collectionAssets, filter, origin, provider, query]);

  const originOptions = [...new Set(collectionAssets.map((asset) => asset.origin))];
  const providerOptions = providerFilterOptions(collectionAssets);
  const hasFilters = filter !== "all" || origin !== "all" || provider !== "all" || Boolean(query.trim());
  const clearFilters = () => {
    setFilter("all");
    setOrigin("all");
    setProvider("all");
    setQuery("");
  };
  const workGroups = useMemo(() => groupAssetsByWork(assets, runs), [assets, runs]);
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  useEffect(() => {
    setExpandedWorkKeys((current) => {
      const visible = new Set(workGroups.map((group) => group.key));
      const retained = new Set([...current].filter((key) => visible.has(key)));
      if (retained.size === 0 && workGroups[0]) retained.add(workGroups[0].key);
      return retained;
    });
  }, [workGroups]);
  const collectionStats = useMemo(() => ({
    reusable: collectionAssets.filter((asset) => asset.reuseStatus === "ready").length,
    duplicateUses: collectionAssets.reduce((count, asset) => count + Math.max(0, asset.useCount - 1), 0),
    needsReview: collectionAssets.filter((asset) => asset.reuseStatus === "review_required").length,
    documents: collectionAssets.filter((asset) => asset.mediaKind === "document").length,
    finalRenders: collectionAssets.filter((asset) => asset.origin === "final_render").length,
  }), [collectionAssets]);
  const switchCollection = (next: AssetCollection) => {
    setCollection(next);
    clearFilters();
  };
  const visibleFilters = collection === "creative"
    ? FILTERS.filter((item) => item.id !== "document" && item.id !== "font" && item.id !== "other")
    : FILTERS.filter((item) => item.id !== "reusable" && item.id !== "needs_review");

  return (
    <main className="page asset-library-page">
      <header className="page-header asset-library-header">
        <div>
          <p className="eyebrow">创作资产</p>
          <h1>素材库</h1>
          <p className="page-summary">{collection === "creative" ? "可再次用于创作的画面与声音，按内容去重并保留授权和入片记录。" : "最终成片、脚本与质检记录独立归档，不混入可复用素材。"}</p>
          <Link to="/resources#visual-providers">配置外部素材来源</Link>
        </div>
        <div className="asset-library-count"><strong>{collectionAssets.length}</strong><span>{collection === "creative" ? "项创作素材" : "项成片与记录"}</span></div>
      </header>

      {manifest ? <section className="asset-index-summary" aria-label="素材库概况">
        {collection === "creative" ? <>
          <div><Database aria-hidden="true" size={18} /><span>可直接复用<strong>{collectionStats.reusable}</strong></span></div>
          <div><Layers3 aria-hidden="true" size={18} /><span>跨作品使用<strong>{collectionStats.duplicateUses}</strong></span></div>
          <div className={collectionStats.needsReview ? "needs-attention" : ""}><ShieldAlert aria-hidden="true" size={18} /><span><Link to="/resources#resource-manifest" aria-label={`去确认授权：授权待确认 ${collectionStats.needsReview} 项`}>授权待确认<strong>{collectionStats.needsReview}</strong></Link></span></div>
        </> : <>
          <div><FileText aria-hidden="true" size={18} /><span>制作文档<strong>{collectionStats.documents}</strong></span></div>
          <div><Film aria-hidden="true" size={18} /><span>最终成片<strong>{collectionStats.finalRenders}</strong></span></div>
          <div><Database aria-hidden="true" size={18} /><span>其他记录<strong>{Math.max(0, collectionAssets.length - collectionStats.documents - collectionStats.finalRenders)}</strong></span></div>
        </>}
      </section> : null}
      {manifest?.truncatedItemCount ? <p className="resource-note">页面只展开最近 500 条明细；搜索、筛选和素材统计仍覆盖全部 {manifest.totalItems} 条记录。</p> : null}

      <section className="asset-library-controls" aria-label="素材筛选">
        <div className="asset-library-organizers">
          <div className="asset-library-sections" role="group" aria-label="档案类型">
            <button type="button" aria-pressed={collection === "creative"} onClick={() => switchCollection("creative")}>创作素材</button>
            <button type="button" aria-pressed={collection === "records"} onClick={() => switchCollection("records")}>成片与记录</button>
          </div>
          <div className="asset-library-view" role="group" aria-label="素材组织方式">
            <button type="button" aria-pressed={view === "work"} onClick={() => setView("work")}>按作品</button>
            <button type="button" aria-pressed={view === "asset"} onClick={() => setView("asset")}>按资产</button>
          </div>
        </div>
        <div className="asset-library-filters">
          {visibleFilters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{assetCount(collectionAssets, item.id)}</span></button>)}
        </div>
        <div className="asset-library-refiners">
          <label><span className="sr-only">素材来源类型</span><select value={origin} onChange={(event) => setOrigin(event.target.value as "all" | StudioAssetOrigin)}><option value="all">全部来源</option>{originOptions.map((item) => <option key={item} value={item}>{originLabel(item)}</option>)}</select></label>
          <label><span className="sr-only">素材提供方</span><select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">全部提供方</option>{providerOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="asset-library-search"><Search aria-hidden="true" size={16} /><span className="sr-only">搜索素材</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索画面、标签或作品" /></label>
        </div>
      </section>

      {error ? <div className="inline-error" role="alert">{error}<button className="button button-secondary" type="button" onClick={() => void load()}>重新读取</button></div> : null}
      {loading && !manifest ? <div className="asset-library-empty">正在建立素材索引...</div> : null}
      {!loading && manifest && assets.length === 0 ? <div className="asset-library-empty"><FolderOpen aria-hidden="true" size={28} /><strong>这个范围里还没有内容</strong><span>{hasFilters ? "可以清除筛选，查看完整素材库。" : "完成一次真实制作后，镜头和制作记录会自动归档到这里。"}</span>{hasFilters ? <button className="button button-secondary" type="button" onClick={clearFilters}>清除筛选</button> : null}</div> : null}

      {assets.length && view === "asset" ? <section className="asset-library-grid" aria-live="polite">
        {assets.map((asset) => <AssetCard asset={asset} run={runsById.get(asset.usages.at(-1)?.runId ?? "")} key={asset.key} />)}
      </section> : null}
      {assets.length && view === "work" ? <section className="asset-work-groups" aria-live="polite">
        {workGroups.map((group, index) => {
          const expanded = expandedWorkKeys.has(group.key);
          return <section className={expanded ? "asset-work-group is-expanded" : "asset-work-group"} key={group.key} aria-labelledby={`asset-work-${group.key}`}>
          <header><button type="button" className="asset-work-toggle" aria-expanded={expanded} aria-controls={`asset-work-items-${group.key}`} onClick={() => setExpandedWorkKeys((current) => {
            const next = new Set(current);
            if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
            return next;
          })}><ChevronDown aria-hidden="true" size={18} /><div><small>{index === 0 ? "最近制作" : "历史制作"} · {group.items.length} 项素材</small><h2 id={`asset-work-${group.key}`}>{group.runTitle}</h2></div></button>{group.runId ? <Link to={`/projects/${group.runId}`}>打开制作</Link> : null}</header>
          {expanded ? <div id={`asset-work-items-${group.key}`} className="asset-library-grid">{group.items.map(({ asset, usage }) => <AssetCard asset={asset} usage={usage} run={runsById.get(group.runId ?? "")} grouped key={`${asset.key}:${usage?.itemId ?? "unassigned"}`} />)}</div> : null}
          </section>;
        })}
      </section> : null}
    </main>
  );
}

function groupAssetsByWork(assets: StudioIndexedAsset[], runs: StudioRunSummary[]): Array<{ key: string; runId?: string; runTitle: string; items: Array<{ asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage }> }> {
  const groups = new Map<string, { key: string; runId?: string; runTitle: string; items: Array<{ asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage }> }>();
  const seenAssetRuns = new Set<string>();
  for (const asset of assets) {
    if (!asset.usages.length) {
      const group = groups.get("unassigned") ?? { key: "unassigned", runTitle: "未归属项目", items: [] };
      group.items.push({ asset });
      groups.set("unassigned", group);
    }
    for (const usage of asset.usages) {
      const assetRunKey = `${asset.key}\u0000${usage.runId}`;
      if (seenAssetRuns.has(assetRunKey)) continue;
      seenAssetRuns.add(assetRunKey);
      const group = groups.get(usage.runId) ?? { key: usage.runId, runId: usage.runId, runTitle: usage.runTitle, items: [] };
      group.items.push({ asset, usage });
      groups.set(usage.runId, group);
    }
  }
  const runOrder = new Map(runs.map((run, index) => [run.id, index]));
  return [...groups.values()].sort((left, right) => {
    if (!left.runId) return 1;
    if (!right.runId) return -1;
    return (runOrder.get(left.runId) ?? Number.MAX_SAFE_INTEGER) - (runOrder.get(right.runId) ?? Number.MAX_SAFE_INTEGER);
  });
}

function AssetCard({ asset, usage, run, grouped = false }: { asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage | undefined; run?: StudioRunSummary | undefined; grouped?: boolean }) {
  const resolvedUsage = usage ?? asset.usages.at(-1);
  const identity = assetUsageIdentity(asset, resolvedUsage, grouped);
  const metadata = assetMetadata(asset, run);
  const creator = creatorFacingTechnicalText(asset.creator);
  const visibleTags = asset.tags.filter((tag) => tag !== "studio-owner" && tag !== asset.creator);
  return <article className="asset-card">
    <AssetPreview asset={asset} usage={resolvedUsage} identity={identity} />
    <div className="asset-card-copy">
      <header><span>{originLabel(asset.origin)} · {mediaKindLabel(asset.mediaKind)}</span><b className={`reuse-${asset.reuseStatus}`}>{reuseStatusLabel(asset.reuseStatus)}</b></header>
      <h3>{assetTitle(asset, resolvedUsage)}</h3>
      <p className="asset-provider">{hasStockAttribution(resolvedUsage?.providerId ?? asset.providerId)
        ? <StockAttribution provider={resolvedUsage?.providerId ?? asset.providerId} creator={resolvedUsage?.creator ?? creator} creatorUrl={resolvedUsage?.creatorUrl ?? asset.creatorUrl} licenseNote={resolvedUsage?.licenseNote ?? asset.licenseNote} />
        : <>{providerLabel(asset.providerId) ?? "其他制作服务"}{creator ? ` · ${creator}` : ""}</>}</p>
      {metadata.length ? <ul className="asset-metadata" aria-label="素材规格">{metadata.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      {visibleTags.length ? <div className="asset-tags">{visibleTags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
      <footer>
        <span>{grouped ? identity : asset.useCount > 1 ? `已用于 ${asset.useCount} 个镜头` : resolvedUsage?.scenePosition ? `镜头 ${resolvedUsage.scenePosition}` : resolvedUsage ? identity : "未归属"}</span>
        <div>{asset.reuseStatus === "review_required" ? <Link to="/resources#resource-manifest">去确认授权</Link> : null}{resolvedUsage ? <Link to={`/projects/${resolvedUsage.runId}`}>查看作品</Link> : null}{asset.sourceUrl ? <a href={asset.sourceUrl} target="_blank" rel="noreferrer" aria-label="查看素材原始来源"><ExternalLink aria-hidden="true" size={14} /></a> : null}</div>
      </footer>
    </div>
  </article>;
}

function AssetPreview({ asset, usage = asset.usages.at(-1), identity }: { asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage | undefined; identity: string }) {
  const isUnsplash = (usage?.providerId ?? asset.providerId) === "unsplash-stock-v1";
  const imageUrl = isUnsplash
    ? unsplashPublicUrl(usage?.previewUrl ?? asset.previewUrl, "images.unsplash.com")
    : asset.contentUrl;
  if (asset.contentUrl && asset.mediaKind === "video") return <div className="asset-card-preview"><video aria-label={`${assetTitle(asset, usage)} 预览`} src={`${asset.contentUrl}#t=0.1`} muted controls playsInline preload="metadata" /><span className="asset-card-identity">{identity}</span></div>;
  if (imageUrl && asset.mediaKind === "image") return <div className="asset-card-preview"><img src={imageUrl} alt={`${assetTitle(asset, usage)} 素材`} loading="lazy" /><span className="asset-card-identity">{identity}</span></div>;
  if (asset.contentUrl && asset.mediaKind === "audio") return <div className="asset-card-preview is-audio"><Music2 aria-hidden="true" size={28} /><audio aria-label={`${assetTitle(asset, usage)} 试听`} src={asset.contentUrl} controls preload="none" /><span className="asset-card-identity">{identity}</span></div>;
  const Icon = asset.mediaKind === "video" ? Film : asset.mediaKind === "image" ? ImageIcon : asset.mediaKind === "audio" ? Music2 : asset.mediaKind === "document" ? FileText : Database;
  return <div className={`asset-card-preview is-${asset.mediaKind}`}><Icon aria-hidden="true" size={28} /><span>{mediaKindLabel(asset.mediaKind)}</span><span className="asset-card-identity">{identity}</span></div>;
}

function assetUsageIdentity(asset: StudioIndexedAsset, usage: StudioIndexedAssetUsage | undefined, grouped: boolean): string {
  if (usage) {
    const related = grouped ? asset.usages.filter((item) => item.runId === usage.runId) : [usage];
    const positions = [...new Set(related.flatMap((item) => item.scenePosition ? [item.scenePosition] : []))].sort((left, right) => left - right);
    if (positions.length) return `镜头 ${positions.join("、")}`;
  }
  return genericAssetIdentity(asset.mediaKind);
}

function genericAssetIdentity(kind: StudioAssetMediaKind): string {
  return ({
    video: "视频素材",
    image: "图片素材",
    audio: "声音素材",
    document: "制作文档",
    font: "字体资源",
    other: "制作资源",
  })[kind];
}

const FILTERS: Array<{ id: AssetFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "video", label: "视频" },
  { id: "image", label: "图片" },
  { id: "audio", label: "声音" },
  { id: "document", label: "文档" },
  { id: "reusable", label: "可复用" },
  { id: "needs_review", label: "待确认" },
];

function assetCount(assets: StudioIndexedAsset[], filter: AssetFilter): number {
  if (filter === "all") return assets.length;
  if (filter === "reusable") return assets.filter((asset) => asset.reuseStatus === "ready").length;
  if (filter === "needs_review") return assets.filter((asset) => asset.reuseStatus === "review_required").length;
  return assets.filter((asset) => asset.mediaKind === filter).length;
}

function isCreativeAsset(asset: StudioIndexedAsset): boolean {
  return asset.origin !== "final_render" && ["video", "image", "audio"].includes(asset.mediaKind);
}

function providerFilterOptions(assets: StudioIndexedAsset[]): Array<{ id: string; label: string }> {
  const ids = [...new Set(assets.map((asset) => asset.providerId))].sort((left, right) => left.localeCompare(right));
  const baseLabels = ids.map((id) => providerLabel(id) ?? "其他制作服务");
  const counts = new Map<string, number>();
  for (const label of baseLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const candidates = ids.map((id, index) => {
    const baseLabel = baseLabels[index]!;
    if ((counts.get(baseLabel) ?? 0) < 2) return { id, baseLabel, label: baseLabel };
    const related = assets.filter((asset) => asset.providerId === id);
    const suffix = [...new Set(related.map(providerAssetSuffix))].join("与") || "制作资源";
    return { id, baseLabel, label: `${baseLabel} · ${suffix}` };
  });
  const candidateCounts = new Map<string, number>();
  for (const item of candidates) candidateCounts.set(item.label, (candidateCounts.get(item.label) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return candidates.map((item) => {
    if ((candidateCounts.get(item.label) ?? 0) < 2) return { id: item.id, label: item.label };
    const occurrence = (occurrences.get(item.label) ?? 0) + 1;
    occurrences.set(item.label, occurrence);
    return { id: item.id, label: `${item.label}（${occurrence}）` };
  });
}

function providerAssetSuffix(asset: StudioIndexedAsset): string {
  if (asset.mediaKind === "audio") return "声音";
  if (asset.mediaKind === "video") return asset.origin === "final_render" ? "成片" : "视频";
  if (asset.mediaKind === "image") return "图片";
  if (asset.mediaKind === "document") return "制作记录";
  if (asset.mediaKind === "font") return "字体";
  return "其他资源";
}

function assetTitle(asset: StudioIndexedAsset, usage = asset.usages.at(-1)): string {
  if (asset.origin === "final_render" || asset.origin === "production_document" || asset.mediaKind === "document") {
    return productionRecordTitle(asset);
  }
  if (asset.query) return asset.query;
  if (!usage) return mediaKindLabel(asset.mediaKind);
  return usage.scenePosition ? `${usage.runTitle} · 镜头 ${usage.scenePosition}` : usage.runTitle;
}

function productionRecordTitle(asset: StudioIndexedAsset): string {
  if (asset.kind === "render") return "最终成片";
  if (asset.kind === "script") return "脚本";
  if (asset.kind === "storyboard") return "导演方案";
  if (asset.kind === "asset_plan") return "画面方案";
  if (asset.kind === "generation_jobs") return "画面生成记录";
  if (asset.kind === "publish_package") return "发布包";
  if (asset.kind === "review_report") {
    if (asset.providerId.includes("technical-review")) return "技术质检报告";
    if (asset.providerId.includes("visual-review") || asset.providerId === "openai") return "视觉审片报告";
    return "审片报告";
  }
  return "制作记录";
}

function assetMetadata(asset: StudioIndexedAsset, run?: StudioRunSummary): string[] {
  return [
    asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined,
    asset.aspectRatio,
    asset.durationSeconds ? `${Math.round(asset.durationSeconds * 10) / 10} 秒` : undefined,
    asset.usages.some((item) => item.runId === run?.id && item.selectedInFinal) ? "已入片" : undefined,
    run ? `${formatRunDate(run.finishedAt ?? run.startedAt)} · ${statusLabel(run.status)}` : undefined,
  ].filter((item): item is string => Boolean(item));
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function mediaKindLabel(kind: StudioAssetMediaKind): string {
  return ({ video: "视频", image: "图片", audio: "声音", document: "制作文档", font: "字体", other: "其他" })[kind];
}

function originLabel(origin: StudioAssetOrigin): string {
  return ({ stock: "授权素材", ai_generated: "AI 生成", local_generated: "本地制作", creator_upload: "个人上传", final_render: "最终成片", voice_synthesis: "合成声音", production_document: "制作过程", system: "系统资源" })[origin];
}

function reuseStatusLabel(status: StudioAssetReuseStatus): string {
  return ({ ready: "可直接复用", review_required: "授权待确认", private: "仅当前项目", not_reusable: "仅作记录" })[status];
}

```

## apps/studio/src/client/pages/TodayPage.tsx

SHA256: bc4c38a9f459fd631c138082628021be73f4a6e9021b6aaf81d9ce56babe1acf; 737 lines. OMITTED: 1-274, 641-737.

### Original lines 275-640

```
  // 建议只影响排序与标注：所有待制作机会都能开工，界面不再按建议把机会分流成"可开工/不可开工"。
  const advisedOpportunities = useMemo(
    () => entryMode === "trend"
      ? visibleOpportunities.filter((item) => opportunityProductionAdvice(item) !== undefined)
      : [],
    [entryMode, visibleOpportunities],
  );
  const advisedOpportunityCount = advisedOpportunities.length;
  const displayedOpportunities = useMemo(
    () => advisedOpportunityCount
      ? [...visibleOpportunities.filter((item) => opportunityProductionAdvice(item) === undefined), ...advisedOpportunities]
      : visibleOpportunities,
    [advisedOpportunityCount, advisedOpportunities, visibleOpportunities],
  );
  const sourceBlockedOpportunities = useMemo(
    () => entryMode === "trend"
      ? visibleOpportunities.filter((item) => item.verification?.status === "blocked")
      : [],
    [entryMode, visibleOpportunities],
  );
  const sourceBlockedCount = sourceBlockedOpportunities.length;
  const visibleRuns = useMemo(
    () => runs.filter((run) => matchesEntryOrigin(entryMode, run.creationOrigin)
      && (entryMode !== "series" || !selectedSeriesId || run.seriesId === selectedSeriesId)),
    [entryMode, runs, selectedSeriesId],
  );
  const selected = useMemo(
    () => displayedOpportunities.find((item) => item.id === selectedId) ?? displayedOpportunities[0],
    [displayedOpportunities, selectedId],
  );
  const selectedSeriesContext = useMemo(() => {
    if (!selected?.seriesId || !selected.episodeNumber) return undefined;
    const selectedSeries = series.find((item) => item.id === selected.seriesId);
    if (!selectedSeries) return undefined;
    const episode = selectedSeries.episodes.find((item) => item.episodeNumber === selected.episodeNumber);
    if (!episode) return undefined;
    return {
      seriesId: selectedSeries.id,
      episodeId: episode.id,
      seriesName: selectedSeries.name,
      seriesRevision: selectedSeries.revision,
      episodeNumber: episode.episodeNumber,
      seasonNumber: episode.seasonNumber,
      canonBaseRevision: episode.canonBaseRevision,
      premise: selectedSeries.premise,
      audience: selectedSeries.audience,
      platform: selectedSeries.platform,
      track: selectedSeries.track,
      arc: episode.arc,
      episode: {
        updatedAt: episode.updatedAt,
        pillar: episode.pillar,
        title: episode.title,
        viewerPromise: episode.viewerPromise,
        hook: episode.hook,
        payoff: episode.payoff,
        planning: episode.planning,
      },
      bible: selectedSeries.bible,
      canon: selectedSeries.canon,
      continuity: episode.continuity,
    };
  }, [selected, series]);
  const visibleCandidateItems = entryMode === "series" && selectedSeriesId
    ? (inbox?.items.filter((item) => item.seriesId === selectedSeriesId) ?? [])
    : (inbox?.items ?? []);
  const visibleCandidateCount = entryMode === "series" && selectedSeriesId
    ? visibleCandidateItems.length
    : (inbox?.facets.total ?? 0);
  const adoptableCandidateCount = visibleCandidateItems.filter(isAdoptableCandidate).length;
  const completedCount = visibleRuns.filter((run) => run.status === "succeeded").length;
  const dailyStatus = entryMode === "trend"
    ? `${adoptableCandidateCount} 条候选可进入制作 · ${visibleOpportunities.length} 条已进入待制作区${advisedOpportunityCount > 0 ? ` · ${advisedOpportunityText(advisedOpportunityCount, sourceBlockedCount)}` : ""} · ${completedCount} 条已完成`
    : `${visibleCandidateCount} 条候选 · ${visibleOpportunities.length} 条制作机会 · ${completedCount} 条已完成`;
  const seriesAuditReady = providersLoading
    ? undefined
    : !providersError && providers.some((provider) => provider.capability === "series.plan" && provider.available && provider.kind !== "test");

  useEffect(() => {
    // 机会仍在加载时不要重置选中项：深链（?opportunity=）带入的初始 id 必须等到列表就绪后再校验。
    if (opportunitiesLoading) return;
    setSelectedId((current) => current && displayedOpportunities.some((item) => item.id === current)
      ? current
      : displayedOpportunities[0]?.id);
  }, [displayedOpportunities, opportunitiesLoading]);

  async function createOpportunity(input: StudioOpportunityInput) {
    const created = await studioApi.createOpportunity({ ...input, origin: input.origin ?? "manual" });
    setOpportunities((current) => [created, ...current]);
    setSelectedId(created.id);
    setOpportunityDialogOpen(false);
    // 保存成功必须可见、可继续：自定义机会进入「从想法开始」的待制作区，
    // 跨页状态以服务端机会状态为准，这里只负责告诉用户它去了哪里、下一步做什么。
    if (entryMode === "custom") {
      announceNotice(`已保存《${created.title}》。它已进入下方待制作区，可以直接开始制作。`);
      return;
    }
    announceNotice(`已保存《${created.title}》。它已进入「从想法开始」的待制作区，当前入口继续展示热点候选。`);
    setNextStepNoticeAction({ to: `/topics?mode=custom&opportunity=${encodeURIComponent(created.id)}`, label: "去查看并制作" });
  }

  async function adoptCandidate(candidate: StudioCandidateInboxItem, verificationConfirmed = false) {
    setAdoptingCandidateId(candidate.id);
    setCandidateActionError(undefined);
    try {
      const adopted = await studioApi.adoptCandidate(candidate.id, {
        origin: candidate.origin,
        ...(verificationConfirmed ? { verificationConfirmed: true } : {}),
      });
      setOpportunities((current) => [adopted, ...current.filter((item) => item.id !== adopted.id)]);
      setSelectedId(adopted.id);
      const updateInbox = (current: StudioCandidateInbox | undefined) => current ? {
        ...current,
        items: current.items.filter((item) => item.id !== candidate.id),
        facets: { ...current.facets, total: Math.max(0, current.facets.total - 1) },
      } : current;
      if (candidate.origin === "trend") setTrendInbox(updateInbox);
      else setSeriesInbox(updateInbox);
      announceNotice("已采用。下一步：检查证据与镜头计划，再开始制作。");
      window.requestAnimationFrame(() => {
        adoptedSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        adoptedSectionRef.current?.focus({ preventScroll: true });
      });
      if (candidate.origin === "series") await loadSeriesWorkspace();
    } catch (caught) {
      setCandidateActionError(`采用候选失败：${errorMessage(caught)}`);
    } finally {
      setAdoptingCandidateId(undefined);
    }
  }

  // 待制作区的方向按钮：需要人工核验的方向先弹核验弹窗，其余直接采用。
  async function adoptDirection(candidate: StudioCandidateInboxItem) {
    if (candidate.verification.status === "review_required") {
      setBoardVerificationCandidate(candidate);
      return;
    }
    await adoptCandidate(candidate);
  }

  async function createSeries(input: StudioSeriesInput) {
    const created = await studioApi.createSeries(input);
    setSeries((current) => [created, ...current]);
    setSeriesDialogOpen(false);
    await loadSeriesCandidates();
  }

  async function updateSeriesEpisode(seriesId: string, episodeNumber: number, input: StudioSeriesEpisodePlanInput) {
    setCandidateActionError(undefined);
    try {
      const updated = await studioApi.updateSeriesEpisodePlan(seriesId, episodeNumber, input);
      setSeries((current) => current.map((item) => item.id === updated.id ? updated : item));
      await loadSeriesCandidates();
      announceNotice(`第 ${episodeNumber} 集路线图已保存为人工版本，后续角色会基于这个版本重新审计。`);
    } catch (caught) {
      const message = `路线图保存失败：${errorMessage(caught)}`;
      setCandidateActionError(message);
      throw new Error(message);
    }
  }

  async function linkLegacySeriesRun(seriesId: string, episodeNumber: number, runId: string) {
    const updated = await studioApi.linkLegacySeriesRun(seriesId, episodeNumber, runId);
    setSeries((current) => current.map((item) => item.id === updated.id ? updated : item));
    await loadSeriesWorkspace();
    announceNotice(`第 ${episodeNumber} 集已关联历史成片，后续单集将按最新已定版内容解锁。`);
  }

  async function startProduction(input: StudioProductionInput) {
    const result = await studioApi.start(input);
    if (selected && (selected.status === "draft" || selected.status === "shortlisted")) {
      try {
        const approved = await studioApi.updateOpportunityStatus(selected.id, "approved");
        setOpportunities((current) => current.map((item) => item.id === approved.id ? approved : item));
      } catch (caught) {
        setCandidateActionError(`制作已创建，但机会状态同步失败：${errorMessage(caught)}`);
      }
    }
    setProductionDialogOpen(false);
    navigate(`/projects/${result.runId}`);
  }

  function focusSourceBlockedOpportunity(opportunityId: string) {
    setSelectedId(opportunityId);
    window.requestAnimationFrame(() => {
      adoptedSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      adoptedSectionRef.current?.focus({ preventScroll: true });
    });
  }

  // 补充来源保存成功后不做任何乐观解除阻塞：完全重新拉取候选/机会列表，
  // 让来源数、门禁状态、分组和推荐模板都以服务端重算结果为准。
  async function submitSupplementSources(evidenceUrls: string[]) {
    if (!sourceSupplementTarget) return;
    setSourceSupplementPending(true);
    setSourceSupplementError(undefined);
    try {
      if (sourceSupplementTarget.kind === "candidate") {
        const candidate = sourceSupplementTarget.candidate;
        await studioApi.supplementCandidateSources(candidate.id, {
          evidenceUrls,
          // 入口声明让服务端把补充写入对应持久层：热点→候选缓存，系列→单集计划。
          ...(candidate.origin === "series" ? { origin: "series" as const } : { origin: "trend" as const }),
        });
        if (candidate.origin === "series") {
          await loadSeriesWorkspace();
        } else {
          updateTrendInbox(await studioApi.candidateInbox({ origins: ["trend"], limit: 100 }));
        }
      } else {
        await studioApi.supplementOpportunitySources(sourceSupplementTarget.opportunity.id, { evidenceUrls });
        const origin = entryMode === "custom" ? "manual" : entryMode;
        setOpportunities(await studioApi.opportunities(origin));
      }
      setSourceSupplementTarget(undefined);
      announceNotice("来源已保存；开工门槛与制作建议已按最新来源重算。");
    } catch (caught) {
      setSourceSupplementError(`来源保存失败：${errorMessage(caught)}`);
      throw caught;
    } finally {
      setSourceSupplementPending(false);
    }
  }

  function openOpportunityDialog(mode: "manual" | "json") {
    setOpportunityDialogMode(mode);
    setOpportunityDialogOpen(true);
  }

  function openProductionDialog() {
    setProductionDialogOpen(true);
  }

  return (
    <main className="today-page">
      <header className="today-header">
        <div><p className="eyebrow">{entryCopy(entryMode).eyebrow}</p><h1>{entryCopy(entryMode).title}</h1><p>{dailyStatus}</p></div>
        <Link className="button button-secondary" to="/"><ArrowLeft aria-hidden="true" size={17} />更换创作入口</Link>
      </header>
      {runsLoading ? <div className="region-loading">正在读取生产状态...</div> : runsError ? (
        <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={18} />生产状态读取失败：{runsError}</div>
      ) : <ProductionStrip runs={visibleRuns} />}
      {settingsError ? (
        <div className="inline-error" role="alert">
          <AlertCircle aria-hidden="true" size={18} />
          <span>未能读取你的创作设置，为避免用错声音/平台/时长，暂未开工。{settingsError}</span>
          <button className="button button-secondary" type="button" onClick={() => void retrySettings()}><RefreshCw aria-hidden="true" size={16} />重新读取</button>
        </div>
      ) : null}
      <TopicEntryWorkspace initialMode={entryMode} {...(initialCandidateId ? { initialSelectedId: initialCandidateId } : {})} selectedSeriesId={selectedSeriesId} {...(inbox ? { inbox } : {})} series={series} historicalRuns={runs} loading={{ trend: trendLoading, series: seriesLoading }} error={{ ...(trendError ? { trend: trendError } : {}), ...(seriesError ? { series: seriesError } : {}) }} trendMeta={trendMeta} trendRefreshPending={trendRefreshPending} trendRefreshing={trendRefreshing} sourceBlockedOpportunities={sourceBlockedOpportunities} onFocusSourceBlocked={focusSourceBlockedOpportunity} {...(seriesAuditReady === undefined ? {} : { seriesAuditReady })} {...(adoptingCandidateId ? { adoptingId: adoptingCandidateId } : {})} onRetry={(origin) => void (origin === "trend" ? loadTrendInbox(true) : loadSeriesWorkspace())} onRefreshTrends={() => void loadTrendInbox(true)} onAdopt={adoptCandidate} onSupplementSources={(candidate) => setSourceSupplementTarget({ kind: "candidate", candidate })} onCreateSeries={() => setSeriesDialogOpen(true)} onSelectSeries={setActiveSeriesId} onUpdateSeriesEpisode={updateSeriesEpisode} onLinkLegacyRun={linkLegacySeriesRun} onRescanSeries={loadSeriesWorkspace} onViewProductionRecords={() => navigate("/projects")} onManual={() => openOpportunityDialog("manual")} onImport={() => openOpportunityDialog("json")} />
      {candidateActionError ? <div className="inline-error topic-action-error" role="alert"><AlertCircle aria-hidden="true" size={18} />{candidateActionError}</div> : null}
      {nextStepNotice ? <div className="next-step-notice" role="status"><CheckCircle2 aria-hidden="true" size={18} /><strong>{nextStepNotice}</strong>{nextStepNoticeAction ? <Link className="button button-secondary" to={nextStepNoticeAction.to}>{nextStepNoticeAction.label}</Link> : null}<button type="button" onClick={() => { setNextStepNotice(undefined); setNextStepNoticeAction(undefined); }} aria-label="关闭下一步提示">知道了</button></div> : null}

      <section ref={adoptedSectionRef} tabIndex={-1} className="adopted-opportunities" aria-labelledby="adopted-opportunities-title">
        <header>
          <div>
            <p className="eyebrow">{entryMode === "series" ? "本集制作" : "待制作"}</p>
            <h2 id="adopted-opportunities-title">{entryMode === "series" ? "本集制作准备" : "待制作机会"}</h2>
          </div>
          {entryMode === "series" && selected ? (
            <label className="series-production-selector">
              <span>待制作单集</span>
              <select aria-label="选择待制作单集" value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                {displayedOpportunities.map((item) => <option key={item.id} value={item.id}>E{String(item.episodeNumber ?? 0).padStart(2, "0")} · {item.title}</option>)}
              </select>
            </label>
          ) : <span>{entryMode === "trend"
            ? `${visibleOpportunities.length} 条已进入待制作区${advisedOpportunityCount > 0 ? ` · ${advisedOpportunityText(advisedOpportunityCount, sourceBlockedCount)}` : ""}`
            : `${visibleOpportunities.length} 条`}</span>}
        </header>
        {entryMode === "trend" ? (
          <HotTopicBoard
            candidates={(trendInbox?.items ?? []).filter((item) => !opportunities.some((adopted) => adopted.id === item.id))}
            {...(trendInbox?.topicGeneration ? { topicGeneration: trendInbox.topicGeneration } : {})}
            {...(adoptingCandidateId ? { adoptingId: adoptingCandidateId } : {})}
            refreshBusy={trendRefreshPending || trendRefreshing}
            onAdopt={adoptDirection}
            onSupplementSources={(candidate) => setSourceSupplementTarget({ kind: "candidate", candidate })}
            onRetry={() => void loadTrendInbox(true)}
          />
        ) : null}
        {opportunitiesLoading ? <div className="today-loading"><RadioTower aria-hidden="true" size={22} />正在读取制作机会...</div> : opportunitiesError ? (
          <div className="source-error-state" role="alert"><AlertCircle aria-hidden="true" size={22} /><div><p className="eyebrow">制作机会不可用</p><h2>机会读取失败</h2><p>{opportunitiesError}</p></div><button className="button button-secondary" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" size={16} />重试</button></div>
        ) : selected ? (
          entryMode === "series" ? (
            <div className="series-production-workspace">
              <OpportunityFocus key={selected.id} opportunity={selected} />
              <DirectorPanel opportunity={selected} providers={providers} {...(recentTopicGeneration ? { recentTopicGeneration } : {})} {...(providersLoading || providersError ? { providerError: providersLoading ? "正在读取能力状态..." : `能力状态读取失败：${providersError}` } : {})} onProduce={openProductionDialog} />
            </div>
          ) : (
            <div className="director-workspace">
              <OpportunityRail opportunities={displayedOpportunities} selectedId={selected.id} onSelect={setSelectedId} onCreate={() => openOpportunityDialog("manual")} />
              <OpportunityFocus key={selected.id} opportunity={selected} {...(selected.origin === "trend" && selected.verification?.status === "blocked" ? { onSupplementSources: () => setSourceSupplementTarget({ kind: "opportunity", opportunity: selected }) } : {})} />
              <DirectorPanel opportunity={selected} providers={providers} {...(recentTopicGeneration ? { recentTopicGeneration } : {})} {...(providersLoading || providersError ? { providerError: providersLoading ? "正在读取能力状态..." : `能力状态读取失败：${providersError}` } : {})} onProduce={openProductionDialog} />
            </div>
          )
        ) : <div className="awaiting-adoption"><RadioTower aria-hidden="true" size={22} /><span>{entryMode === "series" ? "当前没有待制作单集；从路线图采用下一集，或到制作记录继续已有工作。" : "当前没有待制作机会；从上方采用新候选，已开始制作的内容请到制作记录继续。"}</span><Link className="button button-secondary" to="/projects">查看制作记录</Link></div>}
      </section>

      <OpportunityDialog open={opportunityDialogOpen} initialMode={opportunityDialogMode} onClose={() => setOpportunityDialogOpen(false)} onSubmit={createOpportunity} />
      <SourceSupplementDialog
        open={sourceSupplementTarget !== undefined}
        title={sourceSupplementTarget?.kind === "candidate" ? sourceSupplementTarget.candidate.title : sourceSupplementTarget?.opportunity.title ?? ""}
        currentSources={sourceSupplementTarget?.kind === "candidate"
          ? sourceSupplementTarget.candidate.verification.independentSources
          : sourceSupplementTarget?.opportunity.verification?.independentSources ?? 0}
        requiredSources={sourceSupplementTarget?.kind === "candidate"
          ? sourceSupplementTarget.candidate.verification.requiredSources
          : sourceSupplementTarget?.opportunity.verification?.requiredSources ?? 2}
        pending={sourceSupplementPending}
        {...(sourceSupplementError ? { error: sourceSupplementError } : {})}
        onClose={() => {
          if (sourceSupplementPending) return;
          setSourceSupplementTarget(undefined);
          setSourceSupplementError(undefined);
        }}
        onSubmit={submitSupplementSources}
      />
      <CandidateVerificationDialog
        {...(boardVerificationCandidate ? { candidate: boardVerificationCandidate } : {})}
        pending={boardVerificationCandidate?.id === adoptingCandidateId}
        onClose={() => setBoardVerificationCandidate(undefined)}
        onConfirm={async () => {
          if (!boardVerificationCandidate) return;
          await adoptCandidate(boardVerificationCandidate, true);
          setBoardVerificationCandidate(undefined);
        }}
      />
      <SeriesDialog open={seriesDialogOpen} onClose={() => setSeriesDialogOpen(false)} onSubmit={createSeries} />
      <NewRunDialog open={productionDialogOpen} providers={providers} initialDataReady={!providersLoading && !settingsLoading && !settingsError} {...(creatorSettings ? { creatorSettings } : {})} {...(settingsError ? { settingsError } : {})} onRetrySettings={() => void retrySettings()} {...(selected ? { initialValues: {
        title: selected.title,
        angle: selected.hook,
        audience: selected.audience,
        nicheSlug: selected.track,
        platform: selected.origin === "trend"
          ? creatorSettings?.productionDefaults.platform ?? "douyin"
          : selected.platform,
        durationSeconds: creatorSettings?.productionDefaults.durationSeconds ?? 24,
        ...(selected.visualProof ? { visualProof: selected.visualProof } : {}),
        ...(selected.visualPlan ? { visualPlan: selected.visualPlan } : {}),
        // editorial 是"做哪种形态"给编剧/导演用的形态指令，不是总编的意见记录：
        // 总编建议不做（skip）时不该把它塞进这里，否则下游会把它当成形态指令。
        ...(selected.editorialDecision?.verdict !== "skip" && selected.editorialDecision ? {
          editorial: {
            verdict: selected.editorialDecision.verdict,
            reasons: selected.editorialDecision.reasons,
            guardrails: selected.editorialDecision.guardrails,
          },
        } : {}),
        creationContext: {
          origin: selected.origin === "trend" || selected.origin === "series" ? selected.origin : "manual",
          opportunityId: selected.id,
        },
        ...(selectedSeriesContext ? { seriesContext: selectedSeriesContext } : {}),
      } } : {})} onClose={() => setProductionDialogOpen(false)} onSubmit={startProduction} />
    </main>
  );
}

function matchesEntryOrigin(
  mode: "trend" | "series" | "custom",
  // 案例来源的 run 不属于这里的任何一个入口：它从案例页出发，不在选题页的列表里出现。
  origin: "trend" | "series" | "manual" | "case" | undefined,
): boolean {
  if (mode === "trend") return origin === "trend";
  if (mode === "series") return origin === "series";
```

## apps/studio/src/client/styles.css

SHA256: a5c5550db73278887c41599a91e67a5ba1915e57d81310fd087b54343f8efcec; 1204 lines. OMITTED: 101-774, 806-1204.

### Original lines 1-100

```
:root {
  color-scheme: light;
  font-family: "Manrope Variable", "Noto Sans SC Variable", "PingFang SC", sans-serif;
  color: #273247;
  background: #f5f7fa;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  --canvas: #f5f7fa;
  --paper: #ffffff;
  --paper-soft: #f8fafc;
  --ink: #273247;
  --muted: #667085;
  --faint: #98a2b3;
  --line: #e1e6ed;
  --line-strong: #cfd7e3;
  --rail: #fbfcfe;
  --accent: #0f5cf6;
  --action: #0f5cf6;
  --accent-strong: #0948c8;
  --accent-soft: #edf4ff;
  --blue: #0f5cf6;
  --blue-soft: #edf4ff;
  --green: #178765;
  --green-soft: #edf8f4;
  --yellow: #956515;
  --yellow-soft: #fff7e6;
  --red: #c44747;
  --red-soft: #fff1f1;
  --surface-subtle: #f8fafc;
  --surface-pressed: #eef3f8;
  --shadow: 0 10px 28px rgb(23 32 51 / 6%);
}

* { box-sizing: border-box; }
html { min-width: 320px; min-height: 100%; background: var(--canvas); }
body { min-width: 320px; min-height: 100vh; margin: 0; background: var(--canvas); }
button, input, select, textarea { font: inherit; letter-spacing: 0; }
button, a { -webkit-tap-highlight-color: transparent; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid rgb(47 100 166 / 28%); outline-offset: 2px; }
a { color: inherit; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
/* skip-link 用 opacity 隐藏：transform 位移在移动端弹窗/滚动等包含块变化下可能失效，
   opacity 与元素被画在哪里无关，且不影响键盘聚焦。 */
.skip-link { position: fixed; z-index: 1000; top: 10px; left: 10px; padding: 10px 14px; color: #ffffff; background: var(--ink); border-radius: 4px; text-decoration: none; opacity: 0; pointer-events: none; }
.skip-link:focus { opacity: 1; pointer-events: auto; }

.app-shell { min-height: 100vh; padding-left: 220px; }
.side-rail { position: fixed; inset: 0 auto 0 0; z-index: 30; display: flex; width: 220px; flex-direction: column; padding: 22px 16px 18px; color: var(--ink); background: var(--rail); border-right: 1px solid var(--line); }
.brand { display: flex; min-width: 0; align-items: center; gap: 10px; color: inherit; text-decoration: none; }
.side-rail .brand { margin: 0 3px 28px; }
.brand-mark { display: grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center; color: #ffffff; background: var(--accent); border-radius: 6px; box-shadow: 0 8px 20px rgb(15 92 246 / 18%); }
.brand > span:last-child { display: flex; min-width: 0; flex-direction: column; }
.brand strong { overflow: hidden; font-size: 15px; line-height: 1.2; text-overflow: ellipsis; }
.brand small { margin-top: 3px; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.primary-nav { display: grid; gap: 6px; }
.primary-nav a { display: flex; height: 46px; align-items: center; gap: 11px; padding: 0 12px; color: var(--muted); border: 1px solid transparent; border-radius: 6px; font-size: 14px; font-weight: 650; text-decoration: none; }
.primary-nav a:hover { color: var(--ink); background: var(--paper-soft); }
.primary-nav a.active { color: var(--accent-strong); background: var(--accent-soft); border-color: #cfe0ff; box-shadow: inset 3px 0 0 var(--accent); }
.rail-status { display: flex; align-items: center; gap: 8px; margin-top: auto; padding: 10px 9px 2px; color: var(--muted); font-size: 13px; }
.health-dot { width: 7px; height: 7px; flex: 0 0 7px; background: var(--green); border-radius: 50%; box-shadow: 0 0 0 3px rgb(23 135 101 / 12%); }
.health-dot.health-down { background: var(--red); box-shadow: 0 0 0 3px rgb(196 71 71 / 12%); }
.mobile-bar { display: none; }
.content-shell { min-width: 0; min-height: 100vh; }

.page, .today-page { width: 100%; max-width: 1540px; margin: 0 auto; padding: 38px 42px 60px; }
.eyebrow { margin: 0 0 8px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: 0.1em; line-height: 1.3; text-transform: uppercase; }
.page-header, .today-header, .run-header { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 22px; margin-bottom: 26px; }
.page-header h1, .today-header h1, .run-header h1 { max-width: 900px; margin: 0; font-size: 36px; font-weight: 780; letter-spacing: 0; line-height: 1.12; }
.today-header p:last-child, .page-summary { max-width: 720px; margin: 9px 0 0; color: var(--muted); font-size: 15px; line-height: 1.7; }

.button { display: inline-flex; min-height: 38px; align-items: center; justify-content: center; gap: 7px; padding: 0 15px; border: 1px solid transparent; border-radius: 4px; font-size: 14px; font-weight: 750; line-height: 1; text-decoration: none; cursor: pointer; transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease; }
.button { white-space: nowrap; }
.button:disabled { cursor: not-allowed; opacity: 0.48; }
.button-primary { color: #ffffff; background: var(--action); border-color: var(--action); box-shadow: 0 8px 20px rgb(15 92 246 / 16%); }
.button-primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); transform: translateY(-1px); }
.button-secondary { color: var(--ink); background: var(--paper); border-color: var(--line-strong); }
.button-ghost { color: var(--muted); background: transparent; border-color: var(--line); }
.button-danger { color: #ffffff; background: var(--red); border-color: #b64035; }
.button-danger-ghost { color: var(--red); background: #ffffff; border-color: #e4b6b0; }
.icon-button { display: inline-grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center; padding: 0; color: var(--muted); background: var(--paper); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.icon-button:hover:not(:disabled) { color: var(--ink); border-color: var(--line-strong); }
.icon-button-dark { color: var(--ink); background: var(--paper); border-color: var(--line-strong); }

.production-strip { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; min-height: 52px; align-items: center; gap: 12px; margin: -6px 0 18px; padding: 7px 10px 7px 8px; color: #f3f3ed; background: var(--rail); border: 1px solid #151715; border-radius: 4px; }
.production-strip-icon { display: grid; width: 34px; height: 34px; place-items: center; color: #ffffff; background: var(--accent); border-radius: 3px; }
.production-strip-review .production-strip-icon { color: #ffffff; background: var(--red); }
.production-strip > div { display: flex; min-width: 0; align-items: baseline; gap: 10px; }
.production-strip > div span { flex: 0 0 auto; color: #0f5cf6; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; }
.production-strip-review > div span { color: #f18c81; }
.production-strip > div strong { overflow: hidden; font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.production-strip > small { color: #aeb2ae; font-size: 13px; }
.production-strip > a { display: inline-flex; align-items: center; gap: 4px; color: #ffffff; font-size: 13px; font-weight: 700; text-decoration: none; }

.daily-path { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0 0 18px; border-block: 1px solid var(--line-strong); }
.daily-path-step { display: grid; min-width: 0; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 10px; padding: 13px 16px; color: var(--muted); border-right: 1px solid var(--line); }
.daily-path-step:last-child { border-right: 0; }
.daily-path-step > span { display: grid; width: 28px; height: 28px; place-items: center; color: var(--faint); border: 1px solid var(--line-strong); border-radius: 50%; font-size: 11px; font-weight: 800; }
.daily-path-step > div { display: grid; min-width: 0; gap: 3px; }
.daily-path-step strong { color: var(--ink); font-size: 13px; }
.daily-path-step small { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
```

### Original lines 775-805

```
  .publish-delivery-list > div { grid-template-columns: 84px minmax(0, 1fr); }
  .publish-delivery-list small { grid-column: 1 / -1; }
}

@media (max-width: 410px) {
  .mobile-bar .brand strong { display: none; }
  .mobile-bar .brand { gap: 0; }
  .mobile-bar nav a { width: 44px; }
  .page-header h1, .today-header h1, .run-header h1 { font-size: 23px; }
  .focus-heading { gap: 10px; }
  .focus-heading h2 { font-size: 21px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
}

/* Editorial studio visual system */
:root {
  --canvas: #f4f5f2;
  --paper: #fbfcfa;
  --paper-soft: #eef0ec;
  --ink: #1c2028;
  --muted: #676d74;
  --faint: #989da2;
  --line: #d9ddd7;
  --line-strong: #bfc5be;
  --rail: #252b35;
  --yellow: #d7a42c;
  --yellow-soft: #fff3c9;
  --red: #c84a3d;
```

## apps/studio/src/client/studio-v3.css

SHA256: ab5291a6288d91dd393810ce830f74aad04d31be5651f4dbcf8fbcb0de3a5338; 1284 lines. OMITTED: 181-504, 536-1284.

### Original lines 1-180

```
:root {
  --canvas: #f5f7fa;
  --paper: #ffffff;
  --paper-soft: #f8fafc;
  --ink: #273247;
  --muted: #667085;
  --faint: #98a2b3;
  --line: #e1e6ed;
  --line-strong: #cfd7e3;
  --rail: #fbfcfe;
  --accent: #0f5cf6;
  --action: #0f5cf6;
  --accent-strong: #0948c8;
  --accent-soft: #edf4ff;
  --blue: #0f5cf6;
  --blue-soft: #edf4ff;
  --green: #178765;
  --green-soft: #edf8f4;
  --yellow: #956515;
  --yellow-soft: #fff7e6;
  --red: #c44747;
  --red-soft: #fff1f1;
  --shadow: 0 18px 42px rgb(23 32 51 / 8%);
}

body { background: var(--canvas); }
.studio-v3 { min-height: 100vh; padding: 0 0 0 236px; background: var(--canvas); }
.studio-sidebar { position: fixed; inset: 0 auto 0 0; z-index: 40; display: flex; width: 236px; flex-direction: column; padding: 22px 16px 18px; color: var(--ink); background: var(--rail); border-right: 1px solid var(--line); }
.studio-sidebar .brand { margin: 0 5px 26px; }
.studio-sidebar .brand-mark { width: 40px; height: 40px; flex-basis: 40px; background: var(--accent); border-radius: 8px; box-shadow: none; }
.studio-sidebar .brand strong { font-size: 16px; font-weight: 790; }
.studio-sidebar .brand small { color: var(--muted); font-size: 10px; letter-spacing: 0.08em; }
.sidebar-pulse { display: flex; min-height: 82px; align-items: flex-start; gap: 10px; margin-bottom: 22px; padding: 16px 12px 13px; color: var(--ink); background: #ffffff; border: 1px solid var(--line); border-radius: 8px; line-height: 1.45; }
.sidebar-pulse svg { flex: 0 0 auto; margin-top: 2px; color: var(--accent); }
.sidebar-pulse > span { display: grid; min-width: 0; gap: 5px; }
.sidebar-pulse small { color: #929891; font-family: "Manrope Variable", sans-serif; font-size: 9px; font-weight: 760; }
.sidebar-pulse strong { font-family: "Manrope Variable", "Noto Sans SC Variable", "PingFang SC", sans-serif; font-size: 13px; font-weight: 650; }
.studio-sidebar .primary-nav { display: grid; height: auto; align-items: initial; justify-content: initial; gap: 5px; }
.studio-sidebar .primary-nav a { width: 100%; min-width: 0; height: 44px; justify-content: flex-start; padding: 0 11px; color: #62645d; border-radius: 7px; font-size: 13px; font-weight: 680; }
.studio-sidebar .primary-nav a:hover { color: var(--ink); background: #f0f0ec; }
.studio-sidebar .primary-nav a.active { color: var(--ink); background: #e9ebff; border-color: #d7dcff; box-shadow: none; }
.studio-sidebar .primary-nav a.active::after { display: none; }
.studio-sidebar .primary-nav a.active svg { color: var(--blue); }
.sidebar-footer { display: grid; margin-top: auto; }
.tour-help-button { display: flex; min-height: 40px; align-items: center; gap: 9px; padding: 0 10px; color: #555952; background: transparent; border: 1px solid transparent; border-radius: 7px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.tour-help-button:hover { color: var(--blue); background: var(--blue-soft); border-color: #d7deff; }
.studio-status { display: flex; align-items: center; gap: 9px; margin-top: auto; padding: 12px 10px; color: var(--muted); border-top: 1px solid var(--line); font-size: 12px; }
.sidebar-footer .studio-status { margin-top: 4px; }
.mobile-header-actions { display: flex; align-items: center; gap: 8px; }
.mobile-header-actions .tour-help-button { width: 36px; min-height: 36px; justify-content: center; padding: 0; }
.mobile-studio-header, .mobile-nav { display: none; }
.studio-v3 .content-shell { min-height: 100vh; }

.guide-dock {
  position: fixed;
  inset: auto 22px 22px auto;
  z-index: 80;
  display: grid;
  justify-items: end;
  gap: 10px;
  pointer-events: none;
}
.guide-dock > * { pointer-events: auto; }
.guide-dock-trigger {
  display: inline-flex;
  min-width: 126px;
  min-height: 46px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 14px;
  color: var(--ink);
  background: #ffffff;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 14px 32px rgb(24 27 36 / 22%);
  font: inherit;
  font-size: 12px;
  font-weight: 760;
  cursor: pointer;
  transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease;
}
.guide-dock-trigger svg { color: #0f5cf6; }
.guide-dock-trigger:hover { color: var(--accent); background: var(--accent-soft); border-color: #cfe0ff; transform: translateY(-1px); }
.guide-dock.is-open .guide-dock-trigger { color: #22252d; background: #ffffff; border-color: var(--line-strong); }
.guide-dock.is-open .guide-dock-trigger svg { color: var(--accent); }
.guide-dock-panel {
  width: min(380px, calc(100vw - 32px));
  overflow: hidden;
  color: var(--ink);
  background: #fffefa;
  border: 1px solid #cfd0c8;
  border-top: 4px solid var(--accent);
  border-radius: 8px;
  box-shadow: 0 24px 70px rgb(29 31 27 / 20%);
  animation: guide-dock-enter 180ms ease-out both;
}
.guide-dock-panel > header {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 13px 0 17px;
  color: var(--ink);
  background: #ffffff;
  border-bottom: 1px solid var(--line);
}
.guide-dock-panel > header > span { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: .08em; }
.guide-dock-panel > header > span svg { color: #0f5cf6; }
.guide-dock-panel > header > button { display: grid; width: 32px; height: 32px; place-items: center; padding: 0; color: var(--muted); background: transparent; border: 0; border-radius: 6px; cursor: pointer; }
.guide-dock-panel > header > button:hover { color: var(--ink); background: var(--paper-soft); }
.guide-dock-copy { padding: 19px 19px 15px; }
.guide-dock-copy h2 { margin: 0; font-family: "Manrope Variable", "Noto Sans SC Variable", "PingFang SC", sans-serif; font-size: 20px; font-weight: 700; line-height: 1.45; }
.guide-dock-copy p { margin: 7px 0 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
.guide-workflow {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0 19px;
  padding: 0;
  overflow: hidden;
  background: #f1f1ec;
  border: 1px solid #dedfd7;
  border-radius: 7px;
  list-style: none;
}
.guide-workflow li { position: relative; display: grid; min-height: 46px; place-items: center; padding: 6px; color: #777a72; border-right: 1px solid #dedfd7; border-bottom: 1px solid #dedfd7; font-size: 10px; font-weight: 740; }
.guide-workflow li:nth-child(3n) { border-right: 0; }
.guide-workflow li:nth-last-child(-n+3) { border-bottom: 0; }
.guide-workflow li::before { position: absolute; inset: 7px auto auto 7px; width: 5px; height: 5px; background: #b7bab1; border-radius: 50%; content: ""; }
.guide-workflow li.is-current { color: #263971; background: #e9edff; box-shadow: inset 0 -3px 0 var(--blue); }
.guide-workflow li.is-current::before { background: var(--blue); box-shadow: 0 0 0 3px rgb(46 94 232 / 12%); }
.guide-dock-actions { display: grid; grid-template-columns: 1.2fr 1fr; gap: 8px; padding: 15px 19px 0; }
.guide-dock-actions button { display: inline-flex; min-height: 42px; align-items: center; justify-content: center; gap: 7px; padding: 0 10px; color: #373a35; background: #ffffff; border: 1px solid #cfd0c8; border-radius: 7px; font: inherit; font-size: 11px; font-weight: 760; cursor: pointer; }
.guide-dock-actions button:hover { color: var(--blue); border-color: #aebcff; }
.guide-dock-actions .guide-action-primary { color: #ffffff; background: var(--blue); border-color: var(--blue); }
.guide-dock-actions .guide-action-primary:hover { color: #ffffff; background: var(--accent-strong); border-color: var(--accent-strong); }
.guide-dock-note { margin: 0; padding: 11px 19px 15px; color: #8b8e86; font-size: 10px; line-height: 1.55; }
@keyframes guide-dock-enter { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }

@media (min-width: 901px) and (max-height: 760px) {
  .guide-dock { inset: auto auto 14px 252px; justify-items: start; }
  .guide-dock-trigger { width: 46px; min-width: 46px; padding: 0; }
  .guide-dock-trigger span { display: none; }
}

.studio-v3 .page, .studio-v3 .today-page { width: 100%; max-width: 1600px; padding: 36px 38px 72px; }
.studio-v3 .eyebrow { color: var(--accent); font-size: 10px; letter-spacing: 0.08em; }
.studio-v3 .page-header, .studio-v3 .today-header, .studio-v3 .run-header { margin-bottom: 24px; }
.studio-v3 .page-header h1, .studio-v3 .today-header h1, .studio-v3 .run-header h1 { font-size: 34px; font-weight: 760; line-height: 1.2; }
.studio-v3 .today-header p:last-child, .studio-v3 .page-summary { max-width: 660px; margin-top: 8px; color: var(--muted); font-size: 13px; }
.studio-v3 .button { min-height: 40px; border-radius: 7px; font-size: 13px; }
.studio-v3 .button-primary { background: var(--blue); border-color: var(--blue); box-shadow: 0 7px 18px rgb(46 94 232 / 18%); }
.studio-v3 .button-primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
.studio-v3 .icon-button { border-radius: 7px; }

.studio-v3 .production-strip { min-height: 58px; margin-bottom: 14px; padding: 9px 12px; background: #ffffff; border: 1px solid var(--line); border-left: 4px solid var(--blue); border-radius: 8px; box-shadow: none; }
.studio-v3 .production-strip-review { border-left-color: var(--accent); }
.studio-v3 .production-strip-icon { color: var(--blue); background: var(--blue-soft); border-radius: 6px; }
.studio-v3 .production-strip-review .production-strip-icon { color: var(--accent); background: var(--accent-soft); }
.studio-v3 .production-strip > div span { color: var(--blue); letter-spacing: 0; }
.studio-v3 .production-strip-review > div span { color: var(--accent); }
.studio-v3 .production-strip > a { color: var(--blue); }

.studio-v3 .daily-path { margin-bottom: 14px; background: transparent; border: 0; }
.studio-v3 .daily-path-step { min-height: 62px; padding: 10px 13px; background: #ecece8; border: 0; border-right: 5px solid var(--canvas); }
.studio-v3 .daily-path-step:first-child { border-radius: 8px 0 0 8px; }
.studio-v3 .daily-path-step:last-child { border-right: 0; border-radius: 0 8px 8px 0; }
.studio-v3 .daily-path-step.is-current { background: var(--accent-soft); }
.studio-v3 .daily-path-step > span { border: 0; background: #d8d9d3; }
.studio-v3 .daily-path-step.is-current > span { color: #ffffff; background: var(--accent); }
.studio-v3 .daily-path-step.is-complete > span { background: var(--green); }

.studio-v3 .director-workspace { display: grid; min-height: 690px; grid-template-columns: 280px minmax(440px, 1fr) 290px; gap: 12px; overflow: visible; background: transparent; border: 0; border-radius: 0; box-shadow: none; }
.studio-v3 .opportunity-rail, .studio-v3 .opportunity-focus, .studio-v3 .director-panel { min-width: 0; overflow: hidden; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 10px 26px rgb(25 26 22 / 5%); }
.studio-v3 .opportunity-rail { color: var(--ink); }
.studio-v3 .panel-heading { padding: 18px; }
.studio-v3 .panel-heading span { color: var(--muted); font-size: 10px; letter-spacing: 0.08em; }
.studio-v3 .panel-heading h2 { font-size: 16px; }
.studio-v3 .opportunity-rail .icon-button { color: var(--blue); background: var(--blue-soft); border-color: #d8e0ff; }
```

### Original lines 505-535

```
  .studio-v3 .template-restore-panel > div:last-child { justify-content: stretch; }
  .studio-v3 .template-restore-panel .button { width: 100%; }
  .studio-v3 .template-editor-grid { grid-template-columns: 1fr; }
  .studio-v3 .template-editor-copy { border-right: 0; border-bottom: 1px solid var(--line); }
  .studio-v3 .template-system-fields { grid-template-columns: 1fr; }
  .studio-v3 .template-beat-editor { grid-template-columns: 26px minmax(0, 1fr); }
  .studio-v3 .template-beat-editor > label:last-of-type { grid-column: 2; }
  .studio-v3 .template-shot-slots { grid-column: 2; }
  .studio-v3 .template-shot-slot { grid-template-columns: 1fr; }
  .studio-v3 .template-editor-actions { align-items: stretch; flex-direction: column; }
  .studio-v3 .template-editor-actions > span { margin: 0 0 3px; }
  .studio-v3 .resource-manifest-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .studio-v3 .resource-manifest-ledger > article { grid-template-columns: 48px minmax(0, 1fr) 56px; }
  .studio-v3 .resource-manifest-ledger > article > :last-child { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}

/* Loop 19: editorial topic inbox */
.studio-v3 .topic-entry-workspace { min-width: 0; margin: 22px 0 30px; overflow: hidden; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 16px 42px rgb(25 26 22 / 6%); }
.studio-v3 .topic-entry-header { display: flex; min-height: 74px; align-items: center; justify-content: space-between; gap: 20px; padding: 15px 20px; border-bottom: 1px solid var(--line); }
.studio-v3 .topic-entry-header h2 { margin: 2px 0 0; font-family: "Manrope Variable", "Noto Sans SC Variable", "PingFang SC", sans-serif; font-size: 20px; font-weight: 720; }
.studio-v3 .topic-entry-header > span { color: #6c7069; font-size: 11px; font-weight: 760; }
.studio-v3 .topic-entry-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 7px; gap: 5px; background: #eeefeb; border-bottom: 1px solid var(--line); }
.studio-v3 .topic-entry-tabs > button { display: grid; min-width: 0; min-height: 60px; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 9px; padding: 8px 12px; color: #6e716b; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.studio-v3 .topic-entry-tabs > button > svg { padding: 8px; box-sizing: content-box; color: #72766f; background: #dedfd9; border-radius: 5px; }
.studio-v3 .topic-entry-tabs > button > span { display: grid; min-width: 0; gap: 2px; }
.studio-v3 .topic-entry-tabs strong { color: #393c38; font-size: 13px; }
.studio-v3 .topic-entry-tabs small { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
```

## apps/studio/src/client/studio-cplus.css

SHA256: 5bec83598cb4dcd5b4dc74f5ba6a06cf07f67ebf4354de5478f8c572e1588c7c; 3080 lines. OMITTED: 181-349, 426-569, 636-1269, 1456-1679, 1746-1817, 1834-1979, 2056-2885, 3080-3080.

### Original lines 1-180

```
/*
 * Light Curated Studio: a quiet, cool-neutral workspace where the work stays visual.
 * Hierarchy comes from rhythm, space and type; color only marks intent or state.
 */
:root {
  color-scheme: light;
  --canvas: #f5f7fa;
  --paper: #ffffff;
  --paper-soft: #f8fafc;
  --ink: #273247;
  --muted: #667085;
  --faint: #98a2b3;
  --line: #e1e6ed;
  --line-strong: #cfd7e3;
  --rail: #fbfcfe;
  --accent: #0f5cf6;
  --action: #0f5cf6;
  --accent-strong: #0948c8;
  --accent-soft: #edf4ff;
  --blue: #0f5cf6;
  --blue-soft: #edf4ff;
  --green: #178765;
  --green-soft: #edf8f4;
  --yellow: #956515;
  --yellow-soft: #fff7e6;
  --red: #c44747;
  --red-soft: #fff1f1;
  --surface-subtle: #f8fafc;
  --surface-pressed: #eef3f8;
  --shadow: 0 10px 28px rgb(23 32 51 / 6%);
  --shadow-raised: 0 18px 42px rgb(23 32 51 / 9%);
}

.studio-v3 .stock-source-research { margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper-soft); font-size: 13px; line-height: 1.8; }
.studio-v3 .stock-source-research summary { cursor: pointer; font-weight: 650; color: var(--ink); }
.studio-v3 .stock-source-research p { color: var(--muted); }
.studio-v3 .stock-source-research li { margin-block: 8px; }
.studio-v3 .stock-source-research a, .studio-v3 .asset-provider a { color: var(--accent); text-underline-offset: 3px; }

/* 制作可观测性：以阶段和当前动作组织信息，避免把内部节点平铺给创作者。 */
.studio-v3 .production-progress {
  margin: 18px 0 22px;
  padding: 17px 20px 19px;
  color: #26303d;
  background: #ffffff;
  border: 1px solid #dde2e8;
  border-radius: 8px;
  box-shadow: 0 12px 32px rgb(31 38 49 / 6%);
}

.studio-v3 .production-progress > header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
}

.studio-v3 .production-progress > header > div { display: grid; gap: 3px; }
.studio-v3 .production-progress > header .eyebrow { margin: 0; color: #0948c8; }
.studio-v3 .production-progress > header strong { font-size: 13px; }
.studio-v3 .production-progress > header > span { color: #0948c8; font-size: 20px; font-weight: 760; }

.studio-v3 .production-progress-bar {
  height: 3px;
  margin: 12px 0 17px;
  overflow: hidden;
  background: #eceef2;
  border-radius: 3px;
}

.studio-v3 .production-progress-bar > span {
  display: block;
  height: 100%;
  background: #0f5cf6;
  border-radius: inherit;
  transition: width 420ms cubic-bezier(.2, .75, .25, 1);
}

.studio-v3 .production-phases {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0;
}

.studio-v3 .production-phase {
  position: relative;
  display: grid;
  min-width: 0;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  padding-right: 18px;
}

.studio-v3 .production-phase:not(:last-child)::after {
  position: absolute;
  z-index: 0;
  top: 14px;
  right: 4px;
  width: 10px;
  height: 1px;
  background: #d9dde4;
  content: "";
}

.studio-v3 .production-phase-index {
  position: relative;
  z-index: 1;
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  color: #858c96;
  background: #f0f2f5;
  border: 1px solid #e0e4e9;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 800;
}

.studio-v3 .production-phase > div { display: grid; min-width: 0; gap: 2px; }
.studio-v3 .production-phase strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.studio-v3 .production-phase small { color: #8a919b; font-size: 10px; }
.studio-v3 .production-phase.is-completed .production-phase-index { color: #ffffff; background: #278d72; border-color: #278d72; }
.studio-v3 .production-phase.is-running .production-phase-index { color: #ffffff; background: #0f5cf6; border-color: #0f5cf6; box-shadow: 0 0 0 5px rgb(15 92 246 / 10%); }
.studio-v3 .production-phase.is-attention .production-phase-index { color: #6f4e08; background: #f5ce6b; border-color: #e1b84f; }
.studio-v3 .production-phase.is-failed .production-phase-index { color: #ffffff; background: #c95852; border-color: #c95852; }

.studio-v3 .run-live-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
  padding-top: 2px;
  color: #666e79;
  font-size: 11px;
}

.studio-v3 .run-live-metrics > span { display: inline-flex; align-items: center; gap: 6px; }
.studio-v3 .run-live-metrics svg { color: #0948c8; }
.studio-v3 .run-live-metrics strong { color: #2f3742; }
.studio-v3 .run-connection-live i { width: 6px; height: 6px; background: #2c9a7d; border-radius: 50%; box-shadow: 0 0 0 4px rgb(44 154 125 / 10%); }
.studio-v3 .current-production-action > .run-active-provider { margin-top: -6px; color: #6f7580; font-size: 10px; }
.studio-v3 .current-decision-bar { margin: 0 0 14px; padding: 16px 18px; border: 1px solid #c7d8ef; border-radius: 10px; background: #f5f8fc; }
.studio-v3 .current-decision-bar.is-incomplete { border-color: #e6c98a; background: #fffaf0; }
.studio-v3 .current-decision-bar.is-hard-stop { border-color: #e1b5ab; background: #fff6f3; }
.studio-v3 .current-decision-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.studio-v3 .current-decision-heading h2 { margin: 0; font-size: 18px; line-height: 1.35; }
.studio-v3 .current-decision-heading .eyebrow { margin: 0 0 4px; }
.studio-v3 .current-decision-status { flex: 0 0 auto; padding: 4px 8px; border-radius: 999px; color: #385d8c; background: #e6effb; font-size: 11px; font-weight: 740; }
.studio-v3 .current-decision-bar p:not(.eyebrow) { max-width: 760px; margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
.studio-v3 .current-decision-bar dl { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 12px 0 0; }
.studio-v3 .current-decision-bar dl div { display: grid; gap: 2px; min-width: 150px; }
.studio-v3 .current-decision-bar dt { color: var(--muted); font-size: 10px; }
.studio-v3 .current-decision-bar dd { margin: 0; color: var(--ink); font-size: 11px; font-weight: 650; }

.studio-v3 .run-state-panel.has-failure { display: grid; gap: 11px; }
.studio-v3 .run-state-panel.has-failure > .eyebrow { margin: 0; color: #bd4f48; }
.studio-v3 .run-state-panel.has-failure h2 { font-size: 18px; }
.studio-v3 .run-state-panel .run-failure-summary { margin: 0; color: #4c515a; font-size: 12px; font-weight: 650; line-height: 1.65; }
.studio-v3 .run-failure-breakdown { display: grid; gap: 8px; padding: 12px; background: #fff8f0; border: 1px solid #edd9c3; border-radius: 6px; }
.studio-v3 .run-failure-breakdown strong { color: #7e4d22; font-size: 11px; }
.studio-v3 .run-failure-breakdown ul { display: grid; gap: 6px; margin: 0; padding-left: 18px; color: #57504a; font-size: 11px; line-height: 1.55; }
.studio-v3 .run-failure-impact { display: grid; gap: 4px; padding: 11px 12px; background: #f2f7f4; border-left: 3px solid #2f987d; }
.studio-v3 .run-failure-impact strong { color: #27715f; font-size: 11px; }
.studio-v3 .run-failure-impact span { color: #5e6b67; font-size: 11px; line-height: 1.55; }
.studio-v3 .run-saved-work { margin: 0; color: #69717d; font-size: 10px; }
.studio-v3 .run-recovery-list { display: grid; gap: 5px; margin: 0; padding-left: 18px; color: #525966; font-size: 11px; line-height: 1.55; }
.studio-v3 .task-recovery-panel { display: grid; gap: 8px; padding: 12px; border: 1px solid #d8cfae; border-radius: 10px; background: #fffaf0; }
.studio-v3 .task-recovery-panel > p { margin: 0; color: #525966; font-size: 12px; line-height: 1.6; }
.studio-v3 .task-recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 520px) {
  .studio-v3 .task-recovery-actions { display: grid; grid-template-columns: 1fr; }
}
.studio-v3 .run-technical-diagnosis { color: #727986; font-size: 10px; }
.studio-v3 .run-technical-diagnosis summary { width: fit-content; cursor: pointer; font-weight: 700; }
.studio-v3 .run-technical-diagnosis code { display: block; margin-top: 7px; padding: 9px; overflow-wrap: anywhere; color: #69707b; background: #f3f4f6; border-radius: 4px; line-height: 1.55; }
.studio-v3 .paid-operation-panel { display: grid; gap: 12px; margin-block: 4px 12px; padding-block: 14px 0; border-top: 1px solid #dce5f5; }
.studio-v3 .paid-operation-panel.requires-manual { border-color: #efd9b2; }
.studio-v3 .paid-operation-panel > header, .studio-v3 .paid-operation-items article > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.studio-v3 .paid-operation-panel > header strong { color: #284978; font-size: 13px; }
```

### Original lines 350-425

```
.studio-account-identity small { color: #858b96; font-size: 10px; }
.studio-account-identity strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.studio-account-popover [role="menuitem"] { width: 100%; min-height: 36px; display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 0 9px; color: #a33e37; text-align: left; background: transparent; border: 0; border-radius: 5px; cursor: pointer; }
.studio-account-popover [role="menuitem"]:hover { background: #edf4ff; }
.studio-account-popover [role="menuitem"]:disabled { cursor: wait; opacity: 0.65; }
.studio-account-compact .studio-account-popover { inset: calc(100% + 8px) 0 auto auto; }

.studio-topbar {
  position: fixed;
  inset: 0 0 auto 244px;
  z-index: 35;
  height: 66px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 0 34px;
  background: rgb(250 251 252 / 90%);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(18px);
}
.studio-search-trigger {
  width: min(520px, 50vw);
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  color: #777f8d;
  text-align: left;
  background: #ffffff;
  border: 1px solid #dfe3e8;
  border-radius: 7px;
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease;
}
.studio-search-trigger:hover { color: var(--ink); background: #ffffff; border-color: #cfe0ff; }
.studio-search-trigger span { overflow: hidden; flex: 1; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.studio-search-trigger kbd { padding: 2px 7px; color: #757b86; background: #f1f2f4; border: 1px solid #d9dde2; border-radius: 4px; font: 700 10px/1.5 "Manrope Variable", sans-serif; }
.studio-topbar-context { display: flex; align-items: center; gap: 9px; color: #8e9cb3; font-size: 11px; }
.studio-search-backdrop { position: fixed; inset: 0; z-index: 120; display: grid; align-items: start; justify-items: center; padding: min(15vh, 126px) 18px 18px; background: rgb(1 6 17 / 72%); backdrop-filter: blur(10px); }
.studio-search-dialog { width: min(680px, 100%); overflow: hidden; color: var(--ink); background: #ffffff; border: 1px solid #d9dde3; border-radius: 8px; box-shadow: 0 34px 90px rgb(25 28 36 / 24%); animation: studio-search-enter 180ms cubic-bezier(.2, .8, .2, 1) both; }
.studio-search-field { min-height: 58px; display: grid; grid-template-columns: 22px minmax(0, 1fr) 34px; align-items: center; gap: 9px; padding: 0 13px 0 18px; border-bottom: 1px solid var(--line); }
.studio-search-field > svg { color: #8da0c0; }
.studio-search-field input { width: 100%; color: var(--ink); background: transparent; border: 0; outline: 0; font-size: 15px; }
.studio-search-field input::placeholder { color: #667691; }
.studio-search-field button { width: 32px; height: 32px; display: grid; place-items: center; color: #8b99af; background: transparent; border: 0; border-radius: 5px; cursor: pointer; }
.studio-search-field button:hover { color: var(--ink); background: #f2f3f5; }
.studio-search-results { max-height: min(62vh, 520px); overflow-y: auto; padding: 10px; }
.studio-search-results > p { margin: 10px 10px 6px; color: #6f7f99; font-size: 10px; font-weight: 800; text-transform: uppercase; }
.studio-search-results > a { min-height: 52px; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 11px; padding: 7px 10px; color: var(--ink); border: 1px solid transparent; border-radius: 6px; text-decoration: none; }
.studio-search-results > a:hover { background: #edf4ff; border-color: #cfe0ff; }
.studio-search-results > a > span { width: 32px; height: 32px; display: grid; place-items: center; color: #0948c8; background: var(--accent-soft); border-radius: 6px; }
.studio-search-results strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.studio-search-results small { max-width: 230px; overflow: hidden; color: #8391a8; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.studio-search-empty { padding: 34px 16px; color: var(--muted); text-align: center; font-size: 12px; }

.studio-v3 .page,
.studio-v3 .today-page,
.studio-v3 .cases-page,
.studio-v3 .home-page {
  max-width: 1580px;
  padding: 42px 44px 84px;
}

/* The first screen is a decision surface, not a compressed version of the whole product. */
.studio-v3 .home-page {
  width: min(100%, 1320px);
  margin: 0 auto;
}
.studio-v3 .home-intro {
  min-height: 154px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 36px;
```

### Original lines 570-635

```
.studio-v3 .asset-work-toggle { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 0; color: inherit; background: transparent; border: 0; text-align: left; cursor: pointer; }
.studio-v3 .asset-work-toggle > svg { flex: 0 0 auto; color: var(--muted); transition: transform 160ms ease; }
.studio-v3 .asset-work-toggle[aria-expanded="true"] > svg { transform: rotate(180deg); }
.studio-v3 .asset-work-toggle > div { min-width: 0; }
.studio-v3 .asset-card { min-width: 0; overflow: hidden; background: #ffffff; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); transition: border-color 190ms ease, transform 190ms cubic-bezier(.2, .75, .2, 1), box-shadow 190ms ease; animation: studio-surface-enter 360ms cubic-bezier(.22, .8, .24, 1) backwards; }
.studio-v3 .asset-card:hover { border-color: #cfe0ff; box-shadow: var(--shadow-raised); transform: translateY(-2px); }
.studio-v3 .asset-card-preview { position: relative; min-height: 210px; aspect-ratio: 16 / 10; display: grid; align-content: center; justify-items: center; gap: 8px; overflow: hidden; color: #737b85; background: #eef1f3; border-bottom: 1px solid var(--line); font-size: 10px; }
.studio-v3 .asset-card-preview.is-video,
.studio-v3 .asset-card-preview.is-image,
.studio-v3 .asset-card-preview.is-audio,
.studio-v3 .asset-card-preview.is-document { color: #64748b; background: #eef2f7; }
.studio-v3 .asset-card-preview video,
.studio-v3 .asset-card-preview img { width: 100%; height: 100%; min-height: 210px; object-fit: contain; background: #eef0f2; }
.studio-v3 .asset-card-preview audio { width: calc(100% - 28px); margin-top: 18px; }
.studio-v3 .asset-card-copy { min-width: 0; display: flex; flex-direction: column; min-height: 210px; padding: 15px; }
.studio-v3 .asset-card-copy header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.studio-v3 .asset-card-copy header > span { color: #8e9eb5; font-size: 9px; font-weight: 800; }
.studio-v3 .asset-card-copy header b { color: #98a5b8; font-size: 9px; font-weight: 750; }
.studio-v3 .asset-card-copy header b.reuse-ready { color: var(--green); }
.studio-v3 .asset-card-copy header b.reuse-review_required { color: var(--yellow); }
.studio-v3 .asset-card-copy header b.reuse-private { color: var(--muted); }
.studio-v3 .asset-card-copy h3 { display: -webkit-box; overflow: hidden; margin: 13px 0 5px; font-family: "Noto Sans SC Variable", "PingFang SC", sans-serif; font-size: 14px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.studio-v3 .asset-provider { overflow: hidden; margin: 0; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.studio-v3 .asset-metadata { display: flex; flex-wrap: wrap; gap: 5px; margin: 12px 0 0; padding: 0; list-style: none; }
.studio-v3 .asset-metadata li { padding: 3px 6px; color: #69717d; background: #f0f2f4; border-radius: 4px; font-size: 9px; }
.studio-v3 .asset-tags { display: flex; gap: 5px; margin-top: 8px; overflow: hidden; }
.studio-v3 .asset-tags span { flex: 0 0 auto; color: #7e8ea7; font-size: 9px; }
.studio-v3 .asset-tags span::before { content: "#"; color: var(--faint); }
.studio-v3 .asset-card-copy footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 15px; color: #78879d; font-size: 9px; }
.studio-v3 .asset-card-copy footer > div { display: flex; align-items: center; gap: 10px; }
.studio-v3 .asset-card-copy footer a { display: inline-flex; align-items: center; gap: 4px; color: #a9b7d0; font-size: 10px; font-weight: 700; text-decoration: none; }
.studio-v3 .asset-card-copy footer a:hover { color: var(--accent); }
.studio-v3 .asset-library-empty { min-height: 260px; display: grid; place-items: center; align-content: center; gap: 9px; color: var(--muted); background: var(--paper); border: 1px dashed var(--line-strong); border-radius: 8px; font-size: 11px; }
.studio-v3 .asset-library-empty strong { color: var(--ink); font-size: 14px; }

.content-shell > main {
  animation: studio-page-enter 380ms cubic-bezier(.22, .8, .24, 1) backwards;
}

.content-shell > main > :is(.page-header, .today-header, .run-header, .production-strip, .topic-entry-workspace, .project-edition, .project-archive, .resource-masthead, .configuration-index, .template-gallery, .template-experiments, .current-production-action, .review-layout, .role-workspaces) {
  animation: studio-surface-enter 440ms cubic-bezier(.22, .8, .24, 1) backwards;
}

.content-shell > main > :nth-child(2) { animation-delay: 40ms; }
.content-shell > main > :nth-child(3) { animation-delay: 80ms; }
.content-shell > main > :nth-child(4) { animation-delay: 120ms; }

.studio-v3 .page-header,
.studio-v3 .today-header,
.studio-v3 .run-header {
  min-height: 82px;
  align-items: center;
  margin-bottom: 28px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line-strong);
}

.studio-v3 .eyebrow {
  margin-bottom: 9px;
  color: var(--accent);
  font-size: 11px;
  letter-spacing: 0;
}

.studio-v3 .page-header h1,
.studio-v3 .today-header h1,
```

### Original lines 1270-1455

```
.studio-v3 .cost-call-details > summary::-webkit-details-marker { display: none; }
.studio-v3 .cost-call-details > summary span { display: grid; gap: 3px; }
.studio-v3 .cost-call-details > summary strong { font-size: 13px; }
.studio-v3 .cost-call-details > summary small { color: var(--muted); font-size: 11px; }
.studio-v3 .cost-call-details > summary > b { color: var(--yellow); font-size: 12px; }
.guide-dock-panel > header > span,
.guide-workflow li,
.guide-dock-note { font-size: 11px; }

@keyframes studio-page-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes studio-surface-enter {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes studio-progress {
  from { transform: translateX(-110%); }
  to { transform: translateX(440%); }
}

@keyframes studio-search-enter {
  from { opacity: 0; transform: translateY(-10px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 1360px) {
  .studio-v3 .director-workspace { grid-template-columns: 258px minmax(420px, 1fr); }
}

@media (max-width: 1080px) {
  .studio-v3 .asset-library-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .studio-v3 .production-archive { grid-template-columns: 1fr; }
  .studio-v3 .review-layout { grid-template-columns: minmax(420px, 1fr) 300px; }
}

@media (min-width: 901px) and (max-height: 760px) {
  .guide-dock { right: 22px; bottom: 22px; left: auto; justify-items: end; }
  .guide-dock-trigger { width: 46px; min-width: 46px; padding: 0; }
  .guide-dock-trigger span { display: none; }
}

@media (max-width: 900px) {
  .studio-v3 { padding-left: 88px; }
  .studio-sidebar { width: 88px; }
  .studio-topbar { left: 88px; }
  .studio-v3 .page,
  .studio-v3 .today-page,
  .studio-v3 .cases-page,
  .studio-v3 .home-page { padding-inline: 26px; }
  .studio-v3 .director-workspace { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 700px) {
  .studio-v3 { padding: 0 0 72px; }
  .studio-topbar { display: none; }
  .mobile-studio-header { color: var(--ink); background: rgb(251 251 251 / 96%); border-bottom-color: var(--line); backdrop-filter: blur(16px); }
  .mobile-studio-header .brand { color: var(--ink); }
  .mobile-studio-header .tour-help-button { color: var(--muted); }
  .mobile-nav { background: rgb(251 251 251 / 96%); border-top-color: var(--line); }
  .mobile-nav a { color: var(--muted); }
  .mobile-nav a.active { color: #0948c8; }
  .studio-search-backdrop { align-items: start; padding-top: 70px; }
  .studio-search-results small { max-width: 120px; }
  .studio-v3 .page,
  .studio-v3 .today-page,
  .studio-v3 .cases-page,
  .studio-v3 .home-page { padding: 24px 14px 32px; }
  .studio-v3 .home-intro { min-height: 0; display: block; padding: 6px 0 22px; }
  .studio-v3 .home-intro h1 { font-size: 30px; }
  .studio-v3 .home-intro p:last-child { font-size: 12px; }
  .studio-v3 .home-intro time { display: block; margin-top: 14px; }
  .studio-v3 .home-continuation { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 15px; }
  .studio-v3 .home-continuation > .home-section-number,
  .studio-v3 .home-continuation video,
  .studio-v3 .home-continuation .home-run-mark { display: none; }
  .studio-v3 .home-continuation-copy h2 { display: -webkit-box; font-size: 17px; line-height: 1.35; text-overflow: clip; white-space: normal; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .studio-v3 .home-continuation-copy > div span:last-child { display: none; }
  .studio-v3 .home-continuation .button { padding-inline: 12px; }
  .studio-v3 .home-start { margin-top: 42px; }
  .studio-v3 .home-start-options { grid-template-columns: 1fr; }
  .studio-v3 .home-start-options > button { min-height: 94px; border-right: 0; border-bottom: 1px solid var(--line); }
  .studio-v3 .home-start-options > button:last-child { border-bottom: 0; }
  .studio-v3 .home-recommendations { margin-top: 44px; }
  .studio-v3 .home-recommendations > header > a { width: 36px; height: 36px; overflow: hidden; white-space: nowrap; }
  .studio-v3 .home-recommendations > header > a svg { flex: 0 0 auto; margin-left: 10px; }
  .studio-v3 .home-recommendation-list > a { grid-template-columns: 28px minmax(0, 1fr) 18px; gap: 10px; }
  .studio-v3 .home-recommendation-list b { display: none; }
  .studio-v3 .asset-library-header { align-items: flex-start; }
  .studio-v3 .asset-library-count { display: none; }
  .studio-v3 .asset-index-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .studio-v3 .asset-index-summary > div { min-width: 0; display: grid; justify-items: center; gap: 5px; text-align: center; }
  .studio-v3 .asset-index-summary > div + div { margin-left: 0; padding-left: 0; }
  .studio-v3 .asset-index-summary span { display: grid; justify-items: center; gap: 2px; line-height: 1.35; }
  .studio-v3 .asset-library-filters { flex-wrap: wrap; overflow-x: visible; }
  .studio-v3 .asset-library-filters button { flex: 1 1 auto; justify-content: center; }
  .studio-v3 .asset-library-refiners { grid-template-columns: 1fr; }
  .studio-v3 .asset-library-organizers { align-items: stretch; flex-direction: column; }
  .studio-v3 .asset-library-sections,
  .studio-v3 .asset-library-view { width: 100%; }
  .studio-v3 .asset-library-sections button,
  .studio-v3 .asset-library-view button { flex: 1; }
  .studio-v3 .asset-library-search { min-width: 0; }
  .studio-v3 .asset-library-grid { grid-template-columns: 1fr; }
  .studio-v3 .node-expert-grid,
  .studio-v3 .run-technical-files > div { grid-template-columns: 1fr; }
  .studio-v3 .page-header,
  .studio-v3 .today-header,
  .studio-v3 .run-header { min-height: 0; align-items: flex-start; padding-bottom: 16px; }
  .studio-v3 .page-header h1,
  .studio-v3 .today-header h1,
  .studio-v3 .run-header h1 { font-size: 29px; }
  .studio-v3 .today-header p:last-child,
  .studio-v3 .page-summary { font-size: 12px; }
  .studio-v3 .production-strip { grid-template-columns: auto minmax(0, 1fr) auto; min-height: 76px; }
  .studio-v3 .production-strip > small { display: none; }
  .studio-v3 .production-strip-preview { width: 36px; height: 54px; }
  .studio-v3 .topic-entry-header { min-height: 72px; padding-inline: 15px; }
  .studio-v3 .topic-entry-header h2 { font-size: 19px; }
  .studio-v3 .director-workspace { grid-template-columns: 1fr; }
  .studio-v3 .project-edition { margin-bottom: 28px; }
  .studio-v3 .project-controls { align-items: stretch; flex-direction: column; padding-block: 10px; }
  .studio-v3 .project-search { width: 100%; }
  .studio-v3 .production-archive { gap: 10px; }
  .studio-v3 .project-folio,
  .studio-v3 .project-folio:nth-child(2n) {
    min-height: 204px;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 13px;
    padding: 12px;
  }
  .studio-v3 .project-preview { width: 96px; }
  .studio-v3 .project-folio h3 { font-size: 15px; line-height: 1.48; }
  .studio-v3 .configuration-index { top: 68px; margin-bottom: 34px; overflow-x: auto; }
  .studio-v3 .configuration-index a { flex: 0 0 auto; }
  .studio-v3 .resource-section,
  .studio-v3 .resource-voice-studio { margin-top: 48px; }
  .studio-v3 .resource-heading h2 { font-size: 22px; }
  .studio-v3 .node-workspace > summary { min-height: 68px; }
  .studio-v3 .node-workspace-body { padding: 13px; }
  .studio-v3 .node-input-sources > header,
  .studio-v3 .node-input-sources article { align-items: stretch; flex-direction: column; }
  .studio-v3 .node-input-sources > header small { text-align: left; }
  .studio-v3 .node-input-sources article .button { width: 100%; }
  .studio-v3 .node-output-preview pre,
  .studio-v3 .node-output-preview textarea { font-size: 11px; }
  .studio-v3 .project-filters button,
  .studio-v3 .node-workspace-tabs button,
  .studio-v3 .node-editor-mode button,
  .studio-v3 .provider-default { min-height: 44px; }
  .guide-dock > .guide-dock-trigger { display: none; }
  .studio-v3 .review-layout { grid-template-columns: 1fr; margin-bottom: 34px; }
  .studio-v3 .review-panel { position: static; }
  .studio-v3 .video-frame { min-height: 470px; }
  .studio-v3 .video-frame video { width: min(100%, calc(52vh * 9 / 16)); max-height: 52vh; }
  .studio-v3 .template-card { grid-template-columns: 58px minmax(0, 1fr); }
  .studio-v3 .template-art { width: 58px; height: 88px; }
}

@media (prefers-reduced-motion: reduce) {
  .content-shell > main,
  .content-shell > main > *,
  .studio-v3 .production-strip::after,
  .health-dot,
  .studio-v3 .project-folio,
  .studio-v3 .opportunity-card,
  .studio-sidebar .primary-nav a,
  .studio-v3 .asset-candidate-strip figure,
  .studio-v3 .topic-mode-tab,
  .studio-search-dialog { animation: none !important; transform: none !important; transition-duration: 0.01ms !important; }
}
.studio-v3 .project-folio-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.studio-v3 .project-load-more { width: 100%; min-height: 48px; margin-top: 16px; color: var(--muted); background: var(--paper); border: 1px solid var(--line); border-radius: 6px; font-weight: 700; cursor: pointer; transition: color 160ms ease, border-color 160ms ease, transform 160ms ease; }
.studio-v3 .project-load-more:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-2px); }
.studio-v3 .candidate-score { width: 54px; height: 44px; align-content: center; gap: 1px; line-height: 1; }
.studio-v3 .candidate-score small { font-size: 8px; font-weight: 650; }
/* 建议性提示：要看得见，但不能长得像阻断错误，否则又会读成"不许开工"。 */
.studio-v3 .candidate-advisory { margin: 0; color: #825f1b; font-size: 11px; line-height: 1.6; }
.studio-v3 .candidate-audit-advice { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 12px; padding: 9px 11px; color: #825f1b; background: #fdf7e7; border: 1px solid #efe0b8; border-radius: 5px; font-size: 11px; line-height: 1.6; }
.studio-v3 .candidate-audit-advice svg { flex: 0 0 auto; margin-top: 1px; }
.studio-v3 .director-topic-advice { margin: 0 0 10px; padding: 8px 10px; color: #825f1b; background: #fdf7e7; border: 1px solid #efe0b8; border-radius: 5px; font-size: 11px; line-height: 1.6; }
.studio-v3 .candidate-detail > header > strong { width: 64px; height: 54px; align-content: center; gap: 2px; line-height: 1; }
.studio-v3 .candidate-detail > header > strong small { font-family: "Noto Sans SC Variable", sans-serif; font-size: 8px; font-weight: 650; }
```

### Original lines 1680-1745

```
.studio-v3 .asset-library-view { background: #f8f9fa; border-color: #dfe3e8; }
.studio-v3 .asset-library-filters button:hover { color: var(--ink); background: #f2f3f5; }
.studio-v3 .asset-library-filters button[aria-pressed="true"] { color: #0948c8; background: var(--accent-soft); border-color: #cfe0ff; }
.studio-v3 .asset-library-filters button span { color: #737a86; background: #eceef1; }
.studio-v3 .asset-library-search,
.studio-v3 .project-search {
  color: #7c838e;
  background: #f8f9fa;
  border-color: #dfe3e8;
}
.studio-v3 .asset-library-search input { color: var(--ink); }
.studio-v3 .asset-card-preview { border-right-color: #e2e4e8; }
.studio-v3 .asset-card-preview.is-visual,
.studio-v3 .asset-card-preview.is-voice,
.studio-v3 .asset-card-preview.is-document { color: #5d6671; background: #eef1f3; }
.studio-v3 .asset-card-copy header > span,
.studio-v3 .asset-card-copy p,
.studio-v3 .asset-card-copy footer a { color: var(--muted); }

.studio-v3 .button-primary { background: var(--accent); border-color: var(--accent); box-shadow: 0 8px 20px rgb(15 92 246 / 15%); }
.studio-v3 .button-primary:hover:not(:disabled) { background: var(--accent-strong); border-color: var(--accent-strong); }
.studio-v3 .button-secondary { color: var(--ink); background: #ffffff; border-color: #d8dce2; }
.studio-v3 .button-ghost { color: #626a76; background: transparent; border-color: #d8dce2; }
.studio-v3 .button-secondary:hover:not(:disabled) { border-color: #cfe0ff; box-shadow: 0 6px 16px rgb(31 38 49 / 7%); }
.studio-v3 .button-danger-ghost { color: #b64540; background: #fff8f7; border-color: #cfd7e3; }

.studio-v3 .daily-path-step { background: #ffffff; border: 1px solid #e1e4e9; }
.studio-v3 .daily-path-step.is-current { background: var(--accent-soft); border-color: #cfe0ff; }
.studio-v3 .topic-entry-workspace,
.studio-v3 .opportunity-rail,
.studio-v3 .opportunity-focus,
.studio-v3 .director-panel,
.studio-v3 .template-editor,
.studio-v3 .run-artifact-section { background: #ffffff; border-color: #e0e3e8; box-shadow: var(--shadow); }
.studio-v3 .creative-stage { background: #f1f3f6; }
.studio-v3 .director-panel { background: #ffffff; }

.studio-v3 .resource-masthead { background: #ffffff; border: 1px solid #e0e3e8; box-shadow: var(--shadow); }
.studio-v3 .resource-masthead > div { color: var(--ink); border-color: #e1e4e8; }
.studio-v3 .resource-masthead span { color: var(--muted); }
.studio-v3 .resource-budget { color: var(--ink); background: #ffffff; }
.studio-v3 .resource-budget svg { color: var(--accent); }
.studio-v3 .resource-budget span { color: var(--muted); }
.studio-v3 .resource-budget strong { color: var(--ink); }
.studio-v3 .configuration-index a:hover { color: #0948c8; background: #edf4ff; }
.studio-v3 .configuration-index a[aria-current="page"] { color: #0948c8; background: var(--accent-soft); box-shadow: inset 0 -2px var(--accent); }
.studio-v3 .resources-page > [data-resource-section] { display: none; }
.studio-v3 .resources-page > [data-resource-section][data-active="true"] {
  display: block;
  animation: resource-section-reveal 220ms ease-out both;
}
.studio-v3 .configuration-intro { color: var(--ink); background: #f8fafc; box-shadow: inset 0 1px #ffffff; }
.studio-v3 .configuration-intro > svg { color: var(--accent); }
.studio-v3 .configuration-intro p { color: var(--muted); }
.studio-v3 .configuration-intro small { color: var(--green); }
.studio-v3 .voice-direction { background: #ffffff; border-top-color: var(--accent); }
.studio-v3 .voice-preset-picker { display: grid; gap: 10px; }
.studio-v3 .voice-preset-picker > header { display: grid; gap: 3px; }
.studio-v3 .voice-preset-picker > header strong { font-size: 12px; }
.studio-v3 .voice-preset-picker > header small { color: var(--muted); font-size: 10px; line-height: 1.5; }
.studio-v3 .voice-preset-picker > div { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.studio-v3 .voice-preset-picker button { display: grid; gap: 3px; padding: 10px; color: var(--ink); background: #f8f9fa; border: 1px solid var(--line); border-radius: 6px; text-align: left; cursor: pointer; }
.studio-v3 .voice-preset-picker button[aria-pressed="true"] { color: #0948c8; background: var(--accent-soft); border-color: #b9cffb; }
.studio-v3 .voice-preset-picker button strong { font-size: 11px; }
.studio-v3 .voice-preset-picker button small { color: var(--muted); font-size: 9px; line-height: 1.4; }
.studio-v3 .voice-advanced-toggle { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; padding: 9px 0; color: var(--ink); background: transparent; border: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: left; cursor: pointer; }
```

### Original lines 1818-1833

```
.studio-v3 .agent-review-decision .agent-review-guidance { border-top-color: #ead8aa; color: #766b55; }

.content-shell > main { animation-duration: 300ms; }
.content-shell > main > :is(.page-header, .today-header, .run-header, .production-strip, .topic-entry-workspace, .project-edition, .project-archive, .resource-masthead, .configuration-index, .template-gallery, .template-experiments, .current-production-action, .review-layout, .role-workspaces) { animation-duration: 360ms; }

@keyframes resource-section-reveal {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 制作档案：主视图保持轻量，历史项目进入独立归档层。 */
.studio-v3 .queue-view-switch {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
```

### Original lines 1980-2055

```
  .studio-v3 .home-start-options > button:last-child { border-color: #e0e3e8; }
  .studio-v3 .current-production-action, .studio-v3 .current-decision-bar { margin-block: 16px 24px; padding: 15px 12px; }
  .studio-v3 .current-decision-bar { padding-bottom: calc(15px + env(safe-area-inset-bottom)); }
  .studio-v3 .current-production-action > header { align-items: flex-start; }
  .studio-v3 .current-production-action h2 { font-size: 18px; }
}

@media (prefers-reduced-motion: reduce) {
  .studio-v3 .resources-page > [data-resource-section][data-active="true"] { animation: none; }
}

@media (max-width: 700px) {
  .studio-v3 .provider-ledger-row {
    min-height: 0;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    align-items: start;
    gap: 8px 10px;
    padding: 14px 0;
  }
  .studio-v3 .provider-ledger-row > div { grid-column: 2; }
  .studio-v3 .provider-ledger-row > div small {
    overflow: visible;
    line-height: 1.55;
    text-overflow: clip;
    white-space: normal;
  }
  .studio-v3 .provider-ledger-row > .provider-model-cell {
    display: block;
    grid-column: 2 / -1;
    overflow: visible;
    white-space: normal;
  }
  .studio-v3 .provider-ledger-row > .provider-cost {
    display: block;
    grid-column: 2;
    align-self: center;
  }
  .studio-v3 .provider-ledger-row > .ledger-state {
    display: block;
    grid-column: 3;
    grid-row: 1;
  }
  .studio-v3 .provider-ledger-row > .provider-family-label { display: none; }
  .studio-v3 .provider-ledger-row > .provider-default {
    display: block;
    grid-column: 2;
    justify-self: start;
  }
  .studio-v3 .provider-ledger-row > .provider-doc-link {
    display: grid;
    grid-column: 3;
    width: 40px;
    height: 40px;
    place-items: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .studio-v3 .home-continuation,
  .studio-v3 .home-start-options > button,
  .studio-v3 .home-start-options > button > svg,
  .studio-v3 .home-recommendation-list > a,
  .studio-v3 .project-load-more,
  .guide-dock-trigger {
    animation: none !important;
    transform: none !important;
    transition-duration: 0.01ms !important;
  }
}

/* Role-first production configuration */
.studio-v3 .production-team-section {
  padding: 22px 0 24px;
  border-bottom: 1px solid var(--line);
}

```

### Original lines 2886-3079

```
.studio-v3 .run-back-row { padding-top: 12px; }
.studio-v3 .run-page { padding-top: 12px; }
.studio-v3 .run-page .run-header { min-height: 0; align-items: center; margin: 0; padding: 0 0 12px; border: 0; }
.studio-v3 .run-header h1 { font-size: 24px; line-height: 1.45; }
.studio-v3 .run-title-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 18px; margin-top: 4px; font-size: 12px; color: var(--muted); }
.studio-v3 .run-header .eyebrow { margin: 0 0 4px; color: var(--muted); font-size: 12px; }
.studio-v3 .run-brief-context { font-size: 12px; color: var(--muted); }
.studio-v3 .run-brief-context[open] { flex-basis: 100%; }
.studio-v3 .run-brief-context summary { cursor: pointer; padding: 4px 0; }
.studio-v3 .run-brief-context .page-summary { margin: 6px 0; font-size: 13px; }
.studio-v3 .run-workspace-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0 20px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.studio-v3 .run-section-nav { display: flex; flex: 1 1 auto; flex-wrap: wrap; gap: 6px 24px; margin: 0; padding: 0; border: 0; }
.studio-v3 .run-section-nav a { display: inline-flex; align-items: center; min-height: 44px; color: var(--muted); font-size: 13px; text-decoration: none; }
.studio-v3 .run-section-nav a:first-child { color: var(--accent); font-weight: 650; }
.studio-v3 .run-progress-disclosure { font-size: 12px; color: var(--muted); }
.studio-v3 .run-progress-disclosure > summary { cursor: pointer; min-height: 44px; align-content: center; }
.studio-v3 .run-progress-disclosure > summary span { margin-left: 10px; font-variant-numeric: tabular-nums; }
.studio-v3 .run-progress-disclosure[open] { flex-basis: 100%; }
.studio-v3 .run-progress-disclosure .production-progress { margin: 0 0 12px; padding: 12px; box-shadow: none; }
.studio-v3 :is(#run-current, #run-artifacts, #run-costs, #evidence-heading, #creative-direction) { scroll-margin-top: 84px; }
.studio-v3 .run-current-workspace { min-width: 0; }
.studio-v3 .workspace-loading { padding: 32px 20px; background: var(--paper); border: 1px solid var(--line); }
.studio-v3 .production-progress > header > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
.studio-v3 .production-progress > header small { color: var(--muted); font-size: 12px; }
.studio-v3 .production-progress > header > span { color: var(--muted); font-size: 12px; font-weight: 500; }
.studio-v3 .review-layout.review-layout-no-media { grid-template-columns: minmax(0, 1fr); }
.studio-v3 .review-layout-no-media .review-panel { position: static; max-width: none; }
.studio-v3 .current-artifact-surface { min-width: 0; background: var(--paper); border: 1px solid var(--line); padding: 20px; }
.studio-v3 .preview-provenance { padding: 12px 16px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.studio-v3 .run-page .spend-gate { display: grid; grid-template-columns: minmax(0, 1fr); align-items: stretch; gap: 16px; padding: 16px; }
.studio-v3 .run-page .spend-gate-actions { display: flex; flex-direction: column; align-items: stretch; width: 100%; gap: 12px; }
.studio-v3 .spend-quote-summary { margin: 0; width: 100%; }
.studio-v3 .spend-quote-summary > div { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 3fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: 13px; line-height: 1.65; }
.studio-v3 .spend-quote-summary dt { color: var(--muted); }
.studio-v3 .spend-quote-summary dd { margin: 0; overflow-wrap: anywhere; }
.studio-v3 .spend-gate-buttons { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.studio-v3 .spend-gate-actions > small { line-height: 1.7; }
.studio-v3 .creative-discussion-panel { background: var(--paper); padding: 0; margin: 0; border: 1px solid var(--line-strong); border-radius: 6px; overflow: clip; box-shadow: none; }
.studio-v3 .creative-discussion-header { padding: 14px 20px; gap: 12px; align-items: center; border-bottom: 1px solid var(--line); }
.studio-v3 .creative-discussion-header h2 { margin: 0; font-size: 16px; font-weight: 650; line-height: 1.5; }
.studio-v3 .creative-discussion-header p:not(.eyebrow) { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; max-width: 76ch; }
.studio-v3 .creative-review-phase { background: var(--accent-soft); color: var(--accent-strong); border-radius: 4px; font-size: 12px; }
.studio-v3 .creative-discussion-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 34%); gap: 0; margin: 0; align-items: stretch; height: clamp(420px, calc(100dvh - 360px), 800px); }
.studio-v3 .creative-draft-surface { min-height: 0; background: var(--paper); border: 0; border-right: 1px solid var(--line); border-radius: 0; padding: 20px 28px; max-height: none; overflow: auto; scrollbar-gutter: stable; overscroll-behavior: contain; }
.studio-v3 .creative-chat-surface { min-height: 0; background: var(--paper-soft); border: 0; border-radius: 0; padding: 16px 20px; display: flex; flex-direction: column; align-items: stretch; max-height: none; overflow: auto; }
.studio-v3 .creative-document-heading, .studio-v3 .creative-chat-heading { flex-shrink: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--line); font-size: 13px; }
.studio-v3 .creative-document-heading span, .studio-v3 .creative-chat-heading span { color: var(--muted); font-size: 11px; margin-left: auto; }
.studio-v3 .creative-readable-draft { gap: 24px; font-size: 15px; line-height: 1.9; }
.studio-v3 .creative-readable-draft section > strong { color: var(--ink); font-size: 13px; font-weight: 650; }
.studio-v3 .creative-readable-draft p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.studio-v3 .creative-readable-draft ul { padding-left: 20px; margin: 8px 0 0; }
.studio-v3 .creative-readable-draft li + li { margin-top: 10px; }
.studio-v3 .creative-scene { padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.studio-v3 .creative-audience-copy { margin-top: 12px; }
.studio-v3 .creative-audience-copy p { font-size: 16px; font-weight: 500; }
.studio-v3 :is(.creative-audience-copy, .creative-production-note) small { color: var(--muted); font-size: 11px; }
.studio-v3 .creative-production-note { margin-top: 12px; padding: 10px 12px; background: var(--paper-soft); }
.studio-v3 .creative-production-note p { font-size: 13px; color: var(--muted); }
.studio-v3 .creative-message-list { flex: 1 1 100px; min-height: 64px; max-height: none; overflow: auto; }
.studio-v3 .creative-empty-chat { align-items: flex-start; font-size: 13px; line-height: 1.8; margin: 0; }
.studio-v3 .creative-message { border-radius: 4px; font-size: 13px; overflow-wrap: anywhere; }
.studio-v3 .message-user { background: var(--accent-soft); }
.studio-v3 .message-assistant { background: var(--paper); }
.studio-v3 .creative-quick-prompts { flex-shrink: 0; display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.studio-v3 .creative-quick-prompts button { background: var(--paper); border-radius: 4px; min-height: 36px; padding: 6px 9px; color: var(--muted); font-size: 12px; }
.studio-v3 .creative-composer { flex-shrink: 0; }
.studio-v3 .creative-composer > span { font-size: 13px; font-weight: 600; }
.studio-v3 .creative-composer textarea, .studio-v3 .creative-edit-field textarea { width: 100%; min-height: 104px; padding: 12px; font: inherit; font-size: 14px; line-height: 1.75; color: var(--ink); background: var(--paper); border: 1px solid var(--line-strong); border-radius: 5px; resize: vertical; }
.studio-v3 .creative-composer small { font-size: 11px; margin-bottom: 10px; }
.studio-v3 .creative-chat-surface > .button { align-self: flex-end; min-width: 90px; }
.studio-v3 :is(.creative-draft-editor, .creative-selection-disclosure) { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 12px; }
.studio-v3 :is(.creative-draft-editor, .creative-selection-disclosure) > summary { cursor: pointer; min-height: 40px; color: var(--accent); font-size: 13px; line-height: 1.6; }
.studio-v3 .creative-draft-editor { margin: -4px 0 16px; padding: 0; border: 0; }
.studio-v3 .creative-draft-editor > summary { width: fit-content; display: flex; align-items: center; gap: 7px; padding: 6px 10px; min-height: 36px; background: var(--accent-soft); border-radius: 4px; }
.studio-v3 .creative-draft-editor[open] > summary { margin-bottom: 12px; }
.studio-v3 .creative-edit-field { display: grid; gap: 8px; margin: 16px 0; font-size: 13px; }
.studio-v3 .creative-edit-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.studio-v3 .creative-edit-state { background: var(--accent-soft); padding: 10px 12px; font-size: 13px; line-height: 1.7; }
.studio-v3 .creative-review-actions { position: sticky; bottom: 0; z-index: 2; background: var(--paper); padding: 12px 20px; margin: 0; border-top: 1px solid var(--line-strong); align-items: center; flex-wrap: wrap; }
.studio-v3 .creative-confirm-context { flex: 1 1 200px; display: grid; gap: 4px; font-size: 13px; }
.studio-v3 .creative-confirm-context small { font-size: 11px; color: var(--muted); line-height: 1.6; }
.studio-v3 .creative-return-actions { margin: 0; border: 0; border-top: 1px solid var(--line); padding: 14px 24px; border-radius: 0; background: var(--paper-soft); }
.studio-v3 .creative-check-result { border: 1px solid var(--line-strong); border-radius: 4px; background: var(--amber-soft); font-size: 13px; line-height: 1.7; }
.studio-v3 .creative-proposal { border-color: var(--line-strong); border-radius: 4px; }
.studio-v3 .creative-discussion-panel > .form-error { margin: 12px 24px; }
/* 工作台已有侧栏/手机顶栏向导入口，移除会盖住确认按钮的重复悬浮入口。 */
.studio-v3:has(.run-page) .guide-dock:not(.is-open) { display: none; }
.studio-v3 .opportunity-context-nav { display: flex; flex-wrap: wrap; gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); }
.studio-v3 .opportunity-context-nav a { color: var(--accent); font-size: 12px; text-decoration: none; padding: 6px 0; }
.studio-v3 .creative-direction-disclaimer { color: var(--muted); font-size: 12px; line-height: 1.7; }
.studio-v3 .candidate-creation-label { margin: 12px 0 4px; color: var(--muted); font-size: 12px; }
.studio-v3 .candidate-detail .candidate-article-reading { background: var(--paper-soft); padding: 12px; border: 1px solid var(--line); border-radius: 4px; max-height: 280px; overflow: auto; }
.studio-v3 .project-folio-state { flex-wrap: wrap; gap: 8px; }
.studio-v3 :is(.run-section-nav a, .run-progress-disclosure summary, .run-brief-context summary, .brief-extra-options summary, .creative-mobile-tabs button, .creative-quick-prompts button, .creative-draft-surface, .creative-draft-editor summary, .creative-selection-disclosure summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
/* 制作记录是继续工作的入口，统计和占位封面不应把作品挤出首屏。 */
.studio-v3 .queue-page { padding-top: 28px; }
.studio-v3 .queue-page .page-header { margin-bottom: 22px; padding-bottom: 0; min-height: 0; border: 0; align-items: center; }
.studio-v3 .queue-page .page-header h1 { font-size: 26px; }
.studio-v3 .queue-page .page-summary { margin: 8px 0 0; }
.studio-v3 .project-archive-heading { align-items: center; padding: 0 0 12px; border: 0; }
.studio-v3 .project-edition { display: flex; flex-wrap: wrap; gap: 20px; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.studio-v3 .project-edition > div { min-height: 0; padding: 0; border: 0; display: flex; gap: 6px; align-items: baseline; }
.studio-v3 .project-edition strong { font-size: 17px; font-weight: 600; }
.studio-v3 .project-edition span { font-size: 12px; }
.studio-v3 .project-controls { min-height: 58px; }
.studio-v3 .production-archive { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; padding: 0; border-top: 1px solid var(--line-strong); }
.studio-v3 .project-folio, .studio-v3 .project-folio:nth-child(2n) { min-height: 142px; grid-template-columns: 68px minmax(0, 1fr); gap: 20px; padding: 20px 12px; background: var(--paper); border: 0; border-bottom: 1px solid var(--line); border-radius: 0; box-shadow: none; }
.studio-v3 .project-folio:hover { background: var(--paper-soft); transform: none; box-shadow: none; }
.studio-v3 .project-preview { width: 68px; min-height: 100px; max-height: 110px; align-self: center; border-radius: 4px; }
.studio-v3 .project-preview-placeholder strong { font-size: 22px; }
.studio-v3 .project-preview > span { font-size: 10px; right: 4px; bottom: 4px; }
.studio-v3 .project-folio-copy { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) 220px auto; grid-template-rows: auto auto auto; column-gap: 24px; row-gap: 7px; align-content: center; }
.studio-v3 .project-folio-meta { grid-column: 1; grid-row: 1; justify-content: flex-start; gap: 14px; font-size: 11px; }
.studio-v3 .project-folio h3 { grid-column: 1; grid-row: 2; margin: 0; font-size: 17px; line-height: 1.55; }
.studio-v3 .project-folio h3 a { color: inherit; text-decoration: none; }
.studio-v3 .project-folio h3 a:hover { color: var(--accent); text-decoration: underline; text-underline-offset: 4px; }
.studio-v3 .project-folio-state { grid-column: 2; grid-row: 1 / 4; align-content: center; justify-content: flex-start; }
.studio-v3 .project-folio-state > span { font-size: 12px; }
.studio-v3 .project-folio .project-progress { grid-column: 1; grid-row: 3; max-width: 200px; margin-top: 3px; }
.studio-v3 .project-folio-actions { grid-column: 3; grid-row: 1 / 4; align-self: center; gap: 8px; }
.studio-v3 .project-folio-action { font-size: 13px; min-height: 44px; }
.studio-v3 .queue-select-run { top: 8px; left: 8px; }
.studio-v3 .brief-extra-options { grid-column: span 6; align-self: start; border: 1px solid var(--line); border-radius: 4px; }
.studio-v3 .brief-extra-options > summary { padding: 11px 12px; cursor: pointer; font-size: 13px; line-height: 1.7; }
.studio-v3 .brief-extra-options > summary span { margin-left: 10px; color: var(--muted); font-size: 12px; }
.studio-v3 .brief-extra-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 4px 12px 12px; }
.studio-v3 .brief-extra-fields .field { grid-column: span 1; }
.studio-v3 .brief-extra-fields .field-wide { grid-column: 1 / -1; }
.studio-v3 .visual-intent-options { grid-column: 1 / -1; }
.studio-v3 .recipe-dialog-header .eyebrow { display: none; }
@media (max-width: 1200px) {
  .studio-v3 .project-folio-copy { grid-template-columns: minmax(0, 1fr) auto; }
  .studio-v3 .project-folio-state { grid-column: 1; grid-row: 3; }
  .studio-v3 .project-folio .project-progress { grid-row: 4; }
  .studio-v3 .project-folio-actions { grid-column: 2; grid-row: 1 / 5; }
}
@media (max-width: 900px) {
  .studio-v3 .run-page .review-layout { grid-template-columns: minmax(0, 1fr); }
  .studio-v3 .run-page .review-panel { position: static; min-width: 0; max-width: none; }
  .studio-v3 .creative-discussion-layout { grid-template-columns: minmax(0, 1.3fr) minmax(250px, 1fr); }
  .studio-v3 .creative-draft-surface, .studio-v3 .creative-chat-surface { padding: 16px; }
  .studio-v3 .creative-review-actions { padding: 14px 16px; }
}
@media (max-width: 700px) {
  .studio-v3 .run-workspace-toolbar { gap: 0; margin-bottom: 12px; }
  .studio-v3 .run-section-nav { gap: 0 16px; }
  .studio-v3 .run-page .run-header { flex-direction: column; align-items: stretch; gap: 6px; padding-top: 0; }
  .studio-v3 .run-header h1 { font-size: 21px; }
  .studio-v3 .run-page .run-header > .status-badge { align-self: flex-start; }
  .studio-v3 .run-section-nav a { min-height: 44px; font-size: 12px; }
  .studio-v3 .creative-discussion-header { display: flex; padding: 12px; gap: 8px; flex-wrap: wrap; }
  .studio-v3 .creative-discussion-header h2 { font-size: 16px; }
  .studio-v3 .creative-review-phase { margin-left: auto; }
  .studio-v3 .creative-mobile-tabs { display: flex; gap: 8px; padding: 8px 12px; margin: 0; border-bottom: 1px solid var(--line); }
  .studio-v3 .creative-mobile-tabs button { flex: 1; min-height: 44px; padding: 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--muted); }
  .studio-v3 :is(.creative-quick-prompts button, .creative-draft-editor summary, .creative-selection-disclosure summary) { min-height: 44px; }
  .studio-v3 .creative-mobile-tabs button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-strong); border-color: var(--accent); }
  .studio-v3 .creative-discussion-layout { display: block; height: auto; }
  .studio-v3 .creative-draft-surface, .studio-v3 .creative-chat-surface { display: none; height: 56dvh; min-height: 360px; max-height: none; border: 0; padding: 16px; }
  .studio-v3 .creative-draft-surface.is-mobile-active { display: block; }
  .studio-v3 .creative-chat-surface.is-mobile-active { display: flex; height: auto; overflow: visible; scroll-margin-block: 80px; }
  .studio-v3 .creative-chat-surface .creative-message-list { flex: 0 1 auto; max-height: 32dvh; }
  .studio-v3 .creative-chat-surface > .button { min-height: 44px; scroll-margin-block: 80px; }
  .studio-v3 .creative-confirm-context { flex-basis: 100%; }
  .studio-v3 .creative-review-actions { position: static; padding: 12px; }
  .studio-v3 .creative-review-actions .button { flex: 1 1 130px; min-height: 44px; white-space: normal; }
  .studio-v3 .creative-return-actions { padding: 14px 16px; }
  .studio-v3 .creative-composer textarea, .studio-v3 .creative-edit-field textarea { font-size: 16px; }
  .studio-v3 .preview-provenance { padding: 12px; }
  .studio-v3 .recipe-dialog-actions { flex: 0 0 auto; flex-wrap: wrap; gap: 8px; }
  .studio-v3 .recipe-dialog-actions > div { display: block; flex-basis: 100%; }
  .studio-v3 .recipe-dialog-actions > div strong { display: none; }
  .studio-v3 .recipe-dialog-actions > div span { display: block; font-size: 12px; line-height: 1.6; }
  .studio-v3 .queue-page { padding-top: 20px; }
  .studio-v3 .queue-page .page-header { flex-wrap: wrap; gap: 14px; margin-bottom: 18px; }
  .studio-v3 .queue-page .page-header h1 { font-size: 23px; }
  .studio-v3 .project-edition { gap: 12px; }
  .studio-v3 .project-edition > div { gap: 4px; }
  .studio-v3 .project-edition strong { font-size: 15px; }
  .studio-v3 .project-edition span { font-size: 11px; }
  .studio-v3 .project-archive-heading { gap: 12px; flex-wrap: wrap; }
  .studio-v3 .project-controls { gap: 10px; padding: 10px 0; }
  .studio-v3 .project-filters { display: flex; width: 100%; }
  .studio-v3 .project-filters button { min-height: 44px; flex: 1; }
  .studio-v3 .project-search { min-height: 44px; width: 100%; }
  .studio-v3 .project-folio, .studio-v3 .project-folio:nth-child(2n) { grid-template-columns: 52px minmax(0, 1fr); padding: 16px 8px; gap: 12px; }
  .studio-v3 .project-preview { width: 52px; min-height: 78px; max-height: 84px; align-self: start; }
  .studio-v3 .project-folio-copy { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .studio-v3 .project-folio h3 { font-size: 16px; }
  .studio-v3 .project-folio-meta { flex-wrap: wrap; gap: 4px 12px; }
  .studio-v3 .project-folio-actions { grid-column: 1; grid-row: 5; justify-content: space-between; }
  .studio-v3 .brief-extra-options { grid-column: 1 / -1; }
  .studio-v3 .brief-extra-options > summary span { display: block; margin: 4px 0 0; }
}
```

## apps/studio/test/creative-discussion-panel.test.tsx

SHA256: 893f319fbd5e380daa827c8e0fb4b3aed625f28ff718fd52780fce7d96544b25; 345 lines. OMITTED: 101-345.

### Original lines 1-100

```
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeDiscussionPanel } from "../src/client/components/CreativeDiscussionPanel.js";
import type { StudioCreativeReviewCommandInput, StudioCreativeReviewSnapshot } from "../src/shared/api.js";

const sha = "a".repeat(64);

function review(overrides: Partial<StudioCreativeReviewSnapshot> = {}): StudioCreativeReviewSnapshot {
  return {
    runId: "run-creative",
    runRevision: 8,
    stage: "script",
    reviewRevision: 3,
    draftSha256: sha,
    draftArtifactId: "script-draft-1",
    phase: "waiting_user",
    allowedActions: ["discuss", "edit_draft", "adopt_proposal", "undo_draft", "confirm", "return_to_stage"],
    returnTargets: [{
      stage: "treatment",
      label: "返回前期构思",
      impact: "脚本、导演方案和后续确认会失效；历史稿件与已经可用的素材会保留，重新确认后再生成后续方案。",
    }],
    draft: {
      narrativeArc: "问题到答案",
      scenes: [{ id: "scene-1", position: 1, duration: 8, narration: "先看结果。", visual_prompt: "结果对照" }],
    },
    messages: [],
    proposals: [],
    effectiveUserInstructions: [],
    blockingIssues: [],
    ...overrides,
  };
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: vi.fn(() => values.clear()),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    },
  });
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("CreativeDiscussionPanel", () => {
  it("shows an incomplete review without a score and binds explicit consent to that check", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CreativeDiscussionPanel review={review({ checkResult: {
      status: "incomplete", summary: "请求已结清，但没有有效复核结论", issues: [], checkIdentity: "b".repeat(64),
    } })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText("独立复核未完成 · 无评分")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "接受复核未完成，采用本版" }));
    expect(onCommand).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "接受复核未完成，采用本版" }));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", acknowledgeIncomplete: true, expectedCheckIdentity: "b".repeat(64), baseDraftSha256: sha });
  });

  it("only sends stock risk consent after showing the risk and receiving confirmation", async () => {
    const onCommand = vi.fn(async (_input: StudioCreativeReviewCommandInput) => undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CreativeDiscussionPanel review={review({ stage: "director", qualityAdvisories: [
      { scenePositions: [1], reason: "候选仅得20分，视觉核验未完成" },
    ] })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText(/候选仅得20分/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "接受素材风险，先制作首版" }));
    expect(onCommand).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "接受素材风险，先制作首版" }));
    expect(onCommand.mock.calls[0]![0]).toMatchObject({ action: "confirm", acceptQualityFallback: true, baseDraftSha256: sha });
  });
  it("preserves unsaved manual edits across a new server draft and refuses to overwrite it", async () => {
    const onCommand = vi.fn(async () => undefined);
    const rendered = render(<CreativeDiscussionPanel review={review()} busy={false} onCommand={onCommand} />);
    await userEvent.click(screen.getByText("手动修订这份稿件"));
    const narration = await screen.findByLabelText("分镜 1 · 旁白");
    await userEvent.clear(narration);
    await userEvent.type(narration, "我还没保存的文字");
    expect(screen.getByRole("button", { name: "确认当前方案，继续" })).toBeDisabled();
    rendered.rerender(<CreativeDiscussionPanel review={review({
      draftSha256: "b".repeat(64), reviewRevision: 4,
      draft: { ...review().draft as object, narrativeArc: "服务端的新方案" },
    })} busy={false} onCommand={onCommand} />);
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue("我还没保存的文字");
    expect(screen.getByText(/旧稿不能覆盖新稿/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存修订" })).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(screen.getByLabelText("叙事推进")).toHaveValue("服务端的新方案");
  });
```

## apps/studio/test/node-workspace.test.tsx

SHA256: 375b5e90ac4be09790e11593b2d578586ead534af556b9c03a2ef43c3c8b7a26; 1863 lines. OMITTED: 101-1863.

### Original lines 1-100

```
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioCostDashboard as CostDto, StudioNode, StudioProvider } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { CostDashboard, RunCostDetailPanel } from "../src/client/components/CostDashboard.js";
import { NodeWorkspace } from "../src/client/components/NodeWorkspace.js";

// C2 制作范围授权需要当前方案 digest：工作区测试统一携带一个合法形态的 fixture 值。
const TEST_PLAN_DIGEST = "b".repeat(64);

const succeededNode: StudioNode = {
  id: "script",
  label: "脚本",
  role: "编剧",
  status: "succeeded",
  artifactIds: [],
  qualityGateResults: [],
  output: { hook: "旧钩子" },
  inputState: {
    effectiveVersionId: "input-generated",
    stale: false,
    versions: [{
      id: "input-generated",
      source: "derived",
      value: { brief: { title: "旧题目" } },
      upstreamVersionIds: ["brief-v1"],
      createdAt: "2026-08-27T00:00:00.000Z",
      createdBy: "workflow:script",
      schemaVersion: "script-input-v1",
    }],
  },
  outputState: {
    generatedVersionId: "version-generated",
    effectiveVersionId: "version-generated",
    stale: false,
    versions: [{
      id: "version-generated",
      source: "generated",
      artifactIds: [],
      inputVersionIds: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      createdBy: "codex-screenwriter-v1",
      schemaVersion: "script-v1",
      output: { hook: "旧钩子" },
    }],
  },
  executionReceipt: {
    providerId: "codex-screenwriter-v1",
    providerLabel: "Codex 编剧",
    modelId: "codex",
    transport: "unix_socket",
    billing: "subscription",
    configurationSource: "template_default",
    parameters: { promptPack: "video-factory/screenwriter-v4", temperature: 0.4 },
    status: "succeeded",
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:01.000Z",
    actualModelIds: ["codex-runtime-actual"],
  },
};

const seedanceProvider: StudioProvider = {
  id: "seedance-video-v1",
  capability: "asset.prepare",
  label: "Seedance 视频生成",
  available: true,
  kind: "external",
  billing: "metered",
  defaultModelId: "seedance-v1",
  modelProfiles: [{
    id: "seedance-v1",
    providerId: "seedance-video-v1",
    providerFamily: "seedance",
    label: "Seedance 1",
    description: "视频生成",
    available: true,
    taskTypes: ["text-to-video"],
  }],
};

const hailuoProvider: StudioProvider = {
  id: "hailuo-video-v1",
  capability: "asset.prepare",
  label: "MiniMax 视频生成",
  available: true,
  kind: "external",
  billing: "metered",
  defaultModelId: "MiniMax-Hailuo-02",
  modelProfiles: [{
    id: "MiniMax-Hailuo-02",
    providerId: "hailuo-video-v1",
    providerFamily: "minimax",
    label: "MiniMax Hailuo 02",
    description: "视频生成",
    available: true,
    taskTypes: ["text-to-video"],
  }],
};
```

## Existing Studio test files (navigation only, not read/passed evidence)

- apps/studio/test/audio-review-panel.test.tsx
- apps/studio/test/resource-governance-studio.test.ts
- apps/studio/test/node-delivery-preview.test.tsx
- apps/studio/test/studio-service.test.ts
- apps/studio/test/template-store.test.ts
- apps/studio/test/creative-os.test.tsx
- apps/studio/test/production-planning-editing.test.ts
- apps/studio/test/server.test.ts
- apps/studio/test/client.test.tsx
- apps/studio/test/case-source.test.ts
- apps/studio/test/series-planning-agent.test.ts
- apps/studio/test/creative-discussion-panel.test.tsx
- apps/studio/test/model-library.test.tsx
- apps/studio/test/trend-studio.test.ts
- apps/studio/test/auth-gate.test.tsx
- apps/studio/test/planning-stages-panel.test.tsx
- apps/studio/test/creator-language.test.tsx
- apps/studio/test/production-worker.test.ts
- apps/studio/test/resources-manifest-page.test.tsx
- apps/studio/test/scene-resource-revision.test.ts
- apps/studio/test/publishing-studio.test.ts
- apps/studio/test/local-capabilities.test.ts
- apps/studio/test/run-observability.test.tsx
- apps/studio/test/series-store.test.ts
- apps/studio/test/hot-topic-board.test.tsx
- apps/studio/test/topic-taxonomy.test.ts
- apps/studio/test/node-output-validator.test.ts
- apps/studio/test/node-workspace.test.tsx
- apps/studio/test/presentation.test.tsx
- apps/studio/test/trend-topic-pipeline.test.ts
- apps/studio/test/unsplash-attribution.test.tsx
- apps/studio/test/node-structured-editor.test.tsx
- apps/studio/test/production-queue.test.tsx
- apps/studio/test/templates-page.test.tsx
- apps/studio/test/production-planning-stages.test.ts
- apps/studio/test/production-authorization-api.test.ts
- apps/studio/test/text-task-recovery-receipt.cross.test.ts
- apps/studio/test/historical-readonly-ui.test.tsx
- apps/studio/test/trend-article-reader.test.ts
- apps/studio/test/setup.ts
- apps/studio/test/trend-opportunity-agent.test.ts
- apps/studio/test/editorial-decision.test.ts
- apps/studio/test/cases-page.test.tsx
- apps/studio/test/api-contract.test.ts
- apps/studio/test/reference-video-store.test.ts
- apps/studio/test/review-media-preprocessor.test.ts
- apps/studio/test/r4-receipt-child.mjs
- apps/studio/test/text-task-production-recovery.test.ts
- apps/studio/test/client-api.test.tsx
- apps/studio/test/creator-settings-store.test.ts
- apps/studio/test/trend-gateway.test.ts
- apps/studio/test/cost-studio.test.ts
- apps/studio/test/opportunity-store.test.ts
- apps/studio/test/receipt-race-scenario.mjs
- apps/studio/test/codex-provider-settings.test.ts
- apps/studio/test/auth.test.ts
- apps/studio/test/creator-tour.test.tsx
- apps/studio/test/role-agent-assembly.test.ts
- apps/studio/test/case-api.test.ts
- apps/studio/test/model-connections.test.ts
- apps/studio/test/template-catalog.test.ts
- apps/studio/test/candidate-inbox.test.ts
- apps/studio/test/audio-review-service.test.ts
- apps/studio/test/template-studio.test.tsx
- apps/studio/test/assets-page.test.tsx
- apps/studio/test/visual-plan.test.ts
- apps/studio/test/series-planner.test.ts
- apps/studio/test/production-joint-rework.test.ts
- apps/studio/test/task-recovery-ui.test.tsx
