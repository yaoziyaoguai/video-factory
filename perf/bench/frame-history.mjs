// 离线模型仅给出工具指令。HTTP、Pi、SQLite、SSE 和浏览器均使用产品入口。
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assembleOfflineAgent } from "../../apps/studio/src/server/agent/offline.ts";
import { emptyReferences, insertMessage } from "../../apps/studio/src/server/agent/conversation-store.ts";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const root = path.resolve(import.meta.dirname, "../..");
const report = process.argv[2];
assert.ok(report, "需要传入 JSON 证据文件路径");
const temporary = await mkdtemp(path.join(tmpdir(), "frame-long-chat-"));
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const { port } = reservation.address();
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const app = await assembleOfflineAgent({ dataDir: temporary, uiOrigin: origin });
let browser;

try {
  const ownerId = "local-owner";
  const { conversation } = app.service.createConversation(ownerId, { commandId: "typing-history", title: "城市纪录片 · 长对话" });
  app.database.transaction(() => {
    for (let n = 1; n <= 200; n++) {
      insertMessage(app.database, new Date(1770000000000 + n * 1000).toISOString(), {
        id: "history-" + n, conversationId: conversation.id, ownerId, requestId: null, role: n % 2 ? "user" : "assistant",
        kind: "chat", state: "completed", target: null, references: emptyReferences(), createdSeq: n,
        text: n % 2 ? `请核对第 ${n} 个镜头的对白、原声和字幕。` : `#### 第 ${n} 个镜头\n> *街口的声音先入画。*\n**[参考画面](https://example.test/frame)**\n---\n保留原片的机位与节奏，下一镜切到远景。`,
      });
    }
  })();
  await app.app.register(fastifyStatic, { root: path.join(root, "apps/studio/dist/client"), wildcard: false });
  app.app.setNotFoundHandler((request, reply) => request.method === "GET" && !request.url.startsWith("/api/")
    ? reply.sendFile("index.html") : reply.code(404).send());
  await app.app.listen({ host: "127.0.0.1", port });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  let snapshots = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/snapshot")) snapshots++; });
  await page.goto(origin + "/agent/" + conversation.id);
  const rows = page.locator("[data-message-id]");
  await rows.first().waitFor();
  while (await rows.count() < 200) {
    const before = await rows.count();
    await page.getByRole("button", { name: "加载更早的消息" }).click();
    await page.waitForFunction(count => document.querySelectorAll("[data-message-id]").length > count, before);
  }
  const input = page.getByRole("textbox", { name: "消息输入" });
  await input.fill("镜头 ");
  await input.press("End");
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const scriptTime = async () => (await cdp.send("Performance.getMetrics")).metrics.find(m => m.name === "ScriptDuration").value * 1000;
  await page.evaluate(() => {
    window.frameSamples = [];
    requestAnimationFrame(function tick(t) {
      window.frameSamples.push(t);
      if (window.frameSamples.length < 600) requestAnimationFrame(tick);
    });
  });
  const scriptMs = [];
  for (const character of "productiontimecode ".repeat(4)) {
    const start = await scriptTime();
    await page.keyboard.type(character, { delay: 25 });
    scriptMs.push((await scriptTime()) - start);
  }
  const frames = await page.evaluate(() => window.frameSamples);
  const fps = (frames.length - 1) * 1000 / (frames.at(-1) - frames[0]);
  const steps = Array.from({ length: 12 }, (_, index) => async () => {
    await new Promise(resolve => setTimeout(resolve, 220));
    return fauxAssistantMessage(fauxToolCall("start_work", { title: "长对话分集 " + (index + 1) }, { id: "new-work-" + index }));
  });
  app.faux.setResponses([...steps, fauxAssistantMessage("十二个分集均已登记。")]);
  await input.fill("请在原长会话中建立十二个分集作品。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("十二个分集均已登记。", { exact: true }).waitFor({ timeout: 60000 });
  // 旧版本在事件后 120ms 才补拉快照，覆盖其定时器窗口。
  await page.waitForTimeout(450);
  const works = app.database.prepare("SELECT COUNT(*) FROM works WHERE conversation_id=?").pluck().get(conversation.id);
  const workEvents = app.database.prepare("SELECT COUNT(DISTINCT entity_id) FROM events WHERE conversation_id=? AND kind='work.changed'").pluck().get(conversation.id);
  const result = { history: 200, works, workEvents, snapshots, fps, frames, scriptMs, maxKeyMs: Math.max(...scriptMs) };
  await writeFile(report, JSON.stringify(result, null, 2));
  await page.screenshot({ path: report + ".png" });
  assert.equal(works, 12);
  assert.equal(workEvents, 12);
  assert.equal(snapshots, 1);
  assert.ok(fps >= 59, `实测 ${fps.toFixed(2)} FPS`);
  assert.ok(result.maxKeyMs < 4, `最慢按键 ${result.maxKeyMs.toFixed(2)} ms`);
} finally {
  try { await browser?.close(); }
  finally {
    try { await app.app.close(); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
