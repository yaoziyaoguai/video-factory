// R11 收尾轮 步骤 20：让 assets 节点越过花费闸门，并核验它一分钱没花。
//
// 为什么需要这一步（缺陷记录，见 step-r19）：
//   换素材之后 assets 节点停在 awaiting_spend_approval，而费用面板给出的
//   spendAssessment.reason 是 "attempts"（"部分镜头的重试次数已达到你批准的上限"），
//   于是界面按设计只渲染「调整方案」「暂不继续」，**不渲染任何授权按钮**——
//   因为 attempts 类阻断的语义是"加钱解决不了"（production-authorization.ts:448-449）。
//   但这一次四个付费镜一个 create 都不需要：inputFingerprint 只由 {scenePosition, request} 决定，
//   与候选名次无关，历史台账里已 materialized，worker 会走 carry-forward 复用（¥0）。
//   所以这是个**假阳性阻断**：没有任何东西要买，产品却要求改方案。
//
// 本步骤的动作是产品自己的花费授权接口（就是界面「确认并执行」会发的那条请求，
// 字段逐字取自服务端的 spendPlan，人不再另填金额），从页面内已登录会话发出。
// 安全上界：即使 carry-forward 失效，worker 也会在越过付费边界前因
// itemCreateBudgets（priorCreates 1 / budget 1）抛错，不会产生新的付费 create。
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const diskRun = () => JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
const metered = (run) => (run.executionReceipts ?? []).filter((x) => x.billing === 'metered');
const cost = (run) => metered(run).reduce((s, x) => s + (x.actualCostCny ?? 0), 0);

function sceneFiles(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { sceneFiles(full, out); continue; }
    if (!/^scene_\d+_/.test(name)) continue;
    out[name] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return out;
}
function latestAttempt(node) {
  const dirs = readdirSync(path.join(RUN_DIR, 'nodes', node))
    .filter((d) => d.startsWith('attempt-'))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  return dirs[dirs.length - 1];
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);

  const before = diskRun();
  const attemptBefore = latestAttempt('assets');
  const reviewBefore = latestAttempt('visual-review');
  const filesBefore = sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptBefore));
  log('=== 授权前 ===');
  log(`  run=${before.status} revision=${before.revision}`);
  log(`  metered ¥${cost(before).toFixed(2)}｜收据 ${metered(before).length} 笔`
    + `｜授权 ${(before.spendAuthorizations ?? []).length} 笔`);

  const result = await page.evaluate(async (runId) => {
    const detail = await (await fetch(`/api/runs/${encodeURIComponent(runId)}`, { headers: { accept: 'application/json' } })).json();
    const node = (detail.nodes ?? []).find((candidate) => candidate.id === 'assets');
    if (!node?.spendPlan) return { error: 'assets 节点没有 spendPlan', status: detail.status };
    const plan = node.spendPlan;
    const payload = {
      spendPlanId: plan.id,
      inputVersionIds: [...plan.inputVersionIds],
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
    };
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/nodes/assets/spend-authorizations`, {
      method: 'POST',
      // x-video-factory-request 是 app.ts:225 的同源防伪校验，界面自身的客户端也会带。
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-video-factory-request': 'studio' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => undefined);
    return { status: response.status, payload, plan: { estimated: plan.estimatedCostCny, max: plan.maxCostCny }, body: body?.error ?? body?.status ?? undefined };
  }, RUN_ID);
  log('  授权请求: ' + JSON.stringify(result));
  await page.waitForTimeout(4_000);
  await shot(page, 'r20a-authorized');

  let state = null;
  for (let i = 0; i < 240; i += 1) {
    await page.waitForTimeout(15_000);
    const r = diskRun();
    if (i % 4 === 0) log(`    [${(i + 1) * 15}s] run=${r.status} revision=${r.revision}`);
    if (r.status !== 'running') { state = r; break; }
  }
  await shot(page, 'r20b-after-pipeline');

  const after = state ?? diskRun();
  const attemptAfter = latestAttempt('assets');
  const filesAfter = attemptAfter === attemptBefore
    ? filesBefore
    : sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptAfter));

  log('\n=== 授权后 ===');
  log(`  run=${after.status} revision=${after.revision}`);
  log(`  metered ¥${cost(after).toFixed(2)}｜收据 ${metered(after).length} 笔`);
  log(`  ★ 实际付费增量 ¥${(cost(after) - cost(before)).toFixed(2)}（判据：必须为 0.00）`);
  log(`  授权 ${(after.spendAuthorizations ?? []).length} 笔｜已消耗 ${(after.consumedSpendAuthorizationIds ?? []).length} 份`);
  if (after.failure) log(`  failure: ${JSON.stringify(after.failure).slice(0, 300)}`);

  log(`\n  素材 attempt=${attemptBefore} -> ${attemptAfter}`);
  for (let scene = 1; scene <= 7; scene += 1) {
    const pick = (files) => Object.entries(files).filter(([n]) => n.startsWith(`scene_0${scene}_`)).map(([n]) => n).sort().join(',');
    const b = pick(filesBefore);
    const a = pick(filesAfter);
    log(`  场景 ${scene}: ${b === a ? '未变' : '换新'}  ${b || '-'} -> ${a || '-'}`);
  }

  const reviewAfter = latestAttempt('visual-review');
  log(`\n  审片 attempt: ${reviewBefore} -> ${reviewAfter}`);
  if (reviewAfter !== reviewBefore) {
    const review = JSON.parse(readFileSync(path.join(RUN_DIR, 'nodes/visual-review', reviewAfter, 'visual_review.json'), 'utf8'));
    log(`  综合=${review.recommendation} 分数=${JSON.stringify(review.scores)}`);
    for (const f of review.findings ?? []) {
      if ((f.scenePosition ?? 0) !== 4) continue;
      log(`    镜头4 ${f.severity} target=${f.targetNodeId} next=${f.nextAction}: ${String(f.description).slice(0, 120)}`);
    }
  }
  for (const n of after.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);
  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-8)) {
    log('  pageerror ' + m.text.slice(0, 250));
  }
  writeFileSync(`${ASSETS}/checks/step-r20-authorize-reuse.txt`, lines.join('\n'));
});
