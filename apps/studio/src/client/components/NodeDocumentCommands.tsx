import { useEffect, useRef, useState } from "react";
import { studioApi } from "../api.js";
import type { StudioDocumentCommand, StudioNodeDocumentRevisionInput, StudioNodeDocumentAuditInput } from "../../shared/api.js";
import { creatorFacingTechnicalText } from "../presentation.js";

const MAX_INSTRUCTION_CHARS = 4_000;

export interface NodeDocumentCommandsProps {
  runId?: string;
  nodeId: string;
  runRevision: number;
  effectiveVersionId: string;
  contentReview: { status: string; summary: string; suggestions: string[]; auditId?: string };
  busy: boolean;
  completed?: boolean;
  onRevise: (nodeId: string, input: StudioNodeDocumentRevisionInput) => Promise<void>;
  onAudit: (nodeId: string, input: StudioNodeDocumentAuditInput) => Promise<void>;
}

/**
 * 文字交付的 AI 修订与主动再审控件（合同 S4/S5）：
 * 建议仅追加进修订意见，不覆盖、不自动发送；最终修订要求以编辑框文本为准。
 */
export function NodeDocumentCommands({ runId, nodeId, runRevision, effectiveVersionId, contentReview, busy, completed = false, onRevise, onAudit }: NodeDocumentCommandsProps) {
  const [instruction, setInstruction] = useState("");
  const [revisionOpen, setRevisionOpen] = useState(!completed);
  const [checked, setChecked] = useState<number[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [commands, setCommands] = useState<StudioDocumentCommand[]>([]);
  const [unsettled, setUnsettled] = useState<StudioDocumentCommand>();
  const [lookupFailed, setLookupFailed] = useState(false);
  const [localPointerFailed, setLocalPointerFailed] = useState(false);
  const [loadingCommands, setLoadingCommands] = useState(Boolean(runId));
  const storageKey = runId ? `vf:document-command:${runId}:${nodeId}` : undefined;
  const scope = `${runId ?? ""}:${nodeId}`;
  const currentScope = useRef(scope);
  const lookupSequence = useRef(0);
  currentScope.current = scope;
  async function refreshCommands() {
    if (!runId) return;
    const sequence = ++lookupSequence.current;
    try {
      const rows = await studioApi.documentCommands(runId, nodeId);
      if (currentScope.current !== scope || sequence !== lookupSequence.current) return;
      setCommands(rows);
      setLookupFailed(false);
      const active = rows.find((row) => ["created", "pending", "completed"].includes(row.state));
      let local: StudioDocumentCommand | undefined;
      try { local = readDocumentCommandPointer(storageKey); setLocalPointerFailed(false); }
      catch { setLocalPointerFailed(true); }
      const stored = local && rows.find((row) => row.commandId === local.commandId);
      // 本地缓存损坏不影响服务端已确认的原请求；身份无法识别时仍禁止新调用。
      setUnsettled(active ?? (local && !stored ? local : undefined));
      if (stored && !active) forgetDocumentCommandPointer(storageKey, stored.commandId);
      return rows;
    } catch {
      if (currentScope.current === scope && sequence === lookupSequence.current) setLookupFailed(true);
    } finally { if (currentScope.current === scope && sequence === lookupSequence.current) setLoadingCommands(false); }
  }
  useEffect(() => { setCommands([]); setUnsettled(undefined); setLookupFailed(false); setLocalPointerFailed(false); setWorking(false); setError(undefined); setInfo(undefined); }, [runId, nodeId]);
  useEffect(() => { setLoadingCommands(Boolean(runId)); void refreshCommands(); }, [runId, nodeId, runRevision]);
  const target = `${scope}:${effectiveVersionId}`;
  const [targetContext, setTargetContext] = useState({ target, generation: 0 });
  // 离开后再回到同一版本，也已是另一轮编辑上下文；不能让旧意见自动重新生效。
  if (targetContext.target !== target) setTargetContext({ target, generation: targetContext.generation + 1 });
  const [instructionTarget, setInstructionTarget] = useState(targetContext.generation);
  const instructionOwnership = useRef({ value: instruction, generation: instructionTarget });
  instructionOwnership.current = { value: instruction, generation: instructionTarget };
  const staleInstruction = instruction.length > 0 && instructionTarget !== targetContext.generation;
  const adviceIdentity = `${target}:${contentReview.auditId ?? JSON.stringify(contentReview)}`;
  useEffect(() => { setChecked([]); setInfo(undefined); }, [adviceIdentity]);
  const overLimit = [...instruction].length > MAX_INSTRUCTION_CHARS;
  const pending = busy || working || loadingCommands || lookupFailed || localPointerFailed || Boolean(unsettled);
  const auditLabel = `${contentReview.status === "not_audited" ? "" : "重新"}审计当前版本（会调用模型）`;
  const visibleCommands = unsettled ? [unsettled, ...commands.filter(command => command.commandId !== unsettled.commandId)] : commands;
  // 只在完成状态切换时决定默认展开；输入过程中不改变用户已选择的开合状态。
  useEffect(() => { setRevisionOpen(!completed || Boolean(instruction)); }, [completed]);

  function rememberCommand(action: "revise" | "audit", text?: string): StudioDocumentCommand {
    const now = new Date().toISOString();
    const command: StudioDocumentCommand = { commandId: crypto.randomUUID(), action, state: "created",
      expectedRunRevision: runRevision, expectedVersionId: effectiveVersionId,
      ...(text ? { instruction: text } : {}), createdAt: now, updatedAt: now, billingPending: true };
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(command)); }
      catch { throw new Error("无法保存本次操作编号，尚未发送给模型。请检查浏览器存储；修改意见仍保留。"); }
    }
    setUnsettled(command);
    return command;
  }

  async function runCommand(command: StudioDocumentCommand) {
    const input = { commandId: command.commandId, expectedRunRevision: command.expectedRunRevision,
      expectedVersionId: command.expectedVersionId };
    if (command.action === "revise") await onRevise(nodeId, { ...input, instruction: command.instruction ?? "" });
    else await onAudit(nodeId, input);
    if (currentScope.current !== scope) return;
    // 无耐久查询入口的嵌入场景只结束本次回调，不据此声称当前稿已改或已审。
    if (!runId) { setUnsettled(undefined); return; }
    const saved = (await refreshCommands())?.find(row => row.commandId === command.commandId);
    if (saved && ["applied", "unchanged", "stale", "failed", "invalid"].includes(saved.state)) {
      forgetDocumentCommandPointer(storageKey, command.commandId);
    }
    return saved;
  }

  function toggleSuggestion(index: number) {
    setChecked((current) => current.includes(index)
      ? current.filter((candidate) => candidate !== index)
      : [...current, index]);
  }

  function appendSelected() {
    if (staleInstruction) return;
    const selected = checked.map((index) => contentReview.suggestions[index]).filter((value) => typeof value === "string" && value.trim());
    if (selected.length === 0) return;
    setInstruction((current) => current.trim() ? `${current}\n${selected.join("\n")}` : selected.join("\n"));
    setInstructionTarget(targetContext.generation);
    setChecked([]);
    setInfo(undefined);
    setError(undefined);
  }

  async function sendRevision() {
    const trimmed = instruction.trim();
    if (!trimmed || overLimit || staleInstruction) return;
    setWorking(true);
    setError(undefined);
    setInfo(undefined);
    try {
      const command = rememberCommand("revise", trimmed);
      const sent = instructionOwnership.current;
      const saved = await runCommand(command);
      if (currentScope.current !== scope) return;
      if (saved && ["applied", "unchanged"].includes(saved.state)
        && instructionOwnership.current.value === sent.value && instructionOwnership.current.generation === sent.generation) {
        setInstruction("");
        setChecked([]);
      }
      setInfo(documentCommandResultMessage(saved));
    } catch (caught) {
      if (currentScope.current === scope) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (currentScope.current === scope) { setWorking(false); await refreshCommands(); }
    }
  }

  async function auditCurrent() {
    setWorking(true);
    setError(undefined);
    setInfo(undefined);
    try {
      const saved = await runCommand(rememberCommand("audit"));
      if (currentScope.current !== scope) return;
      setInfo(documentCommandResultMessage(saved));
    } catch (caught) {
      if (currentScope.current === scope) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (currentScope.current === scope) { setWorking(false); await refreshCommands(); }
    }
  }

  async function recover() {
    if (!unsettled || busy || working) return;
    setWorking(true); setError(undefined); setInfo(undefined);
    try {
      const saved = await runCommand(unsettled);
      if (currentScope.current === scope) setInfo(documentCommandResultMessage(saved));
    } catch (caught) { if (currentScope.current === scope) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (currentScope.current === scope) { setWorking(false); await refreshCommands(); } }
  }

  return <section className="node-document-commands" aria-label={nodeId === "reference-grammar" ? "参考报告修订与审计" : "发布文案修订与审计"}>
    {lookupFailed ? <div role="alert"><p>暂时无法核对原文字操作，先不要重复发送。你的修改意见仍保留。</p>
      <button type="button" className="button button-ghost" disabled={working || busy} onClick={() => void refreshCommands()}>重新读取操作记录</button></div> : null}
    {localPointerFailed && !lookupFailed ? <div role="alert"><p>本机操作编号暂时无法读取。可以恢复下方服务端已确认的原操作；核清前不要发起新调用。</p>
      <button type="button" className="button button-ghost" disabled={working || busy} onClick={() => void refreshCommands()}>重新核对操作编号</button></div> : null}
    {visibleCommands.length > 0 ? <div className="node-document-command-records" aria-label="文字操作记录">
      {visibleCommands.map(command => <article key={command.commandId} className="node-document-command-record">
        <strong>{command.action === "audit" ? "文字审计" : "稿件修订"} · {command.state === "failed" && command.failureStage === "not_accepted" ? "未受理" : documentCommandStateLabel(command.state)}</strong>
        {command.instruction ? <p className="node-document-original">{command.instruction}</p> : null}
        {command.error ? <p>{creatorFacingTechnicalText(command.error)}</p> : null}
        {command.billingPending ? <p>这次调用的费用仍待核，不表示免费。</p> : null}
        {command.state === "failed" || command.state === "invalid" ? <p>当前稿仍保留。可先处理原稿，或补充意见后主动发起新的模型调用；不会自动重发。</p> : null}
      </article>)}
    </div> : null}
    {unsettled ? <div role="status"><p>{unsettled.state === "completed"
      ? "结果已经生成，等待写入当前稿件；恢复写入不会再次调用模型。"
      : "上一条文字操作尚未结清；先取回原结果，不要重新发起。"}</p>
      <button type="button" className="button" disabled={busy || working || lookupFailed} onClick={() => void recover()}>取回原操作结果</button></div> : null}
    {commands[0]?.state === "stale" ? <p role="status">上一条结果对应旧稿，已保留但未覆盖当前稿。请核对新稿后再发起修改。</p> : null}
    {commands[0]?.state === "unchanged" ? <p role="status">上次模型返回的内容与原稿相同，没有新建版本；本次调用仍记录在费用明细中。</p> : null}
    <details className="node-document-revision" open={revisionOpen} onToggle={event => setRevisionOpen(event.currentTarget.open)}>
      <summary>继续修改（会形成新版本）</summary>
    {contentReview.suggestions.length > 0 ? <div className="node-document-suggestions">
      <p>本版建议（勾选后点「加入修改意见」，只追加、不自动发送）：</p>
      {contentReview.suggestions.map((suggestion, index) => (
        <label key={`${index}:${suggestion.slice(0, 24)}`}>
          <input
            type="checkbox"
            checked={checked.includes(index)}
            onChange={() => toggleSuggestion(index)}
            disabled={pending}
          />{" "}
          {suggestion}
        </label>
      ))}
      <button
        className="button button-ghost"
        type="button"
        onClick={appendSelected}
        disabled={pending || checked.length === 0 || staleInstruction}
      >加入修改意见（{checked.length}）</button>
    </div> : null}
    <label className="field node-document-instruction">
      <span>修订意见</span>
      <textarea
        aria-label="修订意见"
        value={instruction}
        rows={3}
        onChange={(event) => {
          if (!instruction) setInstructionTarget(targetContext.generation);
          setInstruction(event.target.value); setInfo(undefined); setError(undefined);
        }}
        disabled={pending}
        placeholder="写下这份内容要怎么改；最终只以这里的文字为准。"
      />
    </label>
    <div className="node-document-actions">
      <button
        className="button"
        type="button"
        onClick={() => void sendRevision()}
        disabled={pending || !instruction.trim() || overLimit || staleInstruction}
      >发送修订意见</button>
      <span className="node-document-charcount">{[...instruction].length}/{MAX_INSTRUCTION_CHARS}</span>
    </div>
    {staleInstruction ? <div role="alert">
      <p>当前稿件已经更新，下面保留的是你对旧稿尚未发送的意见。请核对后再决定是否用于当前稿。</p>
      <button type="button" className="button button-ghost" disabled={pending} onClick={() => setInstructionTarget(targetContext.generation)}>将这些意见用于当前稿</button>
    </div> : null}
    {overLimit ? <p role="alert">修订意见超过 {MAX_INSTRUCTION_CHARS} 字，请删减后再发送；原文完整保留，不会被截断。</p> : null}
    </details>
    <button className="button button-ghost" type="button" onClick={() => void auditCurrent()} disabled={pending}>{auditLabel}</button>
    {error ? <p role="alert">{error}</p> : null}
    {info ? <p>{info}</p> : null}
  </section>;
}

function documentCommandStateLabel(state: StudioDocumentCommand["state"]): string {
  return ({ created: "操作已登记 · 受理情况待核", pending: "已提交 · 结果待核", completed: "结果已生成 · 等待写入",
    applied: "已完成", failed: "执行失败 · 已核清", invalid: "返回内容不可用 · 已核清",
    stale: "旧版结果已归档", unchanged: "已完成 · 稿件未改动" })[state];
}

function documentCommandResultMessage(command: StudioDocumentCommand | undefined): string | undefined {
  if (command?.state === "applied") return command.action === "audit"
    ? "原审计结果已记录，请核对它对应的版本；是否采用仍由你决定。"
    : "原修订结果已记录，请核对当前正文；是否采用仍由你决定。";
  if (command?.state === "unchanged") return "原修订结果与原稿相同，没有新建版本。";
  if (command?.state === "stale") return "原操作结果已归档，没有覆盖当前稿。";
  if (command?.state === "completed") return "原操作结果已生成，仍待写入；请取回原操作结果。";
  return undefined;
}

function readDocumentCommandPointer(storageKey: string | undefined): StudioDocumentCommand | undefined {
  const raw = storageKey ? localStorage.getItem(storageKey) : null;
  if (raw === null) return undefined;
  const value = JSON.parse(raw) as Partial<StudioDocumentCommand> | null;
  if (!value || typeof value !== "object" || typeof value.commandId !== "string" || !value.commandId
    || !["revise", "audit"].includes(String(value.action))
    || !Number.isSafeInteger(value.expectedRunRevision) || Number(value.expectedRunRevision) < 0
    || typeof value.expectedVersionId !== "string" || !value.expectedVersionId
    || !["created", "pending", "completed", "applied", "failed", "stale", "unchanged", "invalid"].includes(String(value.state))
    || (value.action === "revise" && typeof value.instruction !== "string")) throw new Error("Local command identity is unreadable.");
  return value as StudioDocumentCommand;
}

function forgetDocumentCommandPointer(storageKey: string | undefined, commandId: string): void {
  if (!storageKey) return;
  try {
    if (readDocumentCommandPointer(storageKey)?.commandId === commandId) localStorage.removeItem(storageKey);
  } catch { /* 已核对的服务端记录仍是权威，不删除身份不明或另一条操作的本地编号。 */ }
}
