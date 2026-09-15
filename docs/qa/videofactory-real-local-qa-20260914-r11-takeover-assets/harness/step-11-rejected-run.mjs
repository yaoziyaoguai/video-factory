// 步骤 11：记录素材预检 rejected 终态的用户可见界面与节点诊断（只读，不点击任何付费动作）。
import { withSession, BASE, shot } from './browser.mjs';

const RUN_ID = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  const top = await shot(page, '11a-rejected-run-top');
  const text = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 2600));
  console.log('=== screenshot ===', top);
  console.log('=== visible text ===');
  console.log(text);
  const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errors.length);
  for (const e of errors.slice(0, 8)) console.log(JSON.stringify(e).slice(0, 300));
  const actions = await page.evaluate(() => [...document.querySelectorAll('button, a[role="button"]')]
    .map((el) => (el.textContent ?? '').trim())
    .filter((label) => label.length > 0 && label.length < 30));
  console.log('=== actions ===', JSON.stringify([...new Set(actions)]));
});
