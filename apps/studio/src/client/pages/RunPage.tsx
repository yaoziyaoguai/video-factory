import { AlertCircle, ArrowLeft, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { StudioCostRunDetail, StudioCreatorSettings, StudioDecisionInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioProductionInput, StudioProvider, StudioRunDetail, StudioSpendAuthorizationInput } from "../../shared/api.js";
import { studioApi, subscribeToRun } from "../api.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { RunWorkbench } from "../components/RunWorkbench.js";
import { MultiPlatformPublishDialog } from "../components/MultiPlatformPublishDialog.js";

export function RunPage() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<StudioRunDetail>();
  const [loading, setLoading] = useState(true);
  const [decisionPending, setDecisionPending] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionWarning, setConnectionWarning] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartProviders, setRestartProviders] = useState<StudioProvider[]>([]);
  const [restartSettings, setRestartSettings] = useState<StudioCreatorSettings>();
  const [costDetail, setCostDetail] = useState<StudioCostRunDetail>();
  const [costError, setCostError] = useState<string>();
  const [nodeMutationPending, setNodeMutationPending] = useState(false);
  const costRefreshTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [runResult, costResult] = await Promise.allSettled([studioApi.run(runId), studioApi.runCosts(runId)]);
      if (runResult.status === "rejected") throw runResult.reason;
      setRun(runResult.value);
      setCostDetail(costResult.status === "fulfilled" ? costResult.value : undefined);
      setCostError(costResult.status === "rejected"
        ? `成本明细读取失败：${costResult.reason instanceof Error ? costResult.reason.message : String(costResult.reason)}`
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
    if (!run || run.status === "succeeded" || run.status === "failed" || run.status === "rejected") {
      return;
    }
    return subscribeToRun(
      runId,
      (nextRun) => {
        setRun(nextRun);
        if (costRefreshTimer.current === undefined) {
          costRefreshTimer.current = window.setTimeout(() => {
            costRefreshTimer.current = undefined;
            void refreshCosts();
          }, 1_000);
        }
        setConnectionWarning(undefined);
      },
      () => setConnectionWarning("实时连接暂时中断，正在自动重连。你也可以刷新页面读取最新进度。"),
    );
  }, [runId, run !== undefined, isTerminal(run?.status)]);

  useEffect(() => () => {
    if (costRefreshTimer.current !== undefined) window.clearTimeout(costRefreshTimer.current);
  }, [runId]);

  async function decide(input: StudioDecisionInput) {
    setDecisionPending(true);
    setError(undefined);
    try {
      setRun(await studioApi.decide(runId, input));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDecisionPending(false);
    }
  }

  async function beginRestart() {
    setError(undefined);
    try {
      const [providers, settings] = await Promise.all([studioApi.providers(), studioApi.settings()]);
      setRestartProviders(providers);
      setRestartSettings(settings);
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
      setRun(await studioApi.overrideNode(runId, nodeId, input));
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
      setRun(await studioApi.overrideNodeInput(runId, nodeId, input));
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
      setRun(await studioApi.authorizeSpend(runId, nodeId, input));
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
      setRun(await studioApi.regenerateStale(runId));
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
      setRun(await studioApi.retryFailedNode(runId, nodeId));
      setConnectionWarning(undefined);
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function refreshCosts() {
    try {
      setCostDetail(await studioApi.runCosts(runId));
      setCostError(undefined);
    } catch (caught) {
      setCostError(`成本明细读取失败：${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  if (loading) {
    return <div className="page-loading"><LoaderCircle aria-hidden="true" size={22} />正在读取生产现场...</div>;
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
      <RunWorkbench run={run} decisionPending={decisionPending} onDecision={decide} onOpenPublish={() => setPublishing(true)} onRestart={() => void beginRestart()} {...(costDetail ? { costDetail } : {})} nodeMutationPending={nodeMutationPending} onOverrideNode={overrideNode} onOverrideNodeInput={overrideNodeInput} onAuthorizeSpend={authorizeSpend} onRegenerateStale={regenerateStale} onRetryFailedNode={retryFailedNode} />
      {publishing ? <MultiPlatformPublishDialog runId={run.id} onClose={() => setPublishing(false)} /> : null}
      <NewRunDialog
        open={restarting}
        providers={restartProviders}
        {...(restartSettings ? { creatorSettings: restartSettings } : {})}
        initialValues={{
          title: run.title,
          angle: run.angle,
          audience: run.audience,
          nicheSlug: run.nicheSlug,
          platform: run.platform,
          durationSeconds: run.durationSeconds,
          reviewMode: "manual",
          ...(run.creationOrigin && run.opportunityId ? {
            creationContext: { origin: run.creationOrigin, opportunityId: run.opportunityId },
          } : {}),
        }}
        onClose={() => setRestarting(false)}
        onSubmit={restartProduction}
      />
    </>
  );
}

function isTerminal(status: StudioRunDetail["status"] | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected";
}
