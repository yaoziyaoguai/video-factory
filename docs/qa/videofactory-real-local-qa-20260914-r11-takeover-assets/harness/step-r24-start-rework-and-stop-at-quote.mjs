// R11 收尾轮 步骤 24：提交一次受控返工，然后**停在报价前**，不授权任何支出。
//
// 为什么必须停：用户授权的是"合理且预算内的报价由你自行确认"，而确认的前提是先看到报价。
// 提交本身不产生现金支出；新一轮会先重规划、再逐项报价，购买前仍需人工确认。
//
// 这一步要回答的问题（也是授权的门槛）：
//   1) 新 run 是否真的继承脚本/导演规则、是否只重做受影响镜头；
//   2) 报价里是否出现已通过的镜头 3/4/5 —— 出现即"重买已成功素材"，必须停下问用户；
//   3) 报价对现成成果是否 carry-forward（已批准 ¥17 不应被重复计费）。
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUNS_DIR = process.env.QA_RUNS_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs');
const PASSED_SCENES = [3, 4, 5];                                  // 已通过试片的镜头，不允许被重买
const PASSED_FILES = ['scene_03_', 'scene_04_', 'scene_05_'];      // 对应素材文件前缀

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

/** 工作区口径的累计付费：报价是否"增量"要看这里，而不是看单条 run。 */
function workspaceMetered() {
  let total = 0;
  const perRun = {};
  for (const dir of readdirSync(RUNS_DIR)) {
    const file = path.join(RUNS_DIR, dir, 'run.json');
    if (!existsSync(file)) continue;
    const run = JSON.parse(readFileSync(file, 'utf8'));
    const metered = (run.executionReceipts ?? []).filter((r) => r.billing === 'metered');
    const cost = metered.reduce((sum, r) => sum + (r.actualCostCny ?? 0), 0);
    if (cost > 0) perRun[dir] = `¥${cost.toFixed(2)}`;
    total += cost;
  }
  return { total, perRun };
}

await withSession(async ({ page, consoleMessages }) => {
  let submitted = null;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') {
      try { submitted = request.postDataJSON(); } catch { submitted = null; }
    }
  });

  const before = workspaceMetered();
  log(`=== 提交前：工作区累计 metered ¥${before.total.toFixed(2)}（${JSON.stringify(before.perRun)}）===`);

  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);

  await page.getByRole('button', { name: '调整方案后重新制作' }).first().click();
  await page.waitForTimeout(3_000);

  const dialog = page.locator('[role="dialog"]');
  const start = dialog.getByRole('button', { name: '开始制作' });
  await start.waitFor({ state: 'visible', timeout: 30_000 });
  log(`=== 「开始制作」按钮 enabled=${await start.isEnabled()} ===`);
  await start.click();
  log('=== 已提交，等待新 run ===');

  await page.waitForURL((url) => /\/projects\/run-/.test(url.pathname) && !url.pathname.endsWith(RUN_ID), { timeout: 180_000 });
  await page.waitForTimeout(5_000);
  const newRunId = new URL(page.url()).pathname.split('/').pop();
  log(`=== 新 runId = ${newRunId} ===`);

  if (submitted) {
    writeFileSync(`${ASSETS}/checks/step-r24-submitted-payload.json`, JSON.stringify(submitted, null, 2));
    const rework = submitted.rework ?? {};
    log(`=== 提交载荷摘要 ===`);
    log(`  title=${submitted.title}`);
    log(`  sourceRunId=${rework.sourceRunId} sourceRunRevision=${rework.sourceRunRevision}`);
    log(`  affectedScenePositions=${JSON.stringify(rework.affectedScenePositions)}`);
    log(`  nodeInstructions.script=${JSON.stringify(rework.nodeInstructions?.script ?? null)}`);
  } else {
    log('=== 警告：未捕获到 POST /api/runs 请求体 ===');
  }

  // 等它走到报价闸门（或更后面的阶段）。返工要先重规划，给足时间。
  let state = null;
  for (let i = 0; i < 80; i += 1) {
    await page.waitForTimeout(15_000);
    state = await page.evaluate(async (id) => {
      const r = await fetch(`/api/runs/${encodeURIComponent(id)}`, { credentials: 'include', headers: { accept: 'application/json' } });
      const j = await r.json();
      return { status: j.status, revision: j.revision, nodes: (j.nodes ?? []).map((n) => `${n.id}=${n.status}`) };
    }, newRunId);
    if (i % 4 === 0) log(`    [${(i + 1) * 15}s] ${state.status} rev=${state.revision}`);
    if (state.status !== 'running') break;
  }
  await shot(page, 'r24-rework-at-quote');

  log(`\n=== 停在：status=${state?.status} revision=${state?.revision} ===`);
  log(`  nodes: ${(state?.nodes ?? []).join(' ')}`);

  const disk = existsSync(path.join(RUNS_DIR, newRunId, 'run.json'))
    ? JSON.parse(readFileSync(path.join(RUNS_DIR, newRunId, 'run.json'), 'utf8'))
    : null;
  const after = workspaceMetered();
  log(`\n=== 提交后：工作区累计 metered ¥${after.total.toFixed(2)}（${JSON.stringify(after.perRun)}）===`);
  log(`★ 规划阶段付费增量 ¥${(after.total - before.total).toFixed(2)}`);

  if (disk) {
    const auth = disk.spendAuthorizations ?? [];
    log(`\n  授权 ${auth.length} 笔｜已消耗 ${(disk.consumedSpendAuthorizationIds ?? []).length} 份`);
    for (const a of auth) {
      log(`   - plan=${a.spendPlanId} node=${a.nodeId} max=¥${a.maxCostCny} attempts=${a.maxAttempts}`);
    }
    // 报价逐镜明细：出现已通过镜头就是"重买已成功素材"。
    for (const plan of disk.executionPlan?.spendPlans ?? []) log(`  spendPlan: ${JSON.stringify(plan).slice(0, 600)}`);
  }

  const quoteText = await page.evaluate(() => document.body.innerText
    .split('\n').map((s) => s.trim())
    .filter((s) => /镜头\s*\d|预估|预计|最高|已批准|已发生|在途|上限/.test(s)).slice(0, 40));
  log(`\n=== 页面上的费用确认原文 ===`);
  for (const line of quoteText) log(`  ${line}`);

  // 只认"含金额的行"。方案确认页也会逐镜列出 1–7 并标注获取路线，但那是明细不是报价
  // （原文写的是"预计时长与获取路线将在当前方案确认后进入报价；画面尚未生成"）。
  // 早先版本单凭"镜头 N"匹配，把明细误报成"报价里出现已通过镜头"，已在
  // checks/step-r24-start-rework.txt 里就地更正（QA-R11R-13）。
  const quoteLines = quoteText.filter((line) => /¥/.test(line));
  const reBuys = quoteLines.filter((line) => PASSED_SCENES.some((n) => new RegExp(`镜头\\s*${n}\\b`).test(line)));
  log(`\n  含金额的行 ${quoteLines.length} 条（0 条 = 尚未进入报价，本判据不适用）`);
  log(`★ 报价中是否出现已通过镜头 ${JSON.stringify(PASSED_SCENES)}：${quoteLines.length === 0 ? '不适用（尚未进入报价）' : reBuys.length ? '出现（需停下问用户）' : '未出现'}`);
  for (const line of reBuys) log(`    ⚠ ${line}`);

  log(`\n=== 未授权任何支出；授权留给下一位操作员/用户决定 ===`);
  for (const m of consoleMessages.filter((x) => x.type === 'error' || x.type === 'pageerror').slice(-6)) {
    log('  pageerror ' + m.text.slice(0, 200));
  }
  log(`\n（素材前缀对照：${PASSED_FILES.join(', ')} 为已通过镜头，返工不应重买。）`);
  writeFileSync(`${ASSETS}/checks/step-r24-start-rework.txt`, lines.join('\n'));
});
