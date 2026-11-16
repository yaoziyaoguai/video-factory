import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import {
  agentApi, AgentApiError, messageInput, subscribeEvents, recoverSnapshot,
  type ArtifactDraft, type ArtifactHead, type ArtifactRevision, type Bootstrap, type BusinessEvent, type ContextStatus,
  type Conversation, type Message, type Proposal, type RequestProgress,
} from "./api.js";
import { useFeedbackDrafts } from "./useFeedbackDrafts.js";
import { MarkdownText, MarkdownBody } from "./markdown.js";
import {
  appendNotice, clearDraft, clearReadingView, loadDraft, loadPanelLayout, loadReadingView, mergeArtifacts, mergeConversations, mergeLibraryPicks, mergeMaterialBatches, mergeMessages, mergeProposals, mergeRuns, mergeWorks,
  mergeDraftFrames, saveDraft, savePanelLayout, saveReadingView, type DraftState, type LibraryPick, type OutputNotices, type PanelLayout, type ReadingView,
} from "./workspace-state.js";
import type { MessageInput, Run, AcceptProposal, CancelRun, SkillPackageMutation, Work, ReviewGroup, ReviewConfirmation, MaterialBatch, MaterialBatchIndexItem, ContentSource } from "../../shared/agent/generated/contracts.js";
import { FilePreview, MediaPreview, ProjectPreview, ProposalCard, RunCard, runEnded } from "./ProductionCards.js";
export { ProposalCard } from "./ProductionCards.js";
import { WorkStagePanel, MaterialBatchCard, StandaloneScriptApproval, type AdoptPreview, type ReviewAction, type ReviewEntry, type ReviewNavigation } from "./WorkStagePanel.js";
import { ArrowLeft, ArrowUp, ChevronRight, Cpu, Film, Maximize2, MessageSquare, PanelLeft, Pencil, PlugZap, Plus, Sparkles, UserRound, X } from "lucide-react";
import { ArtifactIcon, stageOwnedLabel, FrameEmptyPreview, FrameWelcome } from "./FramePresentation.js";
import { FrameSettings, framePageTitle, type FramePage } from "./FrameSettings.js";
import { LibraryPickerDialog } from "./WorkLibrary.js";
import { hydrateReferences } from "./references.js";
import { WorkCenter } from "./WorkCenter.js";
import { TaskProgress } from "./TaskProgress.js";
import "./agent.css";

// 增量 A 工作台：会话列表 | 对话 | 产物预览 三栏（后两栏可拖动）。
// 业务事实只来自 API；事件按 id+版本合并；新产出只提示不抢占预览与输入目标。

interface ConversationView {
  conversation: Conversation;
  messages: Message[];
  requestMessages: Message[];
  artifacts: ArtifactHead[];
  proposals: Proposal[];
  runs: Run[];
  works: Work[];
  materialBatches: MaterialBatchIndexItem[];
  activeRequestId: string | null;
  olderCursor: string | null;
  artifactCursor: string | null;
  proposalCursor: string | null;
  runCursor: string | null;
  /** 定位窗口（§6）：非 null 时消息列表止于该锚点，更晚消息只提示不插入。 */
  windowAnchor: { messageId: string; seq: number } | null;
}

const EMPTY_VIEW: ConversationView = {
  conversation: { id: "", title: "", revision: 1, updatedAt: "" },
  messages: [], requestMessages: [], artifacts: [], proposals: [], runs: [], works: [], materialBatches: [], activeRequestId: null, olderCursor: null, artifactCursor: null, proposalCursor: null, runCursor: null, windowAnchor: null,
};

export function AgentWorkbench({ onLogout }: { onLogout?: (() => Promise<void>) | undefined } = {}) {
  const { conversationId: routeConversationId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedPage = params.get("page");
  const page: FramePage = requestedPage === "models" || requestedPage === "services" || requestedPage === "skills" || requestedPage === "library" || requestedPage === "profile" ? requestedPage : "chat";
  const anchorParam = params.get("anchor");
  const setPage = (value: FramePage) => setParams(value === "chat" ? (anchorParam ? { anchor: anchorParam } : {}) : { page: value });
  const [sidebarHidden, setSidebarHidden] = useState(true);
  const chatPanel = usePanelRef();
  const [focusPreview, setFocusPreview] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [inspectedRun, setInspectedRun] = useState<string | null>(null);
  const [runReadAttempt, setRunReadAttempt] = useState(0);
  const [proposalsOpen, setProposalsOpen] = useState(false);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const chatWorkspace = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.matchMedia("(max-width:1180px)");
    const resize = (event: MediaQueryListEvent) => setSidebarHidden(event.matches);
    viewport.addEventListener("change", resize);
    return () => viewport.removeEventListener("change", resize);
  }, []);
  const conversationId = routeConversationId ?? null;

  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState("");
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const conversationPageLoaded = useRef(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [storedView, setView] = useState<ConversationView>(EMPTY_VIEW);
  const view = storedView.conversation.id === conversationId ? storedView : EMPTY_VIEW;
  const [revisionCache, setRevisionCache] = useState<Record<string, ArtifactRevision>>({});
  const [drafts, setDrafts] = useState<Record<string, DraftState>>(() => ({ new: loadDraft("new") ?? { text: "", targetArtifactId: null, targetRevisionId: null } }));
  const [streaming, setStreaming] = useState<{ requestId: string; text: string } | null>(null);
  // 两种暂态回合过程：不落库，断流或回合结束即消失，不与正式产出合并。
  const [draftPanels, setDraftPanels] = useState<Record<string, ArtifactDraft>>({});
  const [referenceErrors, setReferenceErrors] = useState<Record<string, string>>({});
  const revisionCacheRef = useRef(revisionCache); revisionCacheRef.current = revisionCache;
  const [contextNote, setContextNote] = useState<ContextStatus | null>(null);
  const [requestProgress, setRequestProgress] = useState<RequestProgress | null>(null);
  const [notices, setNotices] = useState<OutputNotices>({ byConversation: new Map() });
  const [actionError, setActionError] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // 面板布局只在挂载时读取一次作为初始值；拖动后仅写回存储，不反向驱动渲染。
  const [panelLayout] = useState<PanelLayout | null>(loadPanelLayout);

  const activeId = useRef(conversationId);
  activeId.current = conversationId;
  // B01：首次快照就绪时确定初始作品一次；之后排序变化/新作品到达不换走正在看的事项。
  const viewGeneration = useRef({ id: conversationId, token: 0 });
  if (viewGeneration.current.id !== conversationId) viewGeneration.current = { id: conversationId, token: viewGeneration.current.token + 1 };
  const openIntent = useRef(0);
  const paging = useRef(new Set<string>());
  const scrollIntent = useRef(0);
  const cache = useRef(new Map<string, ConversationView>());
  const reads = useRef(new Map<string, number>());
  const [selection, setSelection] = useState<{ artifactId: string; revisionId: string } | null>(null);
  const selectionRef = useRef(selection); selectionRef.current = selection;
  const [skillId, setSkillId] = useState<string | null>(null);
  const [skillNotice, setSkillNotice] = useState("");
  const [skillMutation, setSkillMutation] = useState<SkillPackageMutation | null>(null);
  // §11.7 来源8：输入框旁的作品库选择弹层；关闭时焦点回到触发按钮，正文与阅读位置不动。
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const libraryPickerTrigger = useRef<HTMLButtonElement | null>(null);
  // 审阅组工作台的 UI 状态：选中的创作事项与被点开的素材批次；认可/制作事实全部来自服务端投影。
  const lastSelectedWork = useRef<string | null>(null);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [reviewNavigation, setReviewNavigation] = useState<ReviewNavigation | null>(null);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  const [reviewBusyKeys, setReviewBusyKeys] = useState<string[]>([]);
  const reviewInFlight = useRef(new Set<string>());
  const [reviewReceipts, setReviewReceipts] = useState<Record<string, string>>({});
  const reviewRequests = useMemo(() => {
    const result: Record<string, "queued" | "running"> = {};
    for (const [key, requestId] of Object.entries(reviewReceipts)) {
      const message = view.requestMessages.find(item => item.role === "user" && item.requestId === requestId);
      if (!message || message.state === "queued" || message.state === "running") result[key] = message?.state === "running" ? "running" : "queued";
    }
    for (const message of view.requestMessages) if (message.role === "user" && message.reviewContext?.intent === "continue"
      && (message.state === "queued" || message.state === "running")) {
      result[`${message.reviewContext.workId}:${message.reviewContext.groupId}`] = message.state;
    }
    return result;
  }, [reviewReceipts, view.requestMessages]);
  useEffect(() => {
    setReviewReceipts(current => {
      const finished = new Set(view.requestMessages.filter(message => message.state !== "queued" && message.state !== "running").map(message => message.requestId));
      const entries = Object.entries(current).filter(([, id]) => !finished.has(id));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [view.requestMessages]);
  useEffect(() => {
    if (bootstrap && skillId && !bootstrap.skills.some(skill => skill.id === skillId)) {
      setSkillId(null);
      setSkillNotice("已选 Skill 已不在当前目录，已恢复自动选择。聊天草稿已保留。");
    }
  }, [bootstrap, skillId]);
  const [pendingSend, setPendingSend] = useState<Record<string, MessageInput>>({});
  const sending = useRef(new Set<string>());
  const [sendingNow, setSendingNow] = useState(false);
  const [connectionState, setConnectionState] = useState("");
  const [streamDisconnected, setStreamDisconnected] = useState(false);
  const [accepting, setAccepting] = useState<string[]>([]);
  const acceptanceInFlight = useRef(new Set<string>());
  const cancelCommands = useRef(new Map<string, CancelRun>());
  const chatScroll = useRef<HTMLDivElement | null>(null);
  const pinnedBottom = useRef(true);
  const [unseenMessages, setUnseenMessages] = useState(false);
  const [streamCursor, setStreamCursor] = useState<{ id: string; cursor: string; generation: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentDraft = drafts[conversationId ?? "new"] ?? { text: "", targetArtifactId: null, targetRevisionId: null };


  const refreshConversations = useCallback(async () => {
    try {
      const page = await agentApi.listConversations();
      if (mounted.current) {
        setConversations(current => mergeConversations(current, page.items));
        if (!conversationPageLoaded.current) setConversationCursor(page.nextCursor);
        conversationPageLoaded.current = true;
      }
      return page.items;
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : "无法读取会话列表。");
      return [];
    }
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const value = await agentApi.bootstrap();
    if (mounted.current) setBootstrap(value);
  }, []);

  useEffect(() => {
    void refreshBootstrap().catch(error => {
      if (mounted.current) setBootError(error instanceof Error ? error.message : "无法连接工作台服务。");
    });
    void refreshConversations();
  }, [refreshBootstrap, refreshConversations]);

  // windowMode：undefined=沿用该会话已有窗口（事件/动作后的刷新）；"latest"=回到最新窗口；
  // 其他字符串=以该消息为锚点的定位窗口（作品库“回到对话”入口）。
  const refreshSnapshot = useCallback(async (id: string, resetStream = false, windowMode: "latest" | string | undefined = undefined, changedArtifactIds: readonly string[] = []) => {
    const generation = viewGeneration.current.token;
    const sequence = (reads.current.get(id) ?? 0) + 1;
    reads.current.set(id, sequence);
    try {
      let anchorId: string | null = null;
      let anchorPage: Awaited<ReturnType<typeof agentApi.anchorMessages>> | null = null;
      if (typeof windowMode === "string" && windowMode !== "latest") {
        anchorId = windowMode;
        anchorPage = await agentApi.anchorMessages(id, windowMode);
      }
      const snapshot = await agentApi.snapshot(id);
      if (!mounted.current || reads.current.get(id) !== sequence || viewGeneration.current.token !== generation) return false;
      const known = cache.current.get(id);
      const changedMessages = snapshot.messages.items.filter(message => !known?.messages.some(old => old.id === message.id && old.revision >= message.revision));
      const refresh = {
        artifacts: [...new Set([...changedArtifactIds, ...changedMessages.flatMap(message => message.references.artifacts.map(ref => ref.artifactId)), ...(resetStream ? known?.artifacts.map(item => item.id) ?? [] : [])])].filter(itemId => !snapshot.artifacts.items.some(item => item.id === itemId)),
        proposals: [...new Set([...changedMessages.flatMap(message => message.references.proposalIds), ...(resetStream ? known?.proposals.map(item => item.id) ?? [] : [])])].filter(itemId => !snapshot.proposals.items.some(item => item.id === itemId)),
        runs: [...new Set([...changedMessages.flatMap(message => message.references.runIds), ...(known?.runs.filter(run => resetStream || !runEnded(run.state) || (run.finance != null && run.finance.state !== "settled")).map(run => run.id) ?? [])])].filter(itemId => !snapshot.runs.items.some(item => item.id === itemId)),
      };
      // 同一补读入口用于快照、历史页和事件；一项失败不会拒绝整页。
      const refs = await hydrateReferences(snapshot.messages.items, {
        artifacts: mergeArtifacts(known?.artifacts ?? [], snapshot.artifacts.items), proposals: mergeProposals(known?.proposals ?? [], snapshot.proposals.items),
        runs: mergeRuns(known?.runs ?? [], snapshot.runs.items),
      }, revisionCacheRef.current, refresh);
      if (!mounted.current || reads.current.get(id) !== sequence || viewGeneration.current.token !== generation) return false;
      const referencedArtifacts = refs.artifacts, referencedProposals = refs.proposals;
      const referencedRuns = refs.runs;
      setRevisionCache(current => ({ ...current, ...refs.revisions }));
      if (activeId.current === id) setReferenceErrors(current => ({ ...current, ...refs.errors }));
      const incomingArtifacts = mergeArtifacts(snapshot.artifacts.items, referencedArtifacts);
      const prior = cache.current.get(id) ?? EMPTY_VIEW;
      const windowAnchor = anchorId && anchorPage
        ? { messageId: anchorId, seq: Math.max(0, ...anchorPage.items.map(item => item.createdSequence)) }
        : windowMode === "latest" ? null : prior.windowAnchor;
      const windowSeq = windowAnchor?.seq ?? null;
      // 定位窗口内只见锚点及之前的消息；快照最新页里更晚的只作为窗口外事实，不进列表。
      const snapshotMessages = windowSeq === null ? snapshot.messages.items : snapshot.messages.items.filter(item => item.createdSequence <= windowSeq);
      // 建立或退出窗口时消息列表按窗口重建（锚点页/最新页），避免残留另一窗口的消息或漏段；
      // 沿用窗口时照常按 id+版本合并，再过滤快照页中晚于锚点的消息。
      const messages = windowMode === undefined
        ? mergeMessages(prior.messages, snapshotMessages)
        : mergeMessages(anchorPage?.items ?? [], snapshotMessages);
      const next: ConversationView = {
        conversation: snapshot.conversation,
        messages,
        // 历史窗口只限制聊天显示；请求的排队、执行与终态始终按原始消息更新。
        requestMessages: mergeMessages(prior.requestMessages, snapshot.messages.items.filter(message => message.requestId)),
        artifacts: mergeArtifacts(prior.artifacts, incomingArtifacts),
        proposals: mergeProposals(prior.proposals, mergeProposals(snapshot.proposals.items, referencedProposals)),
        runs: mergeRuns(prior.runs, mergeRuns(snapshot.runs.items, referencedRuns)),
        works: mergeWorks(prior.works, snapshot.works),
        materialBatches: mergeMaterialBatches(prior.materialBatches, snapshot.materialBatches),
        activeRequestId: snapshot.activeRequestId,
        olderCursor: anchorPage
          ? anchorPage.nextCursor
          : windowMode === "latest" || !prior.conversation.id ? snapshot.messages.nextCursor ?? null : prior.olderCursor,
        artifactCursor: prior.conversation.id ? prior.artifactCursor : snapshot.artifacts.nextCursor,
        proposalCursor: prior.conversation.id ? prior.proposalCursor : snapshot.proposals.nextCursor,
        runCursor: prior.conversation.id ? prior.runCursor : snapshot.runs.nextCursor,
        windowAnchor,
      };
      cache.current.set(id, next);
      const changed = prior.conversation.id ? incomingArtifacts.filter(item => {
        const before = prior.artifacts.find(old => old.id === item.id);
        return !before || before.revisionNumber < item.revisionNumber;
      }) : [];
      for (const item of changed) setNotices(current => appendNotice(current, id, item.id));
      if (activeId.current !== id) return true;
      setView(next);
      const terminal = (requestId: string) => next.requestMessages.some(message => message.requestId === requestId && ["completed", "failed", "stopped"].includes(message.state));
      setStreaming(current => current && !terminal(current.requestId) ? current : null);
      setDraftPanels(current => Object.fromEntries(Object.entries(current).filter(([, draft]) => !terminal(draft.requestId))));
      setContextNote(current => current && !terminal(current.requestId) ? current : null);
      setRequestProgress(current => current && !terminal(current.requestId) ? current : null);
      // 首次进入已有对话也直接展示最近产出；已有阅读位置始终优先。
      // 有创作事项时默认呈现阶段工作台，产物页签点击后再看单件产物。
      const firstPreview = changed[0] ?? incomingArtifacts[0];
      if (!selectionRef.current && firstPreview && !next.works.length) setSelection({ artifactId: firstPreview.id, revisionId: firstPreview.revisionId });
      // 定位窗口里更晚的消息由窗口横幅提示，不再额外弹“回到最新消息”气泡。
      if (windowSeq === null && !pinnedBottom.current && snapshot.messages.items.some(item => !prior.messages.some(old => old.id === item.id))) setUnseenMessages(true);
      setStreamCursor(current => !current || current.id !== id || resetStream
        ? { id, cursor: snapshot.eventCursor, generation: (current?.generation ?? 0) + 1 } : current);
      const unsynced = refresh.artifacts.some(itemId => refs.errors[`artifact:${itemId}`])
        || refresh.proposals.some(itemId => refs.errors[`proposal:${itemId}`]) || refresh.runs.some(itemId => refs.errors[`run:${itemId}`]);
      setConnectionState(unsynced ? "部分最新状态尚未同步，请重新连接。当前阅读和草稿已保留。" : "");
      return true;
    } catch (error) {
      if (!mounted.current || activeId.current !== id || reads.current.get(id) !== sequence || viewGeneration.current.token !== generation) return false;
      setConnectionState(error instanceof AgentApiError ? error.message : "连接暂不可用。已保留当前阅读和草稿。");
      return false;
    }
  }, []);

  const snapshotBatch = useRef<{ timer?: number; pending: boolean; reading: boolean; artifacts: Set<string> }>({ pending: false, reading: false, artifacts: new Set() });
  const scheduleSnapshot = useCallback((id: string, artifactIds: readonly string[] = []) => {
    const batch = snapshotBatch.current;
    const generation = viewGeneration.current.token;
    batch.pending = true;
    artifactIds.forEach(artifactId => batch.artifacts.add(artifactId));
    const flush = async () => {
      if (!mounted.current || activeId.current !== id || viewGeneration.current.token !== generation) return;
      delete batch.timer; batch.reading = true; batch.pending = false;
      const artifacts = [...batch.artifacts]; batch.artifacts.clear();
      await refreshSnapshot(id, false, undefined, artifacts);
      batch.reading = false;
      if (batch.pending) batch.timer = window.setTimeout(() => void flush(), 120);
    };
    if (!batch.reading && batch.timer === undefined) batch.timer = window.setTimeout(() => void flush(), 120);
  }, [refreshSnapshot]);

  const readEventEntity = useCallback(async (id: string, event: BusinessEvent) => {
    const generation = viewGeneration.current.token;
    try {
      const entity = event.kind === "artifact.delivered" ? await agentApi.readArtifactHead(event.entityId)
        : event.kind === "message.changed" ? await agentApi.readMessage(event.entityId)
        : event.kind === "proposal.changed" ? await agentApi.readProposal(event.entityId) : event.kind === "run.changed" ? await agentApi.readRun(event.entityId)
        : event.kind === "work.changed" ? await agentApi.readWork(event.entityId) : null;
      if (!mounted.current || viewGeneration.current.token !== generation) return;
      const prior = cache.current.get(id);
      if (!prior) return;
      const next = { ...prior };
      if (entity && event.kind === "artifact.delivered") {
        next.artifacts = mergeArtifacts(prior.artifacts, [entity as ArtifactHead]);
        // 有创作事项时新产物进入阶段工作台呈现，不抢占当前阅读。
        if (activeId.current === id && !selectionRef.current && !prior.works.length && !(entity as ArtifactHead).workId) {
          const artifact = entity as ArtifactHead; setSelection({ artifactId: artifact.id, revisionId: artifact.revisionId });
        }
      }
      // 定位窗口：晚于锚点的新消息只提示不插入（横幅提供回到最新入口），窗口内更新照常合并。
      if (entity && event.kind === "message.changed") {
        const message = entity as Message;
        if (message.requestId) next.requestMessages = mergeMessages(prior.requestMessages, [message]);
        const windowSeq = prior.windowAnchor?.seq ?? null;
        if (windowSeq === null || (entity as Message).createdSequence <= windowSeq) {
          next.messages = mergeMessages(prior.messages, [entity as Message]);
        }
      }
      if (entity && event.kind === "proposal.changed") next.proposals = mergeProposals(prior.proposals, [entity as Proposal]);
      if (entity && event.kind === "run.changed") next.runs = mergeRuns(prior.runs, [entity as Run]);
      // work.changed 只合并该事项投影；素材批次索引由事件后的快照重读覆盖（批次不可变）。
      if (entity && event.kind === "work.changed") next.works = mergeWorks(prior.works, [entity as Work]);
      cache.current.set(id, next);
      if (activeId.current === id) setView(next);
      // 消息已合入缓存，仍显式重读其引用的 head；独立稿认可可能只发 message.changed，且产物不在快照首页。
      scheduleSnapshot(id, event.kind === "message.changed" && entity
        ? (entity as Message).references.artifacts.map(ref => ref.artifactId) : []);
    } catch { if (activeId.current === id && viewGeneration.current.token === generation) { setConnectionState("最新状态尚未同步，正在补读。当前阅读和草稿已保留。"); scheduleSnapshot(id); } }
  }, [scheduleSnapshot]);

  // 一条当前 SSE；离开的在途会话按事实轮询，避免几十条 EventSource 占满浏览器连接。
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const [id, item] of cache.current) {
        if (id !== activeId.current && (item.activeRequestId || item.messages.some(message => message.state === "queued") || item.runs.some(run => !runEnded(run.state) || (run.finance != null && run.finance.state !== "settled")))) void refreshSnapshot(id);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshSnapshot]);

  useEffect(() => {
    setView(conversationId ? cache.current.get(conversationId) ?? EMPTY_VIEW : EMPTY_VIEW);
    openIntent.current++;
    setSelection(null); setReviewNavigation(null); setFeedbackOpen(false); setInspectedRun(null); setStreaming(null); setStreamCursor(null); setActionError("");
    setDraftPanels({}); setContextNote(null); setRequestProgress(null); setReferenceErrors({}); setReviewReceipts({}); setConnectionState(""); setStreamDisconnected(false);
    setSkillId(null); setUnseenMessages(false); pinnedBottom.current = true;
    setSelectedWorkId(null); lastSelectedWork.current = null; setOpenBatchId(null);
    if (!conversationId) return;
    const stored = loadDraft(conversationId);
    setDrafts(current => ({ ...current, [conversationId]: current[conversationId] ?? stored ?? { text: "", targetArtifactId: null, targetRevisionId: null } }));
    try {
      // 恢复上次真实视图（阶段工作台/独立产物/素材详情/制作记录）；旧格式只有产物选择，按产物视图解释。
      const reading = loadReadingView(conversationId);
      if (reading?.entry === "artifact" && reading.artifactId && reading.revisionId) setSelection({ artifactId: reading.artifactId, revisionId: reading.revisionId });
      else if (reading?.entry === "run" && reading.runId) setInspectedRun(reading.runId);
      if (reading?.workId) setSelectedWorkId(reading.workId);
      if (reading?.batchId) setOpenBatchId(reading.batchId);
      const pending = localStorage.getItem(`vf:agent-send:${conversationId}`);
      if (pending) setPendingSend(current => ({ ...current, [conversationId]: JSON.parse(pending) as MessageInput }));
    } catch { /* 本地草稿不可用时仍可继续访问持久业务数据。 */ }
    // 锚点参数决定进入哪种窗口：有 anchor=定位窗口（作品库回到对话），没有=最新窗口。
    const batch = snapshotBatch.current;
    window.clearTimeout(batch.timer);
    snapshotBatch.current = { pending: false, reading: false, artifacts: new Set() };
    const stopRecovery = recoverSnapshot(() => refreshSnapshot(conversationId, true, anchorParam ?? "latest"),
      () => setConnectionState("暂时无法恢复连接。草稿已保留，可以重新连接；网络恢复或回到页面时会再次尝试。"));
    return () => { stopRecovery(); window.clearTimeout(snapshotBatch.current.timer); };
  }, [conversationId, anchorParam, refreshSnapshot]);

  useEffect(() => {
    if (!streamCursor || streamCursor.id !== conversationId) return;
    let stopRecovery: (() => void) | undefined;
    let disposed = false;
    let disconnected = false;
    let deltaTimer: number | undefined;
    let deltaText = "";
    let lastDelta = -1;
    let deltaRequest = "";
    const seen = new Set<string>();
    const id = streamCursor.id;
    const contextSequences = new Map<string, number>();
    const live = (requestId: string) => !cache.current.get(id)?.requestMessages.some(message => message.requestId === requestId && ["completed", "failed", "stopped"].includes(message.state));
    setStreamDisconnected(false);
    const subscription = subscribeEvents(id, streamCursor.cursor, {
      onBusiness: event => {
        if (disposed || disconnected || activeId.current !== id || seen.has(event.eventId)) return;
        seen.add(event.eventId);
        if (event.kind === "artifact.delivered") setNotices(current => appendNotice(current, id, event.entityId));
        void readEventEntity(id, event);
      },
      onDelta: delta => {
        if (disposed || disconnected || activeId.current !== id || !live(delta.requestId)) return;
        if (delta.requestId !== deltaRequest) { deltaRequest = delta.requestId; lastDelta = -1; deltaText = ""; }
        if (delta.sequence <= lastDelta) return;
        lastDelta = delta.sequence;
        deltaText = (delta.replace ? "" : deltaText) + delta.text;
        if (deltaTimer === undefined) deltaTimer = window.setTimeout(() => {
          deltaTimer = undefined;
          if (!disposed && !disconnected && live(deltaRequest)) setStreaming({ requestId: deltaRequest, text: deltaText });
        }, 80);
      },
      onDraft: draft => {
        if (disposed || disconnected || activeId.current !== id || !live(draft.requestId)) return;
        setDraftPanels(current => mergeDraftFrames(current, draft));
      },
      onContextStatus: status => {
        if (disposed || disconnected || activeId.current !== id || !live(status.requestId) || status.sequence <= (contextSequences.get(status.requestId) ?? -1)) return;
        contextSequences.set(status.requestId, status.sequence);
        setContextNote(status);
      },
      onProgress: progress => {
        if (disposed || disconnected || activeId.current !== id || !live(progress.requestId)) return;
        setRequestProgress(current => current?.requestId === progress.requestId && current.sequence >= progress.sequence ? current : progress);
      },
      onReset: () => {
        if (disposed || disconnected || activeId.current !== id) return;
        disconnected = true;
        setStreamDisconnected(true);
        window.clearTimeout(deltaTimer);
        setStreaming(null); setDraftPanels({}); setContextNote(null); setRequestProgress(null); setReferenceErrors({}); setConnectionState("连接已中断，正在重新同步…");
        stopRecovery = recoverSnapshot(() => refreshSnapshot(id, true),
          () => setConnectionState("连接尚未恢复，当前阅读和草稿已保留。可手动重连；网络恢复后也会再试。"));
      },
    });
    return () => { disposed = true; subscription.close(); stopRecovery?.(); window.clearTimeout(deltaTimer); };
  }, [conversationId, streamCursor, refreshSnapshot, readEventEntity]);

  // 预览身份是固定修订，读取结果只进入不可变缓存；新 head 不改变正在看的版本。
  useEffect(() => {
    // 刷新恢复的旧作品可能不在首页；会话快照先就绪，补读才有可合并的位置。
    if (!selection || !conversationId || view.conversation.id !== conversationId) return;
    const key = `${selection.artifactId}:${selection.revisionId}`;
    const generation = viewGeneration.current.token;
    let disposed = false;
    // 打开制作记录不取消原作品读取；返回时仍使用这份固定修订。
    const current = () => !disposed && mounted.current && viewGeneration.current.token === generation;
    void Promise.all([
      !view.artifacts.some(item => item.id === selection.artifactId) ? agentApi.readArtifactHead(selection.artifactId).then(head => {
        if (!current()) return;
        const prior = cache.current.get(conversationId); if (!prior) return;
        const next = { ...prior, artifacts: mergeArtifacts(prior.artifacts, [head]) };
        cache.current.set(conversationId, next); setView(next);
      }) : Promise.resolve(),
      !revisionCache[key] ? agentApi.readRevision(selection.artifactId, selection.revisionId).then(revision => {
        if (current()) setRevisionCache(cache => ({ ...cache, [key]: revision }));
      }) : Promise.resolve(),
    ]).catch(error => { if (current()) setActionError(error instanceof Error ? error.message : "无法读取产物。"); });

    return () => { disposed = true; };
  }, [selection, conversationId, view.conversation.id]);

  // 总览保持多作品入口；修订由可见卡片及单件审阅按需读取，不随快照批量拉取。

  // 当前阅读入口按会话持久（阶段工作台/独立产物/素材详情/制作记录）；关闭视图即同步更新，
  // 刷新回到最后真实视图，不复活已关闭的旧产物（B03）。
  useEffect(() => {
    if (!conversationId || view.conversation.id !== conversationId) return;
    const next: ReadingView | null = inspectedRun
      ? { entry: "run", workId: selectedWorkId, artifactId: null, revisionId: null, runId: inspectedRun, batchId: openBatchId }
      : selection
        ? { entry: "artifact", workId: selectedWorkId, artifactId: selection.artifactId, revisionId: selection.revisionId, runId: null, batchId: openBatchId }
        : openBatchId
          ? { entry: "batch", workId: selectedWorkId, artifactId: null, revisionId: null, runId: null, batchId: openBatchId }
          : view.works.length || selectedWorkId
            ? { entry: "work", workId: selectedWorkId, artifactId: null, revisionId: null, runId: null, batchId: openBatchId }
            : null;
    if (next) saveReadingView(conversationId, next);
    else clearReadingView(conversationId);
  }, [conversationId, view.conversation.id, view.works.length, selection, inspectedRun, selectedWorkId, openBatchId]);

  const createConversation = async () => {
    try { const created = await agentApi.createConversation("新的会话"); await refreshConversations(); navigate(`/agent/${created.id}`); }
    catch (error) { setActionError(error instanceof Error ? error.message : "创建会话失败。"); }
  };
  const renameBusy = useRef(false);
  const commitRename = async (id: string, title: string, expectedRevision: number) => {
    if (renameBusy.current || !renaming) return;
    renameBusy.current = true; setRenaming(null);
    try { await agentApi.renameConversation(id, title, expectedRevision); await refreshConversations(); if (id === activeId.current) await refreshSnapshot(id); }
    catch (error) { setActionError(error instanceof Error ? error.message : "改名失败。"); await refreshConversations(); }
    finally { renameBusy.current = false; }
  };

  const updateDraft = (update: Partial<DraftState> | ((draft: DraftState) => Partial<DraftState>)) => {
    const id = conversationId ?? "new";
    setDrafts(current => {
      const base = current[id] ?? { text: "", targetArtifactId: null, targetRevisionId: null };
      const next = { ...base, ...(typeof update === "function" ? update(base) : update) };
      saveDraft(id, next); return { ...current, [id]: next };
    });
  };
  const updateDraftText = (text: string) => updateDraft({ text });
  const unbindTarget = () => updateDraft({ targetArtifactId: null, targetRevisionId: null });
  const removeLibrarySelection = (index: number) => updateDraft({ librarySelections: currentDraft.librarySelections?.filter((_, i) => i !== index) ?? [] });
  // §11.7 来源9：库选材并入当前会话草稿后回该会话；无当前会话时并入“新对话”草稿
  // （下一条消息发送时沿用现有建会话流程携带），不猜最近会话、不导航到来源对话。
  const bringLibraryPicks = (picks: LibraryPick[]) => {
    if (!picks.length) return;
    updateDraft(draft => ({ librarySelections: mergeLibraryPicks(draft.librarySelections, picks) }));
    setPage("chat");
  };
  const bindTarget = (artifact: ArtifactHead) => updateDraft({ targetArtifactId: artifact.id, targetRevisionId: selection?.revisionId ?? artifact.revisionId, proposalId: null, proposalDigest: null });
  const model = bootstrap?.models.find(entry => entry.kind === "text" && entry.isDefault);
  // render没有模型条目；具体提案能否受理由服务端实际目录与受理事务判断。
  // 模拟媒体只指测试装配的目录条目；文本 features 已是用户备注，不决定运行状态（T2）。
  const isSimulated = bootstrap?.models.some(model => model.kind !== "text" && model.features.includes("offline-fixture")) ?? false;
  const lockedArtifacts = new Set(view.runs.filter(run => !runEnded(run.state)).flatMap(run => run.inputRevisions.map(ref => ref.artifactId)));
  const replyToProposal = (proposal: Proposal) => {
    setSkillId(null);
    updateDraft({ proposalId: proposal.id, proposalDigest: proposal.digest, targetArtifactId: null, targetRevisionId: null });
  };
  const acceptProposal = async (proposal: Proposal) => {
    if (acceptanceInFlight.current.has(proposal.id)) return;
    acceptanceInFlight.current.add(proposal.id); setAccepting([...acceptanceInFlight.current]);
    const key = `vf:agent-accept:${proposal.id}`;
    let command: AcceptProposal = { commandId: agentApi.newCommandId(), proposalDigest: proposal.digest };
    try { const saved = localStorage.getItem(key); if (saved) command = JSON.parse(saved) as AcceptProposal; else localStorage.setItem(key, JSON.stringify(command)); } catch { /* 本次内存请求仍有身份。 */ }
    try {
      await agentApi.acceptProposal(proposal.id, command);
      localStorage.removeItem(key);
      await refreshSnapshot(proposal.conversationId);
    } catch (error) {
      if (error instanceof AgentApiError && error.payload.status < 500) localStorage.removeItem(key);
      if (activeId.current === proposal.conversationId) setActionError(error instanceof Error ? error.message : "确认结果未返回，可用原请求重试。");
    } finally { acceptanceInFlight.current.delete(proposal.id); setAccepting([...acceptanceInFlight.current]); }
  };
  const cancelProduction = async (run: Run) => {
    const command = cancelCommands.current.get(run.id) ?? { commandId: agentApi.newCommandId(), expectedRevision: run.revision };
    cancelCommands.current.set(run.id, command);
    try { await agentApi.cancelRun(run.id, command); cancelCommands.current.delete(run.id); await refreshSnapshot(run.conversationId); }
    catch (error) {
      if (error instanceof AgentApiError && error.payload.status < 500) cancelCommands.current.delete(run.id);
      if (activeId.current === run.conversationId) setActionError(error instanceof Error ? error.message : "取消结果未确认。");
      await refreshSnapshot(run.conversationId);
    }
  };
  // 面板命令按组或独立稿保存 commandId，结果未知时原请求重试；不动未发送的聊天草稿。
  const sendPanelCommand = async (scope: { workId: string; groupId: string } | { artifactId: string }, label: string, keySuffix: string,
    reviewConfirmation: ReviewConfirmation | null, failureHint: string): Promise<boolean> => {
    const id = view.conversation.id;
    // 组内任一认可在途时整组禁用；独立稿各自拥有忙态。
    const busy = "workId" in scope ? `${scope.workId}:${scope.groupId}` : `standalone:${scope.artifactId}`;
    const continues = !reviewConfirmation || reviewConfirmation.action === "approve_and_continue";
    if (!id || reviewInFlight.current.has(busy) || (continues && reviewRequests[busy])) return false;
    const storageKey = `vf:agent-review:${id}:${busy}:${keySuffix}`;
    const buildCommand = (): MessageInput => ({
      commandId: agentApi.newCommandId(), text: label, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
      reviewConfirmation,
      // 普通继续附本条消息指向的组（F05）：不带确认时不靠服务端猜当前作品；
      // 与 reviewConfirmation/proposalRef/target 互斥；已有缓存保持原 body，缺目标的旧继续命令提示核对。
      reviewContext: !reviewConfirmation && "workId" in scope ? { ...scope, intent: "continue" } : null,
    });
    let command: MessageInput;
    try {
      const saved = localStorage.getItem(storageKey);
      command = saved ? JSON.parse(saved) as MessageInput : buildCommand();
      if (saved && keySuffix === "continue" && command.reviewConfirmation == null && command.reviewContext == null) {
        setActionError("这是旧版留下的继续操作。请先查看原对话，确认是否已经继续；需要接着做时，可在聊天中说明要继续的作品和分组。");
        return false;
      }
      if (!saved) localStorage.setItem(storageKey, JSON.stringify(command));
    } catch {
      command = buildCommand();
    }
    reviewInFlight.current.add(busy);
    setReviewBusyKeys(current => [...current, busy]);
    try {
      const receipt = await agentApi.sendMessages(id, command);
      if (receipt.state === "queued" || receipt.state === "running") setReviewReceipts(current => ({ ...current, [busy]: receipt.requestId }));
      try { localStorage.removeItem(storageKey); } catch { /* 受理成功不因存储不可用变成发送失败。 */ }
      await refreshSnapshot(id);
      return true;
    } catch (error) {
      // 4xx 说明请求本身被拒（稿已前进/条目状态变化等），丢弃原命令；结果未知时保留以便原请求重试。
      if (error instanceof AgentApiError && error.payload.status < 500) localStorage.removeItem(storageKey);
      if (activeId.current === id) setActionError(error instanceof Error ? error.message : failureHint);
      return false;
    } finally { reviewInFlight.current.delete(busy); setReviewBusyKeys(current => current.filter(key => key !== busy)); }
  };
  const confirmReview = (work: Work, group: ReviewGroup, action: ReviewAction, entries: readonly ReviewEntry[], label: string): Promise<boolean> => {
    const subjectKey = entries.map(entry => entry.source.kind === "artifact_revision"
      ? `${entry.source.artifactId}:${entry.source.revisionId}` : `msg:${entry.source.messageId}`).join("|");
    const confirmationItems = entries.map(entry => ({ itemId: entry.itemId, source: entry.source }));
    return sendPanelCommand({ workId: work.id, groupId: group.id }, label, `${action}:${subjectKey}`,
      { workId: work.id, groupId: group.id, action, items: [confirmationItems[0]!, ...confirmationItems.slice(1)] },
      "认可结果未确认，可重试。");
  };
  // 必选项全部认可后的普通继续：一条不带 reviewConfirmation 的普通消息，不补确认、不定稿。
  const continueReview = (work: Work, group: ReviewGroup, label: string): Promise<boolean> =>
    sendPanelCommand({ workId: work.id, groupId: group.id }, label, "continue", null, "继续结果未确认，可重试。");
  const adoptPreview: AdoptPreview = (work, group, item, source) =>
    sendPanelCommand({ workId: work.id, groupId: group.id }, `以这版「${item.label}」定稿并入库。`, `adopt_preview:${item.id}:${source.artifactId}:${source.revisionId}`,
      { kind: "adopt_preview", workId: work.id, groupId: group.id, itemId: item.id, source, action: "finalize_video" },
      "定稿结果未确认，可重试。");
  const approveStandalone = (artifact: ArtifactHead, revision: ArtifactRevision): Promise<boolean> =>
    sendPanelCommand({ artifactId: artifact.id }, `认可「${artifact.title}」这一版。`, `approve:${revision.revisionId}`,
      { kind: "standalone_artifact", artifactId: artifact.id, revisionId: revision.revisionId, action: "approve" },
      "认可结果未确认，可重试。");

  const sendMessage = async (mode: "new" | "steer" = "new", retry = false) => {
    if (sendingNow || sending.current.has(conversationId ?? "new")) return;
    if (skillMutation) { setActionError("Skill 目录正在更新，完成后再发送。聊天草稿已保留。"); return; }
    const draft = currentDraft;
    if (!retry && (!draft.text.trim() || (conversationId && pendingSend[conversationId]))) return;
    let id = conversationId;
    if (!id) {
      sending.current.add("new"); setSendingNow(true);
      try {
        const created = await agentApi.createConversation("新的会话");
        id = created.id;
        saveDraft(id, draft); clearDraft("new");
        setDrafts(current => ({ ...current, [created.id]: draft, new: { text: "", targetArtifactId: null, targetRevisionId: null } }));
        activeId.current = id;
        navigate(`/agent/${id}`);
        void refreshConversations();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "创建会话失败。");
        setSendingNow(false); return;
      } finally { sending.current.delete("new"); }
    }
    const activeMessage = view.messages.find(message => message.role === "user" && message.requestId === view.activeRequestId);
    const target = draft.targetArtifactId && draft.targetRevisionId ? { artifactId: draft.targetArtifactId, revisionId: draft.targetRevisionId, workId: null } : null;
    if (!retry && mode === "new" && target) {
      const head = view.artifacts.find(artifact => artifact.id === target.artifactId);
      if (head && head.revisionId !== target.revisionId) {
        setActionError("绑定的修改目标已过期，请查看最新版本，再决定是否修改。"); return;
      }
    }
    if (!retry && mode === "steer" && target && (activeMessage?.target?.artifactId !== target.artifactId || activeMessage.target.revisionId !== target.revisionId)) {
      setActionError("这份草稿针对另一份产物，请正常发送为新请求，或先清除修改目标。"); return;
    }
    const command = retry ? pendingSend[id]! : {
      ...messageInput(draft.text.trim(), mode === "steer" ? activeMessage?.target ?? null : target),
      proposalRef: draft.proposalId && draft.proposalDigest ? { proposalId: draft.proposalId, digest: draft.proposalDigest } : null,
      // G4-2：作品库选材只随 new 请求携带（steer 是对在途请求的补充说明）；重试沿用原命令。
      ...(mode === "new" && draft.librarySelections?.length ? { librarySelections: draft.librarySelections.map(pick => pick.selection) } : {}),
      skillId: mode === "steer" ? null : skillId, mode, steerRequestId: mode === "steer" ? view.activeRequestId : null,
    };
    setActionError(""); sending.current.add(id); setSendingNow(true);
    setPendingSend(current => ({ ...current, [id]: command }));
    try { localStorage.setItem(`vf:agent-send:${id}`, JSON.stringify(command)); } catch { /* 内存保留原 commandId。 */ }
    const forget = () => {
      setPendingSend(current => { const next = { ...current }; delete next[id]; return next; });
      try { localStorage.removeItem(`vf:agent-send:${id}`); } catch { /* 缓存清理不改变服务端回执。 */ }
    };
    try {
      await agentApi.sendMessages(id, command);
      forget();
      // 原型约定：指定 Skill 只用于下一条请求。new 被服务端明确接收后恢复自动选择；
      // 结果未知或明确未受理时不消费（原请求仍带当时 skillId），steer 不携带也不消费。
      if (command.mode === "new") setSkillId(null);
      setDrafts(current => {
        const pending = current[id];
        // 首次干预可继承正在执行的目标；重试只能依据原 command，不能借用重试时的新绑定。
        const submittedTarget = retry ? command.target : target;
        if (pending?.text.trim() !== command.text
          || pending.targetArtifactId !== (submittedTarget?.artifactId ?? null)
          || pending.targetRevisionId !== (submittedTarget?.revisionId ?? null)
          || (pending.proposalId ?? null) !== (command.proposalRef?.proposalId ?? null)
          || (pending.proposalDigest ?? null) !== (command.proposalRef?.digest ?? null)
          || JSON.stringify(pending.librarySelections ?? []) !== JSON.stringify(draft.librarySelections ?? [])) return current;
        // steer 不携带库选材：chips 属于下一条 new 请求，不被干预消耗；new 发送成功即消费。
        const keepPicks = command.mode === "new" ? [] : pending.librarySelections ?? [];
        const reset: DraftState = { text: "", targetArtifactId: null, targetRevisionId: null, librarySelections: keepPicks };
        if (keepPicks.length) saveDraft(id, reset); else clearDraft(id);
        return { ...current, [id]: reset };
      });
      await refreshSnapshot(id);
      // 从定位窗口发出的新消息晚于锚点，不进当前窗口；发完即回到最新窗口看到自己的消息。
      if (view.windowAnchor && activeId.current === id) navigate(`/agent/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof AgentApiError && error.payload.status < 500) forget();
      if (activeId.current === id) setActionError(error instanceof Error ? error.message : "发送结果未确认，请重试上次发送。");
    } finally { sending.current.delete(id); setSendingNow(false); }
  };

  // 候选采用沿用普通会话请求；准确引用藏在可读链接里，独立命令不消费输入框或 Skill 草稿。
  const adoptMaterial = async (batch: MaterialBatch, candidate: MaterialBatch["results"][number], index: number) => {
    const id = view.conversation.id;
    if (!id || materialAdoptDisabled || sending.current.has(id)) return;
    const work = view.works.find(item => item.id === batch.workId);
    // 采用素材的默认对象：优先方案稿，其次内容稿（与旧阶段语义一致，来源改为审阅组事项）。
    const workItems = work ? work.reviewGroups.flatMap(group => group.items) : [];
    const source = workItems.find(item => item.role === "plan" && item.draft != null)?.draft
      ?? workItems.find(item => item.role === "content" && item.draft != null)?.draft ?? null;
    const target = work && source?.kind === "artifact_revision" ? { artifactId: source.artifactId, revisionId: source.revisionId, workId: work.id } : null;
    const linkLabel = (text: string) => text.replaceAll("[", "［").replaceAll("]", "］").replace(/\s+/g, " ");
    const batchUrl = new URL(`/api/agent/v1/material-batches/${encodeURIComponent(batch.batchId)}`, window.location.origin);
    batchUrl.hash = `candidate=${encodeURIComponent(candidate.candidateId)}`;
    const label = linkLabel(`「${batch.query.query || "素材搜索"}」原批次第 ${index + 1} 首「${candidate.title || "未命名音乐"}」`);
    const workRef = batch.workId ? `，用于[${linkLabel(work?.title ?? "原创作")}](${new URL(`/api/agent/v1/works/${encodeURIComponent(batch.workId)}`, window.location.origin).href})` : "，只作为本次对话的独立素材";
    const text = `请采用[${label}](${batchUrl.href})${workRef}。请先读回这个原始批次核对，不重新搜索。${candidate.provider === "freetouse" ? "用途不明且影响许可时请先向我澄清，不代填用途。" : ""}本次仅采用素材，不新建视频事项、不认可方案或开始制作。`;
    const storageKey = `vf:agent-material:${id}:${batch.batchId}:${candidate.candidateId}`;
    let command = messageInput(text, target);
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) command = JSON.parse(saved) as MessageInput;
      else localStorage.setItem(storageKey, JSON.stringify(command));
    } catch { /* 存储不可用时仍可发送本次请求。 */ }
    setActionError(""); sending.current.add(id); setSendingNow(true);
    try {
      await agentApi.sendMessages(id, command);
      try { localStorage.removeItem(storageKey); } catch { /* 回执已明确，不改变用户草稿。 */ }
      await refreshSnapshot(id);
    } catch (error) {
      if (error instanceof AgentApiError && error.payload.status < 500) {
        try { localStorage.removeItem(storageKey); } catch { /* 拒绝原因仍按原样显示。 */ }
      }
      if (activeId.current === id) setActionError(error instanceof Error ? error.message : "采用请求结果未确认，可再次点击同一候选重试。");
    } finally { sending.current.delete(id); setSendingNow(false); }
  };

  const stopActive = async () => {
    if (!conversationId || !view.activeRequestId) return true;
    const id = conversationId;
    try { await agentApi.stopRequest(view.activeRequestId); await refreshSnapshot(id); return true; }
    catch (error) { if (activeId.current === id) setActionError(error instanceof Error ? error.message : "停止失败。"); return false; }
  };
  const openArtifact = (artifactId: string, revisionId?: string) => {
    const intent = ++openIntent.current, generation = viewGeneration.current.token, cid = conversationId;
    const known = view.artifacts.find(item => item.id === artifactId);
    const revision = revisionId ?? known?.revisionId;
    setActionError("");
    if (revision) { setInspectedRun(null); setSelection({ artifactId, revisionId: revision }); }
    else void agentApi.readArtifactHead(artifactId).then(head => {
      if (!mounted.current || viewGeneration.current.token !== generation || openIntent.current !== intent) return;
      const prior = cid ? cache.current.get(cid) : undefined;
      if (prior && cid) {
        const next = { ...prior, artifacts: mergeArtifacts(prior.artifacts, [head]) };
        cache.current.set(cid, next); setView(next);
      }
      setInspectedRun(null); setSelection({ artifactId, revisionId: head.revisionId });
    }).catch(error => { if (viewGeneration.current.token === generation && openIntent.current === intent) setActionError(error.message); });
    if (cid) setNotices(current => {
      const byConversation = new Map(current.byConversation);
      byConversation.set(cid, (byConversation.get(cid) ?? []).filter(value => value !== artifactId));
      return { byConversation };
    });
  };
  // openRun 与面板被动补读共用：按 ID 读 run，连同其引用合入当前会话缓存（E1）。
  const loadRunIntoCache = useCallback(async (id: string, runId: string, current: () => boolean): Promise<boolean> => {
    const run = await agentApi.readRun(runId);
    if (!current()) return false;
    const prior = cache.current.get(id); if (!prior) return false;
    const refs = await hydrateReferences([], { ...prior, runs: mergeRuns(prior.runs, [run]) }, revisionCacheRef.current);
    if (!current()) return false;
    const latest = cache.current.get(id)!;
    const next = { ...latest, artifacts: mergeArtifacts(latest.artifacts, refs.artifacts), proposals: mergeProposals(latest.proposals, refs.proposals), runs: mergeRuns(latest.runs, refs.runs) };
    cache.current.set(id, next); setView(next);
    setRevisionCache(cache => ({ ...cache, ...refs.revisions }));
    setReferenceErrors(errors => {
      const merged = { ...errors, ...refs.errors };
      if (!refs.errors[`run:${runId}`]) delete merged[`run:${runId}`];
      return merged;
    });
    return true;
  }, []);
  const inspectedRunLoaded = view.runs.some(run => run.id === inspectedRun);
  useEffect(() => {
    if (!inspectedRun || inspectedRunLoaded || !conversationId || view.conversation.id !== conversationId) return;
    let disposed = false;
    const generation = viewGeneration.current.token;
    const current = () => !disposed && mounted.current && viewGeneration.current.token === generation;
    setReferenceErrors(errors => { const next = { ...errors }; delete next[`run:${inspectedRun}`]; return next; });
    void loadRunIntoCache(conversationId, inspectedRun, current).catch(error => {
      if (current()) setReferenceErrors(errors => ({ ...errors, [`run:${inspectedRun}`]: error instanceof Error ? error.message : "无法读取制作记录" }));
    });
    return () => { disposed = true; };
  }, [inspectedRun, inspectedRunLoaded, conversationId, view.conversation.id, runReadAttempt, loadRunIntoCache]);
  const openRun = async (runId: string) => {
    if (!conversationId) return;
    const id = conversationId, generation = viewGeneration.current.token, intent = ++openIntent.current;
    const current = () => mounted.current && viewGeneration.current.token === generation && openIntent.current === intent;
    setActionError("");
    try { if (await loadRunIntoCache(id, runId, current)) setInspectedRun(runId); }
    catch (error) { if (current()) setActionError(error instanceof Error ? error.message : "无法读取这条制作记录，请重试。"); }
  };
  // 所看视频修订的 run 不在已加载列表时按 ID 补读（E1）：不跳页、不换制作记录视图；
  // 失败只记 run 级引用错误供面板提示重试，不弹全局错误。
  const ensureRun = async (runId: string) => {
    if (!conversationId) return;
    const id = conversationId, generation = viewGeneration.current.token;
    const current = () => mounted.current && viewGeneration.current.token === generation;
    try { await loadRunIntoCache(id, runId, current); }
    catch (error) {
      if (current()) setReferenceErrors(errors => ({ ...errors, [`run:${runId}`]: error instanceof Error ? error.message : "读取失败" }));
    }
  };
  const retryReferences = async () => {
    if (!conversationId) return;
    const id = conversationId, generation = viewGeneration.current.token;
    const refs = await hydrateReferences(view.messages, view, revisionCacheRef.current);
    if (!mounted.current || viewGeneration.current.token !== generation) return;
    const prior = cache.current.get(id); if (!prior) return;
    const next = { ...prior, artifacts: mergeArtifacts(prior.artifacts, refs.artifacts), proposals: mergeProposals(prior.proposals, refs.proposals), runs: mergeRuns(prior.runs, refs.runs) };
    cache.current.set(id, next); setView(next); setReferenceErrors(refs.errors);
    setRevisionCache(current => ({ ...current, ...refs.revisions }));
  };
  const feedback = useFeedbackDrafts(conversationId, async id => { await refreshSnapshot(id); }, setActionError);
  const feedbackTarget = selection ? { ...selection, workId: null } : null;
  const { text: feedbackDraft, saved: feedbackSaved, busy: savingFeedback } = feedback.forTarget(feedbackTarget);
  const updateFeedback = (text: string) => { if (feedbackTarget) feedback.edit(feedbackTarget, text); };
  const saveFeedback = () => { if (feedbackTarget) return feedback.submit(feedbackTarget); };

  useEffect(() => {
    const element = chatScroll.current;
    if (element && pinnedBottom.current) element.scrollTop = element.scrollHeight;
  }, [view.messages, streaming, draftPanels, contextNote]);
  const onChatScroll = () => {
    scrollIntent.current++;
    const element = chatScroll.current;
    if (!element) return;
    pinnedBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
    if (pinnedBottom.current) setUnseenMessages(false);
  };
  const loadOlder = async () => {
    if (!conversationId || !view.olderCursor) return;
    const id = conversationId, cursor = view.olderCursor, generation = viewGeneration.current.token;
    const key = `${generation}:${id}:${cursor}`;
    if (paging.current.has(key)) return;
    paging.current.add(key);
    const scroll = scrollIntent.current;
    const anchor = [...(chatScroll.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])]
      .find(item => item.getBoundingClientRect().bottom > (chatScroll.current?.getBoundingClientRect().top ?? 0));
    const top = anchor?.getBoundingClientRect().top;
    try {
      const page = await agentApi.loadMoreMessages(id, cursor);
      if (!mounted.current || viewGeneration.current.token !== generation) return;
      const prior = cache.current.get(id); if (!prior) return;
      const refs = await hydrateReferences(page.items, prior, revisionCacheRef.current);
      if (!mounted.current || viewGeneration.current.token !== generation) return;
      const latest = cache.current.get(id)!;
      const next = { ...latest, messages: mergeMessages(latest.messages, page.items),
        artifacts: mergeArtifacts(latest.artifacts, refs.artifacts), proposals: mergeProposals(latest.proposals, refs.proposals), runs: mergeRuns(latest.runs, refs.runs),
        olderCursor: latest.olderCursor === cursor ? page.nextCursor : latest.olderCursor };
      cache.current.set(id, next); setView(next);
      setRevisionCache(current => ({ ...current, ...refs.revisions })); setReferenceErrors(current => ({ ...current, ...refs.errors }));
      requestAnimationFrame(() => {
        if (chatScroll.current && anchor?.isConnected && top !== undefined && viewGeneration.current.token === generation && scrollIntent.current === scroll) {
          chatScroll.current.scrollTop += anchor.getBoundingClientRect().top - top;
        }
      });
    } catch (error) { if (viewGeneration.current.token === generation) setActionError(error instanceof Error ? error.message : "读取更早消息失败。"); }
    finally { paging.current.delete(key); }
  };
  const loadMoreOutputs = async (kind: "artifacts" | "proposals" | "runs") => {
    if (!conversationId) return;
    const id = conversationId, generation = viewGeneration.current.token;
    const field = kind === "artifacts" ? "artifactCursor" : kind === "proposals" ? "proposalCursor" : "runCursor";
    const cursor = view[field]; if (!cursor) return;
    const key = `${generation}:${id}:${kind}:${cursor}`;
    if (paging.current.has(key)) return;
    paging.current.add(key);
    try {
      const page = kind === "artifacts" ? await agentApi.loadMoreArtifacts(id, cursor) : kind === "proposals" ? await agentApi.loadMoreProposals(id, cursor) : await agentApi.loadMoreRuns(id, cursor);
      if (!mounted.current || viewGeneration.current.token !== generation) return;
      const prior = cache.current.get(id); if (!prior) return;
      const refs = await hydrateReferences([], {
        artifacts: kind === "artifacts" ? mergeArtifacts(prior.artifacts, page.items as ArtifactHead[]) : prior.artifacts,
        proposals: kind === "proposals" ? mergeProposals(prior.proposals, page.items as Proposal[]) : prior.proposals,
        runs: kind === "runs" ? mergeRuns(prior.runs, page.items as Run[]) : prior.runs,
      }, revisionCacheRef.current);
      if (!mounted.current || viewGeneration.current.token !== generation) return;
      const latest = cache.current.get(id)!;
      const next = { ...latest, artifacts: mergeArtifacts(latest.artifacts, refs.artifacts), proposals: mergeProposals(latest.proposals, refs.proposals), runs: mergeRuns(latest.runs, refs.runs),
        [field]: latest[field] === cursor ? page.nextCursor : latest[field] };
      cache.current.set(id, next); setView(next); setRevisionCache(current => ({ ...current, ...refs.revisions }));
      setReferenceErrors(current => ({ ...current, ...refs.errors }));
    } catch (error) { if (viewGeneration.current.token === generation) setActionError(error instanceof Error ? error.message : "读取失败。"); }
    finally { paging.current.delete(key); }
  };
  const loadMoreConversations = async () => {
    if (!conversationCursor) return;
    try { const page = await agentApi.listConversations(conversationCursor); setConversations(current => mergeConversations(current, page.items)); setConversationCursor(page.nextCursor); }
    catch (error) { setActionError(error instanceof Error ? error.message : "读取失败。"); }
  };

  // 正式审阅组的卡片仍在组面板双区阅读，不能绕进独立查看器。
  const selectedReview = useMemo(() => {
    if (!selection) return null;
    const related = view.works.flatMap(work => work.reviewGroups.flatMap(group => group.items.flatMap(item => {
      const sources = [item.draft, item.approved, item.finalizedSource].filter(source => source?.kind === "artifact_revision" && source.artifactId === selection.artifactId);
      return sources.length ? [{ workId: work.id, groupId: group.id, itemId: item.id,
        exact: sources.some(source => source?.kind === "artifact_revision" && source.revisionId === selection.revisionId) }] : [];
    })));
    const exact = related.filter(item => item.exact);
    const matches = exact.length ? exact : related;
    // 来源不唯一或已经脱离当前事项时保留准确修订只读，不猜测某个视频事项。
    const match = matches.length === 1 ? matches[0]! : null;
    return match ? { ...selection, workId: match.workId, groupId: match.groupId, itemId: match.itemId } : null;
  }, [selection, view.works]);
  useEffect(() => {
    if (!selectedReview) return;
    setSelectedWorkId(selectedReview.workId);
    setReviewNavigation(selectedReview);
    setSelection(null);
  }, [selectedReview]);
  const openArtifactHead = selection && !selectedReview ? view.artifacts.find(item => item.id === selection.artifactId) ?? null : null;
  const openRevision = selection ? revisionCache[`${selection.artifactId}:${selection.revisionId}`] ?? null : null;
  // 独立查看器与阶段面板一致：历史修订只读，意见/修改只针对最新稿（服务端合同只接受 head）。
  const viewingOldRevision = Boolean(selection && openArtifactHead && openArtifactHead.revisionId !== selection.revisionId);
  const unresolvedVideo = Boolean(openArtifactHead?.workId && openArtifactHead.kind === "video");
  const previewReadOnly = viewingOldRevision || unresolvedVideo;
  const standaloneScript = openArtifactHead?.kind === "script" && openArtifactHead.workId === null;
  useEffect(() => {
    if (!conversationId || !selection || !openRevision || page !== "chat" || inspectedRun || openArtifactHead?.revisionId !== selection.revisionId) return;
    setNotices(current => {
      const unread = current.byConversation.get(conversationId) ?? [];
      if (!unread.includes(selection.artifactId)) return current;
      const byConversation = new Map(current.byConversation);
      byConversation.set(conversationId, unread.filter(id => id !== selection.artifactId));
      return { byConversation };
    });
  }, [conversationId, selection, openRevision, openArtifactHead?.revisionId, page, inspectedRun]);
  const canSend = model?.availability === "configured";
  const materialAdoptDisabled = !canSend || Boolean(skillMutation) || sendingNow || Boolean(conversationId && pendingSend[conversationId]) || Boolean(view.activeRequestId);
  const sortedMessages = useMemo(() => view.messages, [view.messages]);

  const openConversation = (id: string) => { setPage("chat"); navigate(`/agent/${id}`); };
  const activeRuns = view.runs.filter(run => !runEnded(run.state));
  const selectedRun = view.runs.find(run => run.id === inspectedRun);
  if (selectedWorkId) lastSelectedWork.current = selectedWorkId;
  const workMode = view.works.length > 0 && !inspectedRun && !openArtifactHead && !openBatchId;
  useEffect(() => {
    // 隐藏视图保留输入与阅读位置，但不能继续在后台播放声音或解码视频。
    chatWorkspace.current?.querySelectorAll<HTMLMediaElement>("video, audio").forEach(media => {
      if (!media.paused && media.closest("[hidden]")) media.pause();
    });
  }, [page, workMode, selectedWorkId]);
  // 批次有自己的作品归属；独立展开，避免借用当前作品标题。
  const openBatch = (batchId: string) => {
    openIntent.current++;
    setSelection(null); setInspectedRun(null);
    setOpenBatchId(batchId);
  };
  const backToWork = () => { openIntent.current++; setSelection(null); setInspectedRun(null); setOpenBatchId(null); };
  const selectWork = (id: string | null) => { backToWork(); setReviewNavigation(null); setSelectedWorkId(id); };
  const openReview = (target: ReviewNavigation) => { backToWork(); setSelectedWorkId(target.workId); setReviewNavigation(target); };
  const cacheRevision = (revision: ArtifactRevision) => setRevisionCache(current => current[`${revision.artifactId}:${revision.revisionId}`] ? current : ({ ...current, [`${revision.artifactId}:${revision.revisionId}`]: revision }));
  const progressCard = (compact = false) => <TaskProgress activeRequestId={view.activeRequestId} messages={view.requestMessages} progress={requestProgress} runs={activeRuns}
    works={view.works} disconnected={streamDisconnected} compact={compact} onStop={stopActive} onOpenRun={runId => void openRun(runId)} onOpenWork={selectWork}
    onOpenChat={() => { chatPanel.current?.expand(); setFocusPreview(false); if (view.windowAnchor) navigate(`/agent/${conversationId}`); }} />;
  const title = view.conversation.title || "新的对话";
  const discussArtifact = () => {
    if (!openArtifactHead) return;
    bindTarget(openArtifactHead);
    composerInput.current?.focus();
  };
  // 暂态事件只在本回合仍在进行时展示；回合结束即让位于正式事实。
  const turnLive = (requestId: string | null) => requestId !== null && (view.activeRequestId === requestId || streaming?.requestId === requestId);
  const visibleDrafts = Object.values(draftPanels).filter(draft => draft.state === "streaming" && turnLive(draft.requestId));
  const visibleContextNote = contextNote && turnLive(contextNote.requestId) ? contextNote : null;
  const contextNoteText = visibleContextNote ? ({
    compacting: "正在整理上下文…",
    compacted: "上下文已整理。",
    failed: "上下文整理未完成，已提交的内容保留。",
    cancelled: "上下文压缩已取消。",
  } as const)[visibleContextNote.phase] : null;

  return <div className={`agent-root${sidebarHidden || focusPreview ? " sidebar-hidden" : ""}${focusPreview ? " review-focused" : ""}`}>
    <nav className="agent-rail" aria-label="主导航">
      <button type="button" className="agent-rail-brand" aria-label="Frame 新对话" title="Frame · 新对话" onClick={() => void createConversation()}>f.</button>
      <button type="button" aria-label="新建对话" title="新建对话" onClick={() => void createConversation()}><Plus /><span className="agent-rail-label">新建</span></button>
      <button type="button" aria-label={page === "chat" ? (sidebarHidden || focusPreview ? "展开会话列表" : "收起会话列表") : "返回当前对话"} title={page === "chat" ? "会话列表" : "返回当前对话"}
        aria-current={page === "chat" ? "page" : undefined} aria-expanded={!sidebarHidden && !focusPreview}
        onClick={() => { if (page !== "chat" || focusPreview) { setPage("chat"); chatPanel.current?.expand(); setFocusPreview(false); } else setSidebarHidden(value => !value); }}><MessageSquare /><span className="agent-rail-label">对话</span></button>
      <button type="button" aria-label="打开作品库" title="作品库" aria-current={page === "library" ? "page" : undefined} onClick={() => setPage("library")}><Film /><span className="agent-rail-label">作品库</span></button>
      <div className="agent-rail-bottom"><button type="button" aria-label="打开模型配置" title="模型配置" aria-current={page === "models" ? "page" : undefined} onClick={() => setPage("models")}><Cpu /><span className="agent-rail-label">模型</span></button>
        <button type="button" aria-label="打开免费服务" title="免费服务" aria-current={page === "services" ? "page" : undefined} onClick={() => setPage("services")}><PlugZap /><span className="agent-rail-label">免费服务</span></button>
        <button type="button" aria-label="打开 Skill 管理" title="Skill 管理" aria-current={page === "skills" ? "page" : undefined} onClick={() => setPage("skills")}><Sparkles /><span className="agent-rail-label">Skill</span></button>
        <button type="button" aria-label="打开个人设置" title="个人设置" aria-current={page === "profile" ? "page" : undefined} onClick={() => setPage("profile")}><UserRound /><span className="agent-rail-label">我的</span></button></div>
    </nav>
    <aside className="agent-side">
      <div className="agent-brand"><span className="agent-brand-mark">f.</span><div><span className="agent-brand-name">帧间 <em>Frame</em></span><span className="agent-brand-caption">YOUR VIDEO AGENT</span></div></div>
      <button className="agent-new-chat" type="button" aria-label="＋ 新的会话" onClick={() => void createConversation()}><Plus />新对话</button>
      <span className="agent-nav-label">对话</span>
      <nav className="agent-conversation-list" aria-label="会话列表">{conversations.map(conversation => {
        const notice = notices.byConversation.get(conversation.id);
        return <div key={conversation.id} className={`agent-conversation${conversation.id === conversationId && page === "chat" ? " active" : ""}`}>
          {renaming?.id === conversation.id && conversation.id !== conversationId ? <input autoFocus className="agent-rename-input" value={renaming.title}
            onChange={event => setRenaming({ id: conversation.id, title: event.target.value })}
            onBlur={() => void commitRename(conversation.id, renaming.title.trim() || conversation.title, conversation.revision)}
            onKeyDown={event => { if (event.key === "Enter") void commitRename(conversation.id, renaming.title.trim() || conversation.title, conversation.revision); if (event.key === "Escape") setRenaming(null); }} aria-label="会话名称" />
            : <button type="button" className="agent-conversation-open" onClick={() => openConversation(conversation.id)}><MessageSquare /><span className="agent-conversation-title">{conversation.title}</span>{notice?.length ? <span className="agent-notice-dot" aria-label="有新产出" title="有新产出" /> : null}</button>}
          <button type="button" className="agent-conversation-rename" aria-label="改名" onClick={() => setRenaming({ id: conversation.id, title: conversation.title })}><Pencil /></button>
        </div>;
      })}{conversationCursor ? <button type="button" onClick={() => void loadMoreConversations()}>更多会话</button> : null}</nav>
      <nav className="agent-module-nav" aria-label="设置">
        <button type="button" className={page === "models" ? "active" : ""} onClick={() => setPage("models")}><Cpu />模型配置</button>
        <button type="button" className={page === "services" ? "active" : ""} onClick={() => setPage("services")}><PlugZap />免费服务</button>
        <button type="button" className={page === "skills" ? "active" : ""} onClick={() => setPage("skills")}><Sparkles />Skill 管理</button>
        <button type="button" className={page === "library" ? "active" : ""} onClick={() => setPage("library")}><Film />作品库</button>
        <button type="button" className={`agent-profile-link ${page === "profile" ? "active" : ""}`} onClick={() => setPage("profile")}><span className="agent-user-avatar">创</span><span><strong>{bootstrap?.displayName ?? "创作者"}</strong><small>用户页</small></span><ChevronRight /></button>
      </nav>
    </aside>
    <main className="agent-frame">
      <header className="agent-topbar agent-chat-header">
        <button type="button" className="agent-icon-button" aria-label="切换侧栏" onClick={() => setSidebarHidden(value => !value)}><PanelLeft /></button>
        <div className="agent-topbar-title">{renaming?.id === conversationId && conversationId ? <input autoFocus className="agent-rename-input" aria-label="会话名称" value={renaming.title} onChange={event => setRenaming({ id: conversationId, title: event.target.value })} onBlur={() => void commitRename(conversationId, renaming.title.trim() || title, view.conversation.revision)} onKeyDown={event => { if (event.key === "Enter") void commitRename(conversationId, renaming.title.trim() || title, view.conversation.revision); if (event.key === "Escape") setRenaming(null); }} /> : <h1 onDoubleClick={() => conversationId && setRenaming({ id: conversationId, title })}>{page === "chat" ? title : framePageTitle[page]}</h1>}</div>
        <button type="button" className="agent-title-rename" aria-label="重命名当前对话" hidden={page !== "chat" || !conversationId} onClick={() => conversationId && setRenaming({ id: conversationId, title })}><Pencil /></button>
        <span className="agent-runtime-label">{model?.availability === "configured" ? `${model.name}${isSimulated ? " · 模拟媒体" : ""}` : "文本模型待配置"}</span>
      </header>
      <FrameSettings page={page} bootstrap={bootstrap} conversations={conversations} onConversation={openConversation} onPage={setPage} onLogout={onLogout} onCatalogRefresh={refreshBootstrap} onSkillMutationChange={setSkillMutation} onLibraryBringIn={bringLibraryPicks} libraryBringTarget={conversationId ? "current" : "new"} />
      <div ref={chatWorkspace} className="agent-chat-workspace" hidden={page !== "chat"}>
      {connectionState ? <div role="status" className="agent-connection-state">{connectionState}<button type="button" onClick={() => conversationId && void refreshSnapshot(conversationId, true)}>重新连接</button></div> : null}
      {actionError || bootError ? <div className="agent-action-error" role="alert">{actionError || bootError}<button type="button" onClick={() => setActionError("")}>知道了</button></div> : null}
      {focusPreview ? progressCard(true) : null}
      <Group className="agent-main" orientation="horizontal" id="vf-agent-panels" onLayoutChanged={layout => { if (layout["agent-chat"]) savePanelLayout(layout); }} defaultLayout={panelLayout ?? undefined}>
        <Panel id="agent-chat" defaultSize="36%" minSize="340px" collapsible panelRef={chatPanel} onResize={size => setFocusPreview(size.asPercentage === 0)}>
          <section className="agent-chat" inert={focusPreview}>
            <div className="agent-chat-title"><MessageSquare />与 Frame 协作</div>
            <div className="agent-messages" ref={chatScroll} onScroll={onChatScroll}>
              {view.windowAnchor ? <div className="agent-window-banner" role="status">
                <span>正在查看这条定稿的产出位置，之后的消息未展开</span>
                <button type="button" onClick={() => navigate(`/agent/${encodeURIComponent(conversationId!)}`)}>回到最新消息</button>
              </div> : null}
              {view.olderCursor ? <button className="agent-load-older" type="button" onClick={() => void loadOlder()}>加载更早的消息</button> : null}
              {!sortedMessages.length ? <FrameWelcome onChoose={text => { updateDraftText(text); composerInput.current?.focus(); }} /> : null}
              {sortedMessages.map(message => <MessageRow works={view.works} key={message.id} message={message} anchored={view.windowAnchor?.messageId === message.id} onOpenArtifact={openArtifact} artifacts={view.artifacts} proposals={view.proposals} runs={view.runs} onOpenRun={runId => void openRun(runId)} onOpenBatch={openBatch} materialBatches={view.materialBatches} onAccept={proposal => void acceptProposal(proposal)} onReply={proposal => { replyToProposal(proposal); composerInput.current?.focus(); }} accepting={accepting} revisions={revisionCache} errors={referenceErrors} onRetry={() => void retryReferences()} />)}
              {visibleContextNote ? <div className="agent-context-note" role="status" data-phase={visibleContextNote.phase} data-testid="context-status">{contextNoteText}</div> : null}
              {visibleDrafts.map(visibleDraft => <div key={visibleDraft.draftId} className="agent-message assistant draft" data-testid="artifact-draft" aria-live="polite">
                <span className="agent-assistant-avatar">f·</span>
                <div className="agent-message-content">
                  <span className="agent-author">Frame · 正在写</span>
                  {visibleDraft.items.length === 0 ? <span className="agent-draft-empty">正在准备交付内容…</span> : visibleDraft.items.map(item => <div className="agent-draft-item" key={item.itemIndex} data-kind={item.kind ?? "unknown"}>
                    <strong>{item.title ?? `第 ${item.itemIndex + 1} 份`}</strong>
                    {item.kind ? <span className="agent-draft-kind">{{ prompt: "Prompt", script: "脚本", analysis: "分析" }[item.kind]}</span> : null}
                    <div className="agent-draft-text"><MarkdownText text={item.text || "正在写…"} /></div>
                  </div>)}
                </div>
              </div>)}
              {!focusPreview ? progressCard() : null}
              {streaming ? <div className="agent-message assistant streaming" data-testid="streaming-message"><span className="agent-assistant-avatar">f·</span><div className="agent-message-content"><span className="agent-author">Frame</span><MarkdownText text={streaming.text || "正在想…"} /></div></div> : null}
            </div>
            {unseenMessages && !view.windowAnchor ? <button className="agent-new-messages" type="button" onClick={() => { pinnedBottom.current = true; setUnseenMessages(false); if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight; }}>回到最新消息 ↓</button> : null}
            <footer className="agent-composer">
              {skillNotice ? <p className="agent-config-note" role="status">{skillNotice}</p> : null}
              {skillMutation ? <p className="agent-config-note" role="status">Skill 目录正在更新，聊天草稿已保留。<button type="button" className="agent-text-link" onClick={() => setPage("skills")}>查看进度</button></p> : null}
              {currentDraft.proposalId ? <div className="agent-target-chip"><span>回复《{view.proposals.find(p => p.id === currentDraft.proposalId)?.spec.title ?? "已选提案"}》 · 制作请发送「确认制作」，也可继续讨论</span><button type="button" onClick={() => updateDraft({ proposalId: null, proposalDigest: null })} aria-label="清除提案引用"><X /></button></div> : null}
              {currentDraft.targetArtifactId ? <div className="agent-target-chip">针对：{view.artifacts.find(item => item.id === currentDraft.targetArtifactId)?.title ?? "已选作品"}<button type="button" onClick={unbindTarget} aria-label="清除修改目标"><X /></button></div> : null}
              {currentDraft.librarySelections?.length ? <div className="agent-library-chips">
                {currentDraft.librarySelections.map((pick, index) => <span className="agent-library-chip" key={index}>作品库 · {pick.label}<button type="button" onClick={() => removeLibrarySelection(index)} aria-label={`移除 ${pick.label}`}><X /></button></span>)}
              </div> : null}
              <div className="agent-composer-card">
                <textarea ref={composerInput} value={currentDraft.text} onChange={event => updateDraftText(event.target.value)} onKeyDown={event => { if (canSend && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder={view.activeRequestId ? "补充本轮要求，或排队安排下一步…" : "说说想法，改改作品，或换件事聊…"} aria-label="消息输入" aria-describedby="agent-composer-hint" />
                <div className="agent-composer-tools"><label className="agent-skill-selector"><Sparkles /><select aria-label="指定 Skill" disabled={!!currentDraft.proposalId || Boolean(skillMutation)} value={skillId ?? ""} onChange={event => { setSkillId(event.target.value || null); setSkillNotice(""); }}><option value="">Skill · 自动选择</option>{bootstrap?.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label>
                  <button type="button" className="agent-library-picker-trigger" aria-label="从作品库选择" title="从作品库选择素材或制作文件" disabled={Boolean(skillMutation)} ref={libraryPickerTrigger} onClick={() => { setSkillNotice(""); setLibraryPickerOpen(true); }}><Film aria-hidden="true" />作品库</button>
                  <div className="agent-send-actions">{view.activeRequestId ? <button type="button" disabled={!!currentDraft.proposalId || Boolean(skillMutation) || !currentDraft.text.trim() || sendingNow || !!pendingSend[conversationId!]} onClick={() => void sendMessage("steer")}>干预本轮</button> : null}<button className="agent-send" data-queued={Boolean(view.activeRequestId) || undefined} type="button" aria-label={view.activeRequestId ? "排队发送" : "发送"} title={view.activeRequestId ? "等待当前请求完成后处理" : "发送"} onClick={() => void sendMessage()} disabled={!canSend || Boolean(skillMutation) || !currentDraft.text.trim() || sendingNow || !!pendingSend[conversationId!]}>{view.activeRequestId ? <span>排队</span> : null}<ArrowUp /></button></div>
                </div>
              </div>
              {canSend ? <span id="agent-composer-hint" className="agent-composer-hint">Enter {view.activeRequestId ? "排队发送" : "发送"} · Shift + Enter 换行</span> : <div id="agent-composer-hint" className="agent-config-note" role="status">{bootstrap ? <>可以先写草稿，发送前请<button className="agent-text-link" type="button" onClick={() => setPage("models")}>配置文本模型</button>。</> : "可以先写草稿。"}</div>}
              {conversationId && pendingSend[conversationId] && !sendingNow ? <button type="button" className="agent-retry-send" onClick={() => void sendMessage("new", true)}>重试上次发送（保留原请求）</button> : null}
            </footer>
            {libraryPickerOpen ? <LibraryPickerDialog
              onClose={() => { setLibraryPickerOpen(false); libraryPickerTrigger.current?.focus(); }}
              onConfirm={picks => updateDraft(draft => ({ librarySelections: mergeLibraryPicks(draft.librarySelections, picks) }))} /> : null}
          </section>
        </Panel>
        <Separator className="agent-resizer" aria-label="调整对话与预览的宽度" title="拖动或用左右方向键调整宽度" />
        <Panel id="agent-preview" minSize="620px">
          <section className="agent-preview">
            <div className="agent-workspace-status"><Film /><strong>{focusPreview ? "聚焦审片" : "作品中心"}</strong>{view.runs.length ? <button type="button" onClick={() => void openRun(view.runs[0]!.id)}>制作记录 · {view.runs.length}</button> : null}<button type="button" aria-label={focusPreview ? "返回聊天与作品" : "展开作品区"} title={focusPreview ? "返回聊天与作品" : "展开作品区"} onClick={() => { if (focusPreview) chatPanel.current?.expand(); else chatPanel.current?.collapse(); setFocusPreview(!focusPreview); }}>{focusPreview ? <ArrowLeft /> : <Maximize2 />}{focusPreview ? "返回创作" : "聚焦审片"}</button></div>
            {!workMode && view.artifacts.length ? <div className="agent-artifact-tabs" data-work-mode={workMode || undefined} aria-label="当前会话产物">{view.artifacts.map(artifact => <button type="button" key={artifact.id} aria-label={artifact.title} title={artifact.title} aria-pressed={!inspectedRun && selection?.artifactId === artifact.id} onClick={() => openArtifact(artifact.id)}><span className="agent-artifact-icon"><ArtifactIcon kind={artifact.kind} /></span><span><strong>{artifact.title}</strong><small>{stageOwnedLabel(view.works, artifact)}就绪</small></span>{notices.byConversation.get(conversationId ?? "")?.includes(artifact.id) ? <span className="agent-output-badge">有更新</span> : null}</button>)}{view.artifactCursor ? <button type="button" onClick={() => void loadMoreOutputs("artifacts")}>更多产物</button> : null}</div> : null}
            <div className="agent-workspace-scroll" data-mode={workMode ? "work" : undefined} data-proposals-open={workMode && proposalsOpen || undefined}>
              {selectedRun ? <article className="agent-paper"><header className="agent-preview-header"><h2>制作记录</h2><button type="button" onClick={() => { openIntent.current++; setInspectedRun(null); }}>回到作品</button></header><RunCard key={selectedRun.id} run={selectedRun} onCancel={r => void cancelProduction(r)} onOpen={openArtifact} simulated={isSimulated} proposals={view.proposals} artifacts={view.artifacts} revisions={revisionCache} works={view.works} onRetry={() => void retryReferences()} />
                {view.runs.length > 1 || view.runCursor ? <details className="agent-run-history"><summary>其他制作记录</summary><div className="agent-production-actions">{view.runs.filter(run => run.id !== selectedRun.id).map(run => <button key={run.id} type="button" onClick={() => void openRun(run.id)}>{run.title}</button>)}{view.runCursor ? <button type="button" onClick={() => void loadMoreOutputs("runs")}>更早的制作</button> : null}</div></details> : null}</article>
              : inspectedRun ? <article className="agent-paper"><header className="agent-preview-header"><h2>制作记录</h2><button type="button" onClick={backToWork}>回到作品</button></header><div className="agent-preview-body" role="status">{referenceErrors[`run:${inspectedRun}`] ? <>制作记录读取失败。<button type="button" onClick={() => setRunReadAttempt(value => value + 1)}>重试读取制作记录</button></> : "正在恢复制作记录…"}</div></article>
              : openArtifactHead ? <article className="agent-paper">
                <header className="agent-preview-header"><h2>{openArtifactHead.title}</h2><div className="agent-paper-tools">{view.works.length ? <button className="agent-text-link" type="button" onClick={backToWork}>回到创作</button> : null}<details className="agent-version-picker"><summary>{stageOwnedLabel(view.works, openArtifactHead)} v{openRevision?.revisionNumber ?? "…"}</summary><div>{openRevision?.baseRevisionId ? <button type="button" onClick={() => openArtifact(openArtifactHead.id, openRevision.baseRevisionId!)}>上一版</button> : null}{selection?.revisionId !== openArtifactHead.revisionId ? <button type="button" onClick={() => openArtifact(openArtifactHead.id)}>查看最新 v{openArtifactHead.revisionNumber}</button> : <span>当前最新版本</span>}</div></details>{previewReadOnly
                  ? <span className="agent-stage-muted">{unresolvedVideo ? "未定位审阅事项 · 只读" : "历史版本仅阅读"}</span>
                  : <button className="agent-feedback-trigger" type="button" disabled={lockedArtifacts.has(openArtifactHead.id)} onClick={discussArtifact}><Pencil />{lockedArtifacts.has(openArtifactHead.id) ? "制作中 · 输入已锁定" : "提意见"}</button>}</div></header>
                <div className={standaloneScript ? "agent-standalone-script" : undefined}>
                <section aria-label={standaloneScript ? "草稿与修改" : undefined}>
                {standaloneScript ? <div className="agent-work-pane-title"><h3>草稿与修改</h3>{openRevision ? <span>v{openRevision.revisionNumber}</span> : null}</div> : null}
                <div className="agent-preview-body">{openRevision ? openRevision.content.format === "markdown" ? <MarkdownBody content={openRevision.content} /> : openRevision.content.format === "media" ? <MediaPreview content={openRevision.content} simulated={isSimulated} /> : openRevision.content.format === "file" ? <FilePreview content={openRevision.content} /> : <ProjectPreview content={openRevision.content} /> : <div className="agent-preview-loading">正在读取…</div>}</div>
                <footer className="agent-preview-actions">
                  {standaloneScript && !viewingOldRevision && openRevision ? openArtifactHead.standaloneApproval?.revisionId === openRevision.revisionId
                    ? <span className="agent-stage-muted">这一版已认可。</span>
                    : <button type="button" className="agent-stage-secondary" disabled={reviewBusyKeys.includes(`standalone:${openArtifactHead.id}`)}
                        onClick={() => void approveStandalone(openArtifactHead, openRevision)}>认可这一版</button> : null}
                  {previewReadOnly ? <><span className="agent-stage-muted">{unresolvedVideo ? "未能唯一定位这版视频的审阅事项，当前仅供查看。请从作品中选择要讨论的事项。" : "正在看历史版本，意见和修改请回到最新稿。"}</span>{feedbackDraft ? <label>旧稿的未发送意见<textarea aria-label="意见" readOnly value={feedbackDraft} /></label> : null}</> : <>
                    <button className="agent-text-link" type="button" onClick={() => setFeedbackOpen(value => !value)}>{lockedArtifacts.has(openArtifactHead.id) ? "留下下一版意见" : "只记录意见"}</button>
                    {isSimulated && openRevision?.content.format === "markdown" ? <button className="agent-text-link" type="button" disabled={lockedArtifacts.has(openArtifactHead.id)} onClick={() => { if (currentDraft.text.trim()) { setActionError("输入框还有草稿，请先处理这条消息，再准备制作提案。"); return; } updateDraft({ text: "按这份准备制作提案，先不要开始", targetArtifactId: openArtifactHead.id, targetRevisionId: selection!.revisionId, proposalId: null, proposalDigest: null }); composerInput.current?.focus(); }}>准备模拟提案</button> : null}
                    {feedbackOpen ? <div className="agent-feedback-box"><label>这条意见只记录，不会自动改稿<textarea value={feedbackDraft} onChange={event => updateFeedback(event.target.value)} placeholder="留给这一版的意见…" aria-label="意见" /></label><button type="button" onClick={() => void saveFeedback()} disabled={!feedbackDraft.trim() || savingFeedback}>记录意见</button></div> : null}
                  </>}
                  {feedbackSaved ? <span role="status" className="agent-feedback-saved">{feedbackSaved}</span> : null}
                </footer>
                </section>
                {standaloneScript ? <StandaloneScriptApproval artifact={openArtifactHead} revisions={revisionCache}
                  onRevisionLoaded={revision => setRevisionCache(current => ({ ...current, [`${revision.artifactId}:${revision.revisionId}`]: revision }))} /> : null}
                </div>
              </article>
              : openBatchId ? <article className="agent-paper" data-testid="standalone-batch">
                <header className="agent-preview-header"><h2>素材批次</h2><button type="button" className="agent-text-link" onClick={() => { openIntent.current++; setOpenBatchId(null); }}>返回</button></header>
                <div className="agent-preview-body">
                  <MaterialBatchCard batchId={openBatchId} summary={view.materialBatches.find(batch => batch.batchId === openBatchId) ?? null} works={view.works} open onToggle={() => {}}
                    onAdopt={adoptMaterial} adoptDisabled={materialAdoptDisabled} />
                </div>
              </article>
              : !view.works.length ? <FrameEmptyPreview /> : null}
              {view.works.length ? <div style={{ display: "contents" }} hidden={!workMode}><WorkCenter key={conversationId} active={page === "chat" && workMode}
                works={view.works} selectedWorkId={selectedWorkId} onSelectWork={selectWork} onOpenReview={openReview}
                revisions={revisionCache} onRevisionLoaded={cacheRevision} artifacts={view.artifacts} onOpenArtifact={openArtifact}
                hasMoreArtifacts={Boolean(view.artifactCursor)} onMoreArtifacts={() => void loadMoreOutputs("artifacts")}>
              <WorkStagePanel key={conversationId}
                active={page === "chat" && workMode && selectedWorkId !== null} onOpenReview={openReview}
                conversationId={conversationId!}
                works={view.works} selectedWorkId={selectedWorkId ?? lastSelectedWork.current}
                navigation={reviewNavigation}
                revisions={revisionCache}
                runs={view.runs} materialBatches={view.materialBatches}
                onAdoptMaterial={adoptMaterial} adoptDisabled={materialAdoptDisabled}
                onConfirmReview={(work, group, action, entries, label) => confirmReview(work, group, action, entries, label)}
                onContinueReview={(work, group, label) => continueReview(work, group, label)}
                onAdoptPreview={adoptPreview}
                reviewBusyKeys={reviewBusyKeys} reviewRequests={reviewRequests} canContinueText={canSend}
                onOpenRun={runId => void openRun(runId)}
                onEnsureRun={runId => void ensureRun(runId)} referenceErrors={referenceErrors}
                feedback={feedback}
                simulated={isSimulated} openBatchId={openBatchId}
                onRevisionLoaded={cacheRevision}
              /></WorkCenter></div> : null}
              {view.proposals.length || view.proposalCursor ? <details className="agent-proposals-list" open={proposalsOpen} onToggle={event => setProposalsOpen(event.currentTarget.open)}><summary>制作提案 · {view.proposals.length}</summary>{proposalsOpen ? <>{view.proposals.map(proposal => <ProposalCard key={proposal.id} proposal={proposal} onAccept={p => void acceptProposal(p)} onReply={replyToProposal} busy={accepting.includes(proposal.id)} artifacts={view.artifacts} revisions={revisionCache} works={view.works} onOpen={openArtifact} onOpenRun={runId => void openRun(runId)} />)}{view.proposalCursor ? <button type="button" onClick={() => void loadMoreOutputs("proposals")}>更多提案</button> : null}</> : null}</details> : null}
            </div>
          </section>
        </Panel>
      </Group>
      </div>
    </main>
  </div>;
}

function MessageRow({ works, message, anchored, onOpenArtifact, artifacts, proposals, runs, onOpenRun, onOpenBatch, materialBatches, onAccept, onReply, accepting, revisions, errors, onRetry }: {
  works: Work[]; message: Message; anchored?: boolean; onOpenArtifact: (artifactId: string, revisionId: string) => void; artifacts: ArtifactHead[];
  proposals: Proposal[]; runs: Run[]; onOpenRun: (runId: string) => void; onOpenBatch: (batchId: string) => void; materialBatches: MaterialBatchIndexItem[];
  onAccept?: ((proposal: Proposal) => void) | undefined; onReply: (proposal: Proposal) => void; accepting: string[];
  revisions: Record<string, ArtifactRevision>; errors: Record<string, string>; onRetry: () => void;
}) {
  const isUser = message.role === "user", notice = message.role === "system_notice";
  const targetTitle = message.feedback?.workId ? works.find(work => work.id === message.feedback?.workId)?.title ?? "已选创作"
    : message.target ? artifacts.find(artifact => artifact.id === message.target?.artifactId)?.title ?? "已选作品" : null;
  // 片段针对（B1）：按 runId+segmentId 找回该次运行里的片段标题；找不到就说明段已不在，不猜。
  const segment = message.target?.segment ?? null;
  const segmentTitle = segment
    ? runs.find(run => run.id === segment.runId)?.segments.find(item => item.segmentId === segment.segmentId)?.title ?? null
    : null;
  const unavailable = (key: string, label: string) => <div className="agent-reference-error" key={key}>
    <span>{label} · {errors[key] ? "暂不可读" : "正在读取"}</span><button type="button" onClick={onRetry}>重试读取</button>
  </div>;
  return <div className={`agent-message ${notice ? "notice" : isUser ? "user" : "assistant"}`} data-message-id={message.id} data-state={message.state} data-kind={message.kind} data-anchor={anchored || undefined}>
    {!isUser && !notice ? <span className="agent-assistant-avatar">f·</span> : null}
    <div className="agent-message-content">
      {!isUser && !notice ? <span className="agent-author">Frame</span> : null}
      {message.feedback ? <span className="agent-feedback-tag">{message.feedback.disposition === "next_version" ? "意见（留给下一版）" : "修改意见"}</span> : null}
      {targetTitle ? <span className="agent-message-target">针对：{targetTitle}{segment ? ` · 片段「${segmentTitle ?? "已不在当前版本"}」` : ""}</span> : null}
      <MarkdownText text={message.text} />
      {message.librarySelections.length ? <div className="agent-library-chips">
        {message.librarySelections.map((selection, index) => <span className="agent-library-chip" key={index}>作品库 · {selection.source.kind === "project_file" ? selection.source.relativePath : "素材"}</span>)}
      </div> : null}
      {message.state !== "completed" ? <span className="agent-message-state">{{ queued: "已排队", running: "处理中", failed: "未完成", stopped: "已停止" }[message.state]}</span> : null}
      <div className="agent-references">{message.references.artifacts.map(reference => {
        const artifact = artifacts.find(item => item.id === reference.artifactId);
        const revision = revisions[`${reference.artifactId}:${reference.revisionId}`];
        const errorKey = errors[`artifact:${reference.artifactId}`] ? `artifact:${reference.artifactId}` : `revision:${reference.artifactId}:${reference.revisionId}`;
        if ((!artifact || !revision) && errors[errorKey]) return unavailable(errorKey, artifact?.title ?? "产出");
        return <button key={reference.revisionId} type="button" aria-label={artifact?.title ?? "查看产出"} onClick={() => onOpenArtifact(reference.artifactId, reference.revisionId)}><ArtifactIcon kind={artifact?.kind ?? "prompt"} /><span><strong>{artifact?.title ?? "查看产出"}</strong><small>{artifact ? stageOwnedLabel(works, artifact) : "内容"}{revision ? ` · v${revision.revisionNumber}` : " · 绑定版本"}</small></span><ChevronRight /></button>;
      })}{message.references.runIds.map(id => {
        const run = runs.find(item => item.id === id);
        return run ? <button key={id} type="button" onClick={() => onOpenRun(id)}><span><strong>{run.title}</strong><small>制作记录</small></span><ChevronRight /></button> : unavailable(`run:${id}`, "制作记录");
      })}{message.references.materialBatchIds.map(id => {
        const batch = materialBatches.find(item => item.batchId === id);
        return <button key={id} type="button" onClick={() => onOpenBatch(id)}>
          <span><strong>{batch?.query.query || "素材搜索"}</strong><small>{batch ? `素材批次 · ${batch.resultCount} 项` : "素材批次"}</small></span><ChevronRight />
        </button>;
      })}</div>
      {message.references.proposalIds.map(id => {
        const proposal = proposals.find(item => item.id === id);
        return proposal ? <ProposalCard key={id} proposal={proposal} onAccept={onAccept} onReply={onReply} busy={accepting.includes(id)} artifacts={artifacts} revisions={revisions} works={works} onOpen={onOpenArtifact} onOpenRun={onOpenRun} /> : unavailable(`proposal:${id}`, "制作提案");
      })}
    </div>
  </div>;
}
