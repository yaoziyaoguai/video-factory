import { AlertCircle, Braces, Check, PenLine, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { parseStudioOpportunityInput, type StudioOpportunityInput } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

interface OpportunityDialogProps {
  open: boolean;
  initialMode?: "manual" | "json";
  onClose: () => void;
  onSubmit: (input: StudioOpportunityInput) => Promise<void>;
}

const SCORE_FIELDS = [
  ["audienceReach", "人群覆盖", 70],
  ["visualFeasibility", "视觉可行", 70],
  ["productionCostEfficiency", "成本效率", 70],
  ["novelty", "内容新鲜", 60],
  ["monetization", "商业潜力", 50],
  ["seriesPotential", "系列潜力", 70],
  ["complianceRisk", "合规风险", 20],
] as const;

export function OpportunityDialog({ open, initialMode = "manual", onClose, onSubmit }: OpportunityDialogProps) {
  const [mode, setMode] = useState<"manual" | "json">(initialMode);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError(undefined);
    }
  }, [initialMode, open]);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, submitting, mode);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const data = new FormData(event.currentTarget);
      const input = parseStudioOpportunityInput(mode === "json" ? parseJsonInput(data) : formInput(data));
      await onSubmit(input);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section ref={dialogRef} className="run-dialog opportunity-dialog" role="dialog" aria-modal="true" aria-labelledby="opportunity-dialog-title" tabIndex={-1}>
        <header className="dialog-header">
          <div>
            <p className="eyebrow">选题草稿</p>
            <h2 id="opportunity-dialog-title">录入机会</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} title="关闭"><X aria-hidden="true" size={19} /></button>
        </header>
        <div className="dialog-mode-tabs" role="tablist" aria-label="录入方式">
          <button type="button" role="tab" aria-selected={mode === "manual"} onClick={() => setMode("manual")}><PenLine aria-hidden="true" size={15} />手动录入</button>
          <button type="button" role="tab" aria-selected={mode === "json"} onClick={() => setMode("json")}><Braces aria-hidden="true" size={15} />JSON 导入</button>
        </div>
        <form className="run-form opportunity-form" onSubmit={submit}>
          {mode === "manual" ? <ManualFields /> : (
            <label className="field field-wide json-field">
              <span>机会数据</span>
              <textarea name="json" required data-dialog-initial-focus rows={18} spellCheck={false} placeholder={'{"title":"...","evidence":[...],"scores":{...}}'} />
              <small>字段结构与 Studio Opportunity API 一致，提交后仍由服务端校验。</small>
            </label>
          )}
          {error ? <p className="form-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          <footer className="dialog-actions">
            <button className="button button-ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="submit" disabled={submitting}><Check aria-hidden="true" size={17} />{submitting ? "正在保存..." : "保存机会"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function ManualFields() {
  return (
    <>
      <div className="form-section">
        <div className="form-section-heading"><h3>快速录入</h3><span>完成 5 项基础信息即可开始</span></div>
        <label className="field field-wide"><span>选题标题</span><input name="title" required data-dialog-initial-focus placeholder="一个具体、可验证的内容命题" /></label>
        <label className="field"><span>目标平台</span><select name="platform" defaultValue="douyin"><option value="douyin">抖音</option><option value="xiaohongshu">小红书</option><option value="bilibili">哔哩哔哩</option></select></label>
        <label className="field"><span>目标受众</span><input name="audience" required placeholder="这条内容为谁解决问题" /></label>
        <label className="field"><span>核心痛点</span><input name="painPoint" required placeholder="一个明确而具体的困扰" /></label>
        <label className="field field-wide"><span>开场钩子</span><textarea name="hook" required rows={3} placeholder="前 3 秒要说出的关键一句" /></label>
      </div>
      <details className="opportunity-advanced">
        <summary>高级：系列、证据与评分</summary>
        <div className="opportunity-advanced-body">
          <div className="form-section">
            <div className="form-section-heading"><h3>证据信号</h3><span>有真实来源时再补充</span></div>
            <label className="field"><span>内容系列</span><input name="track" defaultValue="ordinary-life" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label>
            <label className="field"><span>来源名称</span><input name="evidenceSource" placeholder="manual-research" /></label>
            <label className="field"><span>来源平台</span><input name="evidencePlatform" defaultValue="douyin" /></label>
            <label className="field field-wide"><span>观察关键词</span><input name="evidenceKeyword" placeholder="不填时使用选题标题" /></label>
            <label className="field"><span>信号强度</span><input name="evidenceStrength" type="number" min="0" max="100" defaultValue="70" /></label>
            <label className="field"><span>证据链接</span><input name="evidenceUrl" type="url" placeholder="https://" /></label>
          </div>
          <div className="form-section">
            <div className="form-section-heading"><h3>人工评分</h3><span>0–100，合规风险分越低越好</span></div>
            <div className="score-fields">
              {SCORE_FIELDS.map(([name, label, defaultValue]) => (
                <label className="field" key={name}><span>{label}</span><input name={name} type="number" min="0" max="100" defaultValue={defaultValue} /></label>
              ))}
            </div>
          </div>
        </div>
      </details>
    </>
  );
}

function formInput(data: FormData): StudioOpportunityInput {
  const title = required(data, "title");
  const platform = required(data, "platform");
  const evidenceUrl = optional(data, "evidenceUrl");
  return {
    title,
    platform,
    track: optional(data, "track") ?? "ordinary-life",
    audience: required(data, "audience"),
    painPoint: required(data, "painPoint"),
    hook: required(data, "hook"),
    evidence: [{
      source: optional(data, "evidenceSource") ?? "manual-research",
      platform: optional(data, "evidencePlatform") ?? platform,
      keyword: optional(data, "evidenceKeyword") ?? title,
      strength: numeric(data, "evidenceStrength", 70),
      ...(evidenceUrl ? { evidenceUrl } : {}),
      collectedAt: new Date().toISOString(),
    }],
    scores: Object.fromEntries(SCORE_FIELDS.map(([name, , defaultValue]) => [name, numeric(data, name, defaultValue)])) as StudioOpportunityInput["scores"],
  };
}

function parseJsonInput(data: FormData): StudioOpportunityInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(required(data, "json"));
  } catch (caught) {
    if (caught instanceof SyntaxError) throw new Error("JSON 格式不正确，请检查括号、逗号和引号。");
    throw caught;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JSON 顶层必须是对象。");
  return parsed as StudioOpportunityInput;
}

function required(data: FormData, key: string): string {
  const value = data.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${FIELD_LABELS[key] ?? "必填内容"}不能为空。`);
  return value.trim();
}

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  platform: "平台",
  audience: "目标受众",
  painPoint: "用户痛点",
  hook: "开场钩子",
  json: "机会数据",
};

function optional(data: FormData, key: string): string | undefined {
  const value = data.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numeric(data: FormData, key: string, fallback?: number): number {
  const value = optional(data, key);
  if (value === undefined && fallback !== undefined) return fallback;
  return Number(value ?? required(data, key));
}
