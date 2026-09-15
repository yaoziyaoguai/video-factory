// R11 收尾轮 步骤 25：确认返工方案，然后**停在报价闸门前**，不授权支出。
//
// 确认方案本身不花钱（步 24 实测规划阶段付费增量 ¥0.00）；钱发生在报价被授权之后。
// 所以这一步只做两件事：把方案确认掉，然后把报价原文一字不差地打出来供核对。
//
// 授权门槛（三条全过才授权，任一不过就停下问用户）：
//   1) 报价里不出现已通过试片的镜头 1–5（出现即"重买已成功素材"）；
//   2) 镜头 7 仍是复用（reuseFromScenePosition=1），不产生新生成费用；
//   3) 累计额度不超本轮 ¥50（当前已用 ¥17.00）。
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-6ad4e264-8385-45ae-84a0-52d5ef5cc925';
const RUNS_DIR = process.env.QA_RUNS_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs');
const PASSED_SCENES = [1, 2, 3, 4, 5];   // 源 run 里已通过/已生成、不应重买的镜头

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

function workspaceMetered() {
  let total = 0; const perRun = {};
  for (const dir of readdirSync(RUNS_DIR)) {
    const file = path.join(RUNS_DIR, dir, 'run.json');
    if (!existsSync(file)) continue;
    const run = JSON.parse(readFileSync(file, 'utf8'));
    const metered = (run.executionReceipts ?? []).filter((r) => r.billing === 'metered');
    const cost = metered.reduce((s, r) => s + (r.actualCostCny ?? 0), 0);
    if (cost > 0) perRun[dir] = `¥${cost.toFixed(2)}`;
    total += cost;
  }
  return { total, perRun };
}

await withSession(async ({ page }) => {
  const before = workspaceMetered();
  log(`=== 确认前：工作区累计 metered ¥${before.total.toFixed(2)} ===`);

  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);
  await shot(page, 'r25a-before-confirm');

  const confirm = page.getByRole('button', { name: /确认当前方案/ });
  if ((await confirm.count()) === 0) {
    log('✖ 没有「确认当前方案」按钮；当前状态可能已不是待确认。停止。');
    writeFileSync(`${ASSETS}/checks/step-r25-confirm-rework-plan.txt`, lines.join('\n'));
    return;
  }
  await confirm.first().click();
  log('=== 已确认方案，等待报价闸门 ===');

  let state = null;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(15_000);
    state = await page.evaluate(async (id) => {
      const r = await fetch(`/api/runs/${encodeURIComponent(id)}`, { credentials: 'include', headers: { accept: 'application/json' } });
      const j = await r.json();
      return { status: j.status, revision: j.revision };
    }, RUN_ID);
    if (i % 3 === 0) log(`    [${(i + 1) * 15}s] ${state.status} rev=${state.revision}`);
    if (!['running', 'needs_human'].includes(state.status)) break;
  }
  await shot(page, 'r25b-at-quote');

  log(`\n=== 停在：status=${state?.status} revision=${state?.revision} ===`);

  const after = workspaceMetered();
  log(`=== 确认后：工作区累计 metered ¥${after.total.toFixed(2)}（${JSON.stringify(after.perRun)}）===`);
  log(`★ 确认方案的付费增量 ¥${(after.total - before.total).toFixed(2)}（应为 0.00）`);

  const diskFile = path.join(RUNS_DIR, RUN_ID, 'run.json');
  if (existsSync(diskFile)) {
    const disk = JSON.parse(readFileSync(diskFile, 'utf8'));
    const auth = disk.spendAuthorizations ?? [];
    log(`\n  授权 ${auth.length} 笔｜已消耗 ${(disk.consumedSpendAuthorizationIds ?? []).length} 份`);
    for (const a of auth) log(`   - plan=${a.spendPlanId} node=${a.nodeId} max=¥${a.maxCostCny} attempts=${a.maxAttempts} model=${String(a.modelId).slice(0, 80)}`);
  }

  // 报价原文：只在报价闸门阶段才有内容，逐镜明细是授权门槛的直接依据。
  const quote = await page.evaluate(() => document.body.innerText
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((s) => /镜头\s*\d|预估|预计|最高|已批准|已发生|在途|上限|授权|¥/.test(s)).slice(0, 60));
  log(`\n=== 页面费用原文 ===`);
  for (const line of quote) log(`  ${line}`);

  const quoted = quote.filter((line) => /镜头\s*\d/.test(line) && /¥/.test(line));
  const reBuys = quoted.filter((line) => PASSED_SCENES.some((n) => new RegExp(`镜头\\s*${n}(?!\\d)`).test(line)));
  log(`\n★ 门槛 1 —— 报价中已通过镜头 ${JSON.stringify(PASSED_SCENES)}：${reBuys.length ? '出现，需停下问用户' : '未出现'}`);
  for (const line of reBuys) log(`    ⚠ ${line}`);
  log(`★ 门槛 3 —— 累计：¥${after.total.toFixed(2)} / ¥50`);
  log(`\n=== 未授权任何支出 ===`);

  writeFileSync(`${ASSETS}/checks/step-r25-confirm-rework-plan.txt`, lines.join('\n'));
});
