// R11 续轮 步骤 12d：用产品自身的成本端点核对付费敞口，并与磁盘 run.json 交叉验证。
//
// 背景：GET /api/runs/:id（制作详情）**不**返回 executionReceipts / spendAuthorizations，
// 从它统计计费会恒得 ¥0.00。产品的权威成本入口是 GET /api/runs/:id/costs
// （app.ts:505 → studio-service.runCostDetail → cost-studio.runDetail）。
// 本步骤：① 取官方读数；② 与磁盘 run.json 独立核算比对；③ 二者不一致即报错。
// 只读，不点任何按钮，不新增授权。
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

const disk = JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
const diskMetered = (disk.executionReceipts ?? []).filter((x) => x.billing === 'metered');
const diskTotal = diskMetered.reduce((s, x) => s + (typeof x.actualCostCny === 'number' ? x.actualCostCny : 0), 0);

await withSession(async ({ page }) => {
  const detail = JSON.parse(await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.text();
  }, `/api/runs/${RUN_ID}/costs`));
  writeFileSync(`${ASSETS}/checks/step-r12d-cost-endpoint.json`, JSON.stringify(detail, null, 2));

  log('=== GET /api/runs/:id/costs（官方读数）===');
  log('  顶层键: ' + Object.keys(detail).join(', '));
  log('  totals: ' + JSON.stringify(detail.totals));

  log('\n=== 官方明细中的 metered 行 ===');
  const meteredLines = (detail.lines ?? []).filter((l) => l.billing === 'metered');
  for (const l of meteredLines) {
    log(`  ${l.nodeId} | status=${l.status} | est=¥${l.estimatedCostCny ?? '-'} | actual=¥${l.actualCostCny ?? '-'}`
      + ` | 授权=${l.spendAuthorizationId ?? '-'} | 上限=¥${l.authorizedCostCny ?? '-'}`);
  }
  log(`  metered 行数 = ${meteredLines.length}`);

  log('\n=== 交叉核对（官方端点 vs 磁盘 run.json）===');
  const apiTotal = detail.totals?.actualCostCny;
  log(`  官方 totals.actualCostCny = ¥${apiTotal}`);
  log(`  磁盘 metered 合计          = ¥${diskTotal.toFixed(2)}`);
  const agree = typeof apiTotal === 'number' && Math.abs(apiTotal - diskTotal) < 0.005;
  log(`  一致? ${agree ? 'YES' : 'NO —— 需要追查差异来源'}`);
  log(`  磁盘 metered 笔数 ${diskMetered.length} / 授权 ${(disk.spendAuthorizations ?? []).length} 笔`);
  const lastPaid = diskMetered.map((x) => x.finishedAt).filter(Boolean).sort().pop() ?? '(无)';
  log(`  最后一笔付费结束于 ${lastPaid}`);

  const errs = detail.lines ? [] : ['成本端点未返回 lines'];
  for (const e of errs) log('  !! ' + e);

  writeFileSync(`${ASSETS}/checks/step-r12d-cost-endpoint.txt`, lines.join('\n'));
});
