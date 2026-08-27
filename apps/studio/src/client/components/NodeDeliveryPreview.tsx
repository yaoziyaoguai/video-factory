interface NodeDeliveryPreviewProps {
  nodeId: string;
  value: unknown;
}

const PRIMARY_FIELDS: Record<string, string[]> = {
  brief: ["title", "angle", "audience", "durationSeconds", "platform", "reviewMode"],
  script: ["title", "hook", "structure", "duration_target", "disclosure_required", "platform_notes"],
  "visual-direction": ["resolvedProfileId", "profileRationale", "requestedProfileId"],
  assets: ["job_id", "created_at", "director_plan_version"],
  voice: ["voice", "rate", "duration", "direction", "provider"],
  render: ["rendered", "duration_target", "resolution", "visual_quality", "requires_ffmpeg"],
  "technical-review": ["status", "video_path"],
  "visual-review": ["recommendation", "confidence", "summary"],
  "final-review": ["recommendation", "confidence", "summary"],
  "publish-package": ["title", "platform", "runId"],
};

const COLLECTION_FIELDS: Record<string, string[]> = {
  script: ["scenes", "quality_checks", "hashtags"],
  "visual-direction": ["shots"],
  assets: ["scene_assets", "director_routing"],
  voice: ["scenes"],
  render: ["slides"],
  "technical-review": ["checks"],
  "visual-review": ["findings"],
  "final-review": ["findings"],
  "publish-package": ["artifacts"],
};

const NESTED_FIELDS: Record<string, string[]> = {
  brief: ["economics", "director", "voiceDirection"],
  "visual-direction": ["visualBible"],
  voice: ["mastering"],
  "technical-review": ["audio"],
  "visual-review": ["scores"],
  "final-review": ["scores"],
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
  provider: "声音能力",
  rendered: "渲染完成",
  resolution: "画面尺寸",
  visual_quality: "画面质量",
  requires_ffmpeg: "需要 FFmpeg",
  status: "质检结果",
  video_path: "检查对象",
  recommendation: "审片结论",
  confidence: "置信度",
  summary: "审片摘要",
  runId: "制作编号",
  scenes: "分镜",
  position: "序号",
  narration: "旁白",
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
  passed: "是否通过",
  severity: "严重程度",
  message: "说明",
  score: "得分",
  shots: "镜头计划",
  scene_assets: "逐镜素材",
  director_routing: "导演路由",
  candidate_shortlist: "候选素材",
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
};

export function NodeDeliveryPreview({ nodeId, value }: NodeDeliveryPreviewProps) {
  const record = asRecord(value);
  if (!record) return <p className="node-document-state">该节点暂时没有结构化交付。</p>;
  const assetRoutes = nodeId === "assets" && Array.isArray(record.director_routing)
    ? record.director_routing
    : [];

  const primary = (PRIMARY_FIELDS[nodeId] ?? Object.keys(record))
    .filter((key) => isScalar(record[key]));
  const nested = (NESTED_FIELDS[nodeId] ?? [])
    .map((key) => ({ key, value: asRecord(record[key]) }))
    .filter((entry): entry is { key: string; value: Record<string, unknown> } => entry.value !== undefined);
  const collections = (COLLECTION_FIELDS[nodeId] ?? [])
    .map((key) => ({ key, value: Array.isArray(record[key]) ? record[key] : [] }))
    .filter((entry) => entry.value.length > 0 && !(nodeId === "assets" && entry.key === "director_routing"));

  if (!primary.length && !nested.length && !collections.length && !assetRoutes.length) {
    return <p className="node-document-state">交付已生成，可在下方查看完整 JSON。</p>;
  }

  return (
    <div className="node-readable-preview">
      {primary.length ? <dl className="node-preview-summary">{primary.map((key) => (
        <div key={key}><dt>{fieldLabel(key)}</dt><dd>{formatScalar(record[key], key)}</dd></div>
      ))}</dl> : null}
      {nested.map((entry) => <section className="node-preview-section" key={entry.key}>
        <h4>{fieldLabel(entry.key)}</h4>
        <dl className="node-preview-facts">{Object.entries(entry.value).filter(([, item]) => isScalar(item)).map(([key, item]) => (
          <div key={key}><dt>{fieldLabel(key)}</dt><dd>{formatScalar(item, key)}</dd></div>
        ))}</dl>
      </section>)}
      {assetRoutes.length ? <AssetRoutingPreview routes={assetRoutes} /> : null}
      {collections.map((entry) => <section className="node-preview-section" key={entry.key}>
        <h4>{fieldLabel(entry.key)}<span>{entry.value.length}</span></h4>
        <div className="node-preview-items">{entry.value.slice(0, 8).map((item, index) => <PreviewItem index={index} item={item} key={index} />)}</div>
      </section>)}
    </div>
  );
}

function AssetRoutingPreview({ routes }: { routes: unknown[] }) {
  return <section className="node-preview-section asset-routing-preview">
    <h4>导演选材与备选素材<span>{routes.length}</span></h4>
    <div className="asset-routing-list">{routes.slice(0, 12).map((item, index) => {
      const route = asRecord(item);
      if (!route) return null;
      const candidates = Array.isArray(route.candidate_shortlist) ? route.candidate_shortlist : [];
      const scene = isScalar(route.scene_position) ? formatScalar(route.scene_position) : String(index + 1);
      return <article className="asset-routing-scene" key={`${scene}-${index}`}>
        <header>
          <div><strong>镜头 {scene}</strong><small>{formatScalar(route.query)}</small></div>
          <span>{formatScalar(route.actual_provider_id ?? route.actual_provider)}</span>
        </header>
        {isScalar(route.rationale) && route.rationale ? <p>{formatScalar(route.rationale)}</p> : null}
        {candidates.length ? <div className="asset-candidate-strip">{candidates.slice(0, 6).map((candidate, candidateIndex) => (
          <AssetCandidate candidate={candidate} index={candidateIndex} key={candidateIndex} />
        ))}</div> : <div className="asset-candidate-empty">{emptyCandidateMessage(route)}</div>}
      </article>;
    })}</div>
  </section>;
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
      <strong>{formatScalar(record.provider_id ?? record.provider)}</strong>
      <small>{dimensions}{typeof record.duration === "number" && record.duration > 0 ? ` · ${record.duration} 秒` : ""}</small>
      {isScalar(record.creator) && record.creator ? <small>作者：{formatScalar(record.creator)}</small> : null}
      {isScalar(record.license_note) ? <small className="asset-license">{formatScalar(record.license_note)}</small> : null}
      {sourceUrl ? <a href={sourceUrl} rel="noreferrer" target="_blank">核验原始来源</a> : null}
    </figcaption>
  </figure>;
}

function PreviewItem({ item, index }: { item: unknown; index: number }) {
  const record = asRecord(item);
  if (!record) return <article><strong>{String(index + 1).padStart(2, "0")}</strong><p>{formatScalar(item)}</p></article>;
  const titleKey = ["title", "purpose", "label", "name", "scene_id", "shotId", "id", "check", "dimension"].find((key) => isScalar(record[key]));
  const facts = Object.entries(record).filter(([key, value]) => key !== titleKey && isScalar(value)).slice(0, 5);
  return <article>
    <span>{String(index + 1).padStart(2, "0")}</span>
    <div><strong>{titleKey ? formatScalar(record[titleKey], titleKey) : `第 ${index + 1} 项`}</strong>{facts.map(([key, value]) => <p key={key}><b>{fieldLabel(key)}</b>{formatScalar(value, key)}</p>)}</div>
  </article>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
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

function formatScalar(value: unknown, key?: string): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined || value === "") return "未填写";
  if ((key === "durationSeconds" || key === "duration_target" || key === "duration") && typeof value === "number") return `${value} 秒`;
  if (key === "confidence" && typeof value === "number") return `${Math.round(value * 100)}%`;
  return String(value);
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/[_-]+/g, " ");
}
