// R11 收尾轮 步骤 14（只读）：操作员视角打开终审面板，列出当前所有可控元素与逐条表态项。
// 不点击任何会改变 run 的按钮（只看、只截图），用来决定下一步的操作员动作序列。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6_000);

  log('=== 页面标题 ===');
  log('  ' + (await page.title()));

  log('\n=== 全部按钮（可见） ===');
  const buttons = await page.locator('button:visible').allInnerTexts();
  const seen = new Map();
  for (const raw of buttons) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  for (const [t, n] of seen) log(`  ${n > 1 ? `×${n} ` : '   '}${t.slice(0, 90)}`);

  log('\n=== 逐条表态项 ===');
  const items = page.locator('.review-disposition-item');
  const count = await items.count();
  log(`  条目数 ${count}`);
  for (let i = 0; i < count; i += 1) {
    const item = items.nth(i);
    const text = (await item.innerText()).replace(/\s+/g, ' ').trim();
    log(`  [${i}] ${text.slice(0, 200)}`);
  }

  log('\n=== 终审结论/指引文本 ===');
  for (const sel of ['.review-disposition-guide', '.review-disposition-blocker', '.review-disposition-note']) {
    const t = await page.locator(sel).allInnerTexts().catch(() => []);
    for (const x of t) if (x.trim()) log(`  ${sel}: ${x.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  }

  log('\n=== 可用输入框 ===');
  for (const el of await page.locator('input:visible, textarea:visible, select:visible').all()) {
    const name = await el.getAttribute('name').catch(() => null);
    const label = await el.getAttribute('aria-label').catch(() => null);
    const ph = await el.getAttribute('placeholder').catch(() => null);
    const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '?');
    log(`  <${tag}> name=${name ?? '-'} label=${label ?? '-'} placeholder=${(ph ?? '-').slice(0, 60)}`);
  }

  await shot(page, 'r14-final-review-surface');
  writeFileSync(`${ASSETS}/checks/step-r14-surface.txt`, lines.join('\n'));
});
