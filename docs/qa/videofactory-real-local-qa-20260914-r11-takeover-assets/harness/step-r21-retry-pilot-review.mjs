// R11 收尾轮 步骤 21：媒体预处理并发缺陷修复后，对 r20 的失败节点做一次受控复验。
//
// 为什么这一步是"复验"而不是"重做"：
//   r20 的 assets 错误逐字写着"镜头 6 已生成，但试片审查暂未完成……重试时会复用该镜头并
//   恢复审查"，试片证据目录里也只有 glm 分支的 checkpoint（gpt 分支死在媒体预处理）。
//   所以这次重试只应该补跑 gpt 那一个分支，一份素材都不该重买。
//
// 判据（任一不成立即记为失败，不当作"跑通了就算"）：
//   1) 实际付费增量必须为 ¥0.00；
//   2) 场景素材文件哈希不变——复用的是同一个文件，不是重买了一个同名文件；
//   3) gpt 分支要么补跑成功，要么给出可定位的新原因；不允许再退回"调用失败"。
import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);
const GPT_CHECKPOINT_PREFIX = 'checkpoint-419255f2';
const GLM_CHECKPOINT_PREFIX = 'checkpoint-0d872417';

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

// 试片证据目录按内容指纹命名，直接铺开看两个分支各自留下了什么。
function pilotEvidence() {
  const root = path.join(RUN_DIR, 'asset-pilot-reviews');
  if (!existsSync(root)) return {};
  const out = {};
  for (const key of readdirSync(root).sort()) {
    const files = readdirSync(path.join(root, key)).sort();
    out[key] = {
      glm: files.some((f) => f.startsWith(GLM_CHECKPOINT_PREFIX)),
      gpt: files.some((f) => f.startsWith(GPT_CHECKPOINT_PREFIX)),
      report: files.includes('review.json'),
    };
  }
  return out;
}

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);

  const before = diskRun();
  const attemptBefore = latestAttempt('assets');
  const filesBefore = sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptBefore));
  const pilotBefore = pilotEvidence();
  log('=== 复验前 ===');
  log(`  run=${before.status} revision=${before.revision}`);
  log(`  metered ¥${cost(before).toFixed(2)}｜收据 ${metered(before).length} 笔`);
  log(`  素材 attempt=${attemptBefore}｜试片证据 ${JSON.stringify(pilotBefore)}`);

  const result = await page.evaluate(async (runId) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/nodes/assets/retry`, {
      method: 'POST',
      headers: { accept: 'application/json', 'x-video-factory-request': 'studio' },
    });
    const body = await response.json().catch(() => undefined);
    return { status: response.status, error: body?.error ?? undefined, runStatus: body?.status ?? undefined };
  }, RUN_ID);
  log(`  重试请求: ${JSON.stringify(result)}`);
  if (result.status !== 200) {
    log('  ✖ 重试请求未被接受，后续判据无法成立。');
  }
  await page.waitForTimeout(4_000);
  await shot(page, 'r21a-retry-requested');

  let state = null;
  for (let i = 0; i < 360; i += 1) {
    await page.waitForTimeout(15_000);
    const r = diskRun();
    if (i % 4 === 0) log(`    [${(i + 1) * 15}s] run=${r.status} revision=${r.revision}`);
    if (r.status !== 'running') { state = r; break; }
  }
  await shot(page, 'r21b-after-retry');

  const after = state ?? diskRun();
  const attemptAfter = latestAttempt('assets');
  const filesAfter = attemptAfter === attemptBefore
    ? filesBefore
    : sceneFiles(path.join(RUN_DIR, 'nodes/assets', attemptAfter));
  const pilotAfter = pilotEvidence();

  log('\n=== 复验后 ===');
  log(`  run=${after.status} revision=${after.revision}`);
  log(`  metered ¥${cost(after).toFixed(2)}｜收据 ${metered(after).length} 笔`);
  const delta = cost(after) - cost(before);
  log(`  ★ 实际付费增量 ¥${delta.toFixed(2)}（判据：必须为 0.00）`);
  log(`  授权 ${(after.spendAuthorizations ?? []).length} 笔｜已消耗 ${(after.consumedSpendAuthorizationIds ?? []).length} 份`);
  if (after.failure) log(`  failure: ${JSON.stringify(after.failure).slice(0, 500)}`);

  log(`\n  素材 attempt=${attemptBefore} -> ${attemptAfter}`);
  let changed = 0;
  for (let scene = 1; scene <= 7; scene += 1) {
    const pick = (files) => Object.entries(files).filter(([n]) => n.startsWith(`scene_0${scene}_`)).map(([n, h]) => `${n}:${h.slice(0, 8)}`).sort().join(',');
    const b = pick(filesBefore);
    const a = pick(filesAfter);
    if (b !== a) changed += 1;
    log(`  场景 ${scene}: ${b === a ? '未变' : '换新'}  ${b || '-'} -> ${a || '-'}`);
  }
  log(`  ★ 素材变动场景数 ${changed}（判据：0）`);

  log(`\n  试片证据: ${JSON.stringify(pilotBefore)} -> ${JSON.stringify(pilotAfter)}`);
  for (const [key, state2] of Object.entries(pilotAfter)) {
    const prev = pilotBefore[key] ?? { glm: false, gpt: false, report: false };
    log(`    ${key.slice(0, 8)}: glm ${prev.glm}->${state2.glm}｜gpt ${prev.gpt}->${state2.gpt}｜结论 ${prev.report}->${state2.report}`);
    if (state2.report && !prev.report) {
      const review = JSON.parse(readFileSync(path.join(RUN_DIR, 'asset-pilot-reviews', key, 'review.json'), 'utf8'));
      log(`      建议=${review.recommendation} 模型=${JSON.stringify((review.reviewScope?.actualModels ?? []).map((m) => m.modelId))}`);
    }
  }
  for (const n of after.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);
  for (const m of consoleMessages.filter((x) => x.type === 'error' || x.type === 'pageerror').slice(-8)) {
    log('  pageerror ' + m.text.slice(0, 250));
  }
  writeFileSync(`${ASSETS}/checks/step-r21-retry-pilot-review.txt`, lines.join('\n'));
});
