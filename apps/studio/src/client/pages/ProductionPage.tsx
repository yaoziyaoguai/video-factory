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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [runsError, setRunsError] = useState<string>();
  const [providersError, setProvidersError] = useState<string>();

  const load = useCallback(async () => {
    setRunsLoading(true);
    setProvidersLoading(true);
    setRunsError(undefined);
    setProvidersError(undefined);
    await Promise.all([
      studioApi.runs().then(setRuns).catch((caught: unknown) => setRunsError(errorMessage(caught))).finally(() => setRunsLoading(false)),
      studioApi.providers().then(setProviders).catch((caught: unknown) => setProvidersError(errorMessage(caught))).finally(() => setProvidersLoading(false)),
      studioApi.settings().then(setCreatorSettings).catch(() => undefined),
    ]);
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
      <ProductionQueue runs={runs} loading={runsLoading} {...(runsError ? { error: runsError } : {})} onRetry={() => void load()} onCreate={() => setDialogOpen(true)} onArchive={archive} onRestore={restore} onDelete={remove} />
      <NewRunDialog open={dialogOpen} providers={providersLoading ? [] : providers} {...(creatorSettings ? { creatorSettings } : {})} onClose={() => setDialogOpen(false)} onSubmit={start} />
    </>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
