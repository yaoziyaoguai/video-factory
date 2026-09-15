// R11 收尾轮 步骤 18：操作员采纳「镜头 4 蒸汽亮边」这条 critical 结论里的
// 「这一镜素材本身不合格」这一面，用新能力「换一版这一镜素材」换掉这一镜的来源。
//
// 与步骤 15（改旁白）的区别，也是这轮真正的分界：
//   步骤 15 改的是承诺，画面不动；但审片的 failed 依据是脚本的 visible_action／success_criteria
//   （「蒸汽从杯口连续升起」「逆光亮边勾出蒸汽轮廓」），改旁白不会降低这两条要求——
//   证据：creative-planning/revisions/revision-14 的 script.json 已在 09:42 落盘新旁白，
//   而 visual-review/attempt-4（10:28）的审片提示词里同时含新旁白与 26 处「蒸汽」，
//   仍旧判 failed。所以合法的出路只剩换素材 / 借别的镜头 / 回方案改要求。
//
// 本步骤走「换素材」：在该镜**已通过语义筛选**的候选里改选下一名
// （scene 4 候选：7577435 得 72 → 7236863 得 65，两者都 ≥ 40 门槛）。
// 预期付费增量 ¥0：stock 走 Pexels 免费下载，已付费的 4 个生成镜按 inputFingerprint 携带复用。
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);

const NOTE = '镜头 4 三次采样（opening/middle/closing）都只见杯体，杯口没有可辨认的蒸汽轮廓或暖色亮边，'
  + '违背脚本对这一幕的可见动作要求。这一镜的画面来源不合格，改旁白不会降低脚本的可见动作要求，'
  + '所以换这一镜的素材来源，不动其它六个镜头的方案。';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const diskRun = () => JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
const metered = (run) => (run.executionReceipts ?? []).filter((x) => x.billing === 'metered');
const cost = (run) => metered(run).reduce((s, x) => s + (x.actualCostCny ?? 0), 0);

// 素材文件按 attempt 分目录：生成镜在 attempt 根，stock 下载在 attempt/assets/job-*/。
function sceneFiles(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { sceneFiles(full, out); continue; }
    if (!/^scene_\d+_/.test(name)) continue;
    out[name] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return out;
}
function latestAssetsAttempt() {
  const dirs = readdirSync(path.join(RUN_DIR, 'nodes/assets'))
    .filter((d) => d.startsWith('attempt-'))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  return dirs[dirs.length - 1];
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6_000);

  const before = diskRun();
  const attemptBefore = latestAssetsAttempt();
  const filesBefore = sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptBefore));
  log('=== 操作前 ===');
  log(`  run=${before.status} revision=${before.revision}`);
  log(`  metered ¥${cost(before).toFixed(2)}｜收据 ${metered(before).length} 笔`);
  log(`  素材 attempt=${attemptBefore}｜${Object.keys(filesBefore).length} 个文件`);
  for (const [name, hash] of Object.entries(filesBefore).sort()) log(`    ${hash.slice(0, 12)} ${name}`);

  // 这一镜的结论块里必须真的有「换一版这一镜素材」这个入口——
  // 上个快照（步骤 17）看不到它，是因为当时服务端还是旧构建。
  const block = page.locator('.scene-revision-finding').filter({ hasText: '镜头 4' }).first();
  await block.scrollIntoViewIfNeeded();
  const button = block.getByRole('button', { name: '换一版这一镜素材' });
  const present = await button.count();
  log(`\n  「换一版这一镜素材」入口可见=${present > 0}`);
  await shot(page, 'r18a-reselect-surface');
  if (present === 0) {
    log('  入口不存在，后面不再往下走。');
    writeFileSync(`${ASSETS}/checks/step-r18-reselect-scene4.txt`, lines.join('\n'));
    return;
  }

  const note = block.getByLabel('重取说明');
  await note.fill(NOTE);
  await page.waitForTimeout(500);
  log(`  提交按钮 disabled=${await button.isDisabled()}`);
  await shot(page, 'r18b-reselect-filled');

  await button.click();
  log('  已提交「换一版这一镜素材」');
  await page.waitForTimeout(5_000);
  await shot(page, 'r18c-submitted');

  // 素材→素材审查→配音→渲染→技术质检→审片→终审。素材审查本身两次 GLM 调用约 12 分钟，
  // 审片双模型约 13 分钟，所以按 15 秒 × 160 次（40 分钟）留足余量。
  let state = null;
  for (let i = 0; i < 160; i += 1) {
    await page.waitForTimeout(15_000);
    const r = diskRun();
    if (i % 4 === 0) log(`    [${(i + 1) * 15}s] run=${r.status} revision=${r.revision}`);
    if (r.status !== 'running') { state = r; break; }
  }
  await shot(page, 'r18d-after-reselect');

  const after = state ?? diskRun();
  const attemptAfter = latestAssetsAttempt();
  const filesAfter = attemptAfter === attemptBefore
    ? filesBefore
    : sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptAfter));

  log('\n=== 操作后 ===');
  log(`  run=${after.status} revision=${after.revision}`);
  log(`  metered ¥${cost(after).toFixed(2)}｜收据 ${metered(after).length} 笔`);
  log(`  付费增量 ¥${(cost(after) - cost(before)).toFixed(2)}（应为 0）`);
  log(`  素材 attempt=${attemptAfter}`);
  for (const [name, hash] of Object.entries(filesAfter).sort()) log(`    ${hash.slice(0, 12)} ${name}`);

  log('\n=== 逐镜比对（场景 -> 是否变）===');
  for (let scene = 1; scene <= 7; scene += 1) {
    const pick = (files) => Object.entries(files).filter(([n]) => n.startsWith(`scene_0${scene}_`));
    const b = pick(filesBefore);
    const a = pick(filesAfter);
    const bName = b.map(([n]) => n).sort().join(',');
    const aName = a.map(([n]) => n).sort().join(',');
    const changed = bName !== aName;
    log(`  场景 ${scene}: ${changed ? '换新' : '未变'}  ${bName || '-'} -> ${aName || '-'}`);
  }

  // 规划节点这一镜的候选名次是否真的提前了第二名
  const planningNode = (after.nodeRuns ?? []).some((n) => n.nodeId === 'creative-planning') ? 'creative-planning' : 'visual-direction';
  const revisions = readdirSync(path.join(RUN_DIR, 'nodes', planningNode, 'revisions'))
    .filter((d) => d.startsWith('revision-'))
    .sort((x, y) => Number(x.slice(9)) - Number(y.slice(9)));
  const latestRevision = revisions[revisions.length - 1];
  const ranking = JSON.parse(readFileSync(
    path.join(RUN_DIR, 'nodes', planningNode, 'revisions', latestRevision, 'candidate_ranking.json'), 'utf8'));
  const scene4 = (ranking.scenes ?? []).find((s) => (s.scenePosition ?? s.position) === 4);
  log(`\n  规划节点 ${planningNode} 最新 revision=${latestRevision} 镜头4 候选顺序:`);
  for (const c of (scene4?.candidates ?? []).slice(0, 4)) {
    log(`    rank ${c.rank} ${c.provider}/${c.assetId} score=${c.semanticScore ?? c.score ?? '-'}`);
  }

  // 新的审片结论（这一镜是否还判 failed）
  const reviewAttempts = readdirSync(path.join(RUN_DIR, 'nodes/visual-review'))
    .filter((d) => d.startsWith('attempt-'))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const latestReview = reviewAttempts[reviewAttempts.length - 1];
  const review = JSON.parse(readFileSync(
    path.join(RUN_DIR, 'nodes/visual-review', latestReview, 'visual_review.json'), 'utf8'));
  log(`\n  最新审片 ${latestReview}: 综合=${review.recommendation} 分数=${JSON.stringify(review.scores)}`);
  for (const f of review.findings ?? []) {
    if ((f.scenePosition ?? 0) !== 4) continue;
    log(`    镜头4 ${f.severity} target=${f.targetNodeId} next=${f.nextAction} ${String(f.description).slice(0, 90)}`);
  }

  for (const n of after.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);
  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-8)) {
    log('  pageerror ' + m.text.slice(0, 250));
  }
  writeFileSync(`${ASSETS}/checks/step-r18-reselect-scene4.txt`, lines.join('\n'));
});
