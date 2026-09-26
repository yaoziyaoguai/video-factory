// 透明转发到正式 Broker，仅按控制指令丢弃响应；不生成模型结果、不更改持久数据。
import http from "node:http";
import { unlinkSync } from "node:fs";
const socketPath = "/tmp/vf-qa/transport.sock";
try { unlinkSync(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
let dropNextAcceptance = false;
const hidden = new Set();
const events = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (request.url === "/__qa") {
    if (request.method === "POST") {
      const control = JSON.parse(body.toString() || "{}");
      if (typeof control.dropNextAcceptance === "boolean") dropNextAcceptance = control.dropNextAcceptance;
      if (control.reveal) hidden.delete(control.reveal);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ dropNextAcceptance, hidden: [...hidden], events }));
    return;
  }
  const envelope = request.method === "POST" && request.url === "/v1/tasks" ? JSON.parse(body.toString()) : undefined;
  const requestId = envelope?.requestId ?? /^\/v1\/tasks\/([^?]+)/.exec(request.url)?.[1];
  const forwarded = http.request({ socketPath: "/tmp/vf-qa/broker.sock", method: request.method,
    path: request.url, headers: request.headers }, (upstream) => {
    if (envelope && upstream.statusCode === 202 && dropNextAcceptance) {
      dropNextAcceptance = false;
      hidden.add(requestId);
    }
    const dropped = hidden.has(requestId);
    events.push({ at: new Date().toISOString(), method: request.method, path: request.url,
      requestId, kind: envelope?.kind, status: upstream.statusCode, dropped });
    if (dropped) {
      upstream.resume();
      response.destroy();
    } else {
      response.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(response);
    }
  });
  forwarded.on("error", () => response.destroy());
  forwarded.end(body);
});
server.listen(socketPath, () => console.log(`QA transport proxy listening on ${socketPath}`));
