// 从仓库根构建客户端后，在 apps/studio 下使用 node --import tsx test/bench-review-cuts.mjs。
// 浏览器选择与 perf:frame 共用 PLAYWRIGHT_MODULE_PATH 和 PLAYWRIGHT_EXECUTABLE_PATH。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { assembleOfflineAgent } from "../src/server/agent/offline.ts";
import { getArtifactRow, insertRevision } from "../src/server/agent/artifact-store.ts";
import { createWork, writeWorkState } from "../src/server/agent/creative-work.ts";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const directory = await mkdtemp(path.join(tmpdir(), "frame-review-cuts-"));
const owner = "local-owner";
let browser, assembly;
try {
  assembly = await assembleOfflineAgent({ dataDir: directory, uiOrigin: "http://127.0.0.1", media: { autoStart: false } });
  const { app, service, database: db, production } = assembly;
  const conversationId = service.createConversation(owner, { commandId: "bench-review", title: "两版审片" }).conversation.id;
  const now = new Date().toISOString();
  const work = createWork(db, now, { ownerId: owner, conversationId }, "样片比较");
  db.prepare("INSERT INTO artifacts(id,conversation_id,owner_id,work_id,title,kind,created_seq,created_at,updated_at) VALUES('art-review',?,?,?,'样片','video',1,?,?)").run(conversationId, owner, work.id, now, now);
  let revision;
  for (const color of ["red", "blue"]) {
    const file = path.join(directory, color + ".mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=" + color + ":s=320x180:r=24:d=2",
      "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
    const blob = await production.blobs.persistFromFileAsync(owner, conversationId, file, "video/mp4", 2000);
    const artifact = getArtifactRow(db, owner, "art-review");
    revision = insertRevision(db, now, artifact, revision?.id ?? null, { title: "样片", kind: "video",
      content: { format: "media", blobId: blob.id, mimeType: "video/mp4", durationMs: 2000 } }, null, "delivered");
  }
  writeWorkState(db, now, work, { groups: [{ id: "grp-review", title: "画面", revision: 2, nextIntent: null,
    items: [{ id: "item-clip", label: "样片", role: "clip", required: true, approved: null, approvedAt: null, confirmationId: null,
      draft: { kind: "artifact_revision", artifactId: "art-review", revisionId: revision.id, digest: revision.digest } }] }] });
  const transfers = [];
  app.addHook("onSend", async (req, reply, payload) => {
    if (/\/blobs\/[^/]+\/content(?:\?|$)/.test(req.url)) transfers.push({ status: reply.statusCode, bytes: Number(reply.getHeader("content-length") ?? 0) });
    return payload;
  });
  await app.register(fastifyStatic, { root: fileURLToPath(new URL("../dist/client/", import.meta.url)), wildcard: false, preCompressed: true });
  app.get("/agent/:conversationId", (_req, reply) => reply.sendFile("index.html"));
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(address + "/agent/" + conversationId);
  await page.getByRole("button", { name: "审阅样片比较", exact: true }).click();
  await page.getByRole("button", { name: "比较版本", exact: true }).click();
  await page.getByRole("button", { name: "上一版 v1" }).waitFor();
  await page.locator(".agent-review-content video:visible").evaluate(async player => {
    if (!player.readyState) await new Promise(resolve => player.addEventListener("loadedmetadata", resolve, { once: true }));
    player.currentTime = 0.5;
  });
  const cut = older => page.evaluate(async older => {
    const bar = document.querySelector(".agent-cut-switch");
    const button = bar.querySelectorAll("button")[older ? 0 : 1];
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const pixels = canvas.getContext("2d", { willReadFrequently: true });
    const start = performance.now();
    button.click();
    for (;;) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const player = [...document.querySelectorAll(".agent-review-content video")].find(video => video.getClientRects().length);
      if (player?.readyState >= 2 && Math.abs(player.currentTime - 0.5) < 0.05 && button.getAttribute("aria-pressed") === "true") {
        pixels.drawImage(player, 0, 0, 1, 1);
        const [red, , blue] = pixels.getImageData(0, 0, 1, 1).data;
        if (older ? red > 180 && blue < 60 : blue > 180 && red < 60) return performance.now() - start;
      }
      if (performance.now() - start > 5000) throw new Error("对比样片未在 0.5 秒时间码显示预期颜色");
    }
  }, older);
  await cut(true); await cut(false);
  const warm = transfers.splice(0);
  const times = [];
  for (let i = 0; i < 5; i++) times.push(await cut(i % 2 === 0));
  // 等待可能已发出的 Range 请求抵达服务器。
  await page.waitForTimeout(150);
  const bytes = transfers.reduce((n, req) => n + req.bytes, 0);
  console.log("ISS-03", JSON.stringify({ warm, transfers, warmSwitchBytes: bytes, switchMs: times }));
  assert.ok(warm.filter(req => req.bytes > 0).length >= 2);
  assert.equal(bytes, 0);
  assert.ok(times.every(ms => ms < 50), JSON.stringify(times));
} finally {
  await browser?.close();
  await assembly?.close();
  await rm(directory, { recursive: true, force: true });
}
