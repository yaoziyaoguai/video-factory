// 步骤 15：通过产品自带的创作讨论通道，就"场5不该重新购买"提出一次有据的修改要求。
// 只勾选讨论范围"镜头 5"，不点"确认当前方案"，不产生任何购买。
import { writeFileSync } from 'node:fs';
import { withSession, BASE, shot, ASSETS } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-e204cd6c-2365-4cda-bb1d-c50e6e69bb8a';
const MESSAGE = [
  "场5不要重新购买。本次审片对场5的结论是 not_observed：源4688毫秒与6562毫秒两帧倒影形态接近，稀疏采样无法确认倒影是否呈可感知的缓慢移动；" ,
  "随返工带入的画面素材指令原文是「先补查已有素材，不进入新购买」「先调看该镜头源4.5秒至结尾的完整片段核实倒影移动；确认缺失后再决定是否更换素材，不要据此直接重买」，" ,
  "而且上一版场5母片已经物化，不得重复购买。请把场5改回沿用已有母片，并在方案中写明先调看完整片段核实倒影移动；只有核实确认真实缺失时才更换素材。" ,
  "场1至场4按当前方案保持不变，不要改动，也不要改旁白、时长和字幕安全区。",
].join("");

await withSession(async ({ page, consoleMessages }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);

  const before = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return await r.json();
  }, `/api/runs/${RUN_ID}/creative-review`);
  console.log('=== before: reviewRevision', before.reviewRevision, 'phase', before.phase);

  // 只把讨论范围限定到场5，避免导演顺手改动场1至场4。
  const scope = page.locator('.creative-selection label', { hasText: '镜头 5' }).locator('input[type="checkbox"]');
  await scope.waitFor({ state: 'visible', timeout: 20_000 });
  if (!(await scope.isChecked())) await scope.check();
  console.log('=== scope 镜头5 checked ===', await scope.isChecked());

  await page.locator('.creative-composer textarea').fill(MESSAGE);
  console.log('=== message typed, length ===', MESSAGE.length);
  await shot(page, '15a-change-request-typed');

  await page.getByRole('button', { name: '发送' }).click();
  console.log('=== sent; waiting for new revision ===');

  await page.waitForFunction(async (t, prev) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) return false;
    const j = await r.json();
    return j.phase !== 'checking' && j.reviewRevision > prev;
  }, `/api/runs/${RUN_ID}/creative-review`, before.reviewRevision, { timeout: 600_000 });

  await page.waitForTimeout(3_000);
  console.log('=== screenshot ===', await shot(page, '15b-after-change-request'));

  const after = await page.evaluate(async (t) => {
    const r = await fetch(t, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: await r.text() };
  }, `/api/runs/${RUN_ID}/creative-review`);
  writeFileSync(`${ASSETS}/checks/step-15-after-change-request.json`, after.body);
  const j = JSON.parse(after.body);
  console.log('=== after: reviewRevision', j.reviewRevision, 'phase', j.phase, '=== allowedActions', JSON.stringify(j.allowedActions));

  let total = 0;
  for (const sh of j.draft?.shots ?? []) {
    total += sh.estimatedCostCny ?? 0;
    console.log(JSON.stringify({
      scene: sh.scenePosition,
      delivery: sh.deliveryType,
      provider: sh.preferredProviderId,
      reuseFrom: sh.reuseFromScenePosition ?? null,
      est: sh.estimatedCostCny,
      query: sh.query,
    }));
  }
  console.log('=== TOTAL estimatedCostCny ===', total);

  const scene5 = (j.draft?.shots ?? []).find((s) => s.scenePosition === 5);
  if (scene5) {
    console.log('=== scene5 criteria ===');
    for (const c of scene5.successCriteria ?? []) console.log('  ✓', c);
    for (const c of scene5.negativeConstraints ?? []) console.log('  ✗', c);
    console.log('  rationale:', scene5.rationale);
  }
  const lastAssistant = [...(j.messages ?? [])].reverse().find((m) => m.role === 'assistant');
  console.log('=== director reply ===', String(lastAssistant?.text ?? '').slice(0, 1200));

  const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
  console.log('=== console errors ===', errors.length);
});
