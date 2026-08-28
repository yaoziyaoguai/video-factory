interface NodeStructuredEditorProps {
  nodeId: string;
  value: unknown;
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
  visual_strategy: "画面策略",
  search_terms: "检索词",
  duration: "时长",
  durationSeconds: "目标时长",
  query: "素材检索词",
  generationPrompt: "生成提示",
  rationale: "选择理由",
  continuityNote: "连续性",
  narrativeApproach: "叙事方式",
  pacing: "节奏",
  composition: "构图",
  camera: "镜头运动",
  color: "色彩",
  sound: "声音",
  summary: "摘要",
  recommendation: "结论",
  confidence: "置信度",
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
};

const LOCKED_FIELD = /(?:^|_)(?:id|path|url|sha256|version|provider)(?:_|$)|(?:Id|Path|Url|URL|Sha256|Version|Provider)$/;
const EXPLICIT_LOCKED_FIELDS = new Set(["originalRank", "semanticScore"]);

export function NodeStructuredEditor({ nodeId, value, onChange }: NodeStructuredEditorProps) {
  const record = asRecord(value);
  if (!record) return <p className="node-document-state">这个版本不是结构化对象，请切换到 JSON 专家编辑。</p>;
  const entries = Object.entries(record).filter(([, fieldValue]) => fieldValue !== undefined);
  return <div className="node-structured-editor" data-node-editor={nodeId}>
    {entries.map(([key, fieldValue]) => <StructuredField
      key={key}
      fieldKey={key}
      value={fieldValue}
      path={[key]}
      depth={0}
      onChange={(path, next) => onChange(updateAtPath(record, path, next))}
    />)}
  </div>;
}

function StructuredField({ fieldKey, value, path, depth, onChange }: {
  fieldKey: string;
  value: unknown;
  path: Array<string | number>;
  depth: number;
  onChange: (path: Array<string | number>, value: unknown) => void;
}) {
  const locked = LOCKED_FIELD.test(fieldKey) || EXPLICIT_LOCKED_FIELDS.has(fieldKey);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return <label className="node-editor-field node-editor-field-wide"><span>{label(fieldKey)}<small>{locked ? "执行字段，只读" : "每行一项"}</small></span><textarea rows={Math.min(6, Math.max(2, value.length))} readOnly={locked} value={value.join("\n")} onChange={(event) => onChange(path, event.target.value.split("\n"))} /></label>;
    }
    if (value.every(isScalar)) {
      return <label className="node-editor-field node-editor-field-wide"><span>{label(fieldKey)}<small>含数字或布尔值，请在 JSON 专家模式修改</small></span><textarea rows={Math.min(6, Math.max(2, value.length))} readOnly value={value.map(formatEditableScalar).join("\n")} /></label>;
    }
    return <section className="node-editor-collection"><header><strong>{label(fieldKey)}</strong><span>{value.length} 项</span></header>{value.map((item, index) => {
      const child = asRecord(item);
      if (!child) return <p key={index}>{String(item)}</p>;
      return <article key={index}><span className="node-editor-index">{String(index + 1).padStart(2, "0")}</span><div>{Object.entries(child).filter(([, childValue]) => childValue !== undefined).map(([childKey, childValue]) => <StructuredField key={childKey} fieldKey={childKey} value={childValue} path={[...path, index, childKey]} depth={depth + 1} onChange={onChange} />)}</div></article>;
    })}</section>;
  }
  const nested = asRecord(value);
  if (nested) {
    if (depth >= 5) return <label className="node-editor-field node-editor-field-wide"><span>{label(fieldKey)}<small>深层对象，请在 JSON 专家模式修改</small></span><textarea rows={4} readOnly value={JSON.stringify(nested, null, 2)} /></label>;
    return <section className="node-editor-group"><header><strong>{label(fieldKey)}</strong></header><div>{Object.entries(nested).filter(([, childValue]) => childValue !== undefined).map(([childKey, childValue]) => <StructuredField key={childKey} fieldKey={childKey} value={childValue} path={[...path, childKey]} depth={depth + 1} onChange={onChange} />)}</div></section>;
  }
  if (typeof value === "boolean") {
    return <label className="node-editor-toggle"><input type="checkbox" checked={value} disabled={locked} onChange={(event) => onChange(path, event.target.checked)} /><span>{label(fieldKey)}<small>{locked ? "执行字段，只读" : value ? "是" : "否"}</small></span></label>;
  }
  const multiline = typeof value === "string" && (value.length > 72 || /(prompt|narration|summary|description|rationale|note|hook|angle)/i.test(fieldKey));
  return <label className={multiline ? "node-editor-field node-editor-field-wide" : "node-editor-field"}><span>{label(fieldKey)}{locked ? <small>执行字段，只读</small> : null}</span>{multiline
    ? <textarea rows={3} readOnly={locked} value={formatEditableScalar(value)} onChange={(event) => onChange(path, event.target.value)} />
    : typeof value === "number"
      ? <NumberEditor value={value} readOnly={locked} onChange={(next) => onChange(path, next)} />
      : <input type="text" readOnly={locked} value={formatEditableScalar(value)} onChange={(event) => onChange(path, event.target.value)} />}</label>;
}

function NumberEditor({ value, readOnly, onChange }: { value: number; readOnly: boolean; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) onChange(parsed);
    else setDraft(String(value));
  };
  return <input
    type="number"
    readOnly={readOnly}
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
  return value === null || value === undefined ? "" : String(value);
}

function label(key: string): string {
  return LABELS[key] ?? key.replace(/[_-]+/g, " ");
}
import { useEffect, useState } from "react";
