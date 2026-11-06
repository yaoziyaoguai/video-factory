import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const { createPasswordHash } = await import(pathToFileURL(path.resolve("apps/studio/dist/server/server/auth.js")).href);
const port = process.env.SMOKE_PORT ?? "4317";

// 在禁网、无真实凭据和数据卷的候选镜像里，验证正式入口及非 root 文件权限。
assert.notEqual(process.getuid(), 0, "Studio smoke must run as the image's non-root user");
const workspace = await mkdtemp(path.join(tmpdir(), "vf-studio-smoke-"));
const child = spawn(process.execPath, ["apps/studio/dist/server/server/main.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    STUDIO_DEV: "0",
    STUDIO_HOST: "127.0.0.1",
    STUDIO_PORT: port,
    VIDEO_FACTORY_WORKSPACE: workspace, HOME: workspace, AGENT_UI_ORIGIN: "https://frame.example",
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
const base = `http://127.0.0.1:${port}`;
let complete = false;
try {
  let ready = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    assert.equal(closed, false, `Studio exited before readiness: ${diagnostic}`);
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
    if (health?.ok && (await health.json()).release === process.env.RELEASE_SHA) { ready = true; break; }
    await delay(250);
  }
  assert.equal(ready, true, `Studio never became ready: ${diagnostic}`);
  for (const route of ["/bootstrap", "/settings/model-connections"]) {
    assert.equal((await fetch(base + "/api/agent/v1" + route)).status, 401);
  }
  const login = await fetch(base + "/api/auth/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({username:"container-smoke",password:"isolated-smoke-only"})});
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const skills = await fetch(base + "/api/agent/v1/settings/skills", { headers: {cookie} });
  assert.equal(skills.status, 200);
  assert.ok((await skills.json()).skills.some(s => s.id === "travel-prompt-kit"), "Missing built-in skill in the production image");
  const created = await fetch(base + "/api/agent/v1/conversations", {method:"POST", headers:{ cookie, origin:"https://frame.example", "content-type":"application/json", "x-video-factory-request":"studio"}, body:JSON.stringify({commandId:"cmd-container-smoke", title:"Container smoke"})});
  assert.equal(created.status, 201, await created.text());
  const page = await fetch(base + "/agent", { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="root"/);
  complete = true;
  console.log("Non-root production Studio startup, health, static page and authentication boundary passed; no production tasks submitted.");
} finally {
  child.kill("SIGTERM");
  await Promise.race([completion, delay(5000)]);
  if (!closed) child.kill("SIGKILL");
  await completion;
  if (complete) assert.equal(child.signalCode, null, `Studio did not close gracefully: ${child.signalCode}`);
  if (complete) assert.equal(child.exitCode, 0, `Studio shutdown failed: ${diagnostic}`);
}
console.log("Production Studio handled SIGTERM and exited naturally with code 0.");
