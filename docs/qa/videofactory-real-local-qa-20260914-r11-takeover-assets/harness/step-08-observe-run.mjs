// 步骤 8：只读观察原主片当前状态（节点、回执、诊断文案）与页面呈现。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';
const tag = process.argv[3] ?? 'observe';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  await shot(page, `08-${tag}`);

  const detail = await page.evaluate(async (runId) => {
    const response = await fetch(`/api/runs/${runId}`, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: response.status, body: await response.text() };
  }, RUN_ID);
  const run = JSON.parse(detail.body);

  console.log('=== run ===');
  console.log(JSON.stringify({
    status: run.status,
    revision: run.revision,
    currentNodeId: run.currentNodeId,
    waitingFor: run.waitingFor ?? null,
    failure: run.failure ?? null,
  }, null, 1));

  console.log('=== nodes ===');
  for (const node of run.nodeRuns ?? []) {
    console.log(JSON.stringify({
      nodeId: node.nodeId,
      status: node.status,
      attempt: node.attempt,
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      error: typeof node.error === 'string' ? node.error.slice(0, 400) : node.error ?? null,
    }));
  }

  console.log('=== review receipts ===');
  for (const receipt of run.executionReceipts ?? []) {
    if (!/review/.test(String(receipt.nodeId ?? ''))) continue;
    console.log(JSON.stringify({
      nodeId: receipt.nodeId,
      status: receipt.status,
      modelId: receipt.modelId,
      actualModelIds: receipt.actualModelIds,
      parameters: receipt.parameters,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
    }));
  }

  console.log('=== page status lines ===');
  const body = await page.locator('body').innerText();
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => line.includes('制作进度'));
  console.log(lines.slice(Math.max(0, start), start + 26).join('\n'));
});
