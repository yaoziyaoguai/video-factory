// 步骤 7：复现 QA-R11R-09——390×844 手机端“讨论”发送按钮是否被底部 sticky 动作条遮挡。
// 只做几何测量与 elementFromPoint 命中判定，不输入草稿、不发送、不触发任何模型请求。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = process.argv[2] ?? 'run-6083f24f-bc98-4fb5-81f2-2aeb3954e285';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  await shot(page, '07a-discussion-mobile-top');

  // 切到“讨论”标签（若存在），不填写任何内容。
  const tab = page.locator('.creative-mobile-tabs button', { hasText: '讨论' });
  if (await tab.count()) {
    await tab.first().click({ timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
  }
  // 关键场景：发送按钮进入视口时，能否被真实点击（原缺陷是 sticky 的“撤销本轮修改”压在其中心）。
  await page.evaluate(() => {
    const send = [...document.querySelectorAll('button')]
      .filter((element) => /发送/.test(element.textContent ?? ''))
      .find((element) => element.getBoundingClientRect().width > 0);
    send?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(1_200);
  await shot(page, '07b-discussion-mobile-scrolled');

  const probe = await page.evaluate(() => {
    const round = (value) => Math.round(value * 1000) / 1000;
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) };
    };
    // 只取真正可见的发送按钮：手机端桌面面板是 display:none，0×0 的按钮不构成“可点击发送”。
    const send = [...document.querySelectorAll('button')]
      .filter((element) => /发送/.test(element.textContent ?? ''))
      .find((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)
      ?? [...document.querySelectorAll('button')].find((element) => /发送/.test(element.textContent ?? ''));
    if (!send) return { found: false, buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim().slice(0, 12)).filter(Boolean).slice(0, 30) };

    const rect = send.getBoundingClientRect();
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);

    // 命中的遮挡者：向上找到第一个不是自身祖先链上的元素
    let blocker = hit;
    const chain = [];
    while (blocker) {
      chain.push({ tag: blocker.tagName.toLowerCase(), className: String(blocker.className ?? '').slice(0, 70), rect: rectOf(blocker) });
      blocker = blocker.parentElement;
    }
    const anchors = [];
    for (let node = send; node; node = node.parentElement) anchors.push(node);
    const blocked = hit !== null && hit !== send && !send.contains(hit) && !anchors.includes(hit);

    const sticky = [...document.querySelectorAll('body *')].filter((element) => {
      const style = getComputedStyle(element);
      const own = element.getBoundingClientRect();
      return (style.position === 'fixed' || style.position === 'sticky') && own.height > 20;
    }).map((element) => ({
      className: String(element.className ?? '').slice(0, 70),
      position: getComputedStyle(element).position,
      zIndex: getComputedStyle(element).zIndex,
      bottom: getComputedStyle(element).bottom,
      rect: rectOf(element),
      text: (element.textContent ?? '').trim().slice(0, 24),
    }));

    return {
      found: true,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      send: rectOf(send),
      sendCenter: { x: round(centerX), y: round(centerY) },
      hit: hit ? { tag: hit.tagName.toLowerCase(), className: String(hit.className ?? '').slice(0, 70), text: (hit.textContent ?? '').trim().slice(0, 24) } : null,
      blocked,
      chain,
      sticky,
    };
  });
  console.log(JSON.stringify(probe, null, 1));
  console.log('=== verdict ===');
  console.log(JSON.stringify({ runId: RUN_ID, sendBlocked: probe.blocked === true, hitText: probe.hit?.text ?? null }));
}, { mobile: true, viewport: { width: 390, height: 844 } });
