import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { AgentDatabase } from "./db.js";

const tables = ["text_model_versions", "ark_video_configuration_versions", "additional_media_versions", "free_service_settings"] as const;
const sentinel = "Frame credential store v1";
let warned = false;

function cipherFor(secret: string) {
  if (Buffer.byteLength(secret) < 32) throw new Error("FRAME_CREDENTIAL_SECRET 至少需要 32 字节随机密钥。");
  const key = Buffer.from(hkdfSync("sha256", secret, "frame/credentials/v1", "sqlite-api-key", 32));
  return {
    seal(value: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return ["enc", "v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
    },
    open(value: string): string {
      const match = /^enc:v1:([\w-]{16}):([\w-]{22}):([\w-]*)$/.exec(value);
      if (!match) throw new Error("凭据密文格式不正确。");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(match[1]!, "base64url"), { authTagLength: 16 });
      const tag = Buffer.from(match[2]!, "base64url");
      const payload = Buffer.from(match[3]!, "base64url");
      if (tag.toString("base64url") !== match[2] || payload.toString("base64url") !== match[3]) throw new Error("凭据密文格式不正确。");
      decipher.setAuthTag(tag);
      const first = decipher.update(payload);
      try { return Buffer.concat([first, decipher.final()]).toString("utf8"); }
      catch (cause) { throw new Error("凭据认证失败，请检查密钥或恢复完整的凭据记录。", { cause }); }
    },
  };
}

function rewriteKeys(db: AgentDatabase, transform: (value: string) => string): void {
  for (const table of tables) {
    const update = db.prepare(`UPDATE ${table} SET api_key=? WHERE rowid=?`);
    const rows = db.prepare(`SELECT rowid,api_key FROM ${table} WHERE api_key IS NOT NULL`).all() as { rowid: number; api_key: string }[];
    for (const row of rows) update.run(transform(row.api_key), row.rowid);
  }
  const connections = db.prepare("SELECT id,json_extract(configuration_json,'$.apiKey') AS key FROM provider_connections WHERE json_extract(configuration_json,'$.apiKey') IS NOT NULL").all() as { id: string; key: string }[];
  const update = db.prepare("UPDATE provider_connections SET configuration_json=json_set(configuration_json,'$.apiKey',?) WHERE id=?");
  for (const row of connections) update.run(transform(row.key), row.id);
}

function scrub(db: AgentDatabase): void {
  db.exec("VACUUM");
  const [checkpoint] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
  if (checkpoint?.busy !== 0) throw new Error("数据库尚有读取者，请关闭其他进程后完成凭据迁移。");
  db.prepare("UPDATE credential_encryption_state SET needs_scrub=0 WHERE id=1").run();
}

export function configureCredentialCipher(db: AgentDatabase, secret: string | undefined): void {
  const read = db.prepare("SELECT verifier,needs_scrub FROM credential_encryption_state WHERE id=1");
  if (!secret) {
    if (read.get()) throw new Error("此数据库已加密，需要原 FRAME_CREDENTIAL_SECRET。");
    if (!warned) { warned = true; process.emitWarning("本地开发库未设置 FRAME_CREDENTIAL_SECRET，保存的测试凭据将以明文存储。"); }
    db.function("frame_seal", { directOnly: true }, (value: string | null) => value);
    db.function("frame_open", { directOnly: true }, (value: string | null) => value);
    return;
  }
  const cipher = cipherFor(secret);
  const needsScrub = db.transaction(() => {
    const state = read.get() as { verifier: string; needs_scrub: number } | undefined;
    if (state) {
      if (cipher.open(state.verifier) !== sentinel) throw new Error("凭据主密钥校验失败。");
      return state.needs_scrub === 1;
    }
    rewriteKeys(db, cipher.seal);
    db.prepare("INSERT INTO credential_encryption_state(id,verifier,needs_scrub) VALUES (1,?,1)").run(cipher.seal(sentinel));
    return true;
  }).immediate();
  if (needsScrub) scrub(db);
  db.function("frame_seal", { directOnly: true }, (value: string | null) => value === null ? null : cipher.seal(value));
  db.function("frame_open", { directOnly: true }, (value: string | null) => value === null ? null : cipher.open(value));
}

export function rotateCredentialSecret(db: AgentDatabase, current: string, next: string): void {
  const from = cipherFor(current), to = cipherFor(next);
  db.transaction(() => {
    const row = db.prepare("SELECT verifier FROM credential_encryption_state WHERE id=1").pluck().get() as string | undefined;
    if (!row || from.open(row) !== sentinel) throw new Error("旧凭据主密钥校验失败。");
    rewriteKeys(db, value => to.seal(from.open(value)));
    db.prepare("UPDATE credential_encryption_state SET verifier=?,needs_scrub=1 WHERE id=1").run(to.seal(sentinel));
  }).exclusive();
  configureCredentialCipher(db, next);
}
