// R11 收尾轮 步骤 17（只读）：操作员视角打开 needs_human 的成片终审，列出产品给出的全部裁决动作。
// 不点击任何改变 run 的按钮。先看清"我能做什么"，再决定怎么批。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9_000);

  log('=== 页面标题 ===');
  log('  ' + (await page.title()));

  log('\n=== 全部可见按钮（含 disabled 状态）===');
  const seen = new Map();
  for (const btn of await page.locator('button:visible').all()) {
    const t = (await btn.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const dis = await btn.isDisabled().catch(() => null);
    const key = `${t}${dis ? ' [disabled]' : ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [t, n] of seen) log(`  ${n > 1 ? `×${n} ` : '   '}${t.slice(0, 120)}`);

  log('\n=== 可输入控件（批准理由可能在这里）===');
  for (const sel of ['textarea', 'input[type="text"]', 'select']) {
    const items = await page.locator(`${sel}:visible`).all();
    for (const el of items) {
      const ph = await el.getAttribute('placeholder').catch(() => null);
      const name = await el.getAttribute('name').catch(() => null);
      log(`  ${sel} placeholder=${JSON.stringify(ph)} name=${JSON.stringify(name)}`);
    }
  }

  log('\n=== 可见的裁决/终审区块文案 ===');
  for (const sel of ['[class*="final"]', '[class*="decision"]', '[class*="review"]', '[class*="approve"]']) {
    const all = await page.locator(sel).all().catch(() => []);
    let printed = 0;
    for (const block of all) {
      const t = (await block.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!t || t.length > 700) continue;
      log(`  ${sel}: ${t.slice(0, 400)}`);
      printed += 1;
      if (printed >= 3) break;
    }
  }

  log('\n=== 逐条 finding 是否带独立动作（缺陷 P 的关键判据）===');
  const findingRows = await page.locator('[class*="finding"], [class*="Finding"]').all().catch(() => []);
  log(`  finding 行数: ${findingRows.length}`);
  let withButton = 0;
  for (const row of findingRows.slice(0, 20)) {
    const btns = await row.locator('button').count().catch(() => 0);
    if (btns > 0) withButton += 1;
  }
  log(`  其中带按钮的行: ${withButton}`);

  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-6)) {
    log('  pageerror ' + m.text.slice(0, 200));
  }
  await shot(page, 'r17-final-review-surface');
  writeFileSync(`${ASSETS}/checks/step-r17-final-review-surface.txt`, lines.join('\n'));
});
