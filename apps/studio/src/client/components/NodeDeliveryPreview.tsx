import { useState } from "react";
import { creatorContainerViewId, creatorViewId, isCreatorNestedField, isCreatorTopLevelField } from "../creator-document-policy.js";
import { humanizeCreativeText, platformLabel, providerLabel } from "../presentation.js";

interface NodeDeliveryPreviewProps {
  nodeId: string;
  value: unknown;
}

const PRIMARY_FIELDS: Record<string, string[]> = {
  brief: ["title", "angle", "audience"],
  script: ["title", "hook", "structure", "duration_target", "disclosure_required", "platform_notes"],
  "reference-grammar": ["summary", "durationMs", "pacing", "composition", "camera", "color", "transitions", "sound", "confidence"],
  "visual-direction": ["resolvedProfileId", "profileRationale", "requestedProfileId"],
  "asset-candidates": [],
  "asset-semantic-rank": ["summary", "fallbackReason"],
  assets: [],
  voice: ["voice", "rate", "duration", "direction"],
  render: ["duration_target", "resolution", "visual_quality"],
  "technical-review": ["status"],
  "visual-review": ["recommendation", "confidence", "summary"],
  "final-review": [],
  "publish-package": ["title", "platform"],
};

const COLLECTION_FIELDS: Record<string, string[]> = {
  script: ["canonFacts", "scenes", "quality_checks", "hashtags"],
  "reference-grammar": ["beats", "reusableRules", "avoidCopying"],
  "visual-direction": ["shots"],
  "asset-candidates": ["scene_candidates"],
  "asset-semantic-rank": ["scenes"],
  assets: ["director_routing"],
  voice: ["scenes"],
  render: ["slides"],
  "technical-review": ["checks"],
  "visual-review": ["findings"],
  "final-review": ["canonFacts"],
  "publish-package": ["artifacts"],
};

const NESTED_FIELDS: Record<string, string[]> = {
  brief: [],
  script: ["platform_notes"],
  "visual-direction": ["visualBible"],
  voice: ["direction"],
  "technical-review": ["audio"],
  "visual-review": ["scores"],
  "final-review": ["review"],
  "publish-package": ["copy", "approval", "aigc"],
};

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  angle: "切入角度",
  audience: "目标观众",
  durationSeconds: "目标时长",
  duration_target: "目标时长",
  duration: "时长",
  platform: "平台",
  reviewMode: "审片方式",
  hook: "开场钩子",
  structure: "叙事结构",
  disclosure_required: "AI 标识",
  platform_notes: "平台提示",
  resolvedProfileId: "导演风格",
  requestedProfileId: "指定风格",
  profileRationale: "选择理由",
  job_id: "任务编号",
  created_at: "生成时间",
  director_plan_version: "导演方案版本",
  voice: "声音演员",
  rate: "语速",
  direction: "表演指示",
  pause_scale: "停顿强度",
  mastering_preset: "声音质感",
  provider: "声音能力",
  rendered: "渲染完成",
  resolution: "画面尺寸",
  visual_quality: "画面质量",
  requires_ffmpeg: "需要 FFmpeg",
  status: "质检结果",
  video_path: "检查对象",
  recommendation: "审片结论",
  confidence: "置信度",
  pacing: "节奏",
  composition: "构图",
  camera: "运镜",
  color: "色彩",
  transitions: "转场",
  sound: "声音结构",
  narrativeApproach: "叙事方法",
  continuity: "连续性",
  continuityNote: "连续性说明",
  beats: "时间段语法",
  reusableRules: "可复用规则",
  avoidCopying: "禁止复制",
  startMs: "开始时间",
  endMs: "结束时间",
  narrativeFunction: "叙事功能",
  shotSize: "景别",
  cameraMovement: "镜头运动",
  subjectMovement: "主体运动",
  lighting: "光线",
  transitionIn: "入场转场",
  soundRole: "声音作用",
  summary: "审片摘要",
  runId: "制作编号",
  scenes: "分镜",
  position: "序号",
  narration: "旁白",
  search_terms: "检索词",
  subtitle: "字幕",
  on_screen_text: "屏幕文字",
  visual: "画面",
  visual_description: "画面说明",
  visual_strategy: "画面策略",
  visual_prompt: "画面提示",
  purpose: "镜头目的",
  source: "来源",
  provider_id: "能力",
  asset_type: "素材类型",
  query: "检索词",
  prompt: "生成提示",
  generationPrompt: "生成提示词",
  passed: "是否通过",
  severity: "严重程度",
  message: "说明",
  score: "得分",
  legibility: "文字可读性",
  safety: "内容安全",
  narrativeRole: "镜头任务",
  authenticityPolicy: "真实度要求",
  scenePosition: "镜头序号",
  scene_position: "镜头序号",
  preferredProviderId: "首选画面能力",
  subject: "主体",
  description: "问题说明",
  suggestion: "修改建议",
  category: "问题类型",
  timecodeMs: "发生时间",
  shots: "镜头计划",
  scene_assets: "逐镜素材",
  director_routing: "导演路由",
  candidate_shortlist: "候选素材",
  scene_candidates: "逐镜候选",
  semanticScore: "语义匹配分",
  originalRank: "原始名次",
  rank: "当前名次",
  rationale: "排序理由",
  locked: "人工锁定",
  selected: "当前采用",
  visible_action: "可见动作",
  sound_cue: "声音提示",
  success_criteria: "成功条件",
  failure_conditions: "失败条件",
  viewerPromise: "观众承诺",
  narrativeArc: "叙事弧线",
  canonFacts: "拟写入系列正史的事实",
  review: "本轮审片结论",
  fallbackReason: "回退原因",
  quality_checks: "脚本自检",
  hashtags: "建议话题",
  slides: "画面页",
  checks: "检查项",
  findings: "审片发现",
  artifacts: "发布产物",
  economics: "成本策略",
  director: "导演配置",
  voiceDirection: "声音配置",
  visualBible: "视觉圣经",
  mastering: "声音处理",
  audio: "音频检查",
  scores: "评分",
  copy: "发布文案",
  approval: "审片批准",
  aigc: "AI 内容标识",
  brief: "内容简报",
  script: "脚本交付",
  scriptPath: "脚本交付",
  directorPlanPath: "导演方案",
  candidateSearchPath: "候选素材清单",
  candidateRankingPath: "语义排序结果",
  assetPlanPath: "素材方案",
  renderManifestPath: "渲染清单",
};

export function NodeDeliveryPreview({ nodeId, value }: NodeDeliveryPreviewProps) {
  const record = asRecord(value);
  if (!record) return <p className="node-document-state">该节点暂时没有结构化交付。</p>;
  const inputPreview = nodeId.endsWith("-input");
  const viewId = creatorViewId(nodeId);
  const assetRoutes = viewId === "assets" && Array.isArray(record.director_routing)
    ? record.director_routing
    : [];
  const candidateScenes = viewId === "asset-candidates" && Array.isArray(record.scene_candidates)
    ? record.scene_candidates
    : [];
  const rankingScenes = viewId === "asset-semantic-rank" && Array.isArray(record.scenes)
    ? record.scenes
    : [];

  const primary = uniqueKeys([
    ...(PRIMARY_FIELDS[viewId] ?? []),
    ...(inputPreview ? Object.keys(record).filter((key) => isCreatorTopLevelField(nodeId, key, record[key]) && isScalar(record[key])) : []),
  ])
    .filter((key) => isCreatorTopLevelField(nodeId, key, record[key]))
    .filter((key) => hasDisplayScalar(record[key]));
  const nestedKeys = uniqueKeys([
    ...(NESTED_FIELDS[viewId] ?? []),
    ...(inputPreview ? Object.keys(record).filter((key) => isCreatorTopLevelField(nodeId, key, record[key]) && asRecord(record[key]) !== undefined) : []),
  ]);
  const collectionKeys = uniqueKeys([
    ...(COLLECTION_FIELDS[viewId] ?? []),
    ...(inputPreview ? Object.keys(record).filter((key) => isCreatorTopLevelField(nodeId, key, record[key]) && Array.isArray(record[key])) : []),
  ]);
  const nested = nestedKeys
    .filter((key) => isCreatorTopLevelField(nodeId, key, record[key]))
    .map((key) => ({ key, value: asRecord(record[key]) }))
    .filter((entry): entry is { key: string; value: Record<string, unknown> } => entry.value !== undefined && Object.values(entry.value).some(hasDisplayValue));
  const collections = collectionKeys
    .filter((key) => isCreatorTopLevelField(nodeId, key, record[key]))
    .map((key) => ({ key, value: Array.isArray(record[key]) ? record[key].filter(hasCreatorCollectionItem) : [] }))
    .filter((entry) => entry.value.length > 0
      && !(viewId === "assets" && entry.key === "director_routing")
      && !(viewId === "asset-candidates" && entry.key === "scene_candidates")
      && !(viewId === "asset-semantic-rank" && entry.key === "scenes"));

  if (!primary.length && !nested.length && !collections.length && !assetRoutes.length && !candidateScenes.length && !rankingScenes.length) {
    return <p className="node-document-state">这个节点没有需要人工查看或修改的创作内容。</p>;
  }

  return (
    <div className="node-readable-preview">
      {primary.length ? <dl className="node-preview-summary">{primary.map((key) => (
        <div key={key}><dt>{fieldLabel(key)}</dt><dd>{formatScalar(record[key], key)}</dd></div>
      ))}</dl> : null}
      {nested.map((entry) => <section className="node-preview-section" key={entry.key}>
        <h4>{fieldLabel(entry.key)}</h4>
        <dl className="node-preview-facts">{Object.entries(entry.value).filter(([key, item]) => {
          const nestedViewId = creatorContainerViewId(entry.key);
          return (nestedViewId ? isCreatorTopLevelField(nestedViewId, key, item) : isCreatorNestedField(key)) && hasDisplayScalar(item);
        }).map(([key, item]) => (
          <div key={key}><dt>{fieldLabel(key)}</dt><dd>{formatScalar(item, key)}</dd></div>
        ))}</dl>
      </section>)}
      {assetRoutes.length ? <AssetRoutingPreview routes={assetRoutes} /> : null}
      {candidateScenes.length ? <AssetCandidateScenePreview scenes={candidateScenes} /> : null}
      {rankingScenes.length ? <AssetRankingPreview scenes={rankingScenes} /> : null}
      {collections.map((entry) => <CollectionPreview collectionKey={entry.key} items={entry.value} key={entry.key} />)}
    </div>
  );
}

function CollectionPreview({ collectionKey, items }: { collectionKey: string; items: unknown[] }) {
  const initialCount = collectionKey === "findings" ? 20 : 8;
  const { expanded, hiddenCount, setExpanded, visibleItems } = useExpandedItems(items, initialCount);
  const label = fieldLabel(collectionKey);

  return <section className="node-preview-section">
    <h4>{label}<span>{items.length}</span></h4>
    <div className="node-preview-items">{visibleItems.map((item, index) => <PreviewItem collectionKey={collectionKey} index={index} item={item} key={index} />)}</div>
    <PreviewExpandButton expanded={expanded} hiddenCount={hiddenCount} initialCount={initialCount} label={label} totalCount={items.length} onToggle={() => setExpanded((current) => !current)} />
  </section>;
}

function AssetCandidateScenePreview({ scenes }: { scenes: unknown[] }) {
  const { expanded, hiddenCount, setExpanded, visibleItems } = useExpandedItems(scenes, 12);
  return <section className="node-preview-section asset-routing-preview">
    <h4>下载前候选素材<span>{scenes.length}</span></h4>
    <div className="asset-routing-list">{visibleItems.map((item, index) => {
      const scene = asRecord(item);
      if (!scene) return null;
      const candidates = Array.isArray(scene.candidates) ? scene.candidates : [];
      return <article className="asset-routing-scene" key={index}>
        <header><div><strong>镜头 {formatScalar(scene.scene_position ?? index + 1)}</strong><small>{formatScalar(scene.query)}</small></div><span>{candidates.length} 个候选</span></header>
        <div className="asset-candidate-strip">{candidates.slice(0, 6).map((candidate, candidateIndex) => <AssetCandidate candidate={candidate} index={candidateIndex} key={candidateIndex} />)}</div>
      </article>;
    })}</div>
    <PreviewExpandButton expanded={expanded} hiddenCount={hiddenCount} initialCount={12} label="候选镜头" totalCount={scenes.length} onToggle={() => setExpanded((current) => !current)} />
  </section>;
}

function AssetRankingPreview({ scenes }: { scenes: unknown[] }) {
  const { expanded, hiddenCount, setExpanded, visibleItems } = useExpandedItems(scenes, 12);
  return <section className="node-preview-section asset-ranking-preview">
    <h4>逐镜语义排序<span>{scenes.length}</span></h4>
    <div className="node-preview-items">{visibleItems.map((item, index) => {
      const scene = asRecord(item);
      const candidates = scene && Array.isArray(scene.candidates) ? [...scene.candidates].sort((left, right) => {
        const a = asRecord(left)?.rank;
        const b = asRecord(right)?.rank;
        return (typeof a === "number" ? a : 999) - (typeof b === "number" ? b : 999);
      }) : [];
      return <article key={index}>
        <span>{String(scene?.scenePosition ?? index + 1).padStart(2, "0")}</span>
        <div><strong>{formatScalar(scene?.summary)}</strong>{candidates.slice(0, 6).map((candidate, candidateIndex) => {
          const row = asRecord(candidate);
          return row ? <p key={candidateIndex}><b>#{formatScalar(row.rank)} · {formatScalar(row.provider, "provider")}</b>{formatScalar(row.semanticScore)} 分 · {formatScalar(row.rationale)}{row.locked === true ? " · 已锁定" : ""}</p> : null;
        })}</div>
      </article>;
    })}</div>
    <PreviewExpandButton expanded={expanded} hiddenCount={hiddenCount} initialCount={12} label="语义排序" totalCount={scenes.length} onToggle={() => setExpanded((current) => !current)} />
  </section>;
}

function AssetRoutingPreview({ routes }: { routes: unknown[] }) {
  const { expanded, hiddenCount, setExpanded, visibleItems } = useExpandedItems(routes, 12);
  return <section className="node-preview-section asset-routing-preview">
    <h4>导演选材与备选素材<span>{routes.length}</span></h4>
    <div className="asset-routing-list">{visibleItems.map((item, index) => {
      const route = asRecord(item);
      if (!route) return null;
      const candidates = Array.isArray(route.candidate_shortlist) ? route.candidate_shortlist : [];
      const scene = isScalar(route.scene_position) ? formatScalar(route.scene_position) : String(index + 1);
      return <article className="asset-routing-scene" key={`${scene}-${index}`}>
        <header>
          <div><strong>镜头 {scene}</strong><small>{formatScalar(route.query)}</small></div>
          <span>{formatScalar(route.actual_provider_id ?? route.actual_provider, "provider")}</span>
        </header>
        {isScalar(route.rationale) && route.rationale ? <p>{formatScalar(route.rationale)}</p> : null}
        {candidates.length ? <div className="asset-candidate-strip">{candidates.slice(0, 6).map((candidate, candidateIndex) => (
          <AssetCandidate candidate={candidate} index={candidateIndex} key={candidateIndex} />
        ))}</div> : <div className="asset-candidate-empty">{emptyCandidateMessage(route)}</div>}
      </article>;
    })}</div>
    <PreviewExpandButton expanded={expanded} hiddenCount={hiddenCount} initialCount={12} label="选材镜头" totalCount={routes.length} onToggle={() => setExpanded((current) => !current)} />
  </section>;
}

function useExpandedItems<T>(items: T[], initialCount: number) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? items : items.slice(0, initialCount);
  return {
    expanded,
    hiddenCount: items.length - visibleItems.length,
    setExpanded,
    visibleItems,
  };
}

function PreviewExpandButton({
  expanded,
  hiddenCount,
  initialCount,
  label,
  onToggle,
  totalCount,
}: {
  expanded: boolean;
  hiddenCount: number;
  initialCount: number;
  label: string;
  onToggle: () => void;
  totalCount: number;
}) {
  if (totalCount <= initialCount) return null;
  return <button aria-expanded={expanded} className="node-preview-expand" type="button" onClick={onToggle}>
    {expanded ? `收起${label}` : `展开其余 ${hiddenCount} 个${label}`}
  </button>;
}

function emptyCandidateMessage(route: Record<string, unknown>): string {
  const provider = String(route.actual_provider ?? "").toLowerCase();
  if (provider === "local") return "本镜头当前采用本地编辑画面，没有图库候选。";
  if (route.generation_pending === true) return "本镜头计划使用生成式素材；生成前仍需人工确认成本与提示词。";
  return "本次任务没有保存可公开预览的候选素材；旧任务仍可在完整交付中核验实际来源。";
}

function AssetCandidate({ candidate, index }: { candidate: unknown; index: number }) {
  const record = asRecord(candidate);
  if (!record) return null;
  const selected = record.selected === true;
  const previewUrl = safeCandidateUrl(record.preview_url);
  const sourceUrl = safeCandidateUrl(record.source_url);
  const dimensions = [record.width, record.height].every((value) => typeof value === "number")
    ? `${record.width} × ${record.height}`
    : "尺寸未知";
  return <figure className={selected ? "is-selected" : undefined}>
    <div className="asset-candidate-media">
      {previewUrl ? <img alt={`候选素材 ${index + 1}`} loading="lazy" src={previewUrl} /> : <span>暂无缩略图</span>}
      {selected ? <b>当前采用</b> : null}
    </div>
    <figcaption>
      <strong>{formatScalar(record.provider_id ?? record.provider, "provider")}</strong>
      <small>{dimensions}{typeof record.duration === "number" && record.duration > 0 ? ` · ${record.duration} 秒` : ""}</small>
      {isScalar(record.creator) && record.creator ? <small>作者：{formatScalar(record.creator)}</small> : null}
      {isScalar(record.license_note) ? <small className="asset-license">{formatScalar(record.license_note)}</small> : null}
      {sourceUrl ? <a href={sourceUrl} rel="noreferrer" target="_blank">核验原始来源</a> : null}
    </figcaption>
  </figure>;
}

function PreviewItem({ collectionKey, item, index }: { collectionKey: string; item: unknown; index: number }) {
  const record = asRecord(item);
  if (!record) return <article><strong>{String(index + 1).padStart(2, "0")}</strong><p>{formatScalar(item)}</p></article>;
  const titleKey = ["title", "purpose", "label", "name", "check", "timecodeMs"].find((key) => isScalar(record[key]));
  const facts = Object.entries(record).filter(([key, value]) => key !== titleKey && isCreatorNestedField(key) && hasDisplayScalar(value)).slice(0, 5);
  return <article>
    <span>{String(index + 1).padStart(2, "0")}</span>
    <div><strong>{titleKey ? formatScalar(record[titleKey], titleKey) : collectionItemTitle(collectionKey, index)}</strong>{facts.map(([key, value]) => <p key={key}><b>{fieldLabel(key)}</b>{formatScalar(value, key)}</p>)}</div>
  </article>;
}

function collectionItemTitle(collectionKey: string, index: number): string {
  if (collectionKey === "shots") return `镜头 ${index + 1}`;
  if (collectionKey === "scenes") return `分镜 ${index + 1}`;
  if (collectionKey === "findings") return `问题 ${index + 1}`;
  return `第 ${index + 1} 项`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function hasDisplayScalar(value: unknown): boolean {
  return isScalar(value) && value !== null && value !== undefined && value !== "";
}

function hasDisplayValue(value: unknown): boolean {
  if (hasDisplayScalar(value)) return true;
  if (Array.isArray(value)) return value.some(hasDisplayValue);
  const record = asRecord(value);
  return record ? Object.values(record).some(hasDisplayValue) : false;
}

function hasCreatorCollectionItem(value: unknown): boolean {
  if (hasDisplayScalar(value)) return true;
  const record = asRecord(value);
  return record ? Object.entries(record).some(([key, item]) => isCreatorNestedField(key) && hasDisplayValue(item)) : false;
}

function safeCandidateUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    const hostname = url.hostname.toLowerCase();
    const allowed = ["pexels.com", "pixabay.com"].some((domain) => (
      hostname === domain || hostname.endsWith(`.${domain}`)
    ));
    return allowed ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function uniqueKeys(values: string[]): string[] {
  return [...new Set(values)];
}

function formatScalar(value: unknown, key?: string): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined || value === "") return "未填写";
  if (key === "platform" && typeof value === "string") return platformLabel(value);
  if ((key === "provider" || key === "provider_id" || key === "preferredProviderId") && typeof value === "string") return providerLabel(value) ?? value;
  if (key === "reviewMode" && value === "manual") return "人工终审";
  if (key === "recommendation" && typeof value === "string") return ({ approve: "通过", revise: "修改后再审", reject: "不通过" } as Record<string, string>)[value] ?? value;
  if (key === "severity" && typeof value === "string") return ({ info: "提示", low: "轻微", medium: "需关注", warning: "需修改", high: "高风险", critical: "严重" } as Record<string, string>)[value] ?? value;
  if (key === "category" && typeof value === "string") return ({ pacing: "节奏", composition: "构图", continuity: "连续性", legibility: "文字可读性", safety: "内容安全", other: "其他" } as Record<string, string>)[value] ?? value;
  if (key === "visual_strategy" && typeof value === "string") return ({ stock: "实拍视频素材", image: "图片素材", local: "本地编辑画面", generated: "AI 生成画面", screen: "屏幕录制", creator: "创作者素材" } as Record<string, string>)[value] ?? value;
  if (key === "authenticityPolicy" && typeof value === "string") return ({ evidence: "事实镜头", illustrative: "说明镜头", expressive: "表现镜头" } as Record<string, string>)[value] ?? value;
  if (key === "mastering_preset" && typeof value === "string") return ({ natural: "自然", intimate: "亲近", social: "社交清晰" } as Record<string, string>)[value] ?? value;
  if ((key === "requestedProfileId" || key === "resolvedProfileId") && typeof value === "string") return directorProfileLabel(value);
  if (key === "voice" && typeof value === "string") return voiceProfileLabel(value);
  if (key === "narrativeRole" && typeof value === "string") return humanizeNarrativeRole(value);
  if (typeof value === "string" && key && /(?:Path|_path)$/.test(key)) return "已连接上游产物";
  if (typeof value === "string") return humanizeCreativeText(({
    measured: "舒缓克制",
    medium: "适中",
    fast: "明快",
    slow: "舒缓",
  } as Record<string, string>)[value] ?? value);
  if ((key === "durationSeconds" || key === "duration_target" || key === "duration") && typeof value === "number") return `${value} 秒`;
  if (key === "rate" && typeof value === "number") return `${value} 字/分钟`;
  if (key === "timecodeMs" && typeof value === "number") return formatTimecode(value);
  if (key === "confidence" && typeof value === "number") return `${Math.round(value * 100)}%`;
  return String(value);
}

function formatTimecode(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function humanizeNarrativeRole(value: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/^question\s*\/\s*shot-question\s*[：:]?\s*/i, "提问钩子："],
    [/^model\s*\/\s*shot-model\s*[：:]?\s*/i, "原理说明："],
    [/^example\s*\/\s*shot-example\s*[：:]?\s*/i, "实例验证："],
    [/^takeaway\s*\/\s*shot-takeaway\s*[：:]?\s*/i, "结论行动："],
  ];
  return replacements.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value);
}

function directorProfileLabel(value: string): string {
  return ({
    auto: "自动匹配",
    "documentary-observer": "纪实观察",
    "quiet-humanism": "静默人文",
    "urban-poetic": "都市诗意",
    "chromatic-storytelling": "色彩叙事",
    "geometric-control": "几何秩序",
    "suspense-staging": "悬念调度",
  } as Record<string, string>)[value] ?? value;
}

function voiceProfileLabel(value: string): string {
  const labels = {
    "minimax:female-chengshu": "成熟女声",
    "minimax:female-tianmei": "甜美女声",
    "minimax:male-qn-qingse": "青年男声",
    "minimax:male-qn-jingying": "精英男声",
    "macos:Tingting": "Tingting 中文女声",
    "kokoro:zf_xiaobei": "小北女声",
  } as Record<string, string>;
  return labels[value] ?? labels[`minimax:${value}`] ?? labels[`kokoro:${value}`] ?? labels[`macos:${value}`] ?? humanizeCreativeText(value);
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/[_-]+/g, " ");
}
