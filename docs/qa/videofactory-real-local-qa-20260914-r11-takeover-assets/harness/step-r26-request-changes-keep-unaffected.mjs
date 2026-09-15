// R11 收尾轮 步骤 26：对返工 run 的导演草稿提"改方案"，要求只改镜头 6、其余镜头沿用上一版。
//
// 为什么不是直接 approve：草稿带 blockingIssue —— 镜头 4 没有达到自动采用语义阈值的候选。
// 系统拒绝自动采用次档候选（这是质量标准，不许绕），所以放行只会把问题推到素材节点。
// 正确做法是把"未被要求修改的镜头必须逐镜沿用上一版"讲清楚，让它重出草稿。
//
// 更正（2026-09-15，原文此处写的"重规划顺手改写了镜头 4 的图库检索词"是错的）：
// 逐字段比对返工草稿 attempt-2/director-draft-r1.json 与源 run attempt-7/director-draft-r1.json，
// 镜头 4 的 deliveryType / preferredProviderId / query / subject / estimatedCostCny /
// sourceInSeconds / rationale 完全相同，request_changes 没有改变任何字段。
// 真实原因是跨 run 只播了 treatment/script，候选与排序在返工 run 里被从头重搜重排，
// 同一个候选 assetId 7577435 的 LLM 打分从 72 掉到 25，最高分 72 → 38，于是没过 40 的门槛。
// 证据见 checks/step-r26-finding-two-defects.txt。
//
// 这一步不花钱：改方案是重新生成草稿，付费只发生在报价被授权之后。
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-6ad4e264-8385-45ae-84a0-52d5ef5cc925';
const RUNS_DIR = process.env.QA_RUNS_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs');

const MESSAGE = [
  '本次重做的唯一原因是镜头 6 的画面审查未通过，不涉及其他镜头。请按下面两条重出草稿：',
  '1) 镜头 6 保留现在草稿里的修法：停稳约一秒之后再转头肩，并把"不得在停稳前完成转向、'
  + '最终头肩朝向不得与原方向相同"写成明确的禁止条件，让四个阶段可判定。',
  '2) 其余镜头（1、2、3、4、5、7）逐镜沿用上一版制作（source run revision 21）的方案原文，'
  + '特别是镜头 4：必须延用上一版已通过的图库来源与检索词，不要改写它的检索词。'
  + '现在草稿把镜头 4 的检索词改掉之后图库已经没有达标候选，这是本次阻断的直接原因；'
  + '镜头 4 没有被要求修改，改写它只会引入新问题。',
  '凡未被要求修改的镜头，请一律照抄上一版，不要"顺手优化"。',
].join('\n');

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

function runMetered(runId) {
  const file = path.join(RUNS_DIR, runId, 'run.json');
  if (!existsSync(file)) return 0;
  const run = JSON.parse(readFileSync(file, 'utf8'));
  return (run.executionReceipts ?? []).filter((r) => r.billing === 'metered').reduce((s, r) => s + (r.actualCostCny ?? 0), 0);
}

/** 工作区口径的累计付费：付费增量要看这里，不能拿单条 run 去减工作区累计。 */
function workspaceMetered() {
  let total = 0;
  for (const dir of readdirSync(RUNS_DIR)) {
    const file = path.join(RUNS_DIR, dir, 'run.json');
    if (!existsSync(file)) continue;
    const run = JSON.parse(readFileSync(file, 'utf8'));
    total += (run.executionReceipts ?? []).filter((r) => r.billing === 'metered').reduce((s, r) => s + (r.actualCostCny ?? 0), 0);
  }
  return total;
}

function state(runId) {
  const file = path.join(RUNS_DIR, runId, 'run.json');
  if (!existsSync(file)) return null;
  const run = JSON.parse(readFileSync(file, 'utf8'));
  return {
    status: run.status,
    revision: run.revision,
    metered: runMetered(runId),
    node: run.nodeRuns.find((n) => n.nodeId === 'creative-planning')?.status,
  };
}

await withSession(async ({ page }) => {
  const before = workspaceMetered();
  log(`=== 改方案前：工作区累计 ¥${before.toFixed(2)}｜本条 run ${JSON.stringify(state(RUN_ID))} ===`);
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6_000);
  await shot(page, 'r26a-before-change-request');

  for (const scene of ['镜头 4', '镜头 6']) {
    const box = page.locator('.creative-selection label', { hasText: scene }).locator('input[type="checkbox"]');
    if ((await box.count()) === 0) { log(`  警告：未找到「${scene}」勾选框`); continue; }
    if (!(await box.first().isChecked())) await box.first().check();
    log(`  已勾选 ${scene}`);
  }

  await page.locator('.creative-composer textarea').fill(MESSAGE);
  await shot(page, 'r26b-message-typed');
  await page.getByRole('button', { name: '发送' }).click();
  log('=== 已发送改方案请求，等待重出草稿 ===');

  let last = null;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(15_000);
    last = state(RUN_ID);
    if (i % 3 === 0) log(`    [${(i + 1) * 15}s] ${JSON.stringify(last)}`);
    if (last && last.status !== 'running') break;
  }
  await shot(page, 'r26c-after-change-request');

  const after = workspaceMetered();
  log(`\n=== 改方案后：工作区累计 ¥${after.toFixed(2)}｜本条 run ${JSON.stringify(last)} ===`);
  log(`★ 付费增量 ¥${(after - before).toFixed(2)}（改方案不应花钱）`);

  // 新草稿还有没有阻断项：这是"能不能进报价"的直接判据。
  const file = path.join(RUNS_DIR, RUN_ID, 'run.json');
  if (existsSync(file)) {
    const run = JSON.parse(readFileSync(file, 'utf8'));
    const out = run.nodeRuns.find((n) => n.nodeId === 'creative-planning')?.output ?? {};
    log(`\n  blockingIssues: ${JSON.stringify(out.blockingIssues ?? []).slice(0, 900)}`);
    const iv = run.interventions ?? [];
    for (const it of iv) log(`  intervention reason: ${it.reason}`);
  }
  writeFileSync(`${ASSETS}/checks/step-r26-request-changes.txt`, lines.join('\n'));
});
