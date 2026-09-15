// R11 续轮 步骤 11：成片终审就位——只读地取 operator 的决策面。
// 本步骤不提交任何决定，不改 run：只记录 final-review 的介入项、宿主给出的返工草稿、
// 以及双模型复审结论，供操作员据此决策。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

async function api(page, path) {
  return JSON.parse(await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.text();
  }, path));
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);

  const run = await api(page, `/api/runs/${RUN_ID}`);
  log('=== run ===', run.status, 'revision', run.revision);
  for (const n of run.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);

  log('\n=== final-review 介入项 ===');
  for (const i of run.interventions ?? []) {
    log(`  node=${i.nodeId} requiredAction=${i.requiredAction} options=${JSON.stringify(i.options)}`);
    log(`  reason=${i.reason}`);
    log(`  interventionId=${i.id}`);
    log(`  artifacts=${JSON.stringify(i.artifactIds)}`);
  }

  log('\n=== 双模型复审结论 ===');
  try {
    const review = await api(page, `/api/runs/${RUN_ID}/nodes/visual-review/report`).catch(() => null);
    if (review) log('  (节点报告接口可用)');
  } catch { /* 该接口不存在时忽略 */ }

  log('\n=== 宿主给出的返工草稿 GET /rework-draft ===');
  const draft = await api(page, `/api/runs/${RUN_ID}/rework-draft`).catch((error) => ({ error: String(error) }));
  writeFileSync(`${ASSETS}/checks/step-r11-rework-draft.json`, JSON.stringify(draft, null, 2));
  if (draft?.error) {
    log('  错误: ' + JSON.stringify(draft).slice(0, 400));
  } else {
    log('  顶层键: ' + Object.keys(draft).join(','));
    log('  sourceRunRevision=' + draft.sourceRunRevision);
    log('  needsScope=' + draft.needsScope + '  scopeUnresolved=' + draft.scopeUnresolved);
    log('  affectedScenePositions=' + JSON.stringify(draft.affectedScenePositions));
    log('  findings=' + JSON.stringify(draft.findings ?? [], null, 1).slice(0, 2000));
    log('  planningNodeIds=' + JSON.stringify(draft.planningNodeIds));
  }

  log('\n=== 页面可见的决定面文案 ===');
  const body = await page.locator('body').innerText();
  for (const token of ['总导演', '成片', 'request_changes', '请求修改', '返工', '批准']) {
    const hit = body.split('\n').map((s) => s.trim()).filter((s) => s.includes(token)).slice(0, 3);
    if (hit.length) log(`  [${token}] ` + hit.join(' / ').slice(0, 300));
  }

  const buttons = (await page.locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  log('\n=== 可见按钮 ===\n  ' + JSON.stringify(buttons));

  const errs = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  for (const m of errs.slice(-6)) log('  pageerror ' + m.text.slice(0, 250));

  await shot(page, 'r11a-final-review');
  writeFileSync(`${ASSETS}/checks/step-r11-final-review-surface.txt`, lines.join('\n'));
});
