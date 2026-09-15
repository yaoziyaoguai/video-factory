// R11 续轮 步骤 12：操作员在成片终审点击「补查现有成片（不重买素材）」。
// 设计依据：dispatchVisualReinspection 要求 run 处于 needs_human|rejected、证据编号与当前审片绑定、
// 且报告存在 not_observed + inspect_existing_media；它会开启新的审片轮次并 rerunFromNode("visual-review")。
// 本步骤只点这一个按钮：不替换镜头、不批准、不新增任何付费授权。
// 通过标准：补查开启新一轮而不是复用旧结论，且本轮 metered 花费增量为 0。
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
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

// 计费必须从磁盘 run.json 核算：GET /api/runs/:id 的响应**不含** executionReceipts /
// spendAuthorizations，用它统计会恒得 ¥0.00——那是"字段不存在"，不是"没有花钱"。
// 本脚本早期版本据此误报过"增量 ¥0.00"，该读数无效，已废弃。
const diskRun = () => JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));

const metered = (run) => (run.executionReceipts ?? [])
  .filter((x) => x.billing === 'metered')
  .reduce((s, x) => s + (typeof x.actualCostCny === 'number' ? x.actualCostCny : 0), 0);

// 付费证据不能只看合计：笔数、授权笔数、以及"最后一笔付费何时结束"共同证明
// 本动作之后没有新增任何敞口。
function budgetLine(run) {
  const m = (run.executionReceipts ?? []).filter((x) => x.billing === 'metered');
  const last = m.map((x) => x.finishedAt).filter(Boolean).sort().pop() ?? '(无)';
  return `metered 合计 ¥${metered(run).toFixed(2)}｜metered 笔数 ${m.length}`
    + `｜授权 ${(run.spendAuthorizations ?? []).length} 笔｜最后一笔付费结束于 ${last}`;
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);

  const before = await runState(page);
  const budgetBefore = diskRun();
  log('=== 点击前 ===');
  log('  run=' + before.status + ' revision=' + before.revision);
  for (const n of before.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);
  log('  ' + budgetLine(budgetBefore));
  writeFileSync(`${ASSETS}/checks/step-r12-run-before.json`, JSON.stringify(before, null, 2));
  writeFileSync(`${ASSETS}/checks/step-r12-budget-before.json`, JSON.stringify(budgetBefore, null, 2));

  const btn = page.getByRole('button', { name: /补查现有成片/ });
  const count = await btn.count();
  log('\n=== 补查按钮数 === ' + count);
  if (!count) {
    log('!! 未找到补查按钮，记录当前可见按钮后终止');
    log('按钮: ' + JSON.stringify((await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean)));
    await shot(page, 'r12-no-reinspect-button');
    writeFileSync(`${ASSETS}/checks/step-r12-reinspect.txt`, lines.join('\n'));
    return;
  }
  log('  disabled=' + await btn.first().isDisabled());
  await shot(page, 'r12a-before-reinspect');
  await btn.first().click();
  log('  已点击「补查现有成片（不重买素材）」');

  // 立即观察宿主响应（revision 变化 / 节点重新进入 running / 报错）
  await page.waitForTimeout(12_000);
  await shot(page, 'r12b-after-reinspect');
  const after = await runState(page);
  const budgetAfter = diskRun();
  log('\n=== 点击后 ===');
  log('  run=' + after.status + ' revision=' + after.revision);
  for (const n of after.nodeRuns ?? []) {
    log(`  node ${n.nodeId} = ${n.status}${n.error ? ' 错误: ' + String(n.error).slice(0, 300) : ''}`);
  }
  log('  ' + budgetLine(budgetAfter));
  log('  付费敞口增量 ¥' + (metered(budgetAfter) - metered(budgetBefore)).toFixed(2)
    + `（metered 笔数 ${(budgetBefore.executionReceipts ?? []).filter((x) => x.billing === 'metered').length}`
    + ` → ${(budgetAfter.executionReceipts ?? []).filter((x) => x.billing === 'metered').length}`
    + `，授权 ${(budgetBefore.spendAuthorizations ?? []).length} → ${(budgetAfter.spendAuthorizations ?? []).length} 笔）`);
  writeFileSync(`${ASSETS}/checks/step-r12-run-after.json`, JSON.stringify(after, null, 2));
  writeFileSync(`${ASSETS}/checks/step-r12-budget-after.json`, JSON.stringify(budgetAfter, null, 2));

  const alerts = await page.locator('[role="alert"], .error, .run-failure-summary').allInnerTexts().catch(() => []);
  for (const a of alerts) if (a.trim()) log('  !! 页面提示: ' + a.trim().slice(0, 400));

  const pageErrors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  for (const m of pageErrors.slice(-8)) log('  pageerror ' + m.text.slice(0, 250));

  writeFileSync(`${ASSETS}/checks/step-r12-reinspect.txt`, lines.join('\n'));
});
