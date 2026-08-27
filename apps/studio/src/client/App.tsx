import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { AppShell } from "./components/AppShell.js";
import { ExperimentsPage } from "./pages/ExperimentsPage.js";
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
      <Route path="/" element={<TodayPage />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/:runId" element={<RunPage />} />
      <Route path="/templates" element={<TemplatesPage />} />
      <Route path="/resources" element={<ResourcesPage />} />
      <Route path="/experiments" element={<ExperimentsPage />} />
      <Route path="/runs/:runId" element={<LegacyRunRedirect />} />
      <Route path="/providers" element={<Navigate to="/resources" replace />} />
    </Routes>
  );
}

function LegacyRunRedirect() {
  const { runId } = useParams();
  return <Navigate to={runId ? `/projects/${runId}` : "/projects"} replace />;
}
