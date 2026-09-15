// 步骤 12：走产品自带的"调整方案后重新制作"入口，只打开对话框并记录范围勾选与提示，
// 不提交、不新建 run、不触发任何报价或购买。
import { withSession, BASE, shot } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);

  const trigger = page.getByRole('button', { name: '调整方案后重新制作' });
  await trigger.waitFor({ state: 'visible', timeout: 20_000 });
  await trigger.click();
  await page.waitForTimeout(2_500);

  console.log('=== dialog screenshot ===', await shot(page, '12a-rework-dialog'));

  const scope = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') ?? document.body;
    const boxes = [...dialog.querySelectorAll('input[type="checkbox"]')].map((el) => {
      const label = el.closest('label') ?? document.querySelector(`label[for="${el.id}"]`);
      return {
        id: el.id || null,
        checked: el.checked,
        disabled: el.disabled,
        name: el.name || null,
        label: (label?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      };
    });
    const buttons = [...dialog.querySelectorAll('button')]
      .map((el) => ({ text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), disabled: el.disabled, type: el.type }))
      .filter((b) => b.text.length > 0 && b.text.length < 40);
    return { boxes, buttons };
  });
  console.log('=== scope checkboxes ===');
  for (const b of scope.boxes) console.log(JSON.stringify(b));
  console.log('=== dialog buttons ===');
  for (const b of scope.buttons) console.log(JSON.stringify(b));

  const text = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') ?? document.body;
    return dialog.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 2600);
  });
  console.log('=== dialog text ===');
  console.log(text);

  const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errors.length);

  // 明确不提交：只做只读读取后关闭，避免误触发新一轮报价。
  console.log('=== submitted: NO (read-only inspection) ===');
});
