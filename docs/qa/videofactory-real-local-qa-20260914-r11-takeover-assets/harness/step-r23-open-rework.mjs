// R11 收尾轮 步骤 23：打开「调整方案后重新制作」面板，只做勘察，不提交。
//
// 为什么先勘察：提交会创建返工 run，并触发导演方案重规划（付费）。在看清表单实际会提交
// 什么之前不该按下提交键——步骤 23 只看，步骤 24 才决定。
//
// 明确不做的事：不点「重新检查已有试片」。那是在同一批帧上重跑审片，靠模型随机性换一个
// 结论属于"刷成功"，是被明令禁止的。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.env.QA_RUN_ID ?? 'run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08';
const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/runs/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);

  // 先把 rejected 终态下真实存在的按钮全列出来，而不是凭代码猜哪个在渲染。
  const actions = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => ({ label: b.textContent.trim().slice(0, 40), disabled: b.disabled })));
  log('=== run 页可见按钮 ===');
  for (const a of actions) log(`  [${a.disabled ? 'x' : ' '}] ${a.label}`);

  const target = page.getByRole('button', { name: '调整方案后重新制作' });
  if ((await target.count()) === 0) {
    log('\n✖ 未找到「调整方案后重新制作」按钮，停止（不做任何替代尝试）。');
    await shot(page, 'r23-no-rework-button');
    writeFileSync(`${ASSETS}/checks/step-r23-open-rework.txt`, lines.join('\n'));
    return;
  }

  await target.first().click();
  await page.waitForTimeout(6_000);
  await shot(page, 'r23-rework-panel');

  const fields = await page.evaluate(() => [...document.querySelectorAll('input, textarea, select')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      name: el.getAttribute('name') ?? el.id ?? '',
      type: el.getAttribute('type') ?? '',
      value: String(el.value ?? '').slice(0, 60),
    })));
  log(`\n=== 面板可见字段 ${fields.length} 个 ===`);
  for (const f of fields) log(`  ${f.tag}[${f.type}] ${f.name} = ${JSON.stringify(f.value)}`);

  const panelButtons = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => b.offsetParent !== null)
    .map((b) => b.textContent.trim().slice(0, 40)));
  log(`\n=== 点击后可见按钮 ===`);
  for (const b of panelButtons) log(`  ${b}`);

  log('\n（本步未提交任何表单。）');
  writeFileSync(`${ASSETS}/checks/step-r23-open-rework.txt`, lines.join('\n'));
});
