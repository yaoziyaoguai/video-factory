import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StudioAuthenticator,
  createPasswordHash,
  readStudioAuthEnvironment,
} from "../src/server/auth.js";

describe("studio authentication", () => {
  it("requires complete hashed credentials in production", () => {
    assert.throws(
      () => readStudioAuthEnvironment({}, { required: true, secureCookie: true }),
      /VIDEO_FACTORY_AUTH_USERNAME/,
    );
    assert.equal(readStudioAuthEnvironment({}, { required: false, secureCookie: false }), undefined);

    const auth = readStudioAuthEnvironment({
      VIDEO_FACTORY_AUTH_USERNAME: "owner",
      VIDEO_FACTORY_AUTH_PASSWORD_HASH: createPasswordHash("long password", Buffer.from("test-salt")),
      VIDEO_FACTORY_AUTH_SESSION_SECRET: "a-session-secret-with-at-least-32-characters",
    }, { required: true, secureCookie: true });

    assert.equal(auth?.username, "owner");
    assert.equal(auth?.secureCookie, true);
  });

  it("limits repeated failed logins for one client", async () => {
    let now = 1_000;
    const auth = new StudioAuthenticator({
      username: "owner",
      passwordHash: createPasswordHash("correct password", Buffer.from("test-salt")),
      sessionSecret: "a-session-secret-with-at-least-32-characters",
      secureCookie: false,
      loginAttemptLimit: 2,
      loginWindowMs: 1_000,
      now: () => now,
    });

    assert.equal(await auth.authenticate("owner", "wrong", "127.0.0.1"), "rejected");
    assert.equal(await auth.authenticate("owner", "wrong-again", "127.0.0.1"), "rejected");
    assert.equal(await auth.authenticate("owner", "correct password", "127.0.0.1"), "limited");
    now += 1_001;
    assert.equal(await auth.authenticate("owner", "correct password", "127.0.0.1"), "accepted");
  });

  it("counts concurrent login attempts before async verification, keeping the per-window cap", async () => {
    const auth = new StudioAuthenticator({
      username: "owner",
      passwordHash: createPasswordHash("correct password", Buffer.from("test-salt")),
      sessionSecret: "a-session-secret-with-at-least-32-characters",
      secureCookie: false,
      loginAttemptLimit: 5,
      loginWindowMs: 60_000,
      now: () => 1_000,
    });

    // 10 个并发失败请求：同步预计数使第 6 个起立即 limited；若计数滞后于 scrypt await，
    // 全部请求都会越过上限进入校验（回归即 10 拒 0 限）。
    const results = await Promise.all(
      Array.from({ length: 10 }, () => auth.authenticate("owner", "wrong", "127.0.0.1")),
    );
    assert.equal(results.filter(result => result === "rejected").length, 5);
    assert.equal(results.filter(result => result === "limited").length, 5);
  });

  it("rejects an expired signed session", () => {
    let now = 1_000;
    const auth = new StudioAuthenticator({
      username: "owner",
      passwordHash: createPasswordHash("correct password", Buffer.from("test-salt")),
      sessionSecret: "a-session-secret-with-at-least-32-characters",
      secureCookie: false,
      sessionTtlSeconds: 1,
      now: () => now,
    });
    const cookie = auth.createSessionCookie();

    assert.equal(auth.authenticatedUsername(cookie), "owner");
    now += 1_001;
    assert.equal(auth.authenticatedUsername(cookie), undefined);
  });

  it("revokes the session on logout; other sessions keep working", () => {
    let now = 1_000;
    const auth = new StudioAuthenticator({
      username: "owner",
      passwordHash: createPasswordHash("correct password", Buffer.from("test-salt")),
      sessionSecret: "a-session-secret-with-at-least-32-characters",
      secureCookie: false,
      sessionTtlSeconds: 3_600,
      now: () => now,
    });
    const cookie = auth.createSessionCookie();
    const otherCookie = auth.createSessionCookie();
    assert.equal(auth.authenticatedUsername(cookie), "owner");

    // 登出吊销当前会话：同一签名 Cookie（含被复制的）立即失效，其他会话不受影响。
    auth.revokeSession(cookie);
    assert.equal(auth.authenticatedUsername(cookie), undefined);
    assert.equal(auth.authenticatedUsername(otherCookie), "owner");

    // 伪造/无关 Cookie 不影响吊销逻辑，也不产生副作用。
    auth.revokeSession(undefined);
    auth.revokeSession("vf_session=tampered.payload.sig");
    assert.equal(auth.authenticatedUsername(otherCookie), "owner");

    // 吊销记录随会话自然过期被清理：过期后再签发同名 nonce 不会被误伤（nonce 随机，此处验证清理不抛错且校验如常）。
    now += 3_600_001;
    assert.equal(auth.authenticatedUsername(otherCookie), undefined);
    const fresh = auth.createSessionCookie();
    assert.equal(auth.authenticatedUsername(fresh), "owner");
  });
});
