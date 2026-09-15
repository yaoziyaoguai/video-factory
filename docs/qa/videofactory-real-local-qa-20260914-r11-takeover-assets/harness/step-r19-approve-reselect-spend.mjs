// R11 收尾轮 步骤 19：走完「换一版这一镜素材」之后的费用确认，并核验它到底花了多少钱。
//
// 为什么这一步必须存在：assets 节点的花费授权是一次性信封，上一次已经被 consumed，
// 所以节点第二次执行必然停在 awaiting_spend_approval（workflow-runner.ts:1377-1382）。
// 报价 ¥17.00 是本方案四个付费镜的上限，不是本次要花的钱：
//   四个付费镜的 inputFingerprint 只由 {scenePosition, request} 决定，
//   历史两次台账里完全相同（bdaac257dd/8a04bd5ab0/18b4aff91d/122056ea49）且都已 materialized，
//   因此重跑走 carry-forward 复用，不会向 provider 发起 create；镜头 4 是 Pexels 免费下载。
// 本步骤的判据就是这条：**授权 ¥17 的信封之后，metered 实际支出增量必须是 ¥0**。
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const diskRun = () => JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
const metered = (run) => (run.executionReceipts ?? []).filter((x) => x.billing === 'metered');
const cost = (run) => metered(run).reduce((s, x) => s + (x.actualCostCny ?? 0), 0);

function sceneFiles(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { sceneFiles(full, out); continue; }
    if (!/^scene_\d+_/.test(name)) continue;
    out[name] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return out;
}
function latestAssetsAttempt() {
  const dirs = readdirSync(path.join(RUN_DIR, 'nodes/assets'))
    .filter((d) => d.startsWith('attempt-'))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  return dirs[dirs.length - 1];
}
function latestAttempt(node) {
  const dirs = readdirSync(path.join(RUN_DIR, 'nodes', node))
    .filter((d) => d.startsWith('attempt-'))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  return dirs[dirs.length - 1];
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6_000);

  const before = diskRun();
  const attemptBefore = latestAssetsAttempt();
  const filesBefore = sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptBefore));
  const reviewBefore = latestAttempt('visual-review');
  log('=== 授权前 ===');
  log(`  run=${before.status} revision=${before.revision}`);
  log(`  metered ¥${cost(before).toFixed(2)}｜收据 ${metered(before).length} 笔`
    + `｜已消耗授权 ${(before.consumedSpendAuthorizationIds ?? []).length} 份`);
  log(`  素材 attempt=${attemptBefore}｜审片 attempt=${reviewBefore}`);

  const action = page.locator('section.current-production-action');
  await action.scrollIntoViewIfNeeded();
  log(`\n  当前需要处理: ${(await action.locator('h2').first().innerText()).trim()}`);
  await shot(page, 'r19a-spend-surface');

  const gate = action.locator('section.spend-gate');
  const offered = await gate.innerText();
  log(`  费用确认原文: ${offered.replace(/\s+/g, ' ').slice(0, 400)}`);

  // 两阶段：先取不可变报价，看到金额后第二次点击才授权同一份报价。
  const getQuote = gate.getByRole('button', { name: /获取费用报价/ });
  if (await getQuote.count() > 0 && !(await getQuote.isDisabled())) {
    await getQuote.click();
    log('  已点击「获取费用报价」');
    await page.waitForTimeout(6_000);
    const quotePanel = gate.locator('dl[aria-label="服务端费用报价"]');
    await quotePanel.waitFor({ timeout: 30_000 });
    log('  服务端报价: ' + (await quotePanel.innerText()).replace(/\s+/g, ' ').slice(0, 300));
    await shot(page, 'r19b-quote');
  }

  const confirm = gate.getByRole('button', { name: /确认并授权|同意追加/ });
  const confirmCount = await confirm.count();
  log(`  授权按钮数=${confirmCount}`);
  if (confirmCount === 0) {
    log('  没有可点的授权按钮，停止。');
    writeFileSync(`${ASSETS}/checks/step-r19-approve-spend.txt`, lines.join('\n'));
    return;
  }
  log(`  将点击: ${(await confirm.first().innerText()).trim()}`);
  await confirm.first().click();
  log('  已提交授权');
  await page.waitForTimeout(8_000);
  await shot(page, 'r19c-authorized');

  let state = null;
  for (let i = 0; i < 240; i += 1) {
    await page.waitForTimeout(15_000);
    const r = diskRun();
    if (i % 4 === 0) log(`    [${(i + 1) * 15}s] run=${r.status} revision=${r.revision}`);
    if (r.status !== 'running') { state = r; break; }
  }
  await shot(page, 'r19d-after-pipeline');

  const after = state ?? diskRun();
  const attemptAfter = latestAssetsAttempt();
  const filesAfter = attemptAfter === attemptBefore
    ? filesBefore
    : sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptAfter));

  log('\n=== 授权后 ===');
  log(`  run=${after.status} revision=${after.revision}`);
  log(`  metered ¥${cost(after).toFixed(2)}｜收据 ${metered(after).length} 笔`);
  log(`  ★ 实际付费增量 ¥${(cost(after) - cost(before)).toFixed(2)}（判据：必须为 0.00）`);
  log(`  授权总数 ${(after.spendAuthorizations ?? []).length} 笔`
    + `｜已消耗 ${(after.consumedSpendAuthorizationIds ?? []).length} 份`);
  for (const a of after.spendAuthorizations ?? []) {
    log(`    ${a.id} node=${a.nodeId} 最高 ¥${((a.approvedAmountCents ?? 0) / 100).toFixed(2)} by ${a.approvedBy}`);
  }

  log(`\n  素材 attempt=${attemptAfter}`);
  for (let scene = 1; scene <= 7; scene += 1) {
    const pick = (files) => Object.entries(files).filter(([n]) => n.startsWith(`scene_0${scene}_`)).map(([n]) => n).sort().join(',');
    const b = pick(filesBefore);
    const a = pick(filesAfter);
    log(`  场景 ${scene}: ${b === a ? '未变' : '换新'}  ${b || '-'} -> ${a || '-'}`);
  }

  const reviewAfter = latestAttempt('visual-review');
  log(`\n  审片 attempt: ${reviewBefore} -> ${reviewAfter}`);
  if (reviewAfter !== reviewBefore) {
    const review = JSON.parse(readFileSync(
      path.join(RUN_DIR, 'nodes/visual-review', reviewAfter, 'visual_review.json'), 'utf8'));
    log(`  综合=${review.recommendation} 分数=${JSON.stringify(review.scores)}`);
    for (const f of review.findings ?? []) {
      if ((f.scenePosition ?? 0) !== 4) continue;
      log(`    镜头4 ${f.severity} target=${f.targetNodeId} next=${f.nextAction}: ${String(f.description).slice(0, 110)}`);
    }
  }

  for (const n of after.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);
  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-8)) {
    log('  pageerror ' + m.text.slice(0, 250));
  }
  writeFileSync(`${ASSETS}/checks/step-r19-approve-spend.txt`, lines.join('\n'));
});
