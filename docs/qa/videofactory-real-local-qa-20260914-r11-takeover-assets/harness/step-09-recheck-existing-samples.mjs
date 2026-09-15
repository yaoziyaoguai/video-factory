// 步骤 9：通过正式 UI 点击「重新检查已有试片」，只重跑受影响的 asset-source-review，
// 不重建 run、不重买素材；点击后轮询到该节点出现终态为止。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';
const POLL_TIMEOUT_MS = Number(process.env.QA_RECHECK_TIMEOUT_MS ?? 25 * 60 * 1000);

await withSession(async ({ page }) => {
  const traffic = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    if (response.request().method() === 'GET' && !/retry|resume|review/.test(url)) return;
    let body = '';
    try { body = (await response.text()).slice(0, 400); } catch { /* 忽略不可读响应体 */ }
    traffic.push(`${response.request().method()} ${response.status()} ${url} ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
  });

  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);

  // run 处于 rejected 时该按钮叫「重新检查已有试片」，failed 时同一处理器显示为「重试失败步骤」。
  const recheck = page.locator('button:has-text("重新检查已有试片"), button:has-text("重试失败步骤")').first();
  await recheck.waitFor({ state: 'visible', timeout: 15_000 });
  await recheck.click();
  console.log('=== clicked 重新检查已有试片 at', new Date().toISOString(), '===');
  await page.waitForTimeout(6_000);
  await shot(page, '09a-after-recheck-click');
  for (const line of traffic) console.log('TRAFFIC', line);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const state = await page.evaluate(async (runId) => {
      const response = await fetch(`/api/runs/${runId}`, { credentials: 'include', headers: { accept: 'application/json' } });
      const run = await response.json();
      const node = (run.nodes ?? []).find((item) => item.id === 'asset-source-review');
      return { runStatus: run.status, nodeStatus: node?.status, attempts: node?.attempts ?? node?.attempt ?? null };
    }, RUN_ID).catch((error) => ({ error: String(error) }));
    const rendered = JSON.stringify(state);
    if (rendered !== last) {
      console.log(new Date().toISOString(), rendered);
      last = rendered;
    }
    if (state.nodeStatus && !['pending', 'running'].includes(state.nodeStatus)) {
      console.log('=== terminal node status:', state.nodeStatus, 'at', new Date().toISOString(), '===');
      break;
    }
    await page.waitForTimeout(15_000);
  }

  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  await shot(page, '09b-recheck-result');
  const body = await page.locator('body').innerText();
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => line.includes('制作进度'));
  console.log('=== page status lines ===');
  console.log(lines.slice(Math.max(0, start), start + 22).join('\n'));
});
