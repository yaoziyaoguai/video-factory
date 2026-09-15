import type { StudioArtifact, StudioRunDetail } from "../shared/api.js";

/**
 * 当前有效版本里的脚本交付。
 *
 * 旁白与字幕都来自脚本，改字必须改在脚本上；旧拓扑的脚本节点与 joint-v1 的创作规划节点
 * 都可能持有它，所以两种拓扑都要找。取值按各节点自己的有效版本，避免翻到人工修订前的旧稿。
 */
export function currentScriptArtifact(run: StudioRunDetail): StudioArtifact | undefined {
  for (const nodeId of ["creative-planning", "script"]) {
    const node = run.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) continue;
    const effectiveVersion = node.outputState?.versions.find(
      (version) => version.id === node.outputState?.effectiveVersionId,
    );
    const currentIds = effectiveVersion?.artifactIds?.length ? effectiveVersion.artifactIds : node.artifactIds;
    const artifact = run.artifacts.find((candidate) => candidate.kind === "script"
      && candidate.contentType === "application/json"
      && candidate.contentUrl
      && currentIds.includes(candidate.id));
    if (artifact) return artifact;
  }
  return undefined;
}

/** 从脚本交付里取指定镜位的旁白原文。 */
export function sceneNarrationText(document: unknown, scenePosition: number): string {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("脚本交付不是可读的结构。");
  }
  const scenes = (document as Record<string, unknown>).scenes;
  if (!Array.isArray(scenes)) throw new Error("脚本交付里没有分镜列表。");
  const scene = scenes.find((candidate) => (
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    && Number((candidate as Record<string, unknown>).position) === scenePosition
  ));
  if (!scene) throw new Error(`当前脚本里已经没有镜头 ${scenePosition}。`);
  const narration = (scene as Record<string, unknown>).narration;
  if (typeof narration !== "string") throw new Error(`镜头 ${scenePosition} 的旁白字幕不是文字。`);
  return narration;
}
