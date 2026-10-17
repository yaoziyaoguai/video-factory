import { ArrowRight, Check, Clock3, Download, FileText, Settings2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { StudioRunDetail } from "../../shared/api.js";
import { RUN_NODE_LABELS } from "../presentation.js";
import { statusLabel } from "./StatusBadge.js";

export type WorkbenchSection = "work" | "review" | "process" | "files" | "records" | "settings";

export function WorkbenchNavigation({ section, onChange, hasFilm, completed }: {
  section: WorkbenchSection; onChange(section: WorkbenchSection): void; hasFilm: boolean; completed: boolean;
}) {
  const tabs: Array<{ id: WorkbenchSection; label: string }> = [
    { id: "work", label: completed ? "作品" : "当前任务" },
    ...(hasFilm ? [{ id: "review" as const, label: "审片" }] : []),
    { id: "process", label: "制作流程" },
    ...(hasFilm ? [{ id: "files" as const, label: "文案与文件" }] : []),
  ];
  return <div className="workbench-navigation">
    <nav aria-label="作品工作区" className="workbench-tabs">
      {tabs.map(tab => <button key={tab.id} type="button" aria-current={section === tab.id ? "page" : undefined}
        onClick={() => onChange(tab.id)}>{tab.label}</button>)}
    </nav>
    <div className="workbench-tools">
      <button type="button" aria-pressed={section === "records"} onClick={() => onChange("records")}><Clock3 size={16} aria-hidden="true" />版本与记录</button>
      <button type="button" aria-pressed={section === "settings"} onClick={() => onChange("settings")}><Settings2 size={16} aria-hidden="true" />设置与费用</button>
    </div>
  </div>;
}

export function WorkbenchStages({ run, selectedId, active, onSelect }: {
  run: StudioRunDetail; selectedId: string | undefined; active: boolean; onSelect(id: string): void;
}) {
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const navigation = navigationRef.current;
    const selected = navigation?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!active || !navigation || !selected || navigation.scrollWidth <= navigation.clientWidth) return;
    // 窄屏只移动阶段条，让当前步骤可见，不改变页面的纵向阅读位置。
    navigation.scrollLeft += selected.getBoundingClientRect().left - navigation.getBoundingClientRect().left
      - (navigation.clientWidth - selected.offsetWidth) / 2;
  }, [active, selectedId]);
  return <nav ref={navigationRef} className="workbench-stages" aria-label="制作阶段">
    {run.nodes.map((node, index) => <button key={node.id} type="button" aria-current={selectedId === node.id ? "step" : undefined}
      onClick={() => onSelect(node.id)}>
      <span className="workbench-stage-number">{node.status === "succeeded" && !node.outputState?.stale ? <Check size={14} aria-hidden="true" /> : String(index + 1).padStart(2, "0")}</span>
      <span><strong>{nodeLabel(run, node.id, node.label)}</strong><small>{node.outputState?.stale ? "需重新处理" : node.status === "skipped" ? "已跳过" : statusLabel(node.status)}</small></span>
    </button>)}
  </nav>;
}

export function WorkbenchFiles({ run, onOpenNode }: { run: StudioRunDetail; onOpenNode(id: string): void }) {
  // 文件入口只使用服务端投影的当前版本；历史产物仍在对应阶段的版本记录里。
  const currentIds = new Set(run.nodes.flatMap(node => node.outputState
    ? node.outputState.versions.find(version => version.id === node.outputState?.effectiveVersionId)?.artifactIds ?? []
    : node.artifactIds));
  if (run.videoArtifactId) currentIds.add(run.videoArtifactId);
  if (run.publishPackageArtifactId) currentIds.add(run.publishPackageArtifactId);
  const files = run.artifacts.filter(artifact => currentIds.has(artifact.id) && artifact.contentUrl);
  const publishing = run.nodes.find(node => node.id === "publish-package");
  return <section className="workbench-files" aria-label="文案与文件">
    <header className="workbench-section-heading"><div><p className="eyebrow">本版交付</p><h2>文案与文件</h2><p>查看当前采用的内容，下载需要的成果。</p></div>
      {publishing ? <button className="button button-secondary" type="button" onClick={() => onOpenNode(publishing.id)}>查看与编辑发布文案<ArrowRight size={16} aria-hidden="true" /></button> : null}
    </header>
    <div className="workbench-file-list">{files.map(file => <a key={file.id} href={file.contentUrl} download>
      <FileText size={20} aria-hidden="true" /><span><strong>{artifactLabel(file.kind)}{file.scenePosition ? ` · 镜头 ${file.scenePosition}` : ""}</strong>
        <small>{file.producerNodeId ? nodeLabel(run, file.producerNodeId) : "制作产物"} · {formatTime(file.createdAt)}</small></span><Download size={18} aria-hidden="true" />
    </a>)}</div>
    {!files.length ? <p className="workbench-empty">当前还没有可下载的文件。成果准备好后会出现在这里。</p> : null}
  </section>;
}

export function WorkbenchRecords({ run, children }: { run: StudioRunDetail; children?: ReactNode }) {
  return <section className="workbench-records" aria-label="版本与记录">
    <header className="workbench-section-heading"><div><p className="eyebrow">制作记录</p><h2>版本与记录</h2><p>当前采用版本与历史记录分别保留。</p></div></header>
    <ol className="workbench-history-list">{run.decisions.slice().reverse().map(decision => <li key={decision.id}>
      <time dateTime={decision.createdAt}>{formatTime(decision.createdAt)}</time>
      <div><strong>{decision.action === "approve" ? "已确认当前步骤" : decision.action === "reject" ? "已终止制作" : "已提出修改"}</strong>
        {decision.note ? <p>{decision.note}</p> : null}</div>
    </li>)}</ol>
    {!run.decisions.length ? <p className="workbench-empty">尚未记录人工决定。完成第一步确认后，会在这里保留记录。</p> : null}
    {children}
  </section>;
}

function nodeLabel(run: StudioRunDetail, id: string, fallback?: string) {
  return id === "voice" && run.audioMode === "native_av" ? "原声与时间轴" : RUN_NODE_LABELS[id] ?? fallback ?? "制作产物";
}

function artifactLabel(kind: string) {
  return ({ render: "成片", video: "视频", publish_package: "发布包", voiceover: "配音", narration_vtt: "同步字幕",
    narration_srt: "字幕", script: "脚本", storyboard: "导演分镜", director_plan: "导演分镜", media_asset: "画面素材", asset: "画面素材", asset_plan: "素材计划", voiceover_plan: "配音时间方案", render_manifest: "合成记录", review_report: "检查报告", creative_treatment: "前期构思", visual_review: "审片报告" } as Record<string, string>)[kind] ?? "制作文件";
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date) : "时间未记录";
}
