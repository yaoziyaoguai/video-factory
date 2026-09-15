// R11 续轮 步骤 10：操作员在 run 被 rejected 后，复用已物化试片重新检查 assets 节点。
// 依据：RunWorkbench 在 sourceAssetFailure 且 run.status==="rejected" 时提供「重新检查已有试片」按钮。
// 本步骤只点这一个按钮：不重新报价、不新增授权、不重买已生成素材。
// 通过标准：assets 节点不再因 not_observed 咨询项被打回，且本轮新增付费镜头数不超过授权范围。
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
// 计费只能从磁盘 run.json 核算：GET /api/runs/:id 的响应**不含** executionReceipts，
// 早期版本据响应体统计得到"0 笔 / ¥0.00"并落进 checks/step-r10-retry-assets.txt，
// 那是字段缺失、不是没有花钱。该错误读数已在该 txt 中标注更正。
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

async function runState(page) {
  return JSON.parse(await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.text();
  }, `/api/runs/${RUN_ID}`));
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_500);

  const before = await runState(page);
  log('=== 点击前 run 状态 ===', before.status, 'revision', before.revision);
  for (const n of before.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);
  writeFileSync(`${ASSETS}/checks/step-r10-run-before-retry.json`, JSON.stringify(before, null, 2));

  // 操作员看到的失败说明原文
  const body = await page.locator('body').innerText();
  const failureLine = body.split('\n').map((s) => s.trim())
    .find((s) => s.includes('试片') || s.includes('源素材视觉') || s.includes('预检'));
  log('=== 页面失败说明 ===', failureLine ?? '(未匹配到)');

  const retry = page.getByRole('button', { name: /重新检查已有试片|重试失败步骤/ });
  const count = await retry.count();
  log('=== 重试按钮数 ===', count);
  if (!count) {
    log('!! 未找到重试按钮，记录当前可见按钮后终止');
    log('按钮: ' + JSON.stringify((await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean)));
    await shot(page, 'r10-no-retry-button');
    writeFileSync(`${ASSETS}/checks/step-r10-retry-assets.txt`, lines.join('\n'));
    return;
  }
  const label = (await retry.first().innerText()).trim();
  log('=== 点击按钮 ===', JSON.stringify(label), 'disabled=', await retry.first().isDisabled());
  await shot(page, 'r10a-before-retry');
  await retry.first().click();
  await page.waitForTimeout(8_000);
  await shot(page, 'r10b-after-retry');

  const after = await runState(page);
  log('=== 点击后 run 状态 ===', after.status, 'revision', after.revision);
  for (const n of after.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status} ${n.error ? '错误: ' + String(n.error).slice(0, 300) : ''}`);
  writeFileSync(`${ASSETS}/checks/step-r10-run-after-retry.json`, JSON.stringify(after, null, 2));

  const onDisk = JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
  const meter = (onDisk.executionReceipts ?? []).filter((x) => x.billing === 'metered');
  log('=== metered 回执（磁盘 run.json 核算）===', meter.length, '笔，已结算合计 ¥'
    + meter.reduce((s, x) => s + (typeof x.actualCostCny === 'number' ? x.actualCostCny : 0), 0).toFixed(2)
    + `，授权 ${(onDisk.spendAuthorizations ?? []).length} 笔`);

  const err = await page.locator('[role="alert"], .run-failure-summary, .error').allInnerTexts().catch(() => []);
  for (const e of err) if (e.trim()) log('  !! 页面提示: ' + e.trim().slice(0, 400));

  const pageErrors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  for (const m of pageErrors.slice(-8)) log('  pageerror ' + m.text.slice(0, 300));

  writeFileSync(`${ASSETS}/checks/step-r10-retry-assets.txt`, lines.join('\n'));
});
