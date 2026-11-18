import { useEffect, useRef, useState } from "react";
import type { ArtifactRevision, ContentSource, RevisionRef } from "../../shared/agent/generated/contracts.js";
import { agentApi } from "./api.js";

export function useNearViewport<T extends HTMLElement>() {
  const element = useRef<T>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !element.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible]);
  return [element, visible] as const;
}

export function sameSource(left: ContentSource | null, right: ContentSource | null): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  return left.kind === "message_text"
    ? left.messageId === (right as Extract<ContentSource, { kind: "message_text" }>).messageId
    : left.revisionId === (right as Extract<ContentSource, { kind: "artifact_revision" }>).revisionId;
}

// 草稿按准确修订读取；失败有可见重试，不用永久 loading 代替错误。
// 读到的修订回报父级合入共享缓存，整组认可的阅读守卫据此判断当前稿是否已加载。
export function useStageRevision(source: ContentSource | RevisionRef | null, cache: Record<string, ArtifactRevision>, onLoaded?: ((revision: ArtifactRevision) => void) | undefined, active = true) {
  const artifactId = source && "artifactId" in source ? source.artifactId : null;
  const revisionId = source && "revisionId" in source ? source.revisionId : null;
  const key = artifactId && revisionId ? `${artifactId}:${revisionId}` : null;
  const cached = key ? cache[key] : undefined;
  const [result, setResult] = useState<{ key: string; revision: ArtifactRevision | null; error: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  useEffect(() => {
    if (!active || !artifactId || !revisionId || !key || cached) return;
    let disposed = false;
    setResult(null);
    void agentApi.readRevision(artifactId, revisionId).then(revision => {
      loadedRef.current?.(revision);
      if (!disposed) setResult({ key, revision, error: false });
    }).catch(() => {
      if (!disposed) setResult({ key, revision: null, error: true });
    });
    return () => { disposed = true; };
  }, [artifactId, revisionId, key, cached, attempt, active]);
  return { revision: key ? cache[key] ?? (result?.key === key ? result.revision : null) : null,
    error: result?.key === key && result.error, retry: () => setAttempt(value => value + 1) };
}
