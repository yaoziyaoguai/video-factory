// R11 续轮步骤 R2：驱动创作规划的三个确认闸门（导演方案 → 脚本 → 分镜与画面方案）。
// 走真实 UI 按钮路径。遇到 repair 判定即停止并记录，不重复点击（避免无进展的付费复核）。
// 节点状态从磁盘 run.json 读（HTTP 视图省略 nodeRuns），闸门状态走 creative-review 接口。
// 只确认方案，不购买、不授权。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, ASSETS, ROOT, shot } from './browser.mjs';

const RUN_ID = readFileSync(`${ASSETS}/checks/step-r1-run-id.txt`, 'utf8').trim();
const RUN_DIR = path.join(ROOT, 'workspace/qa-r11-repair-20260914/runs', RUN_ID);
const POLL_MS = 15_000;
const PLANNING_DEADLINE_MS = 60 * 60 * 1000;
const GATE_DEADLINE_MS = 25 * 60 * 1000;
const MAX_GATES = 6;

function readRun() {
  try {
    return JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function nodeStatus(run, nodeId) {
  return run?.nodeRuns?.find((n) => n.nodeId === nodeId)?.status ?? 'absent';
}

const startedAt = Date.now();
let gatesSeen = 0;
const timeline = [];

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);

  const fetchReview = () => page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    if (r.status !== 200) return { absent: true, status: r.status };
    return await r.json();
  }, `/api/runs/${RUN_ID}/creative-review`);

  let gateWaitStarted = Date.now();
  for (;;) {
    const run = readRun();
    const review = await fetchReview();

    if (!review.absent && review.phase === 'waiting_user') {
      gatesSeen += 1;
      gateWaitStarted = Date.now();
      const verdict = review.checkResult?.verdict ?? null;
      console.log(`[闸门 ${gatesSeen}] stage=${review.stage} revision=${review.reviewRevision} 复核=${verdict ?? '无'} 阻断项=${review.blockingIssues?.length ?? 0}`);
      writeFileSync(`${ASSETS}/checks/step-r2-gate-${gatesSeen}.json`, JSON.stringify(review, null, 2));

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3_000);
      await shot(page, `r2-gate-${gatesSeen}-${review.stage}`);

      if (verdict === 'repair') {
        console.log('  → 独立复核判定 repair，停止确认，记录后交人工判断');
        for (const issue of review.checkResult.issues ?? []) {
          console.log(`     · [${issue.severity}] ${issue.criterion}`);
          console.log(`       证据: ${String(issue.evidence).slice(0, 200)}`);
          console.log(`       修复指令: ${String(issue.repairInstruction).slice(0, 220)}`);
        }
        const primary = page.locator('.creative-review-actions button').last();
        console.log(`  → 主按钮文案="${(await primary.innerText()).trim()}" disabled=${await primary.isDisabled()}`);
        timeline.push({ gate: gatesSeen, outcome: 'repair', stage: review.stage, reviewRevision: review.reviewRevision, issues: review.checkResult.issues ?? [] });
        break;
      }

      const button = page.getByRole('button', { name: '确认当前方案，继续' });
      if (!(await button.count())) {
        console.log('  → 未找到确认按钮，操作区文本:', (await page.locator('.creative-review-actions').innerText().catch(() => '(无)')).slice(0, 300));
        timeline.push({ gate: gatesSeen, outcome: 'no_confirm_button', stage: review.stage });
        break;
      }
      console.log('  → 点击确认');
      await button.click();
      timeline.push({ gate: gatesSeen, outcome: 'confirmed', stage: review.stage, reviewRevision: review.reviewRevision, at: new Date().toISOString() });
      await page.waitForTimeout(10_000);
      continue;
    }

    // 闸门未出现：区分"还在规划（含正在开会话/写稿）"与"规划节点已终态"
    // 注意闸门处节点状态是 needs_human 而非 running，所以只有终态才算结束。
    const planning = nodeStatus(run, 'creative-planning');
    const status = run?.status ?? 'unknown';
    if (review.absent && ['succeeded', 'failed', 'rejected'].includes(planning)) {
      console.log(`=== 规划阶段结束：creative-planning=${planning} run=${status}`);
      break;
    }
    if (Date.now() - gateWaitStarted > GATE_DEADLINE_MS) {
      console.log('=== 等待闸门超时（25 分钟），停止驱动，保留现场');
      timeline.push({ gate: gatesSeen + 1, outcome: 'timeout' });
      break;
    }
    if (Date.now() - startedAt > PLANNING_DEADLINE_MS) {
      console.log('=== 规划总时长超时（60 分钟），停止驱动');
      timeline.push({ outcome: 'planning_timeout' });
      break;
    }
    process.stdout.write(`. [planning=${planning} run=${status} review=${review.absent ? 'none' : review.phase}]\n`);
    await page.waitForTimeout(POLL_MS);
  }

  writeFileSync(`${ASSETS}/checks/step-r2-timeline.json`, JSON.stringify(timeline, null, 2));

  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  await shot(page, 'r2-planning-final');
  const run = readRun();
  console.log('=== run', RUN_ID, 'status', run?.status, 'revision', run?.revision);
  for (const n of run?.nodeRuns ?? []) console.log('  node', n.nodeId, n.status, String(n.error ?? '').slice(0, 200));
});
