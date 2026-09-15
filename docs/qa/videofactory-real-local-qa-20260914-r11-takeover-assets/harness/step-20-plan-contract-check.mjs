// 步骤 20：只读核对复验轮的导演方案是否仍包含合同未声明的既有素材绑定语法，
// 并打印独立 check 的结论。不确认、不提交、不授权任何支出。
// 用法：node step-20-plan-contract-check.mjs [runId]
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-b0468e64-2815-46e6-b837-7cf1bfafa389';
// 合同里已声明的复用语法只有这些（visual-director / generative-asset-worker 内的解析口径）。
const DECLARED = [/^REUSE_ONLY\s+scene\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i];
// 返工轮曾出现过的、未被任何解析器接受的伪语法片段。
const UNDECLARED = [/EXISTING_ASSET_ONLY/i, /KEEP_EXISTING/i, /REUSE_EXISTING/i];
const SHOT_FIELDS = ['scenePosition', 'reuseFromScenePosition', 'sourceInSeconds', 'preferredProviderId', 'providerId', 'deliveryType', 'query', 'estimatedCostCny'];

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_500);

  const detail = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}`);
  writeFileSync(`${ASSETS}/checks/step-20-run-detail.json`, detail.body);
  const run = JSON.parse(detail.body);
  console.log('=== run ===', run.runId ?? run.id, 'status', run.status, 'revision', run.revision);

  const shots = collectShots(run);
  console.log('=== director shots ===', shots.length);
  let undeclaredHits = 0;
  for (const shot of shots) {
    const row = {};
    for (const field of SHOT_FIELDS) if (shot[field] !== undefined) row[field] = shot[field];
    if (typeof row.query === 'string') {
      row.query = row.query.slice(0, 90);
      if (UNDECLARED.some((pattern) => pattern.test(row.query))) undeclaredHits += 1;
      if (/^\s*[A-Z_]{6,}\b/.test(row.query) && !DECLARED.some((pattern) => pattern.test(row.query))) {
        console.log('  ! 非声明语法前缀:', JSON.stringify(row.query));
      }
    }
    console.log('  ', JSON.stringify(row));
  }
  console.log('=== 未声明语法命中数 ===', undeclaredHits);

  const review = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}/creative-review`);
  writeFileSync(`${ASSETS}/checks/step-20-creative-review.json`, review.body);
  if (review.status === 200) {
    const parsed = JSON.parse(review.body);
    const review0 = parsed.review ?? parsed;
    console.log('=== creative review ===', JSON.stringify({
      phase: review0.phase,
      reviewRevision: review0.reviewRevision,
      allowedActions: review0.allowedActions,
    }));
    const checks = review0.checkResult ?? review0.checks ?? review0.independentCheck;
    if (checks) console.log('=== checkResult ===', JSON.stringify(checks).slice(0, 1400));
  } else {
    console.log('=== creative review HTTP', review.status, '===');
  }
  console.log('=== screenshot ===', await shot(page, '20a-plan-contract-check'));
});

function collectShots(run) {
  const found = [];
  const seen = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.shots)) {
      for (const shot of value.shots) {
        if (!shot || typeof shot !== 'object') continue;
        const key = JSON.stringify(shot);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(shot);
      }
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(run);
  return found.sort((left, right) => (left.scenePosition ?? 0) - (right.scenePosition ?? 0));
}
