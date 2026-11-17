import type { ArtifactDraft, ArtifactHead, ContentSource, Conversation, FeedbackInput, LibrarySelection, MaterialBatchIndexItem, Message, Proposal, RevisionRef, Run, Work } from "../../shared/agent/generated/contracts.js";

// 工作台状态合并规则（纯函数，可独立测试）：
// - 一律按 id + 实体版本合并，旧版本不覆盖新版本（旧页晚到、重复乱序事件都吸收）；
// - 页面 watermark 只用于继续翻页，不推进 SSE 游标；
// - 新产出只产生提示：已打开的预览与输入绑定目标绝不被新结果抢占。

/** 作品库“带入对话”的本地选材：label 只用于输入框展示，selection 才是发送契约。 */
export interface LibraryPick {
  label: string;
  selection: LibrarySelection;
}

export interface DraftState {
  text: string;
  targetArtifactId: string | null;
  targetRevisionId: string | null;
  proposalId?: string | null;
  proposalDigest?: string | null;
  /** G4-2：随下一条 new 请求携带的作品库选材；steer 不携带。 */
  librarySelections?: LibraryPick[];
}

export interface OutputNotices {
  /** conversationId → 有未读新产出的 artifactId 列表 */
  byConversation: Map<string, string[]>;
}

export function mergeConversations(current: readonly Conversation[], incoming: readonly Conversation[]): Conversation[] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) {
    const existing = byId.get(item.id);
    if (!existing || item.revision >= existing.revision) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

export function mergeMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (!existing || message.revision >= existing.revision) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.createdSequence - right.createdSequence);
}

export function mergeArtifacts(current: readonly ArtifactHead[], incoming: readonly ArtifactHead[]): ArtifactHead[] {
  const byId = new Map(current.map(artifact => [artifact.id, artifact]));
  for (const artifact of incoming) {
    const existing = byId.get(artifact.id);
    if (!existing || artifact.revisionNumber >= existing.revisionNumber) byId.set(artifact.id, artifact);
  }
  return [...byId.values()].sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.id < right.id ? -1 : 1));
}

export function mergeProposals(current: readonly Proposal[], incoming: readonly Proposal[]): Proposal[] {
  const byId = new Map(current.map(proposal => [proposal.id, proposal]));
  for (const proposal of incoming) {
    const existing = byId.get(proposal.id);
    if (!existing || proposal.revision >= existing.revision) byId.set(proposal.id, proposal);
  }
  return [...byId.values()].sort((left, right) => (left.expiresAt < right.expiresAt ? 1 : left.expiresAt > right.expiresAt ? -1 : left.id < right.id ? -1 : 1));
}

export function mergeWorks(current: readonly Work[], incoming: readonly Work[]): Work[] {
  const byId = new Map(current.map(work => [work.id, work]));
  for (const work of incoming) {
    const existing = byId.get(work.id);
    if (!existing || work.revision >= existing.revision) byId.set(work.id, work);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

// 批次索引项按 batchId 去重：批次本身不可变，重复事件/翻页晚到都按原批次吸收。
export function mergeMaterialBatches(current: readonly MaterialBatchIndexItem[], incoming: readonly MaterialBatchIndexItem[]): MaterialBatchIndexItem[] {
  const byId = new Map(current.map(batch => [batch.batchId, batch]));
  for (const batch of incoming) if (!byId.has(batch.batchId)) byId.set(batch.batchId, batch);
  return [...byId.values()].sort((left, right) => right.retrievedAt.localeCompare(left.retrievedAt) || left.batchId.localeCompare(right.batchId));
}

export function mergeRuns(current: readonly Run[], incoming: readonly Run[]): Run[] {
  const byId = new Map(current.map(run => [run.id, run]));
  for (const run of incoming) if (!byId.has(run.id) || byId.get(run.id)!.revision <= run.revision) byId.set(run.id, run);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// —— 暂态回合事件（artifact.draft / context.status）——
// 不落库、不进合并缓存：只描述“正在发生”的过程。cleared 立即消失；
// 同一草稿的旧序列晚到不回退；断流/reset 由调用方整体清空。

export function mergeDraftFrames(current: Record<string, ArtifactDraft>, incoming: ArtifactDraft): Record<string, ArtifactDraft> {
  const prior = current[incoming.draftId];
  // cleared 留作本连接的墓碑；同一草稿不能被迟到帧复活。
  if (prior && (prior.state === "cleared" || prior.sequence >= incoming.sequence)) return current;
  return { ...current, [incoming.draftId]: incoming };
}

export function appendNotice(notices: OutputNotices, conversationId: string, artifactId: string): OutputNotices {
  const byConversation = new Map(notices.byConversation);
  const existing = byConversation.get(conversationId) ?? [];
  if (!existing.includes(artifactId)) byConversation.set(conversationId, [...existing, artifactId]);
  return { byConversation };
}

// —— 面板布局 —— react-resizable-panels v4 不内置 autoSave，手动持久化百分比布局。

export type PanelLayout = Record<string, number>;

const PANEL_LAYOUT_KEY = "vf:agent-panel-layout:frame";

export function loadPanelLayout(): PanelLayout | null {
  try {
    const raw = window.localStorage.getItem(PANEL_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const layout: PanelLayout = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100) layout[id] = value;
    }
    return Object.keys(layout).length > 0 ? layout : null;
  } catch {
    return null;
  }
}

export function savePanelLayout(layout: PanelLayout): void {
  try {
    window.localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // 同草稿：存储不可用时布局只在本次会话生效。
  }
}

// —— 草稿 —— 按会话持久；绑定目标随草稿一起保存，切换会话/刷新不丢（A-07）。

const DRAFT_PREFIX = "vf:agent-draft:";

// G4-2 作品库“带入对话”可能连续触发（同一会话多次选材）：同一来源定稿下的同一素材/工程文件只保留一份。
const libraryPickKey = ({ selection: { source, sourceVideo } }: LibraryPick) => JSON.stringify([
  sourceVideo.artifactId, sourceVideo.revisionId,
  source.kind === "artifact_revision" ? [source.kind, source.artifactId, source.revisionId]
    : source.kind === "run_input" ? [source.kind, source.runId, source.operationId, source.inputIndex, source.blobId]
    : [source.kind, source.project.artifactId, source.project.revisionId, source.relativePath],
]);

export function mergeLibraryPicks(existing: readonly LibraryPick[] | undefined, incoming: readonly LibraryPick[]): LibraryPick[] {
  const seen = new Set((existing ?? []).map(libraryPickKey));
  return [...(existing ?? []), ...incoming.filter(pick => !seen.has(libraryPickKey(pick)))];
}

export function draftStorageKey(conversationId: string): string {
  return `${DRAFT_PREFIX}${conversationId}`;
}

export function saveDraft(conversationId: string, draft: DraftState): void {
  try {
    window.localStorage.setItem(draftStorageKey(conversationId), JSON.stringify(draft));
  } catch {
    // 隐私模式/存储被禁时草稿只留在内存里。
  }
}

export function loadDraft(conversationId: string): DraftState | null {
  try {
    const raw = window.localStorage.getItem(draftStorageKey(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    if (typeof parsed.text !== "string") return null;
    const picks = Array.isArray(parsed.librarySelections)
      ? parsed.librarySelections.filter(pick => typeof pick?.label === "string" && !!pick.selection?.source && !!pick.selection?.sourceVideo)
      : [];
    return {
      text: parsed.text,
      targetArtifactId: typeof parsed.targetArtifactId === "string" ? parsed.targetArtifactId : null,
      targetRevisionId: typeof parsed.targetRevisionId === "string" ? parsed.targetRevisionId : null,
      ...(typeof parsed.proposalId === "string" && typeof parsed.proposalDigest === "string" ? { proposalId: parsed.proposalId, proposalDigest: parsed.proposalDigest } : {}),
      ...(picks.length ? { librarySelections: picks } : {}),
    };
  } catch {
    return null;
  }
}

export function clearDraft(conversationId: string): void {
  try {
    window.localStorage.removeItem(draftStorageKey(conversationId));
  } catch {
    // 同上：读不到存储就跳过。
  }
}

// —— 阅读位置（B01/B03）—— 按会话保存“正在看什么”的 UI 引用：当前入口（阶段工作台/独立产物/
// 素材详情/制作记录）、选中事项与正在看的阶段修订。只存引用，不复制 snapshot/作品/认可事实；
// 恢复时按当前真实快照解释，找不到的引用回落到当前快照。
// 旧格式只有 {artifactId, revisionId}（独立产物选择），按产物视图解释一次。

export type ReadingEntry = "work" | "artifact" | "run" | "batch";

export interface ReadingView {
  entry: ReadingEntry;
  workId: string | null;
  artifactId: string | null;
  revisionId: string | null;
  runId: string | null;
  batchId: string | null;
}

const READING_KEY = "vf:agent-reading:";

function readingStorageKey(conversationId: string): string {
  return `${READING_KEY}${conversationId}`;
}

export function loadReadingView(conversationId: string): ReadingView | null {
  try {
    const raw = window.localStorage.getItem(readingStorageKey(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReadingView> & { view?: unknown };
    const artifactId = typeof parsed.artifactId === "string" ? parsed.artifactId : null;
    const revisionId = typeof parsed.revisionId === "string" ? parsed.revisionId : null;
    // 旧格式（无 entry 字段）只表达独立产物选择。
    const entry = parsed.entry === "work" || parsed.entry === "run" || parsed.entry === "batch" ? parsed.entry
      : artifactId ? "artifact" : null;
    if (!entry) return null;
    return {
      entry,
      workId: typeof parsed.workId === "string" ? parsed.workId : null,
      artifactId, revisionId,
      runId: typeof parsed.runId === "string" ? parsed.runId : null,
      batchId: typeof parsed.batchId === "string" ? parsed.batchId : null,
    };
  } catch {
    return null;
  }
}

export function saveReadingView(conversationId: string, view: ReadingView): void {
  try {
    window.localStorage.setItem(readingStorageKey(conversationId), JSON.stringify(view));
  } catch {
    // 存储不可用时阅读位置只在本次会话生效。
  }
}

export function clearReadingView(conversationId: string): void {
  try {
    window.localStorage.removeItem(readingStorageKey(conversationId));
  } catch {
    // 同上。
  }
}

// —— 审阅组工作台阅读（B03）—— 各作品正在看的组、各事项正在看的准确修订（null=尚未打开）
// 与展开的素材批次。键内含 work/group/item/revision，各事项互不覆盖。修订引用必须成对记产物与修订：
// 新一版制作输出是新产物，只记修订号会把它配到当前草稿产物上读错。
// 旧固定阶段格式（stageByWork）不再解释：组的默认视图按当前快照回落。

export type StageRevisionRef = RevisionRef | Extract<ContentSource, { kind: "message_text" }>;

export interface StageReading {
  groupByWork: Record<string, string>;
  itemByGroup: Record<string, string>;
  revisionByItem: Record<string, StageRevisionRef | null>;
  batchId: string | null;
}

const STAGE_READING_KEY = "vf:agent-stage-reading:";

export function loadStageReading(conversationId: string): StageReading {
  const empty: StageReading = { groupByWork: {}, itemByGroup: {}, revisionByItem: {}, batchId: null };
  try {
    const raw = window.localStorage.getItem(`${STAGE_READING_KEY}${conversationId}`);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StageReading>;
    const groupByWork: Record<string, string> = {};
    for (const [workId, groupId] of Object.entries(parsed.groupByWork ?? {})) {
      if (typeof groupId === "string") groupByWork[workId] = groupId;
    }
    const itemByGroup: Record<string, string> = {};
    for (const [groupKey, itemId] of Object.entries(parsed.itemByGroup ?? {})) {
      if (typeof itemId === "string") itemByGroup[groupKey] = itemId;
    }
    const revisionByItem: Record<string, StageRevisionRef | null> = {};
    for (const [itemKey, ref] of Object.entries(parsed.revisionByItem ?? {})) {
      if (ref === null || (typeof ref === "object" && "artifactId" in ref && typeof ref.artifactId === "string" && typeof ref.revisionId === "string")
        || (typeof ref === "object" && "kind" in ref && ref.kind === "message_text" && typeof ref.messageId === "string" && typeof ref.text === "string" && (ref.author === "user" || ref.author === "assistant"))) {
        revisionByItem[itemKey] = ref;
      }
    }
    return { groupByWork, itemByGroup, revisionByItem, batchId: typeof parsed.batchId === "string" ? parsed.batchId : null };
  } catch {
    return empty;
  }
}

export function saveStageReading(conversationId: string, reading: StageReading): void {
  try {
    window.localStorage.setItem(`${STAGE_READING_KEY}${conversationId}`, JSON.stringify(reading));
  } catch {
    // 同草稿：不可写时仅本次会话生效。
  }
}

// —— 稿旁意见草稿（B03/U05）—— 按 feedbackKey（会话内含 work+阶段+准确修订）保留文字与
// 重试命令身份；成功只清对应键，失败两者都保留按原命令重试。

export interface StageFeedbackDraft {
  text: string;
  command: FeedbackInput;
}

const STAGE_FEEDBACK_KEY = "vf:agent-stage-feedback:";

export function loadStageFeedbackDrafts(conversationId: string): Record<string, StageFeedbackDraft> {
  try {
    const raw = window.localStorage.getItem(`${STAGE_FEEDBACK_KEY}${conversationId}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const drafts: Record<string, StageFeedbackDraft> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { text?: unknown; command?: unknown };
      if (typeof entry.text !== "string" || !entry.command || typeof entry.command !== "object") continue;
      const command = entry.command as FeedbackInput;
      if (typeof command.commandId !== "string") continue;
      drafts[key] = { text: entry.text, command };
    }
    return drafts;
  } catch {
    return {};
  }
}

export function saveStageFeedbackDrafts(conversationId: string, drafts: Record<string, StageFeedbackDraft>): void {
  try {
    const hasContent = Object.values(drafts).some(draft => draft.text.trim());
    if (hasContent) window.localStorage.setItem(`${STAGE_FEEDBACK_KEY}${conversationId}`, JSON.stringify(drafts));
    else window.localStorage.removeItem(`${STAGE_FEEDBACK_KEY}${conversationId}`);
  } catch {
    // 同上。
  }
}
