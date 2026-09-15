// R11 续轮 步骤 12c：只读核算本 run 的付费敞口（不打开浏览器、不调模型、不改 run）。
//
// 存在理由：GET /api/runs/:id 的响应**不含** executionReceipts / spendAuthorizations，
// 用响应体统计计费会恒得 ¥0.00——那是"字段不存在"，不是"没有花钱"。
// step-r12-reinspect.mjs 早期版本据此误报过"补查增量 ¥0.00"，该读数无效。
// 因此计费一律从 run 目录下的 run.json 磁盘文件核算，并同时记录笔数与最后一笔付费时刻，
// 以便事后证明"某动作之后没有新增敞口"。
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

const run = JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
const receipts = run.executionReceipts ?? [];
const metered = receipts.filter((x) => x.billing === 'metered');
const total = metered.reduce((s, x) => s + (typeof x.actualCostCny === 'number' ? x.actualCostCny : 0), 0);
const auths = run.spendAuthorizations ?? [];

log(`run ${RUN_ID}`);
log(`status=${run.status} revision=${run.revision}`);
log(`run.json mtime=${statSync(path.join(RUN_DIR, 'run.json')).mtime.toISOString()}`);
log('');
log(`=== metered 收据（${metered.length} 笔，合计 ¥${total.toFixed(2)}）===`);
for (const x of metered) {
  log(`  ${x.nodeId} ¥${x.actualCostCny}  授权=${x.spendAuthorizationId}`);
  log(`    上限 ¥${x.authorizedCostCny}  模型=${(x.actualModelIds ?? []).join('+')}  status=${x.status}`);
  log(`    起 ${x.startedAt}  止 ${x.finishedAt}`);
}
log('');
log(`=== 非 metered 收据（${receipts.length - metered.length} 笔，均为 ¥0）===`);
const byBilling = {};
for (const x of receipts.filter((x) => x.billing !== 'metered')) {
  byBilling[x.billing] = (byBilling[x.billing] ?? 0) + 1;
}
for (const [k, v] of Object.entries(byBilling)) log(`  ${k}: ${v} 笔`);
log('');
log(`=== 花钱授权（${auths.length} 笔）===`);
for (const a of auths) {
  log(`  ${a.id}`);
  log(`    上限 ¥${a.maxCostCny}  approvedAt=${a.approvedAt}`);
  log(`    itemCreateBudgets=${JSON.stringify(a.itemCreateBudgets)}`);
}
log(`consumedSpendAuthorizationIds=${JSON.stringify(run.consumedSpendAuthorizationIds ?? [])}`);
log('');
const lastPaid = metered.map((x) => x.finishedAt).filter(Boolean).sort().pop() ?? '(无)';
log(`最后一笔付费结束于 ${lastPaid}`);
log(`本 run 付费敞口合计 ¥${total.toFixed(2)}`);

writeFileSync(`${ASSETS}/checks/step-r12c-budget-audit.txt`, lines.join('\n'));
writeFileSync(`${ASSETS}/checks/step-r12-budget-after.json`, JSON.stringify(run, null, 2));
