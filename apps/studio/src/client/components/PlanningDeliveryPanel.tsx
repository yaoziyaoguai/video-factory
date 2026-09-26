import { useEffect, useState } from "react";
import type { StudioArtifact } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { NodeDeliveryPreview } from "./NodeDeliveryPreview.js";

const DELIVERIES = [
  { kind: "creative_treatment", label: "前期构思" },
  { kind: "script", label: "脚本" },
  { kind: "storyboard", label: "导演方案" },
  { kind: "asset_candidates", label: "候选素材" },
  { kind: "asset_ranking", label: "选材排序" },
  { kind: "executable_plan", label: "执行方案" },
] as const;

const FIELD_LABELS: Record<string, string> = {
  viewerPromise: "观众承诺", hook: "开场", progression: "内容推进", payoff: "结尾兑现",
  narrationIntent: "旁白意图", visualIntent: "画面意图", viewerGain: "观众收获",
  visualPrinciples: "画面原则", soundPrinciples: "声音原则", narrativeArc: "叙事推进",
  evidenceRequirements: "需要核对的依据", feasibilityQuestions: "制作前要回答的问题",
  claim: "要表达的事实", requirement: "依据要求", acquisition: "获取方式", critical: "关键要求", question: "待决定的问题",
  canonFacts: "已确认的事实", sourcePolicy: "来源原则", sourceIds: "关联来源",
  scenes: "逐段脚本", narration: "旁白", visual_prompt: "画面描述", visualBible: "全片视觉规则",
  shots: "逐镜方案", scene_candidates: "逐镜候选", candidates: "候选素材", query: "检索词",
  summary: "摘要", rationale: "选择理由", scenePosition: "镜头", scene_position: "镜头",
  duration: "时长", durationSeconds: "时长", deliveryType: "获取路线", visibleAction: "画面动作",
  title: "标题", purpose: "目的", description: "说明", rank: "排序", score: "得分",
  totalFrames: "总帧数", cuts: "逐镜剪辑", fps: "帧率", durationRange: "时长范围",
  startFrame: "起始帧", frameCount: "镜头帧数", sourceInFrame: "素材起点",
  originalRank: "原排序", semanticScore: "语义匹配分", qualityScore: "画面匹配分",
  materialization_notes: "素材准备说明", visualDescription: "画面描述", visualStrategy: "画面策略",
};

const VALUE_LABELS: Record<string, string> = {
  factual_support: "需要真实来源支持", illustration_only: "仅用于示意",
  external_required: "需要你提供或核实", pipeline_retrievable: "可由素材库获取",
  pipeline_generated: "可由 AI 生成，制作前需确认报价",
  not_needed: "不需要额外素材",
  generated_video: "生成画面", stock_video: "素材库视频", stock_image: "素材库图片",
  reuse: "复用已有画面", illustrative: "示意画面", factual: "真实取证",
};

const PREVIEW_NODE_IDS: Record<string, string> = {
  script: "script", storyboard: "visual-direction",
  asset_candidates: "asset-candidates", asset_ranking: "asset-semantic-rank",
};
const TECHNICAL_FIELD = /^(?:id|beatId|sceneId|sourceId|sourceIds|source_ids|suppliedSourceIds|retrievalProviderId|providerId|modelId|version|schemaVersion|protocolVersion|artifactId|inputDigest|createdAt|createdBy|sha256)$|(?:^|_)(?:path|sha256)(?:_|$)|(?:Path|Sha256)$/;

interface PlanningDeliveryPanelProps {
  runId: string;
  versionId: string;
  artifactIds: string[];
  artifacts: StudioArtifact[];
  publicationExpected: boolean;
}

export function PlanningDeliveryPanel({ runId, versionId, artifactIds, artifacts, publicationExpected }: PlanningDeliveryPanelProps) {
  const current = DELIVERIES.map((entry) => ({
    ...entry,
    artifact: artifacts.find((artifact) => artifactIds.includes(artifact.id) && artifact.kind === entry.kind),
  }));
  const [selectedKind, setSelectedKind] = useState<string>(() => current.find((entry) => entry.artifact)?.kind ?? DELIVERIES[0].kind);
  const selected = current.find((entry) => entry.kind === selectedKind) ?? current[0]!;
  const [reading, setReading] = useState<{ identity: string; status: "loading" | "ready" | "invalid" | "unavailable"; document?: unknown }>();
  const identity = `${runId}:${versionId}:${selected.artifact?.id ?? selected.kind}:${selected.artifact?.sha256 ?? ""}`;

  useEffect(() => {
    const artifact = selected.artifact;
    if (!artifact) {
      setReading({ identity, status: "unavailable" });
      return;
    }
    if (!artifact.contentUrl || artifact.contentType !== "application/json" || !artifact.sha256) {
      setReading({ identity, status: "invalid" });
      return;
    }
    const controller = new AbortController();
    setReading({ identity, status: "loading" });
    void studioApi.resourceJson(artifact.contentUrl, controller.signal).then((document) => {
      if (!controller.signal.aborted) setReading({ identity, status: "ready", document });
    }).catch(() => {
      if (!controller.signal.aborted) setReading({ identity, status: "invalid" });
    });
    return () => controller.abort();
  }, [identity, selected.artifact?.contentUrl, selected.artifact?.contentType, selected.artifact?.sha256]);

  if (artifactIds.length === 0) {
    return <p className="node-document-state">{publicationExpected
      ? "正式交付记录暂未核对成功。已有文件不会被当作新方案使用；请查看制作记录，不要为此重新规划。"
      : "正式规划尚未交付。当前可讨论的初稿请在上方创作工作台查看。"}</p>;
  }
  return <section className="planning-delivery" aria-label="当前规划交付">
    <div className="planning-delivery-index" aria-label="规划产物目录">
      {current.map((entry) => <button key={entry.kind} type="button" className={entry.kind === selectedKind ? "is-selected" : ""}
        aria-pressed={entry.kind === selectedKind} onClick={() => setSelectedKind(entry.kind)}>
        <span>{entry.label}</span><small>{entry.artifact ? "已交付" : "未产出"}</small>
      </button>)}
    </div>
    <div className="planning-delivery-document" aria-live="polite">
      <header><strong>{selected.label}</strong><small>{selected.artifact ? "当前正式版本 · 只读" : "当前版本未登记此项"}</small></header>
      {reading?.identity !== identity || reading.status === "loading" ? <p>正在读取当前交付…</p>
        : reading.status === "unavailable" ? <p>这一项尚未产出，其他已交付内容仍可查看。</p>
          : reading.status === "invalid" ? <p role="alert">交付已登记，但正文暂时无法核验或读取。已保留现有成果，请查看制作记录；不要为此重新规划。</p>
            : PREVIEW_NODE_IDS[selected.kind]
              ? <><NodeDeliveryPreview nodeId={PREVIEW_NODE_IDS[selected.kind]!} value={reading.document} />
                <details className="planning-delivery-complete"><summary>查看完整业务内容</summary><PlanningDocument value={reading.document} /></details></>
              : <PlanningDocument value={reading.document} />}
      {selected.artifact ? <details className="planning-document-records"><summary>查看产物登记信息</summary>
        <dl className="planning-document-fields"><div><dt>登记编号</dt><dd>{selected.artifact.id}</dd></div>
          <div><dt>内容校验值</dt><dd>{selected.artifact.sha256 ?? "未登记"}</dd></div></dl>
      </details> : null}
    </div>
  </section>;
}

function PlanningDocument({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length > 0
    ? <ol className="planning-document-list">{value.map((item, index) => <li key={index}><PlanningDocument value={item} /></li>)}</ol>
    : <span>暂无</span>;
  if (value && typeof value === "object") {
    const business = Object.entries(value).filter(([key]) => !TECHNICAL_FIELD.test(key));
    return business.length > 0 ? <dl className="planning-document-fields">{business.map(([key, item]) => <div key={key}>
        <dt>{FIELD_LABELS[key] ?? key}</dt><dd><PlanningDocument value={item} /></dd>
      </div>)}</dl> : null;
  }
  return <span>{value === null || value === undefined ? "未填写" : typeof value === "boolean" ? value ? "是" : "否" : VALUE_LABELS[String(value)] ?? String(value)}</span>;
}
