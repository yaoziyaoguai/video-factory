// R11 续轮：花钱关口前的只读复核。拉全工作区账本 + 每个 run 的未结清回执 + 本 run 的报价。
// 纯只读，不授权、不下单。
import { writeFileSync } from 'node:fs';
import { withSession, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';

await withSession(async ({ page }) => {
  const call = (url) => page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, url);

  const costs = await call('/api/costs');
  const runs = await call('/api/runs');
  const quotes = await call(`/api/runs/${RUN_ID}/production-quotes`).catch(() => ({ status: 0, body: null }));

  const lines = [];
  lines.push('=== /api/costs ===');
  lines.push(JSON.stringify(costs, null, 2));
  lines.push('=== runs ===');
  for (const run of runs.body?.runs ?? runs.body ?? []) {
    lines.push(JSON.stringify({ runId: run.runId, title: run.title, totals: run.totals }));
  }
  lines.push(`=== quotes for ${RUN_ID} ===`);
  lines.push(JSON.stringify(quotes, null, 2));

  const text = lines.join('\n');
  writeFileSync(`${ASSETS}/checks/step-r5-costs.json`, text);
  console.log(text);
});
