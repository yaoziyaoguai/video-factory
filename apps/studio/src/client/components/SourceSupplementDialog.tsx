import { ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

interface SourceSupplementDialogProps {
  open: boolean;
  title: string;
  currentSources: number;
  requiredSources: number;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (evidenceUrls: string[]) => Promise<void>;
}

// 新候选与历史机会共用的补充来源对话框：每行一个 URL；
// 保存只留档不探测远端，是否计入有效独立来源由服务端来源门槛重算。
export function SourceSupplementDialog({
  open,
  title,
  currentSources,
  requiredSources,
  pending,
  error,
  onClose,
  onSubmit,
}: SourceSupplementDialogProps) {
  const [value, setValue] = useState("");
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, pending, attempt);

  // 每次新打开时清空输入；提交失败保持打开，输入原样保留供修正后重试。
  useEffect(() => {
    if (open) {
      setValue("");
      setAttempt((current) => current + 1);
    }
  }, [open]);

  if (!open) return null;

  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const submit = async () => {
    try {
      await onSubmit(lines);
    } catch {
      // 失败信息由 error 属性展示；这里只保证对话框与输入保留。
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="verification-dialog source-supplement-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-supplement-title"
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div><p className="eyebrow">补充原始来源</p><h2 id="source-supplement-title">补齐可核验的原始来源</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={pending} title="关闭"><X aria-hidden="true" size={19} /></button>
        </header>
        <div className="verification-dialog-body">
          <div className="verification-intro"><ShieldAlert aria-hidden="true" size={21} /><div><strong>{title}</strong><span>当前 {currentSources}/{requiredSources} 个不同域名的有效原始来源。</span></div></div>
          <label className="source-supplement-field">
            <span>来源链接（每行一条，1–10 条）</span>
            <textarea
              data-dialog-initial-focus
              rows={5}
              value={value}
              disabled={pending}
              onChange={(event) => setValue(event.target.value)}
              placeholder={"https://example.com/article-a\nhttps://news.example.org/article-b"}
            />
          </label>
          <p className="source-supplement-hint">需要的是<b>不同域名的有效原始来源</b>，不是链接条数；搜索结果页可以保存留档，但不会被计入有效来源。补齐后系统会按最新来源重算开工门槛与制作建议，仍可能需要人工核验，或因内容质量暂不推荐。</p>
          {error ? <p className="source-supplement-error" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onClose} disabled={pending}>暂不补充</button>
          <button
            className="button button-primary"
            type="button"
            disabled={pending || lines.length === 0}
            onClick={() => void submit()}
          >{pending ? "正在保存..." : `保存来源（${lines.length} 条）`}</button>
        </footer>
      </section>
    </div>
  );
}
