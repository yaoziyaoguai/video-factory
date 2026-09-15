// 探针：只读打印 creative-review 接口的原始状态码与响应体，用于区分"闸门未开"与"探测有误"。
import { readFileSync } from 'node:fs';
import { withSession, BASE, ASSETS } from './browser.mjs';

const RUN_ID = readFileSync(`${ASSETS}/checks/step-r1-run-id.txt`, 'utf8').trim();

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);
  const out = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, headers: [...r.headers.entries()].filter(([k]) => k.startsWith('content-')), body: (await r.text()).slice(0, 1200) };
  }, `/api/runs/${RUN_ID}/creative-review`);
  console.log('URL:', `${BASE}/projects/${RUN_ID}`);
  console.log('status:', out.status);
  console.log('headers:', JSON.stringify(out.headers));
  console.log('body:', out.body);

  const run = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: (await r.text()).slice(0, 1500) };
  }, `/api/runs/${RUN_ID}`);
  console.log('--- GET /api/runs/:id status:', run.status);
  console.log(run.body);
  console.log('--- 页面可见文本 ---');
  console.log((await page.locator('body').innerText()).slice(0, 1500));
});
