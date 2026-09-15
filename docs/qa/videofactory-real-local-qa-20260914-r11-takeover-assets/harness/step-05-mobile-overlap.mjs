// 步骤 5：移动端固定底栏遮挡测量——滚到底后，最底部可交互元素是否仍被底栏覆盖。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(1_500);
  await shot(page, '05a-mobile-bottom-run');

  const probe = await page.evaluate(() => {
    const viewportHeight = window.innerHeight;
    const nav = document.querySelector('nav.mobile-nav');
    const navTop = nav ? nav.getBoundingClientRect().top : null;
    const items = [...document.querySelectorAll('button, a, input, textarea, select')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 30),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          visible: rect.width > 0 && rect.height > 0,
        };
      })
      .filter((item) => item.visible && item.top < viewportHeight && item.bottom > (navTop ?? viewportHeight))
      .slice(0, 15);
    return { viewportHeight, navTop: navTop === null ? null : Math.round(navTop), covering: items };
  });
  console.log(JSON.stringify(probe, null, 1));
}, { mobile: true, viewport: { width: 402, height: 874 } });
