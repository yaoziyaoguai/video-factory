// Frame /agent 工作台测速（与 huashu-flash 口径一致）；仅允许环回隔离 QA 后端。
// 与旧 measure.mjs（已退役旧 Studio 页面）不同，本脚本面向 /agent 唯一入口：
//   open   打开工作台到能用（rail+输入框+欢迎语），统计首屏前请求/字节/字体文件数
//   send   Faux 触发句发送到首次反馈与首个交付草稿（SSE/流式路径）
// 护栏：双宽度全页截图 + 可见文字哈希 + 溢出检查 + 导航冒烟。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { lineSetHash, SCRIPT_TITLES, visibleLines } from "./frame-send-guard.mjs";
const require = (await import("node:module")).createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const args = Object.fromEntries(process.argv.slice(2).map((v, i, all) => v.startsWith("--") ? [v.slice(2), all[i + 1]] : []).filter(v => v.length));
if (!args.a || !args.out) throw new Error("--a <url> [--b <url>] --out <json> [--runs 10] [--guards 1] [--routes open,send] [--settle 250] [--run-widths 1440,960] [--label-a <s>] [--label-b <s>]");
const origins = { A: args.a, ...(args.b ? { B: args.b } : {}) };
for (const url of Object.values(origins)) if (new URL(url).hostname !== "127.0.0.1") throw new Error("Only isolated loopback QA is allowed");
// 构建身份：棘轮要求 builds.{A,B}.label 非空；未显式给标签时以入口 URL 兜底（正式配对务必传 --label-a/--label-b）。
const builds = Object.fromEntries(Object.entries(origins).map(([k, u]) => [k, { label: (k === "A" ? args["label-a"] : args["label-b"]) ?? new URL("/agent", u).href, url: new URL("/agent", u).href }]));
const counts = Number(args.runs ?? 10);
const settleMs = Number(args.settle ?? 250);
const runWidths = (args["run-widths"] ?? "1440").split(",").map(Number).filter(w => [960, 1440].includes(w));
if (!runWidths.length) throw new Error("--run-widths 只支持 960/1440");
const cpuRate = Number(args.cpu ?? 1);
const routesWanted = (args.routes ?? "open,send").split(",");
const exe = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });

// 「能用」判定：全部在页面内执行；空壳/骨架不算。
const READY_OPEN = `(() => {
  const rail = document.querySelector('nav.agent-rail');
  const buttons = rail ? rail.querySelectorAll('button') : null;
  const composer = document.querySelector('footer.agent-composer textarea[aria-label="消息输入"]');
  const welcome = document.querySelector('.agent-welcome, .agent-messages .agent-message, .agent-empty-workspace');
  const boot = document.querySelector('.agent-boot-error, .agent-action-error');
  return !!(buttons && buttons.length >= 6 && composer && !composer.disabled && welcome && !boot);
})()`;
const TRIGGER = "给我三个不同方向的脚本，先不要制作";
const results = {};
const guards = [];
const started = new Date().toISOString();
const pct = (v, p) => { const a = [...v].sort((x, y) => x - y); const n = (a.length - 1) * p; return Math.round((a[Math.floor(n)] + (a[Math.ceil(n)] - a[Math.floor(n)]) * (n % 1)) * 10) / 10; };

async function newCtx(browser2, width) {
  const ctx = await browser2.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const external = [];
  await ctx.route("**/*", r => { const host = new URL(r.request().url()).hostname; if (host && host !== "127.0.0.1") { external.push(host); return r.abort(); } return r.continue(); });
  return { ctx, external };
}

async function measure(origin, route, width, guard) {
  const { ctx, external } = await newCtx(browser, width);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: 4 * 1024 * 1024 / 8, uploadThroughput: 3 * 1024 * 1024 / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  await page.addInitScript(() => {
    window.__flash = { ready: null, fontReady: null, lcp: null, longtask: 0 };
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__flash.lcp = e.startTime)).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__flash.longtask += e.duration)).observe({ type: "longtask", buffered: true });
    const tick = () => {
      if (window.__flash.check?.()) {
        window.__flash.ready ??= performance.now();
        if (document.fonts.status === "loaded") window.__flash.fontReady ??= performance.now();
      }
      if (window.__flash.fontReady === null) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const result = { ok: false, route, width };
  try {
    if (route === "open") {
      await page.addInitScript(ready => { window.__flash.check = () => eval(ready); }, READY_OPEN);
      await page.goto(new URL("/agent", origin).href, { waitUntil: "commit", timeout: 60000 });
      await page.waitForFunction(() => window.__flash && window.__flash.ready !== null, null, { timeout: 60000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const input = page.getByRole("textbox", { name: "消息输入", exact: true });
      await input.fill("性能输入检查");
      if (await input.inputValue() !== "性能输入检查") throw new Error("输入未保留");
      await input.fill("");
      // 「可输入」真实口径：fill+读回验证之后才计 inputReadyMs；上方 ready 只是谓词就绪（选器命中即停）。
      result.inputReadyMs = await page.evaluate(() => performance.now());
      Object.assign(result, await page.evaluate(() => {
        const res = performance.getEntriesByType("resource"), nav = performance.getEntriesByType("navigation")[0];
        const byType = suffix => res.filter(r => new URL(r.name).pathname.endsWith(suffix));
        // ready 点字节快照；下方完整采样在 fontReady+settle 之后，代表 settle 后总量而非首屏前字节。
        return { requestsAtReady: res.length + 1, bytesAtReady: res.reduce((n, r) => n + r.transferSize, 0) + (nav.transferSize || 0), jsBytesAtReady: byType(".js").reduce((n, r) => n + r.transferSize, 0) };
      }));
      await page.waitForFunction(() => window.__flash.fontReady !== null, null, { timeout: 30000 });
      await page.waitForTimeout(settleMs);
      Object.assign(result, await page.evaluate(() => {
        const res = performance.getEntriesByType("resource"), nav = performance.getEntriesByType("navigation")[0];
        const byType = suffix => res.filter(r => new URL(r.name).pathname.endsWith(suffix));
        const fonts = byType(".woff2");
        const api = res.filter(r => r.name.includes("/api/"));
        return { ...window.__flash,
          requests: res.length + 1,
          bytes_total: res.reduce((n, r) => n + r.transferSize, 0) + (nav.transferSize || 0),
          jsBytes: byType(".js").reduce((n, r) => n + r.transferSize, 0),
          cssBytes: byType(".css").reduce((n, r) => n + r.transferSize, 0),
          fontFiles: fonts.length, fontBytes: fonts.reduce((n, r) => n + r.transferSize, 0),
          apiRequests: api.length,
          slowest: [...res].sort((a, b) => b.responseEnd - a.responseEnd).slice(0, 8).map(r => ({ path: new URL(r.name).pathname, ms: Math.round(r.responseEnd), bytes: r.transferSize })) };
      }));
      const capture = async name => {
        await page.evaluate(() => document.fonts.ready);
        const text = await page.locator("body").innerText();
        const shot = await page.screenshot({ fullPage: true, animations: "disabled" });
        const file = `${args.out}.${new URL(origin).port}-${name}-${width}.png`;
        await writeFile(file, shot);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        result.images ??= [];
        result.images.push({ name, width, file, golden: createHash("sha256").update(text).digest("hex"), overflow });
        result.overflow ||= overflow;
      };
      if (guard) await capture("open");
      const t0 = await page.evaluate(() => performance.now());
      await page.click('nav.agent-rail button[aria-label="打开模型配置"]');
      await page.waitForSelector('.agent-settings-page[aria-label="模型配置"]:not([hidden]) .agent-current-model', { timeout: 10000 });
      result.settingsNavMs = (await page.evaluate(() => performance.now())) - t0;
      if (guard) await capture("models");
    } else if (route === "send") {
      await page.addInitScript(ready => { window.__flash.check = () => eval(ready); }, `!!document.querySelector('footer.agent-composer textarea[aria-label="消息输入"]')`);
      await page.goto(new URL("/agent", origin).href, { waitUntil: "commit", timeout: 60000 });
      await page.waitForSelector('footer.agent-composer textarea[aria-label="消息输入"]', { timeout: 60000 });
      await page.waitForTimeout(300);
      const seen = { snapshot: 0, events: 0, other: 0 };
      page.on("request", r => { const p = new URL(r.url()).pathname; if (p.includes("/snapshot")) seen.snapshot++; else if (p.includes("/events")) seen.events++; else if (p.includes("/api/")) seen.other++; });
      await page.fill('footer.agent-composer textarea[aria-label="消息输入"]', TRIGGER);
      const send = page.getByRole('button', { name: '发送', exact: true });
      await send.waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForFunction(() => { const button = document.querySelector('button[aria-label="发送"]'); return button && !button.disabled; }, null, { timeout: 30000 });
      // 在浏览器内测量点击到各阶段的偏移。临时交付草稿可能被合并成正式交付，缺测不延后终态计时。
      await send.evaluate(button => {
        const marks = window.__frameSend = { firstFeedbackMs: null, firstDeliveryMs: null, turnDoneMs: null };
        button.addEventListener("click", () => {
          const startedAt = performance.now();
          const observer = new MutationObserver(() => {
            const elapsed = performance.now() - startedAt;
            const draft = document.querySelector(".agent-draft-item");
            const progress = document.querySelector(".agent-task-progress");
            const assistant = document.querySelector(".agent-message.assistant");
            const terminal = !progress && document.querySelector(".agent-execution-record")
              && document.querySelector(".agent-message.assistant:not(.draft):not(.streaming)");
            if (draft) marks.firstDeliveryMs ??= elapsed;
            if (progress || assistant || document.querySelector(".agent-context-note")) marks.firstFeedbackMs ??= elapsed;
            if (terminal) {
              marks.turnDoneMs = elapsed;
              observer.disconnect();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
        }, { capture: true, once: true });
      });
      await send.click();
      await page.waitForFunction(() => window.__frameSend.firstFeedbackMs !== null, null, { timeout: 30000 });
      await page.waitForFunction(() => window.__frameSend.turnDoneMs !== null, null, { timeout: 120000 });
      Object.assign(result, await page.evaluate(() => window.__frameSend));
      result.deliveryObserved = result.firstDeliveryMs !== null;
      const persisted = await page.evaluate(async () => {
        const id = location.pathname.split('/').pop();
        const response = await fetch(`/api/agent/v1/conversations/${id}/snapshot`);
        if (!response.ok) throw new Error(`持久交付读回失败: HTTP ${response.status}`);
        const value = await response.json();
        return { conversationId: id, activeRequestId: value.activeRequestId, artifacts: value.artifacts.items.map(({ id, kind, title, revisionId, revisionNumber }) => ({ id, kind, title, revisionId, revisionNumber })) };
      });
      const scripts = persisted.artifacts.filter(item => item.kind === "script");
      if (persisted.activeRequestId || scripts.length !== SCRIPT_TITLES.length
        || !SCRIPT_TITLES.every(title => scripts.some(item => item.title === title && item.revisionId && item.revisionNumber === 1))) {
        throw new Error("未取得指定的三份 v1 持久交付");
      }
      result.persisted = persisted;
      result.longtask = await page.evaluate(() => window.__flash.longtask);
      result.netCounter = seen;
      result.apiRequests = seen.snapshot + seen.events + seen.other;
      if (guard) {
        // 性能采样已结束。两边都依次打开三张卡，清除异步送达的「有更新」标记，再截图。
        const title = SCRIPT_TITLES[0];
        const tabs = page.locator(".agent-artifact-tabs");
        result.badgesBeforeReview = await tabs.locator(".agent-output-badge:visible").count();
        for (const script of [...SCRIPT_TITLES.slice(1), title]) {
          await tabs.getByRole("button", { name: script, exact: true }).click({ timeout: 10000 });
          await tabs.getByRole("button", { name: script, exact: true, pressed: true }).waitFor({ timeout: 10000 });
        }
        await tabs.locator(".agent-output-badge:visible").first().waitFor({ state: "hidden", timeout: 10000 });
        const paper = page.locator(".agent-paper");
        await paper.getByRole("heading", { name: title, exact: true }).waitFor({ timeout: 10000 });
        await paper.locator(".agent-version-picker summary").filter({ hasText: /\bv1$/ }).waitFor({ timeout: 10000 });
        await paper.locator(".agent-preview-body").getByText("以夜间城市天际线的延时镜头开场……（离线测试内容一）", { exact: true }).waitFor({ timeout: 10000 });
        await page.evaluate(() => document.fonts.ready);
        result.reviewed = { title, revisionNumber: 1 };
        result.referenceCards = await page.locator(".agent-message.assistant .agent-references > button:visible").evaluateAll(cards => cards.map(card => [
          card.querySelector("strong")?.innerText,
          card.querySelector("small")?.innerText,
          card.getAttribute("aria-label"),
        ]));
        result.lines = visibleLines(await page.locator("body").innerText());
        const shotFile = `${args.out}.${new URL(origin).port}-send-${width}.png`;
        const shot = await page.screenshot({ fullPage: true, animations: "disabled" });
        await writeFile(shotFile, shot);
        result.golden = lineSetHash(result.lines);
        result.screenshot = createHash("sha256").update(shot).digest("hex");
        result.screenshotFile = shotFile; // 哈希之外的原始截图路径，供事后复核（旧版只存哈希）
        result.overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      }
    }
    result.ok = !errors.length && !external.length && !result.overflow;
  } catch (e) { result.error = String(e).slice(0, 300); }
  result.errors = errors; result.external = external;
  await ctx.close();
  return result;
}

await mkdir(path.dirname(args.out), { recursive: true });
const metrics = {
  open: ["ready", "fontReady", "inputReadyMs", "lcp", "longtask", "requests", "bytes_total", "requestsAtReady", "bytesAtReady", "jsBytesAtReady", "jsBytes", "cssBytes", "fontFiles", "fontBytes", "apiRequests", "settingsNavMs"],
  send: ["firstFeedbackMs", "firstDeliveryMs", "turnDoneMs", "longtask", "apiRequests"],
};
try {
  for (const route of ["open", "send"].filter(r => routesWanted.includes(r))) {
    results[route] = Object.fromEntries(Object.keys(origins).map(k => [k, { url: new URL("/agent", origins[k]).href, runs: [] }]));
    for (let i = 0; i < counts; i++) {
      const order = i % 2 ? Object.keys(origins).reverse() : Object.keys(origins);
      for (const k of order) for (const width of runWidths) {
        const r = await measure(origins[k], route, width, false);
        results[route][k].runs.push(r);
        const ms = v => v == null ? "null" : `${Math.round(v)}ms`;
        console.log(`${route} ${k} ${i + 1}/${counts} ${width} ok=${r.ok} ${r.route === "open" ? `ready=${ms(r.ready)} input=${ms(r.inputReadyMs)} fonts=${r.fontFiles}/${Math.round((r.fontBytes ?? 0) / 1024)}KB` : `first=${ms(r.firstFeedbackMs)} delivery=${ms(r.firstDeliveryMs)} done=${ms(r.turnDoneMs)}`} ${r.error ?? ""}`);
      }
    }
    for (const set of Object.values(results[route])) {
      const good = set.runs.filter(r => r.ok);
      set.summary = { n: set.runs.length, n_ok: good.length };
      for (const metric of metrics[route]) {
        const values = good.map(r => r[metric]).filter(value => typeof value === 'number' && Number.isFinite(value));
        // 逐指标记录有效/缺失样本数：null 不再被静默丢弃后不可见（审计 probe2 正是利用该口径）。
        set.summary[metric] = { n_valid: values.length, n_missing: good.length - values.length, ...Object.fromEntries([50, 75, 95].map(p => ["p" + p, values.length ? pct(values, p / 100) : null])) };
      }
    }
    if (args.guards) for (const width of [1440, 960]) for (const [version, origin] of Object.entries(origins))
      guards.push({ version, ...await measure(origin, route, width, true) });
  }
} finally {
  await browser.close();
  await writeFile(args.out, JSON.stringify({ started, finished: new Date().toISOString(), profile: `Fast4G 20ms/4Mbps/3Mbps, CPUx${cpuRate}, cache off`, nodeVersion: process.version, builds, results, guards }, null, 2));
}
if (Object.values(results).some(v => Object.values(v).some(s => s.runs.some(r => !r.ok))) || guards.some(g => !g.ok)) process.exitCode = 1;
