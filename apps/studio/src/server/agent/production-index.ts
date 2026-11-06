import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { maxEventSeq } from "./event-log.js";
import { decodeListCursor, encodeEventCursor, encodeListCursor } from "./paging.js";
import { getProposalRow, listProposalRows, rowToProposal } from "./artifact-store.js";
import { toRun, type RunRow } from "./production-store.js";
import type {
  ProductionIndexPage, Proposal, ProposalIndexItem, Run, RunIndexItem, ToolListProduction,
} from "../../shared/agent/generated/contracts.js";

// 只读制作索引：Pi 工具（read_proposal / read_run / list_production）与运行上下文
// 注入共用同一投影与分页算法（与 AgentService 各列表页同源）。只做 SELECT，
// 不产生业务写入，不触发许可、run 或费用变更。

const DEFAULT_LIMIT = 10;

export function toProposalIndexItem(proposal: Proposal): ProposalIndexItem {
  return {
    id: proposal.id,
    title: proposal.spec.title,
    state: proposal.state,
    revision: proposal.revision,
    digest: proposal.digest,
    expiresAt: proposal.expiresAt,
    acceptedRunId: proposal.acceptedRunId,
  };
}

export function toRunIndexItem(run: Run): RunIndexItem {
  return {
    id: run.id,
    title: run.title,
    state: run.state,
    revision: run.revision,
    proposalId: run.proposalId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new AgentError("INVALID_INPUT", "limit 必须在 1..50 之间。");
  }
  return limit;
}

// 超取一行判断是否还有下一页；nextCursor 指向返回页最后一项的不可变创建序。
function pageCursor(fetched: { created_seq: number }[], pageSize: number, scope: { v: 1; c: string; k: string; w: number }): string | null {
  if (fetched.length <= pageSize || fetched.length === 0) return null;
  return encodeListCursor({ ...scope, p: fetched[pageSize - 1]!.created_seq });
}

export function listProductionIndex(db: AgentDatabase, conversationId: string, input: ToolListProduction): ProductionIndexPage {
  const pageSize = boundedLimit(input.limit);
  if (input.kind === "proposals") {
    const decoded = input.cursor === undefined ? undefined : decodeListCursor(input.cursor, conversationId, "proposals");
    const fetched = listProposalRows(db, conversationId, pageSize + 1, decoded?.p);
    // 与 AgentService.proposalPage 相同的粘性 watermark：翻页沿用首页读取位置。
    const watermark = decoded ? decoded.w : maxEventSeq(db, conversationId);
    return {
      kind: "proposals",
      items: fetched.slice(0, pageSize).map(row => toProposalIndexItem(rowToProposal(row, db))),
      nextCursor: pageCursor(fetched, pageSize, { v: 1, c: conversationId, k: "proposals", w: watermark }),
      watermark: encodeEventCursor(conversationId, watermark),
    };
  }
  const decoded = input.cursor === undefined ? undefined : decodeListCursor(input.cursor, conversationId, "runs");
  const fetched = (decoded === undefined
    ? db.prepare("SELECT * FROM production_runs WHERE conversation_id=? ORDER BY created_seq DESC LIMIT ?")
      .all(conversationId, pageSize + 1)
    : db.prepare("SELECT * FROM production_runs WHERE conversation_id=? AND created_seq<? ORDER BY created_seq DESC LIMIT ?")
      .all(conversationId, decoded.p, pageSize + 1)) as RunRow[];
  const watermark = decoded?.w ?? maxEventSeq(db, conversationId);
  return {
    kind: "runs",
    items: fetched.slice(0, pageSize).map(row => toRunIndexItem(toRun(db, row))),
    nextCursor: pageCursor(fetched, pageSize, { v: 1, c: conversationId, k: "runs", w: watermark }),
    watermark: encodeEventCursor(conversationId, watermark),
  };
}

// 归属读取：owner + conversation 双层范围核对，供 Pi 工具使用。
export function getScopedProposal(db: AgentDatabase, ownerId: string, conversationId: string, proposalId: string): Proposal | undefined {
  const row = getProposalRow(db, ownerId, proposalId);
  if (!row || row.conversation_id !== conversationId) return undefined;
  return rowToProposal(row, db);
}

export function getScopedRunRow(db: AgentDatabase, ownerId: string, conversationId: string, runId: string): RunRow | undefined {
  const row = db.prepare("SELECT * FROM production_runs WHERE id = ? AND owner_id = ?").get(runId, ownerId) as RunRow | undefined;
  if (!row || row.conversation_id !== conversationId) return undefined;
  return row;
}

// 回合上下文注入：各一页近期索引 + nextCursor，模型发现更早对象后用 detail 工具读取。
export function contextProductionIndex(db: AgentDatabase, conversationId: string): {
  proposals: { items: ProposalIndexItem[]; nextCursor: string | null };
  runs: { items: RunIndexItem[]; nextCursor: string | null };
} {
  const proposals = listProductionIndex(db, conversationId, { kind: "proposals" });
  const runs = listProductionIndex(db, conversationId, { kind: "runs" });
  // kind 判别后的窄化：ProductionIndexPage.items 是 oneOf 联合数组。
  return {
    proposals: { items: proposals.items as ProposalIndexItem[], nextCursor: proposals.nextCursor },
    runs: { items: runs.items as RunIndexItem[], nextCursor: runs.nextCursor },
  };
}
