// 步骤 6：只读核对费用投影与账本事实（不写入、不确认、不释放任何授权）。
import { withSession, BASE } from './browser.mjs';

const RUN_ID = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);
  const data = await page.evaluate(async () => {
    const response = await fetch('/api/runs/' + 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446' + '/costs', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    return { status: response.status, body: await response.text() };
  });
  const parsed = JSON.parse(data.body);
  const summary = {
    status: data.status,
    keys: Object.keys(parsed),
    recordedYuan: parsed.recordedYuan ?? parsed.recorded,
    pendingConfirmation: parsed.pendingConfirmationCount ?? parsed.pending,
    lines: Array.isArray(parsed.items) ? parsed.items.length : parsed.lines?.length,
  };
  console.log('=== summary ===');
  console.log(JSON.stringify(summary, null, 1));
  const items = parsed.items ?? parsed.lines ?? [];
  for (const item of items) {
    console.log(JSON.stringify({
      label: item.label ?? item.title ?? item.kind,
      status: item.status,
      amount: item.amountYuan ?? item.amount ?? item.quoteYuan,
      confirmed: item.confirmed ?? item.settled,
      requestId: typeof item.requestId === 'string' ? item.requestId.slice(0, 12) : item.requestId,
    }));
  }
  console.log('=== raw (truncated) ===');
  console.log(data.body.slice(0, 4000));
});
