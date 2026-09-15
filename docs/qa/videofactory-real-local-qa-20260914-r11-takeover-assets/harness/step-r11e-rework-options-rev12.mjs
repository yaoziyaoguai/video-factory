// R11 续轮 步骤 11e：revision 12（补查后）终审返修面的只读探明。
// 补查后否决项由 1 条变为 2 条（镜头 4、镜头 5），本步骤逐个展开其"替换后重新审片"候选，
// 记录候选集与提示文案，判断替换是否可行。不点击任何提交按钮，不改 run。
// 产出：checks/step-r11e-rework-options-rev12.{txt,json} 与截图 r11e-scene{4,5}-expanded。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const result = { runId: RUN_ID, panels: [] };

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);

  const panelText = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const anchor = buttons.find((b) => (b.innerText || '').includes('替换后重新审片'));
    if (!anchor) return null;
    let node = anchor;
    for (let i = 0; i < 8 && node.parentElement; i += 1) node = node.parentElement;
    return node.innerText;
  });
  log('=== 终审返修面板文本（含全部否决项）===\n' + String(panelText));
  result.panelText = panelText;

  // 逐个展开每个"镜头 N · 时码"chip，记录其候选下拉的可选项。
  const chipLabels = await page.evaluate(() => [...document.querySelectorAll('button')]
    .map((b) => (b.innerText || '').trim())
    .filter((t) => /^镜头 \d+ · /.test(t)));
  log('\n=== 发现返修 chip ===', JSON.stringify(chipLabels));
  result.chips = chipLabels;

  for (const label of chipLabels) {
    const entry = { label, dialog: null, buttonsAfter: [] };
    log(`\n=== 展开「${label}」 ===`);
    const chip = page.getByRole('button', { name: label, exact: true });
    if (!(await chip.count())) { log('  (未找到该 chip)'); result.panels.push(entry); continue; }
    await chip.first().click();
    await page.waitForTimeout(1_200);
    entry.dialog = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')]
      .map((d) => d.innerText).join('\n---\n') || null);
    log('  弹出内容: ' + (entry.dialog ? entry.dialog.slice(0, 1500) : '(无 dialog/listbox/menu)'));
    entry.buttonsAfter = (await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
    log('  展开后按钮: ' + JSON.stringify(entry.buttonsAfter));
    await shot(page, `r11e-scene${label.match(/^镜头 (\d+)/)?.[1] ?? 'x'}-expanded`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    result.panels.push(entry);
  }

  // 每个否决项各带一个 <select>，其 options 即候选集（代码：1 … scenePosition-1）
  const selects = await page.locator('select').all();
  log('\n=== 全部 select 的候选集 ===');
  result.selects = [];
  for (const s of selects) {
    const opts = await s.locator('option').allInnerTexts();
    if (opts.some((t) => t.trim())) { log('  ' + JSON.stringify(opts)); result.selects.push(opts); }
  }

  // 镜头 1 是否根本无法返修（scenePosition-1 = 0 → sourceOptions 空 → 控件不渲染）
  log('\n=== 镜头 1 是否暴露返修控件 ===');
  const hasScene1 = chipLabels.some((t) => /^镜头 1 · /.test(t));
  log('  ' + (hasScene1 ? '暴露（与代码预期不符，需追查）' : '未暴露（与 RunWorkbench.tsx:938 守卫一致）'));
  result.scene1ReworkExposed = hasScene1;

  for (const m of consoleMessages.filter((x) => x.type === 'error' || x.type === 'pageerror').slice(-6)) log('  pageerror ' + m.text.slice(0, 200));

  await shot(page, 'r11e-final-review-rev12');
  writeFileSync(`${ASSETS}/checks/step-r11e-rework-options-rev12.txt`, lines.join('\n'));
  writeFileSync(`${ASSETS}/checks/step-r11e-rework-options-rev12.json`, JSON.stringify(result, null, 2));
});
