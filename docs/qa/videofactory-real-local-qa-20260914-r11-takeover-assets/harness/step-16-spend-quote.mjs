// 步骤 16：只读读取返工 run 的报价与购买授权评估（不授权、不拒绝、不购买）。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-e204cd6c-2365-4cda-bb1d-c50e6e69bb8a';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);
  console.log('=== screenshot ===', await shot(page, '16a-spend-quote'));

  const detail = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}`);
  writeFileSync(`${ASSETS}/checks/step-16-run-detail.json`, detail.body);
  const j = JSON.parse(detail.body);
  console.log('=== run ===', j.id, 'status', j.status, 'revision', j.revision);
  console.log('spendAuthorizations:', JSON.stringify(j.spendAuthorizations ?? []).slice(0, 900));

  for (const n of j.nodeRuns ?? []) {
    if (!['assets', 'asset-source-review'].includes(n.nodeId)) continue;
    console.log(`--- node ${n.nodeId} status=${n.status}`);
    console.log('   spendPlan:', JSON.stringify(n.spendPlan ?? null).slice(0, 1200));
    console.log('   spendAssessment:', JSON.stringify(n.spendAssessment ?? null).slice(0, 900));
    console.log('   spendAuthorizationId:', n.spendAuthorizationId ?? null);
    console.log('   costReceipt:', JSON.stringify(n.costReceipt ?? n.executionReceipt ?? null).slice(0, 600));
  }

  const costs = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.text();
  }, `/api/runs/${RUN_ID}/costs`);
  const c = JSON.parse(costs);
  const scalars = {};
  for (const [k, v] of Object.entries(c)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) scalars[k] = v;
  console.log('=== costs scalars ===', JSON.stringify(scalars));
  for (const line of (c.lines ?? []).filter((l) => l.billing === 'metered' || l.actualPending === true)) {
    console.log('  metered:', JSON.stringify({ id: line.id, node: line.nodeId, provider: line.providerId, status: line.status, est: line.estimatedCostCny, pending: line.actualPending }));
  }

  const visible = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 1800));
  console.log('=== visible text ===');
  console.log(visible);
});
