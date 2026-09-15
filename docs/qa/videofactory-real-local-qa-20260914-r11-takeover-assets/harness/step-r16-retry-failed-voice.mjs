// R11 收尾轮 步骤 16：操作员按产品面板上唯一的恢复动作「重试失败步骤」重跑失败的 voice。
//
// 这是在**修好根因（joint 引用闭包不再丢掉方案引用的原稿）并修复落盘成员表之后**的一次受控复验，
// 不是盲目重试：复验依据是本次回归测试的 RED→GREEN 证据 + 修复前后成员表的逐 id 对照。
// 基线全部先记下来，用来核对：付费增量、已付费素材文件是否被动过（SHA256）、收据与授权笔数。
import { writeFileSync, readFileSync } from 'node:fs';
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
const nodeLine = (run) => (run.nodeRuns ?? []).map((n) => `${n.nodeId}=${n.status}`).join(' ');

// 已付费素材的文件指纹：这是"没有重新购买"的硬证据。
const mediaFingerprint = (run) => {
  const out = {};
  for (const artifact of run.artifacts) {
    if (artifact.kind !== 'media_asset' || !artifact.uri) continue;
    try {
      out[artifact.id] = createHash('sha256').update(readFileSync(artifact.uri)).digest('hex');
    } catch (error) {
      out[artifact.id] = `unreadable:${error.code ?? error.message}`;
    }
  }
  return out;
};

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8_000);

  const before = diskRun();
  const mediaBefore = mediaFingerprint(before);
  log('=== 复验前基线 ===');
  log(`  run=${before.status} revision=${before.revision}`);
  log(`  metered ¥${cost(before).toFixed(2)}｜收据 ${metered(before).length} 笔｜授权 ${(before.spendAuthorizations ?? []).length} 笔`);
  log(`  已付费素材 ${Object.keys(mediaBefore).length} 件`);
  for (const [id, sha] of Object.entries(mediaBefore)) log(`    ${id} ${sha.slice(0, 16)}…`);
  log(`  节点: ${nodeLine(before)}`);

  // 操作员看到的失败文案（原样记下来，作为"操作员看到的是这条报错"的证据）。
  const voiceCard = page.locator('[class*="failed"]').filter({ hasText: '配音' }).first();
  const voiceText = (await voiceCard.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  log(`\n  配音失败卡片文案: ${voiceText.slice(0, 500)}`);
  await shot(page, 'r16a-before-retry');

  const retry = page.getByRole('button', { name: '重试失败步骤' }).first();
  log(`\n  重试按钮 disabled=${await retry.isDisabled()}`);
  await retry.click();
  log('  已点击「重试失败步骤」');
  await page.waitForTimeout(4_000);
  await shot(page, 'r16b-after-retry-click');

  let state = null;
  for (let i = 0; i < 100; i += 1) {
    await page.waitForTimeout(15_000);
    const r = diskRun();
    if (i % 4 === 0 || r.status !== 'running') log(`    [${(i + 1) * 15}s] run=${r.status} rev=${r.revision} | ${nodeLine(r)}`);
    if (r.status !== 'running') { state = r; break; }
  }
  await shot(page, 'r16c-after-retry');

  const after = state ?? diskRun();
  const mediaAfter = mediaFingerprint(after);
  log('\n=== 复验后 ===');
  log(`  run=${after.status} revision=${after.revision}`);
  log(`  metered ¥${cost(after).toFixed(2)}｜收据 ${metered(after).length} 笔｜授权 ${(after.spendAuthorizations ?? []).length} 笔`);
  log(`  付费增量 ¥${(cost(after) - cost(before)).toFixed(2)}`);
  log(`  节点: ${nodeLine(after)}`);
  for (const node of after.nodeRuns ?? []) {
    if (node.error) log(`  ${node.nodeId} error: ${String(node.error).slice(0, 300)}`);
  }
  const unchanged = Object.keys(mediaBefore).length === Object.keys(mediaAfter).length
    && Object.entries(mediaBefore).every(([id, sha]) => mediaAfter[id] === sha);
  log(`  已付费素材 SHA256 全部未变: ${unchanged}`);
  for (const [id, sha] of Object.entries(mediaAfter)) {
    if (mediaBefore[id] !== sha) log(`    CHANGED ${id}: ${String(mediaBefore[id]).slice(0, 16)} -> ${sha.slice(0, 16)}`);
  }

  for (const m of consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror').slice(-8)) {
    log('  pageerror ' + m.text.slice(0, 250));
  }
  writeFileSync(`${ASSETS}/checks/step-r16-retry-failed-voice.txt`, lines.join('\n'));
});
