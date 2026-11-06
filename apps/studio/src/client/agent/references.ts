import { agentApi, type ArtifactHead, type ArtifactRevision, type Message, type Proposal } from "./api.js";
import type { Run } from "../../shared/agent/generated/contracts.js";

export interface ReferenceEntities {
  artifacts: ArtifactHead[];
  proposals: Proposal[];
  runs: Run[];
}

// 一页消息及它引用的制作范围；失败隔离到单个对象，保留可重试的引用位置。
export async function hydrateReferences(messages: Message[], known: ReferenceEntities, cachedRevisions: Record<string, ArtifactRevision> = {},
  refresh: { artifacts?: string[]; proposals?: string[]; runs?: string[] } = {}) {
  const artifacts = new Map(known.artifacts.map(item => [item.id, item]));
  const proposals = new Map(known.proposals.map(item => [item.id, item]));
  const runs = new Map(known.runs.map(item => [item.id, item]));
  const revisions: Record<string, ArtifactRevision> = {};
  const errors: Record<string, string> = {};
  const read = async <T,>(key: string, fetch: () => Promise<T>, save: (item: T) => void) => {
    try { save(await fetch()); } catch (error) { errors[key] = error instanceof Error ? error.message : "读取失败"; }
  };
  // 修订正文不可变；head、提案和制作状态会变化，重连时仅重核已加载的对象。
  const runIds = new Set([...messages.flatMap(message => message.references.runIds), ...(refresh.runs ?? [])]);
  await Promise.all([...runIds].filter(id => !runs.has(id) || refresh.runs?.includes(id)).map(id => read(`run:${id}`, () => agentApi.readRun(id), item => { runs.set(id, item); })));
  const proposalIds = new Set([...messages.flatMap(message => message.references.proposalIds), ...[...runs.values()].map(run => run.proposalId), ...(refresh.proposals ?? [])]);
  await Promise.all([...proposalIds].filter(id => !proposals.has(id) || refresh.proposals?.includes(id)).map(id => read(`proposal:${id}`, () => agentApi.readProposal(id), item => { proposals.set(id, item); })));
  const refs = new Map([...messages.flatMap(message => message.references.artifacts),
    ...[...proposals.values()].flatMap(proposal => proposal.spec.inputRevisions),
    ...[...runs.values()].flatMap(run => run.outputRevisions)].map(ref => [`${ref.artifactId}:${ref.revisionId}`, ref]));
  await Promise.all([
    ...[...new Set([...refs.values()].map(ref => ref.artifactId).concat(refresh.artifacts ?? []))].filter(id => !artifacts.has(id) || refresh.artifacts?.includes(id))
      .map(id => read(`artifact:${id}`, () => agentApi.readArtifactHead(id), item => { artifacts.set(id, item); })),
    ...[...refs].filter(([key]) => !cachedRevisions[key]).map(([key, ref]) => read(`revision:${key}`, () => agentApi.readRevision(ref.artifactId, ref.revisionId), item => { revisions[key] = item; })),
  ]);
  return { artifacts: [...artifacts.values()], proposals: [...proposals.values()], runs: [...runs.values()], revisions, errors };
}
