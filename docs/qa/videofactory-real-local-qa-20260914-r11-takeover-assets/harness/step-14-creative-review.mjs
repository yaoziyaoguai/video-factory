// 步骤 14：只读读取返工 run 的创作讨论（分镜与画面方案），并截图；不 approve、不 request_changes。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-e204cd6c-2365-4cda-bb1d-c50e6e69bb8a';

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  console.log('=== screenshot ===', await shot(page, '14a-rework-creative-review'));

  const review = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}/creative-review`);
  console.log('=== creative-review status ===', review.status);
  if (review.status === 200) {
    writeFileSync(`${ASSETS}/checks/step-14-creative-review.json`, review.body);
    const j = JSON.parse(review.body);
    console.log('keys:', Object.keys(j).join(','));
    console.log('stage:', j.stage, 'reviewRevision:', j.reviewRevision);
    console.log('pendingAction:', JSON.stringify(j.pendingAction ?? j.intervention ?? null).slice(0, 400));
    const text = JSON.stringify(j);
    console.log('bodyBytes:', text.length);
  }

  const visible = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 3000));
  console.log('=== visible text ===');
  console.log(visible);
  const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errors.length);
});
