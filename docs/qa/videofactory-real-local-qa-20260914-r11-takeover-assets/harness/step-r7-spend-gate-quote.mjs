// R11 续轮 步骤 7：以操作员身份走到 assets 花钱关口，只执行第一阶段「获取费用报价」。
// 本步骤不授权、不购买、不拒绝：拿到服务端不可变报价后停下，交操作员复核金额与范围。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);

  // 展开 assets 节点工作区
  const gate = page.locator('section.spend-gate');
  if (!(await gate.count())) {
    const node = page.locator('article, section, li').filter({ hasText: '素材导演' }).first();
    if (await node.count()) { await node.click({ timeout: 5_000 }).catch(() => {}); await page.waitForTimeout(1_500); }
  }
  await gate.first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  log('=== 闸门可见 ===', await gate.count());

  const header = await gate.first().locator('div').first().innerText().catch(() => '(未读到)');
  log('=== 闸门抬头 ===\n' + header);

  const prepare = page.getByRole('button', { name: '获取费用报价' });
  const prepareCount = await prepare.count();
  log('=== 「获取费用报价」按钮数 ===', prepareCount);
  if (!prepareCount) {
    log('!! 未找到报价按钮，记录当前可见按钮与正文');
    log('按钮: ' + JSON.stringify((await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean)));
    log('正文:\n' + (await page.locator('body').innerText()).slice(0, 2500));
    await shot(page, 'r7-spend-gate-no-quote-button');
    writeFileSync(`${ASSETS}/checks/step-r7-spend-gate.txt`, lines.join('\n'));
    return;
  }
  log('=== 报价按钮 disabled ===', await prepare.first().isDisabled());

  const maxInput = gate.first().locator('input[type="number"]').first();
  if (await maxInput.count()) {
    log('=== 最高授权额输入 placeholder ===', await maxInput.getAttribute('placeholder'));
    log('=== 当前输入值（空=用默认上限）===', JSON.stringify(await maxInput.inputValue()));
  }

  await shot(page, 'r7a-before-quote');
  log('=== 点击「获取费用报价」 ===');
  await prepare.first().click();
  await page.waitForTimeout(4_000);
  await shot(page, 'r7b-after-quote');

  const summary = page.locator('.spend-quote-summary');
  if (await summary.count()) {
    log('=== 服务端报价 ===');
    const rows = await summary.first().locator('div').all();
    for (const row of rows) {
      const dt = (await row.locator('dt').innerText().catch(() => '')).trim();
      const dd = (await row.locator('dd').innerText().catch(() => '')).trim();
      if (dt || dd) log(`  ${dt} :: ${dd}`);
    }
  } else log('!! 未出现 .spend-quote-summary');

  for (const note of await page.locator('.spend-gate small').allInnerTexts()) {
    if (note.trim()) log('  · ' + note.trim());
  }
  const err = await page.locator('.spend-gate [role="alert"], .error, .field-error').allInnerTexts().catch(() => []);
  for (const e of err) if (e.trim()) log('  !! 错误: ' + e.trim());

  log('=== 闸门内按钮 ===');
  for (const b of await gate.first().locator('button').all()) {
    log(`  · ${JSON.stringify((await b.innerText()).trim())} disabled=${await b.isDisabled()}`);
  }

  const pageErrors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  if (pageErrors.length) { log('=== 页面错误 ==='); for (const m of pageErrors.slice(-10)) log('  ' + m.text.slice(0, 300)); }

  writeFileSync(`${ASSETS}/checks/step-r7-spend-gate.txt`, lines.join('\n'));
  log('=== 本步骤止于报价：未授权、未购买 ===');
});
