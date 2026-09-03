import { AlertCircle, ArrowLeft, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { StudioCostRunDetail, StudioCreatorSettings, StudioDecisionInput, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioPaidNodeSummary, StudioPaidReconciliationInput, StudioProductionInput, StudioProvider, StudioReworkDraft, StudioRunDetail, StudioSceneRevisionInput, StudioSpendAuthorizationInput, StudioSpendRejectionInput } from "../../shared/api.js";
import { studioApi, subscribeToRun } from "../api.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { RunWorkbench } from "../components/RunWorkbench.js";
import { MultiPlatformPublishDialog } from "../components/MultiPlatformPublishDialog.js";

export function preferRunSnapshot(current: StudioRunDetail | undefined, next: StudioRunDetail): StudioRunDetail {
  return !current || next.revision >= current.revision ? next : current;
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
      setCostError(`成本明细读取失败：${caught instanceof Error ? caught.message : String(caught)}`);
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

  const refreshRunSnapshot = useCallback(async () => {
    if (snapshotRefreshPending.current) return;
    snapshotRefreshPending.current = true;
    try {
      const nextRun = await studioApi.run(runId);
      setRun((current) => preferRunSnapshot(current, nextRun));
    } catch {
      // SSE 的断线提示负责告知连接问题；心跳补偿读取不重复制造错误横幅。
    } finally {
      snapshotRefreshPending.current = false;
    }
  }, [runId]);

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
      if (nodeId === "voice" && input.outcome === "confirmed_charged") {
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
      <RunWorkbench run={run} providers={runProviders} decisionPending={decisionPending} onDecision={decide} onRequestSceneRevision={requestSceneRevision} onOpenPublish={() => setPublishing(true)} onRestart={() => void beginRestart()} {...(costDetail ? { costDetail } : {})} {...(paidNodeSummary ? { paidNodeSummary } : {})} {...(connectionHeartbeatAt ? { connectionHeartbeatAt } : {})} nodeMutationPending={nodeMutationPending} pausePending={pausePending} onOverrideNode={overrideNode} onOverrideNodeInput={overrideNodeInput} onConfigureNode={configureNode} onAuthorizeSpend={authorizeSpend} onRejectSpend={rejectSpend} onRegenerateStale={regenerateStale} onRequestPause={requestPause} onResumePaused={resumePaused} onRetryFailedNode={retryFailedNode} onReconcilePaidNode={reconcilePaidNode} />
      {publishing ? <MultiPlatformPublishDialog runId={run.id} onClose={() => setPublishing(false)} /> : null}
      <NewRunDialog
        open={restarting}
        providers={restartProviders}
        {...(restartSettings ? { creatorSettings: restartSettings } : {})}
        {...(restartDraft ? { initialValues: restartDraft.input } : {})}
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
