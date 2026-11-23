import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// UIUX-01/06/07 的静态样式契约统一收口：jsdom 不加载样式表、client tsconfig 也不含 node 类型，
// 读文件的断言放在 node 测试侧工程里跑；真实坐标与渲染效果仍留浏览器验收。

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const agentCss = read("../src/client/agent/agent.css");
const reviewCss = read("../src/client/agent/review-workspace.css");
const baseCss = read("../src/client/frame-base.css");
const settingsCss = read("../src/client/agent/frame-settings.css");
const settingsSource = read("../src/client/agent/FrameSettings.tsx");
const workbenchSource = read("../src/client/agent/AgentWorkbench.tsx");
const designDoc = read("../../../DESIGN.md");

test("UIUX-01 新消息提示样式契约：锚定滚动区底边，玻璃底浮层与输入框保持可分辨间距", () => {
  assert.ok(!agentCss.includes("bottom:171px"), "不得回到硬编码偏移");
  assert.match(agentCss, /\.agent-new-messages-anchor\s*\{[^}]*position:relative;[^}]*height:0;/);
  assert.match(agentCss, /\.agent-root \.agent-new-messages\s*\{[^}]*position:absolute;[^}]*bottom:16px;/);
  assert.match(agentCss, /\.agent-root \.agent-new-messages\s*\{[^}]*backdrop-filter:blur\(6px\);/);
});

test("UIUX-06 对话入口与切换作品热区样式契约：select 透明覆盖，暗栏按钮可挂未读圆点", () => {
  assert.match(reviewCss, /\.agent-work-switch\s*\{[^}]*min-height:36px;/);
  assert.match(reviewCss, /\.agent-work-switch select\s*\{[^}]*position:absolute;[^}]*inset:0;[^}]*opacity:0;/);
  assert.match(agentCss, /\.agent-rail button\s*\{[^}]*position:relative;/);
  assert.match(agentCss, /\.agent-rail-dot\s*\{[^}]*border-radius:50%;[^}]*background:#d07a52;/);
});

test("UIUX-07 正文与衬线字体栈都不含低清点阵或老旧字体", () => {
  const bodyStack = /--font-body:([^;]+);/.exec(baseCss)![1]!;
  const editorialStack = /--font-editorial:([^;]+);/.exec(baseCss)![1]!;
  assert.doesNotMatch(bodyStack, /SimSun|SimHei|STSong/i);
  assert.doesNotMatch(editorialStack, /SimSun|SimHei|STSong/i);
  // 跨平台现代回退齐备：macOS / HarmonyOS / Windows / 开源 Noto 系。
  for (const family of ["PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", "Source Han Sans SC", "Noto Sans SC", "Noto Sans CJK SC"]) {
    assert.ok(bodyStack.includes(`"${family}"`), bodyStack);
  }
  for (const family of ["Songti SC", "Noto Serif SC", "Source Han Serif SC", "STZhongsong", "FangSong"]) {
    assert.ok(editorialStack.includes(`"${family}"`), editorialStack);
  }
});

test("UIUX-07 首屏零中文字体阻塞：唯一 @font-face 仅覆盖拉丁子集", () => {
  const faces = baseCss.match(/@font-face\s*{[^}]*}/g) ?? [];
  assert.equal(faces.length, 1);
  assert.ok(faces[0]!.includes("unicode-range:U+0000-00FF"));
});

test("UIUX-07 版本号与计时元素固定等宽数字", () => {
  assert.match(baseCss, /time,\s*output\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
});

test("UIUX-07 DESIGN.md 字体说明与实际加载策略一致", () => {
  assert.ok(!designDoc.includes("随应用分发的 Noto Sans SC"));
  assert.ok(designDoc.includes("系统高质量现代 CJK 字体栈"));
  assert.ok(designDoc.includes("首屏零中文字体阻塞"));
  assert.ok(designDoc.includes("容器内渲染统一使用预装的 Noto Sans/Serif CJK SC"));
});

test("UIUX-03 冷绿清场：已扫除的十六进制不得回流三份样式表", () => {
  // 覆盖三类来源：低对比灰绿正文/图标、冷绿链接与选中态、冷绿边框与浅底。
  const denylist = [
    "#9aa79b", "#98a69c", "#8aa392", "#72937b", "#396e54", "#43836a", "#7a8d7b",
    "#477358", "#4c6b55", "#5a8260", "#648365", "#738b73", "#7b947c", "#91ad99",
    "#365e43", "#293a32", "#249359", "#8a6a52",
    "#ceded1", "#dbeadf", "#deebe2", "#dce6df", "#9eb1a4", "#dbe3de", "#e8eee9",
  ];
  for (const hex of denylist) {
    for (const [name, css] of [["agent.css", agentCss], ["frame-settings.css", settingsCss], ["frame-base.css", baseCss]] as const) {
      assert.ok(!css.includes(hex), `${name} 不应再包含 ${hex}`);
    }
  }
});

// WCAG 相对亮度与对比度：颜色值来自样式表 token/字面量，背景取真实承载面。
const channel = (value: number) => {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16 & 255) + 0.7152 * channel(n >> 8 & 255) + 0.0722 * channel(n & 255);
};
const contrast = (foreground: string, background: string) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

test("UIUX-03 WCAG 对比度：token 与语义色在真实背景上达标", () => {
  // 色彩 token 单源：只在 frame-base.css :root 声明；其余样式表重复声明同名色彩 token 即失败，防止两套值漂移。
  const tokens = new Map<string, string>();
  for (const match of baseCss.matchAll(/--frame-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(match[1]!, match[2]!);
  }
  for (const name of ["paper", "shelf", "soft", "ink", "muted", "line", "green", "green-tint", "amber", "accent", "disabled-bg", "disabled-ink"]) {
    assert.ok(tokens.has(name), `frame-base.css 缺少 --frame-${name}`);
  }
  for (const [file, css] of [["agent.css", agentCss], ["review-workspace.css", reviewCss], ["frame-settings.css", settingsCss]] as const) {
    for (const match of css.matchAll(/--frame-(?:paper|shelf|soft|ink|muted|line|green|green-tint|amber|accent|disabled-bg|disabled-ink):\s*#/g)) {
      assert.fail(`${file} 重复声明了色彩 token（唯一来源是 frame-base.css）：${match[0]}`);
    }
  }

  // 普通文字 ≥4.5：正文/链接/语义状态色 × 实际承载背景（纸面、架面、soft 底、白卡、深栏）。
  const textPairs: Array<[string, string, string]> = [
    ...(["ink", "muted", "green", "amber", "accent"] as const).flatMap(name => ([
      [tokens.get(name)!, tokens.get("paper")!, `--frame-${name} on paper`],
      [tokens.get(name)!, tokens.get("shelf")!, `--frame-${name} on shelf`],
      [tokens.get(name)!, tokens.get("soft")!, `--frame-${name} on soft`],
      [tokens.get(name)!, "#ffffff", `--frame-${name} on white`],
    ] as Array<[string, string, string]>)),
    ["#7a6541", "#faf6ea", "inline-note 琥珀 on #faf6ea"],
    [tokens.get("green")!, tokens.get("green-tint")!, "总览已认可胶囊 on green-tint"],
    ["#254b36", "#e6efe9", "认可印章 hover on #e6efe9"],
    ["#7a5c3e", "#ffffff", "connection-unavailable on 白卡"],
    ["#96513d", "#f2f1eb", "batch-error on 对话底"],
    ["#7b5419", "#fff4de", "pending 计数 on #fff4de"],
    ["#84644e", "#f8f2ec", "failed/cancelled on #f8f2ec"],
    ["#cbd0c8", "#222724", "rail 文本 on 深栏"],
  ];
  for (const [foreground, background, label] of textPairs) {
    assert.ok(contrast(foreground, background) >= 4.5, `${label}: ${contrast(foreground, background).toFixed(2)} < 4.5`);
  }

  // 图形/指示 ≥3：未读圆点、滚动条与选中边框。
  const graphicsPairs: Array<[string, string, string]> = [
    ["#d07a52", "#222724", "rail 未读圆点 on rw 栏底"],
    ["#d07a52", "#1e2523", "rail 未读圆点 on 栏底"],
    ["#66776e", "#1e2523", "rail 滚动条 on 栏底"],
    [tokens.get("green")!, tokens.get("paper")!, "选中/聚焦边框 on paper"],
  ];
  for (const [foreground, background, label] of graphicsPairs) {
    assert.ok(contrast(foreground, background) >= 3, `${label}: ${contrast(foreground, background).toFixed(2)} < 3`);
  }
});

test("UIUX-03 FrameSettings 免费服务图标换用 PlugZap，不再复用文件夹图标", () => {
  assert.ok(settingsSource.includes("PlugZap"), "FrameSettings 应引入 PlugZap");
  assert.ok(!settingsSource.includes("FolderOpen"), "FrameSettings 不应再使用 FolderOpen 表达接入状态");
});

test("UIUX-10 预算读取依赖是财务摘要键，不再是 runs 数组引用", () => {
  // view.runs 每轮快照都是新引用，进依赖会让挂载后的每轮快照都重读预算。
  assert.ok(workbenchSource.includes("runsFinanceKey"));
  assert.ok(workbenchSource.includes("runsFinanceKey, budgetAttempt, page]"), "依赖数组应使用 runsFinanceKey");
  assert.ok(!workbenchSource.includes("view.runs, budgetAttempt"), "依赖数组不应直接引用 view.runs");
});

test("UIUX-12 归档导出是纯 TS 流式实现：无子进程，crc32 在进程内计算", () => {
  const exportSource = read("../src/server/agent/export-bundle.ts");
  assert.ok(!exportSource.includes("child_process"), "导出不得再 spawn 子进程");
  assert.ok(!exportSource.includes("spawn("), "导出不得再 spawn 子进程");
  assert.ok(exportSource.includes('crc32 } from "node:zlib"'), "CRC 应使用进程内 zlib.crc32");
  assert.ok(exportSource.includes("MAX_ARCHIVE_STREAMS"), "导出应有并发流上限保护");
});
