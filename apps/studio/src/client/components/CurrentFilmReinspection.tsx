import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { StudioVisualReinspectionInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

/** 再审是用户明确选择的新操作，不是恢复原请求；确认绑定打开时的版本与证据。 */
export function CurrentFilmReinspection({ input, busy, onConfirm }: {
  input: StudioVisualReinspectionInput;
  busy: boolean;
  onConfirm: (input: StudioVisualReinspectionInput) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<StudioVisualReinspectionInput>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => { if (!submitting) { setSnapshot(undefined); setError(undefined); } };
  const dialog = useDialogFocus<HTMLElement>(Boolean(snapshot), close, submitting);
  const changed = snapshot && (snapshot.expectedRunRevision !== input.expectedRunRevision
    || snapshot.reviewEvidenceId !== input.reviewEvidenceId);
  async function submit() {
    if (!snapshot || changed || submitting || busy) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onConfirm(snapshot);
      setSnapshot(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "未能开始本次审查，当前成片与原意见仍保留。");
    } finally { setSubmitting(false); }
  }
  return <>
    <button className="button button-secondary" type="button" disabled={busy || submitting}
      onClick={() => setSnapshot({ ...input })}>
      <RotateCcw aria-hidden="true" size={17} />重新审查当前成片
    </button>
    {snapshot ? <div className="dialog-backdrop" role="presentation">
      <section ref={dialog} className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="reinspection-title" tabIndex={-1}>
        <header className="dialog-header"><h2 id="reinspection-title">重新审查这一版成片？</h2></header>
        <div className="decision-dialog-copy"><div>
          <p>按当前配置重新检查画面和声音；不是只重听声音。未配置的审查不会假装已完成。</p>
          <p>这是新的模型调用，可能产生审查费用；不会重新购买画面、配音或重新渲染视频。</p>
          <p>新意见可能与上一轮不同，旧意见仍可回看。审查完成后仍由你决定是否修改或继续，不会自动改片。</p>
          {changed ? <p role="alert">当前版本已变化，请关闭后查看最新成片，再决定是否审查。</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </div></div>
        <footer className="dialog-actions">
          <button className="button button-secondary" type="button" disabled={submitting} onClick={close}>先不审查</button>
          <button className="button button-primary" type="button" disabled={busy || submitting || Boolean(changed)} onClick={() => void submit()}>
            {submitting ? "正在提交审查…" : "确认重新审查"}
          </button>
        </footer>
      </section>
    </div> : null}
  </>;
}
