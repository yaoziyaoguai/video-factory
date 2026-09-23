// 真实产物到达的"成片揭幕"判定（M6，纯函数便于确定性测试）。
// 合同：初次观察到的旧片只作基线；此后当前 run 中真正新到的媒体加载完成才揭幕。
// 同一 artifact 不重复（即使媒体 URL 更新），A→B→A 也不重播；切换 run 建立新基线。

export interface FilmArrivalState {
  runId: string | null;
  observed: boolean;
  baselineArtifact: string | null;
  revealed: string[];
}

export const initialFilmArrival: FilmArrivalState = {
  runId: null,
  observed: false,
  baselineArtifact: null,
  revealed: [],
};

export function nextFilmArrival(
  state: FilmArrivalState,
  runId: string,
  artifactId: string | undefined,
  mediaReady: boolean,
): { state: FilmArrivalState; reveal: boolean } {
  if (!state.observed || state.runId !== runId) {
    return { state: { runId, observed: true, baselineArtifact: artifactId ?? null, revealed: [] }, reveal: false };
  }
  if (!artifactId || state.baselineArtifact === artifactId) return { state, reveal: false };
  if (state.revealed.includes(artifactId)) return { state, reveal: false };
  if (!mediaReady) return { state, reveal: false };
  return { state: { ...state, revealed: [...state.revealed, artifactId] }, reveal: true };
}

/**
 * 节点交接光轨的触发判定（M2，纯函数）。
 * 身份 = 会话内当前阶段的「有效稿件/产物身份」，不是 run.revision——轮询带来的纯版本号
 * 变化不重播；只有身份真的变化（新提案到达、被采用后的新稿）才触发一次。
 */
export function stageHandoffIdentityChanged(
  seenIdentity: string | null,
  identity: string | undefined,
): { seen: string | null; changed: boolean } {
  if (identity === undefined) return { seen: seenIdentity, changed: false };
  if (seenIdentity === null) return { seen: identity, changed: false };
  return { seen: identity, changed: identity !== seenIdentity };
}
