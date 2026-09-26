import { useEffect, useRef, useState } from "react";
import { studioApi } from "../api.js";
import type { StudioDocumentCommand, StudioNodeDocumentRevisionInput, StudioNodeDocumentAuditInput } from "../../shared/api.js";

const MAX_INSTRUCTION_CHARS = 4_000;

export interface NodeDocumentCommandsProps {
  runId?: string;
  nodeId: string;
  runRevision: number;
  effectiveVersionId: string;
  contentReview: { status: string; summary: string; suggestions: string[]; auditId?: string };
  busy: boolean;
  onRevise: (nodeId: string, input: StudioNodeDocumentRevisionInput) => Promise<void>;
  onAudit: (nodeId: string, input: StudioNodeDocumentAuditInput) => Promise<void>;
}

/**
 * 文字交付的 AI 修订与主动再审控件（合同 S4/S5）：
 * 建议仅追加进修订意见，不覆盖、不自动发送；最终修订要求以编辑框文本为准。
 */
export function NodeDocumentCommands({ runId, nodeId, runRevision, effectiveVersionId, contentReview, busy, onRevise, onAudit }: NodeDocumentCommandsProps) {
  const [instruction, setInstruction] = useState("");
  const [checked, setChecked] = useState<number[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [commands, setCommands] = useState<StudioDocumentCommand[]>([]);
  const [unsettled, setUnsettled] = useState<StudioDocumentCommand>();
  const [lookupFailed, setLookupFailed] = useState(false);
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
      const raw = storageKey ? localStorage.getItem(storageKey) : null;
      const local = raw ? JSON.parse(raw) as StudioDocumentCommand : undefined;
      const stored = local && rows.find((row) => row.commandId === local.commandId);
      // 服务端尚未见过的本地动作沿用原编号；不能根据空列表生成另一个请求。
      setUnsettled(active ?? (local && !stored ? local : undefined));
      if (stored && !active && storageKey) { try { localStorage.removeItem(storageKey); } catch { /* 以服务端完成记录为准。 */ } }
    } catch {
      if (currentScope.current === scope && sequence === lookupSequence.current) setLookupFailed(true);
    } finally { if (currentScope.current === scope && sequence === lookupSequence.current) setLoadingCommands(false); }
  }
  useEffect(() => { setCommands([]); setUnsettled(undefined); setLookupFailed(false); setWorking(false); setError(undefined); setInfo(undefined); }, [runId, nodeId]);
  useEffect(() => { setLoadingCommands(Boolean(runId)); void refreshCommands(); }, [runId, nodeId, runRevision]);
  const target = `${scope}:${effectiveVersionId}`;
  const [instructionTarget, setInstructionTarget] = useState(target);
  const staleInstruction = instruction.length > 0 && instructionTarget !== target;
  const adviceIdentity = `${target}:${contentReview.auditId ?? JSON.stringify(contentReview)}`;
  useEffect(() => { setChecked([]); setInfo(undefined); }, [adviceIdentity]);
  const overLimit = [...instruction].length > MAX_INSTRUCTION_CHARS;
  const pending = busy || working || loadingCommands || lookupFailed || Boolean(unsettled);

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
    // 清理浏览器草稿失败不是模型执行失败，也不能让用户重新购买。
    if (storageKey) { try { localStorage.removeItem(storageKey); } catch { /* 服务端记录继续作为权威恢复依据。 */ } }
    if (currentScope.current === scope) setUnsettled(undefined);
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
    setInstructionTarget(target);
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
      await runCommand(command);
      if (currentScope.current !== scope) return;
      setInstruction("");
      setChecked([]);
      setInfo("已提交修订：新稿是未审版本，请核对后再采用，或点「审计当前版本」。");
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
      await runCommand(rememberCommand("audit"));
      if (currentScope.current !== scope) return;
      setInfo("已记录本版审计结论；稿件不变，是否采用仍由你决定。");
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
      await runCommand(unsettled);
      if (currentScope.current === scope) setInfo("原操作结果已取回；未自动推进制作，请核对当前稿件。");
    } catch (caught) { if (currentScope.current === scope) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (currentScope.current === scope) { setWorking(false); await refreshCommands(); } }
  }

  return <section className="node-document-commands" aria-label={nodeId === "reference-grammar" ? "参考报告修订与审计" : "发布文案修订与审计"}>
    {lookupFailed ? <div role="alert"><p>暂时无法核对原文字操作，先不要重复发送。你的修改意见仍保留。</p>
      <button type="button" className="button button-ghost" disabled={working || busy} onClick={() => void refreshCommands()}>重新读取操作记录</button></div> : null}
    {unsettled ? <div role="status"><p>{unsettled.state === "completed"
      ? "结果已经生成，等待写入当前稿件；恢复写入不会再次调用模型。"
      : "上一条文字操作尚未结清；先取回原结果，不要重新发起。"}</p>
      {unsettled.instruction ? <p>原修改意见：{unsettled.instruction}</p> : null}
      <button type="button" className="button" disabled={busy || working || lookupFailed} onClick={() => void recover()}>取回原操作结果</button></div> : null}
    {commands[0]?.state === "stale" ? <p role="status">上一条结果对应旧稿，已保留但未覆盖当前稿。请核对新稿后再发起修改。</p> : null}
    {commands[0]?.state === "unchanged" ? <p role="status">上次模型返回的内容与原稿相同，没有新建版本；本次调用仍记录在费用明细中。</p> : null}
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
    <label className="node-document-instruction">
      <span>修订意见</span>
      <textarea
        aria-label="修订意见"
        value={instruction}
        rows={3}
        onChange={(event) => {
          if (!instruction) setInstructionTarget(target);
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
      <button
        className="button button-ghost"
        type="button"
        onClick={() => void auditCurrent()}
        disabled={pending}
      >审计当前版本</button>
      <span className="node-document-charcount">{[...instruction].length}/{MAX_INSTRUCTION_CHARS}</span>
    </div>
    {staleInstruction ? <div role="alert">
      <p>当前稿件已经更新，下面保留的是你对旧稿尚未发送的意见。请核对后再决定是否用于当前稿。</p>
      <button type="button" className="button button-ghost" disabled={pending} onClick={() => setInstructionTarget(target)}>将这些意见用于当前稿</button>
    </div> : null}
    {overLimit ? <p role="alert">修订意见超过 {MAX_INSTRUCTION_CHARS} 字，请删减后再发送；原文完整保留，不会被截断。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {info ? <p>{info}</p> : null}
  </section>;
}
