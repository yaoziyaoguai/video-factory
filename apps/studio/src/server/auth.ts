import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const COOKIE_NAME = "vf_session";
const HASH_PREFIX = "scrypt:v1";
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_ATTEMPT_LIMIT = 5;

export interface StudioAuthOptions {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  secureCookie: boolean;
  sessionTtlSeconds?: number;
  loginWindowMs?: number;
  loginAttemptLimit?: number;
  now?: () => number;
}

export function readStudioAuthEnvironment(
  environment: NodeJS.ProcessEnv,
  policy: { required: boolean; secureCookie: boolean },
): StudioAuthOptions | undefined {
  const username = environment.VIDEO_FACTORY_AUTH_USERNAME?.trim();
  const passwordHash = environment.VIDEO_FACTORY_AUTH_PASSWORD_HASH?.trim();
  const sessionSecret = environment.VIDEO_FACTORY_AUTH_SESSION_SECRET?.trim();
  if (!username && !passwordHash && !sessionSecret && !policy.required) return undefined;

  const missing = [
    !username && "VIDEO_FACTORY_AUTH_USERNAME",
    !passwordHash && "VIDEO_FACTORY_AUTH_PASSWORD_HASH",
    !sessionSecret && "VIDEO_FACTORY_AUTH_SESSION_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Studio authentication requires ${missing.join(", ")}.`);

  return {
    username: username!,
    passwordHash: passwordHash!,
    sessionSecret: sessionSecret!,
    secureCookie: policy.secureCookie,
    ...(environment.VIDEO_FACTORY_AUTH_SESSION_TTL_SECONDS
      ? { sessionTtlSeconds: parsePositiveEnvironmentInteger(environment.VIDEO_FACTORY_AUTH_SESSION_TTL_SECONDS, "VIDEO_FACTORY_AUTH_SESSION_TTL_SECONDS") }
      : {}),
  };
}

interface SessionPayload {
  version: 1;
  username: string;
  expiresAt: number;
  nonce: string;
}

interface LoginWindow {
  attempts: number;
  startedAt: number;
}

export class StudioAuthenticator {
  private readonly sessionTtlSeconds: number;
  private readonly loginWindowMs: number;
  private readonly loginAttemptLimit: number;
  private readonly now: () => number;
  private readonly loginWindows = new Map<string, LoginWindow>();

  constructor(private readonly options: StudioAuthOptions) {
    if (!options.username.trim()) throw new Error("Studio auth username is required.");
    if (options.sessionSecret.length < 32) throw new Error("Studio auth session secret must contain at least 32 characters.");
    parsePasswordHash(options.passwordHash);
    this.sessionTtlSeconds = positiveInteger(options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS, "session TTL");
    this.loginWindowMs = positiveInteger(options.loginWindowMs ?? DEFAULT_LOGIN_WINDOW_MS, "login window");
    this.loginAttemptLimit = positiveInteger(options.loginAttemptLimit ?? DEFAULT_LOGIN_ATTEMPT_LIMIT, "login attempt limit");
    this.now = options.now ?? Date.now;
  }

  authenticate(username: string, password: string, clientId: string): "accepted" | "rejected" | "limited" {
    const now = this.now();
    const window = this.currentLoginWindow(clientId, now);
    if (window.attempts >= this.loginAttemptLimit) return "limited";

    const validUsername = safeTextEqual(username, this.options.username);
    const validPassword = verifyPassword(password, this.options.passwordHash);
    if (!validUsername || !validPassword) {
      window.attempts += 1;
      return "rejected";
    }
    this.loginWindows.delete(clientId);
    return "accepted";
  }

  createSessionCookie(): string {
    const payload: SessionPayload = {
      version: 1,
      username: this.options.username,
      expiresAt: this.now() + this.sessionTtlSeconds * 1000,
      nonce: randomBytes(12).toString("base64url"),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.sign(encoded);
    return serializeCookie(`${encoded}.${signature}`, this.sessionTtlSeconds, this.options.secureCookie);
  }

  clearSessionCookie(): string {
    return serializeCookie("", 0, this.options.secureCookie);
  }

  authenticatedUsername(cookieHeader: string | undefined): string | undefined {
    const token = readCookie(cookieHeader, COOKIE_NAME);
    if (!token) return undefined;
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) return undefined;
    const expected = this.sign(encoded);
    if (!safeTextEqual(signature, expected)) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
      if (payload.version !== 1 || payload.username !== this.options.username || typeof payload.expiresAt !== "number") {
        return undefined;
      }
      return payload.expiresAt > this.now() ? payload.username : undefined;
    } catch {
      return undefined;
    }
  }

  private sign(value: string): string {
    return createHmac("sha256", this.options.sessionSecret).update(value).digest("base64url");
  }

  private currentLoginWindow(clientId: string, now: number): LoginWindow {
    const current = this.loginWindows.get(clientId);
    if (current && now - current.startedAt < this.loginWindowMs) return current;
    const next = { attempts: 0, startedAt: now };
    this.loginWindows.set(clientId, next);
    return next;
  }
}

export function createPasswordHash(password: string, salt = randomBytes(16)): string {
  if (!password) throw new Error("Password is required.");
  const derived = scryptSync(password, salt, 32);
  return `${HASH_PREFIX}:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

function verifyPassword(password: string, encodedHash: string): boolean {
  const { salt, expected } = parsePasswordHash(encodedHash);
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

function parsePasswordHash(value: string): { salt: Buffer; expected: Buffer } {
  const [algorithm, version, encodedSalt, encodedHash, extra] = value.split(":");
  if (`${algorithm}:${version}` !== HASH_PREFIX || !encodedSalt || !encodedHash || extra) {
    throw new Error("Studio auth password hash is invalid.");
  }
  const salt = Buffer.from(encodedSalt, "base64url");
  const expected = Buffer.from(encodedHash, "base64url");
  if (salt.length < 8 || expected.length !== 32) throw new Error("Studio auth password hash is invalid.");
  return { salt, expected };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return undefined;
}

function serializeCookie(value: string, maxAge: number, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Studio auth ${label} must be a positive integer.`);
  return value;
}

function parsePositiveEnvironmentInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
