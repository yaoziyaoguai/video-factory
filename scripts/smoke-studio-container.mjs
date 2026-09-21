import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPasswordHash } from "/app/apps/studio/dist/server/server/auth.js";

// 在禁网、无真实凭据和数据卷的候选镜像里，验证正式入口及非 root 文件权限。
assert.notEqual(process.getuid(), 0, "Studio smoke must run as the image's non-root user");
const workspace = await mkdtemp(path.join(tmpdir(), "vf-studio-smoke-"));
const child = spawn(process.execPath, ["apps/studio/dist/server/server/main.js"], {
  cwd: "/app",
  env: {
    ...process.env,
    STUDIO_DEV: "0",
    STUDIO_HOST: "127.0.0.1",
    STUDIO_PORT: "4317",
    VIDEO_FACTORY_WORKSPACE: workspace,
    VIDEO_FACTORY_AUTH_USERNAME: "container-smoke",
    VIDEO_FACTORY_AUTH_PASSWORD_HASH: createPasswordHash("isolated-smoke-only"),
    VIDEO_FACTORY_AUTH_SESSION_SECRET: "isolated-smoke-only-not-a-production-secret",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let diagnostic = "";
child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
let closed = false;
const completion = new Promise(resolve => {
  child.once("error", error => { diagnostic = error.message; });
  child.once("close", () => { closed = true; resolve(); });
});
const base = "http://127.0.0.1:4317";
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    assert.equal(closed, false, `Studio exited before readiness: ${diagnostic}`);
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
    if (health?.ok && (await health.json()).status === "ok") { ready = true; break; }
    await delay(250);
  }
  assert.equal(ready, true, `Studio never became ready: ${diagnostic}`);
  assert.equal((await fetch(`${base}/api/runs`, { signal: AbortSignal.timeout(5000) })).status, 401);
  const page = await fetch(base, { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="root"/);
  console.log("Non-root production Studio startup, health, static page and authentication boundary passed; no production tasks submitted.");
} finally {
  child.kill("SIGTERM");
  await Promise.race([completion, delay(2000)]);
  if (!closed) child.kill("SIGKILL");
  await completion;
}
