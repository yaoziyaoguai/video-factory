// 与 huashu-flash bench.py 同口径；增加本地合成登录、交互校验及截图护栏。
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const args = Object.fromEntries(process.argv.slice(2).map((v, i, all) => v.startsWith("--") ? [v.slice(2), all[i + 1]] : []).filter(v => v.length));
if (!args.a || !args.out) throw new Error("--a <url> [--b <url>] --out <json> --run-id <local-run> [--runs 10] [--guards 1]");
const origins = { A: args.a, ...(args.b ? { B: args.b } : {}) };
for (const url of Object.values(origins)) if (new URL(url).hostname !== "127.0.0.1") throw new Error("Only isolated loopback QA is allowed");
const counts = Number(args.runs ?? 10);
const routes = [
  { name: "home", path: "/", ready: "document.querySelector('.home-page') && !document.querySelector('.home-loading') && document.querySelectorAll('.home-start-options button').length === 4" },
  { name: "queue", path: "/projects", ready: "document.querySelector('.queue-page input[placeholder=\"搜索标题\"]') && !document.querySelector('.queue-placeholder')" },
  ...(args["run-id"] ? [{ name: "workspace", path: `/projects/${args["run-id"]}`, ready: "document.querySelector('.run-page') && document.querySelector('#run-current')" }] : []),
].filter(r => !args.route || r.name === args.route);
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
const bootstrap = await browser.newContext();
const login = await bootstrap.request.post(new URL("/api/auth/login", args.a).href,
  { data: { username: "local-qa", password: "local-decision-qa" } });
if (!login.ok()) throw new Error(`Synthetic QA login failed: ${login.status()}`);
// 只在内存复用认证，绝不写storageState/cookie文件或输出其值。
const cookies = await bootstrap.cookies();
await bootstrap.close();
const results = {};
const guards = [];
const pct = (v, p) => { const a = [...v].sort((a,b)=>a-b); const n = (a.length-1)*p; return Math.round((a[Math.floor(n)] + (a[Math.ceil(n)]-a[Math.floor(n)])*(n%1))*10)/10; };
const started = new Date().toISOString();
async function measure(origin, route, width, guard) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const errors = [], external = [];
  page.on("pageerror", e => errors.push(e.message));
  await ctx.route("**/*", r => { const host = new URL(r.request().url()).hostname;
    if (host && host !== "127.0.0.1") { external.push(host); return r.abort(); } return r.continue(); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: 4*1024*1024/8, uploadThroughput: 3*1024*1024/8 });
  await page.addInitScript(({ ready, guard }) => {
    localStorage.setItem("videofactory.creator-tour", "creator-canvas-v2");
    if (guard) { const RealDate = Date; window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [1791356400000])); } static now() { return 1791356400000; } }; }
    window.__flash = { ready: null, lcp: null, longtask: 0 };
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__flash.lcp=e.startTime)).observe({type:"largest-contentful-paint",buffered:true});
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__flash.longtask+=e.duration)).observe({type:"longtask",buffered:true});
    const tick = () => { if (document.fonts.status === "loaded" && eval(ready)) window.__flash.ready=performance.now(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, { ready: route.ready, guard });
  const result = { ok: false };
  try {
    await page.goto(new URL(route.path, origin).href, { waitUntil: "commit", timeout: 60000 });
    await page.waitForFunction(() => window.__flash && window.__flash.ready !== null, null, { timeout: 60000 });
    // 第二帧确认布局与绑定已经可用，不以同步空壳提前结束。
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (guard) {
      await page.evaluate(() => document.querySelectorAll("video").forEach(v => { v.pause(); v.currentTime = 0; }));
      await page.waitForTimeout(400);
      const text = await page.locator("main").innerText();
      const shot = await page.screenshot({ fullPage: true, animations: "disabled" });
      await writeFile(`${args.out}.${new URL(origin).port}-${route.name}-${width}.png`, shot);
      result.golden = createHash("sha256").update(text).digest("hex");
      result.screenshot = createHash("sha256").update(shot).digest("hex");
      result.width = width;
      result.overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    }
    result.interactions = {};
    if (route.name === "queue") {
      const input = page.getByPlaceholder("搜索标题");
      const start = await page.evaluate(() => performance.now());
      await input.fill("钥匙");
      if (await input.inputValue() !== "钥匙") throw new Error("Search input did not retain text");
      result.interactions.searchMs = await page.evaluate(() => performance.now()) - start;
      await input.fill("");
    }
    // 在任何额外页面跳转前采集冷启动指标，避免把后续交互资源混入首屏。
    Object.assign(result, await page.evaluate(() => {
      const res=performance.getEntriesByType("resource"), nav=performance.getEntriesByType("navigation")[0];
      const used=res.filter(r => r.responseEnd <= window.__flash.ready);
      const bytes=type => used.filter(r => new URL(r.name).pathname.endsWith(type)).reduce((n,r)=>n+r.transferSize,0);
      return { ...window.__flash, requests: used.length+1, bytes_total: used.reduce((n,r)=>n+r.transferSize,0)+(nav.transferSize||0), jsBytes: bytes(".js"), cssBytes: bytes(".css"),
        slowest: used.sort((a,b)=>b.responseEnd-a.responseEnd).slice(0,6).map(r=>({path:new URL(r.name).pathname,ms:Math.round(r.responseEnd),bytes:r.transferSize})) };
    }));
    if (guard && route.name === "home") {
      await page.getByRole("button", { name: "从自己的想法开始 写下主题，加入你的参考" }).click();
      await page.waitForURL("**/topics?mode=manual");
      await page.getByRole("button", { name: "手动录入 填写标题、受众、痛点和开场钩子" }).click();
      await page.getByRole("dialog").waitFor({ timeout: 10000 });
      result.interactions.createEntry = true;
    }
    result.ok = !errors.length && !external.length && !result.overflow;
  } catch(e) { result.error = String(e); }
  result.errors=errors; result.external=external;
  await ctx.close();
  return result;
}
await mkdir(path.dirname(args.out), { recursive: true });
try {
  for (const route of routes) {
    results[route.name] = Object.fromEntries(Object.keys(origins).map(k=>[k,{url:new URL(route.path,origins[k]).href,runs:[]} ]));
    for (let i=0; i<counts; i++) {
      const order = i%2 ? Object.keys(origins).reverse() : Object.keys(origins);
      for (const k of order) {
        const r=await measure(origins[k],route,1440,false); results[route.name][k].runs.push(r);
        console.log(`${route.name} ${k} ${i+1}/${counts} ok=${r.ok} ready=${Math.round(r.ready??0)}ms ${r.error??""}`);
      }
    }
    for (const set of Object.values(results[route.name])) {
      const good=set.runs.filter(r=>r.ok); set.summary={n:set.runs.length,n_ok:good.length};
      for(const metric of ["ready","lcp","longtask","requests","bytes_total","jsBytes","cssBytes"])
        set.summary[metric]=Object.fromEntries([50,75,95].map(p=>["p"+p,good.length?pct(good.map(r=>r[metric]??0),p/100):null]));
    }
    if(args.guards) for(const width of [1440,390]) for(const [version,origin] of Object.entries(origins))
      guards.push({route:route.name,version,...await measure(origin,route,width,true)});
  }
} finally {
  await browser.close();
  await writeFile(args.out,JSON.stringify({started,finished:new Date().toISOString(),profile:"Fast4G 20ms/4Mbps/3Mbps",results,guards},null,2));
}
if(Object.values(results).some(v=>Object.values(v).some(s=>s.runs.some(r=>!r.ok))) || guards.some(g=>!g.ok)) process.exitCode=1;
