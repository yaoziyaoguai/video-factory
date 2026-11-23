// 发布演练专用。在隔离的测试站点复用与正式入口相同的标记与 Nginx include。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const [http, https] = process.argv.slice(2).map(value => new URL(value));
assert.equal(http.protocol, "http:");
assert.equal(https.protocol, "https:");
const origins = [http, https];
const setEntry = mode => execFileSync("sh", [fileURLToPath(new URL("./frame-release-entry.sh", import.meta.url)), mode]);
const responses = async pathname => Promise.all(origins.map(async origin => {
  const response = await fetch(new URL(pathname, origin), { redirect: "manual" });
  await response.arrayBuffer();
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), geolocation=(), microphone=()");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  if (response.status === 503) assert.equal(response.headers.get("retry-after"), "3");
  return response;
}));
const statuses = async pathname => (await responses(pathname)).map(response => response.status);
const initial = await responses("/agent");
assert.deepEqual(initial.map(response => response.status), [301, 200]);
assert.equal(initial[0].headers.get("location"), new URL("/agent", https).href);
const measurements = [];
for (let index = 0; index < 3; index++) {
  const start = performance.now();
  setEntry("close");
  let opened;
  try {
    assert.deepEqual(await statuses("/agent"), [503, 503]);
    measurements.push(performance.now() - start);
    assert.deepEqual(await statuses("/api/health"), [200, 200]);
  } finally { opened = performance.now(); setEntry("open"); }
  assert.deepEqual(await statuses("/agent"), [301, 200]);
  measurements.push(performance.now() - opened);
}
console.log(JSON.stringify({ http: "301 -> 503 -> 301", https: "200 -> 503 -> 200", securityHeaders: 5, publicHealth: 200, switchMs: measurements }));
assert.ok(measurements.every(ms => ms < 200), "HTTP 与 HTTPS 须在 200 ms 内同时完成切换");
