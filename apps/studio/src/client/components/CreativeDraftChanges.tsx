import { useMemo, useState } from "react";
import type { StudioCreativeReviewSnapshot } from "../../shared/api.js";
import { CreativeDraft } from "./CreativeDraftReader.js";

type Stage = StudioCreativeReviewSnapshot["stage"];
type Document = Record<string, unknown>;
type FieldChange = { field: string; before: unknown; after: unknown };
type SegmentChange = { id: string; label: string; kind: "added" | "removed" | "changed"; fields: FieldChange[] };

const FIELD_LABELS: Record<string, string> = {
  narration: "旁白", visual_prompt: "画面描述", duration: "时长（秒）", position: "段落顺序",
  purpose: "段落目的", viewerGain: "观众收获", visualIntent: "画面意图", narrationIntent: "旁白意图",
  narrativeArc: "叙事推进", viewerPromise: "观众看完能得到什么", hook: "开头", payoff: "结尾兑现",
  visualPrinciples: "视觉方向", soundPrinciples: "声音方向", dialogue: "角色台词", characters: "角色设定",
  character_ids: "出场人物", visible_action: "可见动作", screen_text: "屏幕文字", sound_cue: "声音意图",
  scene_goal: "镜头目的", emotion: "情绪", evidence: "依据", evidencePlan: "素材安排", delivery: "表演提示",
};

/** 只比较服务端给出的当前稿与上一稿；没有稳定身份时不按序号猜跨版本对应。 */
export function CreativeDraftChanges({ stage, current, previous, nativeAudio = false }: {
  stage: Stage; current: unknown; previous: unknown; nativeAudio?: boolean;
}) {
  const comparison = useMemo(() => compareDrafts(stage, previous, current), [stage, previous, current]);
  const [showWhole, setShowWhole] = useState(false);
  const parts = comparison.mapped ? [
    comparison.changes.filter(change => change.kind === "changed").length ? `修改 ${comparison.changes.filter(change => change.kind === "changed").length} 项` : "",
    comparison.changes.filter(change => change.kind === "added").length ? `新增 ${comparison.changes.filter(change => change.kind === "added").length} 项` : "",
    comparison.changes.filter(change => change.kind === "removed").length ? `移除 ${comparison.changes.filter(change => change.kind === "removed").length} 项` : "",
    comparison.global.length ? `整体要求变化 ${comparison.global.length} 项` : "",
    comparison.reordered ? "排列顺序变化" : "",
  ].filter(Boolean) : [];
  return <section className="creative-draft-changes" aria-label="与上一版的实际变化">
    <strong>与上一版的实际变化</strong>
    <p>{comparison.mapped ? parts.join(" · ") || "当前稿与上一版内容相同" : "缺少可核对的段落身份，无法可靠逐项对应；请对比前后整篇。"}</p>
    {comparison.mapped && parts.length > 0 ? <details className="creative-change-list"><summary>只看改动</summary>
      {comparison.reordered ? <p>段落排列顺序有变化；以下仍按稳定身份对应，不按位置配对。</p> : null}
      {comparison.global.length > 0 ? <section><h4>整体要求</h4><ChangedFields fields={comparison.global} /></section> : null}
      {comparison.changes.map(change => <section key={change.id}>
        <h4>{change.label} · {change.kind === "added" ? "新增" : change.kind === "removed" ? "移除" : "已修改"}</h4>
        <ChangedFields fields={change.fields} />
      </section>)}
      <p>这里只列文稿的实际差异，不代表已满足全部要求，也不沿用上一版的审计结论。</p>
    </details> : null}
    <details className="creative-whole-comparison" onToggle={event => setShowWhole(event.currentTarget.open)}>
      <summary>对比前后整篇</summary>
      {showWhole ? <div className="creative-comparison-columns">
        <section><h4>上一版</h4><CreativeDraft stage={stage} value={previous} nativeAudio={nativeAudio} /></section>
        <section><h4>当前稿</h4><CreativeDraft stage={stage} value={current} nativeAudio={nativeAudio} /></section>
      </div> : null}
    </details>
  </section>;
}

function ChangedFields({ fields }: { fields: FieldChange[] }) {
  return <dl className="creative-field-changes">{fields.map(change => <div key={change.field}>
    <dt>{FIELD_LABELS[change.field] ?? change.field}</dt>
    <dd><span>之前</span><pre>{fieldText(change.before)}</pre></dd>
    <dd><span>现在</span><pre>{fieldText(change.after)}</pre></dd>
  </div>)}</dl>;
}

function fieldText(value: unknown): string {
  if (value === undefined) return "未设置";
  if (value === "") return "（空文字）";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "未设置";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function changedFields(before: Document, after: Document, omit: string[] = []): FieldChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(field => !omit.includes(field) && canonical(before[field]) !== canonical(after[field]))
    .map(field => ({ field, before: before[field], after: after[field] }));
}

function compareDrafts(stage: Stage, before: unknown, after: unknown):
  | { mapped: false }
  | { mapped: true; changes: SegmentChange[]; global: FieldChange[]; reordered: boolean } {
  if (stage === "director" || !isRecord(before) || !isRecord(after)) return { mapped: false };
  const field = stage === "treatment" ? "progression" : "scenes";
  const idField = stage === "treatment" ? "beatId" : "id";
  const previous = indexedSegments(before[field], idField);
  const current = indexedSegments(after[field], idField);
  if (!previous || !current) return { mapped: false };
  const changes: SegmentChange[] = [];
  const ids = [...current.keys(), ...[...previous.keys()].filter(id => !current.has(id))];
  for (const id of ids) {
    const old = previous.get(id);
    const next = current.get(id);
    const item = next ?? old!;
    const source = next ? current : previous;
    const ordinal = [...source.keys()].indexOf(id) + 1;
    // 序号只用于显示；对应关系始终取双侧唯一的 id / beatId。
    const label = stage === "treatment" ? `内容推进 ${ordinal}` : `第 ${Number.isInteger(item.position) ? item.position : ordinal} 段`;
    const fields = changedFields(old ?? {}, next ?? {}, [idField]);
    if (!old || !next || fields.length > 0) changes.push({ id, label, kind: !old ? "added" : !next ? "removed" : "changed", fields });
  }
  const oldShared = [...previous.keys()].filter(id => current.has(id));
  const newShared = [...current.keys()].filter(id => previous.has(id));
  return { mapped: true, changes, global: changedFields(before, after, [field]), reordered: canonical(oldShared) !== canonical(newShared) };
}

function indexedSegments(value: unknown, idField: string): Map<string, Document> | undefined {
  if (!Array.isArray(value)) return undefined;
  const indexed = new Map<string, Document>();
  for (const item of value) {
    if (!isRecord(item) || typeof item[idField] !== "string" || !item[idField].trim() || indexed.has(item[idField])) return undefined;
    indexed.set(item[idField], item);
  }
  return indexed;
}

function isRecord(value: unknown): value is Document {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
