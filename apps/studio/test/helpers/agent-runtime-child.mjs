// 隔离子进程记录外部边界；只输出计数，不输出路径中的私人数据、凭据或正文。
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import { registerHooks, syncBuiltinESMExports } from "node:module";
const counts = { externalFetch: 0, outboundSockets: 0, secretReads: 0, legacyRuntimeModules: 0 };
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => { counts.externalFetch++; throw new Error("offline provider attempted fetch"); };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // 此入口只需要监听和响应，不应主动建立供应商连接。
  counts.outboundSockets++; return originalConnect.apply(this, args);
};
const observeRead = target => {
  const file = String(target);
  if (/(^|\/)\.env($|[./])|\/.local\/secrets\/|\/\.pi\/|auth\.json$/.test(file)) counts.secretReads++;
};
const readSync = fs.readFileSync, readAsync = fsp.readFile;
fs.readFileSync = function (file, ...args) { observeRead(file); return readSync.call(this, file, ...args); };
fsp.readFile = async function (file, ...args) { observeRead(file); return readAsync.call(this, file, ...args); };
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  // 按旧实现的真实位置识别；新 Agent 的 production-worker 不是旧编排器。
  if (/\/src\/server\/(studio-service|production-worker)\.|\/packages\/codex-broker\//.test(resolved.url)) counts.legacyRuntimeModules++;
  return resolved;
} });
const { assembleOfflineAgent } = await import("../../src/server/agent/offline.ts");
const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
const [directory, port] = process.argv.slice(2);
const assembly = await assembleOfflineAgent({ dataDir: directory, uiOrigin: `http://127.0.0.1:${port}`, fauxTokensPerSecond: 100,
  fauxResponses: [fauxAssistantMessage("只用于验证尚未保存的流式输出。".repeat(300))] });
await assembly.app.listen({ host: "127.0.0.1", port: Number(port) });
process.stdout.write(`${JSON.stringify({ event: "listening", counts })}\n`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await assembly.close();
  process.stdout.write(`${JSON.stringify({ event: "closed", counts })}\n`);
  globalThis.fetch = originalFetch;
  process.exit(0);
}
process.once("SIGINT", close); process.once("SIGTERM", close);
