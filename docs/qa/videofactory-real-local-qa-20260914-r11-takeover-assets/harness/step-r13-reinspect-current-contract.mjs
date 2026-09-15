// R11 收尾轮 步骤 13：操作员在成片终审点击「补查现有成片（不重买素材）」，
// 并且**这次 broker 跑的是当前审片合同**（旧进程加载的是加 claimType 之前的 dist，
// 所以 02:01 那次补查产出的仍是旧合同证据——见 step-r12 的 findings 无 claimType）。
//
// 本步骤只做一件事：点补查，然后等审片重跑完。不替换镜头、不批准、不新增任何付费授权。
// 通过标准（四条同时成立才算通过）：
//   1. visual-review 新增一次 attempt（补查真的重跑了，而不是复用旧结论）
//   2. 新报告的 actualModels 合同摘要 == 当前要求 ef6bb583…（证据来自当前合同）
//   3. 新报告的 findings 带 claimType（新合同才有的字段）
//   4. metered 花费、收据笔数、授权笔数、素材文件 sha256 全部不变（没重买画面）
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);
const REQUIRED_VISUAL_CONTRACT = 'ef6bb583f730bab5e071b56238c4ff01a87155bcc6d7b6330ec5db8044a8ff46';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const diskRun = () => JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));

// 素材指纹：补查只该重跑审片。任何画面/配音/成片字节变化都意味着做了本动作不该做的事。
function mediaFingerprint() {
  const out = {};
  for (const node of ['assets', 'voice', 'render']) {
    const dir = path.join(RUN_DIR, 'nodes', node);
    if (!existsSync(dir)) continue;
    const found = execFileSync('/usr/bin/find', [dir, '-type', 'f',
      '-not', '-path', '*/.review-media/*', '-not', '-path', '*/.generation-operations/*'])
      .toString().trim().split('\n').filter(Boolean);
    for (const file of found.sort()) {
      if (/\.(mp4|mov|wav|mp3|m4a|png|jpe?g|json)$/i.test(file) === false) continue;
      out[path.relative(RUN_DIR, file)]
        = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
    }
  }
  return out;
}

const meteredRows = (run) => (run.executionReceipts ?? []).filter((x) => x.billing === 'metered');
const metered = (run) => meteredRows(run)
  .reduce((s, x) => s + (typeof x.actualCostCny === 'number' ? x.actualCostCny : 0), 0);
const budgetLine = (run) => `metered ¥${metered(run).toFixed(2)}｜收据 ${meteredRows(run).length} 笔`
  + `｜授权 ${(run.spendAuthorizations ?? []).length} 笔`;

const reviewReport = (run, attempt) => {
  const p = path.join(RUN_DIR, 'nodes/visual-review', attempt, 'visual_review.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const attempts = () => execFileSync('/bin/ls', [path.join(RUN_DIR, 'nodes/visual-review')])
  .toString().trim().split('\n').filter((x) => x.startsWith('attempt-')).sort();

async function runState(page) {
  return JSON.parse(await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.text();
  }, `/api/runs/${RUN_ID}`));
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);

  const before = await runState(page);
  const diskBefore = diskRun();
  const mediaBefore = mediaFingerprint();
  const attemptsBefore = attempts();
  log('=== 补查前 ===');
  log(`  run=${before.status} revision=${before.revision}`);
  log(`  历史审片 attempt: ${attemptsBefore.join(', ')}`);
  log(`  ${budgetLine(diskBefore)}`);
  log(`  素材指纹条目 ${Object.keys(mediaBefore).length} 个`);
  writeFileSync(`${ASSETS}/checks/step-r13-before.json`,
    JSON.stringify({ run: before, budget: diskBefore, media: mediaBefore }, null, 2));

  const btn = page.getByRole('button', { name: /补查现有成片/ });
  if (!(await btn.count())) {
    log('!! 未找到补查按钮；当前可见按钮: '
      + JSON.stringify((await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean)));
    await shot(page, 'r13-no-reinspect-button');
    writeFileSync(`${ASSETS}/checks/step-r13-reinspect.txt`, lines.join('\n'));
    return;
  }
  await shot(page, 'r13a-before-reinspect');
  await btn.first().click();
  log('\n  已点击「补查现有成片（不重买素材）」，等待审片重跑…');

  // 审片要跑两个模型分支，上次实测约 10 分钟；这里等到状态离开 running 为止。
  let state = null;
  let settled = false;
  for (let i = 0; i < 120; i += 1) {
    await page.waitForTimeout(15_000);
    state = await runState(page);
    if (i % 4 === 0) log(`    [${(i + 1) * 15}s] run=${state.status} revision=${state.revision}`);
    if (state.status !== 'running') { settled = true; break; }
  }
  await shot(page, 'r13b-after-reinspect');
  const after = state ?? await runState(page);
  const diskAfter = diskRun();
  const mediaAfter = mediaFingerprint();
  const attemptsAfter = attempts();

  log('\n=== 补查后 ===');
  log(`  run=${after.status} revision=${after.revision}（等到终态: ${settled}）`);
  log(`  历史审片 attempt: ${attemptsAfter.join(', ')}`);
  log(`  ${budgetLine(diskAfter)}`);

  const newAttempt = attemptsAfter.filter((a) => !attemptsBefore.includes(a));
  const latest = attemptsAfter[attemptsAfter.length - 1];
  const report = reviewReport(diskAfter, latest);

  log('\n=== 判定 ===');
  log(`  1. 新增审片 attempt: ${newAttempt.length ? newAttempt.join(',') + ' → 通过' : '无 → 未通过'}`);

  const models = report?.reviewScope?.actualModels ?? [];
  const digests = models.map((m) => `${m.providerId}/${m.modelId}=${String(m.producerContractDigest).slice(0, 12)}`);
  const contractOk = models.length > 0
    && models.every((m) => m.producerContractDigest === REQUIRED_VISUAL_CONTRACT);
  log(`  2. 报告合同摘要: ${digests.join('  ') || '(无)'} → ${contractOk ? '当前合同，通过' : '不是当前合同，未通过'}`);

  const findings = report?.findings ?? [];
  const withClaim = findings.filter((f) => typeof f.claimType === 'string' && f.claimType);
  log(`  3. findings 带 claimType: ${withClaim.length}/${findings.length}`
    + ` → ${findings.length > 0 && withClaim.length === findings.length ? '通过' : '未通过'}`);

  const changed = Object.keys(mediaBefore).filter((k) => mediaAfter[k] !== mediaBefore[k]);
  const addedOrRemoved = [
    ...Object.keys(mediaAfter).filter((k) => !(k in mediaBefore)),
    ...Object.keys(mediaBefore).filter((k) => !(k in mediaAfter)),
  ];
  const budgetSame = metered(diskAfter) === metered(diskBefore)
    && meteredRows(diskAfter).length === meteredRows(diskBefore).length
    && (diskAfter.spendAuthorizations ?? []).length === (diskBefore.spendAuthorizations ?? []).length;
  log(`  4. 花费/素材未变: metered ${budgetSame ? '未变，通过' : '变了，未通过'}`
    + `｜素材改动 ${changed.length} 个｜增删 ${addedOrRemoved.length} 个`
    + ` → ${budgetSame && changed.length === 0 && addedOrRemoved.length === 0 ? '通过' : '未通过'}`);
  if (changed.length) for (const k of changed) log(`      改动: ${k}`);
  if (addedOrRemoved.length) for (const k of addedOrRemoved) log(`      增删: ${k}`);

  if (findings.length) {
    log('\n=== 本轮 findings ===');
    for (const f of findings) {
      log(`  ${f.scenePosition}:${f.targetNodeId} claim=${f.claimType ?? '(缺)'}`
        + ` evidence=${f.evidenceStatus ?? '-'} next=${f.nextAction ?? '-'} sev=${f.severity ?? '-'}`
        + ` | ${String(f.description ?? '').slice(0, 60)}`);
    }
  }

  const alerts = await page.locator('[role="alert"], .error, .run-failure-summary').allInnerTexts().catch(() => []);
  for (const a of alerts) if (a.trim()) log('  !! 页面提示: ' + a.trim().slice(0, 400));
  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-8)) {
    log('  pageerror ' + m.text.slice(0, 250));
  }

  writeFileSync(`${ASSETS}/checks/step-r13-after.json`,
    JSON.stringify({ run: after, budget: diskAfter, media: mediaAfter }, null, 2));
  writeFileSync(`${ASSETS}/checks/step-r13-reinspect.txt`, lines.join('\n'));
});
