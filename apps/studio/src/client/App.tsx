import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { AppShell } from "./components/AppShell.js";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary.js";
import { ExperimentsPage } from "./pages/ExperimentsPage.js";
import { AssetsPage } from "./pages/AssetsPage.js";
import { CasesPage } from "./pages/CasesPage.js";
import { HomePage } from "./pages/HomePage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ResourcesPage } from "./pages/ResourcesPage.js";
import { TodayPage } from "./pages/TodayPage.js";
import { TemplatesPage } from "./pages/TemplatesPage.js";

const RunPage = lazy(() => import("./pages/RunPage.js").then(module => ({ default: module.RunPage })));

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
  const { pathname } = useLocation();
  return (
    <RouteErrorBoundary key={pathname}>
    <Suspense fallback={<main className="page" role="status">正在打开页面…</main>}>
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
    </Suspense>
    </RouteErrorBoundary>
  );
}

function LegacyRunRedirect() {
  const { runId } = useParams();
  return <Navigate to={runId ? `/projects/${runId}` : "/projects"} replace />;
}
