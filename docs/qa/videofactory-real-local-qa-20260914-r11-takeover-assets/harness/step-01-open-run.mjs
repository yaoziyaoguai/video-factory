// 步骤 1：正常登录并打开主 run 页面，记录失败节点的界面文案与可用动作。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  await shot(page, '01-run-failed-state');

  const body = await page.locator('body').innerText();
  console.log('=== URL ===', page.url());
  console.log('=== BODY (first 4000) ===');
  console.log(body.slice(0, 4000));
  console.log('=== BUTTONS ===');
  for (const label of await page.locator('button').allInnerTexts()) {
    const trimmed = label.trim();
    if (trimmed) console.log(JSON.stringify(trimmed));
  }
  console.log('=== CONSOLE ===');
  for (const message of consoleMessages.slice(-20)) console.log(message.type, message.text.slice(0, 200));
});
