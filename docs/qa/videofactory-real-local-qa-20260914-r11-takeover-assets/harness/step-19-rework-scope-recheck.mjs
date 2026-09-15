// 步骤 19：在修复后的客户端上重开同一源 run 的返工对话框，先只读核对默认范围
// （"先补查已有素材"的镜头不得再被预选或标成必改），再提交一次受控复验。
// 用法：node step-19-rework-scope-recheck.mjs [sourceRunId] [--submit]
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const args = process.argv.slice(2);
const SUBMIT = args.includes('--submit');
const RUN_ID = args.find((value) => !value.startsWith('--')) ?? 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page, consoleMessages }) => {
  let submitted = null;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') {
      try { submitted = request.postDataJSON(); } catch { submitted = null; }
    }
  });

  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);
  console.log('=== screenshot ===', await shot(page, '19a-before-rework-dialog'));

  await page.getByRole('button', { name: '调整方案后重新制作' }).click();
  await page.waitForTimeout(3_000);

  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: '开始制作' }).waitFor({ state: 'visible', timeout: 20_000 });
  console.log('=== dialog screenshot ===', await shot(page, '19b-rework-dialog'));

  const scope = await page.evaluate(() => {
    const region = document.querySelector('[aria-label="本轮变更范围"], section:has(#rework-scope-title)');
    const root = region ?? document;
    const checkboxes = [...root.querySelectorAll('input[type="checkbox"]')].map((input) => ({
      label: input.getAttribute('aria-label'),
      checked: input.checked,
      disabled: input.disabled,
    }));
    const text = root.innerText.replace(/\n{3,}/g, '\n\n');
    const summary = [...text.matchAll(/本轮(?:选择|未选择)[^\n]*/g)].map((match) => match[0]);
    const reuse = [...text.matchAll(/其余[^\n]*计划沿用[^\n]*/g)].map((match) => match[0]);
    return { checkboxes, summary, reuse };
  });
  writeFileSync(`${ASSETS}/checks/step-19-rework-scope.json`, JSON.stringify(scope, null, 2));
  console.log('=== scope checkboxes ===');
  for (const box of scope.checkboxes) console.log(JSON.stringify(box));
  console.log('=== summary ===', JSON.stringify(scope.summary), JSON.stringify(scope.reuse));

  if (!SUBMIT) {
    console.log('=== dry run：未提交（加 --submit 才提交）===');
    const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
    console.log('=== console errors ===', errors.length);
    return;
  }

  await dialog.getByRole('button', { name: '开始制作' }).click();
  await page.waitForURL((url) => /\/projects\/run-/.test(url.pathname) && !url.pathname.endsWith(RUN_ID), { timeout: 180_000 });
  await page.waitForTimeout(4_000);

  const newRunId = new URL(page.url()).pathname.split('/').pop();
  console.log('=== new runId ===', newRunId);
  console.log('=== screenshot ===', await shot(page, '19c-rework-run-created'));

  if (submitted) {
    writeFileSync(`${ASSETS}/checks/step-19-submitted-payload.json`, JSON.stringify(submitted, null, 2));
    const rework = submitted.rework ?? {};
    console.log('=== submitted summary ===', JSON.stringify({
      affectedScenePositions: rework.affectedScenePositions,
      sourceRunId: rework.sourceRunId,
      sourceRunRevision: rework.sourceRunRevision,
      findings: (rework.findings ?? []).map((finding) => ({
        p: finding.scenePosition, action: finding.action, next: finding.nextAction,
      })),
      voice: submitted.providers?.voice ?? null,
      voiceProfile: submitted.voiceDirection?.profileId ?? null,
    }));
  } else {
    console.log('=== WARNING: POST /api/runs body not captured ===');
  }

  const created = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    const j = await r.json();
    return {
      runId: j.runId, revision: j.revision, status: j.status,
      nodes: (j.nodes ?? []).map((n) => ({ id: n.id, status: n.status })),
    };
  }, `/api/runs/${newRunId}`);
  console.log('=== new run detail ===', JSON.stringify(created));

  const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errors.length);
  for (const e of errors.slice(0, 5)) console.log(JSON.stringify(e).slice(0, 300));
});
