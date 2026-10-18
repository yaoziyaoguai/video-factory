import { ArrowLeft, Check, FilePenLine, MessageCircle, PanelRightClose, RotateCcw, Save, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { stageHandoffIdentityChanged } from "../film-arrival.js";
import { studioApi } from "../api.js";
import {
  clearCreativeSessionFields,
  creativeSessionSlotKey,
  creativeSessionStorage,
  importLegacyCreativeEdit,
  importLegacyCreativeMessage,
  readCreativeSessionRecord,
  readCreativeSessionSlot,
  writeCreativeSessionFields,
  type CreativeDraftSessionBase,
} from "../creative-draft-session.js";
import { CreativeDraft, CreativeDraftReader } from "./CreativeDraftReader.js";
import { CreativeDraftChanges } from "./CreativeDraftChanges.js";
import { CreativeWorkspacePanels } from "./CreativeWorkspacePanels.js";
import { CreativeDurationPanel, durationSecondsLabel } from "./CreativeDurationPanel.js";
import { CharacterScriptEditor, isCharacterDocument } from "./CharacterScriptEditor.js";
import type { StudioCreativeReviewCommandInput, StudioCreativeReviewCommandReceipt, StudioCreativeReviewSnapshot } from "../../shared/api.js";
import { parseStudioCreativeReviewCommandInput } from "../../shared/api.js";
import type { DurationAmendment } from "@video-factory/production-pipeline/executable-timeline";

export { CreativeDraft } from "./CreativeDraftReader.js";

interface CreativeDiscussionPanelProps {
  review: StudioCreativeReviewSnapshot;
  busy: boolean;
  nativeAudio?: boolean;
  onDraftDirtyChange?: (dirty: boolean) => void;
  onCommand(input: StudioCreativeReviewCommandInput): Promise<void | StudioCreativeReviewCommandReceipt>;
  /** CLOUD-11/P5.2：run 的服务目录（来自 RunPage runProviders），供“素材安排待补齐”筛选兼容来源。 */
  providers?: Array<{
    id: string;
    capability: string;
    label: string;
    available: boolean;
    kind?: string;
    deliveryTypes?: string[];
  }>;
}

// 与 PlanningStagesPanel 的阶段名保持一致。这里曾经把 treatment 写成"导演方案"、
// 把 director 写成"分镜与画面方案"，于是同一个停点的标题和提示各说各的名字。
const STAGE_LABEL = { treatment: "前期构思", script: "脚本", director: "导演方案" } as const;

// 应用内风险确认：打开时冻结用户看到的稿件/复核身份与完整命令体。
// 弹窗期间身份变化就拒绝提交（提示重新查看），不能把旧文案当作新身份发出去。
interface PendingRiskConfirm {
  kind: "confirm" | "return";
  dialogLabel: string;
  lines: string[];
  actionLabel: string;
  identity: {
    runId: string;
    stage: StudioCreativeReviewSnapshot["stage"];
    reviewPurpose?: StudioCreativeReviewSnapshot["reviewPurpose"];
    runRevision: number;
    reviewRevision: number;
    draftSha256: string;
    draftVersionId?: string;
    briefSha256?: string;
    checkIdentity?: string;
    allowedActions: StudioCreativeReviewSnapshot["allowedActions"];
  };
  command: StudioCreativeReviewCommandInput;
}

export function CreativeDiscussionPanel({ review, busy, onCommand, onDraftDirtyChange, providers = [], nativeAudio = false }: CreativeDiscussionPanelProps) {
  const purposeKey = review.reviewPurpose ?? "draft";
  // 旧版按版本号写 localStorage 的草稿 key：只作一次性只读导入来源，不再写入。
  const storageKey = `vf:creative-draft:${review.runId}:${review.stage}:${purposeKey}${review.draftVersionId ? `:${review.draftVersionId}` : ""}`;
  const commandStorageKey = `vf:creative-command:${review.runId}:${review.stage}:${purposeKey}`;
  const currentCommandStorageKey = useRef(commandStorageKey);
  currentCommandStorageKey.current = commandStorageKey;
  // 未保存意见/编辑文字按标签会话保存：key 不含版本号，标签之间互不可见。
  const sessionSlotKey = creativeSessionSlotKey(review.runId, review.stage, purposeKey);
  const sessionBase: CreativeDraftSessionBase = {
    runId: review.runId,
    stage: review.stage,
    purposeKey,
    ...(review.draftVersionId ? { versionId: review.draftVersionId } : {}),
    ...(review.draftArtifactId ? { artifactId: review.draftArtifactId } : {}),
    ...(review.draftSha256 ? { draftSha256: review.draftSha256 } : {}),
  };
  const currentStorageKey = useRef(sessionSlotKey);
  currentStorageKey.current = sessionSlotKey;
  const [message, setMessage] = useState(() => {
    const { storage } = creativeSessionStorage();
    // C3：导入写失败不谎报持久成功——如实提示本机草稿无法保存。
    if (importLegacyCreativeMessage({ session: storage, legacy: window.localStorage, sessionKey: sessionSlotKey, base: sessionBase, legacyKey: storageKey }) === "failed") {
      queueMicrotask(() => setStorageBroken(true));
    }
    return readCreativeSessionSlot(storage, sessionSlotKey)?.message ?? "";
  });
  const messageSequence = useRef(0);
  useEffect(() => { messageSequence.current += 1; }, [message, sessionSlotKey]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedAuditIndexes, setSelectedAuditIndexes] = useState<number[]>([]);
  const [error, setError] = useState<string>();
  const [completionNotice, setCompletionNotice] = useState<string>();
  const [pendingCommandId, setPendingCommandId] = useState<string | undefined>(() => {
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(commandStorageKey) ?? "null");
      return saved && typeof saved === "object" && typeof (saved as { commandId?: unknown }).commandId === "string"
        ? (saved as { commandId: string }).commandId : undefined;
    } catch { return undefined; }
  });
  const [reconcilingCommand, setReconcilingCommand] = useState(false);
  // 待核原请求不接受新模型操作；文字仍可编辑，服务端证明的三类稿件决定另行核验。
  // 本机指针整理后仍以耐久记录为准，不能因刷新或独立手改就重新开放讨论。
  const hasUnresolvedOperation = pendingCommandId !== undefined || review.pendingConsultation !== undefined
    || review.consultationOperations?.some(operation => operation.status === "running"
      || operation.status === "unknown" && operation.command.action !== "audit_current") === true;
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const [editingDuration, setEditingDuration] = useState(false);
  useEffect(() => { onDraftDirtyChange?.(hasUnsavedEdits || editingDuration); }, [hasUnsavedEdits, editingDuration, onDraftDirtyChange]);
  useEffect(() => () => onDraftDirtyChange?.(false), [onDraftDirtyChange]);
  const [mobileTab, setMobileTab] = useState<"draft" | "discussion">("draft");
  const [discussionOpen, setDiscussionOpen] = useState(true);
  const [storageBroken, setStorageBroken] = useState(false);
  const [pendingRisk, setPendingRisk] = useState<PendingRiskConfirm | null>(null);
  const [exitingRisk, setExitingRisk] = useState<PendingRiskConfirm | null>(null);
  const lastRiskRef = useRef<PendingRiskConfirm | null>(null);
  useEffect(() => {
    if (pendingRisk) {
      lastRiskRef.current = pendingRisk;
      setExitingRisk(null);
      return;
    }
    if (!lastRiskRef.current) return;
    setExitingRisk(lastRiskRef.current);
    lastRiskRef.current = null;
    const timer = window.setTimeout(() => setExitingRisk(null), 120);
    return () => window.clearTimeout(timer);
  }, [pendingRisk]);
  const [identityStale, setIdentityStale] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const discussionFocusFrameRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (discussionFocusFrameRef.current !== undefined) window.cancelAnimationFrame(discussionFocusFrameRef.current);
  }, []);
  function changeDiscussionOpen(open: boolean) {
    if (discussionFocusFrameRef.current !== undefined) window.cancelAnimationFrame(discussionFocusFrameRef.current);
    discussionFocusFrameRef.current = undefined;
    setDiscussionOpen(open);
    if (!open) setMobileTab("draft");
  }
  function changeWorkspacePane(pane: "draft" | "discussion") {
    if (discussionFocusFrameRef.current !== undefined) window.cancelAnimationFrame(discussionFocusFrameRef.current);
    discussionFocusFrameRef.current = undefined;
    setMobileTab(pane);
  }
  function focusDiscussion(target: "composer" | "advice") {
    setDiscussionOpen(true);
    setMobileTab("discussion");
    if (discussionFocusFrameRef.current !== undefined) window.cancelAnimationFrame(discussionFocusFrameRef.current);
    discussionFocusFrameRef.current = window.requestAnimationFrame(() => {
      const element = target === "composer" ? composerRef.current : document.getElementById("creative-advice-title");
      element?.focus({ preventScroll: true });
      element?.scrollIntoView?.({ block: target === "composer" ? "center" : "nearest" });
      discussionFocusFrameRef.current = undefined;
    });
  }
  function focusRevisionDiscussion() {
    focusDiscussion("composer");
  }
  const followMessagesRef = useRef(true);
  const [unseenMessages, setUnseenMessages] = useState(false);
  // 只让当前 run 内的新稿件触发交接；切换 run 是新的观察基线。
  const [stageHandoffActive, setStageHandoffActive] = useState(false);
  const [handoffNotice, setHandoffNotice] = useState(false);
  const seenRunIdRef = useRef<string | null>(null);
  const seenDraftIdentityRef = useRef<string | null>(null);
  const stageHandoffTimerRef = useRef<number | undefined>(undefined);
  const stageHandoffFrameRef = useRef<number | undefined>(undefined);
  const draftIdentity = `${review.stage}:${purposeKey}:${review.draftVersionId ?? review.draftArtifactId}:${review.draftSha256}`;
  useEffect(() => {
    if (seenRunIdRef.current !== review.runId) {
      seenRunIdRef.current = review.runId;
      seenDraftIdentityRef.current = draftIdentity;
      setStageHandoffActive(false);
      setHandoffNotice(false);
      if (stageHandoffFrameRef.current !== undefined) window.cancelAnimationFrame(stageHandoffFrameRef.current);
      if (stageHandoffTimerRef.current !== undefined) window.clearTimeout(stageHandoffTimerRef.current);
      return;
    }
    const next = stageHandoffIdentityChanged(seenDraftIdentityRef.current, draftIdentity);
    seenDraftIdentityRef.current = next.seen;
    if (!next.changed) return;
    setStageHandoffActive(false);
    setHandoffNotice(true);
    if (stageHandoffFrameRef.current !== undefined) window.cancelAnimationFrame(stageHandoffFrameRef.current);
    stageHandoffFrameRef.current = window.requestAnimationFrame(() => setStageHandoffActive(true));
    if (stageHandoffTimerRef.current !== undefined) window.clearTimeout(stageHandoffTimerRef.current);
    stageHandoffTimerRef.current = window.setTimeout(() => {
      setStageHandoffActive(false);
      setHandoffNotice(false);
    }, 900);
  }, [draftIdentity, review.runId]);
  useEffect(() => () => {
    if (stageHandoffFrameRef.current !== undefined) window.cancelAnimationFrame(stageHandoffFrameRef.current);
    if (stageHandoffTimerRef.current !== undefined) window.clearTimeout(stageHandoffTimerRef.current);
  }, []);
  // M3 讨论消息：只给挂载后新到的消息做入场动画；历史消息初始化不逐条飞入。
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(() => new Set());
  const seenMessageIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seenMessageIdsRef.current === null) {
      seenMessageIdsRef.current = new Set(review.messages.map((entry) => entry.id));
      return;
    }
    const fresh = review.messages.filter((entry) => !seenMessageIdsRef.current!.has(entry.id));
    if (fresh.length === 0) return;
    for (const entry of fresh) seenMessageIdsRef.current!.add(entry.id);
    setNewMessageIds((current) => {
      const next = new Set(current);
      for (const entry of fresh) next.add(entry.id);
      return next;
    });
  }, [review.messages]);
  const closeRiskDialog = () => { setPendingRisk(null); setIdentityStale(false); };
  const riskDialogRef = useDialogFocus<HTMLDivElement>(pendingRisk !== null, closeRiskDialog);
  const hasBlockingIssues = review.blockingIssues.length > 0;
  const processing = busy || review.phase === "checking";
  const evidenceRepairs = review.stage === "treatment" ? review.draftValidation?.issues ?? [] : [];
  const hasMissingEvidenceProvider = evidenceRepairs.length > 0;
  const hasUnavailableEvidenceProvider = evidenceRepairs.some((issue) => compatibleEvidenceProviders(
    providers, issue.acquisition ?? "pipeline_generated", review.draftValidation?.allowedRetrievalProviderIds,
  ).options.length === 0);
  // 草稿一变 publishCreativeDraft 必然清空 checkResult，所以在场的 repair 一定是针对当前草稿的。
  // 复核是"提议"而不是"否决"：此时确认仍然可用，但必须由人显式承担，并把被接受的意见记进
  // confirmation.acknowledgedRepair，事后能查到是谁在什么结论下放行的。
  const awaitingRepair = review.checkResult?.verdict === "repair";
  const hasContentSuggestions = (review.checkResult?.issues.length ?? 0) > 0;
  const incompleteCheck = review.checkResult?.status === "incomplete";
  const auditIssueIdentity = `${review.runId}:${review.stage}:${purposeKey}:${review.draftVersionId ?? review.draftArtifactId}:${review.draftSha256}:${review.checkResult?.checkIdentity ?? "unreviewed"}`;
  const qualityAdvisories = review.qualityAdvisories ?? [];
  const needsStockConsent = review.stage === "director" && review.reviewPurpose !== "direction" && qualityAdvisories.length > 0;
  const adoptionObject = review.reviewPurpose === "direction" ? "导演初稿" : review.reviewPurpose === "material_plan" ? "选材方案" : STAGE_LABEL[review.stage];
  const currentAuditPending = review.consultationOperations?.some(operation => operation.command.action === "audit_current"
    && (operation.status === "running" || operation.status === "unknown") && operation.command.stage === review.stage
    && operation.command.baseDraftSha256 === review.draftSha256
    && operation.command.baseDraftVersionId === review.draftVersionId) === true;
  const scriptAdoptionLabel = review.stage === "script" && review.duration?.proposal
    ? `采用此脚本 · 约${durationSecondsLabel(review.duration.proposal.totalSeconds)}秒${incompleteCheck ? "（审计未完成）" : !review.checkResult ? "（未审计）" : hasContentSuggestions ? "（保留审计建议）" : ""}` : undefined;
  const commandBase = useMemo(() => ({
    expectedRunRevision: review.runRevision,
    expectedReviewRevision: review.reviewRevision,
    stage: review.stage,
    ...(review.reviewPurpose ? { reviewPurpose: review.reviewPurpose } : {}),
    baseDraftSha256: review.draftSha256,
    ...(review.draftVersionId ? { baseDraftVersionId: review.draftVersionId } : {}),
  }), [review]);

  function releaseCompletedConsultation(command: StudioCreativeReviewCommandInput, key = commandStorageKey) {
    const saved = readPendingCommand(key);
    if (saved && !sameCommandIdentity(saved, command)) {
      if (currentCommandStorageKey.current === key) setPendingCommandId(current => current === command.commandId ? saved.commandId : current);
      throw new Error("本机操作记录已变化，请核对正确的操作；不会覆盖或发送另一条命令。");
    }
    // 核对和删除之间没有await；完成A不能整理后来B或同ID异body的记录。
    if (saved) window.localStorage.removeItem(key);
    if (currentCommandStorageKey.current === key) setPendingCommandId(current => current === command.commandId ? undefined : current);
  }

  useEffect(() => {
    // 查询期间父页面可能重挂面板；已核终态从耐久证明同步，不能仅依赖旧实例回调。
    // 失败/未受理也已核清，但不等于成功；只整理匹配指针，保留原文且不自动重发。
    const settled = review.consultationOperations?.find(operation => operation.commandId === pendingCommandId
      && (operation.status === "completed" || operation.status === "failed" || operation.status === "not_accepted"));
    if (!settled) return;
    try { releaseCompletedConsultation(settled.command); }
    catch { setCompletionNotice("原请求已核清，但本机恢复记录尚未整理；请核对原操作，不需要重新生成。当前输入已保留。"); }
  }, [pendingCommandId, commandStorageKey, review.consultationOperations]);

  useEffect(() => {
    // 换 run/阶段/用途是新的讨论上下文，读该上下文自己的会话槽；
    // 同一上下文内服务端换版本不重置用户输入（DG-UX-01）。
    const { storage } = creativeSessionStorage();
    setMessage(readCreativeSessionSlot(storage, sessionSlotKey)?.message ?? "");
    setSelectedIds([]);
  }, [sessionSlotKey]);

  useEffect(() => setSelectedAuditIndexes([]), [auditIssueIdentity]);
  // C4（收尾包）：selection 生命周期与意见持久槽分离——绑定 run/stage/purpose 与完整
  // 稿件身份同时核版本、产物与内容；缺版本明确留在legacy域。身份任一变化（含同 SHA 的
  // A→B→A′）清空旧 scene/beat 范围；同身份的普通 rerender/SSE revision 不清用户选择。
  useEffect(() => setSelectedIds([]), [`${review.runId}:${review.stage}:${purposeKey}:${review.draftVersionId ?? "legacy"}:${review.draftArtifactId}:${review.draftSha256}`]);

  const auditSuggestions = review.checkResult?.status !== "incomplete" ? review.checkResult?.issues.map((issue, index) => ({
    index,
    text: (issue.creatorAction ?? issue.repairInstruction).trim(),
    title: issue.creatorTitle ?? issue.creatorAction ?? issue.repairInstruction,
  })) ?? [] : [];
  // 输入文字是唯一真源：刷新、手改、换版都不依赖另一份未持久化的建议队列。
  const includedSuggestions = auditSuggestions.filter((suggestion, index, suggestions) => suggestion.text
    && suggestions.findIndex(item => item.text === suggestion.text) === index && containsSuggestion(message, suggestion.text));
  const discussionScope = selectedIds.length > 0
    ? `指定范围：${selectionOptions(review.stage, review.draft).filter(option => selectedIds.includes(option.id)).map(option => option.label).join("、")}`
    : "全稿讨论";

  function appendAuditSuggestions() {
    if (!review.checkResult || review.checkResult.status === "incomplete" || selectedAuditIndexes.length === 0) return;
    const additions = [...new Set(auditSuggestions.filter(suggestion => selectedAuditIndexes.includes(suggestion.index))
      .map(suggestion => suggestion.text).filter(text => text && !containsSuggestion(message, text)))];
    const next = [message.trimEnd(), ...additions.map((value) => `- ${value}`)].filter(Boolean).join("\n");
    if (next.length > 4000) {
      setError("加入后会超过 4,000 字，请删减当前文字或少选几条；原输入已保留。");
      return;
    }
    setMessage(next);
    setSelectedAuditIndexes([]);
    focusRevisionDiscussion();
  }

  useEffect(() => {
    // 意见文字写进本标签会话槽；无法持久时明确提示，不承诺刷新后可恢复。
    const { storage, durable } = creativeSessionStorage();
    const ok = message
      ? writeCreativeSessionFields(storage, sessionSlotKey, sessionBase, { message })
      : clearCreativeSessionFields(storage, sessionSlotKey, ["message"]);
    if (!ok || !durable) setStorageBroken(true);
    // sessionBase 是每次渲染的派生值，仅在写入时取当次身份，不作为触发条件。
  }, [message, sessionSlotKey]);

  // 新消息只在用户本就靠近底部时跟随滚动；否则提供入口，不抢走正在阅读的位置。
  useEffect(() => {
    const list = messageListRef.current;
    if (!list || review.messages.length === 0) return;
    if (followMessagesRef.current) list.scrollTop = list.scrollHeight;
    else setUnseenMessages(true);
  }, [review.messages.length]);

  async function submit(input: StudioCreativeReviewCommandInput, clearMessage = false) {
    const sentMessageSequence = messageSequence.current;
    setError(undefined);
    setCompletionNotice(undefined);
    // 待发命令的读取失败不能当成"没有未决命令"：此时发出命令可能无法可靠重放。
    let pending: StudioCreativeReviewCommandInput | undefined;
    try {
      pending = readPendingCommand(commandStorageKey) ?? undefined;
    } catch {
      setError("本机存储暂不可用，无法可靠记录待发命令；请恢复浏览器存储后再发送。");
      throw new Error("本机存储暂不可用，无法可靠记录待发命令。");
    }
    // C1（收尾包 §5.4）：原 unknown 讨论/修订命令仍在时，服务端证明过的用户确定性
    // 动作（手改/采用/返回）用新 commandId 放行——执行时服务端仍按完整身份与 CAS
    // 重新核；其余新命令继续等待原命令核清，不能用本地指针冒充服务端证明。
    const pendingConsultation = review.pendingConsultation;
    const independentlyAllowed = pendingConsultation !== undefined && pendingConsultation.commandId === pending?.commandId
      && (input.action === "edit_draft" || input.action === "confirm" || input.action === "return_to_stage" || input.action === "update_duration")
      && pendingConsultation.allowedActions.includes(input.action) === true;
    if (pending && !independentlyAllowed && !sameCommandBody(pending, input)) {
      setError("上一条操作的结果尚未核清，不能用新操作覆盖它。请先核对上一条操作。");
      throw new Error("上一条创作操作尚未核清。");
    }
    if (pending && independentlyAllowed) {
      // 先保存只查询引用，再释放当前指针；整理失败不发送新动作。
      try { window.localStorage.setItem(`vf:creative-consultation-command:${review.runId}:${pending.commandId}`, JSON.stringify(pending)); }
      catch { setError("原讨论恢复记录未能保存，新动作没有发送；当前输入已保留。"); throw new Error("原命令恢复记录未保存。"); }
    }
    const command = independentlyAllowed ? input : pending ?? input;
    try {
      window.localStorage.setItem(commandStorageKey, JSON.stringify(command));
      setPendingCommandId(command.commandId);
    } catch {
      setError("本机存储暂不可用，命令没有发送；请恢复浏览器存储后重试。");
      throw new Error("本机存储暂不可用，命令没有发送。");
    }
    try {
      const receipt = await onCommand(command);
      if (receipt && receipt.commandId !== command.commandId) throw new Error("返回的操作编号不一致，原命令仍待核实。请核对原操作，不要重复发送。");
      if (canRetainIndependentAudit(command, receipt)) {
        retainIndependentAudit(command);
        return false;
      }
      if (receipt?.status === "unknown" || receipt?.status === "running") {
        setCompletionNotice(receipt.status === "running"
          ? "操作已受理，正在处理；完成后会自动更新。"
          : "原操作结果仍未确定；原命令与输入已保留，请核对原请求，不要重复发送。原请求与费用保持待核。");
        return false;
      }
    } catch (caught) {
      if (caught instanceof Error && "commandCompleted" in caught && caught.commandCompleted === true) {
        try {
          releaseCompletedConsultation(command);
        } catch { setCompletionNotice("操作已完成，但本机恢复记录尚未整理；当前输入已保留，不需要重新生成。"); }
      }
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
    let cleaned = true;
    try {
      releaseCompletedConsultation(command);
    } catch {
      cleaned = false;
    }
    if (!cleaned) {
      setCompletionNotice("操作已完成，本机恢复记录未清理；不需要重发。");
      return false;
    }
    if (clearMessage && currentStorageKey.current === sessionSlotKey && messageSequence.current === sentMessageSequence) {
      setMessage((current) => current === message ? "" : current);
    }
    return true;
  }

  function retainIndependentAudit(command: StudioCreativeReviewCommandInput) {
    try {
      // 原未知审计的完整命令留作恢复记录；只释放当前命令指针，不宣称原请求完成或取消。
      window.localStorage.setItem(`vf:creative-audit-command:${review.runId}:${command.commandId}`, JSON.stringify(command));
      releaseCompletedConsultation(command);
      setCompletionNotice("原审计结果仍待核，记录已保留。你可以修订或采用当前稿件；原请求和费用请在待核审计区查询，不会自动重发。");
    } catch {
      setError("原审计仍待核，本机恢复记录未能整理；请先核对上一条操作，不要覆盖或重发。当前输入已保留。");
    }
  }

  async function reconcilePendingCommand() {
    if (!pendingCommandId || reconcilingCommand) return;
    setReconcilingCommand(true);
    setError(undefined);
    try {
      // 查询前冻结原完整body；返回后不从共享槽借用另一条命令。
      const saved = readPendingCommand(commandStorageKey);
      if (!saved || saved.commandId !== pendingCommandId || saved.stage !== review.stage || (saved.reviewPurpose ?? "draft") !== purposeKey) {
        setError("本机操作记录已变化或缺少原命令，请刷新核对正确的操作；不会重新发送。");
        return;
      }
      const receipt = await studioApi.creativeReviewCommand(review.runId, saved.commandId);
      if (receipt.commandId !== saved.commandId) throw new Error("返回的操作编号与原命令不一致。");
      if (currentCommandStorageKey.current !== commandStorageKey) return;
      const current = readPendingCommand(commandStorageKey);
      if (current && !sameCommandIdentity(current, saved)) {
        setPendingCommandId(current.commandId);
        setError("本机操作记录已变化，请核对正确的操作；不会覆盖或发送另一条命令。");
        return;
      }
      if (current && canRetainIndependentAudit(saved, receipt)) {
        retainIndependentAudit(saved);
        return;
      }
      if (receipt.status === "running") {
        setCompletionNotice("上一条操作仍在处理；请稍后核对，不要再次发送。");
        return;
      }
      if (receipt.status === "unknown") {
        // C1（收尾包 §5.4.1）：显式核对用保存的原完整命令（含原 revision）走恢复
        // 入口；服务端该分支只观察原物理请求（observePrepared），不重建信封、不重投。
        if (!current) {
          setCompletionNotice("本机没有保存原命令，无法发起核对；请刷新页面重新发现原操作。");
          return;
        }
        try {
          // 同 ID 同 body：走恢复入口（服务端只观察原物理请求），不经新命令构造。
          const resolved = await onCommand(saved);
          if (resolved && resolved.commandId !== saved.commandId) throw new Error("返回的操作编号与原命令不一致。");
          if (resolved && (resolved.status === "completed" || resolved.status === "failed" || resolved.status === "not_accepted")) {
            setCompletionNotice(resolved.status !== "completed" ? "原操作已核清但未完成，当前稿件与输入保留，请查看后决定下一步。"
              : resolved.resultDisposition === "recorded_not_applied"
              ? "原请求此后已完成；结果只保留在原命令记录里，未应用到当前稿。"
              : "原请求已完成并应用到当前稿；请查看最新方案。");
            try {
              releaseCompletedConsultation(saved);
            } catch { setCompletionNotice("原操作已核清，但本机恢复记录尚未整理；当前输入已保留，不需要重新生成。"); }
          } else {
            setCompletionNotice("原操作结果仍未确定；当前稿可独立处理（手动修改/采用/返回），原请求与费用保持待核。");
          }
        } catch (caught) {
          // onCommand 内部已展示错误；原命令与输入保留，不重发。
          if (caught instanceof Error && "commandCompleted" in caught && caught.commandCompleted === true) {
            try { releaseCompletedConsultation(saved); }
            catch { setCompletionNotice("原操作已完成，但本机恢复记录尚未整理；不需要重新生成。"); }
          }
        }
        return;
      }
      try {
        releaseCompletedConsultation(saved);
      } catch {
        setCompletionNotice(receipt.status === "completed"
          ? "上一条操作已完成，但本机恢复记录未清理；不需要重发，请刷新查看当前方案。"
          : "上一条操作已失败，但本机恢复记录未清理；请刷新查看失败原因，不要直接重发。");
        return;
      }
      setCompletionNotice(receipt.status === "not_accepted"
        ? "已核实上一条操作未受理，没有执行；当前稿件保留，请查看后重新选择。"
        : receipt.status === "completed"
        ? "上一条操作已完成。请刷新查看当前方案，再继续讨论。"
        : "上一条操作已失败，当前稿件保留。请刷新查看失败原因后决定下一步。");
    } catch {
      setError("暂时无法核对上一条操作，记录已保留；不要发送新操作。稍后再核对。");
    } finally {
      setReconcilingCommand(false);
    }
  }

  async function reconcileConsultation(command: StudioCreativeReviewCommandInput) {
    if (busy || reconcilingCommand) return;
    setReconcilingCommand(true);
    setError(undefined);
    try {
      // 服务端耐久记录返回的原body；此POST只观察原请求，绝不构造当前revision的新信封。
      const receipt = await onCommand(command);
      if (receipt && receipt.commandId !== command.commandId) throw new Error("返回的操作编号与原命令不一致。");
      if (receipt?.status === "completed") {
        setCompletionNotice(receipt.resultDisposition === "recorded_not_applied"
          ? "原请求已完成，回复已归档；当前稿件和你的决定没有改变。"
          : "原讨论已完成，请查看最新回复。");
        releaseCompletedConsultation(command);
      } else setCompletionNotice("原请求与费用仍待核；记录已保留，不会重复发送。");
    } catch { setError("暂时无法取回原讨论结果，原命令与当前输入已保留；请稍后核对。"); }
    finally { setReconcilingCommand(false); }
  }

  function sendMessage(action: "discuss" | "revise" = "discuss") {
    const text = message.trim();
    if (!text || busy || hasUnresolvedOperation || !review.allowedActions.includes(action)) return;
    if (text.length > 4000) {
      setError("修改意见不能超过 4,000 字；请删减后再发送，原输入已保留。");
      return;
    }
    void submit({
      action,
      commandId: crypto.randomUUID(),
      ...commandBase,
      message: text,
      ...(selectedIds.length ? { selection: creativeSelection(selectedIds) } : {}),
    }, true).catch(() => undefined);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== "Enter" || !event.ctrlKey) return;
    event.preventDefault();
    sendMessage("discuss");
  }

  function openConfirmRisk(durationAmendment?: DurationAmendment) {
    const lines = [
      ...(durationAmendment ? ["本次将一并修改时长要求并采用当前稿；变更后的版本未重新审计，原审计意见仍保留。"] : []),
      ...(!review.checkResult ? ["本版尚未审计。继续表示采用未审稿，同时接受下列素材风险；不会自动补审。"] : []),
      ...(awaitingRepair ? ["独立复核对当前这一版提出了意见，还没有通过。"] : []),
      ...(incompleteCheck ? ["独立复核没有得到有效结论。这不是审查通过，也没有质量评分；你可以承担未完成复核的风险采用本版。"] : []),
      ...(needsStockConsent ? ["当前示意素材匹配得分较低或视觉核验未完成。接受后先制作首版，原始评分与问题会保留；不会扩大费用授权，也不会将示意画面用作真实事件证据。"] : []),
      "继续会保留你的采用决定。",
    ];
    setIdentityStale(false);
    setPendingRisk({
      kind: "confirm",
      dialogLabel: "接受素材风险，先制作首版？",
      lines,
      actionLabel: "接受素材风险，先制作首版",
      identity: {
        runId: review.runId,
        stage: review.stage,
        reviewPurpose: review.reviewPurpose,
        runRevision: review.runRevision,
        reviewRevision: review.reviewRevision,
        draftSha256: review.draftSha256,
        ...(review.draftVersionId ? { draftVersionId: review.draftVersionId } : {}),
        ...(review.duration ? { briefSha256: review.duration.briefSha256 } : {}),
        ...(review.checkResult ? { checkIdentity: review.checkResult.checkIdentity } : {}),
        allowedActions: review.allowedActions,
      },
      command: {
        action: "confirm",
        commandId: crypto.randomUUID(),
        ...commandBase,
        // 把界面上这一条复核的身份原样带回去：确认要指向人看到的意见，不能指向服务端
        // 此刻恰好记着的那一条。
        ...(review.checkResult ? { expectedCheckIdentity: review.checkResult.checkIdentity } : {}),
        ...(!review.checkResult || durationAmendment ? { acknowledgeUnaudited: true as const } : {}),
        ...(durationAmendment ? { durationAmendment } : {}),
        ...(awaitingRepair ? { acknowledgeRepair: true } : {}),
        ...(incompleteCheck ? { acknowledgeIncomplete: true as const } : {}),
        ...(needsStockConsent ? { acceptQualityFallback: true as const } : {}),
      },
    });
  }

  async function confirmWithDuration(durationAmendment: DurationAmendment) {
    if (busy || hasMissingEvidenceProvider || hasUnsavedEdits || !review.allowedActions.includes("confirm")
      || !review.allowedActions.includes("update_duration")) return false;
    if (needsStockConsent) {
      openConfirmRisk(durationAmendment);
      return false;
    }
    return submit({ action: "confirm", commandId: crypto.randomUUID(), ...commandBase, durationAmendment,
      acknowledgeUnaudited: true,
      ...(review.checkResult ? { expectedCheckIdentity: review.checkResult.checkIdentity } : {}),
      ...(awaitingRepair ? { acknowledgeRepair: true as const } : {}),
      ...(incompleteCheck ? { acknowledgeIncomplete: true as const } : {}),
    });
  }

  function confirmDraft() {
    if (busy || hasMissingEvidenceProvider || hasUnsavedEdits || editingDuration || review.conflicts?.length || !review.allowedActions.includes("confirm")) return;
    if (needsStockConsent) {
      openConfirmRisk();
      return;
    }
    void submit({
      action: "confirm",
      commandId: crypto.randomUUID(),
      ...commandBase,
      ...(review.checkResult ? { expectedCheckIdentity: review.checkResult.checkIdentity } : {}),
      ...(!review.checkResult ? { acknowledgeUnaudited: true as const } : {}),
      ...(awaitingRepair ? { acknowledgeRepair: true as const } : {}),
      ...(incompleteCheck ? { acknowledgeIncomplete: true as const } : {}),
    }).catch(() => undefined);
  }

  function auditCurrent() {
    if (busy || hasUnresolvedOperation || currentAuditPending || hasUnsavedEdits || !review.allowedActions.includes("audit_current")) return;
    void submit({ action: "audit_current", commandId: crypto.randomUUID(), ...commandBase }).catch(() => undefined);
  }

  function returnToStage(target: StudioCreativeReviewSnapshot["returnTargets"][number]) {
    if (busy || hasUnsavedEdits || !review.allowedActions.includes("return_to_stage")) return;
    setIdentityStale(false);
    setPendingRisk({
      kind: "return",
      dialogLabel: `确定${target.label}吗？`,
      lines: [target.impact, "确认不会自动跨过新阶段的人工门禁。"],
      actionLabel: "仍然返回",
      identity: {
        runId: review.runId,
        stage: review.stage,
        reviewPurpose: review.reviewPurpose,
        runRevision: review.runRevision,
        reviewRevision: review.reviewRevision,
        draftSha256: review.draftSha256,
        ...(review.draftVersionId ? { draftVersionId: review.draftVersionId } : {}),
        ...(review.duration ? { briefSha256: review.duration.briefSha256 } : {}),
        ...(review.checkResult ? { checkIdentity: review.checkResult.checkIdentity } : {}),
        allowedActions: review.allowedActions,
      },
      command: {
        action: "return_to_stage",
        commandId: crypto.randomUUID(),
        ...commandBase,
        targetStage: target.stage,
        acknowledgeImpact: true,
      },
    });
  }

  // 确认时逐项核对弹窗打开时的身份：任何一项变了都不提交，让用户重新查看最新内容。
  function resolvePendingRisk() {
    if (!pendingRisk || busy) return;
    const identity = pendingRisk.identity;
    const stillCurrent = identity.runId === review.runId
      && identity.stage === review.stage
      && identity.reviewPurpose === review.reviewPurpose
      && identity.runRevision === review.runRevision
      && identity.reviewRevision === review.reviewRevision
      && identity.draftSha256 === review.draftSha256
      && identity.draftVersionId === review.draftVersionId
      && identity.briefSha256 === review.duration?.briefSha256
      && (identity.checkIdentity ?? null) === (review.checkResult?.checkIdentity ?? null)
      && review.allowedActions.includes(pendingRisk.kind === "confirm" ? "confirm" : "return_to_stage");
    if (!stillCurrent) {
      setIdentityStale(true);
      return;
    }
    const command = pendingRisk.command;
    setPendingRisk(null);
    setIdentityStale(false);
    void submit(command).catch(() => undefined);
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

  // 脚本样板调整唯一时长和决定区的位置，不复制编辑器或改变命令。
  const durationPanel = <CreativeDurationPanel key={`${review.runId}:${review.stage}:${purposeKey}`} review={review} busy={busy || hasUnsavedEdits}
      decisionNoteAtAdoption={review.stage === "script"}
      onEditingChange={setEditingDuration} onAdopt={confirmWithDuration}
      onSave={amendment => submit({ action: "update_duration", commandId: crypto.randomUUID(), ...commandBase, durationAmendment: amendment })} />;
  const decisionBar = <section className="creative-review-actions creative-decision-bar" id="creative-confirm-footer" aria-label="当前稿件决定">
      <div className="creative-confirm-context" tabIndex={-1}><strong>{hasUnsavedEdits ? "有未保存的手动修改" : hasMissingEvidenceProvider ? "先补齐素材安排，再决定采用" : review.reviewPurpose === "direction" ? "确认对象：当前导演初稿" : review.reviewPurpose === "material_plan" ? "确认对象：当前选材方案" : `确认对象：当前${STAGE_LABEL[review.stage]}`}</strong><small>{hasUnsavedEdits ? "先保存或放弃修改，再确认采用；不会提交编辑器里的未保存文字。" : hasMissingEvidenceProvider ? "这里只缺画面服务安排，不是审计建议在阻止采用。修订保存后，由你决定是否审计或采用。" : review.stage === "script" && review.duration ? `${review.duration.proposal ? "采用同时确认本版时长" : "参考目标不代表已确认时长"}；${review.checkResult ? "不重复审计" : "本版未审计，你仍可明确采用"}。费用待方案核价，后续付费仍需单独确认。` : review.checkResult ? "采用不会重复审计当前稿，也不会授权购买素材；后续付费仍需单独确认。" : "本版尚未审计。你可主动审计，也可明确采用未审稿；后续付费仍需单独确认。"}</small></div>
      <div className="creative-decision-buttons">
        <button type="button" className={`button ${hasMissingEvidenceProvider ? "button-secondary" : "button-primary"}`} disabled={busy || hasMissingEvidenceProvider || hasUnsavedEdits || editingDuration || Boolean(review.conflicts?.length) || !review.allowedActions.includes("confirm")} onClick={confirmDraft}><Check aria-hidden="true" size={16} />{hasMissingEvidenceProvider ? "补齐画面服务后再采用" : scriptAdoptionLabel ?? (needsStockConsent ? "采用选材方案（接受素材风险）" : incompleteCheck ? `采用${adoptionObject}（复核未完成）` : hasContentSuggestions ? `采用${adoptionObject}（保留审计建议）` : !review.checkResult ? `采用${adoptionObject}（未审计）` : hasBlockingIssues ? "修改后重新检查" : review.reviewPurpose === "direction" ? "采用导演初稿，开始选材" : review.reviewPurpose === "material_plan" ? "采用选材方案，继续制作" : `采用当前${adoptionObject}，继续`)}</button>
        <button type="button" className={`button ${hasMissingEvidenceProvider ? "button-primary" : "button-secondary"}`} onClick={focusRevisionDiscussion}><MessageCircle aria-hidden="true" size={16} />提出修改</button>
      </div>
    </section>;

  return (
    <section className="creative-discussion-panel" data-creative-stage={review.stage} aria-labelledby="creative-review-title">
      <header className={`creative-discussion-header${stageHandoffActive ? " stage-handoff" : ""}`}>
        <div>
          <h2 className="creative-current-draft-title" id="creative-review-title">{processing ? `正在处理${STAGE_LABEL[review.stage]}，当前稿件已保留` : hasBlockingIssues ? "当前导演方案需要你决定" : review.reviewPurpose === "direction" ? "导演初稿已就绪，等你决定" : review.reviewPurpose === "material_plan" ? "选材方案已就绪，等你决定" : `${STAGE_LABEL[review.stage]}已生成，等你确认`}</h2>
          {hasBlockingIssues ? <p>自动选材尚未通过，具体原因见下方。已保留你确认的方案，不会自动改成生成画面；请在讨论区说明允许怎样调整，或补充素材。</p> : null}
          {review.reviewPurpose === "direction" && !processing ? <p>你可以和导演继续讨论；只有采用这版初稿后，才会开始寻找候选画面。</p> : null}
          {processing ? <p>下方保留操作前的稿件供查看。正在查询原操作，具体制作阶段见进度区，请勿重复提交。</p> : null}
          {review.reviewPurpose === "material_plan" ? <p>请查看选材结果与风险；这次决定不会自动扩大素材采购授权。</p> : null}
          <p className="creative-audit-status">{review.checkResult?.status === "incomplete" ? "审计未取得结论" : review.checkResult ? "本版已审计" : "本版未审计"}</p>
        </div>
        {review.checkResult && review.checkResult.status !== "incomplete" && review.checkResult.issues.length > 0 ? <button type="button" className="button button-ghost creative-advice-jump" onClick={() => focusDiscussion("advice")}>查看 {review.checkResult.issues.length} 条建议</button> : null}
        <span className={`creative-review-phase phase-${review.phase}`}>
          {processing ? "正在处理原操作" : "等你决定"}
        </span>
      </header>

      {hasMissingEvidenceProvider ? <section className="creative-validation-notice" role="alert">
        <strong>素材安排待补齐</strong>
        <p>{evidenceRepairs.map((issue) => `第 ${issue.index + 1} 项素材安排还没选择画面服务，暂不能采用这版`).join("；")}。当前稿件和讨论已保留。{hasUnavailableEvidenceProvider
          ? "部分素材在本制作没有可选的对应画面服务，请用“提出修改”调整素材安排，优先使用本制作已启用的来源。"
          : "请展开“手动修订这份稿件”，在“素材安排待补齐”里选择服务后保存。"}</p>
        <details className="creative-validation-tech"><summary>技术详情</summary>
          <ul>{evidenceRepairs.map((issue) => <li key={issue.path}>{issue.technicalDetail}</li>)}</ul>
        </details>
      </section> : null}

      {review.stage === "script" ? <div className="creative-script-overview">{durationPanel}</div> : null}

      <CreativeWorkspacePanels activePane={mobileTab} onPaneChange={changeWorkspacePane} discussionOpen={discussionOpen}
        onDiscussionOpenChange={changeDiscussionOpen} messageCount={review.messages.length}
        draft={<article id="creative-draft" tabIndex={0} className={`creative-draft-surface${stageHandoffActive ? " stage-handoff" : ""}`} aria-label={`当前${STAGE_LABEL[review.stage]}`}>
          {stageHandoffActive ? <i className="stage-handoff-rule" aria-hidden="true" /> : null}
          {handoffNotice ? <p className="creative-handoff-notice" role="status">当前稿件已更新</p> : null}
          <CreativeDraftReader key={`${review.runId}:${draftIdentity}:${review.draftArtifactId}`} stage={review.stage} value={review.draft} nativeAudio={nativeAudio} />
          <CreativeDraftEditor nativeAudio={nativeAudio} sessionSlotKey={sessionSlotKey} sessionBase={sessionBase} legacyEditStorageKey={`${storageKey}:edit`} draftIdentity={`${review.draftVersionId ?? review.draftArtifactId}:${review.draftSha256}`} stage={review.stage} draft={review.draft} busy={busy || review.phase === "checking" || !review.allowedActions.includes("edit_draft")} onSave={saveEditedDraft} onDirtyChange={setHasUnsavedEdits} evidenceRepairs={evidenceRepairs} providers={providers} allowedRetrievalProviderIds={review.stage === "treatment" ? review.draftValidation?.allowedRetrievalProviderIds : undefined} />
          {review.previousDraft !== undefined ? <CreativeDraftChanges key={`${review.runId}:${draftIdentity}`} stage={review.stage}
            current={review.draft} previous={review.previousDraft} nativeAudio={nativeAudio} /> : null}
          {review.reviewPurpose === "material_plan" && review.candidatePreviews?.length ? <section className="creative-candidate-previews" aria-label="候选画面预览">
            <h3>先看候选画面</h3><p>每镜显示排序靠前的 3 个候选。这里是预览，是否通过机器视觉核验单独标注。</p>
            {review.candidatePreviews.map(scene => <div key={scene.scenePosition}><h4>镜头 {scene.scenePosition}</h4>
              <div className="creative-candidate-grid">{scene.candidates.map(candidate => <CandidatePreview key={`${candidate.provider}:${candidate.assetId}`} candidate={candidate} />)}</div>
            </div>)}
          </section> : null}
          {review.stage !== "script" ? <>{durationPanel}{decisionBar}</> : null}
          {incompleteCheck ? <section className="creative-check-result" role="status"><strong>独立复核未完成 · 无评分</strong><p>{review.checkResult?.summary}</p></section> : null}
          {needsStockConsent ? <section className="creative-check-result" role="status">
            <strong>可以先制作首版，但请了解素材风险</strong>
            <ul>{qualityAdvisories.map((issue, index) => <li key={index}>镜头 {issue.scenePositions.join("、")}：{issue.reason}</li>)}</ul>
            <p>接受不会改分、不会伪装成已核验，也不增加费用授权。你仍可以先讨论调整方案。</p>
          </section> : null}
          {selectionOptions(review.stage, review.draft).length > 0 ? <details className="creative-selection-disclosure"><summary>指定讨论范围{selectedIds.length > 0 ? ` · 已选 ${selectedIds.length} 项` : "（可选）"}</summary><CreativeSelection
            stage={review.stage}
            draft={review.draft}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
          /></details> : null}
          <div className="creative-secondary-decisions">
            {review.previousDraft !== undefined ? <button type="button" className="button button-ghost" disabled={busy || hasUnresolvedOperation || hasUnsavedEdits || !review.allowedActions.includes("undo_draft")} onClick={() => void submit({ action: "undo_draft", commandId: crypto.randomUUID(), ...commandBase }).catch(() => undefined)}><RotateCcw aria-hidden="true" size={16} />撤销本轮修改</button> : null}
            <button type="button" className="button button-ghost" disabled={busy || hasUnresolvedOperation || currentAuditPending || hasUnsavedEdits || !review.allowedActions.includes("audit_current")} onClick={auditCurrent}>{review.checkResult ? "重新审计当前版本（会调用模型）" : "审计当前版本（会调用模型）"}</button>
          </div>
          <a href="#creative-review-history">查看完整创作版本记录</a>
          {/* 停在这里是因为自动循环推不动了，不是这一版做完了。不说出来，人会以为一切正常。 */}
          {review.stopDetail && !(review.reviewContinuation?.reasonCode.startsWith("discussion_")
            && review.stopDetail === review.reviewContinuation.detail) ? <section className="creative-check-result" role="status">
            <strong>需要你决定下一步</strong>
            <p>{review.stopDetail}</p>
          </section> : null}
          {review.reviewContinuation?.reasonCode.startsWith("discussion_") ? <section className="creative-check-result" role="status">
            <strong>{review.reviewContinuation.status === "unknown"
              ? "原讨论或修改仍在核实"
              : review.reviewContinuation.status === "completed_not_applied"
                ? "原讨论或修改此后已完成，未应用到当前稿"
                : "这次讨论或修改没有完成"}</strong>
            <p>{review.reviewContinuation.detail}</p>
            {review.reviewContinuation.status === "unknown" && review.pendingConsultation
              ? <p>原请求待核期间，你可以先处理当前稿：手动修改、采用或返回（原请求与费用保持待核，核对原操作只查询、不重发）；不会自动重试或换模型。</p>
              : review.reviewContinuation.status === "unknown"
                ? <p>原请求待核；请稍后核对原操作。当前稿的独立处理入口待服务端确认本地无活跃写者后开放；不会自动重试或换模型。</p>
                : <p>当前稿件未改动，仍可编辑、讨论或采用；不会自动重试或换模型。</p>}
          </section> : null}
          {review.scopeConflict ? <section className="creative-check-result" role="status">
            <strong>新方案超出了这次批准的返工范围</strong>
            <p>涉及镜头 {review.scopeConflict.requiredScenePositions.join("、") || "当前方案"}。当前仍是旧方案；你可以采用旧方案继续，或回到来源制作重新选择范围。扩大范围后仍须查看新报价，不能沿用旧费用授权。</p>
            <a className="button button-secondary" href={`/projects/${encodeURIComponent(review.scopeConflict.sourceRunId)}`}>返回来源制作，调整返工范围</a>
          </section> : null}
          {hasBlockingIssues ? <section className="creative-check-result" role="status">
            <strong>素材选择需要你处理</strong>
            <ul>{review.blockingIssues.map((issue, index) => <li key={`${issue.reason}:${index}`}>
              <strong>{issue.scenePositions.length > 0 ? `镜头 ${issue.scenePositions.join("、")}` : "当前方案"}</strong>
              <span>{issue.reason}。{issue.requiredChange}</span>
            </li>)}</ul>
          </section> : null}
          {review.proposals.map((proposal) => <section className="creative-proposal" key={proposal.proposalId}>
            <header><strong>{review.scopeConflict?.proposalId === proposal.proposalId ? "越界新稿 · 仅供比较" : "备选方案"}</strong><small>{proposal.changeSummary.join("；") || "可与当前方案比较"}</small></header>
            {proposal.duration ? <p>此备选约 {durationSecondsLabel(proposal.duration.totalSeconds)} 秒（{proposal.duration.totalFrames} 帧），共 {proposal.duration.scenes.length} 镜。</p>
              : review.stage === "script" ? <p>此备选的逐镜时长暂不可核对；不能用参考目标代替。</p> : null}
            {review.duration ? <p>备选仍受当前时长要求约束：{review.duration.commitment
              ? [review.duration.commitment.minSeconds === undefined ? null : `至少 ${durationSecondsLabel(review.duration.commitment.minSeconds)} 秒`,
                review.duration.commitment.maxSeconds === undefined ? null : `最多 ${durationSecondsLabel(review.duration.commitment.maxSeconds)} 秒`].filter(Boolean).join("，")
              : "未设硬性范围"}。</p> : null}
            <CreativeDraft stage={review.stage} value={proposal.document} nativeAudio={nativeAudio} />
            {proposal.conflicts?.length ? <div role="status">
              <strong>这份草稿仍有待处理的冲突</strong>
              <ul>{proposal.conflicts.map((conflict, index) => <li key={`${conflict.code}:${index}`}>{conflict.detail}</li>)}</ul>
              <p>{proposal.conflicts.some(conflict => conflict.code === "execution_capability_conflict")
                ? "设为当前草稿后，请调整分镜或素材安排；取消时长要求不能扩大素材能力。"
                : "设为当前草稿后，可修改稿件，或修改、取消时长要求。"}</p>
            </div> : null}
            {review.scopeConflict?.proposalId === proposal.proposalId ? <p>这份新稿尚未被采用；调整返工范围并重新报价前不能使用。</p>
              : <><p>设为当前草稿只切换编辑对象，不会确认本阶段或开始后续制作。</p>
                <button type="button" className="button button-secondary" disabled={busy || hasUnresolvedOperation || hasUnsavedEdits || editingDuration || !review.allowedActions.includes("adopt_proposal")} onClick={() => void submit({ action: "adopt_proposal", commandId: crypto.randomUUID(), ...commandBase, proposalId: proposal.proposalId }).catch(() => undefined)}>设为当前草稿</button></>}
          </section>)}
        </article>}
        discussion={<section id="creative-chat" className="creative-chat-surface" aria-label="与当前角色讨论">
          <header className="creative-discussion-pane-header"><h3>建议与讨论</h3>
            <button type="button" className="icon-button" aria-label="收起讨论" title="收起讨论，专注读稿" onClick={() => changeDiscussionOpen(false)}><PanelRightClose aria-hidden="true" size={18} /></button>
          </header>
          <p className="creative-discussion-context">当前{STAGE_LABEL[review.stage]} · {discussionScope}</p>
          {review.checkResult && review.checkResult.status !== "incomplete" && review.checkResult.issues.length > 0 ? <section className="creative-check-result creative-advice-panel" aria-labelledby="creative-advice-title">
            <header><h3 id="creative-advice-title" tabIndex={-1}>本版建议</h3><span>{review.checkResult.issues.length} 条</span></header>
            <p className="creative-advice-scope">全稿建议</p>
            <p>{review.checkResult.summary}</p>
            <ul>{review.checkResult.issues.map((issue, index) => <li key={`${review.checkResult?.checkIdentity}:${index}`}>
              <label><input type="checkbox" checked={selectedAuditIndexes.includes(index) || containsSuggestion(message, (issue.creatorAction ?? issue.repairInstruction).trim())} disabled={busy || containsSuggestion(message, (issue.creatorAction ?? issue.repairInstruction).trim())} aria-label={issue.creatorAction ?? issue.repairInstruction} onChange={(event) => setSelectedAuditIndexes((current) => event.target.checked ? [...current, index] : current.filter((value) => value !== index))} />
                <span>{issue.creatorTitle ?? issue.creatorAction ?? issue.repairInstruction}</span>
                {containsSuggestion(message, (issue.creatorAction ?? issue.repairInstruction).trim()) ? <small>已加入</small> : null}
              </label>
              <details className="creative-advice-detail"><summary>查看依据与修改建议</summary>
                {issue.creatorObservation ? <small>{issue.creatorObservation}</small> : issue.evidence ? <small>{issue.evidence}</small> : null}
                {issue.creatorTitle && issue.creatorAction ? <p>{issue.creatorAction}</p> : null}
              </details>
            </li>)}</ul>
            <button type="button" className="button button-secondary" disabled={busy || selectedAuditIndexes.length === 0} onClick={appendAuditSuggestions}>加入修改意见（{selectedAuditIndexes.length}）</button>
          </section> : null}
          {includedSuggestions.length > 0 ? <section className="creative-added-advice" aria-label="已加入的修改意见">
            <strong>已加入修改意见 · {includedSuggestions.length} 条</strong>
            <ul>{includedSuggestions.map(suggestion => <li key={suggestion.text}><span>{suggestion.title}</span>
              <button type="button" className="button button-ghost" aria-label={`移除已加入建议：${suggestion.title}`} onClick={() => {
                // 只移除仍然完整存在的原条目；用户改写的意见不再匹配，不擅自删除。
                setMessage(current => removeSuggestion(current, suggestion.text));
              }}>移除</button>
            </li>)}</ul>
            <small>仍是未发送的文字，可在下面自由修改；选择或移除不会改稿。</small>
          </section> : null}
          <label className="creative-composer">
            <span>讨论与修改</span>
            <textarea ref={composerRef} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="描述你想保留或修改的内容，也可以先讨论。" />
            <small>只讨论不改稿；发送修订意见才会修改。Ctrl + Enter 只讨论。</small>
          </label>
          {hasUnresolvedOperation ? <p className="creative-composer-pending" role="status">
            <span>原操作仍在处理或待核，暂不另发讨论或修订。当前输入不会发送或清空。</span>{" "}
            {review.consultationOperations?.length ? <a href="#creative-request-records">查看原请求与核对入口</a> : null}
          </p> : null}
          <div className="creative-composer-actions">
            <button type="button" className="button button-secondary" disabled={busy || hasUnresolvedOperation || !message.trim() || !review.allowedActions.includes("discuss")} onClick={() => sendMessage("discuss")}><Send aria-hidden="true" size={16} />{busy ? "正在处理…" : "只讨论"}</button>
            <button type="button" className="button button-primary" disabled={busy || hasUnresolvedOperation || !message.trim() || !review.allowedActions.includes("revise")} onClick={() => sendMessage("revise")}>发送修订意见</button>
          </div>
          <header className="creative-chat-heading"><MessageCircle aria-hidden="true" size={17} /><strong>交互记录</strong></header>
          <div className="creative-message-list" aria-live="polite" ref={messageListRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              followMessagesRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
              if (followMessagesRef.current) setUnseenMessages(false);
            }}>
            {review.messages.length === 0 ? <p className="creative-empty-chat"><MessageCircle aria-hidden="true" size={18} />还没有讨论。可以问为什么这样安排，或直接说想改成什么样。</p> : null}
            {review.messages.map((entry) => <div key={entry.id} className={`creative-message message-${entry.role}${newMessageIds.has(entry.id) ? " is-new" : ""}`} onAnimationEnd={() => setNewMessageIds((current) => { if (!current.has(entry.id)) return current; const next = new Set(current); next.delete(entry.id); return next; })}><span>{entry.role === "user" ? "你" : "创作角色"}</span>{entry.role !== "user" && entry.text.length > 400
              ? <details className="creative-long-reply"><summary>{entry.text.slice(0, 160)}…<br /><strong>展开完整回复（{entry.text.length} 字）</strong></summary><p>{entry.text}</p></details>
              : entry.text}</div>)}
          </div>
          {unseenMessages ? <button type="button" className="creative-unseen-messages" onClick={() => {
            const list = messageListRef.current;
            if (list) list.scrollTop = list.scrollHeight;
            followMessagesRef.current = true;
            setUnseenMessages(false);
          }}>有新消息，查看 ↓</button> : null}
          {review.consultationOperations?.length ? <aside id="creative-request-records" className="creative-request-records" aria-label="原讨论与修改请求">
            {review.consultationOperations.map(operation => {
              const audit = operation.command.action === "audit_current";
              const originalText = "message" in operation.command ? operation.command.message : undefined;
              const alreadyShown = review.messages.some(entry => entry.role === "user" && entry.commandId === operation.commandId);
              return <details key={operation.commandId} className={`creative-request-record is-${operation.status}`} open={operation.status !== "completed"}>
                <summary>{audit ? "文字审计" : operation.command.action === "revise" ? "稿件修订" : "创作讨论"} · {STAGE_LABEL[operation.command.stage]} · <span>{operation.status === "running" ? "正在处理原请求" : operation.status === "unknown" ? "暂时无法确认原请求结果"
                  : operation.status === "failed" ? "执行失败 · 结果已核清" : operation.status === "not_accepted" ? "未受理" : "已完成"}</span></summary>
                {originalText && !alreadyShown ? <p className="creative-original-message">{originalText}</p> : null}
                {operation.detail ? <p>{operation.detail}</p> : null}
                {operation.status === "unknown" ? <p>原请求与费用仍待核；核对只查询原请求，不会另发一次。</p> : null}
                {operation.status === "running" ? <p>正在处理原请求，请稍后查看；不会重复发送。原请求费用仍待核，以实际记录为准。</p> : null}
                {operation.status === "failed" || operation.status === "not_accepted" ? <p>当前稿仍保留。你可修改意见后主动发起新的{audit ? "文字审计" : "讨论或修订"}（会调用模型），或处理已有稿件；费用以实际记录为准。</p> : null}
                {operation.resultDisposition === "recorded_not_applied" ? <p>回复只归档于原稿；当前稿和决定未改变。</p> : null}
                {operation.reply && operation.resultDisposition === "recorded_not_applied" ? <p>{operation.reply}</p> : null}
                {operation.status === "unknown" ? <button type="button" className="button button-secondary" disabled={busy || reconcilingCommand}
                  onClick={() => void reconcileConsultation(operation.command)}>{audit ? "核对原文字审计结果" : "核对原讨论结果"}</button> : null}
              </details>;
            })}
          </aside> : null}
        </section>}
      />

      {review.stage === "script" ? <div className="creative-script-decision">{decisionBar}</div> : null}

      {error ? <p className="form-error" role="alert">{error} 输入内容已保留，请查看最新方案后再试。</p> : null}
      {pendingCommandId ? <div className="creative-storage-note" role="status">{processing ? "本次操作已提交，正在等待原结果；不会重复发送。" : "上一条操作结果尚未核清。"}
        <button type="button" className="button button-secondary" disabled={reconcilingCommand || busy} onClick={() => void reconcilePendingCommand()}>
          {reconcilingCommand ? "正在核对…" : "核对上一条操作"}
        </button>
      </div> : null}
      {completionNotice ? <p className="creative-storage-note" role="status">{completionNotice}</p> : null}
      {storageBroken ? <p className="creative-storage-note" role="status">本机草稿无法保存；当前页面内已保留，刷新或关闭可能丢失，请先复制。待发命令也需要浏览器存储恢复后才能发送。</p> : null}
      {review.returnTargets.length > 0 ? <aside className="creative-return-actions" aria-label="返回前期方案">
        <strong>需要调整更早的决定？</strong>
        <p>返回后只让受影响的后续方案失效，历史稿件和已可用素材会保留。</p>
        {review.returnTargets.map((target) => <button key={target.stage} type="button" className="button button-secondary" disabled={busy || hasUnsavedEdits || !review.allowedActions.includes("return_to_stage")} title={target.impact} onClick={() => returnToStage(target)}><ArrowLeft aria-hidden="true" size={16} />{target.label}</button>)}
      </aside> : null}
      {pendingRisk ? <div className="dialog-backdrop" role="presentation">
        <section ref={riskDialogRef} className="decision-dialog creative-risk-dialog" role="dialog" aria-modal="true" aria-labelledby="creative-risk-title" tabIndex={-1}>
          <header className="dialog-header">
            <div><p className="eyebrow">{pendingRisk.kind === "confirm" ? "确认采用" : "返回前期方案"}</p><h2 id="creative-risk-title">{pendingRisk.dialogLabel}</h2></div>
            <button className="icon-button" type="button" onClick={closeRiskDialog} title="关闭"><X aria-hidden="true" size={19} /></button>
          </header>
          <div className="decision-dialog-copy">
            <Check aria-hidden="true" size={22} />
            <div>
              {pendingRisk.lines.map((line) => <p key={line}>{line}</p>)}
              <p className="creative-risk-identity">确认对象：第 {pendingRisk.identity.reviewRevision} 版讨论 · 稿件 {pendingRisk.identity.draftSha256.slice(0, 12)}…{pendingRisk.identity.checkIdentity ? ` · 复核 ${pendingRisk.identity.checkIdentity.slice(0, 12)}…` : ""}</p>
            </div>
          </div>
          {identityStale ? <p className="form-error creative-risk-stale" role="alert">内容已更新，请重新查看后确认。</p> : null}
          <footer className="dialog-actions">
            <button type="button" className="button button-ghost" data-dialog-initial-focus disabled={busy} onClick={closeRiskDialog}>返回查看</button>
            <button type="button" className="button button-primary" disabled={busy} onClick={resolvePendingRisk}>{pendingRisk.actionLabel}</button>
          </footer>
        </section>
      </div> : exitingRisk ? <div className="dialog-backdrop dialog-exit-decoration" aria-hidden="true" inert>
        <div className="decision-dialog creative-risk-dialog"><h2>{exitingRisk.dialogLabel}</h2></div>
      </div> : null}
    </section>
  );
}

function canRetainIndependentAudit(
  command: StudioCreativeReviewCommandInput,
  receipt: void | StudioCreativeReviewCommandReceipt,
): boolean {
  return command.action === "audit_current" && receipt?.commandId === command.commandId
    && receipt.status === "unknown" && receipt.independentDraftActionsAllowed === true;
}

function containsSuggestion(message: string, suggestion: string): boolean {
  return suggestion.length > 0 && `\n${message}\n`.includes(`\n- ${suggestion}\n`);
}

function removeSuggestion(message: string, suggestion: string): string {
  return `\n${message}\n`.replace(`\n- ${suggestion}\n`, "\n").slice(1, -1);
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
  if (stage === "treatment") return [];
  if (stage === "script") return Array.isArray(draft.scenes) ? draft.scenes.flatMap((item, index) => isRecord(item) ? [{ id: String(item.id ?? `scene-${index + 1}`), label: `第 ${Number(item.position ?? index + 1)} 段` }] : []) : [];
  return Array.isArray(draft.shots) ? draft.shots.flatMap((item, index) => isRecord(item) ? [{ id: `scene-${Number(item.scenePosition ?? index + 1)}`, label: `镜头 ${Number(item.scenePosition ?? index + 1)}` }] : []) : [];
}

function creativeSelection(ids: string[]) {
  return {
    kind: "scene" as const,
    ids,
    scenePositions: ids.map((id) => Number(id.replace(/^scene-/, ""))).filter(Number.isInteger),
  };
}

function sameCommandBody(left: StudioCreativeReviewCommandInput, right: StudioCreativeReviewCommandInput): boolean {
  const withoutCommandLeft = { ...left, commandId: "" };
  const rightWithoutId = { ...right, commandId: "" };
  return JSON.stringify(withoutCommandLeft) === JSON.stringify(rightWithoutId);
}

function sameCommandIdentity(left: StudioCreativeReviewCommandInput, right: StudioCreativeReviewCommandInput): boolean {
  return left.commandId === right.commandId && sameCommandBody(left, right);
}

function readPendingCommand(key: string): StudioCreativeReviewCommandInput | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  // 验证沿用HTTP合同，但恢复保留原字段顺序和原revision，不构造新body。
  parseStudioCreativeReviewCommandInput(parsed);
  return parsed as StudioCreativeReviewCommandInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 人工修订编辑器（v1）：只暴露各阶段合同里的**文字性字段**——叙述、承诺、视觉规则的措辞、
 * 每段/每镜的描述文字。镜头增删、路线更换这类结构性改动会牵动排序/报价/画面证据，仍然走
 * 讨论或重新生成；文字修订在这里改完保存，走与 AI 修订相同的制度：换稿 → 停点重现。
 * 需要新审计时由用户主动触发，确认当前稿不会临时补审。
 */
interface EvidenceRepairIssue {
  code: string;
  path: string;
  index: number;
  claim?: string;
  acquisition?: string;
  message: string;
  technicalDetail: string;
}

/** CLOUD-11/P5.2 的兼容来源筛选：capability=asset.prepare、可用、非测试、非 AI 路由器，
 * deliveryTypes 与该素材的取得方式匹配（generated→生成画面；retrievable→图库画面）。
 * 目录缺 deliveryTypes 时不猜兼容，按待配置处理。
 * CR3（2026-10-05 复审）：候选还必须在本制作已选来源集合（allowedRetrievalProviderIds，
 * 来自当前制作的有效 brief）内；集合未投影时不默认全开。浏览器禁选只是第一道筛选，
 * 服务端命令边界对同一集合做权威核验。 */
function compatibleEvidenceProviders<E extends { id: string; capability: string; available: boolean; kind?: string; deliveryTypes?: string[] }>(
  providers: E[], acquisition: string, allowedRetrievalProviderIds: string[] | undefined,
): { options: E[]; catalogIncomplete: boolean } {
  const allowed = acquisition === "pipeline_generated"
    ? ["generated_image", "generated_video"]
    : ["stock_image", "stock_video"];
  const runScope = new Set(allowedRetrievalProviderIds ?? []);
  let catalogIncomplete = false;
  const options = providers.filter((provider) => {
    if (provider.capability !== "asset.prepare" || !provider.available || provider.kind === "test" || provider.id === "ai-shot-router-v1") return false;
    if (!runScope.has(provider.id)) return false;
    if (!provider.deliveryTypes || provider.deliveryTypes.length === 0) {
      catalogIncomplete = true;
      return false;
    }
    return provider.deliveryTypes.some((deliveryType) => allowed.includes(deliveryType));
  });
  return { options, catalogIncomplete };
}

const ACQUISITION_LABEL: Record<string, string> = {
  pipeline_generated: "AI 生成画面",
  pipeline_retrievable: "图库检索画面",
};

function CreativeDraftEditor({ sessionSlotKey, sessionBase, legacyEditStorageKey, draftIdentity, stage, draft, busy, onSave, onDirtyChange, evidenceRepairs = [], providers = [], allowedRetrievalProviderIds, nativeAudio = false }: {
  sessionSlotKey: string;
  sessionBase: CreativeDraftSessionBase;
  legacyEditStorageKey: string;
  draftIdentity: string;
  stage: StudioCreativeReviewSnapshot["stage"];
  draft: unknown;
  busy: boolean;
  nativeAudio?: boolean;
  onSave(document: Record<string, unknown>): Promise<void>;
  onDirtyChange(dirty: boolean): void;
  /** 服务端投影的当前稿缺项（CLOUD-11）；按保存稿列出，选择后随完整文档一起保存。 */
  evidenceRepairs?: EvidenceRepairIssue[];
  providers?: CreativeDiscussionPanelProps["providers"];
  /** CR3：本制作有效画面来源集合的只读投影；缺投影时不默认全开。 */
  allowedRetrievalProviderIds?: string[] | undefined;
}) {
  const draftKey = JSON.stringify({ stage, draftIdentity, draft });
  const [edited, setEdited] = useState<{ baseKey: string; document: Record<string, unknown> } | null>(() => {
    // 旧 localStorage 草稿一次性导入会话槽；此后读写都走本标签会话。
    const { storage } = creativeSessionStorage();
    if (importLegacyCreativeEdit({ session: storage, legacy: window.localStorage, sessionKey: sessionSlotKey, base: sessionBase, legacyEditKey: legacyEditStorageKey, currentBaseKey: draftKey, currentDraft: draft }) === "failed") {
      queueMicrotask(() => setEditStorageBroken(true));
    }
    return readCreativeSessionSlot(storage, sessionSlotKey)?.document ?? null;
  });
  const [open, setOpen] = useState(edited !== null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "failed">();
  const [editStorageBroken, setEditStorageBroken] = useState(false);
  const stale = edited !== null && edited.baseKey !== draftKey;
  useEffect(() => {
    onDirtyChange(edited !== null);
    // 本地文字只用于恢复编辑，不作为服务端采用版本或确认依据。
    const { storage, durable } = creativeSessionStorage();
    const ok = edited
      ? writeCreativeSessionFields(storage, sessionSlotKey, sessionBase, { document: edited })
      : clearCreativeSessionFields(storage, sessionSlotKey, ["document"]);
    setEditStorageBroken(!ok || !durable);
  }, [edited, onDirtyChange, sessionSlotKey]);
  useEffect(() => {
    if (!edited) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited]);
  const fields = useMemo(() => editableTextFields(stage, edited?.document ?? draft), [stage, edited, draft]);
  if (!isRecord(draft) || (fields.length === 0 && !isCharacterDocument(draft))) return null;
  const current = edited?.document ?? draft;
  const dirty = edited !== null;
  return <details className="creative-draft-editor" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><FilePenLine aria-hidden="true" size={14} />手动修订这份稿件{dirty ? " · 有未保存修改" : ""}</summary>
    {/* 收起时不渲染字段：可读稿和编辑器里会出现相同文字，展开才挂载避免同一屏两份同文。 */}
    {open ? <>
      <p className="creative-edit-state" role="status">{stale ? "当前方案已更新。你的未保存文字仍在下方，可先复制留存；请放弃旧稿修改、重新读取当前版本后再编辑。旧稿不能覆盖新稿。" : saving ? "正在保存修订，等待服务端确认…" : saveState === "failed" ? "保存未完成，输入仍保留。请查看错误后重试。" : dirty ? "修改尚未生效；保存后会形成未审新稿，等你决定是否审计或采用。" : saveState === "saved" ? "修订已保存。请核对当前稿，再决定是否审计或采用。" : "可直接修改文字。保存不会自动审计、采用或购买素材。"}</p>
      {stage === "treatment" ? <p className="creative-edit-state">修改正文后，旧稿自动整理的素材要求与制作问题会在保存时清除，后续按新正文规划。</p> : null}
      {evidenceRepairs.length > 0 ? <fieldset className="creative-evidence-repairs">
        <legend>素材安排待补齐</legend>
        <p>以下素材安排还没选择画面服务；选择不会调用外部服务、不报价、不签费用，保存后形成未审新稿。</p>
        {evidenceRepairs.map((issue) => {
          const requirements = Array.isArray(current.evidenceRequirements) ? current.evidenceRequirements : [];
          const entry = requirements[issue.index];
          const selectedValue = typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).retrievalProviderId === "string"
            ? (entry as Record<string, unknown>).retrievalProviderId as string : "";
          const acquisition = issue.acquisition ?? "pipeline_generated";
          const { options, catalogIncomplete } = compatibleEvidenceProviders(providers, acquisition, allowedRetrievalProviderIds);
          return <div key={issue.path} className="creative-evidence-repair-row">
            <span className="creative-evidence-repair-claim">第 {issue.index + 1} 项{issue.claim ? ` · ${issue.claim}` : ""} · {ACQUISITION_LABEL[acquisition] ?? "画面服务"}</span>
            {options.length > 0 ? <label>
              <span>画面服务</span>
              <select aria-label={`第 ${issue.index + 1} 项画面服务`} value={selectedValue} disabled={busy || saving}
                onChange={(event) => {
                  const value = event.target.value;
                  setSaveState(undefined);
                  setEdited({ baseKey: edited?.baseKey ?? draftKey, document: applyEvidenceProviderSelection(structuredClone(current), issue.index, value) });
                }}>
                <option value="">未选择</option>
                {options.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select>
            </label> : <p className="creative-evidence-repair-missing" role="note">当前制作未配置可用的对应画面服务{catalogIncomplete ? "（部分来源信息不完整，暂不能选用）" : ""}；稿件与讨论保留。请用“提出修改”调整素材安排，优先使用本制作已启用的来源；修改全局设置不会自动改变本制作的来源范围。</p>}
          </div>;
        })}
      </fieldset> : null}
      {dirty && editStorageBroken ? <p className="creative-storage-note" role="status">手工修订无法在本机保存；当前页面内已保留，刷新或关闭可能丢失，请先复制。</p> : null}
      {isCharacterDocument(current) ? <CharacterScriptEditor value={current} disabled={busy || saving || stale} nativeAudio={nativeAudio} onChange={(document) => {
        setSaveState(undefined); setEdited({ baseKey: edited?.baseKey ?? draftKey, document: { ...document } });
      }} /> : null}
      {fields.filter((field) => !isCharacterDocument(current) || !field.key.startsWith("scenes.")).map((field) => <label key={field.key} className="creative-edit-field">
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
            try {
              await onSave(edited.document); setEdited(null); setSaveState("saved");
            }
            catch { setSaveState("failed"); }
            finally { setSaving(false); }
          }}
        ><Save aria-hidden="true" size={15} />{saving || busy ? "正在处理…" : "保存修订"}</button>
      </div>
    </> : null}
  </details>;
}

/** 把选择写进编辑中的文档：只改该行的 retrievalProviderId，其余字段与用户文字保持原样。 */
function applyEvidenceProviderSelection(document: Record<string, unknown>, index: number, providerId: string): Record<string, unknown> {
  const requirements = Array.isArray(document.evidenceRequirements) ? [...document.evidenceRequirements] : [];
  const entry = requirements[index];
  if (typeof entry === "object" && entry !== null) {
    requirements[index] = { ...(entry as Record<string, unknown>), retrievalProviderId: providerId === "" ? null : providerId };
  }
  return { ...document, evidenceRequirements: requirements };
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
  if (stage === "treatment") {
    const concept = text("concept", "构思正文", (d) => d.concept, (d, v) => { d.concept = v; });
    return concept ? [concept] : [];
  }
  if (stage === "script") {
    const fields: EditableTextField[] = [];
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


function CandidatePreview({ candidate }: { candidate: import("../../shared/api.js").StudioCandidatePreview["candidates"][number] }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [candidate.previewUrl]);
  return <figure className="creative-candidate-preview">
    {candidate.previewUrl && !failed ? <img loading="lazy" src={candidate.previewUrl} alt={`${candidate.provider} 候选画面`} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <div className="candidate-preview-unavailable">预览图未能读取</div>}
    <figcaption><span>{candidate.visualReviewed ? "已完成机器视觉核验" : "机器尚未核验"}</span>
      {candidate.sourceUrl ? <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">查看素材来源 ↗</a> : null}</figcaption>
  </figure>;
}
