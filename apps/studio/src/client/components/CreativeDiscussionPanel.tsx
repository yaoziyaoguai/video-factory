import { ArrowLeft, Check, MessageCircle, RotateCcw, Send } from "lucide-react";
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
    if (!text || busy) return;
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
    if (busy) return;
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
    if (busy || !window.confirm(`${target.impact}\n\n确定${target.label}吗？`)) return;
    void submit({
      action: "return_to_stage",
      commandId: crypto.randomUUID(),
      ...commandBase,
      targetStage: target.stage,
      acknowledgeImpact: true,
    }).catch(() => undefined);
  }

  return (
    <section className="creative-discussion-panel" aria-labelledby="creative-review-title">
      <header className="creative-discussion-header">
        <div>
          <p className="eyebrow">当前需要你参与</p>
          <h2 id="creative-review-title">{hasBlockingIssues ? "当前导演方案需要你决定" : `${STAGE_LABEL[review.stage]}已生成，等你确认`}</h2>
          <p>{hasBlockingIssues
            ? "没有找到满足当前要求的素材。已保留你确认的方案，不会自动改成生成画面；请先在右侧告诉导演允许怎样调整，或补充合适素材。"
            : "可以直接继续，也可以先聊聊想改的地方。点确认会按当前这一版做一次独立复核：复核通过才进入下一步；复核提出意见时你会停在同一份方案上，可以照着改，也可以看过意见后仍然确认。确认不会购买素材。"}</p>
        </div>
        <span className={`creative-review-phase phase-${review.phase}`}>
          {review.phase === "checking" ? "正在处理原操作" : `第 ${review.reviewRevision} 版讨论`}
        </span>
      </header>

      <div className="creative-mobile-tabs" role="tablist" aria-label="方案与讨论">
        <button type="button" role="tab" aria-selected={mobileTab === "draft"} onClick={() => setMobileTab("draft")}>当前方案</button>
        <button type="button" role="tab" aria-selected={mobileTab === "discussion"} onClick={() => setMobileTab("discussion")}>讨论</button>
      </div>

      <div className="creative-discussion-layout">
        <article className={mobileTab === "draft" ? "creative-draft-surface is-mobile-active" : "creative-draft-surface"} aria-label={`当前${STAGE_LABEL[review.stage]}`}>
          <CreativeDraft stage={review.stage} value={review.draft} />
          <CreativeSelection
            stage={review.stage}
            draft={review.draft}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
          />
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
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => void submit({ action: "adopt_proposal", commandId: crypto.randomUUID(), ...commandBase, proposalId: proposal.proposalId }).catch(() => undefined)}>采用这个备选</button>
          </section>)}
        </article>

        <section className={mobileTab === "discussion" ? "creative-chat-surface is-mobile-active" : "creative-chat-surface"} aria-label="与当前角色讨论">
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
          <button type="button" className="button button-secondary" disabled={busy || !message.trim()} onClick={sendMessage}><Send aria-hidden="true" size={16} />{busy ? "正在处理…" : "发送"}</button>
        </section>
      </div>

      {error ? <p className="form-error" role="alert">{error} 输入内容已保留，请查看最新方案后再试。</p> : null}
      {review.returnTargets.length > 0 ? <aside className="creative-return-actions" aria-label="返回前期方案">
        <strong>需要调整更早的决定？</strong>
        <p>返回后只让受影响的后续方案失效，历史稿件和已可用素材会保留。</p>
        {review.returnTargets.map((target) => <button key={target.stage} type="button" className="button button-secondary" disabled={busy} title={target.impact} onClick={() => returnToStage(target)}><ArrowLeft aria-hidden="true" size={16} />{target.label}</button>)}
      </aside> : null}
      <footer className="creative-review-actions">
        <button type="button" className="button button-ghost" disabled={busy || review.previousDraft === undefined} onClick={() => void submit({ action: "undo_draft", commandId: crypto.randomUUID(), ...commandBase }).catch(() => undefined)}><RotateCcw aria-hidden="true" size={16} />撤销本轮修改</button>
        <button type="button" className="button button-primary" disabled={busy} onClick={confirmDraft}><Check aria-hidden="true" size={16} />{awaitingRepair ? "看过意见，仍然确认" : hasBlockingIssues ? "修改后重新检查" : "确认当前方案，继续"}</button>
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
  if (stage === "script") return <div className="creative-readable-draft"><DraftField label="叙事推进" value={value.narrativeArc} />{Array.isArray(value.scenes) ? value.scenes.map((scene, index) => isRecord(scene) ? <section className="creative-scene" key={String(scene.id ?? index)}><strong>第 {Number(scene.position ?? index + 1)} 段 · {Number(scene.duration ?? 0)} 秒</strong><p>{String(scene.narration ?? "")}</p><small>画面描述（尚未生成）：{String(scene.visual_prompt ?? "")}</small></section> : null) : null}</div>;
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
