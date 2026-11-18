import assert from "node:assert/strict";
import { get } from "node:http";
import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
const origin = process.argv[2];
if (!origin || new URL(origin).hostname !== "127.0.0.1") throw new Error("仅允许环回测试地址");
function request(path, encoding) {
  return new Promise((resolve, reject) => {
    get(new URL(path, origin), { headers: { "accept-encoding": encoding } }, response => {
      const chunks = []; response.on("data", data => chunks.push(data)); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}
// 从 /agent 实际 HTML 动态枚举全部 JS/CSS 引用（不再假设恰好两个资源）。
const html = await request("/agent", "identity");
const assets = [...html.body.toString().matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map(match => match[1]);
assert.ok(assets.length >= 1, `未从 /agent 枚举到任何 JS/CSS 静态资源`);
const results = [];
for (const file of ["/agent", ...assets]) {
  const plain = await request(file, "identity");
  assert.equal(plain.status, 200, `${file}: identity 非 200`);
  for (const encoding of ["br", "gzip"]) {
    const encoded = await request(file, encoding);
    assert.equal(encoded.status, 200, `${file}/${encoding}: 非 200`);
    assert.equal(encoded.headers["content-encoding"], encoding, `${file}: ${encoding} 未生效`);
    assert.match(encoded.headers.vary ?? "", /accept-encoding/i, `${file}: 缺 Vary`);
    assert.equal(encoded.headers["content-type"], plain.headers["content-type"], `${file}: MIME 改变`);
    const decoded = encoding === "br" ? brotliDecompressSync(encoded.body) : gunzipSync(encoded.body);
    assert.deepEqual(decoded, plain.body, `${file}: 解压后字节改变`);
    results.push({ file, encoding, plainBytes: plain.body.length, transferredBytes: encoded.body.length, sha256: createHash("sha256").update(decoded).digest("hex") });
  }
}
// SPA 深链：/agent/<未知路由> 必须返回同一份应用 HTML，而不是 404 或空体。
const deep = await request("/agent/perf-deep-link-check", "identity");
assert.equal(deep.status, 200, "SPA 深链非 200");
assert.match(deep.headers["content-type"] ?? "", /text\/html/, "SPA 深链未返回 HTML");
assert.deepEqual(deep.body, html.body, "SPA 深链未返回应用 HTML");
// API 不回落 HTML：未知 API 路径应返回 JSON 404，而不是 index.html。
const api = await request("/api/nonexistent-perf-check", "br");
assert.equal(api.status, 404, `未知 API 应 404，实际 ${api.status}`);
assert.match(api.headers["content-type"] ?? "", /json/, "未知 API 未返回 JSON（回落 HTML？）");
// 质量协商：br;q=0 时应选 gzip。
const q = await request(assets[0], "br;q=0, gzip");
assert.equal(q.headers["content-encoding"], "gzip", "br;q=0 时未回退 gzip");
console.log(JSON.stringify({ status: "PASS", assets: assets.length, results, spaDeepLink: true, apiNotSpa: true, qualityNegotiation: true }, null, 2));
