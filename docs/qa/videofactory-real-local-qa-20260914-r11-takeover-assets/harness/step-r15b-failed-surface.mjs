// R11 收尾轮 步骤 15b（只读）：操作员视角打开**失败态**的 run，列出页面给出的全部动作与错误文案。
// 不点击任何改变 run 的按钮。目的：先看清产品在这个状态下到底提供了哪些恢复动作。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8_000);

  log('=== 页面标题 ===');
  log('  ' + (await page.title()));

  log('\n=== 可见按钮 ===');
  const seen = new Map();
  for (const raw of await page.locator('button:visible').allInnerTexts()) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    seen.set(t, (seen.get(t) ?? 0) + 1);
  }
  for (const [t, n] of seen) log(`  ${n > 1 ? `×${n} ` : '   '}${t.slice(0, 110)}`);

  log('\n=== 可见错误/状态文案 ===');
  for (const sel of ['.node-error', '.run-error', '[class*="error"]', '[class*="failed"]']) {
    const all = await page.locator(sel).allInnerTexts().catch(() => []);
    for (const t of all) {
      const c = t.replace(/\s+/g, ' ').trim();
      if (c) log(`  ${sel}: ${c.slice(0, 300)}`);
    }
  }

  log('\n=== 节点状态区块 ===');
  const nodeBlocks = await page.locator('[class*="node-card"], [class*="node-run"], [class*="NodeCard"]').all();
  log(`  区块数 ${nodeBlocks.length}`);
  for (const block of nodeBlocks.slice(0, 20)) {
    const t = (await block.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (t) log(`  - ${t.slice(0, 220)}`);
  }

  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-6)) {
    log('  pageerror ' + m.text.slice(0, 200));
  }
  await shot(page, 'r15b-failed-surface');
  writeFileSync(`${ASSETS}/checks/step-r15b-failed-surface.txt`, lines.join('\n'));
});
