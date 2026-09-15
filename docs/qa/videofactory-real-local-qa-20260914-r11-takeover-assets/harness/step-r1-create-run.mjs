// R11 续轮步骤 R1：用当前代码新建一条真实制作，走完整端到端链路。
// 简报模板取自上一轮主片的 initialInput（同题材重启同一条产线，不换题），只替换幂等键。
// 只创建 run，不授权、不购买。
import { writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { withSession, BASE, ASSETS, ROOT } from './browser.mjs';

const TEMPLATE_RUN = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';
// 只取简报本身。rework / taskContractDigests 是源 run 的派生状态，不是简报内容：
// run-a7c42cc4 自己是一条返工 run，整体复制会把它的 rework 血缘一并带过来，
// 造出"返工的返工"——treatment/script 会按返工规则被继承，跳过两道人工闸门。
// creationContext 只保留来源标记，不带机会编号以外的继承。
const source = JSON.parse(readFileSync(
  path.join(ROOT, 'workspace/qa-r11-repair-20260914/runs', TEMPLATE_RUN, 'run.json'),
  'utf8',
)).initialInput;
const { rework, taskContractDigests, creationContext, ...template } = source;
void rework;
void taskContractDigests;
void creationContext;

const idempotencyKey = `qa-r11-fresh-${randomUUID()}`;
writeFileSync(`${ASSETS}/checks/step-r1-idempotency-key.txt`, idempotencyKey);

await withSession(async ({ page }) => {
  const created = await page.evaluate(async ({ brief, key }) => {
    const response = await fetch('/api/runs', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        'x-video-factory-request': 'studio',
      },
      body: JSON.stringify(brief),
    });
    return { status: response.status, body: await response.text() };
  }, { brief: template, key: idempotencyKey });

  writeFileSync(`${ASSETS}/checks/step-r1-create-response.json`, created.body);
  console.log('=== POST /api/runs status ===', created.status);
  console.log(created.body.slice(0, 800));

  if (created.status !== 202) {
    console.log('=== 创建失败，未创建任何制作 ===');
    return;
  }
  const { runId } = JSON.parse(created.body);
  writeFileSync(`${ASSETS}/checks/step-r1-run-id.txt`, runId);
  console.log('=== 新制作编号 ===', runId);

  await page.goto(`${BASE}/projects/${runId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: `${ASSETS}/screenshots/r1-new-run.png` });
  console.log('=== 首屏可见文本 ===');
  console.log((await page.locator('body').innerText()).slice(0, 1200));
});
