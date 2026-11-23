import { derivePasswordHash, verifyPassword } from "../auth.js";
import type {
  BudgetPolicies,
  BudgetPolicy,
  BudgetPeriod,
  BudgetSummary,
  BudgetUsage,
  CreateStudioAccount,
  SaveBudgetPolicy,
  StudioAccount,
  StudioAccounts,
  UpdateStudioAccount,
} from "../../shared/agent/generated/contracts.js";
import {
  checkCommandReceipt,
  storeCommandReceipt,
} from "./conversation-store.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { finances, terminal, type RunRow } from "./production-store.js";
import { newAgentId, type AgentClock } from "./util.js";
import { validatorFor } from "./validate.js";

interface StoredAccount extends StudioAccount {
  passwordHash: string;
  sessionVersion: number;
}
interface AccountCommandReceipt {
  result: StudioAccounts;
  passwordVerifier: string | null;
}

const accountFields = "id,username,role,disabled_at AS disabledAt";
const fields =
  "scope,subject_id AS subjectId,revision,conversation_limit AS conversationLimitMinor,day_limit AS dayLimitMinor,month_limit AS monthLimitMinor";

export class StudioAccountsStore {
  constructor(
    private db: AgentDatabase,
    private clock: AgentClock,
  ) {}
  bootstrap(username: string, hash: string) {
    this.db.transaction(() => {
      // 初始管理员沿用旧 owner_id。已存在账号的角色与密码由成员管理维护。
      const existing = this.find(username);
      if (existing) {
        if (existing.id !== username) throw new Error("初始管理员名称已分配给其他账号。");
        return;
      }
      this.db.prepare("INSERT INTO studio_users(id,username,role,password_hash) VALUES(?,?,'admin',?)")
        .run(username, username, hash);
      this.advanceRevision();
    }).immediate();
  }
  find(username: string) {
    return this.db.prepare("SELECT " + accountFields +
      ",password_hash AS passwordHash,session_version AS sessionVersion FROM studio_users WHERE username=?")
      .get(username) as StoredAccount | undefined;
  }
  isAdmin(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM studio_users WHERE id=? AND role='admin' AND disabled_at IS NULL").get(id));
  }
  private revision() {
    return this.db.prepare("SELECT revision FROM studio_account_settings WHERE id=1").pluck().get() as number;
  }
  private advanceRevision() {
    this.db.prepare("UPDATE studio_account_settings SET revision=revision+1 WHERE id=1").run();
  }
  list(): StudioAccounts {
    return this.db.transaction(() => ({
      revision: this.revision(),
      accounts: this.db.prepare("SELECT " + accountFields + " FROM studio_users ORDER BY rowid").all() as StudioAccount[],
    }))();
  }
  create(ownerId: string, input: CreateStudioAccount, authorized: () => boolean) {
    const valid = validatorFor("CreateStudioAccount")(input);
    if (!valid.ok) throw new AgentError("INVALID_INPUT", valid.message);
    return this.changeAccount(ownerId, "createStudioAccount", "team", input, authorized, (hash) => {
      if (this.find(input.username)) throw new AgentError("INVALID_INPUT", "这个用户名已使用。");
      this.db.prepare("INSERT INTO studio_users(id,username,role,password_hash) VALUES(?,?,?,?)")
        .run(newAgentId("usr"), input.username, input.role, hash);
      return true;
    });
  }
  update(ownerId: string, username: string, input: UpdateStudioAccount, authorized: () => boolean) {
    const valid = validatorFor("UpdateStudioAccount")(input);
    if (!valid.ok) throw new AgentError("INVALID_INPUT", valid.message);
    return this.changeAccount(ownerId, "updateStudioAccount", username, input, authorized, (hash, now) => {
      const member = this.find(username);
      if (!member) throw new AgentError("NOT_FOUND", "没有找到该成员。");
      const role = input.role ?? member.role;
      const disabledAt = input.disabled === undefined ? member.disabledAt
        : input.disabled ? member.disabledAt ?? now : null;
      if (role === member.role && disabledAt === member.disabledAt && hash === null) return false;
      if (member.role === "admin" && member.disabledAt === null && (role !== "admin" || disabledAt !== null)
        && !this.db.prepare("SELECT 1 FROM studio_users WHERE role='admin' AND disabled_at IS NULL AND id<>?").get(member.id)) {
        throw new AgentError("FORBIDDEN", "空间至少需要保留一位启用的管理员。");
      }
      this.db.prepare("UPDATE studio_users SET role=?,disabled_at=?,password_hash=?,session_version=session_version+1 WHERE id=?")
        .run(role, disabledAt, hash ?? member.passwordHash, member.id);
      return true;
    });
  }
  private async changeAccount(
    ownerId: string, operation: string, targetId: string,
    input: CreateStudioAccount | UpdateStudioAccount, authorized: () => boolean,
    write: (hash: string | null, now: string) => boolean,
  ): Promise<StudioAccounts> {
    const key = { ownerId, operation, targetId, commandId: input.commandId };
    const { password, ...metadata } = input;
    const replayResult = async (receipt: AccountCommandReceipt) => {
      const samePassword = password === undefined ? receipt.passwordVerifier === null
        : receipt.passwordVerifier !== null && await verifyPassword(password, receipt.passwordVerifier);
      if (!samePassword) throw new AgentError("IDEMPOTENCY_CONFLICT", "同一命令已经用于不同的账号信息。");
      return receipt.result;
    };
    const prior = checkCommandReceipt<AccountCommandReceipt>(this.db, key, metadata);
    if (prior.kind === "replay") return replayResult(prior.receipt);
    const hash = password === undefined ? null : await derivePasswordHash(password);
    const result = this.db.transaction(() => {
      // 派生密码期间会让出事件循环，写入前重新验证操作人仍有管理权限。
      if (!authorized()) throw new AgentError("FORBIDDEN", "只有管理员可以管理团队设置。");
      const replay = checkCommandReceipt<AccountCommandReceipt>(this.db, key, metadata);
      if (replay.kind === "replay") return replay;
      if (input.expectedRevision !== this.revision()) throw new AgentError("STALE_REVISION", "团队账号已有更新。");
      const now = this.clock();
      if (write(hash, now)) this.advanceRevision();
      const receipt = { result: this.list(), passwordVerifier: hash };
      storeCommandReceipt(this.db, now, key, metadata, receipt);
      return { kind: "written" as const, receipt };
    }).immediate();
    return result.kind === "replay" ? replayResult(result.receipt) : result.receipt.result;
  }
  budgetSummary(ownerId: string, conversationId: string | null): BudgetSummary {
    const window = budgetWindowUtc(this.clock());
    return this.db.transaction((): BudgetSummary => {
      const policies = applicablePolicies(this.db, ownerId);
      const personal = budgetUsage(this.db, "user", ownerId, conversationId, window,
        policies.find(p => p.scope === "user"));
      const workspace = budgetUsage(this.db, "workspace", ownerId, conversationId, window,
        policies.find(p => p.scope === "workspace"));
      const caps = [personal, workspace].flatMap(usage => [usage.conversation, usage.day, usage.month])
        .flatMap(period => period !== null && period.remainingMinor !== null ? [period.remainingMinor] : []);
      return { currency: "CNY", timeZone: window.timeZone, conversationId, personal, workspace,
        effectiveRemainingMinor: caps.length ? Math.min(...caps) : null };
    })();
  }
  budgets(): BudgetPolicies {
    return {
      currency: "CNY",
      policies: this.db
        .prepare(
          "SELECT " +
            fields +
            " FROM budget_policies ORDER BY scope,subject_id",
        )
        .all() as BudgetPolicy[],
    };
  }
  saveBudget(ownerId: string, input: SaveBudgetPolicy) {
    const valid = validatorFor("SaveBudgetPolicy")(input);
    if (!valid.ok) throw new AgentError("INVALID_INPUT", valid.message);
    const key = {
      ownerId,
      operation: "saveBudgetPolicy",
      targetId: input.scope + "/" + input.subjectId,
      commandId: input.commandId,
    };
    return this.db
      .transaction(() => {
        const prior = checkCommandReceipt<BudgetPolicy>(this.db, key, input);
        if (prior.kind === "replay") return prior.receipt;
        if (
          input.scope === "workspace"
            ? input.subjectId !== "default"
            : !this.db
                .prepare("SELECT 1 FROM studio_users WHERE id=?")
                .get(input.subjectId)
        )
          throw new AgentError("NOT_FOUND", "没有找到预算所属空间或账号。");
        const rev = this.db
          .prepare(
            "SELECT revision FROM budget_policies WHERE scope=? AND subject_id=?",
          )
          .pluck()
          .get(input.scope, input.subjectId) as number | undefined;
        if ((rev ?? 0) !== input.expectedRevision)
          throw new AgentError("STALE_REVISION", "预算额度已由另一操作更新。");
        const revision = input.expectedRevision + 1;
        this.db
          .prepare(
            "INSERT INTO budget_policies VALUES(?,?,?,?,?,?) ON CONFLICT(scope,subject_id) DO UPDATE SET revision=excluded.revision,conversation_limit=excluded.conversation_limit,day_limit=excluded.day_limit,month_limit=excluded.month_limit",
          )
          .run(
            input.scope,
            input.subjectId,
            revision,
            input.conversationLimitMinor,
            input.dayLimitMinor,
            input.monthLimitMinor,
          );
        const receipt: BudgetPolicy = {
          scope: input.scope,
          subjectId: input.subjectId,
          revision,
          conversationLimitMinor: input.conversationLimitMinor,
          dayLimitMinor: input.dayLimitMinor,
          monthLimitMinor: input.monthLimitMinor,
        };
        storeCommandReceipt(this.db, this.clock(), key, input, receipt);
        return receipt;
      })
      .immediate();
  }
}

const dayMs = 86_400_000;

export function budgetWindowUtc(now: string, timeZone = process.env.FRAME_BUDGET_TZ ?? "Asia/Shanghai") {
  const dates = new Intl.DateTimeFormat("en", { timeZone, calendar: "iso8601",
    numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" });
  const localParts = (ms: number) => Object.fromEntries(dates.formatToParts(ms).map(part => [part.type, part.value]));
  const { year, month, day } = localParts(Date.parse(now));
  function startOfLocalDate(calendarDate: number) {
    // 以本地日历日期找首个对应的 UTC 毫秒，覆盖时区的 23/25 小时自然日与午夜跳变。
    const target = new Date(calendarDate).toISOString().slice(0, 10);
    let first = calendarDate - dayMs;
    let last = calendarDate + dayMs;
    while (first < last) {
      const mid = first + Math.floor((last - first) / 2);
      const parts = localParts(mid);
      const key = [parts.year, parts.month, parts.day].join("-");
      if (key < target) first = mid + 1;
      else last = mid;
    }
    return new Date(first).toISOString();
  }
  return {
    timeZone: dates.resolvedOptions().timeZone,
    dayStart: startOfLocalDate(Date.UTC(Number(year), Number(month) - 1, Number(day))),
    dayEnd: startOfLocalDate(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1)),
    monthStart: startOfLocalDate(Date.UTC(Number(year), Number(month) - 1, 1)),
    monthEnd: startOfLocalDate(Date.UTC(Number(year), Number(month), 1)),
  };
}

function applicablePolicies(db: AgentDatabase, ownerId: string) {
  return db.prepare("SELECT " + fields +
    " FROM budget_policies WHERE (scope='user' AND subject_id=?) OR (scope='workspace' AND subject_id='default')")
    .all(ownerId) as BudgetPolicy[];
}

function budgetUsage(db: AgentDatabase, scope: BudgetPolicy["scope"], ownerId: string, conversationId: string | null,
  window: ReturnType<typeof budgetWindowUtc>, policy: BudgetPolicy | undefined): BudgetUsage {
  const runs = db.prepare(
    "SELECT r.* FROM production_runs r WHERE r.proposal_id IS NOT NULL" +
    (scope === "user" ? " AND r.owner_id=?" : "") +
    // 在途运行不分窗口（钱可能已经花出去）；终态运行的已结与待核费用都只归到创建它的日/月窗口，
    // 没有外部账单时待核费用不会永久占住之后每一天、每一月的额度。
    " AND (r.conversation_id=? OR r.state NOT IN ('succeeded','failed','cancelled') OR (r.created_at>=? AND r.created_at<?))",
  ).all(...(scope === "user" ? [ownerId] : []), conversationId, window.monthStart, window.monthEnd) as RunRow[];
  let conversation = 0, day = 0, month = 0;
  for (const run of runs) {
    const f = finances(db, run);
    const held = f.reservedMinor + f.pendingUnknownMinor;
    const inFlight = !terminal(run.state);
    const inDay = run.created_at >= window.dayStart && run.created_at < window.dayEnd;
    const inMonth = run.created_at >= window.monthStart && run.created_at < window.monthEnd;
    if (run.conversation_id === conversationId) conversation += f.settledMinor + held;
    day += (inFlight || inDay ? held : 0) + (inDay ? f.settledMinor : 0);
    month += (inFlight || inMonth ? held : 0) + (inMonth ? f.settledMinor : 0);
  }
  const period = (limitMinor: number | null, usedMinor: number): BudgetPeriod => ({
    limitMinor, usedMinor, remainingMinor: limitMinor === null ? null : Math.max(0, limitMinor - usedMinor),
  });
  return {
    conversation: conversationId === null ? null : period(policy?.conversationLimitMinor ?? null, conversation),
    day: period(policy?.dayLimitMinor ?? null, day),
    month: period(policy?.monthLimitMinor ?? null, month),
  };
}

export function checkBudget(db: AgentDatabase, ownerId: string, conversationId: string, now: string, amount: number) {
  if (amount === 0) return;
  const policies = applicablePolicies(db, ownerId).filter(p =>
    p.conversationLimitMinor !== null || p.dayLimitMinor !== null || p.monthLimitMinor !== null);
  if (!policies.length) return;
  const window = budgetWindowUtc(now);
  for (const policy of policies) {
    const usage = budgetUsage(db, policy.scope, ownerId, conversationId, window, policy);
    for (const [label, period] of [["本会话", usage.conversation], ["今日", usage.day], ["本月", usage.month]] as const) {
      const remaining = period?.remainingMinor;
      if (remaining !== undefined && remaining !== null && amount > remaining) {
        throw new AgentError("BUDGET_LIMIT_EXCEEDED",
          (policy.scope === "workspace" ? "共享空间" : "本账号") + label +
          "剩余额度 ¥" + (remaining / 100).toFixed(2) + "，本次需授权 ¥" + (amount / 100).toFixed(2) + "。");
      }
    }
  }
}
