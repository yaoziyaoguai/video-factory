import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import {
  agentApi, AgentApiError, messageInput, subscribeEvents,
  type ArtifactDraft, type ArtifactHead, type ArtifactRevision, type Bootstrap, type BusinessEvent, type ContextStatus,
  type Conversation, type Message, type Proposal,
} from "./api.js";
import { useFeedbackDrafts } from "./useFeedbackDrafts.js";
import { MarkdownText, MarkdownBody } from "./markdown.js";
import {
  appendNotice, clearDraft, clearReadingView, loadDraft, loadPanelLayout, loadReadingView, mergeArtifacts, mergeConversations, mergeMaterialBatches, mergeMessages, mergeProposals, mergeRuns, mergeWorks,
  mergeDraftFrames, saveDraft, savePanelLayout, saveReadingView, type DraftState, type OutputNotices, type PanelLayout, type ReadingView,
} from "./workspace-state.js";
import type { MessageInput, Run, AcceptProposal, CancelRun, SkillPackageMutation, Work, WorkStage, MaterialBatch, MaterialBatchIndexItem, StageConfirmation, ContentSource } from "../../shared/agent/generated/contracts.js";
import { MediaPreview, ProposalCard, RunCard, runEnded } from "./ProductionCards.js";
export { ProposalCard } from "./ProductionCards.js";
import { WorkStagePanel, MaterialBatchCard, type StageAction } from "./WorkStagePanel.js";
import { ArrowLeft, ArrowUp, ChevronRight, Clock3, Cpu, Film, FolderOpen, Maximize2, MessageSquare, PanelLeft, Pencil, Plus, Sparkles, X } from "lucide-react";
import { ArtifactIcon, stageOwnedLabel, FrameEmptyPreview, FrameWelcome } from "./FramePresentation.js";
import { FrameSettings, framePageTitle, type FramePage } from "./FrameSettings.js";
import { hydrateReferences } from "./references.js";
import "./agent.css";

// 增量 A 工作台：会话列表 | 对话 | 产物预览 三栏（后两栏可拖动）。
// 业务事实只来自 API；事件按 id+版本合并；新产出只提示不抢占预览与输入目标。

interface ConversationView {
  conversation: Conversation;
  messages: Message[];
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
  messages: [], artifacts: [], proposals: [], runs: [], works: [], materialBatches: [], activeRequestId: null, olderCursor: null, artifactCursor: null, proposalCursor: null, runCursor: null, windowAnchor: null,
};

export function AgentWorkbench({ onLogout }: { onLogout?: (() => Promise<void>) | undefined } = {}) {
  const { conversationId: routeConversationId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requestedPage = params.get("page");
  const page: FramePage = requestedPage === "models" || requestedPage === "services" || requestedPage === "skills" || requestedPage === "library" || requestedPage === "profile" ? requestedPage : "chat";
  const anchorParam = params.get("anchor");
  const setPage = (value: FramePage) => setParams(value === "chat" ? (anchorParam ? { anchor: anchorParam } : {}) : { page: value });
  const [sidebarHidden, setSidebarHidden] = useState(() => window.matchMedia("(max-width:1180px)").matches);
  const chatPanel = usePanelRef();
  const [focusPreview, setFocusPreview] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [inspectedRun, setInspectedRun] = useState<string | null>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
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
  const [notices, setNotices] = useState<OutputNotices>({ byConversation: new Map() });
  const [actionError, setActionError] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // 面板布局只在挂载时读取一次作为初始值；拖动后仅写回存储，不反向驱动渲染。
  const [panelLayout] = useState<PanelLayout | null>(loadPanelLayout);

  const activeId = useRef(conversationId);
  activeId.current = conversationId;
  // B01：首次快照就绪时确定初始作品一次；之后排序变化/新作品到达不换走正在看的事项。
  const initialWorkPicked = useRef(false);
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
  // 阶段工作台的 UI 状态：选中的创作事项与被点开的素材批次；认可/制作事实全部来自服务端投影。
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [stageNavigation, setStageNavigation] = useState<{ workId: string; stage: WorkStage; artifactId: string; revisionId: string } | null>(null);
  const [preparingWorkId, setPreparingWorkId] = useState<string | null>(null);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  const [stageBusyKeys, setStageBusyKeys] = useState<string[]>([]);
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
  const refreshSnapshot = useCallback(async (id: string, resetStream = false, windowMode: "latest" | string | undefined = undefined) => {
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
      if (!mounted.current || reads.current.get(id) !== sequence || viewGeneration.current.token !== generation) return;
      const known = cache.current.get(id);
      const changedMessages = snapshot.messages.items.filter(message => !known?.messages.some(old => old.id === message.id && old.revision >= message.revision));
      const refresh = {
        artifacts: [...new Set([...changedMessages.flatMap(message => message.references.artifacts.map(ref => ref.artifactId)), ...(resetStream ? known?.artifacts.map(item => item.id) ?? [] : [])])].filter(itemId => !snapshot.artifacts.items.some(item => item.id === itemId)),
        proposals: [...new Set([...changedMessages.flatMap(message => message.references.proposalIds), ...(resetStream ? known?.proposals.map(item => item.id) ?? [] : [])])].filter(itemId => !snapshot.proposals.items.some(item => item.id === itemId)),
        runs: [...new Set([...changedMessages.flatMap(message => message.references.runIds), ...(known?.runs.filter(run => resetStream || !runEnded(run.state) || run.finance.state !== "settled").map(run => run.id) ?? [])])].filter(itemId => !snapshot.runs.items.some(item => item.id === itemId)),
      };
      // 同一补读入口用于快照、历史页和事件；一项失败不会拒绝整页。
      const refs = await hydrateReferences(snapshot.messages.items, {
        artifacts: mergeArtifacts(known?.artifacts ?? [], snapshot.artifacts.items), proposals: mergeProposals(known?.proposals ?? [], snapshot.proposals.items),
        runs: mergeRuns(known?.runs ?? [], snapshot.runs.items),
      }, revisionCacheRef.current, refresh);
      if (!mounted.current || reads.current.get(id) !== sequence || viewGeneration.current.token !== generation) return;
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
      if (activeId.current !== id) return;
      setView(next);
      const terminal = (requestId: string) => next.messages.some(message => message.requestId === requestId && ["completed", "failed", "stopped"].includes(message.state));
      setStreaming(current => current && !terminal(current.requestId) ? current : null);
      setDraftPanels(current => Object.fromEntries(Object.entries(current).filter(([, draft]) => !terminal(draft.requestId))));
      setContextNote(current => current && !terminal(current.requestId) ? current : null);
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
    } catch (error) {
      if (!mounted.current || activeId.current !== id || reads.current.get(id) !== sequence || viewGeneration.current.token !== generation) return;
      setConnectionState(error instanceof AgentApiError ? error.message : "连接暂不可用。已保留当前阅读和草稿。");
    }
  }, []);

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
      // activeRequestId 等会话状态从快照更新；实体读取不会被首屏页的范围限制。
      void refreshSnapshot(id);
    } catch { if (activeId.current === id && viewGeneration.current.token === generation) setConnectionState("最新状态尚未同步，请重新连接。当前阅读和草稿已保留。"); }
  }, [refreshSnapshot]);

  // 一条当前 SSE；离开的在途会话按事实轮询，避免几十条 EventSource 占满浏览器连接。
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const [id, item] of cache.current) {
        if (id !== activeId.current && (item.activeRequestId || item.messages.some(message => message.state === "queued") || item.runs.some(run => !runEnded(run.state) || run.finance.state !== "settled"))) void refreshSnapshot(id);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshSnapshot]);

  useEffect(() => {
    setView(conversationId ? cache.current.get(conversationId) ?? EMPTY_VIEW : EMPTY_VIEW);
    openIntent.current++;
    setSelection(null); setStageNavigation(null); setFeedbackOpen(false); setInspectedRun(null); setStreaming(null); setStreamCursor(null); setActionError("");
    setDraftPanels({}); setContextNote(null); setReferenceErrors({});
    setSkillId(null); setUnseenMessages(false); pinnedBottom.current = true;
    setSelectedWorkId(null); setOpenBatchId(null);
    initialWorkPicked.current = false;
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
    void refreshSnapshot(conversationId, true, anchorParam ?? "latest");
  }, [conversationId, anchorParam, refreshSnapshot]);

  useEffect(() => {
    if (!streamCursor || streamCursor.id !== conversationId) return;
    let reconnect: number | undefined;
    let disposed = false;
    let lastDelta = -1;
    let deltaRequest = "";
    const seen = new Set<string>();
    const id = streamCursor.id;
    const contextSequences = new Map<string, number>();
    const live = (requestId: string) => !cache.current.get(id)?.messages.some(message => message.requestId === requestId && ["completed", "failed", "stopped"].includes(message.state));
    const subscription = subscribeEvents(id, streamCursor.cursor, {
      onBusiness: event => {
        if (disposed || activeId.current !== id || seen.has(event.eventId)) return;
        seen.add(event.eventId);
        if (event.kind === "artifact.delivered") setNotices(current => appendNotice(current, id, event.entityId));
        void readEventEntity(id, event);
      },
      onDelta: delta => {
        if (disposed || activeId.current !== id || !live(delta.requestId)) return;
        if (delta.requestId !== deltaRequest) { deltaRequest = delta.requestId; lastDelta = -1; }
        if (delta.sequence <= lastDelta) return;
        lastDelta = delta.sequence;
        setStreaming(current => ({ requestId: delta.requestId, text: (current?.requestId === delta.requestId ? current.text : "") + delta.text }));
      },
      onDraft: draft => {
        if (disposed || activeId.current !== id || !live(draft.requestId)) return;
        setDraftPanels(current => mergeDraftFrames(current, draft));
      },
      onContextStatus: status => {
        if (disposed || activeId.current !== id || !live(status.requestId) || status.sequence <= (contextSequences.get(status.requestId) ?? -1)) return;
        contextSequences.set(status.requestId, status.sequence);
        setContextNote(status);
      },
      onReset: () => {
        if (disposed || activeId.current !== id) return;
        disposed = true;
        setStreaming(null); setDraftPanels({}); setContextNote(null); setReferenceErrors({}); setConnectionState("连接已中断，正在重新同步…");
        window.clearTimeout(reconnect);
        reconnect = window.setTimeout(() => void refreshSnapshot(id, true), 1000);
      },
    });
    return () => { disposed = true; subscription.close(); window.clearTimeout(reconnect); };
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

  // 创作事项各阶段引用的修订可能不在首屏页；按需补读进不可变缓存，不改变阅读位置。
  useEffect(() => {
    if (!conversationId || view.conversation.id !== conversationId) return;
    const generation = viewGeneration.current.token;
    let disposed = false;
    const current = () => !disposed && mounted.current && viewGeneration.current.token === generation;
    const knownHeads = new Set(view.artifacts.map(item => item.id));
    const missingHeads = new Set<string>();
    const missingRevisions: { artifactId: string; revisionId: string }[] = [];
    for (const work of view.works) for (const stage of [work.stages.content, work.stages.plan, work.stages.video]) {
      for (const source of [stage.draft, stage.approved]) {
        if (!source || source.kind !== "artifact_revision") continue;
        if (!knownHeads.has(source.artifactId)) missingHeads.add(source.artifactId);
        if (!revisionCache[`${source.artifactId}:${source.revisionId}`]) missingRevisions.push({ artifactId: source.artifactId, revisionId: source.revisionId });
      }
    }
    if (!missingHeads.size && !missingRevisions.length) return;
    void Promise.all([
      Promise.all([...missingHeads].map(headId => agentApi.readArtifactHead(headId))),
      Promise.all(missingRevisions.map(ref => agentApi.readRevision(ref.artifactId, ref.revisionId))),
    ]).then(([heads, revisions]) => {
      if (!current()) return;
      setRevisionCache(cache => {
        const next = { ...cache };
        for (const revision of revisions) next[`${revision.artifactId}:${revision.revisionId}`] = revision;
        return next;
      });
      if (!heads.length) return;
      const prior = cache.current.get(conversationId); if (!prior) return;
      const nextView = { ...prior, artifacts: mergeArtifacts(prior.artifacts, heads) };
      cache.current.set(conversationId, nextView); setView(nextView);
    }).catch(() => { /* 单项补读失败由快照重试覆盖，不阻塞阶段呈现。 */ });
    return () => { disposed = true; };
  }, [conversationId, view.conversation.id, view.works, view.artifacts, revisionCache]);

  // 首次快照真正就绪时确定初始作品并保留其 ID；排序变化与新作品不换走正在看的事项（B01）。
  useEffect(() => {
    if (!conversationId || view.conversation.id !== conversationId || initialWorkPicked.current || !view.works.length) return;
    initialWorkPicked.current = true;
    setSelectedWorkId(current => current ?? view.works[0]!.id);
  }, [conversationId, view.conversation.id, view.works]);

  // 当前阅读入口按会话持久（阶段工作台/独立产物/素材详情/制作记录）；关闭视图即同步更新，
  // 刷新回到最后真实视图，不复活已关闭的旧产物（B03）。
  useEffect(() => {
    if (!conversationId || view.conversation.id !== conversationId) return;
    const next: ReadingView | null = inspectedRun
      ? { entry: "run", workId: selectedWorkId, artifactId: null, revisionId: null, runId: inspectedRun, batchId: openBatchId }
      : selection
        ? { entry: "artifact", workId: selectedWorkId, artifactId: selection.artifactId, revisionId: selection.revisionId, runId: null, batchId: openBatchId }
        : openBatchId && !view.works.length
          ? { entry: "batch", workId: null, artifactId: null, revisionId: null, runId: null, batchId: openBatchId }
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

  const updateDraft = (update: Partial<DraftState>) => {
    const id = conversationId ?? "new";
    setDrafts(current => {
      const next = { ...(current[id] ?? { text: "", targetArtifactId: null, targetRevisionId: null }), ...update };
      saveDraft(id, next); return { ...current, [id]: next };
    });
  };
  const updateDraftText = (text: string) => updateDraft({ text });
  const unbindTarget = () => updateDraft({ targetArtifactId: null, targetRevisionId: null });
  const bindTarget = (artifact: ArtifactHead) => updateDraft({ targetArtifactId: artifact.id, targetRevisionId: selection?.revisionId ?? artifact.revisionId, proposalId: null, proposalDigest: null });
  const model = bootstrap?.models.find(entry => entry.kind === "text" && entry.isDefault) ?? bootstrap?.models.find(entry => entry.kind === "text") ?? null;
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
  // 阶段认可走 MessageInput.stageConfirmation 原入口：每个（事项, 动作, next, 准确稿件）一个持久
  // commandId，结果未知时原请求重试可回放；按钮独立构造请求，不动用户未发送的聊天草稿。
  // 返回是否成功，供“认可内容，查看对应方案”这类成功后跳转的按钮使用。
  const confirmStage = async (work: Work, action: StageAction, subject: StageConfirmation["subject"], label: string, next?: "prepare_production"): Promise<boolean> => {
    const id = view.conversation.id;
    const variant = next ?? "plain";
    const subjectKey = subject.kind === "artifact_revision" ? `${subject.artifactId}:${subject.revisionId}` : `msg:${subject.messageId}`;
    const busy = `${work.id}:${action}:${variant}`;
    if (!id || stageBusyKeys.includes(busy)) return false;
    const storageKey = `vf:agent-stage:${id}:${work.id}:${action}:${variant}:${subjectKey}`;
    const stageCommand: StageConfirmation = next
      ? { workId: work.id, action, subject, next }
      : { workId: work.id, action, subject };
    let command: MessageInput;
    try {
      const saved = localStorage.getItem(storageKey);
      command = saved ? JSON.parse(saved) as MessageInput : {
        commandId: agentApi.newCommandId(), text: label, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, stageConfirmation: stageCommand,
      };
      if (!saved) localStorage.setItem(storageKey, JSON.stringify(command));
    } catch {
      command = { commandId: agentApi.newCommandId(), text: label, target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null, stageConfirmation: stageCommand };
    }
    setStageBusyKeys(current => [...current, busy]);
    try {
      await agentApi.sendMessages(id, command);
      localStorage.removeItem(storageKey);
      await refreshSnapshot(id);
      return true;
    } catch (error) {
      // 4xx 说明请求本身被拒（旧稿/在途等），丢弃原命令；结果未知时保留以便原请求重试。
      if (error instanceof AgentApiError && error.payload.status < 500) localStorage.removeItem(storageKey);
      if (activeId.current === id) setActionError(error instanceof Error ? error.message : "认可结果未确认，可重试。");
      return false;
    } finally { setStageBusyKeys(current => current.filter(key => key !== busy)); }
  };

  const prepareProduction = async (work: Work) => {
    const id = view.conversation.id;
    const plan = work.stages.plan.draft;
    if (plan?.kind !== "artifact_revision") return;
    setPreparingWorkId(work.id);
    try {
      await agentApi.sendMessages(id, messageInput(
        `请按「${work.title}」当前这份已认可的画面与声音方案准备制作，展示本次费用让我确认。方案内容不变，不需要重新交稿或认可；现在先不提交生成。`,
        { artifactId: plan.artifactId, revisionId: plan.revisionId, workId: work.id },
      ));
      await refreshSnapshot(id);
    } catch (error) {
      if (activeId.current === id) setActionError(error instanceof Error ? error.message : "准备制作失败。");
    } finally { setPreparingWorkId(null); }
  };

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
          || (pending.proposalDigest ?? null) !== (command.proposalRef?.digest ?? null)) return current;
        clearDraft(id); return { ...current, [id]: { text: "", targetArtifactId: null, targetRevisionId: null } };
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
    const source = work?.stages.plan.draft ?? work?.stages.content.draft;
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
    if (!conversationId || !view.activeRequestId) return;
    try { await agentApi.stopRequest(view.activeRequestId); await refreshSnapshot(conversationId); }
    catch (error) { setActionError(error instanceof Error ? error.message : "停止失败。"); }
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
  const loadRunIntoCache = async (id: string, runId: string, current: () => boolean): Promise<boolean> => {
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
  };
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
  const feedback = useFeedbackDrafts(conversationId, id => refreshSnapshot(id), setActionError);
  // 明确失败过的准备请求（按消息 target 指向的事项）：再次准备按“重新准备费用”表述，
  // 不要求重新认可；结果未知/成功的不算。
  const failedPrepareWorkIds = view.messages
    .filter(message => message.role === "user" && message.state === "failed" && message.target?.workId)
    .map(message => message.target!.workId!);
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

  // 正式阶段的卡片仍在双区阅读，不能绕进独立查看器。
  const selectedStage = useMemo(() => {
    if (!selection) return null;
    for (const work of view.works) {
      for (const stage of ["content", "plan", "video"] as const) {
        if ([work.stages[stage].draft, work.stages[stage].approved].some(source =>
          source?.kind === "artifact_revision" && source.artifactId === selection.artifactId)) {
          return { ...selection, workId: work.id, stage };
        }
      }
      const artifact = view.artifacts.find(item => item.id === selection.artifactId);
      if (artifact?.workId === work.id && artifact.kind === "video") return { ...selection, workId: work.id, stage: "video" as const };
    }
    return null;
  }, [selection, view.works, view.artifacts]);
  useEffect(() => {
    if (!selectedStage) return;
    setSelectedWorkId(selectedStage.workId);
    setStageNavigation(selectedStage);
    setSelection(null);
  }, [selectedStage]);
  const openArtifactHead = selection && !selectedStage ? view.artifacts.find(item => item.id === selection.artifactId) ?? null : null;
  const openRevision = selection ? revisionCache[`${selection.artifactId}:${selection.revisionId}`] ?? null : null;
  // 独立查看器与阶段面板一致：历史修订只读，意见/修改只针对最新稿（服务端合同只接受 head）。
  const viewingOldRevision = Boolean(selection && openArtifactHead && openArtifactHead.revisionId !== selection.revisionId);
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

  const openConversation = (id: string) => navigate(`/agent/${id}`);
  const activeRuns = view.runs.filter(run => !runEnded(run.state));
  const selectedRun = view.runs.find(run => run.id === inspectedRun);
  const workMode = view.works.length > 0 && !selectedRun && !openArtifactHead;
  // 消息里的批次引用点开后回到阶段工作台并展开该批次。
  const openBatch = (batchId: string) => {
    openIntent.current++;
    setSelection(null); setInspectedRun(null);
    setSelectedWorkId(current => current ?? view.works[0]?.id ?? null);
    setOpenBatchId(batchId);
  };
  const backToWork = () => { openIntent.current++; setSelection(null); setInspectedRun(null); };
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

  return <div className={`agent-root${sidebarHidden ? " sidebar-hidden" : ""}`}>
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
        <button type="button" className={page === "services" ? "active" : ""} onClick={() => setPage("services")}><FolderOpen />免费服务</button>
        <button type="button" className={page === "skills" ? "active" : ""} onClick={() => setPage("skills")}><Sparkles />Skill 管理</button>
        <button type="button" className={page === "library" ? "active" : ""} onClick={() => setPage("library")}><Film />作品库</button>
        <button type="button" className={`agent-profile-link ${page === "profile" ? "active" : ""}`} onClick={() => setPage("profile")}><span className="agent-user-avatar">创</span><span><strong>{bootstrap?.displayName ?? "创作者"}</strong><small>用户页</small></span><ChevronRight /></button>
      </nav>
    </aside>
    <main className="agent-frame">
      <header className="agent-topbar agent-chat-header">
        <button type="button" className="agent-icon-button" aria-label="切换侧栏" onClick={() => setSidebarHidden(value => !value)}><PanelLeft /></button>
        <div className="agent-topbar-title"><span>FRAME　/　{framePageTitle[page]}</span>{renaming?.id === conversationId && conversationId ? <input autoFocus className="agent-rename-input" aria-label="会话名称" value={renaming.title} onChange={event => setRenaming({ id: conversationId, title: event.target.value })} onBlur={() => void commitRename(conversationId, renaming.title.trim() || title, view.conversation.revision)} onKeyDown={event => { if (event.key === "Enter") void commitRename(conversationId, renaming.title.trim() || title, view.conversation.revision); if (event.key === "Escape") setRenaming(null); }} /> : <h1 onDoubleClick={() => conversationId && setRenaming({ id: conversationId, title })}>{page === "chat" ? title : framePageTitle[page]}</h1>}</div>
        <button type="button" className="agent-title-rename" aria-label="重命名当前对话" hidden={page !== "chat" || !conversationId} onClick={() => conversationId && setRenaming({ id: conversationId, title })}><Pencil /></button>
        <select className="agent-compact-nav" aria-label="页面导航" value={page} onChange={event => setPage(event.target.value as FramePage)}>{Object.entries(framePageTitle).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select className="agent-compact-nav" aria-label="选择对话" value={conversationId ?? ""} onChange={event => event.target.value ? openConversation(event.target.value) : void createConversation()}><option value="">新对话</option>{conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
        <span className="agent-runtime-label">{model?.availability === "configured" ? `${model.name}${isSimulated ? " · 模拟媒体" : ""}` : "文本模型待配置"}</span>
      </header>
      <FrameSettings page={page} bootstrap={bootstrap} conversations={conversations} onConversation={openConversation} onPage={setPage} onLogout={onLogout} onCatalogRefresh={refreshBootstrap} onSkillMutationChange={setSkillMutation} />
      <div className="agent-chat-workspace" hidden={page !== "chat"}>
      <Group className="agent-main" orientation="horizontal" id="vf-agent-panels" onLayoutChanged={layout => { if (layout["agent-chat"]) savePanelLayout(layout); }} defaultLayout={panelLayout ?? undefined}>
        <Panel id="agent-chat" defaultSize="390px" minSize="320px" collapsible panelRef={chatPanel} onResize={size => setFocusPreview(size.asPercentage === 0)}>
          <section className="agent-chat" inert={focusPreview}>
            {connectionState ? <div role="status" className="agent-connection-state">{connectionState}<button type="button" onClick={() => conversationId && void refreshSnapshot(conversationId, true)}>重新连接</button></div> : null}
            {actionError || bootError ? <div className="agent-action-error" role="alert">{actionError || bootError}<button type="button" onClick={() => setActionError("")}>知道了</button></div> : null}
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
              {streaming ? <div className="agent-message assistant streaming" data-testid="streaming-message"><span className="agent-assistant-avatar">f·</span><div className="agent-message-content"><span className="agent-author">Frame</span><MarkdownText text={streaming.text || "正在想…"} /></div></div> : null}
            </div>
            {unseenMessages && !view.windowAnchor ? <button className="agent-new-messages" type="button" onClick={() => { pinnedBottom.current = true; setUnseenMessages(false); if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight; }}>回到最新消息 ↓</button> : null}
            <footer className="agent-composer">
              {skillNotice ? <p className="agent-config-note" role="status">{skillNotice}</p> : null}
              {skillMutation ? <p className="agent-config-note" role="status">Skill 目录正在更新，聊天草稿已保留。<button type="button" className="agent-text-link" onClick={() => setPage("skills")}>查看进度</button></p> : null}
              {view.activeRequestId ? <div className="agent-activity"><span><span className="agent-live-dot" />Frame 正在处理</span><button className="agent-stop" type="button" onClick={() => void stopActive()}>停止本轮</button></div> : null}
              {activeRuns.map(run => <div className="agent-activity" key={run.id}><button type="button" onClick={() => void openRun(run.id)}><span className="agent-live-dot" />{run.title} · {run.state === "queued" ? "等待制作" : run.state === "cancel_requested" ? "确认取消中" : run.state === "unknown" ? "待核实" : "制作中"}<ChevronRight /></button></div>)}
              {currentDraft.proposalId ? <div className="agent-target-chip"><span>回复《{view.proposals.find(p => p.id === currentDraft.proposalId)?.spec.title ?? "已选提案"}》 · 制作请发送「确认制作」，也可继续讨论</span><button type="button" onClick={() => updateDraft({ proposalId: null, proposalDigest: null })} aria-label="清除提案引用"><X /></button></div> : null}
              {currentDraft.targetArtifactId ? <div className="agent-target-chip">针对：{view.artifacts.find(item => item.id === currentDraft.targetArtifactId)?.title ?? "已选作品"}<button type="button" onClick={unbindTarget} aria-label="清除修改目标"><X /></button></div> : null}
              <div className="agent-composer-card">
                <textarea ref={composerInput} value={currentDraft.text} onChange={event => updateDraftText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder="说说想法，改改作品，或换件事聊…" disabled={!canSend} aria-label="消息输入" />
                <div className="agent-composer-tools"><label className="agent-skill-selector"><Sparkles /><select aria-label="指定 Skill" disabled={!!currentDraft.proposalId || Boolean(skillMutation)} value={skillId ?? ""} onChange={event => { setSkillId(event.target.value || null); setSkillNotice(""); }}><option value="">Skill · 自动选择</option>{bootstrap?.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label>
                  <div className="agent-send-actions">{view.activeRequestId ? <button type="button" disabled={!!currentDraft.proposalId || Boolean(skillMutation) || !currentDraft.text.trim() || sendingNow || !!pendingSend[conversationId!]} onClick={() => void sendMessage("steer")}>干预本轮</button> : null}<button className="agent-send" type="button" aria-label="发送" onClick={() => void sendMessage()} disabled={!canSend || Boolean(skillMutation) || !currentDraft.text.trim() || sendingNow || !!pendingSend[conversationId!]}><ArrowUp /></button></div>
                </div>
              </div>
              <span className="agent-composer-hint">Enter 发送 · Shift + Enter 换行</span>
              {!canSend && bootstrap ? <button className="agent-text-link" type="button" onClick={() => setPage("models")}>查看文本模型状态</button> : null}
              {conversationId && pendingSend[conversationId] && !sendingNow ? <button type="button" className="agent-retry-send" onClick={() => void sendMessage("new", true)}>重试上次发送（保留原请求）</button> : null}
            </footer>
          </section>
        </Panel>
        <Separator className="agent-resizer" aria-label="调整对话与预览的宽度" title="拖动或用左右方向键调整宽度" />
        <Panel id="agent-preview" minSize="360px">
          <section className="agent-preview">
            <div className="agent-workspace-status"><Clock3 />{view.activeRequestId ? "新产出会留在这里" : "慢慢看，不限时"}{view.runs.length ? <button type="button" onClick={() => void openRun(view.runs[0]!.id)}>制作记录 · {view.runs.length}</button> : null}<button type="button" aria-label={focusPreview ? "返回聊天与作品" : "展开作品区"} title={focusPreview ? "返回聊天与作品" : "展开作品区"} onClick={() => focusPreview ? chatPanel.current?.expand() : chatPanel.current?.collapse()}>{focusPreview ? <ArrowLeft /> : <Maximize2 />}</button></div>
            {view.artifacts.length ? <div className="agent-artifact-tabs" aria-label="当前会话产物">{view.artifacts.map(artifact => <button type="button" key={artifact.id} aria-label={artifact.title} title={artifact.title} aria-pressed={!inspectedRun && selection?.artifactId === artifact.id} onClick={() => openArtifact(artifact.id)}><span className="agent-artifact-icon"><ArtifactIcon kind={artifact.kind} /></span><span><strong>{artifact.title}</strong><small>{stageOwnedLabel(view.works, artifact)}就绪</small></span>{notices.byConversation.get(conversationId ?? "")?.includes(artifact.id) ? <span className="agent-output-badge">有更新</span> : null}</button>)}{view.artifactCursor ? <button type="button" onClick={() => void loadMoreOutputs("artifacts")}>更多产物</button> : null}</div> : null}
            <div className="agent-workspace-scroll" data-mode={workMode ? "work" : undefined}>
              {selectedRun ? <article className="agent-paper"><header className="agent-preview-header"><h2>制作记录</h2><button type="button" onClick={() => { openIntent.current++; setInspectedRun(null); }}>回到作品</button></header><RunCard key={selectedRun.id} run={selectedRun} onCancel={r => void cancelProduction(r)} onOpen={openArtifact} simulated={isSimulated} proposals={view.proposals} artifacts={view.artifacts} revisions={revisionCache} onRetry={() => void retryReferences()} />
                {view.runs.length > 1 || view.runCursor ? <details className="agent-run-history"><summary>其他制作记录</summary><div className="agent-production-actions">{view.runs.filter(run => run.id !== selectedRun.id).map(run => <button key={run.id} type="button" onClick={() => void openRun(run.id)}>{run.title}</button>)}{view.runCursor ? <button type="button" onClick={() => void loadMoreOutputs("runs")}>更早的制作</button> : null}</div></details> : null}</article>
              : openArtifactHead ? <article className="agent-paper">
                <header className="agent-preview-header"><h2>{openArtifactHead.title}</h2><div className="agent-paper-tools">{view.works.length ? <button className="agent-text-link" type="button" onClick={backToWork}>回到创作</button> : null}<details className="agent-version-picker"><summary>{stageOwnedLabel(view.works, openArtifactHead)} v{openRevision?.revisionNumber ?? "…"}</summary><div>{openRevision?.baseRevisionId ? <button type="button" onClick={() => openArtifact(openArtifactHead.id, openRevision.baseRevisionId!)}>上一版</button> : null}{selection?.revisionId !== openArtifactHead.revisionId ? <button type="button" onClick={() => openArtifact(openArtifactHead.id)}>查看最新 v{openArtifactHead.revisionNumber}</button> : <span>当前最新版本</span>}</div></details>{viewingOldRevision
                  ? <span className="agent-stage-muted">历史版本仅阅读</span>
                  : <button className="agent-feedback-trigger" type="button" disabled={lockedArtifacts.has(openArtifactHead.id)} onClick={discussArtifact}><Pencil />{lockedArtifacts.has(openArtifactHead.id) ? "制作中 · 输入已锁定" : "提意见"}</button>}</div></header>
                <div className="agent-preview-body">{openRevision ? openRevision.content.format === "markdown" ? <MarkdownBody content={openRevision.content} /> : <MediaPreview content={openRevision.content} simulated={isSimulated} /> : <div className="agent-preview-loading">正在读取…</div>}</div>
                <footer className="agent-preview-actions">
                  {viewingOldRevision ? <><span className="agent-stage-muted">正在看历史版本，意见和修改请回到最新稿。</span>{feedbackDraft ? <label>旧稿的未发送意见<textarea aria-label="意见" readOnly value={feedbackDraft} /></label> : null}</> : <>
                    <button className="agent-text-link" type="button" onClick={() => setFeedbackOpen(value => !value)}>{lockedArtifacts.has(openArtifactHead.id) ? "留下下一版意见" : "只记录意见"}</button>
                    {isSimulated && openRevision?.content.format === "markdown" ? <button className="agent-text-link" type="button" disabled={lockedArtifacts.has(openArtifactHead.id)} onClick={() => { if (currentDraft.text.trim()) { setActionError("输入框还有草稿，请先处理这条消息，再准备制作提案。"); return; } updateDraft({ text: "按这份准备制作提案，先不要开始", targetArtifactId: openArtifactHead.id, targetRevisionId: selection!.revisionId, proposalId: null, proposalDigest: null }); composerInput.current?.focus(); }}>准备模拟提案</button> : null}
                    {feedbackOpen ? <div className="agent-feedback-box"><label>这条意见只记录，不会自动改稿<textarea value={feedbackDraft} onChange={event => updateFeedback(event.target.value)} placeholder="留给这一版的意见…" aria-label="意见" /></label><button type="button" onClick={() => void saveFeedback()} disabled={!feedbackDraft.trim() || savingFeedback}>记录意见</button></div> : null}
                  </>}
                  {feedbackSaved ? <span role="status" className="agent-feedback-saved">{feedbackSaved}</span> : null}
                </footer>
              </article>
              : openBatchId && !view.works.length ? <article className="agent-paper" data-testid="standalone-batch">
                <header className="agent-preview-header"><h2>素材批次</h2><button type="button" className="agent-text-link" onClick={() => { openIntent.current++; setOpenBatchId(null); }}>返回</button></header>
                <div className="agent-preview-body">
                  <MaterialBatchCard batchId={openBatchId} summary={view.materialBatches.find(batch => batch.batchId === openBatchId) ?? null} open onToggle={() => {}}
                    onAdopt={adoptMaterial} adoptDisabled={materialAdoptDisabled} />
                </div>
              </article>
              : !view.works.length ? <FrameEmptyPreview /> : null}
              {view.works.length ? <div style={{ display: workMode ? "contents" : "none" }}><WorkStagePanel key={conversationId}
                conversationId={conversationId!}
                works={view.works} selectedWorkId={selectedWorkId} onSelectWork={setSelectedWorkId}
                navigation={stageNavigation}
                artifacts={view.artifacts} revisions={revisionCache}
                proposals={view.proposals} runs={view.runs} materialBatches={view.materialBatches}
                onAdoptMaterial={adoptMaterial} adoptDisabled={materialAdoptDisabled}
                onConfirmStage={(work, action, subject, label, next) => confirmStage(work, action, subject, label, next)}
                stageBusyKeys={stageBusyKeys} canContinueText={canSend}
                onPrepareProduction={work => void prepareProduction(work)} preparing={preparingWorkId !== null || Boolean(view.activeRequestId)}
                failedPrepareWorkIds={failedPrepareWorkIds}
                onAccept={proposal => void acceptProposal(proposal)} accepting={accepting}
                onOpenArtifact={openArtifact} onOpenRun={runId => void openRun(runId)}
                onEnsureRun={runId => void ensureRun(runId)} referenceErrors={referenceErrors}
                feedback={feedback}
                simulated={isSimulated} openBatchId={openBatchId}
              /></div> : null}
              {!workMode && view.proposals.length ? <details className="agent-proposals-list"><summary>制作提案 · {view.proposals.length}</summary>{view.proposals.map(proposal => <ProposalCard works={view.works} runs={view.runs} key={proposal.id} proposal={proposal} onAccept={p => void acceptProposal(p)} onReply={replyToProposal} busy={accepting.includes(proposal.id)} artifacts={view.artifacts} revisions={revisionCache} onOpen={openArtifact} onOpenRun={runId => void openRun(runId)} />)}{view.proposalCursor ? <button type="button" onClick={() => void loadMoreOutputs("proposals")}>更多提案</button> : null}</details> : null}
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
        return proposal ? <ProposalCard works={works} runs={runs} key={id} proposal={proposal} onAccept={onAccept} onReply={onReply} busy={accepting.includes(id)} artifacts={artifacts} revisions={revisions} onOpen={onOpenArtifact} onOpenRun={onOpenRun} /> : unavailable(`proposal:${id}`, "制作提案");
      })}
    </div>
  </div>;
}
