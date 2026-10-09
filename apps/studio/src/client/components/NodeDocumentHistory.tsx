import { useEffect, useState } from "react";
import type { StudioArtifact, StudioNodeOutputState } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { NodeContentReview, nodeContentReview } from "./NodeContentReview.js";
import { NodeDeliveryPreview } from "./NodeDeliveryPreview.js";
import { beijingDateTime } from "../presentation.js";

const DOCUMENT_KIND: Record<string, string> = {
  "publish-package": "publish_package",
  "reference-grammar": "shot_grammar",
};

export function NodeDocumentHistory({ nodeId, outputState, artifacts }: {
  nodeId: string;
  outputState: StudioNodeOutputState | undefined;
  artifacts: StudioArtifact[];
}) {
  const history = outputState?.versions.filter((version) => version.id !== outputState.effectiveVersionId) ?? [];
  if (history.length === 0) return null;
  return <section className="node-document-history" aria-label="交付历史版本">
    <h3>历史版本</h3>
    <p>旧版只供回看，不能直接当作当前稿采用；要恢复内容，请保存为新的人工版本并重新核对。</p>
    {history.map((version) => {
      const artifact = artifacts.find((candidate) => version.artifactIds.includes(candidate.id)
        && candidate.kind === DOCUMENT_KIND[nodeId]
        && candidate.contentType === "application/json");
      return <HistoricalDocument key={version.id} nodeId={nodeId} versionId={version.id}
        label={`第 ${outputState!.versions.indexOf(version) + 1} 版 · ${beijingDateTime(version.createdAt) ?? "时间未记录"}`}
        artifact={artifact} review={nodeContentReview(version.output)} />;
    })}
  </section>;
}

function HistoricalDocument({ nodeId, versionId, label, artifact, review }: {
  nodeId: string;
  versionId: string;
  label: string;
  artifact: StudioArtifact | undefined;
  review: ReturnType<typeof nodeContentReview>;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<unknown>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open || !artifact?.contentUrl) return;
    const controller = new AbortController();
    setContent(undefined);
    setError(undefined);
    void studioApi.resourceJson(artifact.contentUrl, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setContent(value);
      setError(undefined);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => controller.abort();
  }, [artifact?.contentUrl, open]);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {review ? <NodeContentReview value={review} /> : <p>此历史版本没有可核实的审计记录。</p>}
    {!artifact?.contentUrl ? <p>此历史版本的完整文档不可读取，请查看原始产物记录。</p>
      : error ? <p role="alert">读取历史文档失败：{error}</p>
        : content === undefined ? <p>正在读取历史文档…</p>
          : <NodeDeliveryPreview nodeId={nodeId} value={content} />}
    <details className="node-document-diagnostics"><summary>版本诊断信息</summary>
      <label className="field"><span>版本编号（可选中复制）</span><input aria-label="历史版本编号" readOnly value={versionId} onFocus={event => event.currentTarget.select()} /></label>
    </details>
  </details>;
}
