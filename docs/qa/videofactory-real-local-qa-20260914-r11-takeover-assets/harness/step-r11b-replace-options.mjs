// R11 续轮 步骤 11b：只读探明成片终审的"替换后重新审片"会提供哪些替换来源。
// 不点击任何提交按钮；只展开选择器并记录候选，判断替换是否会造成字幕与画面不符。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);

  // 定位终审面板：包含"替换后重新审片"的区域
  const panelText = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const anchor = buttons.find((b) => (b.innerText || '').includes('替换后重新审片'));
    if (!anchor) return null;
    let node = anchor;
    for (let i = 0; i < 8 && node.parentElement; i += 1) node = node.parentElement;
    return node.innerText;
  });
  log('=== 终审面板文本 ===\n' + String(panelText).slice(0, 3000));

  // scene 4 选择器：找出 chip 与其可选项
  const chips = await page.evaluate(() => [...document.querySelectorAll('button, [role="tab"], [role="radio"], select, option')]
    .map((el) => ({ tag: el.tagName, text: (el.innerText || el.textContent || '').trim().slice(0, 60), role: el.getAttribute('role'), name: el.getAttribute('name') }))
    .filter((x) => x.text));
  log('\n=== 候选控件 ===');
  for (const c of chips.filter((x) => /镜头|scene|替换|00:/.test(x.text))) log('  ' + JSON.stringify(c));

  const selects = await page.locator('select').all();
  log('\n=== select 元素数 ===', selects.length);
  for (const s of selects) {
    const opts = await s.locator('option').allInnerTexts();
    log('  options=' + JSON.stringify(opts));
  }

  // 直接展开"镜头 4"chip（若为按钮），看它是否弹出候选列表
  const chip = page.getByRole('button', { name: /镜头 4 · 00:10/ });
  if (await chip.count()) {
    log('\n=== 展开 镜头 4 chip ===');
    await chip.first().click();
    await page.waitForTimeout(1_200);
    const after = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')];
      return dialogs.map((d) => d.innerText).join('\n---\n');
    });
    log('  弹出内容: ' + (after ? after.slice(0, 2000) : '(无 dialog/listbox/menu)'));
    const allButtons = (await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
    log('  展开后按钮: ' + JSON.stringify(allButtons));
    await shot(page, 'r11b-scene4-expanded');
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    log('\n(未找到 镜头 4 chip 按钮)');
  }

  const errs = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  for (const m of errs.slice(-6)) log('  pageerror ' + m.text.slice(0, 200));

  await shot(page, 'r11b-final-review-panel');
  writeFileSync(`${ASSETS}/checks/step-r11b-replace-options.txt`, lines.join('\n'));
});
