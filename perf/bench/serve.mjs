// 仅本地实验：A/B静态构建共用一个隔离QA后端，不接真实生产。
import { createServer, request } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
const [rootArg, portArg, apiPortArg] = process.argv.slice(2);
if (!rootArg || !portArg || !apiPortArg) throw new Error("usage: serve.mjs <build-root> <port> <local-api-port>");
const root = path.resolve(rootArg);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    const upstream = request({ host: "127.0.0.1", port: Number(apiPortArg), path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${apiPortArg}` } }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
    return;
  }
  try {
    const target = path.resolve(root, "." + decodeURIComponent((req.url ?? "/").split("?")[0]));
    if (!target.startsWith(root + path.sep) && target !== root) { res.writeHead(404); res.end(); return; }
    let file = target;
    if (!(await stat(file).catch(() => null))?.isFile()) {
      if (path.extname(file)) { res.writeHead(404); res.end(); return; }
      file = path.join(root, "index.html");
    }
    const size = (await stat(file)).size;
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "content-length": size,
      "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end(); }
}).listen(Number(portArg), "127.0.0.1", () => console.log(`Local perf server: ${portArg}`));
