import { useEffect, useState } from "react";
import { creatorContainerViewId, isCreatorNestedField, isCreatorTopLevelField } from "../creator-document-policy.js";
import { humanizeCreativeText, providerLabel } from "../presentation.js";

interface NodeStructuredEditorProps {
  nodeId: string;
  value: unknown;
  assetProviderIds?: string[];
  onChange: (value: unknown) => void;
}

const LABELS: Record<string, string> = {
  title: "标题",
  angle: "切入角度",
  audience: "目标观众",
  hook: "开场钩子",
  narration: "旁白",
  subtitle: "字幕",
  on_screen_text: "屏幕文字",
  visual_prompt: "画面提示",
  visual_description: "画面说明",
  search_terms: "检索词",
  duration: "时长",
  durationSeconds: "目标时长",
  duration_target: "目标时长",
  structure: "叙事结构",
  disclosure_required: "需要 AI 标识",
  platform_notes: "平台提示",
  platform: "发布平台",
  position: "镜头序号",
  quality_checks: "脚本自检",
  hashtags: "建议话题",
  query: "素材检索词",
  subject: "主体",
  generationPrompt: "生成提示",
  rationale: "选择理由",
  requestedProfileId: "指定风格",
  resolvedProfileId: "导演风格",
  profileRationale: "风格选择理由",
  continuityNote: "连续性",
  continuity: "连续性",
  narrativeApproach: "叙事方式",
  pacing: "节奏",
  composition: "构图",
  camera: "镜头运动",
  color: "色彩",
  sound: "声音",
  summary: "摘要",
  recommendation: "结论",
  confidence: "置信度（%）",
  message: "说明",
  severity: "严重程度",
  scenes: "分镜",
  shots: "镜头计划",
  findings: "审片问题",
  beats: "节拍",
  visualBible: "视觉圣经",
  scores: "评分",
  economics: "成本策略",
  director: "导演配置",
  voiceDirection: "声音配置",
  viewerPromise: "观众承诺",
  narrativeArc: "叙事弧线",
  visible_action: "可见动作",
  sound_cue: "声音提示",
  success_criteria: "成功条件",
  failure_conditions: "失败条件",
  narrativeFunction: "叙事功能",
  narrativeRole: "镜头任务",
  authenticityPolicy: "真实度要求",
  scenePosition: "镜头序号",
  scene_position: "镜头序号",
  preferredProviderId: "首选画面能力",
  shotSize: "景别",
  cameraMovement: "镜头运动",
  subjectMovement: "主体运动",
  lighting: "光线",
  transitionIn: "入场转场",
  soundRole: "声音作用",
  reusableRules: "可复用规则",
  avoidCopying: "禁止复制",
  candidates: "候选素材",
  intent: "镜头意图",
  semanticScore: "语义匹配分",
  originalRank: "原始名次",
  rank: "当前名次",
  locked: "人工锁定",
  direction: "表演指示",
  voice: "声音演员",
  rate: "语速（字/分钟）",
  pause_scale: "停顿强度",
  mastering_preset: "声音质感",
  description: "问题说明",
  suggestion: "修改建议",
  category: "问题类型",
  legibility: "文字可读性",
  safety: "内容安全",
  visual_strategy: "画面来源",
};

const ENUM_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  visual_strategy: [
    { value: "stock", label: "实拍视频素材" },
    { value: "image", label: "图片素材" },
    { value: "generated", label: "AI 生成画面" },
    { value: "local", label: "本地编辑画面" },
  ],
  authenticityPolicy: [
    { value: "evidence", label: "事实镜头" },
    { value: "illustrative", label: "说明镜头" },
    { value: "expressive", label: "表现镜头" },
  ],
  recommendation: [
    { value: "approve", label: "通过" },
    { value: "revise", label: "修改后再审" },
    { value: "reject", label: "不通过" },
  ],
  severity: [
    { value: "info", label: "提示" },
    { value: "low", label: "轻微" },
    { value: "medium", label: "需关注" },
    { value: "warning", label: "需修改" },
    { value: "high", label: "高风险" },
    { value: "critical", label: "严重" },
  ],
  category: [
    { value: "pacing", label: "节奏" },
    { value: "composition", label: "构图" },
    { value: "continuity", label: "连续性" },
    { value: "legibility", label: "文字可读性" },
    { value: "safety", label: "内容安全" },
    { value: "other", label: "其他" },
  ],
  mastering_preset: [
    { value: "natural", label: "自然" },
    { value: "intimate", label: "亲近" },
    { value: "social", label: "社交清晰" },
  ],
  platform: [
    { value: "douyin", label: "抖音" },
    { value: "xiaohongshu", label: "小红书" },
    { value: "bilibili", label: "哔哩哔哩" },
  ],
  requestedProfileId: directorOptions(true),
  resolvedProfileId: directorOptions(false),
};

export function NodeStructuredEditor({ nodeId, value, assetProviderIds = [], onChange }: NodeStructuredEditorProps) {
  const record = asRecord(value);
  if (!record) return <p className="node-document-state">这个交付没有适合手工修改的内容。</p>;
  const entries = Object.entries(record).filter(([key, fieldValue]) => hasEditableValue(fieldValue) && isCreatorTopLevelField(nodeId, key, fieldValue));
  if (!entries.length) return <p className="node-document-state">这个交付只有系统记录，不需要手工修改。</p>;
  return <div className="node-structured-editor" data-node-editor={nodeId}>
    {entries.map(([key, fieldValue]) => <StructuredField
      key={key}
      fieldKey={key}
      nodeId={nodeId}
      value={fieldValue}
      assetProviderIds={assetProviderIds}
      path={[key]}
      depth={0}
      onChange={(path, next) => onChange(updateAtPath(record, path, next))}
    />)}
  </div>;
}

function StructuredField({ nodeId, fieldKey, value, assetProviderIds, path, depth, onChange }: {
  nodeId: string;
  fieldKey: string;
  value: unknown;
  assetProviderIds: string[];
  path: Array<string | number>;
  depth: number;
  onChange: (path: Array<string | number>, value: unknown) => void;
}) {
  if (depth > 0 && !isCreatorNestedField(fieldKey)) return null;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return <label className="node-editor-field node-editor-field-wide"><span>{label(fieldKey)}<small>每行一项</small></span><textarea rows={Math.min(6, Math.max(2, value.length))} value={value.join("\n")} onChange={(event) => onChange(path, event.target.value.split("\n"))} /></label>;
    }
    if (value.every(isScalar)) {
      return <section className="node-editor-collection node-editor-scalar-list"><header><strong>{label(fieldKey)}</strong><span>{value.length} 项</span></header><div>{value.map((item, index) => <ScalarEditor key={index} value={item} onChange={(next) => onChange([...path, index], next)} />)}</div></section>;
    }
    const visibleItems = value.map((item, index) => {
      const child = asRecord(item);
      if (!child) return hasEditableValue(item) ? { index, item, fields: [] as Array<[string, unknown]> } : undefined;
      const fields = Object.entries(child).filter(([childKey, childValue]) => hasEditableValue(childValue) && isCreatorNestedField(childKey));
      return fields.length ? { index, item, fields } : undefined;
    }).filter((item): item is { index: number; item: unknown; fields: Array<[string, unknown]> } => item !== undefined);
    if (!visibleItems.length) return null;
    return <section className="node-editor-collection"><header><strong>{label(fieldKey)}</strong><span>{visibleItems.length} 项</span></header>{visibleItems.map(({ index, item, fields }, visibleIndex) => {
      if (!fields.length) return <p key={index}>{String(item)}</p>;
      if (fieldKey === "findings") return <details className="node-editor-finding" key={index} name="node-editor-findings" open={visibleIndex === 0}>
        <summary><span className="node-editor-index">{String(index + 1).padStart(2, "0")}</span><span><strong>{findingTitle(item, index)}</strong><small>{findingSummary(item)}</small></span></summary>
        <div>{fields.map(([childKey, childValue]) => <StructuredField key={childKey} nodeId={nodeId} fieldKey={childKey} value={childValue} assetProviderIds={assetProviderIds} path={[...path, index, childKey]} depth={depth + 1} onChange={onChange} />)}</div>
      </details>;
      return <article key={index}><span className="node-editor-index">{String(index + 1).padStart(2, "0")}</span><div>{fields.map(([childKey, childValue]) => <StructuredField key={childKey} nodeId={nodeId} fieldKey={childKey} value={childValue} assetProviderIds={assetProviderIds} path={[...path, index, childKey]} depth={depth + 1} onChange={onChange} />)}</div></article>;
    })}</section>;
  }
  const nested = asRecord(value);
  if (nested) {
    if (depth >= 5) return null;
    const nestedViewId = creatorContainerViewId(fieldKey);
    const fields = Object.entries(nested).filter(([childKey, childValue]) => hasEditableValue(childValue) && (
      nestedViewId ? isCreatorTopLevelField(nestedViewId, childKey, childValue) : isCreatorNestedField(childKey)
    ));
    if (!fields.length) return null;
    return <section className="node-editor-group"><header><strong>{label(fieldKey)}</strong></header><div>{fields.map(([childKey, childValue]) => <StructuredField key={childKey} nodeId={nodeId} fieldKey={childKey} value={childValue} assetProviderIds={assetProviderIds} path={[...path, childKey]} depth={depth + 1} onChange={onChange} />)}</div></section>;
  }
  if (typeof value === "boolean") {
    return <label className="node-editor-toggle"><input type="checkbox" checked={value} onChange={(event) => onChange(path, event.target.checked)} /><span>{label(fieldKey)}<small>{value ? "是" : "否"}</small></span></label>;
  }
  const stringValue = typeof value === "string" ? value : undefined;
  const options = stringValue === undefined
    ? undefined
    : fieldKey === "preferredProviderId"
      ? assetProviderOptions(assetProviderIds, stringValue)
      : ENUM_OPTIONS[fieldKey];
  if (options && stringValue !== undefined) {
    const choices = options.some((option) => option.value === stringValue)
      ? options
      : [{ value: stringValue, label: fieldKey === "preferredProviderId" ? providerLabel(stringValue) ?? stringValue : stringValue }, ...options];
    return <label className="node-editor-field"><span>{label(fieldKey)}</span><select value={stringValue} onChange={(event) => onChange(path, event.target.value)}>{choices.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
  }
  const multiline = typeof value === "string" && (value.length > 72 || /(prompt|narration|summary|description|rationale|note|hook|angle)/i.test(fieldKey));
  return <label className={multiline ? "node-editor-field node-editor-field-wide" : "node-editor-field"}><span>{label(fieldKey)}</span>{multiline
    ? <textarea rows={3} value={formatEditableScalar(value)} onChange={(event) => onChange(path, event.target.value)} />
    : typeof value === "number"
      ? fieldKey === "confidence" && value >= 0 && value <= 1
        ? <PercentageEditor value={value} onChange={(next) => onChange(path, next)} />
        : <NumberEditor value={value} onChange={(next) => onChange(path, next)} />
      : <input type="text" value={formatEditableScalar(value)} onChange={(event) => onChange(path, event.target.value)} />}</label>;
}

function ScalarEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  if (typeof value === "boolean") return <label className="node-editor-toggle"><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><span>{value ? "是" : "否"}</span></label>;
  if (typeof value === "number") return <NumberEditor value={value} onChange={onChange} />;
  return <input type="text" value={formatEditableScalar(value)} onChange={(event) => onChange(event.target.value)} />;
}

function NumberEditor({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) onChange(parsed);
    else setDraft(String(value));
  };
  return <input
    type="number"
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
  />;
}

function PercentageEditor({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const displayValue = Math.round(value * 100);
  const [draft, setDraft] = useState(String(displayValue));
  useEffect(() => setDraft(String(displayValue)), [displayValue]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) onChange(parsed / 100);
    else setDraft(String(displayValue));
  };
  return <input
    type="number"
    min={0}
    max={100}
    step={1}
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
  />;
}

function updateAtPath(source: Record<string, unknown>, path: Array<string | number>, next: unknown): Record<string, unknown> {
  const clone = structuredClone(source);
  let cursor: Record<string | number, unknown> | unknown[] = clone;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = (cursor as Record<string | number, Record<string | number, unknown> | unknown[]>)[path[index]!]!;
  }
  (cursor as Record<string | number, unknown>)[path[path.length - 1]!] = next;
  return clone;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function formatEditableScalar(value: unknown): string {
  return value === null || value === undefined ? "" : humanizeCreativeText(String(value));
}

function hasEditableValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some(hasEditableValue);
  const record = asRecord(value);
  return record ? Object.values(record).some(hasEditableValue) : true;
}

function findingTitle(value: unknown, index: number): string {
  const record = asRecord(value);
  if (!record) return `问题 ${index + 1}`;
  const parts: string[] = [];
  if (typeof record.timecodeMs === "number") parts.push(formatTimecode(record.timecodeMs));
  if (typeof record.category === "string") parts.push(enumLabel("category", record.category));
  if (typeof record.severity === "string") parts.push(enumLabel("severity", record.severity));
  return parts.join(" · ") || `问题 ${index + 1}`;
}

function findingSummary(value: unknown): string {
  const record = asRecord(value);
  const summary = typeof record?.description === "string" ? record.description : typeof record?.suggestion === "string" ? record.suggestion : "点开查看和修改";
  return summary.length > 56 ? `${summary.slice(0, 56)}…` : summary;
}

function enumLabel(fieldKey: string, value: string): string {
  return ENUM_OPTIONS[fieldKey]?.find((option) => option.value === value)?.label ?? value;
}

function formatTimecode(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function label(key: string): string {
  return LABELS[key] ?? key.replace(/[_-]+/g, " ");
}

function directorOptions(includeAuto: boolean): Array<{ value: string; label: string }> {
  return [
    ...(includeAuto ? [{ value: "auto", label: "自动匹配" }] : []),
    { value: "documentary-observer", label: "纪实观察" },
    { value: "quiet-humanism", label: "静默人文" },
    { value: "urban-poetic", label: "都市诗意" },
    { value: "chromatic-storytelling", label: "色彩叙事" },
    { value: "geometric-control", label: "几何秩序" },
    { value: "suspense-staging", label: "悬念调度" },
  ];
}

function assetProviderOptions(configuredIds: string[], currentId: string): Array<{ value: string; label: string }> {
  return [...new Set([currentId, ...configuredIds])]
    .map((value) => ({ value, label: providerLabel(value) ?? value }));
}
