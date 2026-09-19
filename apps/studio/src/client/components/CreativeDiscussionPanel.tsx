import { ArrowLeft, Check, FilePenLine, MessageCircle, RotateCcw, Save, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { StudioCreativeReviewCommandInput, StudioCreativeReviewSnapshot } from "../../shared/api.js";

interface CreativeDiscussionPanelProps {
  review: StudioCreativeReviewSnapshot;
  busy: boolean;
  onCommand(input: StudioCreativeReviewCommandInput): Promise<void>;
}

// 与 PlanningStagesPanel 的阶段名保持一致。这里曾经把 treatment 写成"导演方案"、
// 把 director 写成"分镜与画面方案"，于是同一个停点的标题和提示各说各的名字。
const STAGE_LABEL = { treatment: "前期构思", script: "脚本", director: "导演方案" } as const;

export function CreativeDiscussionPanel({ review, busy, onCommand }: CreativeDiscussionPanelProps) {
  const storageKey = `vf:creative-draft:${review.runId}:${review.stage}`;
  const commandStorageKey = `vf:creative-command:${review.runId}:${review.stage}`;
  const currentStorageKey = useRef(storageKey);
  currentStorageKey.current = storageKey;
  const [message, setMessage] = useState(() => window.localStorage.getItem(storageKey) ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const [mobileTab, setMobileTab] = useState<"draft" | "discussion">("draft");
  const hasBlockingIssues = review.blockingIssues.length > 0;
  // 草稿一变 publishCreativeDraft 必然清空 checkResult，所以在场的 repair 一定是针对当前草稿的。
  // 复核是"提议"而不是"否决"：此时确认仍然可用，但必须由人显式承担，并把被接受的意见记进
  // confirmation.acknowledgedRepair，事后能查到是谁在什么结论下放行的。
  const awaitingRepair = review.checkResult?.verdict === "repair";
  const commandBase = useMemo(() => ({
    expectedRunRevision: review.runRevision,
    expectedReviewRevision: review.reviewRevision,
    stage: review.stage,
    baseDraftSha256: review.draftSha256,
  }), [review]);

  useEffect(() => {
    setMessage(window.localStorage.getItem(storageKey) ?? "");
    setSelectedIds([]);
  }, [storageKey]);

  useEffect(() => {
    if (message) window.localStorage.setItem(storageKey, message);
    else window.localStorage.removeItem(storageKey);
  }, [message, storageKey]);

  async function submit(input: StudioCreativeReviewCommandInput, clearMessage = false) {
    setError(undefined);
    const pending = readPendingCommand(commandStorageKey);
    const command = pending && sameCommandBody(pending, input) ? pending : input;
    window.localStorage.setItem(commandStorageKey, JSON.stringify(command));
    try {
      await onCommand(command);
      window.localStorage.removeItem(commandStorageKey);
      if (clearMessage && currentStorageKey.current === storageKey) setMessage((current) => current === message ? "" : current);
    } catch (caught) {
      if (caught instanceof Error && "commandCompleted" in caught && caught.commandCompleted === true) {
        window.localStorage.removeItem(commandStorageKey);
      }
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  }

  function sendMessage() {
    const text = message.trim();
    if (!text || busy || !review.allowedActions.includes("discuss")) return;
    void submit({
      action: "discuss",
      commandId: crypto.randomUUID(),
      ...commandBase,
      message: text,
      ...(selectedIds.length ? { selection: creativeSelection(review.stage, selectedIds) } : {}),
    }, true).catch(() => undefined);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== "Enter" || !event.ctrlKey) return;
    event.preventDefault();
    sendMessage();
  }

  function confirmDraft() {
    if (busy || hasUnsavedEdits || !review.allowedActions.includes("confirm")) return;
    if (awaitingRepair && !window.confirm(
      "独立复核对当前这一版提出了意见，还没有通过。\n\n"
      + "继续会让流程带着这些未处理的意见进入下一步，系统会记录是你确认放行的。\n\n"
      + "确定仍然确认吗？",
    )) return;
    void submit({
      action: "confirm",
      commandId: crypto.randomUUID(),
      ...commandBase,
      // 把界面上这一条复核的身份原样带回去：确认要指向人看到的意见，不能指向服务端
      // 此刻恰好记着的那一条。
      ...(review.checkResult ? { expectedCheckIdentity: review.checkResult.checkIdentity } : {}),
      ...(awaitingRepair ? { acknowledgeRepair: true } : {}),
    }).catch(() => undefined);
  }

  function returnToStage(target: StudioCreativeReviewSnapshot["returnTargets"][number]) {
    if (busy || hasUnsavedEdits || !review.allowedActions.includes("return_to_stage") || !window.confirm(`${target.impact}\n\n确定${target.label}吗？`)) return;
    void submit({
      action: "return_to_stage",
      commandId: crypto.randomUUID(),
      ...commandBase,
      targetStage: target.stage,
      acknowledgeImpact: true,
    }).catch(() => undefined);
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

  return (
    <section className="creative-discussion-panel" aria-labelledby="creative-review-title">
      <header className="creative-discussion-header">
        <div>
          <h2 id="creative-review-title">{hasBlockingIssues ? "当前导演方案需要你决定" : `${STAGE_LABEL[review.stage]}已生成，等你确认`}</h2>
          {hasBlockingIssues ? <p>素材暂不满足方案。已保留你确认的方案，不会自动改成生成画面；请在讨论区说明允许怎样调整，或补充素材。</p> : null}
        </div>
        <span className={`creative-review-phase phase-${review.phase}`}>
          {review.phase === "checking" ? "正在处理原操作" : `第 ${review.reviewRevision} 版讨论`}
        </span>
      </header>

      <div className="creative-mobile-tabs" role="group" aria-label="方案与讨论">
        <button type="button" aria-pressed={mobileTab === "draft"} aria-controls="creative-draft" onClick={() => setMobileTab("draft")}>当前方案</button>
        <button type="button" aria-pressed={mobileTab === "discussion"} aria-controls="creative-chat" onClick={() => setMobileTab("discussion")}>讨论{review.messages.length > 0 ? ` · ${review.messages.length}` : ""}</button>
      </div>

      <div className="creative-discussion-layout">
        <article id="creative-draft" tabIndex={0} className={mobileTab === "draft" ? "creative-draft-surface is-mobile-active" : "creative-draft-surface"} aria-label={`当前${STAGE_LABEL[review.stage]}`}>
          <CreativeDraftEditor storageKey={`${storageKey}:edit`} draftIdentity={`${review.draftArtifactId}:${review.draftSha256}`} stage={review.stage} draft={review.draft} busy={busy || review.phase === "checking" || !review.allowedActions.includes("edit_draft")} onSave={saveEditedDraft} onDirtyChange={setHasUnsavedEdits} />
          <CreativeDraft stage={review.stage} value={review.draft} />
          <details className="creative-selection-disclosure"><summary>指定讨论范围{selectedIds.length > 0 ? ` · 已选 ${selectedIds.length} 项` : "（可选）"}</summary><CreativeSelection
            stage={review.stage}
            draft={review.draft}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
          /></details>
          {review.previousDraft !== undefined ? <details><summary>查看上一版</summary><CreativeDraft stage={review.stage} value={review.previousDraft} /></details> : null}
          {review.checkResult?.verdict === "repair" ? <section className="creative-check-result" role="status">
            <strong>有 {review.checkResult.issues.length} 处需要调整，尚未进入下一步</strong>
            <p>{review.checkResult.summary}</p>
            <ul>{review.checkResult.issues.map((issue, index) => <li key={`${issue.criterion}:${index}`}>
              <strong>{issue.criterion}</strong><span>{issue.repairInstruction}</span>
              {/* 复核已经定位到具体条目，人不必再把字段级意见翻译成散文重述一遍；
                  只预填不发送，改不改、怎么改仍由人按下发送键决定。 */}
              <div className="creative-check-actions">
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => {
                  setMessage([
                    "只按下面这一条意见修改，不要扩大改动范围。",
                    "",
                    `意见：${issue.criterion}`,
                    `复核给的修复指令：${issue.repairInstruction}`,
                    `依据：${issue.evidence}`,
                    "",
                    "如果这条指令给了多个可选分支，请按最保守的一支执行，并说明你选了哪一支。",
                  ].join("\n"));
                  setMobileTab("discussion");
                }}>按这条意见改</button>
                <button type="button" className="button button-ghost" disabled={busy} onClick={() => {
                  setMessage([
                    "这条意见我不接受，理由如下：",
                    "",
                    "",
                    "请保留当前做法，不要按这条意见改；如果你认为该判断成立，请说明依据。",
                    "",
                    `（原意见：${issue.criterion}）`,
                  ].join("\n"));
                  setMobileTab("discussion");
                }}>这条我不同意</button>
              </div>
            </li>)}</ul>
          </section> : null}
          {/* 停在这里是因为自动循环推不动了，不是这一版做完了。不说出来，人会以为一切正常。 */}
          {review.stopDetail ? <section className="creative-check-result" role="status">
            <strong>自动检查已停止，需要你决定</strong>
            <p>{review.stopDetail}</p>
          </section> : null}
          {hasBlockingIssues ? <section className="creative-check-result" role="status">
            <strong>当前素材条件无法满足方案</strong>
            <ul>{review.blockingIssues.map((issue, index) => <li key={`${issue.reason}:${index}`}>
              <strong>{issue.scenePositions.length > 0 ? `镜头 ${issue.scenePositions.join("、")}` : "当前方案"}</strong>
              <span>{issue.reason}。{issue.requiredChange}</span>
            </li>)}</ul>
          </section> : null}
          {review.proposals.map((proposal) => <section className="creative-proposal" key={proposal.proposalId}>
            <header><strong>备选方案</strong><small>{proposal.changeSummary.join("；") || "可与当前方案比较"}</small></header>
            <CreativeDraft stage={review.stage} value={proposal.document} />
            <button type="button" className="button button-secondary" disabled={busy || hasUnsavedEdits || !review.allowedActions.includes("adopt_proposal")} onClick={() => void submit({ action: "adopt_proposal", commandId: crypto.randomUUID(), ...commandBase, proposalId: proposal.proposalId }).catch(() => undefined)}>采用这个备选</button>
          </section>)}
        </article>

        <section id="creative-chat" className={mobileTab === "discussion" ? "creative-chat-surface is-mobile-active" : "creative-chat-surface"} aria-label="与当前角色讨论">
          <header className="creative-chat-heading"><MessageCircle aria-hidden="true" size={17} /><strong>一起打磨这一版</strong></header>
          <div className="creative-message-list" aria-live="polite">
            {review.messages.length === 0 ? <p className="creative-empty-chat"><MessageCircle aria-hidden="true" size={18} />还没有讨论。可以问为什么这样安排，或直接说想改成什么样。</p> : null}
            {review.messages.map((entry) => <p key={entry.id} className={`creative-message message-${entry.role}`}><span>{entry.role === "user" ? "你" : "创作角色"}</span>{entry.text}</p>)}
          </div>
          <div className="creative-quick-prompts" aria-label="讨论提示">
            {["解释这个安排", "开头不够吸引", "给我另一个方向，但先不要替换"].map((text) => <button type="button" key={text} disabled={busy} onClick={() => setMessage(text)}>{text}</button>)}
          </div>
          <label className="creative-composer">
            <span>聊聊你的想法</span>
            <textarea value={message} maxLength={4000} onChange={(event) => setMessage(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="例如：为什么这样开场？或者：把开头改得更直接一些。" />
            <small>Ctrl + Enter 发送；普通换行不会发送。</small>
          </label>
          <button type="button" className="button button-secondary" disabled={busy || !message.trim() || !review.allowedActions.includes("discuss")} onClick={sendMessage}><Send aria-hidden="true" size={16} />{busy ? "正在处理…" : "发送"}</button>
        </section>
      </div>

      {error ? <p className="form-error" role="alert">{error} 输入内容已保留，请查看最新方案后再试。</p> : null}
      {review.returnTargets.length > 0 ? <aside className="creative-return-actions" aria-label="返回前期方案">
        <strong>需要调整更早的决定？</strong>
        <p>返回后只让受影响的后续方案失效，历史稿件和已可用素材会保留。</p>
        {review.returnTargets.map((target) => <button key={target.stage} type="button" className="button button-secondary" disabled={busy || hasUnsavedEdits || !review.allowedActions.includes("return_to_stage")} title={target.impact} onClick={() => returnToStage(target)}><ArrowLeft aria-hidden="true" size={16} />{target.label}</button>)}
      </aside> : null}
      <footer className="creative-review-actions">
        <div className="creative-confirm-context"><strong>{hasUnsavedEdits ? "有未保存的手动修改" : `确认对象：当前${STAGE_LABEL[review.stage]}`}</strong><small>{hasUnsavedEdits ? "先保存或放弃修改，再确认采用；不会提交编辑器里的未保存文字。" : "确认时独立复核，不会购买素材；有意见由你决定，后续步骤仍需确认。"}</small></div>
        <button type="button" className="button button-ghost" disabled={busy || hasUnsavedEdits || review.previousDraft === undefined || !review.allowedActions.includes("undo_draft")} onClick={() => void submit({ action: "undo_draft", commandId: crypto.randomUUID(), ...commandBase }).catch(() => undefined)}><RotateCcw aria-hidden="true" size={16} />撤销本轮修改</button>
        <button type="button" className="button button-primary" disabled={busy || hasUnsavedEdits || !review.allowedActions.includes("confirm")} onClick={confirmDraft}><Check aria-hidden="true" size={16} />{awaitingRepair ? "看过意见，仍然确认" : hasBlockingIssues ? "修改后重新检查" : "确认当前方案，继续"}</button>
      </footer>
    </section>
  );
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
  if (stage === "treatment") return Array.isArray(draft.progression) ? draft.progression.flatMap((item, index) => isRecord(item) ? [{ id: String(item.beatId ?? `beat-${index + 1}`), label: `内容推进 ${index + 1}：${String(item.purpose ?? "")}` }] : []) : [];
  if (stage === "script") return Array.isArray(draft.scenes) ? draft.scenes.flatMap((item, index) => isRecord(item) ? [{ id: String(item.id ?? `scene-${index + 1}`), label: `第 ${Number(item.position ?? index + 1)} 段` }] : []) : [];
  return Array.isArray(draft.shots) ? draft.shots.flatMap((item, index) => isRecord(item) ? [{ id: `scene-${Number(item.scenePosition ?? index + 1)}`, label: `镜头 ${Number(item.scenePosition ?? index + 1)}` }] : []) : [];
}

function creativeSelection(stage: StudioCreativeReviewSnapshot["stage"], ids: string[]) {
  return {
    kind: stage === "treatment" ? "beat" as const : "scene" as const,
    ids,
    scenePositions: stage === "treatment" ? [] : ids.map((id) => Number(id.replace(/^scene-/, ""))).filter(Number.isInteger),
  };
}

function readPendingCommand(key: string): StudioCreativeReviewCommandInput | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as StudioCreativeReviewCommandInput | null;
    return value && typeof value === "object" && typeof value.commandId === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function sameCommandBody(left: StudioCreativeReviewCommandInput, right: StudioCreativeReviewCommandInput): boolean {
  const withoutCommandLeft = { ...left, commandId: "" };
  const rightWithoutId = { ...right, commandId: "" };
  return JSON.stringify(withoutCommandLeft) === JSON.stringify(rightWithoutId);
}

function CreativeDraft({ stage, value }: { stage: StudioCreativeReviewSnapshot["stage"]; value: unknown }) {
  if (!isRecord(value)) return <p>当前方案暂时无法读取，请刷新后重试。</p>;
  if (stage === "treatment") return <div className="creative-readable-draft">
    <DraftField label="观众看完能得到什么" value={value.viewerPromise} />
    <DraftField label="开头" value={isRecord(value.hook) ? `${String(value.hook.narrationIntent ?? "")} ${String(value.hook.visualIntent ?? "")}` : value.hook} />
    <DraftList label="内容推进" value={Array.isArray(value.progression) ? value.progression.map((beat) => isRecord(beat) ? `${String(beat.purpose ?? "")}：${String(beat.viewerGain ?? "")}` : String(beat)) : []} />
    <DraftField label="结尾兑现" value={value.payoff} />
    <DraftList label="视觉方向" value={value.visualPrinciples} />
    <DraftList label="声音方向" value={value.soundPrinciples} />
  </div>;
  if (stage === "script") return <div className="creative-readable-draft"><DraftField label="叙事推进（制作参考）" value={value.narrativeArc} />{Array.isArray(value.scenes) ? value.scenes.map((scene, index) => isRecord(scene) ? <section className="creative-scene" key={String(scene.id ?? index)}><strong>第 {Number(scene.position ?? index + 1)} 段 · {Number(scene.duration ?? 0)} 秒</strong><div className="creative-audience-copy"><small>旁白 · 观众听到的内容</small><p>{String(scene.narration ?? "")}</p></div><div className="creative-production-note"><small>画面描述 · 制作参考，尚未生成</small><p>{String(scene.visual_prompt ?? "")}</p></div></section> : null) : null}</div>;
  return <div className="creative-readable-draft">{isRecord(value.visualBible) ? <DraftField label="全片视觉规则" value={`${String(value.visualBible.narrativeApproach ?? "")} · ${String(value.visualBible.pacing ?? "")} · ${String(value.visualBible.continuity ?? "")}`} /> : null}{Array.isArray(value.shots) ? value.shots.map((shot, index) => isRecord(shot) ? <section className="creative-scene" key={String(shot.scenePosition ?? index)}><strong>镜头 {Number(shot.scenePosition ?? index + 1)} · {String(shot.deliveryType ?? "待定路线")}</strong><p>{String(shot.visibleAction ?? shot.generationPrompt ?? shot.query ?? "")}</p><small>预计时长与获取路线将在当前方案确认后进入报价；画面尚未生成。</small></section> : null) : null}</div>;
}

function DraftField({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return <section><strong>{label}</strong><p>{String(value)}</p></section>;
}

function DraftList({ label, value }: { label: string; value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return <section><strong>{label}</strong><ul>{value.map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 人工修订编辑器（v1）：只暴露各阶段合同里的**文字性字段**——叙述、承诺、视觉规则的措辞、
 * 每段/每镜的描述文字。镜头增删、路线更换这类结构性改动会牵动排序/报价/画面证据，仍然走
 * 讨论或重新生成；文字修订在这里改完保存，走与 AI 修订完全相同的制度：换稿 → 停点重现 →
 * 确认时自动跑一轮新的独立复核。
 */
function CreativeDraftEditor({ storageKey, draftIdentity, stage, draft, busy, onSave, onDirtyChange }: {
  storageKey: string;
  draftIdentity: string;
  stage: StudioCreativeReviewSnapshot["stage"];
  draft: unknown;
  busy: boolean;
  onSave(document: Record<string, unknown>): Promise<void>;
  onDirtyChange(dirty: boolean): void;
}) {
  const [edited, setEdited] = useState<{ baseKey: string; document: Record<string, unknown> } | null>(() => {
    try {
      const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      return isRecord(stored) && typeof stored.baseKey === "string" && isRecord(stored.document)
        ? { baseKey: stored.baseKey, document: stored.document } : null;
    } catch { return null; }
  });
  const [open, setOpen] = useState(edited !== null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "failed">();
  const draftKey = JSON.stringify({ stage, draftIdentity, draft });
  const stale = edited !== null && edited.baseKey !== draftKey;
  useEffect(() => {
    onDirtyChange(edited !== null);
    // 本地文字只用于恢复编辑，不作为服务端采用版本或确认依据。
    try {
      if (edited) window.localStorage.setItem(storageKey, JSON.stringify(edited));
      else window.localStorage.removeItem(storageKey);
    } catch { /* 存储不可用时仍保留当前页内的文字。 */ }
  }, [edited, onDirtyChange, storageKey]);
  useEffect(() => {
    if (!edited) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [edited]);
  const fields = useMemo(() => editableTextFields(stage, edited?.document ?? draft), [stage, edited, draft]);
  if (!isRecord(draft) || fields.length === 0) return null;
  const current = edited?.document ?? draft;
  const dirty = edited !== null;
  return <details className="creative-draft-editor" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><FilePenLine aria-hidden="true" size={14} />手动修订这份稿件{dirty ? " · 有未保存修改" : ""}</summary>
    {/* 收起时不渲染字段：可读稿和编辑器里会出现相同文字，展开才挂载避免同一屏两份同文。 */}
    {open ? <>
      <p className="creative-edit-state" role="status">{stale ? "当前方案已更新。你的未保存文字仍在下方，可先复制留存；请放弃旧稿修改、重新读取当前版本后再编辑。旧稿不能覆盖新稿。" : saving ? "正在保存修订，等待服务端确认…" : saveState === "failed" ? "保存未完成，输入仍保留。请查看错误后重试。" : dirty ? "修改尚未生效；保存后仍等你确认采用，确认时重新独立复核。" : saveState === "saved" ? "修订已保存。请核对当前稿，再确认采用。" : "可直接修改文字。保存不会自动采用或购买素材；确认采用时重新独立复核。"}</p>
      {fields.map((field) => <label key={field.key} className="creative-edit-field">
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
            try { await onSave(edited.document); setEdited(null); setSaveState("saved"); }
            catch { setSaveState("failed"); }
            finally { setSaving(false); }
          }}
        ><Save aria-hidden="true" size={15} />{saving || busy ? "正在处理…" : "保存修订"}</button>
      </div>
    </> : null}
  </details>;
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
  const list = (key: string, label: string, field: string): EditableTextField | null => {
    const items = draft[field];
    if (!Array.isArray(items) || items.length === 0) return null;
    return {
      key,
      label,
      value: items.map((item) => String(item)).join("\n"),
      apply: (next, value) => { next[field] = value.split("\n").map((line) => line.trim()).filter(Boolean); return next; },
    };
  };
  if (stage === "treatment") {
    const fields: EditableTextField[] = [];
    const viewer = text("viewerPromise", "观众看完能得到什么", (d) => d.viewerPromise, (d, v) => { d.viewerPromise = v; });
    if (viewer) fields.push(viewer);
    if (isRecord(draft.hook)) {
      for (const [field, fieldLabel] of [["narrationIntent", "开头的叙述意图"], ["visualIntent", "开头的画面意图"]] as const) {
        if (draft.hook[field] === undefined || draft.hook[field] === null) continue;
        fields.push({
          key: `hook.${field}`,
          label: fieldLabel,
          value: String(draft.hook[field]),
          apply: (next, value) => { next.hook = { ...(next.hook as Record<string, unknown>), [field]: value }; return next; },
        });
      }
    }
    fields.push(...collectionTextFields(draft, "progression", "内容推进", [
      ["purpose", "这一段的作用"],
      ["viewerGain", "观众得到什么"],
    ], (item) => String(item.beatId ?? "")));
    const payoff = text("payoff", "结尾兑现", (d) => d.payoff, (d, v) => { d.payoff = v; });
    if (payoff) fields.push(payoff);
    const principles = list("visualPrinciples", "视觉方向（每行一条）", "visualPrinciples");
    if (principles) fields.push(principles);
    const sound = list("soundPrinciples", "声音方向（每行一条）", "soundPrinciples");
    if (sound) fields.push(sound);
    return fields;
  }
  if (stage === "script") {
    const fields: EditableTextField[] = [];
    const arc = text("narrativeArc", "叙事推进", (d) => d.narrativeArc, (d, v) => { d.narrativeArc = v; });
    if (arc) fields.push(arc);
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
    ["viewerPromise", "观众承诺"],
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
