// R11 续轮步骤 R4：treatment 闸门第 2 次 repair 的操作员处置。
// 与 R3 的差别（重要）：R3 让模型"取消同期环境声"，但我没核对上游 —— 上游 brief.visualPlan.strategy
// 原文就写了"同期环境声"，等于让产物和上游对着干，于是第 2 次复核判 repair（score 76，宿主阻断项 0）。
// 本次改为：接受纯旁白方案（因渲染器只接旁白轨，A 分支不可实现），但要求在稿面上
// 显式记录这是对上游的已知偏离，而不是悄悄删掉上游要求。
// 只提交讨论，不确认、不购买。
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withSession, BASE, ASSETS } from './browser.mjs';

const RUN_ID = readFileSync(`${ASSETS}/checks/step-r1-run-id.txt`, 'utf8').trim();
const gate = JSON.parse(readFileSync(`${ASSETS}/checks/step-r2-gate-2.json`, 'utf8'));

const message = [
  '按独立复核的修复指令处理。复核给了二选一，我作为操作员明确选 B：接受"纯旁白与停顿"的声音方案，',
  '同时要求把"这是对上游输入的偏离"写在稿面上，而不是悄悄删掉上游要求。',
  '',
  '事实依据（已核实，不是推测）：',
  '1. 本片 providers.voice = macos-say-v1，只有旁白 TTS；currentRoleContract 已声明 musicTrack=false、soundEffectsTrack=false。',
  '2. 渲染器只把旁白音轨（或静音）接入成片，素材片源自带音频从不进入渲染。',
  '   因此复核给的 A 分支"保留并核验素材原始同期声"在当前流水线不可实现，不成立。',
  '',
  '请这样改（只改必要处，不要扩大范围）：',
  '1. 在 soundPrinciples 中保留"本片不产出可听的环境同期声，也不以另配的脚步、车流或街区音效冒充现场记录"的边界；',
  '2. 并在同一处明确写出：这是对上游 brief.visualPlan.strategy 中"同期环境声"一项的已知偏离，原因是流水线只支持旁白音轨。',
  '   偏离必须让读者在稿面上看得见，不能靠删除上游要求来消除冲突；',
  '3. 不得因此新增任何 external_required 依赖，也不得把该边界写成 factual_support；',
  '4. 其余 beat、观众承诺、视觉原则、事实边界保持不变。',
].join('\n');

const commandId = randomUUID();
const body = {
  action: 'discuss',
  commandId,
  expectedRunRevision: gate.runRevision,
  expectedReviewRevision: gate.reviewRevision,
  stage: gate.stage,
  baseDraftSha256: gate.draftSha256,
  message,
};

writeFileSync(`${ASSETS}/checks/step-r4-discuss-request.json`, JSON.stringify(body, null, 2));

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);

  const posted = await page.evaluate(async ({ runId, payload }) => {
    const response = await fetch(`/api/runs/${runId}/creative-review/commands`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-video-factory-request': 'studio',
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.text() };
  }, { runId: RUN_ID, payload: body });

  console.log('=== POST 状态 ===', posted.status);
  console.log(posted.body.slice(0, 600));
  writeFileSync(`${ASSETS}/checks/step-r4-discuss-response.json`, posted.body);

  if (posted.status !== 202) {
    console.log('=== 提交失败，未改稿 ===');
    return;
  }
  const receipt = JSON.parse(posted.body);
  console.log('=== 操作编号 ===', receipt.commandId, '状态:', receipt.status);

  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    const op = await page.evaluate(async ({ runId, id }) => {
      const r = await fetch(`/api/runs/${runId}/creative-review/commands/${id}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      return { status: r.status, body: await r.text() };
    }, { runId: RUN_ID, id: receipt.commandId });

    let parsed;
    try { parsed = JSON.parse(op.body); } catch { parsed = undefined; }
    const state = parsed?.status ?? `http-${op.status}`;
    console.log(`[${new Date().toISOString().slice(11, 19)}] 操作状态: ${state}`);
    writeFileSync(`${ASSETS}/checks/step-r4-discuss-operation.json`, op.body);

    if (state === 'completed' || state === 'failed' || state === 'unknown') {
      console.log('=== 终态 ===', state);
      break;
    }
    if (Date.now() > deadline) {
      console.log('=== 等待超时（20 分钟），保留现场 ===');
      break;
    }
    await page.waitForTimeout(15_000);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: `${ASSETS}/screenshots/r4-after-discuss.png` });
});
