// 步骤 3：观察重做后的画面预检进度（只读，不触发任何写操作）。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';
const tag = process.argv[2] ?? 'watch';

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  await shot(page, `03-${tag}-review-running`);
  const body = await page.locator('body').innerText();
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => line.includes('制作进度'));
  console.log('=== status lines ===');
  console.log(lines.slice(Math.max(0, start), start + 30).join('\n'));
  console.log('=== cost lines ===');
  const cost = lines.findIndex((line) => line.includes('已记录费用'));
  console.log(lines.slice(Math.max(0, cost - 2), cost + 12).join('\n'));
  console.log('=== console ===');
  for (const message of consoleMessages.slice(-10)) console.log(message.type, message.text.slice(0, 200));
});
