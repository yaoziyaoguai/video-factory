// R11 续轮 步骤 8：操作员复核报价后授权 assets 范围费用（最高 ¥17.00）。
// 预算依据：本轮已发生 ¥13.50 + 在途最坏 ¥10.00 = ¥23.50，¥50 授权余额 ¥26.50 ≥ ¥17.00。
// 授权后流水线在范围内自动继续（含有限修复），不再逐项打扰。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);

  // 若报价尚未在本会话生成，先重新取一次（prepare 不授权、不花钱）
  if (!(await page.locator('.spend-quote-summary').count())) {
    const prepare = page.getByRole('button', { name: '获取费用报价' });
    if (await prepare.count()) {
      log('=== 本会话未持有报价，先重新获取 ===');
      await prepare.first().click();
      await page.waitForTimeout(4_000);
    }
  }

  const summary = page.locator('.spend-quote-summary');
  if (!(await summary.count())) { log('!! 未取得报价，终止，不授权'); writeFileSync(`${ASSETS}/checks/step-r8-authorize.txt`, lines.join('\n')); return; }

  const amount = (await summary.first().locator('div').filter({ hasText: '最高授权' }).first().locator('dd').innerText().catch(() => '')).trim();
  log('=== 待授权最高额 ===', amount);

  const authorize = page.getByRole('button', { name: /确认并授权/ });
  if (!(await authorize.count())) { log('!! 未找到授权按钮，终止'); writeFileSync(`${ASSETS}/checks/step-r8-authorize.txt`, lines.join('\n')); return; }
  const label = (await authorize.first().innerText()).trim();
  log('=== 授权按钮 ===', JSON.stringify(label), 'disabled=', await authorize.first().isDisabled());
  if (await authorize.first().isDisabled()) { log('!! 按钮不可用，终止不授权'); writeFileSync(`${ASSETS}/checks/step-r8-authorize.txt`, lines.join('\n')); return; }

  await shot(page, 'r8a-before-authorize');
  log('=== 点击授权 ===');
  await authorize.first().click();
  await page.waitForTimeout(6_000);
  await shot(page, 'r8b-after-authorize');

  const gate = page.locator('section.spend-gate').first();
  if (await gate.count()) {
    log('=== 授权后闸门状态 ===');
    for (const t of (await gate.innerText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12)) log('  ' + t);
  }
  const err = await page.locator('[role="alert"], .error').allInnerTexts().catch(() => []);
  for (const e of err) if (e.trim()) log('  !! 错误: ' + e.trim());

  const detail = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.text();
  }, `/api/runs/${RUN_ID}`);
  const j = JSON.parse(detail);
  log('=== run 状态 ===', j.status, 'revision', j.revision);
  for (const n of j.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);
  log('=== spendAuthorizations ===');
  for (const s of j.spendAuthorizations ?? []) log('  ' + JSON.stringify({ id: s.id, nodeId: s.nodeId, max: s.maximumCostCny ?? s.maxCostCny, status: s.status }));
  writeFileSync(`${ASSETS}/checks/step-r8-run-after-authorize.json`, detail);

  const pageErrors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  for (const m of pageErrors.slice(-8)) log('  pageerror ' + m.text.slice(0, 200));

  writeFileSync(`${ASSETS}/checks/step-r8-authorize.txt`, lines.join('\n'));
});
