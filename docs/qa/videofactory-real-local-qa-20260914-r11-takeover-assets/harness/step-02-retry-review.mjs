// 步骤 2：通过正式 UI 点击"重试失败步骤"，只重做受影响的画面预检，不重建 run、不重买素材。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page, consoleMessages }) => {
  const traffic = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    const method = response.request().method();
    if (method === 'GET' && !/retry|resume|review|observe/.test(url)) return;
    let body = '';
    try { body = (await response.text()).slice(0, 600); } catch { /* 忽略不可读响应体 */ }
    traffic.push({ method, url, status: response.status(), body });
  });

  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  await shot(page, '02a-before-retry');

  const retry = page.locator('button:has-text("重试失败步骤")').first();
  await retry.waitFor({ state: 'visible', timeout: 15_000 });
  await retry.click();
  await page.waitForTimeout(8_000);
  await shot(page, '02b-after-retry-click');

  const body = await page.locator('body').innerText();
  console.log('=== TRAFFIC ===');
  for (const item of traffic) console.log(item.method, item.status, item.url, '\n   ', item.body.replace(/\s+/g, ' ').slice(0, 400));
  console.log('=== BODY (first 3500) ===');
  console.log(body.slice(0, 3500));
  console.log('=== CONSOLE ===');
  for (const message of consoleMessages.slice(-15)) console.log(message.type, message.text.slice(0, 200));
});
