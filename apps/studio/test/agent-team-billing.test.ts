import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildFrameApp } from "../src/server/agent/app.js";
import { createPasswordHash } from "../src/server/auth.js";
import { BillingStatements } from "../src/server/agent/billing-statements.js";
import { encodeListCursor } from "../src/server/agent/paging.js";
import { EventHub } from "../src/server/agent/event-log.js";
import {
  finances,
  runRow,
  type AttemptRow,
} from "../src/server/agent/production-store.js";
import {
  StudioAccountsStore,
  budgetWindowUtc,
  checkBudget,
} from "../src/server/agent/studio-accounts.js";
import type {
  StatementLine,
  StudioAccounts,
} from "../src/shared/agent/generated/contracts.js";
import { buildLocalRuntime } from "./helpers/native-render.js";
import { productionHarness } from "./helpers/production-harness.js";
import { seedConfirmedWork } from "./helpers/creative-work-fixture.js";

test("CAP-07 两个真实签名登录态分别持有会话、作品、媒体，管理员旧工作区可读，预算耗尽仍能讨论", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-team-")),
    rt = await buildLocalRuntime(dir);
  const root = "/api/agent/v1",
    origin = "http://studio.test",
    password = "Team-local-fixture-2026";
  const old = rt.service.createConversation("admin", {
    commandId: "legacy",
    title: "旧的管理员作品",
  }).conversation.id;
  const app = buildFrameApp({
    agent: {
      service: rt.service,
      uiOrigin: origin,
      resolveOwner: () => undefined,
    },
    auth: {
      username: "admin",
      passwordHash: createPasswordHash(password),
      sessionSecret: "fixture-session-secret-for-two-account-verification",
      secureCookie: false,
    },
  });
  t.after(async () => {
    await app.close();
    await rt.close();
    await rm(dir, { force: true, recursive: true });
  });
  const post = (url: string, body: object, cookie = "") =>
    app.inject({
      method: "POST",
      url,
      headers: {
        origin,
        host: "studio.test",
        cookie,
        "x-video-factory-request": "studio",
      },
      payload: body,
    });
  const get = (url: string, cookie: string) =>
    app.inject({ url: root + url, headers: { cookie } });
  async function login(username: string, credential = password) {
    const r = await post("/api/auth/login", { username, password: credential });
    assert.equal(r.statusCode, 200, r.body);
    return String(r.headers["set-cookie"]).split(";")[0]!;
  }
  const admin = await login("admin");
  assert.equal((await get("/conversations/" + old, admin)).statusCode, 200);
  const accounts = async (name: string, revision: number) => {
    const input = {
      commandId: name,
      expectedRevision: revision,
      username: name,
      password,
      role: "creator",
    };
    const r = await post(root + "/settings/accounts", input, admin);
    assert.equal(r.statusCode, 201, r.body);
    assert.doesNotMatch(r.body, /scrypt|password|Team-local/);
    assert.deepEqual(
      (await post(root + "/settings/accounts", input, admin)).json(),
      r.json(),
    );
    assert.equal(
      (
        await post(
          root + "/settings/accounts",
          { ...input, password: "changed-fixture-secret" },
          admin,
        )
      ).statusCode,
      409,
    );
    return (r.json() as StudioAccounts).accounts.find(
      (x) => x.username === name,
    )!;
  };
  const a = await accounts("creator-a", 1),
    b = await accounts("creator-b", 2);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, a.username);
  assert.equal(
    (
      await post(
        root + "/settings/accounts",
        {
          commandId: "stale-join",
          expectedRevision: 1,
          username: "creator-c",
          password,
          role: "creator",
        },
        admin,
      )
    ).statusCode,
    409,
  );
  const cookies = await Promise.all([login(a.username), login(b.username)]);
  const oldCount = rt.database
    .prepare("SELECT count(*) FROM studio_users")
    .pluck()
    .get();
  assert.equal(oldCount, 3);
  for (const [i, account] of [a, b].entries()) {
    const own = cookies[i]!,
      other = cookies[1 - i]!;
    for (const url of [
      "/settings/accounts",
      "/settings/budgets",
      "/settings/model-connections",
      "/settings/skills",
    ]) {
      const r = await get(url, own);
      assert.equal(r.statusCode, 403, url + " " + r.body);
    }
    const bootstrap = await get("/bootstrap", own);
    assert.equal(bootstrap.json().accountRole, "creator");
    const created = await post(
      root + "/conversations",
      { commandId: "same-command", title: account.username },
      own,
    );
    assert.equal(created.statusCode, 201, created.body);
    const cid = created.json().id,
      work = seedConfirmedWork(rt.database, "2026-10-28T00:00:00.000Z", {
        conversationId: cid,
        ownerId: account.id,
      });
    assert.ok(work.content.kind === "artifact_revision");
    const ownBudget = await get("/profile/budget?conversationId=" + cid, own);
    assert.equal(ownBudget.statusCode, 200, ownBudget.body);
    assert.equal(ownBudget.headers["cache-control"], "private, no-store");
    assert.equal(ownBudget.headers["x-content-type-options"], "nosniff");
    assert.equal(ownBudget.json().conversationId, cid);
    assert.equal((await get("/profile/budget?conversationId=" + cid, other)).statusCode, 404);
    const blob = await rt.production!.blobs.persistFromStream(
      account.id,
      cid,
      Readable.from(["private content " + i]),
      "text/plain",
      null,
    );
    const urls = [
      "/conversations/" + cid,
      "/conversations/" + cid + "/snapshot",
      "/artifacts/" +
        work.content.artifactId +
        "/revisions/" +
        work.content.revisionId,
      "/blobs/" + blob.id + "/content",
      "/artifacts/" +
        work.content.artifactId +
        "/revisions/" +
        work.content.revisionId +
        "/archive.zip",
    ];
    urls.push(
      "/library/videos?cursor=" +
        encodeListCursor({ v: 1, c: account.id, k: "library", p: 1, w: 1 }),
    );
    for (const url of urls) {
      const r = await get(url, other);
      assert.equal(r.statusCode, 404, url + " " + r.body);
      assert.equal(r.json().code, "NOT_FOUND");
    }
    assert.equal((await get(urls[3]!, own)).body, "private content " + i);
    assert.ok(!(await get("/conversations", other)).body.includes(cid));
    assert.ok(
      !(await get("/library/videos", other)).body.includes(
        work.content.revisionId,
      ),
    );
    const budget = await post(
      root + "/settings/budgets",
      {
        scope: "user",
        subjectId: account.id,
        expectedRevision: 0,
        commandId: "zero-" + i,
        conversationLimitMinor: null,
        dayLimitMinor: null,
        monthLimitMinor: 0,
      },
      admin,
    );
    assert.equal(budget.statusCode, 200, budget.body);
    assert.equal((await get("/profile/budget?conversationId=" + cid, own)).json().effectiveRemainingMinor, 0);
    rt.host.faux!.setResponses([fauxAssistantMessage("已经完成文稿讨论。")]);
    const msg = await post(
      root + "/conversations/" + cid + "/messages",
      {
        commandId: "free-chat",
        text: "核对文稿",
        target: null,
        skillId: null,
        proposalRef: null,
        mode: "new",
        steerRequestId: null,
      },
      own,
    );
    assert.ok([200, 201, 202].includes(msg.statusCode), msg.body);
    const deadline = Date.now() + 6000;
    while (
      !rt.database
        .prepare(
          "SELECT 1 FROM messages WHERE owner_id=? AND conversation_id=? AND role='assistant' AND text LIKE '%文稿讨论%'",
        )
        .get(account.id, cid)
    ) {
      assert.ok(Date.now() < deadline, "免费文稿未完成");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const patch = (username: string, payload: object, cookie = admin) => app.inject({
    method: "PATCH", url: root + "/settings/accounts/" + username, payload,
    headers: { origin, host: "studio.test", cookie, "x-video-factory-request": "studio" },
  });
  assert.equal((await patch("admin", { commandId: "self-disable", expectedRevision: 3, disabled: true })).statusCode, 403);
  assert.equal((await patch("admin", { commandId: "self-demote", expectedRevision: 3, role: "creator" })).statusCode, 403);
  const disable = { commandId: "disable-a", expectedRevision: 3, disabled: true };
  assert.equal((await patch(a.username, disable, cookies[1])).statusCode, 403);
  const disabled = await patch(a.username, disable);
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().revision, 4);
  assert.ok(disabled.json().accounts.find((account: StudioAccounts["accounts"][number]) => account.id === a.id).disabledAt);
  assert.deepEqual((await patch(a.username, disable)).json(), disabled.json());
  assert.equal((await get("/bootstrap", cookies[0]!)).statusCode, 401);
  assert.equal((await post("/api/auth/login", { username: a.username, password })).statusCode, 401);
  const newPassword = "Team-new-fixture-secret";
  const rotated = { commandId: "reset-a", expectedRevision: 4, password: newPassword, disabled: false };
  const reset = await patch(a.username, rotated);
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().revision, 5);
  assert.doesNotMatch(reset.body, /scrypt|password|Team-new/);
  assert.equal((await patch(a.username, { ...rotated, password })).statusCode, 409);
  assert.equal((await get("/bootstrap", cookies[0]!)).statusCode, 401, "恢复账号后旧 Cookie 仍无效");
  assert.equal((await post("/api/auth/login", { username: a.username, password })).statusCode, 401);
  const fresh = await login(a.username, newPassword);
  assert.equal((await get("/bootstrap", fresh)).statusCode, 200);
  const session = await app.inject({ url: "/api/auth/session", headers: { cookie: fresh } });
  assert.equal(session.json().ownerId, a.id);
  const selfReset = await patch("admin", { commandId: "reset-admin", expectedRevision: 5, password: newPassword });
  assert.equal(selfReset.statusCode, 200, selfReset.body);
  assert.equal((await get("/bootstrap", admin)).statusCode, 401);
  rt.service.accounts.bootstrap("admin", createPasswordHash(password));
  assert.equal((await get("/conversations/" + old, await login("admin", newPassword))).statusCode, 200);
  t.diagnostic(
    "2 个独立创作者登录，12 个带身份的跨账号资源读返回 404，2 次零额度文稿回合完成",
  );
});

test("CAP-07 同一共享预算下竞争的两份付费提案，等待账单、调减和重放均原子结算", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-budget-")),
    now = "2026-11-21T22:00:00.000Z";
  const ha = productionHarness(dir, now, undefined, false, {
      owner: "paid-a",
      conversation: "conv-a",
      billing: null,
    }),
    hb = productionHarness(dir, now, undefined, false, {
      owner: "paid-b",
      conversation: "conv-b",
      billing: null,
    });
  const db = ha.db,
    hub = new EventHub(),
    feed = path.join(dir, "bill.ndjson");
  let instant = now;
  const reconcile = new BillingStatements(db, () => instant, hub, feed);
  t.after(async () => {
    await reconcile.close();
    hub.close();
    await hb.close();
    await ha.close();
    await rm(dir, { force: true, recursive: true });
  });
  const store = new StudioAccountsStore(db, () => instant);
  store.bootstrap("paid-b", createPasswordHash("local-test"));
  const policy = {
    scope: "workspace" as const,
    subjectId: "default",
    commandId: "quota",
    expectedRevision: 0,
    conversationLimitMinor: null,
    dayLimitMinor: null,
    monthLimitMinor: 1200,
  };
  const saved = store.saveBudget("admin", policy);
  assert.deepEqual(store.saveBudget("admin", policy), saved);
  assert.throws(
    () => store.saveBudget("admin", { ...policy, commandId: "outdated" }),
    { code: "STALE_REVISION" },
  );
  const contenders = await Promise.allSettled([
    Promise.resolve().then(() => ha.accept()),
    Promise.resolve().then(() => hb.accept()),
  ]);
  assert.deepEqual(
    contenders.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(
    (contenders[1] as PromiseRejectedResult).reason.code,
    "BUDGET_LIMIT_EXCEEDED",
  );
  const before = () =>
    [
      "production_runs",
      "command_receipts",
      "authorizations",
      "user_actions",
      "requests",
      "messages",
      "work_review_confirmations",
    ].map((table) =>
      db
        .prepare("SELECT count(*) FROM " + table)
        .pluck()
        .get(),
    );
  const counts = before(),
    bound = {
      commandId: "bound",
      text: "确认继续",
      target: null,
      skillId: null,
      proposalRef: { proposalId: hb.proposal.id, digest: hb.proposal.digest },
      mode: "new" as const,
      steerRequestId: null,
    };
  assert.throws(() => hb.service.acceptMessage("paid-b", "conv-b", bound), {
    code: "BUDGET_LIMIT_EXCEEDED",
  });
  assert.deepEqual(before(), counts);
  assert.ok(ha.accept().replayed);
  const run = ha.accept().run;
  for (let i = 0; i < 8 && runRow(db, run.id).state !== "succeeded"; i++)
    await ha.worker.pollOnce();
  const position = () => finances(db, runRow(db, run.id));
  assert.equal(position().state, "pending_reconciliation");
  assert.ok(position().pendingUnknownMinor > 0);
  const attempt = db
    .prepare("SELECT * FROM production_attempts WHERE run_id=?")
    .get(run.id) as AttemptRow;
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM pending_reconciliation").pluck().get(),
    1,
  );
  const model = JSON.parse(
    db
      .prepare("SELECT spec_json FROM production_operations WHERE run_id=?")
      .pluck()
      .get(run.id) as string,
  ).model;
  const item: StatementLine = {
    providerId: model.providerId,
    connectionId: model.connectionId,
    providerTaskId: attempt.provider_task_id!,
    requestIdentity: attempt.request_identity,
    fact: {
      kind: "authoritative",
      billingFactId: "bill-test-1",
      sourceRevision: "1",
      final: true,
      netAmount: { currency: "CNY", amountMinor: 75 },
      evidenceId: "itemized-1",
    },
  };
  await writeFile(feed, "\n");
  assert.deepEqual(await reconcile.sync(), { parsed: 0, matched: 0 });
  const due = db.prepare("SELECT due_at FROM pending_reconciliation WHERE attempt_id=?").pluck().get(attempt.id);
  instant = new Date(Date.parse(now) + 60_000).toISOString();
  assert.equal(due, new Date(Date.parse(now) + 15 * 60_000).toISOString());
  await writeFile(
    feed,
    [
      { ...item, connectionId: "another-connection" },
      { ...item, requestIdentity: "unmatched" },
      item,
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  assert.deepEqual(await reconcile.sync(), { parsed: 3, matched: 1 });
  assert.deepEqual(await reconcile.sync(), { parsed: 3, matched: 0 });
  assert.equal(position().state, "settled");
  assert.equal(position().settledMinor, 75);
  assert.equal(position().pendingUnknownMinor, 0);
  assert.equal(
    db.prepare("SELECT count(*) FROM pending_reconciliation").pluck().get(),
    0,
  );
  const corrected = {
    ...item,
    fact: {
      ...item.fact,
      sourceRevision: "2",
      netAmount: { currency: "CNY", amountMinor: 40 },
      evidenceId: "credit-note",
    },
  };
  await writeFile(
    feed,
    [item, corrected].map((x) => JSON.stringify(x)).join("\n"),
  );
  assert.deepEqual(await reconcile.sync(), { parsed: 2, matched: 1 });
  assert.equal(position().settledMinor, 40);
  db.prepare("UPDATE production_runs SET created_at=? WHERE id=?").run("2026-11-30T16:05:00.000Z", run.id);
  instant = "2026-11-30T16:06:00.000Z";
  const december = store.budgetSummary("paid-a", "conv-a");
  assert.equal(december.workspace.day.usedMinor, 40);
  assert.equal(december.workspace.month.usedMinor, 40);
  assert.equal(december.effectiveRemainingMinor, 1160);
  assert.throws(() => checkBudget(db, "paid-b", "conv-b", instant, 1161), { code: "BUDGET_LIMIT_EXCEEDED" });
  instant = "2026-12-01T16:00:00.000Z";
  const nextDay = store.budgetSummary("paid-a", "conv-a");
  assert.equal(nextDay.workspace.day.usedMinor, 0);
  assert.equal(nextDay.workspace.month.usedMinor, 40);
  db.prepare("UPDATE production_runs SET created_at=? WHERE id=?").run(now, run.id);
  instant = now;
  assert.throws(() => hb.accept(), { code: "BUDGET_LIMIT_EXCEEDED" });
  assert.doesNotThrow(() => checkBudget(db, "paid-b", "conv-b", now, 0));
  store.saveBudget("admin", {
    ...policy,
    expectedRevision: 1,
    commandId: "share-room",
    monthLimitMinor: 1240,
  });
  const own = {
    ...policy,
    scope: "user" as const,
    subjectId: "paid-b",
    commandId: "individual",
    conversationLimitMinor: 1199,
    monthLimitMinor: null,
  };
  store.saveBudget("admin", own);
  assert.throws(() => hb.accept(), /本会话/);
  store.saveBudget("admin", {
    ...own,
    expectedRevision: 1,
    commandId: "daily",
    conversationLimitMinor: null,
    dayLimitMinor: 1199,
  });
  assert.throws(() => hb.accept(), /今日/);
  store.saveBudget("admin", {
    ...own,
    expectedRevision: 2,
    commandId: "monthly",
    conversationLimitMinor: null,
    monthLimitMinor: 1200,
  });
  assert.equal(
    hb.service.acceptMessage("paid-b", "conv-b", bound).state,
    "completed",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM authorizations").pluck().get(),
    2,
  );
  instant = "2026-12-01T00:01:00.000Z";
  assert.throws(() => checkBudget(db, "paid-b", "other", instant, 1200), {
    code: "BUDGET_LIMIT_EXCEEDED",
  });
  t.diagnostic(
    JSON.stringify({
      competingAdmissions: 2,
      admittedAtSharedCap: 1,
      rejectedWrites: 0,
      pending: position().pendingUnknownMinor,
      invoiceMinor: 75,
      correctedMinor: 40,
      duplicateSettlements: 0,
    }),
  );
});

test("BUG-01 待核费用只占创建它的日/月窗口：跨日、跨月归零；在途运行不分窗口", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-budget-window-"));
  // 上海时间 11-22 06:00，日界为 16:00Z。
  const day = "2026-11-21T22:00:00.000Z";
  const pending = productionHarness(dir, day, undefined, false, { owner: "paid-a", conversation: "conv-a", billing: null }),
    settled = productionHarness(dir, day, undefined, false, { owner: "paid-b", conversation: "conv-b" }),
    inFlight = productionHarness(dir, day, undefined, false, { owner: "paid-c", conversation: "conv-c" });
  const db = pending.db;
  let instant = day;
  const store = new StudioAccountsStore(db, () => instant);
  t.after(async () => {
    await inFlight.close();
    await settled.close();
    await pending.close();
    await rm(dir, { force: true, recursive: true });
  });
  // worker 每次轮询都会认领库里的到期运行并顺带对账：先跑完带默认账单的那份，再让待核运行进场。
  const finish = async (harness: typeof pending): Promise<string> => {
    const run = harness.accept().run;
    for (let i = 0; i < 8 && runRow(db, run.id).state !== "succeeded"; i++) await harness.worker.pollOnce();
    return run.id;
  };
  const settledRun = await finish(settled),
    pendingRun = await finish(pending);
  const unreconciled = finances(db, runRow(db, pendingRun));
  assert.equal(unreconciled.state, "pending_reconciliation");
  assert.ok(unreconciled.pendingUnknownMinor > 0);
  const paid = finances(db, runRow(db, settledRun));
  assert.equal(paid.state, "settled");
  assert.ok(paid.settledMinor > 0);
  const pendingMinor = unreconciled.pendingUnknownMinor,
    settledMinor = paid.settledMinor;
  // 个人日/月用量、空间日/月用量。
  const usage = () => {
    const { personal, workspace } = store.budgetSummary("paid-a", "conv-a");
    return [personal.day.usedMinor, workspace.day.usedMinor, workspace.month.usedMinor];
  };

  assert.deepEqual(usage(), [pendingMinor, pendingMinor + settledMinor, pendingMinor + settledMinor]);
  instant = "2026-11-22T18:00:00.000Z";
  // 次日：待核与已结都只留在创建它的那一天，月额度照常占用。
  assert.deepEqual(usage(), [0, 0, pendingMinor + settledMinor]);
  instant = "2026-12-21T22:00:00.000Z";
  // 次月：没有外部账单的待核费用不再永久占住额度。
  assert.deepEqual(usage(), [0, 0, 0]);

  const policy = {
    scope: "workspace" as const,
    subjectId: "default",
    commandId: "day-cap",
    expectedRevision: 0,
    conversationLimitMinor: null,
    dayLimitMinor: pendingMinor + settledMinor,
    monthLimitMinor: null,
  };
  store.saveBudget("admin", policy);
  instant = day;
  assert.throws(() => checkBudget(db, "paid-a", "conv-x", instant, 1), /今日/);
  instant = "2026-11-22T18:00:00.000Z";
  assert.doesNotThrow(() => checkBudget(db, "paid-a", "conv-x", instant, pendingMinor + settledMinor));

  store.saveBudget("admin", { ...policy, commandId: "no-cap", expectedRevision: 1, dayLimitMinor: null });
  const reserved = finances(db, runRow(db, inFlight.accept().run.id)).reservedMinor;
  assert.ok(reserved > 0);
  // 前一天受理、尚未执行的运行：钱可能已经花出去，次日与次月都照占。
  assert.deepEqual(usage(), [0, reserved, pendingMinor + settledMinor + reserved]);
  instant = "2026-12-21T22:00:00.000Z";
  assert.deepEqual(usage(), [0, reserved, reserved]);
});

test("NEW-01 私网 HTTPS 账单地址在发起请求前拒绝", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-invoice-boundary-"));
  const h = productionHarness(dir, "2026-11-22T00:00:00.000Z", undefined, false);
  const hub = new EventHub();
  t.after(async () => { hub.close(); await h.close(); await rm(dir, { recursive: true, force: true }); });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("私网账单地址不应发起 fetch");
  });
  for (const host of ["127.0.0.1", "[::1]", "100.100.100.200", "localhost"]) {
    const statements = new BillingStatements(h.db, () => "2026-11-22T00:00:00.000Z", hub, "https://" + host + "/statement");
    await assert.rejects(statements.sync(), { code: "FORBIDDEN" });
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("NEW-02 预算的日月边界按所选时区和真实日长计算", () => {
  assert.deepEqual(budgetWindowUtc("2026-11-30T16:05:00.000Z", "Asia/Shanghai"), {
    timeZone: "Asia/Shanghai",
    dayStart: "2026-11-30T16:00:00.000Z", dayEnd: "2026-12-01T16:00:00.000Z",
    monthStart: "2026-11-30T16:00:00.000Z", monthEnd: "2026-12-31T16:00:00.000Z",
  });
  for (const [date, hours] of [["2026-03-08", 23], ["2026-11-01", 25]] as const) {
    const bounds = budgetWindowUtc(date + "T12:00:00Z", "America/New_York");
    assert.equal((Date.parse(bounds.dayEnd) - Date.parse(bounds.dayStart)) / 3_600_000, hours);
  }
});
