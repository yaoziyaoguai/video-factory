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
