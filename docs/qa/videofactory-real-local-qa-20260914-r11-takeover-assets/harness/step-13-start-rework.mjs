// 步骤 13：走产品自带"调整方案后重新制作"入口提交一次受控返工，记录提交载荷与新 runId。
// 提交本身不产生现金支出：新一轮会先重新规划并逐项报价，购买前仍需人工确认。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page, consoleMessages }) => {
  let submitted = null;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') {
      try { submitted = request.postDataJSON(); } catch { submitted = null; }
    }
  });

  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);

  const before = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    const j = await r.json();
    return { revision: j.revision, status: j.status, runId: j.runId, currentVersionRunId: j.currentVersionRunId ?? null };
  }, `/api/runs/${RUN_ID}`);
  console.log('=== source run before ===', JSON.stringify(before));

  await page.getByRole('button', { name: '调整方案后重新制作' }).click();
  await page.waitForTimeout(2_500);

  const dialog = page.locator('[role="dialog"]');
  const start = dialog.getByRole('button', { name: '开始制作' });
  await start.waitFor({ state: 'visible', timeout: 20_000 });
  console.log('=== start button enabled ===', await start.isEnabled());
  await start.click();

  await page.waitForURL((url) => /\/projects\/run-/.test(url.pathname) && !url.pathname.endsWith(RUN_ID), { timeout: 120_000 });
  await page.waitForTimeout(4_000);

  const newRunId = new URL(page.url()).pathname.split('/').pop();
  console.log('=== new runId ===', newRunId);
  console.log('=== screenshot ===', await shot(page, '13a-rework-run-created'));

  if (submitted) {
    writeFileSync(`${ASSETS}/checks/step-13-submitted-payload.json`, JSON.stringify(submitted, null, 2));
    const rework = submitted.rework ?? {};
    console.log('=== submitted summary ===');
    console.log(JSON.stringify({
      title: submitted.title,
      affectedScenePositions: rework.affectedScenePositions,
      sourceRunId: rework.sourceRunId,
      sourceRunRevision: rework.sourceRunRevision,
      inheritedNodeIds: Object.keys(submitted).filter((k) => k !== "rework"),
      voice: submitted.voice ?? submitted.voiceDirector ?? null,
    }));
    console.log('=== payload saved to checks/step-13-submitted-payload.json ===');
  } else {
    console.log('=== WARNING: POST /api/runs body not captured ===');
  }

  const created = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    const j = await r.json();
    return {
      runId: j.runId, revision: j.revision, status: j.status,
      versionOf: j.versionOf ?? j.parentRunId ?? null,
      nodes: (j.nodes ?? []).map((n) => ({ id: n.id, status: n.status })),
      totals: j.costTotals ?? j.totals ?? null,
    };
  }, `/api/runs/${newRunId}`);
  console.log('=== new run detail ===', JSON.stringify(created, null, 1));

  const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errors.length);
  for (const e of errors.slice(0, 5)) console.log(JSON.stringify(e).slice(0, 300));
});
