// R11 收尾轮 步骤 15：操作员采纳「镜头 4 蒸汽亮边」这条结论，并改这一镜的字幕/旁白。
//
// 操作员的判断依据（人眼看帧，不是猜）：review_media 的 09.875/10.750/11.625ms 三帧里，
// 明确可见的暖色亮边在**杯沿**上，蒸汽只是一缕很淡的虚影；而字幕写的是「蒸汽有了亮边」——
// 把亮边归给了蒸汽。这是真实的轻微过度承诺，所以采纳。
// 修法是改承诺而不是改画面：没有可复用的蒸汽镜头，且画面已付费。
// 预期花费 ¥0：配音 providers.voice=macos-say-v1（本地）、渲染本地 ffmpeg、复审走订阅。
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const RUN_DIR = process.env.QA_RUN_DIR
  ?? path.join(ASSETS, '../../../workspace/qa-r11-repair-20260914/runs', RUN_ID);

const NEW_NARRATION = '杯沿，亮着。';
const NOTE = '画面里明确的暖色亮边在杯沿，蒸汽只是一缕很淡的虚影；字幕却把亮边归给了蒸汽，'
  + '属于轻微的过度承诺。没有可复用的蒸汽镜头，画面也已付费，所以改承诺而不是改画面：'
  + '把这句写成画面确实给出的事实。';

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const diskRun = () => JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
const metered = (run) => (run.executionReceipts ?? []).filter((x) => x.billing === 'metered');
const cost = (run) => metered(run).reduce((s, x) => s + (x.actualCostCny ?? 0), 0);

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6_000);

  const before = diskRun();
  log('=== 返修前 ===');
  log(`  run=${before.status} revision=${before.revision}`);
  log(`  metered ¥${cost(before).toFixed(2)}｜收据 ${metered(before).length} 笔`
    + `｜授权 ${(before.spendAuthorizations ?? []).length} 笔`);

  // 只动「镜头 4」那一块里的旁白控件：镜头 2 的结论我不采纳，不改它的字。
  const block = page.locator('.scene-revision-finding').filter({ hasText: '镜头 4' }).first();
  await block.scrollIntoViewIfNeeded();
  await block.getByRole('button', { name: '改这一镜的字幕/旁白' }).click();
  await page.waitForTimeout(3_000);
  await shot(page, 'r15a-narration-editor-open');

  const field = block.getByLabel('镜头 4 的旁白字幕');
  const original = await field.inputValue();
  log(`\n  原文: ${JSON.stringify(original)}`);
  log(`  新文: ${JSON.stringify(NEW_NARRATION)}`);

  await field.fill(NEW_NARRATION);
  // 同一块里有三个 textarea：素材替换的「修改说明」、旁白正文、旁白的「这一镜的修改说明」。
  // 按序号取会写错框（第一次就写错了，narration 被说明文字覆盖、说明留空 → 提交按钮永远禁用），
  // 所以旁白正文按 aria-label 取，说明只在旁白控件内部取最后一个。
  const noteBox = block.locator('.scene-narration-revision textarea').last();
  await noteBox.fill(NOTE);
  await page.waitForTimeout(500);
  await shot(page, 'r15b-narration-filled');

  const submit = block.getByRole('button', { name: '按新文字重做配音与字幕' });
  log('  提交按钮 disabled=' + await submit.isDisabled());
  await submit.click();
  log('  已提交「按新文字重做配音与字幕」');

  // 配音→渲染→技术质检→审片→终审，等它跑完。上次补查约 2 分钟，这里给足余量。
  let state = null;
  for (let i = 0; i < 120; i += 1) {
    await page.waitForTimeout(15_000);
    const r = JSON.parse(readFileSync(path.join(RUN_DIR, 'run.json'), 'utf8'));
    if (i % 4 === 0) log(`    [${(i + 1) * 15}s] run=${r.status} revision=${r.revision}`);
    if (r.status !== 'running') { state = r; break; }
  }
  await shot(page, 'r15c-after-revision');

  const after = state ?? diskRun();
  log('\n=== 返修后 ===');
  log(`  run=${after.status} revision=${after.revision}`);
  log(`  metered ¥${cost(after).toFixed(2)}｜收据 ${metered(after).length} 笔`
    + `｜授权 ${(after.spendAuthorizations ?? []).length} 笔`);
  log(`  付费增量 ¥${(cost(after) - cost(before)).toFixed(2)}（应为 0：本地配音+本地渲染）`);
  for (const n of after.nodeRuns ?? []) log(`  node ${n.nodeId} = ${n.status}`);

  // 新的旁白是否真的落到了脚本产物上
  const attempts = readFileSync('/dev/null', 'utf8') ?? '';
  void attempts;
  const { execFileSync } = await import('node:child_process');
  const dirs = execFileSync('/bin/ls', [path.join(RUN_DIR, 'nodes/assets')]).toString().trim().split('\n');
  const latest = dirs.filter((d) => d.startsWith('attempt-')).sort().pop();
  const script = JSON.parse(readFileSync(path.join(RUN_DIR, 'nodes/assets', latest, 'executable_script.json'), 'utf8'));
  const scene4 = (script.scenes ?? []).find((s) => (s.scenePosition ?? s.position) === 4);
  log(`\n  最新脚本产物 ${latest} 镜头4 旁白: ${JSON.stringify(scene4?.narration)}`);

  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-8)) {
    log('  pageerror ' + m.text.slice(0, 250));
  }
  writeFileSync(`${ASSETS}/checks/step-r15-narration-revision.txt`, lines.join('\n'));
});
