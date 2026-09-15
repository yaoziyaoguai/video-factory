import { withSession, BASE } from './browser.mjs';
await withSession(async ({ page }) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const r = await page.evaluate(async () => {
    const res = await fetch('/api/voices', { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: res.status, body: await res.text() };
  });
  const list = JSON.parse(r.body);
  const arr = Array.isArray(list) ? list : (list.voices ?? []);
  const byEngine = {};
  for (const v of arr) byEngine[v.engine ?? v.providerId] = (byEngine[v.engine ?? v.providerId] ?? 0) + 1;
  console.log('status', r.status, 'total', arr.length, JSON.stringify(byEngine));
  for (const v of arr.filter((x) => String(x.providerId ?? '').includes('minimax'))) console.log('  ', v.id, '|', v.label, '|', v.locale);
});
