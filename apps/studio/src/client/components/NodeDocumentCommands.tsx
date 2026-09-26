import { useState } from "react";

const MAX_INSTRUCTION_CHARS = 4_000;

export interface NodeDocumentCommandsProps {
  nodeId: string;
  runRevision: number;
  effectiveVersionId: string;
  contentReview: { status: string; summary: string; suggestions: string[] };
  busy: boolean;
  onRevise: (nodeId: string, input: { instruction: string; expectedRunRevision: number; expectedVersionId: string; confirmTerminalEdit?: boolean }) => Promise<void>;
  onAudit: (nodeId: string, input: { expectedRunRevision: number; expectedVersionId: string }) => Promise<void>;
}

/**
 * 发布文案的 AI 修订与主动再审控件（合同 S4/S5）：
 * 建议仅追加进修订意见，不覆盖、不自动发送；最终修订要求以编辑框文本为准。
 */
export function NodeDocumentCommands({ nodeId, runRevision, effectiveVersionId, contentReview, busy, onRevise, onAudit }: NodeDocumentCommandsProps) {
  const [instruction, setInstruction] = useState("");
  const [checked, setChecked] = useState<number[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const overLimit = [...instruction].length > MAX_INSTRUCTION_CHARS;
  const pending = busy || working;

  function toggleSuggestion(index: number) {
    setChecked((current) => current.includes(index)
      ? current.filter((candidate) => candidate !== index)
      : [...current, index]);
  }

  function appendSelected() {
    const selected = checked.map((index) => contentReview.suggestions[index]).filter((value) => typeof value === "string" && value.trim());
    if (selected.length === 0) return;
    setInstruction((current) => current.trim() ? `${current}\n${selected.join("\n")}` : selected.join("\n"));
    setChecked([]);
    setInfo(undefined);
    setError(undefined);
  }

  async function sendRevision() {
    const trimmed = instruction.trim();
    if (!trimmed || overLimit) return;
    setWorking(true);
    setError(undefined);
    setInfo(undefined);
    try {
      await onRevise(nodeId, { instruction: trimmed, expectedRunRevision: runRevision, expectedVersionId: effectiveVersionId });
      setInstruction("");
      setChecked([]);
      setInfo("已提交修订：新稿是未审版本，请核对后再采用，或点「审计当前版本」。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  async function auditCurrent() {
    setWorking(true);
    setError(undefined);
    setInfo(undefined);
    try {
      await onAudit(nodeId, { expectedRunRevision: runRevision, expectedVersionId: effectiveVersionId });
      setInfo("已记录本版审计结论；稿件不变，是否采用仍由你决定。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  return <section className="node-document-commands" aria-label="发布文案修订与审计">
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
        disabled={pending || checked.length === 0}
      >加入修改意见（{checked.length}）</button>
    </div> : null}
    <label className="node-document-instruction">
      <span>修订意见</span>
      <textarea
        aria-label="修订意见"
        value={instruction}
        rows={3}
        onChange={(event) => { setInstruction(event.target.value); setInfo(undefined); setError(undefined); }}
        disabled={pending}
        placeholder="写下这条发布文案要怎么改；最终只以这里的文字为准。"
      />
    </label>
    <div className="node-document-actions">
      <button
        className="button"
        type="button"
        onClick={() => void sendRevision()}
        disabled={pending || !instruction.trim() || overLimit}
      >发送修订意见</button>
      <button
        className="button button-ghost"
        type="button"
        onClick={() => void auditCurrent()}
        disabled={pending}
      >审计当前版本</button>
      <span className="node-document-charcount">{[...instruction].length}/{MAX_INSTRUCTION_CHARS}</span>
    </div>
    {overLimit ? <p role="alert">修订意见超过 {MAX_INSTRUCTION_CHARS} 字，请删减后再发送；原文完整保留，不会被截断。</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {info ? <p>{info}</p> : null}
  </section>;
}
