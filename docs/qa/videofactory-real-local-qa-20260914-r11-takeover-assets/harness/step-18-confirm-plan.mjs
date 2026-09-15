// 步骤 18：在创作确认闸门点击"确认当前方案，继续"，让返工 run 进入素材节点。
// 只确认方案，不购买、不授权；购买授权在报价读取后再决定。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-e204cd6c-2365-4cda-bb1d-c50e6e69bb8a';

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);

  const before = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.json();
  }, `/api/runs/${RUN_ID}/creative-review`);
  console.log('=== before: phase', before.phase, 'reviewRevision', before.reviewRevision);
  if (before.phase !== 'waiting_user') {
    console.log('=== 不在 waiting_user，跳过确认 ===');
    await shot(page, '18a-not-waiting');
    return;
  }

  await shot(page, '18a-before-confirm');
  const btn = page.getByRole('button', { name: /确认当前方案/ });
  await btn.waitFor({ state: 'visible', timeout: 20_000 });
  console.log('=== 按钮文案 ===', (await btn.innerText()).trim());
  await btn.click();
  console.log('=== 已点击确认，等待进入后续阶段 ===');

  // 等待创作确认离开 waiting_user（进入素材等后续节点）
  await page.waitForFunction(async (t, prev) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) return true; // 阶段结束后该接口可能返回 404/空
    const j = await r.json().catch(() => ({}));
    return j.phase !== 'waiting_user' && j.phase !== 'checking' && j.reviewRevision > prev;
  }, `/api/runs/${RUN_ID}/creative-review`, before.reviewRevision, { timeout: 900_000 }).catch((e) => console.log('=== 等待超时（按设计继续观察）:', String(e).slice(0, 160)));

  await page.waitForTimeout(4_000);
  console.log('=== screenshot ===', await shot(page, '18b-after-confirm'));

  const run = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}`);
  writeFileSync(`${ASSETS}/checks/step-18-after-confirm-run.json`, run.body);
  const rj = JSON.parse(run.body);
  console.log('=== run', rj.id, 'status', rj.status, 'revision', rj.revision);
  for (const n of rj.nodeRuns ?? []) console.log('  node', n.nodeId, n.status, String(n.error ?? '').slice(0, 140));
  console.log('=== spendAuthorizations ===', JSON.stringify(rj.spendAuthorizations ?? []).slice(0, 600));

  const errs = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errs.length);
  for (const e of errs.slice(0, 5)) console.log('   !', String(e.text).slice(0, 200));
});
