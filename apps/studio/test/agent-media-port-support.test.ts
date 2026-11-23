import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { downloadToFile, extractSafeProviderError, ProviderHttpError, providerRequestJson } from "../src/server/agent/media-port-support.js";

// 供应商端口共用件的两处外部边界：4xx 拒绝原因的受控摘要（白名单、脱敏、限长），
// 以及成片下载对重定向的逐跳跟随（每一跳先过私网边界、不带任何请求头）。全程不触真实外网。

const KEY = "ark-live-key-7f3a9c";
const REDACTED = "[已隐去凭据]";
const publicHost = async () => [{ address: "93.184.216.34" }];

it("拒绝摘要只取白名单字段：带出错误码与说明，重复值只留一份", () => {
  assert.equal(
    extractSafeProviderError({ error: { code: "InputTextSensitive", message: "提示词未通过内容安全审核。", type: "SensitiveContentDetectedInputText", request_id: "req-1" } }, KEY),
    "（InputTextSensitive：提示词未通过内容安全审核。）",
  );
  assert.equal(extractSafeProviderError({ base_resp: { status_code: 1004, status_msg: "text too long" }, data: { audio: "ab" } }, KEY), "（base_resp 1004：text too long）");
  assert.equal(extractSafeProviderError({ code: "InvalidParameter", message: "duration not supported", request_id: "abc" }, KEY), "（InvalidParameter：duration not supported）");
  assert.equal(extractSafeProviderError({ code: "ModelNotOpen", message: "模型未开通", error: { code: "ModelNotOpen", message: "模型未开通" } }, KEY), "（ModelNotOpen：模型未开通）");
});

it("拒绝正文不是 JSON 对象或没有白名单字段时不产生摘要", () => {
  for (const body of [undefined, "Unauthorized", null, 42, ["x"], {}, { error: "Invalid API key" }, { base_resp: "oops" }, { detail: "不在白名单" }]) {
    assert.equal(extractSafeProviderError(body, KEY), "", `body=${JSON.stringify(body) ?? String(body)}`);
  }
});

it("拒绝摘要隐去本次 Key 与疑似凭据片段", () => {
  const summary = extractSafeProviderError({ error: { code: "AuthenticationError", message: `Rejected for Authorization: Bearer ${KEY}; api_key=AKIAIOSFODNN7; token=sk-live-abcdefghijklmnop` } }, KEY);
  // 凭据名保留，只隐去它的值；"Bearer + 本次 Key" 被两道规则各隐一次。
  assert.equal(summary, `（AuthenticationError：Rejected for Authorization: ${REDACTED} ${REDACTED}; api_key=${REDACTED}; token=${REDACTED}）`);
  for (const secret of [KEY, "AKIAIOSFODNN7", "sk-live-abcdefghijklmnop"]) assert.ok(!summary.includes(secret), secret);
  // 不是本次 Key 的凭据形状同样隐去（保留 "Bearer"、凭据名这类固定词）；"API key provided" 这类普通措辞保留。
  assert.equal(
    extractSafeProviderError({ error: { message: "bad Bearer eyJhbGciOiJIUzI1NiJ9.abc; Incorrect API key provided: sk-Proj****3qcA." } }, KEY),
    `（bad Bearer ${REDACTED}; Incorrect API key provided: ${REDACTED}.）`,
  );
});

it("拒绝摘要压成单行且至多 160 字", () => {
  const long = extractSafeProviderError({ error: { code: "RateLimitExceeded", message: `first\nsecond\tline\r\n${"长".repeat(300)}` } }, KEY);
  assert.match(long, /^（RateLimitExceeded：first second line 长+…）$/);
  assert.ok(long.length <= 160 + 2, `摘要长度 ${long.length}`);
});

it("非 2xx 的 ProviderHttpError 保留 HTTP 状态前缀并带受控摘要；非 JSON 正文只报状态", async () => {
  const respond = (status: number, text: string, echo: string): typeof fetch => async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(text.replace("${echo}", authorization), { status });
  };
  const url = new URL("https://ark.example.test/api/v3/contents/generations/tasks");
  await assert.rejects(
    providerRequestJson("POST", url, KEY, { model: "m" }, { fetchImpl: respond(400, JSON.stringify({ error: { code: "InputTextSensitive", message: "prompt rejected (${echo})" } }), "${echo}") }),
    (error: ProviderHttpError) => error instanceof ProviderHttpError && error.status === 400
      && error.message === `HTTP 400（InputTextSensitive：prompt rejected (Bearer ${REDACTED})）`,
  );
  await assert.rejects(
    providerRequestJson("GET", url, KEY, undefined, { fetchImpl: respond(502, "<html>Bad Gateway</html>", "${echo}") }),
    (error: ProviderHttpError) => error instanceof ProviderHttpError && error.status === 502 && error.message === "HTTP 502",
  );
});

// —— 成片下载的重定向 ——

function redirect(location: string | null): Response {
  return new Response(null, { status: 302, headers: location === null ? {} : { location } });
}

/** 记录每次请求的替身 fetch。 */
function recordingFetch(respond: (url: URL) => Response | Promise<Response>): { fetchImpl: typeof fetch; urls: string[]; headerInits: unknown[] } {
  const urls: string[] = [], headerInits: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    urls.push(url.href);
    headerInits.push(init?.headers);
    assert.equal(init?.redirect, "manual", "重定向交给下载器自己逐跳把关");
    return respond(url);
  };
  return { fetchImpl, urls, headerInits };
}

async function workDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

it("下载逐跳跟随相对地址的重定向（至多 5 跳），每个请求都不带请求头", async t => {
  const dir = await workDir(t);
  const bytes = new Uint8Array([0, 1, 2, 3, 250, 251]);
  const { fetchImpl, urls, headerInits } = recordingFetch(url => {
      const hop = Number(url.pathname.slice("/hop".length));
      return url.pathname === "/start" ? redirect("/hop1") : hop < 5 ? redirect(`/hop${hop + 1}`) : new Response(bytes);
    });
  await downloadToFile(fetchImpl, new URL("https://cdn.example.test/start"), dir, path.join(dir, "download.mp4"), { resolveHost: publicHost });
  assert.deepEqual(urls, ["https://cdn.example.test/start", ...[1, 2, 3, 4, 5].map(hop => `https://cdn.example.test/hop${hop}`)]);
  assert.deepEqual(headerInits, urls.map(() => undefined), "跳转后的请求不附加认证头等任何请求头");
  assert.deepEqual([...await readFile(path.join(dir, "download.mp4"))], [...bytes]);
});

it("超过 5 跳或缺少 Location 的重定向按下载失败处理", async t => {
  const dir = await workDir(t);
  const loop = recordingFetch(() => redirect("/next"));
  await assert.rejects(
    downloadToFile(loop.fetchImpl, new URL("https://cdn.example.test/start"), dir, path.join(dir, "download.mp4"), { resolveHost: publicHost }),
    /下载失败：HTTP 302/,
  );
  assert.equal(loop.urls.length, 6, "收到第 6 个重定向即停止");

  const missing = recordingFetch(() => redirect(null));
  await assert.rejects(
    downloadToFile(missing.fetchImpl, new URL("https://cdn.example.test/start"), dir, path.join(dir, "download.mp4"), { resolveHost: publicHost }),
    /下载失败：HTTP 302/,
  );
  assert.equal(missing.urls.length, 1);
});

it("跳转目标是内网、云元数据地址或非 HTTP(S) 地址时拒绝跟随，不发请求、不落文件", async t => {
  const dir = await workDir(t);
  const refusals = [
    ["http://169.254.169.254/latest/meta-data/", "请求目标属于内网地址，已拒绝。"],
    ["http://[::1]:8080/admin", "请求目标属于内网地址，已拒绝。"],
    ["file:///etc/passwd", "下载跳转地址不是有效的 HTTP(S) 地址，已拒绝跟随。"],
    ["http://[::1", "下载跳转地址不是有效的 HTTP(S) 地址，已拒绝跟随。"],
  ] as const;
  for (const [location, message] of refusals) {
    const literal = recordingFetch(url => url.pathname === "/start" ? redirect(location) : new Response("leak"));
    await assert.rejects(
      downloadToFile(literal.fetchImpl, new URL("https://cdn.example.test/start"), dir, path.join(dir, "download.mp4"), { resolveHost: publicHost }),
      { code: "FORBIDDEN", message }, location,
    );
    assert.equal(literal.urls.length, 1, location);
  }

  // 域名解析到内网同样拒绝。
  const resolved = recordingFetch(url => url.pathname === "/start" ? redirect("https://edge.example.net/file.mp4") : new Response("leak"));
  await assert.rejects(
    downloadToFile(resolved.fetchImpl, new URL("https://cdn.example.test/start"), dir, path.join(dir, "download.mp4"), { resolveHost: async () => [{ address: "10.0.0.8" }] }),
    { code: "FORBIDDEN", message: "目标地址解析到内网 IP（10.0.0.8），已拒绝请求。" },
  );
  assert.equal(resolved.urls.length, 1);
  await assert.rejects(readFile(path.join(dir, "download.mp4")));
});

it("显式放行内网的联调环境下，跳到本机地址的重定向照常下载", async t => {
  const previous = process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK;
  process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK;
    else process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK = previous;
  });
  const dir = await workDir(t);
  const local = recordingFetch(url => url.pathname === "/start" ? redirect("http://127.0.0.1:4444/signed.mp4?X-Tos-Signature=abc") : new Response(new Uint8Array([9, 9, 9])));
  await downloadToFile(local.fetchImpl, new URL("https://cdn.example.test/start"), dir, path.join(dir, "download.mp4"));
  assert.deepEqual(local.urls, ["https://cdn.example.test/start", "http://127.0.0.1:4444/signed.mp4?X-Tos-Signature=abc"]);
  assert.deepEqual([...await readFile(path.join(dir, "download.mp4"))], [9, 9, 9]);
});
