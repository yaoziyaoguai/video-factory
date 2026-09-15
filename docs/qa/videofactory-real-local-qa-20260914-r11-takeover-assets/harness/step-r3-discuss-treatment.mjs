// R11 续轮步骤 R3：以操作员身份在 treatment 闸门提交 discuss 决定。
// 这不是新增流程，而是使用闸门已有的 discuss 动作（creative-review.ts:88）。
// 决策依据：审计 repair(74) 的修复指令 + 指令第 173 行（边界声明不得升级为外部来源要求）。
// 决定内容：本片不承诺同期环境声，把该条从 evidenceRequirements 降级回 soundPrinciples。
// 只提交讨论，不确认、不购买。
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withSession, BASE, ASSETS } from './browser.mjs';

const RUN_ID = readFileSync(`${ASSETS}/checks/step-r1-run-id.txt`, 'utf8').trim();
const gate = JSON.parse(readFileSync(`${ASSETS}/checks/step-r2-gate-2.json`, 'utf8'));

const message = [
  '按独立复核的修复指令处理这条阻断项。我作为操作员决定：本片不承诺使用同期环境声。',
  '',
  '理由：这条内容是创作边界声明（不拿别处的音效冒充现场记录），按角色指令它属于 soundPrinciples，',
  '不是 factual_support，也不应升级成 external_required 的核心依赖。流水线确实无法取得可核验的对应原片同期声。',
  '',
  '请这样改：',
  '1. 删除 evidenceRequirements 中 beatId=half_pause、claim 以「若画面中的脚步、车流或街区声被呈现为同期声」开头的那一条；',
  '2. 把「不虚构可听见的环境声」的边界并入 soundPrinciples，明确本片声音只用旁白与停顿节奏，不出现可听的环境同期声；',
  '3. 保留其余 beat、观众承诺、事实边界与已合格的声音原则不变，不要扩大改动范围。',
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

writeFileSync(`${ASSETS}/checks/step-r3-discuss-request.json`, JSON.stringify(body, null, 2));

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
  writeFileSync(`${ASSETS}/checks/step-r3-discuss-response.json`, posted.body);

  if (posted.status !== 202) {
    console.log('=== 提交失败，未改稿 ===');
    return;
  }
  const receipt = JSON.parse(posted.body);
  console.log('=== 操作编号 ===', receipt.commandId, '状态:', receipt.status);

  // 等模型返回修订稿：轮询同一操作的状态。
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
    writeFileSync(`${ASSETS}/checks/step-r3-discuss-operation.json`, op.body);

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
  await page.screenshot({ path: `${ASSETS}/screenshots/r3-after-discuss.png` });
});
