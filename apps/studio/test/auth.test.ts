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

  it("limits repeated failed logins for one client", () => {
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

    assert.equal(auth.authenticate("owner", "wrong", "127.0.0.1"), "rejected");
    assert.equal(auth.authenticate("owner", "wrong-again", "127.0.0.1"), "rejected");
    assert.equal(auth.authenticate("owner", "correct password", "127.0.0.1"), "limited");
    now += 1_001;
    assert.equal(auth.authenticate("owner", "correct password", "127.0.0.1"), "accepted");
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
});
