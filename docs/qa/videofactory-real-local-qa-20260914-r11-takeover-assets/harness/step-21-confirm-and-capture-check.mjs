// 步骤 21：对返工 run 的导演闸门做**一次**受控确认，并把独立 check 的完整结论落盘。
// 只确认方案，不授权任何支出、不购买素材、不新建 run。
// 用法：node step-21-confirm-and-capture-check.mjs [runId]
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-b0468e64-2815-46e6-b837-7cf1bfafa389';

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);

  const read = () => page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}/creative-review`);

  const before = await read();
  writeFileSync(`${ASSETS}/checks/step-21-creative-review-before.json`, before.body);
  const beforeJson = before.status === 200 ? JSON.parse(before.body) : {};
  console.log('=== before: phase', beforeJson.phase, 'reviewRevision', beforeJson.reviewRevision,
    'checkIdentity', beforeJson.checkResult?.checkIdentity?.slice(0, 16), 'verdict', beforeJson.checkResult?.verdict);
  if (beforeJson.phase !== 'waiting_user') {
    console.log('=== 不在 waiting_user，跳过确认 ===');
    await shot(page, '21a-not-waiting');
    return;
  }

  await shot(page, '21a-before-confirm');
  const btn = page.getByRole('button', { name: /确认当前方案/ });
  await btn.waitFor({ state: 'visible', timeout: 20_000 });
  console.log('=== 按钮文案 ===', (await btn.innerText()).trim());
  await btn.click();
  console.log('=== 已点击确认（本步骤只点这一次）===');

  // 等待这一轮独立 check 出结论：要么闸门以新 reviewRevision 重新开闸（repair），
  // 要么离开 waiting_user 进入素材阶段（pass 并确认成功）。
  await page.waitForFunction(async (t, prev) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) return true;
    const j = await r.json().catch(() => ({}));
    if (j.phase === 'checking') return false;
    if (j.phase === 'waiting_user') return j.reviewRevision > prev;
    return true;
  }, `/api/runs/${RUN_ID}/creative-review`, beforeJson.reviewRevision, { timeout: 900_000 })
    .catch((e) => console.log('=== 等待超时（按设计继续观察）:', String(e).slice(0, 160)));

  await page.waitForTimeout(4_000);
  console.log('=== screenshot ===', await shot(page, '21b-after-confirm'));

  const after = await read();
  writeFileSync(`${ASSETS}/checks/step-21-creative-review-after.json`, after.body);
  if (after.status === 200) {
    const j = JSON.parse(after.body);
    console.log('=== after: phase', j.phase, 'reviewRevision', j.reviewRevision,
      'draftSha256', String(j.draftSha256).slice(0, 16), 'allowedActions', JSON.stringify(j.allowedActions));
    if (j.checkResult) {
      console.log('=== after checkResult verdict', j.checkResult.verdict,
        'score', j.checkResult.score);
      console.log('=== summary ===', j.checkResult.summary);
      for (const [i, issue] of (j.checkResult.issues ?? []).entries()) {
        console.log(`  issue[${i}] ${issue.severity} | ${issue.criterion}`);
        console.log(`    evidence: ${issue.evidence}`);
        console.log(`    repair  : ${issue.repairInstruction}`);
      }
    } else {
      console.log('=== after checkResult === (none)');
    }
  } else {
    console.log('=== after creative-review HTTP', after.status, '（导演阶段已结束，接口不再返回）===');
  }

  const run = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}`);
  writeFileSync(`${ASSETS}/checks/step-21-after-confirm-run.json`, run.body);
  const rj = JSON.parse(run.body);
  console.log('=== run', rj.id, 'status', rj.status, 'revision', rj.revision);
  for (const n of rj.nodeRuns ?? []) console.log('  node', n.nodeId, n.status, String(n.error ?? '').slice(0, 160));
  console.log('=== spendAuthorizations ===', JSON.stringify(rj.spendAuthorizations ?? []).slice(0, 600));

  const errs = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errs.length);
  for (const e of errs.slice(0, 5)) console.log('   !', String(e.text).slice(0, 200));
});
