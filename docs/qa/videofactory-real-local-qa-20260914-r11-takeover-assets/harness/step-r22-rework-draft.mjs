// R11 收尾轮 步骤 22：只读地看系统对 r21 的否决给出了什么返工范围。
//
// 这一步不花任何钱：GET /api/runs/:runId/rework-draft 只读 run、已否决素材与既有产物，
// 不调用任何模型。先看范围，再决定要不要为它花钱——顺序不能反。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);

  const draft = await page.evaluate(async (runId) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/rework-draft`, {
      headers: { accept: 'application/json', 'x-video-factory-request': 'studio' },
    });
    const body = await response.json().catch(() => undefined);
    return { status: response.status, body };
  }, RUN_ID);

  log(`=== rework-draft (只读，无模型调用) HTTP ${draft.status} ===`);
  if (draft.status !== 200) { log(JSON.stringify(draft.body).slice(0, 800)); }
  else {
    const d = draft.body;
    // 全文落盘：报告里要引用的是"系统自己给出的返工范围"，不能靠截断的片段推断。
    writeFileSync(`${ASSETS}/checks/step-r22-rework-draft.json`, JSON.stringify(d, null, 2));
    log(`顶层字段: ${Object.keys(d).join(', ')}`);
    log(`requiredAffectedScenePositions = ${JSON.stringify(d.requiredAffectedScenePositions)}`);
    log(`inheritedNodeIds = ${JSON.stringify(d.inheritedNodeIds)}`);
    const scope = d.scopeState ?? {};
    log(`scopeState 字段: ${Object.keys(scope).join(', ')}`);
    for (const key of Object.keys(scope)) {
      if (!Array.isArray(scope[key]) && typeof scope[key] !== 'object') log(`  scopeState.${key} = ${JSON.stringify(scope[key])}`);
    }
    for (const key of ['affectedScenePositions', 'requiredAffectedScenePositions', 'unmaterializedAssetScenePositions', 'rejectionReason']) {
      if (scope[key] !== undefined) log(`  scopeState.${key} = ${JSON.stringify(scope[key])}`);
    }
    const findings = scope.findings ?? d.findings ?? [];
    log(`\n  findings ${findings.length} 条:`);
    for (const f of findings) {
      log(`    - scene=${JSON.stringify(f.scenePositions ?? f.scenePosition)} action=${f.action} owner=${f.primaryOwnerNodeId} nodes=${JSON.stringify(f.affectedNodeIds)}`);
      log(`      ${String(f.description ?? f.reason ?? '').slice(0, 300)}`);
    }
  }
  await shot(page, 'r22-rework-draft');
  writeFileSync(`${ASSETS}/checks/step-r22-rework-draft.txt`, lines.join('\n'));
});
