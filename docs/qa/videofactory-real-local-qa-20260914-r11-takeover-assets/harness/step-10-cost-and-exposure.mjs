// 步骤 10：只读核对账本投影与授权暴露（购买前复核用；不写入、不确认、不释放任何授权）。
// 行字段取自实际响应：{id, runId, runTitle, nodeId, role, capability, providerId, modelId,
// billing, status, estimatedCostCny, actualPending, startedAt, finishedAt}。
import { withSession, BASE } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_500);
  const pull = async (url) => await page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: response.status, body: await response.text() };
  }, url);

  const runCosts = await pull(`/api/runs/${RUN_ID}/costs`);
  console.log('=== run costs status', runCosts.status, '===');
  const parsed = JSON.parse(runCosts.body);
  const scalars = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) scalars[key] = value;
  }
  console.log('runScalars:', JSON.stringify(scalars));

  const lines = parsed.lines ?? [];
  const billingCount = {};
  for (const line of lines) billingCount[line.billing] = (billingCount[line.billing] ?? 0) + 1;
  console.log('lineCount:', lines.length, 'byBilling:', JSON.stringify(billingCount));

  const exposure = lines.filter((line) => line.billing === 'metered' || line.actualPending === true);
  console.log('meteredOrPendingLines:', exposure.length);
  let pendingEstimated = 0;
  for (const line of exposure) {
    if (typeof line.estimatedCostCny === 'number' && line.actualPending === true) pendingEstimated += line.estimatedCostCny;
    console.log(JSON.stringify({
      id: line.id,
      nodeId: line.nodeId,
      provider: line.providerId,
      model: line.modelId,
      billing: line.billing,
      status: line.status,
      estimatedCostCny: line.estimatedCostCny,
      actualPending: line.actualPending,
      startedAt: line.startedAt,
      finishedAt: line.finishedAt,
    }));
  }
  console.log('pendingEstimatedCny(仅 actualPending 行求和):', pendingEstimated);

  const global = await pull('/api/costs');
  if (global.status === 200) {
    const totals = JSON.parse(global.body).totals ?? JSON.parse(global.body);
    console.log('=== /api/costs totals ===', JSON.stringify(totals));
  } else {
    console.log('=== /api/costs status', global.status, '===');
  }
});
