#!/usr/bin/env node
// Frame 性能棘轮：对 frame-measure.mjs 产出的配对文档做合同校验 + 门槛比较 + 护栏消费。
// 原则（对应审计 A03 的三条假通过路径）：
//   1) 结构校验先于浏览器启动：缺 route/缺侧/缺样本/指标 null/护栏重复缺侧/缺 golden/形状不符/缺构建身份/文档重复键
//      一律 FAIL 并点名缺项，不靠崩溃或空比较放行。
//   2) 分位数只从原始 runs 复算（与 frame-measure 的 pct 同口径），summary 只作一致性比对，
//      不作为门槛数据源；null/NaN/负值样本视为有效样本不足。
//   3) 护栏按 route 消费实际形状：open=images 像素比对，send=golden/screenshot 合同；
//      guards 出现的 route 必须也有 results 该 route。
// 负向自检常驻：node frame-ratchet.mjs --selftest（内置 fixtures/ 三份探针，无需浏览器）。
// 接受时更新棘轮上限：node frame-ratchet.mjs <paired.json> --update-ceiling
//   方法（预先定义，勿事后调整）：newCeiling = min(旧值, pct(B 侧原始样本, 0.75))，
//   不加余量、不取 A 侧；来源文件与样本数写入 history。
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { compareSendGuards, lineSetHash, SCRIPT_TITLES } from "./frame-send-guard.mjs";
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(v => v.startsWith("--")));
const file = argv.find(v => !v.startsWith("--"));
const usage = "usage: node frame-ratchet.mjs <paired.json> [--update-ceiling] | node frame-ratchet.mjs --selftest";
const ceilingUrl = new URL("frame-ceilings.json", import.meta.url);

const ROUTES = ["open", "send"];
const WIDTHS = [1440, 960];
// 门槛指标：open 三项都要求 B<=A 配对；ceiling 检查仅在对应键存在时执行（inputReadyMs 首次接受时建立）。
// settingsNavMs 只验样本完整性，不设门槛（无改善证据，观察单列）。
const GATE_METRICS = { open: ["ready", "fontReady", "inputReadyMs", "cssBytes"], send: ["firstFeedbackMs", "turnDoneMs"] };
const OBSERVED_METRICS = { open: ["settingsNavMs"], send: [] };
// 配对容差（2026-11-18 修订，依据 R6 四轮完整配对实测）：send 旅程发生在页面加载完成之后，
// A/B 唯一差异（压缩字节）不在其关键路径，四轮 firstFeedbackMs/turnDoneMs 的 A/B 差在
// 0.06%–1.1% 区间随机双向（+2.4ms/+2.7ms/+1.9ms 等），严格 B<=A 等于要求噪音方向正确。
// 2% 容差覆盖全部观测噪音且远小于真实回归量级；open 门槛维持严格 B<=A
// （压缩收益直接作用于首屏，四轮 B 稳定快约 3 倍，容差不改变其判别力）。
const PAIR_TOLERANCE = { open: 0, send: 0.02 };

// 与 frame-measure.mjs 的 pct 完全同口径：type-7 线性插值，round 0.1。
const pct = (values, p) => {
  const a = [...values].sort((x, y) => x - y);
  const n = (a.length - 1) * p;
  return Math.round((a[Math.floor(n)] + (a[Math.ceil(n)] - a[Math.floor(n)]) * (n % 1)) * 10) / 10;
};
const isSample = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
const ceilingGate = (ceiling, key) => ceiling.gates?.[key] ?? ceiling[key];

// JSON.parse 对同对象重复键静默取末值，改写出重复键的文档可携带两套值绕过结构校验，先扫一遍拒绝。
function parseRejectingDuplicateKeys(text, label) {
  const objectKeys = [];
  let inString = false, escaped = false, buf = "", lastString = null;
  for (const ch of text) {
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === "\\") { escaped = true; }
      else if (ch === '"') { inString = false; lastString = buf; continue; }
      buf += ch;
      continue;
    }
    if (ch === '"') { inString = true; buf = ""; continue; }
    if (ch === "{") { objectKeys.push(new Set()); continue; }
    if (ch === "}") { objectKeys.pop(); continue; }
    if (ch === ":" && objectKeys.length) {
      const keys = objectKeys[objectKeys.length - 1];
      if (keys.has(lastString)) throw new Error(`${label}: 对象内重复键 "${lastString}"（JSON.parse 静默取末值，棘轮拒绝）`);
      keys.add(lastString);
    }
  }
  return JSON.parse(text);
}

function validate(doc, ceiling) {
  const errors = [];
  const recomputed = {};
  if (doc.profile !== ceiling.profile) errors.push(`测速口径不一致: doc=${doc.profile} ceiling=${ceiling.profile}`);
  if (!doc.builds || typeof doc.builds !== "object") errors.push("缺少构建身份 builds");
  else for (const side of ["A", "B"]) if (!doc.builds[side]?.label) errors.push(`缺少构建身份 builds.${side}.label`);

  const routes = Object.keys(doc.results ?? {});
  if (!routes.length) errors.push("缺少必需 route open（results 为空）");
  for (const route of routes) {
    if (!ROUTES.includes(route)) { errors.push(`未知 route ${route}（只允许 open,send）`); continue; }
    const versions = doc.results[route] ?? {};
    for (const side of ["A", "B"]) if (!versions[side]) errors.push(`route ${route} 缺少 ${side} 侧数据`);
    for (const [side, version] of Object.entries(versions)) {
      if (!Array.isArray(version?.runs) || version.runs.length === 0) { errors.push(`route ${route} ${side}: runs 缺失或为空`); continue; }
      const summary = version.summary ?? {};
      const good = version.runs.filter(r => r?.ok === true);
      const sharedServer = doc.transferComparison === "shared-server";
      const minimum = sharedServer && route === "send" ? 40 : 10;
      if (sharedServer && good.some(run => run.entryCssEncoding !== (side === "A" ? "identity" : "br")))
        errors.push(`route ${route} ${side}: 初始样式的响应编码与采样侧不符`);
      if (summary.n !== version.runs.length) errors.push(`route ${route} ${side}: summary.n=${summary.n} 与 runs 实测 ${version.runs.length} 不一致`);
      if (summary.n_ok !== good.length) errors.push(`route ${route} ${side}: summary.n_ok=${summary.n_ok} 与有效样本 ${good.length} 不一致`);
      if (good.length < minimum) errors.push(`route ${route} ${side}: 有效样本 ${good.length} < ${minimum}`);
      recomputed[`${route}.${side}`] = {};
      for (const metric of [...GATE_METRICS[route], ...OBSERVED_METRICS[route]]) {
        const raw = good.map(r => r?.[metric]);
        const valid = raw.filter(isSample);
        const invalid = raw.length - valid.length;
        if (invalid) errors.push(`route ${route} ${side} 指标 ${metric}: ${invalid} 个样本为 null/非有限/负值，有效样本 ${valid.length}`);
        if (valid.length < minimum) { errors.push(`route ${route} ${side} 指标 ${metric}: 有效样本 ${valid.length} < ${minimum}，p75 不可信`); continue; }
        const p75 = pct(valid, 0.75);
        recomputed[`${route}.${side}`][metric] = { p75, values: valid, n: valid.length };
        const claimed = summary[metric]?.p75;
        if (!isSample(claimed)) errors.push(`route ${route} ${side} 指标 ${metric}: summary.p75 为 null/非有限（原始样本复算=${p75}）`);
        else if (Math.abs(claimed - p75) > 0.1) errors.push(`route ${route} ${side} 指标 ${metric}: summary.p75=${claimed} 与原始样本复算 ${p75} 不一致`);
      }
    }
    // 配对门槛：B<=A×(1+容差)（容差见 PAIR_TOLERANCE 注释；两侧 gate 指标都复算成功才执行）；ceiling 仅在键存在时检查。
    if (recomputed[`${route}.A`] && recomputed[`${route}.B`]) {
      for (const metric of GATE_METRICS[route]) {
        const a = recomputed[`${route}.A`][metric], b = recomputed[`${route}.B`][metric];
        if (!a || !b) continue;
        const tol = PAIR_TOLERANCE[route] ?? 0;
        if (b.p75 > a.p75 * (1 + tol)) errors.push(`route ${route} 指标 ${metric}: 配对 p75 变慢 B=${b.p75} > A=${a.p75}×${(1 + tol).toFixed(2)}`);
        const cap = ceilingGate(ceiling, `${route}::${metric}_p75`);
        if (metric === "cssBytes" && cap !== undefined && a.p75 > cap) errors.push(`route ${route} 原始 CSS p75=${a.p75} 超过上限 ${cap}`);
        if (cap !== undefined && b.p75 > cap) errors.push(`route ${route} 指标 ${metric}: B p75=${b.p75} 超过棘轮上限 ${cap}`);
      }
    }
  }
  if (routes.includes("open") && ceilingGate(ceiling, "open::ready_p75") === undefined) errors.push("ceiling 缺少 open::ready_p75（先建立基线）");
  return { errors, recomputed };
}

function validateGuards(doc, errors) {
  const guards = Array.isArray(doc.guards) ? doc.guards : [];
  if (!guards.length) { errors.push("缺少护栏 guards（需 {A,B}×{1440,960}）"); return new Map(); }
  const byKey = new Map();
  for (const g of guards) {
    if (!g || typeof g !== "object") { errors.push("护栏条目不是对象"); continue; }
    for (const field of ["version", "route", "width", "ok"]) if (g[field] === undefined) errors.push(`护栏缺少 ${field} 字段（version=${g.version ?? "?"}）`);
    if (!["A", "B"].includes(g.version)) errors.push(`护栏 version 非法: ${String(g.version)}`);
    if (g.route !== undefined && !ROUTES.includes(g.route)) errors.push(`护栏 route 非法: ${String(g.route)}`);
    if (g.route === undefined || g.width === undefined || g.version === undefined) continue;
    const key = `${g.version}|${g.route}|${g.width}`;
    if (byKey.has(key)) errors.push(`护栏重复: ${key}`);
    byKey.set(key, g);
  }
  const routesInGuards = new Set([...byKey.values()].map(g => g.route));
  for (const route of routesInGuards) if (!(doc.results ?? {})[route]) errors.push(`guards 含 route ${route} 但 results 缺该 route`);
  for (const route of Object.keys(doc.results ?? {})) {
    if (!ROUTES.includes(route)) continue;
    if (!routesInGuards.has(route)) { errors.push(`route ${route} 缺少护栏`); continue; }
    for (const version of ["A", "B"]) for (const width of WIDTHS) {
      const g = byKey.get(`${version}|${route}|${width}`);
      if (!g) { errors.push(`route ${route} 缺少护栏 ${version}/${width}`); continue; }
      if (g.ok !== true) errors.push(`route ${route} 护栏 ${version}/${width}: ok=${String(g.ok)}`);
      if (g.overflow === true) errors.push(`route ${route} 护栏 ${version}/${width}: overflow`);
      if (route === "open") {
        const images = Array.isArray(g.images) ? g.images : [];
        if (!images.length) { errors.push(`route open 护栏 ${version}/${width}: 缺少 images 截图集`); continue; }
        const names = images.map(i => i?.name);
        for (const need of ["open", "models"]) if (!names.includes(need)) errors.push(`route open 护栏 ${version}/${width}: images 缺少 ${need} 截图`);
        if (new Set(names).size !== names.length) errors.push(`route open 护栏 ${version}/${width}: images 名称重复`);
        for (const image of images) {
          if (typeof image?.file !== "string" || !image.file) errors.push(`route open 护栏 ${version}/${width}: image.file 缺失（name=${String(image?.name)}）`);
          if (typeof image?.golden !== "string" || !image.golden) errors.push(`route open 护栏 ${version}/${width}: image.golden 缺失（name=${String(image?.name)}）`);
        }
      } else {
        if (!g.screenshotFile) errors.push(`route send 护栏 ${version}/${width}: 缺少 screenshotFile 路径`);
        if (typeof g.golden !== "string" || !g.golden) errors.push(`route send 护栏 ${version}/${width}: 缺少 golden 哈希`);
        if (typeof g.screenshot !== "string" || !g.screenshot) errors.push(`route send 护栏 ${version}/${width}: 缺少 screenshot 哈希`);
      }
    }
  }
  // open 的同名截图 golden 应相等且不溢出。send 比较按次数保留的可见行和三张准确 v1 引用卡。
  // 工作区交付卡排序键含随机成分，两侧像素可能不同。
  // 两侧 screenshotFile 必须存在（checkFiles）且哈希随 JSON 留档，供事后人工比对。
  for (const route of routesInGuards) {
    if (!(doc.results ?? {})[route]) continue;
    for (const width of WIDTHS) {
      const a = byKey.get(`A|${route}|${width}`), b = byKey.get(`B|${route}|${width}`);
      if (!a || !b) continue;
      if (route === "open" && Array.isArray(a.images)) for (const left of a.images) {
        const right = Array.isArray(b.images) ? b.images.find(i => i.name === left.name) : null;
        if (!right) { errors.push(`route open 护栏 ${width}: B 侧缺 ${String(left.name)} 截图`); continue; }
        if (typeof left.file === "string" && typeof right.file === "string" && path.resolve(left.file) === path.resolve(right.file)) errors.push(`route open 护栏 ${width}/${left.name}: 两侧共用截图文件`);
        if (left.overflow || right.overflow) errors.push(`route open 护栏 ${width}/${String(left.name)}: 溢出`);
        if (left.golden !== right.golden) errors.push(`route open 护栏 ${width}/${String(left.name)}: 可见文字改变`);
      }
      if (route === "send") {
        if (typeof a.screenshotFile === "string" && typeof b.screenshotFile === "string" && path.resolve(a.screenshotFile) === path.resolve(b.screenshotFile)) errors.push(`route send 护栏 ${width}: 两侧共用截图文件`);
        const difference = compareSendGuards(a, b);
        if (difference) errors.push(`route send 护栏 ${width}: ${difference}`);
      }
    }
  }
  return byKey;
}

async function checkFiles(doc, errors) {
  for (const g of doc.guards ?? []) {
    if (!g || typeof g !== "object") continue;
    if (g.route === "open" && Array.isArray(g.images)) for (const image of g.images) {
      if (typeof image?.file !== "string" || !image.file) continue;
      try { await access(image.file); } catch { errors.push(`截图文件不存在: ${image.file}`); }
    }
    if (g.route === "send" && g.screenshotFile) {
      try { await access(g.screenshotFile); } catch { errors.push(`send 截图文件不存在: ${g.screenshotFile}`); }
    }
  }
}

async function selftest() {
  const ceiling = JSON.parse(await readFile(ceilingUrl, "utf8"));
  const cases = [
    ["fixtures/ratchet-empty-probe.json", "缺少必需 route open"],
    ["fixtures/ratchet-null-metrics-probe.json", "null"],
    ["fixtures/ratchet-send-shape-probe.json", "guards 含 route send 但 results 缺该 route"],
  ];
  let failed = 0;
  for (const [name, expected] of cases) {
    const doc = JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
    const { errors } = validate(doc, ceiling);
    validateGuards(doc, errors);
    await checkFiles(doc, errors);
    const pass = errors.length > 0 && errors.some(e => e.includes(expected));
    console.log(`${pass ? "PASS" : "FAIL"} selftest ${name}: ${errors.length} 项错误${pass ? "" : `，未含期望缺项「${expected}」；实际: ${errors.slice(0, 5).join(" | ")}`}`);
    if (!pass) failed++;
  }
  const reviewed = { title: SCRIPT_TITLES[0], revisionNumber: 1 };
  const oldReferences = SCRIPT_TITLES.map(title => [title, "脚本 · v1", title]);
  const newReferences = SCRIPT_TITLES.map(title => ["脚本 · v1", `现名：${title}`, `脚本 · v1，现名：${title}`]);
  const unchanged = ["Frame", "发送", ...SCRIPT_TITLES, "脚本 · v1", "脚本 · v1", "脚本 · v1"];
  const left = { reviewed, referenceCards: oldReferences, lines: [...unchanged, ...SCRIPT_TITLES] };
  const right = { reviewed, referenceCards: newReferences, lines: [...unchanged, ...SCRIPT_TITLES.map(title => `现名：${title}`)] };
  const withDigest = guard => ({ ...guard, golden: lineSetHash(guard.lines) });
  const sendCases = [
    ["三处现名与排列变化", { ...right, lines: [...right.lines].reverse(), referenceCards: [...newReferences].reverse() }, true],
    ["引用不变", left, true],
    ["误选 v2", { ...right, reviewed: { ...reviewed, revisionNumber: 2 } }, false],
    ["误选同会话其他作品", { ...right, reviewed: { ...reviewed, title: SCRIPT_TITLES[1] } }, false],
    ["引用误绑到 v3", { ...right, referenceCards: [["脚本 · v3", newReferences[0][1], newReferences[0][2]], ...newReferences.slice(1)] }, false],
    ["非审核标题改变", { ...right, lines: right.lines.map(line => line === "发送" ? "排队" : line) }, false],
    ["允许的标题出现多一次", { ...right, lines: [...right.lines, newReferences[0][1]] }, false],
    ["缺少一个原样保留的标题", { ...right, lines: right.lines.filter(line => line !== SCRIPT_TITLES[0]) }, false],
    ["引用跨作品重复", { ...right, referenceCards: [newReferences[0], newReferences[0], newReferences[2]] }, false],
  ];
  for (const [name, guard, accepted] of sendCases) {
    const difference = compareSendGuards(withDigest(left), withDigest(guard));
    const pass = (difference === null) === accepted;
    console.log(`${pass ? "PASS" : "FAIL"} selftest send ${name}${difference ? ` — ${difference}` : ""}`);
    if (!pass) failed++;
  }
  const runs = Array.from({ length: 10 }, () => ({ ok: true, entryCssEncoding: "br", firstFeedbackMs: 3, turnDoneMs: 200 }));
  const side = { runs, summary: { n: 10, n_ok: 10, firstFeedbackMs: { p75: 3 }, turnDoneMs: { p75: 200 } } };
  const probe = { profile: ceiling.profile, builds: { A: { label: "identity" }, B: { label: "br" } }, transferComparison: "shared-server",
    results: { send: { A: side, B: side } }, guards: ["A", "B"].map(version => ({ version, route: "send", width: 1440, ok: true,
      ...withDigest(left), screenshotFile: "same.png", screenshot: "x" })) };
  const evidenceErrors = validate(probe, ceiling).errors;
  validateGuards(probe, evidenceErrors);
  const missingProof = ["有效样本 10 < 40", "初始样式的响应编码", "两侧共用截图文件"];
  for (const expected of missingProof) {
    const pass = evidenceErrors.some(error => error.includes(expected));
    console.log(`${pass ? "PASS" : "FAIL"} selftest 拒绝 ${expected}`);
    if (!pass) failed++;
  }
  if (failed) { console.error(JSON.stringify({ status: "FAIL", stage: "selftest", failed }, null, 2)); return 1; }
  console.log(JSON.stringify({ status: "PASS", stage: "selftest", cases: cases.length + sendCases.length + missingProof.length }, null, 2));
  return 0;
}

if (flags.has("--selftest")) process.exit(await selftest());
if (!file) throw new Error(usage);

const document = parseRejectingDuplicateKeys(await readFile(file, "utf8"), file);
const ceiling = JSON.parse(await readFile(ceilingUrl, "utf8"));
const { errors, recomputed } = validate(document, ceiling);
validateGuards(document, errors);
await checkFiles(document, errors);
if (errors.length) {
  console.error(JSON.stringify({ status: "FAIL", stage: "validate", errors }, null, 2));
  process.exit(1);
}

const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
} catch (e) {
  throw new Error(`无法启动浏览器（未安装 Playwright headless shell 时需设置 PLAYWRIGHT_EXECUTABLE_PATH 指向已安装的 Chrome/Chromium）: ${e.message}`);
}
const comparisons = [];
try {
  const page = await browser.newPage();
  // 像素比对仅适用 open 护栏（send 用哈希合同，已在结构校验中完成）。
  for (const before of document.guards.filter(g => g.version === "A" && g.route === "open")) {
    const after = document.guards.find(g => g.version === "B" && g.route === "open" && g.width === before.width);
    for (const left of before.images) {
      const right = after.images.find(image => image.name === left.name);
      const result = await page.evaluate(async ({ a, b }) => {
        const load = src => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
        const [one, two] = await Promise.all([load(a), load(b)]);
        if (one.width !== two.width || one.height !== two.height) throw new Error("截图尺寸不同");
        const canvas = document.createElement("canvas"); canvas.width = one.width; canvas.height = one.height;
        const context = canvas.getContext("2d");
        context.drawImage(one, 0, 0); const aa = context.getImageData(0, 0, one.width, one.height).data;
        context.clearRect(0, 0, one.width, one.height); context.drawImage(two, 0, 0);
        const bb = context.getImageData(0, 0, one.width, one.height).data;
        let changed = 0;
        for (let i = 0; i < aa.length; i += 4) if (Math.max(Math.abs(aa[i] - bb[i]), Math.abs(aa[i + 1] - bb[i + 1]), Math.abs(aa[i + 2] - bb[i + 2])) > 20) changed++;
        return { changed, fraction: changed / (one.width * one.height) };
      }, { a: `data:image/png;base64,${(await readFile(left.file)).toString("base64")}`, b: `data:image/png;base64,${(await readFile(right.file)).toString("base64")}` });
      comparisons.push({ name: left.name, width: left.width, ...result });
      assert.ok(result.fraction <= 0.001, `${left.name}/${left.width}: 像素变化超过0.1%`);
    }
  }
  const summary = { status: "PASS", builds: document.builds, gates: Object.fromEntries(Object.entries(recomputed).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([m, s]) => [m, s.p75]))])), comparisons };
  console.log(JSON.stringify(summary, null, 2));
  await writeFile(`${file}.guards.json`, JSON.stringify(summary, null, 2));
  if (flags.has("--update-ceiling")) await updateCeiling(recomputed, summary);
} finally { await browser.close(); }

async function updateCeiling(recomputed, summary) {
  // 预定方法：newCeiling = min(旧值, pct(B 侧 gate 指标原始样本, 0.75))；不加余量、不取 A 侧。
  const history = Array.isArray(ceiling.history) ? [...ceiling.history] : [];
  if (!history.length) history.push({ baseline: ceiling.baseline, date: "2026-11-17", gates: { "open::ready_p75": ceilingGate(ceiling, "open::ready_p75"), "open::fontReady_p75": ceilingGate(ceiling, "open::fontReady_p75") }, source: "初始基线 545ccf2 配对（perf/.local/paired-compression.json）", n: 10 });
  const gates = { ...(ceiling.gates ?? {}) };
  for (const metric of GATE_METRICS.open) {
    const b = recomputed["open.B"]?.[metric];
    if (!b) continue;
    const key = `open::${metric}_p75`;
    const old = ceilingGate(ceiling, key);
    const next = old === undefined ? b.p75 : Math.min(old, b.p75);
    gates[key] = next;
    history.push({ baseline: document.builds.B.label, date: document.finished, gates: { [key]: next }, from: old ?? null, computedFromB: b.p75, source: path.relative(process.cwd(), file), n: b.n, method: "min(old, pct(B raw samples, 0.75))" });
  }
  const reference = ceiling.reference ?? Object.fromEntries(["open::jsBytes", "open::cssBytes", "open::fontBytes", "open::requests"].filter(k => ceiling[k] !== undefined).map(k => [k, ceiling[k]]));
  const updated = { baseline: document.builds.B.label, profile: ceiling.profile, gates, reference, note: "reference 为观察字段，不设门槛", history };
  await writeFile(ceilingUrl, JSON.stringify(updated, null, 2) + "\n");
  console.log(JSON.stringify({ status: "CEILING_UPDATED", gates, source: path.relative(process.cwd(), file) }, null, 2));
}
