import { AlertCircle, ArrowLeft, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { StudioCostRunDetail, StudioCreativeReviewCommandInput, StudioCreativeReviewHistory, StudioCreativeReviewSnapshot, StudioCreatorSettings, StudioDecisionInput, StudioNodeExecutionConfigurationInput, StudioNodeInputOverrideInput, StudioNodeOverrideInput, StudioPaidNodeSummary, StudioPaidReconciliationInput, StudioProductionInput, StudioProvider, StudioReworkDraft, StudioRunDetail, StudioNarrationRevisionInput,
  StudioSceneResourceRevisionInput, StudioSceneRevisionInput, StudioSpendAuthorizationInput, StudioSpendRejectionInput, StudioVisualReinspectionInput } from "../../shared/api.js";
import { studioApi, subscribeToRun } from "../api.js";
import { pendingLocalReviewCommand, observePendingLocalReviewCommand, submitLocalReviewCommand } from "../review-continuation-command.js";
import { createRunRead } from "../run-read-coalescer.js";
import { currentScriptArtifact, sceneNarrationText } from "../scene-narration.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { RunWorkbench } from "../components/RunWorkbench.js";
import { CreativeDiscussionPanel } from "../components/CreativeDiscussionPanel.js";
import { CreativeReviewHistoryPanel } from "../components/CreativeReviewHistoryPanel.js";
import { MultiPlatformPublishDialog } from "../components/MultiPlatformPublishDialog.js";

export function preferRunSnapshot(current: StudioRunDetail | undefined, next: StudioRunDetail): StudioRunDetail {
  if (!current || current.id !== next.id) return next;
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
    ...(next.optionalReviewTasks === undefined && current.optionalReviewTasks !== undefined
      ? { optionalReviewTasks: current.optionalReviewTasks } : {}),
    ...(next.reviewContinuationTargets === undefined && current.reviewContinuationTargets !== undefined
      ? { reviewContinuationTargets: current.reviewContinuationTargets } : {}),
    ...(next.optionalReviewUncertaintySafe === undefined && current.optionalReviewUncertaintySafe !== undefined
      ? { optionalReviewUncertaintySafe: current.optionalReviewUncertaintySafe } : {}),
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
  // 切作品时所有本页状态/异步回调归原实例；旧请求不能覆盖新作品或带入旧费用/编辑框。
  return <RunPageContent key={runId} runId={runId} />;
}

function RunPageContent({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const [run, setRun] = useState<StudioRunDetail>();
  const latestRun = useRef(run);
  latestRun.current = run;
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
  const [hasUnsavedCreativeEdits, setHasUnsavedCreativeEdits] = useState(false);
  const [creativeHistory, setCreativeHistory] = useState<StudioCreativeReviewHistory>();
  const [creativeCommandPending, setCreativeCommandPending] = useState(false);
  const creativeReviewRequest = useRef(0);
  const currentRunId = useRef(runId);
  currentRunId.current = runId;
  useEffect(() => {
    currentRunId.current = runId;
    setCreativeCommandPending(false);
    return () => {
      currentRunId.current = "";
      creativeReviewRequest.current += 1;
    };
  }, [runId]);
  const eventRefreshTimer = useRef<number | undefined>(undefined);
  const lastRunEventAt = useRef(Date.now());
  const lastRunEvent = useRef<string | undefined>(undefined);
  const paidSummaryRequest = useRef(0);
  const reconciliationRequests = useRef(new Map<string, {
    reconciliationId: string;
    expectedRunRevision: number;
  }>());
  const uncertainPaidNodeId = run?.nodes.find((node) => node.outcomeUncertain === true)?.id;

  const reads = useMemo(() => ({
    run: createRunRead(() => studioApi.run(runId), (nextRun) => {
      if (nextRun.id !== runId) throw new Error("制作详情与当前作品不匹配");
      setRun(current => preferRunSnapshot(current, nextRun));
    }, (caught, surfaceError) => {
      if (surfaceError) setError(`${isTerminal(latestRun.current?.status) ? "最终状态" : "制作"}详情读取失败：${caught instanceof Error ? caught.message : String(caught)}。请刷新页面重读，不会重新执行模型或付费任务。`);
    }),
    cost: createRunRead(() => studioApi.runCosts(runId), (detail) => {
      if (detail.runId !== runId) throw new Error("费用明细与当前作品不匹配");
      setCostDetail(detail);
      setCostError(undefined);
    }, caught => setCostError(`调用与费用明细读取失败：${caught instanceof Error ? caught.message : String(caught)}`)),
  }), [runId]);
  const refreshCosts = useCallback(() => reads.cost.request(), [reads]);
  const refreshRunSnapshot = useCallback((surfaceError = false) => reads.run.request(surfaceError), [reads]);

  useEffect(() => {
    reads.run.activate();
    reads.cost.activate();
    return () => { reads.run.dispose(); reads.cost.dispose(); };
  }, [reads]);

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

  useEffect(() => {
    if (!run || !isTerminal(run.status)) return;
    if (eventRefreshTimer.current !== undefined) {
      window.clearTimeout(eventRefreshTimer.current);
      eventRefreshTimer.current = undefined;
    }
    // 终态事件会关闭 SSE；关闭前立即补读一次权威详情，避免诊断只在手动刷新后出现。
    void refreshRunSnapshot(true);
    void refreshCosts();
  }, [runId, isTerminal(run?.status), refreshRunSnapshot, refreshCosts]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void refreshRunSnapshot(true).finally(() => { if (active) setLoading(false); });
    void refreshCosts();
    void studioApi.providers().then(value => { if (active) setRunProviders(value); }).catch(() => {});
    return () => { active = false; };
  }, [refreshRunSnapshot, refreshCosts]);

  useEffect(() => {
    // 命令在途的 running 事件可能暂时不含人工停点。保留原讨论组件与输入，
    // 由原 commandId 的完成回执更新稿件；卸载重挂会抢先读取尚未清理的恢复记录。
    if (creativeCommandPending && run?.id === runId) return;
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
  }, [runId, run, creativeCommandPending]);

  useEffect(() => {
    if (!run || creativeCommandPending) return;
    let active = true;
    void studioApi.creativeReviewHistory(runId).then((history) => {
      if (active) setCreativeHistory(history);
    }).catch(() => {
      if (active) setCreativeHistory(undefined);
    });
    return () => { active = false; };
  }, [runId, run?.revision, creativeReview?.reviewRevision, creativeCommandPending]);

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
        if (currentRunId.current !== runId || nextRun.id !== runId) return;
        const eventIdentity = JSON.stringify(nextRun);
        if (lastRunEvent.current === eventIdentity) return;
        lastRunEvent.current = eventIdentity;
        setRun((current) => preferRunSnapshot(current, nextRun));
        lastRunEventAt.current = Date.now();
        setConnectionHeartbeatAt(new Date().toISOString());
        if (!isTerminal(nextRun.status) && eventRefreshTimer.current === undefined) {
          eventRefreshTimer.current = window.setTimeout(() => {
            eventRefreshTimer.current = undefined;
            void refreshRunSnapshot();
            void refreshCosts();
          }, 1_000);
        }
        setConnectionWarning(undefined);
      },
      () => setConnectionWarning("实时连接暂时中断，正在自动重连。你也可以刷新页面读取最新进度。"),
      (at) => {
        setConnectionHeartbeatAt(at);
        setConnectionWarning(undefined);
      },
    );
  }, [runId, run !== undefined, isTerminal(run?.status), refreshRunSnapshot, refreshCosts]);

  useEffect(() => () => {
    if (eventRefreshTimer.current !== undefined) window.clearTimeout(eventRefreshTimer.current);
  }, [runId]);

  const executionPending = run?.status === "running" || decisionPending || nodeMutationPending || creativeCommandPending;
  useEffect(() => {
    if (!executionPending) return;
    // SSE 有实际进度时让事件触发更新；无事件时详情按 2/4/8/10s 退避，费用只作 10s 兜底。
    // 定时器不提交任何制作命令，也不因读取失败改变服务端任务状态。
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - lastRunEventAt.current >= 2_000 && reads.run.due(reads.run.retryDelay())) void refreshRunSnapshot();
      if (reads.cost.due(10_000)) void refreshCosts();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [executionPending, reads, refreshRunSnapshot, refreshCosts]);

  // T10.4：页面隐藏暂停兜底读取；恢复可见时补一轮权威快照与费用。
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden || currentRunId.current !== runId) return;
      void refreshRunSnapshot();
      void refreshCosts();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [runId, refreshRunSnapshot, refreshCosts]);

  async function decide(input: StudioDecisionInput) {
    setDecisionPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => input.commandId
        ? submitLocalReviewCommand(runId, { kind: "decision", input: { ...input, commandId: input.commandId } })
        : studioApi.decide(runId, input));
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
          const independentAudit = input.action === "audit_current" && operation.commandId === input.commandId
            && operation.status === "unknown" && operation.independentDraftActionsAllowed === true;
          // C1（收尾包 §5.4.3）：原 discuss/revise 已 unknown 且服务端证明当前稿可独立
          // 处理时，结束本页无效 busy 轮询——原请求走“核对上一条操作”查询，不再等它。
          const independentConsultation = (input.action === "discuss" || input.action === "revise")
            && operation.commandId === input.commandId && operation.status === "unknown"
            && operation.independentDraftActions?.actions?.length;
          if (operation.status === "running" || (operation.status === "unknown" && !independentAudit && !independentConsultation)) {
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
            continue;
          }
          const requestId = ++creativeReviewRequest.current;
          const nextRun = await refreshRunSnapshot(true);
          if (!nextRun) throw new Error("操作结果已保存，但详情暂时读不到；请查询原操作，不要重复生成。");
          const review = nextRun.activeIntervention?.kind === "creative_review"
            ? await studioApi.creativeReview(runId) : undefined;
          if (currentRunId.current !== runId) throw new Error("已离开原作品；请返回查看操作结果。");
          if (requestId === creativeReviewRequest.current) setCreativeReview(review);
          setRun((current) => preferRunSnapshot(current, nextRun));
          if (operation.status === "not_accepted") {
            throw Object.assign(new Error("这次操作未受理，没有执行；当前稿件已保留，请查看当前方案后重新选择。"), { commandCompleted: true });
          }
          if (operation.status === "failed") {
            throw Object.assign(new Error("这次创作操作未成功，当前稿已保留。请查看失败原因和恢复选项；不会自动重复生成。"), { commandCompleted: true });
          }
          return operation;
        }
        throw new Error("原创作任务仍在处理。请稍后查询，不要重复生成。");
      };
      return await observe();
    } catch (caught) {
      throw caught;
    } finally {
      if (currentRunId.current === runId) {
        setCreativeCommandPending(false);
        void refreshCosts();
      }
    }
  }

  async function requestSceneRevision(input: StudioSceneRevisionInput) {
    setDecisionPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.requestSceneRevision(runId, input));
      setRun((current) => preferRunSnapshot(current, nextRun));
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      // 确认框须收到拒绝，保留当前决定并显示原因，不能将失败当作已提交而关闭。
      throw caught;
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

  async function reviseNodeDocument(nodeId: string, input: { instruction: string; expectedRunRevision: number; expectedVersionId: string; confirmTerminalEdit?: boolean }) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.reviseNodeDocument(runId, nodeId, input);
      setRun((current) => preferRunSnapshot(current, nextRun));
      await refreshCosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function auditNodeDocument(nodeId: string, input: { expectedRunRevision: number; expectedVersionId: string }) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.auditNodeDocument(runId, nodeId, input);
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function authorizeProductionScope(input: import("../../shared/api.js").StudioProductionAuthorizationInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.authorizeProductionScope(runId, input));
      setRun(current => preferRunSnapshot(current, nextRun));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function amendProductionScope(authorizationId: string, input: import("../../shared/api.js").StudioProductionAmendmentInput) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await withMutationProgress(() => studioApi.amendProductionScope(runId, authorizationId, input));
      setRun(current => preferRunSnapshot(current, nextRun));
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
      const nextRun = await withMutationProgress(() => studioApi.retryFailedNode(runId, nodeId, nodeId === "voice" ? run?.nativeAudioRecovery : undefined));
      setRun((current) => preferRunSnapshot(current, nextRun));
      setConnectionWarning(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function prepareReviewContinuation(input: import("../../shared/api.js").StudioReviewContinuationInput) {
    setNodeMutationPending(true); setError(undefined);
    try {
      const next = await submitLocalReviewCommand(runId, { kind: "prepare", input });
      setRun(current => preferRunSnapshot(current, next));
      await refreshRunSnapshot();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); throw caught; }
    finally { setNodeMutationPending(false); }
  }

  async function observeLocalReviewCommand(continueOriginal = false) {
    setNodeMutationPending(true); setError(undefined);
    try {
      const next = await observePendingLocalReviewCommand(runId, continueOriginal);
      if (next) setRun(current => preferRunSnapshot(current, next));
      else setError("原本地操作仍已受理，尚未完成；请稍后查看。不会自动重发模型或媒体请求。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setNodeMutationPending(false); }
  }

  async function queryOriginalTextTask(target?: import("../../shared/api.js").StudioOptionalReviewTarget) {
    setNodeMutationPending(true);
    setError(undefined);
    try {
      const nextRun = await studioApi.queryOriginalTextTask(runId, target);
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
      await refreshPaidNode(nextRun.nodes.find((node) => node.outcomeUncertain === true)?.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setNodeMutationPending(false);
    }
  }

  async function withMutationProgress(operation: () => Promise<StudioRunDetail>): Promise<StudioRunDetail> {
    try {
      return await operation();
    } finally {
      // 失败回包也可能已有费用；结束只刷新账务，不重放 mutation。
      void refreshCosts();
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
      {pendingLocalReviewCommand(runId) ? <section className="task-recovery-panel" aria-label="原本地决定状态">
        <p>上一条准备或风险决定已保留原编号与输入；先查看状态，不要换编号重复确认。</p>
        <button type="button" className="button button-secondary" disabled={nodeMutationPending || decisionPending} onClick={() => void observeLocalReviewCommand()}>查看上次决定状态</button>
        <button type="button" className="button button-secondary" disabled={nodeMutationPending || decisionPending} onClick={() => void observeLocalReviewCommand(true)}>按原操作继续</button>
      </section> : null}
      {costError ? <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{costError}</div> : null}
      {paidOperationError ? <div className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{paidOperationError}</div> : null}
      <RunWorkbench run={run} onRunUpdated={next => { if (next.id === currentRunId.current) setRun(current => preferRunSnapshot(current, next)); }} {...(hasUnsavedCreativeEdits ? { assetConfigurationBlockedReason: "请先保存或放弃当前稿件的手动修改，再调整画面来源。" } : {})} creativeDiscussion={creativeReview ? <CreativeDiscussionPanel nativeAudio={run.audioMode === "native_av"} key={`${run.id}:${creativeReview.stage}:${creativeReview.reviewPurpose ?? "draft"}`} review={creativeReview} busy={creativeCommandPending || nodeMutationPending || decisionPending || creativeReview.phase === "checking"} onDraftDirtyChange={setHasUnsavedCreativeEdits} onCommand={commandCreativeReview} providers={runProviders} /> : undefined} providers={runProviders} decisionPending={decisionPending} onDecision={decide} onRequestSceneRevision={requestSceneRevision} onRequestSceneResourceRevision={requestSceneResourceRevision} onRequestNarrationRevision={requestNarrationRevision} onLoadSceneNarration={loadSceneNarration} onReinspectVisualReview={reinspectVisualReview} onOpenPublish={() => setPublishing(true)} onRestart={() => void beginRestart()} {...(costDetail ? { costDetail } : {})} {...(paidNodeSummary ? { paidNodeSummary } : {})} {...(connectionHeartbeatAt ? { connectionHeartbeatAt } : {})} nodeMutationPending={nodeMutationPending || creativeCommandPending} pausePending={pausePending} onOverrideNode={overrideNode} onOverrideNodeInput={overrideNodeInput} onReviseNodeDocument={reviseNodeDocument} onAuditNodeDocument={auditNodeDocument} onConfigureNode={configureNode} onAuthorizeSpend={authorizeSpend} onAuthorizeProductionScope={authorizeProductionScope} onAmendProductionScope={amendProductionScope} onRejectSpend={rejectSpend} onRegenerateStale={regenerateStale} onRequestPause={requestPause} onResumePaused={resumePaused} onQueryOriginalTextTask={queryOriginalTextTask} onPrepareReviewContinuation={prepareReviewContinuation} onRetrieveOriginalTextTask={retrieveOriginalTextTask} onRetryFailedNode={retryFailedNode} onReconcilePaidNode={reconcilePaidNode} />
      {creativeHistory ? <CreativeReviewHistoryPanel nativeAudio={run.audioMode === "native_av"} history={creativeHistory} /> : null}
      {publishing ? <MultiPlatformPublishDialog runId={run.id} onClose={() => setPublishing(false)} /> : null}
      <NewRunDialog
        open={restarting}
        providers={restartProviders}
        {...(restartSettings ? { creatorSettings: restartSettings } : {})}
        {...(restartDraft ? {
          initialValues: restartDraft.input,
          inheritedNodeIds: restartDraft.inheritedNodeIds,
          requiredAffectedScenePositions: restartDraft.requiredAffectedScenePositions,
          ...(restartDraft.scopePrompt ? { scopePrompt: restartDraft.scopePrompt } : {}),
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
