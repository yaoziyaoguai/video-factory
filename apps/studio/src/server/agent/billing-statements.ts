import { lookup } from "node:dns/promises";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { Agent } from "undici";
import type {
  ExecutionObservation,
  StatementLine,
} from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { insertEvent, type EventHub } from "./event-log.js";
import { assertPublicResolvedHost } from "./network-policy.js";
import { mergeBilling, runRow, type AttemptRow } from "./production-store.js";
import { canonicalJson, digestOf, type AgentClock } from "./util.js";
import { validatorFor } from "./validate.js";

export function queueUnsettled(
  db: AgentDatabase,
  attemptId: string,
  now: string,
) {
  const attempt = db
    .prepare(
      "SELECT phase,state,billing_final,billing_conflict FROM production_attempts WHERE id=?",
    )
    .get(attemptId) as AttemptRow;
  if (attempt.billing_final && !attempt.billing_conflict)
    db.prepare("DELETE FROM pending_reconciliation WHERE attempt_id=?").run(
      attemptId,
    );
  else if (
    attempt.phase !== "prepared" &&
    ["succeeded", "failed", "cancelled", "unknown"].includes(attempt.state)
  )
    db.prepare("INSERT OR IGNORE INTO pending_reconciliation VALUES(?,?)").run(
      attemptId,
      now,
    );
}

export class BillingStatements {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  constructor(
    private db: AgentDatabase,
    private clock: AgentClock,
    private hub: EventHub,
    private source: string,
  ) {}
  start() {
    const tick = () => {
      this.active = this.sync()
        .then(
          () => {},
          (e) => {
            process.emitWarning(
              "逐笔账单暂未处理：" +
                (e instanceof Error ? e.message : String(e)),
            );
          },
        )
        .finally(() => {
          this.active = null;
          if (!this.stopping)
            this.timer = setTimeout(tick, 15 * 60_000).unref();
        });
    };
    this.timer = setTimeout(tick, 1000).unref();
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
  async sync() {
    if (this.source.startsWith("https://")) {
      const target = new URL(this.source);
      const addresses = await lookup(target.hostname.replace(/^\[|\]$/g, ""), { all: true });
      await assertPublicResolvedHost(target.hostname, async () => addresses, false);
      // 连接只使用已核验的地址，保留原域名的 TLS 校验，避免核验后再次解析。
      const dispatcher = new Agent({
        connect: {
          lookup(_hostname, options, result) {
            if (options.all) result(null, addresses);
            else result(null, addresses[0]!.address, addresses[0]!.family);
          },
        },
      });
      try {
        const options = { dispatcher, redirect: "error" as const, signal: AbortSignal.timeout(45000) };
        const response = await fetch(target, options);
        if (!response.ok || !response.body)
          throw new Error("供应商逐笔账单返回 HTTP " + response.status);
        return await this.consume(Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ));
      } finally {
        await dispatcher.destroy();
      }
    }
    let file;
    try {
      file = await open(this.source, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    return this.consume(file.createReadStream());
  }
  private async consume(stream: Readable) {
    const now = this.clock(),
      due = new Date(Date.parse(now) + 15 * 60_000).toISOString();
    let parsed = 0,
      matched = 0;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const record: StatementLine = JSON.parse(line);
        const valid = validatorFor("StatementLine")(record);
        if (!valid.ok)
          throw new Error(
            "逐笔账单第 " + (parsed + 1) + " 行不符合契约：" + valid.message,
          );
        parsed++;
        const cnv = this.apply(record, now);
        if (cnv) {
          matched++;
          this.hub.notifyCommitted(cnv);
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    this.db
      .prepare("UPDATE pending_reconciliation SET due_at=? WHERE due_at<=?")
      .run(due, now);
    return { parsed, matched };
  }
  private apply(line: StatementLine, now: string) {
    return this.db
      .transaction(() => {
        const where = line.requestIdentity
          ? "a.request_identity=?"
          : "a.provider_task_id=?";
        const value = line.requestIdentity ?? line.providerTaskId!;
        const candidates = this.db
          .prepare(
            "SELECT a.* FROM production_attempts a JOIN production_operations o ON o.run_id=a.run_id AND o.id=a.operation_id JOIN production_runs r ON r.id=a.run_id WHERE " +
              where +
              " AND r.proposal_id IS NOT NULL AND a.phase<>'prepared' AND json_extract(o.spec_json,'$.model.providerId')=? AND json_extract(o.spec_json,'$.model.connectionId')=?",
          )
          .all(value, line.providerId, line.connectionId) as AttemptRow[];
        if (candidates.length !== 1) return null;
        const a = candidates[0]!;
        if (line.providerTaskId && a.provider_task_id !== line.providerTaskId)
          return null;
        const fact = line.fact,
          hash = digestOf({ attemptId: a.id, statement: fact });
        const applied = this.db
          .prepare(
            "SELECT 1 FROM ledger_observations WHERE attempt_id=? AND digest=?",
          )
          .get(a.id, hash);
        if (applied) return null;
        const obs: ExecutionObservation = {
          observationId: "inv-" + hash.slice(0, 32),
          attemptId: a.id,
          state: a.state === "prepared" ? "unknown" : a.state,
          providerTaskId: a.provider_task_id,
          blob: null,
          observedAt: now,
          message: "已取得可逐笔匹配的供应商账单。",
          billing: fact,
        };
        this.db
          .prepare(
            "INSERT INTO ledger_observations(attempt_id,digest,observation_json,applied) VALUES(?,?,?,1)",
          )
          .run(a.id, hash, canonicalJson(obs));
        mergeBilling(this.db, a, fact, false);
        queueUnsettled(this.db, a.id, now);
        const run = runRow(this.db, a.run_id);
        this.db
          .prepare(
            "UPDATE production_runs SET revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(now, run.id);
        insertEvent(this.db, now, {
          ownerId: run.owner_id,
          conversationId: run.conversation_id,
          kind: "run.changed",
          entityId: run.id,
          entityVersion: run.revision + 1,
        });
        return run.conversation_id;
      })
      .immediate();
  }
}
