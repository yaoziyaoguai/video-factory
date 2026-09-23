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
      <RunWorkbench run={run} creativeDiscussion={creativeReview ? <CreativeDiscussionPanel key={`${run.id}:${creativeReview.stage}:${creativeReview.reviewPurpose ?? "draft"}`} review={creativeReview} busy={creativeCommandPending || creativeReview.phase === "checking"} onCommand={commandCreativeReview} /> : undefined} providers={runProviders} decisionPending={decisionPending} onDecision={decide} onRequestSceneRevision={requestSceneRevision} onRequestSceneResourceRevision={requestSceneResourceRevision} onRequestNarrationRevision={requestNarrationRevision} onLoadSceneNarration={loadSceneNarration} onReinspectVisualReview={reinspectVisualReview} onOpenPublish={() => setPublishing(true)} onRestart={() => void beginRestart()} {...(costDetail ? { costDetail } : {})} {...(paidNodeSummary ? { paidNodeSummary } : {})} {...(connectionHeartbeatAt ? { connectionHeartbeatAt } : {})} nodeMutationPending={nodeMutationPending} pausePending={pausePending} onOverrideNode={overrideNode} onOverrideNodeInput={overrideNodeInput} onConfigureNode={configureNode} onAuthorizeSpend={authorizeSpend} onRejectSpend={rejectSpend} onRegenerateStale={regenerateStale} onRequestPause={requestPause} onResumePaused={resumePaused} onQueryOriginalTextTask={queryOriginalTextTask} onRetrieveOriginalTextTask={retrieveOriginalTextTask} onRetryFailedNode={retryFailedNode} onReconcilePaidNode={reconcilePaidNode} />
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
