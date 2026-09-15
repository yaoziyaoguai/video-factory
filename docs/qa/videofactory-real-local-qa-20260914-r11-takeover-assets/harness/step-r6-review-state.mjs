// R11 续轮：只读拉取创作复核快照（驱动看到的同一份），用于判断闸门是"还在跑"还是"已停"。
import { withSession } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';

await withSession(async ({ page }) => {
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, `/api/runs/${RUN_ID}/creative-review`);

  console.log('HTTP', r.status);
  if (r.status !== 200) { console.log(JSON.stringify(r.body, null, 2)); return; }
  const j = r.body;
  console.log(JSON.stringify({
    stage: j.stage,
    phase: j.phase,
    reviewRevision: j.reviewRevision,
    runRevision: j.runRevision,
    draftSha256: String(j.draftSha256).slice(0, 16),
    checkResult: j.checkResult ? { verdict: j.checkResult.verdict, score: j.checkResult.score, issues: (j.checkResult.issues ?? []).length } : null,
    blockingIssues: (j.blockingIssues ?? []).length,
    allowedActions: j.allowedActions,
    messages: (j.messages ?? []).length,
  }, null, 2));
  if (j.checkResult?.issues?.length) {
    for (const i of j.checkResult.issues) console.log(` · [${i.severity}] ${i.criterion} :: ${String(i.repairInstruction).slice(0, 160)}`);
  }
});
