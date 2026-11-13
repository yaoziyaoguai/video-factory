import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

for (const useProxy of [true, false]) test(`正式入口加载 Pi 后保留${useProxy ? "环境代理与 NO_PROXY" : "宿主直连"}`, { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-network-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const proxied: string[] = [];
  const proxy = http.createServer((request, response) => {
    proxied.push(request.url!);
    response.end("proxied");
  });
  const direct = http.createServer((_request, response) => response.end("direct"));
  proxy.listen(0, "127.0.0.1"); direct.listen(0, "127.0.0.1");
  await Promise.all([once(proxy, "listening"), once(direct, "listening")]);
  t.after(() => { proxy.closeAllConnections(); direct.closeAllConnections(); proxy.close(); direct.close(); });
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const directUrl = `http://127.0.0.1:${(direct.address() as AddressInfo).port}`;
  const main = pathToFileURL(path.resolve(import.meta.dirname, "../src/server/main.ts")).href;
  // 用正式入口的真实依赖加载顺序；全程只访问两个本地测试端口。
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    await import(${JSON.stringify(main)});
    try {
      ${useProxy ? 'assert.equal(await fetch("http://frame-provider.invalid/v1/models", { signal: AbortSignal.timeout(3000) }).then(r => r.text()), "proxied");' : ""}
      assert.equal(await fetch(${JSON.stringify(directUrl)}, { signal: AbortSignal.timeout(3000) }).then(r => r.text()), "direct");
    } finally { process.kill(process.pid, "SIGTERM"); }
  `], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: { PATH: process.env.PATH, STUDIO_DEV: "1", STUDIO_HOST: "127.0.0.1", STUDIO_PORT: "0",
      AGENT_DATA_DIR: directory, VIDEO_FACTORY_WORKSPACE: directory, NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: useProxy ? proxyUrl : "", HTTPS_PROXY: useProxy ? proxyUrl : "", NO_PROXY: "127.0.0.1,localhost" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.deepEqual(proxied, useProxy ? ["http://frame-provider.invalid/v1/models"] : []);
});

test("免费配音实际 Python 驱动把部署代理传给客户端，并遵循 NO_PROXY 与变量优先级", async () => {
  const source = await readFile(new URL("../src/server/agent/pi-tools.ts", import.meta.url), "utf8");
  const driver = source.match(/const DUB_DRIVER_PYTHON = `([\s\S]*?)`;/)?.[1];
  assert.ok(driver, "应运行产品实际驱动");
  // 仅替换外部客户端：实际 -I 驱动必须消费部署变量并传入 Communicate；桩不联网。
  const clientBoundary = `import json, sys, types
edge = types.ModuleType("edge_tts")
constants = types.ModuleType("edge_tts.constants")
constants.WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
class Communicate:
    def __init__(self, text, voice, **options):
        sys.stderr.write(json.dumps({"text": text, "voice": voice, **options}))
    async def stream(self):
        yield {"type": "audio", "data": b"fixture-mp3"}
        yield {"type": "WordBoundary", "text": "短句", "offset": 1000000, "duration": 2000000}
edge.Communicate = Communicate
sys.modules["edge_tts"] = edge
sys.modules["edge_tts.constants"] = constants
exec(sys.argv[1])
`;
  const cases: { env: NodeJS.ProcessEnv; expected: string | null }[] = [
    { env: { HTTPS_PROXY: "http://https-proxy.invalid:8080" }, expected: "http://https-proxy.invalid:8080" },
    { env: { HTTPS_PROXY: "http://https-proxy.invalid:8080", NO_PROXY: ".bing.com" }, expected: null },
    { env: {}, expected: null },
    { env: { https_proxy: "http://lower.invalid:8080", HTTP_PROXY: "http://http.invalid:8080" }, expected: "http://lower.invalid:8080" },
    { env: { HTTPS_PROXY: "http://https-proxy.invalid:8080", NO_PROXY: "other.invalid", no_proxy: "speech.platform.bing.com" }, expected: "http://https-proxy.invalid:8080" },
  ];
  const runPython = promisify(execFile);
  for (const { env, expected } of cases) {
    const pending: Promise<{ stdout: string; stderr: string }> & { child: import("node:child_process").ChildProcess } = runPython("python3", ["-I", "-c", clientBoundary, driver], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    pending.child.stdin!.end(JSON.stringify({ text: "短句", voice: "zh-CN-XiaoxiaoNeural", rate: "+10%" }));
    const { stdout, stderr } = await pending;
    assert.deepEqual(JSON.parse(stderr), { text: "短句", voice: "zh-CN-XiaoxiaoNeural", rate: "+10%", boundary: "WordBoundary", proxy: expected });
    assert.deepEqual(JSON.parse(stdout), { audioB64: Buffer.from("fixture-mp3").toString("base64"), boundaries: [{ text: "短句", offsetMs: 100, durationMs: 200 }] });
  }
});
