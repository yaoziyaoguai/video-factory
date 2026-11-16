import { useEffect, useState } from "react";
import type { ArtifactHead, ArtifactRevision, AudioSummary, CreativeProjectContent, FileContent, InputRef, MediaContent, OperationSpec, Proposal, RenderParameters, Run, Work } from "../../shared/agent/generated/contracts.js";
import { AudioSummaryView, MediaSourceDetails } from "./AudioSummaryView.js";
import { MarkdownBody } from "./markdown.js";

export const runEnded = (state: Run["state"]) => ["succeeded", "failed", "cancelled"].includes(state);
const money = (amount: number) => `¥${(amount / 100).toFixed(2)}`;

const PROPOSAL_STATE_LABEL = {
  ready: "待确认", stale: "需重新准备", expired: "已过期", accepted: "已受理",
} as const;

const RUN_STATE_LABEL = {
  queued: "等待制作", running: "后台制作中", unknown: "结果待核实", cancel_requested: "正在确认取消",
  succeeded: "已完成", failed: "未完成", cancelled: "已停止",
} as const;

const KINDS = { video: "视频", image: "图片", speech: "配音", render: "合成" };
const OP_STATE_LABEL = { pending: "等待中", running: "进行中", succeeded: "已完成", failed: "未完成", cancelled: "已停止" } as const;

// 步骤命名与冻结规格同序：同 kind 依次编号（如“视频 2”），与 HTTP/SSE/read_run 同一事实。
function operationLabel(operation: Run["operations"][number], all: Run["operations"]): string {
  const peers = all.filter(item => item.kind === operation.kind);
  return peers.length > 1 ? `${KINDS[operation.kind]} ${peers.indexOf(operation) + 1}` : KINDS[operation.kind];
}
type RevisionCache = Record<string, ArtifactRevision>;
interface ScopeProps {
  artifacts?: ArtifactHead[] | undefined;
  revisions?: RevisionCache | undefined;
  works?: Work[] | undefined;
  onOpen?: ((id: string, revisionId: string) => void) | undefined;
}

// 交付位置一行（B6）：existing 从当前作品投影读组/事项标签，create 按声明读；不露原始 ID。
// 目标已不存在时返回 null，可否受理仍由服务端 blocker 说明。
function outputTargetLabel(spec: Proposal["spec"], works: Work[]): string | null {
  const declared = "outputTarget" in spec ? spec.outputTarget ?? null : null;
  if (!declared) return null;
  if (declared.group.mode === "existing") {
    const groupId = declared.group.groupId;
    const group = works.find(work => work.id === spec.workId)?.reviewGroups.find(group => group.id === groupId);
    if (!group) return null;
    if (declared.item.mode === "existing") {
      const itemId = declared.item.itemId;
      const item = group.items.find(item => item.id === itemId);
      return item ? `${group.title} · ${item.label}` : null;
    }
    return `${group.title} · ${declared.item.label}`;
  }
  return `${declared.group.title} · ${declared.item.label}`;
}

function revisionLabel(ref: { artifactId: string; revisionId: string }, artifacts: ArtifactHead[], revisions: RevisionCache): string {
  const artifact = artifacts.find(item => item.id === ref.artifactId);
  const revision = revisions[`${ref.artifactId}:${ref.revisionId}`];
  const number = revision?.revisionNumber ?? (artifact?.revisionId === ref.revisionId ? artifact.revisionNumber : null);
  return `${artifact?.title ?? "已选内容"} · ${number ? `v${number}` : "绑定修订待读取"}`;
}
// final render 的视觉槽位：ordered 按 inputs；narrated 按 videoInputSlots；timed/mixed 按 segments。
// code_project 从冻结工程解析，不走输入槽；音乐/配音不计作画面；同一源文件两次引用仍是两个时间线片段。
function finalVisualInputs(spec: Proposal["spec"]): InputRef[] {
  const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId);
  if (final?.kind !== "render" || final.parameters.assembly === "code_project") return [];
  const parameters = final.parameters;
  const slots = parameters.assembly === "narrated_concat" ? parameters.videoInputSlots
    : parameters.assembly === "timed_narrated_concat" || parameters.assembly === "mixed_concat" ? parameters.segments.map(segment => segment.inputSlot)
    : final.inputs.map((_, index) => index);
  return slots.map(slot => final.inputs[slot]).filter((ref): ref is InputRef => ref != null && ref.kind !== "text");
}

function inputLabel(ref: InputRef, spec: Proposal["spec"], artifacts: ArtifactHead[], revisions: RevisionCache): string {
  if (ref.kind === "text") return ref.text;
  if (ref.kind === "artifact_revision") {
    // final 视觉槽上的媒体修订也是保留输入（E3）：标签同样标出，与 blob 一致。
    const kept = finalVisualInputs(spec).some(item => item.kind === "artifact_revision"
      && item.artifactId === ref.artifactId && item.revisionId === ref.revisionId);
    return `${kept ? "保留 · " : ""}${revisionLabel(ref, artifacts, revisions)}`;
  }
  if (ref.kind === "operation_output") {
    const op = spec.operations.find(item => item.operationId === ref.producerOperationId);
    const peers = spec.operations.filter(item => item.kind === op?.kind);
    return `${specReusesMedia(spec) ? "重做 · " : ""}本次${op ? KINDS[op.kind] : "生成"}${peers.length > 1 ? ` ${peers.indexOf(op!) + 1}` : ""}产出`;
  }
  if (ref.kind === "project_revision") return `保留 · 工程 · ${revisionLabel(ref.projectRevision, artifacts, revisions)}`;
  const blobs = spec.operations.flatMap(op => op.inputs).filter(input => input.kind === "blob");
  const ids = [...new Set(blobs.map(input => input.kind === "blob" ? input.blobId : null))];
  return `保留 · 已有素材 ${ids.indexOf(ref.blobId) + 1}`;
}

function renderNarrationInput(op: Extract<OperationSpec, { kind: "render" }>): InputRef | undefined {
  const parameters = op.parameters;
  const slot = parameters.assembly === "mixed_concat" ? parameters.narration?.inputSlot
    : parameters.assembly === "ordered_concat" || parameters.assembly === "code_project" ? undefined : parameters.narrationInputSlot;
  return slot === undefined ? undefined : op.inputs[slot];
}

// 只按冻结规格区分本次生成与已有媒体，不从客户端递归推导声音内容。
const specReusesMedia = (spec: Proposal["spec"]) => {
  const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId);
  const narration = final?.kind === "render" ? renderNarrationInput(final) : undefined;
  return finalVisualInputs(spec).some(ref => ref.kind === "blob" || ref.kind === "artifact_revision" || ref.kind === "project_revision")
    || narration?.kind === "blob" || narration?.kind === "artifact_revision" || narration?.kind === "project_revision";
};
function renderSummary(parameters: RenderParameters): string {
  if (parameters.assembly === "code_project") return `工程渲染 · ${parameters.expectedMediaKind === "video"
    ? `${parameters.width}×${parameters.height} · ${parameters.fps} fps · MP4`
    : parameters.expectedMediaKind === "image" ? `${parameters.width}×${parameters.height} · ${parameters.format.toUpperCase()}`
    : `${parameters.sampleRate} Hz · ${parameters.channels} 声道 · ${parameters.format.toUpperCase()}`}`;
  return `${parameters.width}×${parameters.height} · ${parameters.fps} fps · MP4 · ${
    parameters.assembly === "ordered_concat"
      ? `顺序拼接 · ${parameters.audioMode === "preserve" ? "保留镜头原声" : "全片静音"}`
      : parameters.assembly === "mixed_concat" ? "画面与声音混合成片"
      : `${parameters.assembly === "narrated_concat" ? "旁白成片" : "旁白定时成片"} · 旁白替换原声`}`;
}
function operationSummary(op: OperationSpec): string {
  if (op.kind === "video") return `${op.parameters.durationSeconds} 秒 · ${op.parameters.aspectRatio} · ${op.parameters.resolution} · ${op.parameters.audioMode === "none" ? "无声" : "原生音频"}`;
  if (op.kind === "render") return renderSummary(op.parameters);
  if (op.kind === "image") return `${op.parameters.aspectRatio} · ${op.parameters.resolution}`;
  return `${op.parameters.voiceId} · ${op.parameters.format}`;
}

// timed 分支的镜头按 segments 实际顺序与区间表达；旁白单独一行，不混进画面片段。
function renderSegmentLabel(segment: { kind: "video"; inputSlot: number; startMs: number; durationMs: number } | { kind: "image"; inputSlot: number; durationMs: number }): string {
  return segment.kind === "video"
    ? `视频 ${(segment.startMs / 1000).toFixed(1)}s 起 ${(segment.durationMs / 1000).toFixed(1)}s`
    : `静帧 ${(segment.durationMs / 1000).toFixed(1)}s`;
}

function ProposalScope({ spec, audioSummary, artifacts = [], revisions = {}, works = [], onOpen }: ScopeProps & { spec: Proposal["spec"]; audioSummary?: AudioSummary | undefined }) {
  const final = spec.operations.find(item => item.operationId === spec.finalOutput.operationId);
  const reuses = specReusesMedia(spec);
  const targetLine = outputTargetLabel(spec, works);
  // 保留/重做摘要（B4/E3）：只统计 final render 的视觉输入与旁白，从冻结规格直接数出来。
  let keptLine: string | null = null;
  if (final?.kind === "render" && reuses && final.parameters.assembly !== "code_project") {
    const visual = finalVisualInputs(spec);
    const kept = visual.filter(ref => ref.kind !== "operation_output").length;
    const redone = visual.length - kept;
    const narration = renderNarrationInput(final);
    const parts = [`保留 ${kept} 段`, `重做 ${redone} 段`];
    if (narration && narration.kind !== "text") parts.push(final.parameters.assembly === "mixed_concat"
      ? narration.kind === "operation_output" ? "新配音" : "复用配音"
      : narration.kind === "operation_output" ? "重做旁白" : "复用旁白");
    if (final.parameters.assembly === "mixed_concat") parts.push("本地重合成");
    keptLine = parts.join(" · ");
  }
  return <>
    <p className="agent-proposal-final">最终产出：{final?.kind === "render"
      ? final.parameters.assembly === "code_project" ? `工程产出${reuses ? " · 重新渲染" : ""}`
      : `视频成片${reuses ? " · 重新合成" : ""}` : final ? KINDS[final.kind] : "作品"}</p>
    {targetLine ? <p className="agent-operation-order">交付到：{targetLine}</p> : null}
    {keptLine ? <p className="agent-operation-order">{keptLine}</p> : null}
    {audioSummary ? <AudioSummaryView summary={audioSummary} />
      : final?.kind === "render" && final.parameters.assembly === "code_project" ? null
      : final?.kind === "render" && final.parameters.assembly === "mixed_concat" ? <p className="agent-model-note">本次声音摘要暂不可读。</p>
      : final?.kind === "render" ? <p className="agent-operation-order">声音：{final.parameters.assembly === "ordered_concat"
        ? final.parameters.audioMode === "preserve" ? "保留镜头原声，无音轨片段补等长静音" : "全片静音，不保留镜头原声"
        : final.parameters.assembly === "timed_narrated_concat" ? "旁白替换原声；旁白不足补静音，超出画面时长则不生成"
        : "旁白替换原声；保留完整内容，必要时停留尾帧或补静音"}</p>
      : final?.kind === "video" ? <p className="agent-operation-order">声音：{final.parameters.audioMode === "native" ? "原生音频" : "全片静音"}</p> : null}
    {spec.operations.filter(op => op.kind === "render").map(op => <p className="agent-operation-order" key={op.operationId}>
      {op.parameters.assembly === "code_project" ? <>工程渲染：输出 {op.parameters.outputPath} · {op.parameters.expectedMediaKind === "video" ? "视频" : op.parameters.expectedMediaKind === "image" ? "图片" : "音频"}</>
        : op.parameters.assembly === "mixed_concat" || op.parameters.assembly === "timed_narrated_concat"
        ? <>镜头顺序：{op.parameters.segments.map(segment =>
          `${renderSegmentLabel(segment)}（${inputLabel(op.inputs[segment.inputSlot]!, spec, artifacts, revisions)}）`).join(" → ")}{op.parameters.assembly === "timed_narrated_concat" ? ` · 旁白：${inputLabel(op.inputs[op.parameters.narrationInputSlot]!, spec, artifacts, revisions)}` : null}</>
        : op.parameters.assembly === "narrated_concat"
        ? <>画面顺序：{op.parameters.videoInputSlots.map(slot => inputLabel(op.inputs[slot]!, spec, artifacts, revisions)).join(" → ")} · 旁白：{inputLabel(op.inputs[op.parameters.narrationInputSlot]!, spec, artifacts, revisions)}</>
        : <>拼接顺序：{op.inputs.map(ref => inputLabel(ref, spec, artifacts, revisions)).join(" → ")}</>}
    </p>)}
    <details className="agent-scope-details"><summary>查看制作范围 · {spec.operations.length} 项操作</summary>
      <ul className="agent-proposal-operations">{spec.operations.map(op => <li key={op.operationId}>
        <strong>{op.kind === "render" && reuses ? "重新合成" : KINDS[op.kind]}</strong><span className="agent-operation-line">{operationSummary(op)}</span>
        <span className="agent-operation-line">每次 {money(op.quotePerAttempt.amountMinor ?? 0)}（{op.priceKind === "estimate" ? "估价" : "封顶"}） · 最多 {op.maxCreateAttempts} 次</span>
        <ol className="agent-operation-inputs" aria-label={`${op.operationId} 的输入`}>{op.inputs.map((ref, index) => <li key={index}>
          {ref.kind === "text" ? <span className="agent-production-text"><small>本次使用的文字</small><span>{ref.text}</span></span> : ref.kind === "artifact_revision" && onOpen ? <button type="button" onClick={() => onOpen(ref.artifactId, ref.revisionId)}>{inputLabel(ref, spec, artifacts, revisions)}</button> : inputLabel(ref, spec, artifacts, revisions)}
        </li>)}</ol>
        {op.model ? <dl className="agent-model-binding"><dt>模型</dt><dd>{op.model.providerId} / {op.model.modelId}</dd></dl> : null}
      </li>)}</ul>
    </details>
  </>;
}

function ProposalPrice({ proposal }: { proposal: Proposal }) {
  const totalMinor = proposal.spec.operations.reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
  const estimated = proposal.spec.operations.some(op => op.priceKind === "estimate");
  const simulated = proposal.spec.operations.some(op => op.model?.providerId === "fixture-text");
  const speech = proposal.spec.operations.filter(op => op.kind === "speech");
  const speechMinor = speech.reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
  const zeroLocalRender = proposal.spec.operations.some(op => op.kind === "render" && op.quotePerAttempt.amountMinor === 0);
  return <>
    <p>{estimated ? "估算" : "报价"} {money(totalMinor)} · 本次授权 {money(proposal.spec.maxSpend.amountMinor)}。{estimated ? "估算不代表实际账单或供应商账单封顶。" : "报价不代表实际账单。"}</p>
    {zeroLocalRender ? <p className="agent-model-note">{speech.length ? `本次新配音 ${money(speechMinor)}；` : ""}本地合成 ¥0.00 仅指该操作无媒体供应商费用，其他制作操作与运行成本需分别核对。</p> : null}
    {simulated ? <p className="agent-model-note">模拟媒体，仅验证流程，不发生真实扣费。</p> : null}
    <details className="agent-scope-details"><summary>费用说明</summary><p>{proposal.priceDisclosure}</p></details>
  </>;
}

export function ProposalCard({ proposal, onAccept, onReply, busy = false, artifacts, revisions, works = [], onOpen, onOpenRun }: ScopeProps & {
  proposal: Proposal; onAccept?: ((proposal: Proposal) => void) | undefined; onReply?: (proposal: Proposal) => void;
  busy?: boolean; onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const delay = Date.parse(proposal.expiresAt) - Date.now();
    if (delay <= 0) { setNow(Date.now()); return; }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay + 50, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [proposal.expiresAt]);
  const expired = proposal.state === "ready" && Date.parse(proposal.expiresAt) <= now;
  const ready = proposal.state === "ready" && !expired;
  // 受理门以服务端推导的 blocker 为准（目录/绑定/报价、输入漂移、必要认可）；
  // 客户端不再从阶段状态自行推导可否确认。
  const startable = ready && proposal.acceptanceBlocker === null;
  return <div className="frame-production-proposal" data-state={proposal.state}>
    <header><strong>{proposal.spec.title}</strong><span>{expired ? "已过期" : PROPOSAL_STATE_LABEL[proposal.state]}</span></header>
    <ProposalPrice proposal={proposal} />
    <ProposalScope spec={proposal.spec} audioSummary={proposal.audioSummary} artifacts={artifacts} revisions={revisions} works={works} onOpen={onOpen} />
    {ready && startable ? <p className="agent-model-note">确认后锁定本次输入，意见留给下一版。</p> : null}
    {ready && !startable && proposal.acceptanceBlocker ? <p className="agent-model-note" role="status">{proposal.acceptanceBlocker.message}</p> : null}
    <div className="agent-production-actions">
      {startable || proposal.state === "accepted" ? <button type="button" disabled={!ready || !startable || !onAccept || busy} onClick={() => onAccept?.(proposal)} title={!onAccept ? "制作能力尚未接入" : undefined}>{busy ? "正在确认…" : proposal.state === "accepted" ? "已受理" : "确认制作"}</button> : null}
      {proposal.acceptedRunId && onOpenRun ? <button type="button" onClick={() => onOpenRun(proposal.acceptedRunId!)}>查看制作记录</button> : null}
      {ready && onReply ? <button type="button" onClick={() => onReply(proposal)}>回复这份提案</button> : null}
    </div>
  </div>;
}

export function RunCard({ run, onCancel, onOpen, simulated, proposals = [], artifacts, revisions, works = [], onRetry }: ScopeProps & {
  run: Run; onCancel: (run: Run) => void; onOpen: (id: string, revisionId: string) => void; simulated: boolean; proposals?: Proposal[]; onRetry?: () => void;
}) {
  // 本地请求直接受理的制作没有提案事实；提案来源的 run 才有原提案可回看。
  const originProposalId = run.origin.kind === "proposal" ? run.origin.proposalId : null;
  const proposal = originProposalId ? proposals.find(item => item.id === originProposalId) : null;
  const finished = run.operations.filter(op => op.state === "succeeded").length;
  const percent = run.state === "succeeded" ? 100
    : finished < run.operations.length ? Math.round((finished / run.operations.length) * 100) : null;
  return <div className="agent-run" data-state={run.state}>
    <header><strong>{run.title}</strong><span>{RUN_STATE_LABEL[run.state]}</span></header>
    <p>{run.operations.length} 个制作步骤 · 已完成 {finished}{percent !== null ? `（${percent}%）` : ""}</p>
    <ol className="agent-run-operations">{run.operations.map(op => <li key={op.operationId} data-state={op.state}>
      <span>{operationLabel(op, run.operations)}</span><small>{OP_STATE_LABEL[op.state]}</small>
    </li>)}</ol>
    {simulated ? <p className="agent-model-note">模拟执行 · 无真实媒体扣费</p> : null}
    {run.issue ? <p role="status">{run.issue.message}</p> : null}
    {run.audioSummary ? <AudioSummaryView summary={run.audioSummary} title="本次制作的声音" /> : null}
    <p>{run.finance == null ? "本次制作无供应商费用记账。"
      : run.finance.state === "settled" ? `费用已核对 · ${money(run.finance.settledMinor)}`
      : run.finance.state === "pending_reconciliation"
      ? `供应商账单待核对（${run.finance.settledMinor > 0 ? `已核对 ${money(run.finance.settledMinor)}，` : ""}待核对部分估算 ${money(run.finance.pendingUnknownMinor)}）`
      : `已授权制作 · 本次预留 ${money(run.finance.reservedMinor)}`}</p>
    {run.origin.kind === "proposal" ? (proposal ? <details className="agent-run-scope"><summary>回看原提案：{proposal.spec.title}</summary>
        <ProposalPrice proposal={proposal} /><ProposalScope spec={proposal.spec} audioSummary={proposal.audioSummary} artifacts={artifacts} revisions={revisions} works={works} onOpen={onOpen} />
      </details> : <p>原提案暂不可读。<button type="button" onClick={onRetry}>重试读取</button></p>) : null}
    <div className="agent-production-actions">
      {run.outputRevisions.map((ref, index) => <button type="button" key={ref.revisionId} onClick={() => onOpen(ref.artifactId, ref.revisionId)}>查看{run.outputRevisions.length > 1 ? `产出 ${index + 1}` : "产出"}</button>)}
      {!runEnded(run.state) ? <button type="button" disabled={run.state === "cancel_requested"} onClick={() => onCancel(run)}>停止制作</button> : null}
    </div>
  </div>;
}

// T3 来源署名：按实际 sources 数组展示作者/来源/许可；无来源不造署名，旧记录缺省视为空。
function MediaSources({ sources }: { sources: MediaContent["sources"] }) {
  if (!sources?.length) return null;
  return <div className="agent-media-sources" aria-label="素材来源">
    {sources.map(source => <div key={`${source.provider}:${source.assetId}`}>
      {source.title ? <strong>{source.title}</strong> : null}
      <MediaSourceDetails source={source} />
    </div>)}
  </div>;
}

export function MediaPreview({ content, simulated, onTimeUpdate }: { content: MediaContent; simulated: boolean; onTimeUpdate?: ((seconds: number) => void) | undefined }) {
  const url = `/api/agent/v1/blobs/${encodeURIComponent(content.blobId)}/content`;
  const [dimensions, setDimensions] = useState<{ blobId: string; width: number; height: number } | null>(null);
  return <div className="agent-preview-media">
    {simulated ? <p>模拟样片，仅验证制作流程</p> : null}
    {content.mimeType.startsWith("video/") ? <video key={url} controls preload="metadata" src={url} aria-label="视频预览" onTimeUpdate={event => onTimeUpdate?.(event.currentTarget.currentTime)} />
      : content.mimeType.startsWith("image/") ? <img src={url} alt="图片产出" onLoad={event => {
        const image = event.currentTarget;
        setDimensions({ blobId: content.blobId, width: image.naturalWidth, height: image.naturalHeight });
      }} /> : <audio key={url} controls preload="metadata" src={url} aria-label={content.sources?.length ? "音乐预览" : "音频预览"} />}
    {content.mimeType.startsWith("image/") && dimensions?.blobId === content.blobId && dimensions.width > 0 && dimensions.height > 0
      ? <span className="agent-stage-muted">实际尺寸 {dimensions.width}×{dimensions.height}</span> : null}
    <a href={url} download>下载文件</a>
    <MediaSources sources={content.sources} />
  </div>;
}

// §11.7 来源5：作品库文件卡——文本类按原字节读回渲染（与服务端 read_artifact 同一截断上限），
// 二进制只给事实与下载链接，不在同源页面解释或执行。
export function FilePreview({ content }: { content: FileContent }) {
  const url = `/api/agent/v1/blobs/${encodeURIComponent(content.blobId)}/content`;
  const textual = content.mimeType.startsWith("text/") || content.mimeType === "application/json";
  const [text, setText] = useState<{ value: string; truncated: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!textual) return;
    let disposed = false;
    setText(null); setFailed(false);
    fetch(url).then(async response => {
      if (!response.ok) throw new Error(`blob ${response.status}`);
      return response.text();
    }).then(value => { if (!disposed) setText({ value: value.slice(0, 262_144), truncated: value.length > 262_144 }); })
      .catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [textual, url]);
  return <div className="agent-preview-file">
    <p className="agent-file-facts">{content.path}<small>{content.mimeType}</small></p>
    {textual ? failed ? <p className="agent-stage-muted">文本读取失败，可下载原文件。</p>
      : text ? <pre className="agent-file-text">{text.value}</pre> : <p className="agent-stage-muted">正在读取…</p>
      : <p className="agent-stage-muted">二进制文件不在页面内解释，请下载原字节使用。</p>}
    {text?.truncated ? <p className="agent-stage-muted">内容较长，仅显示前 256 KiB。</p> : null}
    <a href={url} download>下载文件</a>
  </div>;
}

// 冻结工程的只读概览：文件清单与入口按快照呈现，不在客户端执行或猜测产物。
export function ProjectPreview({ content }: { content: CreativeProjectContent }) {
  return <div className="agent-preview-project">
    <p>{content.files.length} 个文件{content.timelineFiles.length ? ` · ${content.timelineFiles.length} 个时间线文件` : ""}{content.dependencyLocks.length ? ` · ${content.dependencyLocks.length} 个锁定依赖` : ""}</p>
    <ul>{content.files.map(file => <li key={file.relativePath}><span>{file.relativePath}</span><small>{file.purpose}</small></li>)}</ul>
    <p className="agent-stage-muted">入口 {content.entrypoint.argv.join(" ")} · 运行镜像 {content.runtimeImage}</p>
  </div>;
}

// 修订正文按 format 判别渲染；调用方只提供准确修订，不预读内容。
export function RevisionBody({ content, simulated, onTimeUpdate }: { content: ArtifactRevision["content"]; simulated: boolean; onTimeUpdate?: ((seconds: number) => void) | undefined }) {
  if (content.format === "markdown") return <MarkdownBody content={content} />;
  if (content.format === "media") return <MediaPreview content={content} simulated={simulated} onTimeUpdate={onTimeUpdate} />;
  if (content.format === "file") return <FilePreview content={content} />;
  return <ProjectPreview content={content} />;
}
