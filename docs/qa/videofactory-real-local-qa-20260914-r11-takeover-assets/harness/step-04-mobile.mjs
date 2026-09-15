// 步骤 4：移动端布局检查（只读）。重点看 QA-R11R-09 记录的底部操作条是否遮挡发送区。
import { withSession, shot, BASE } from './browser.mjs';

const RUN_ID = 'run-a7c42cc4-98de-4354-9dc9-c268b68b1446';

await withSession(async ({ page }) => {
  await page.goto(`${BASE}/projects/${RUN_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000);
  await shot(page, '04a-mobile-run-top');

  // 底部操作条与页面底部元素的几何关系：真实测量，不靠目测。
  const geometry = await page.evaluate(() => {
    const viewportHeight = window.innerHeight;
    const fixed = [...document.querySelectorAll('body *')].filter((element) => {
      const style = getComputedStyle(element);
      return (style.position === 'fixed' || style.position === 'sticky')
        && element.getBoundingClientRect().height > 20
        && element.getBoundingClientRect().bottom > viewportHeight - 4;
    }).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        className: String(element.className).slice(0, 80),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
      };
    });
    const interactive = [...document.querySelectorAll('textarea, input, button')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName.toLowerCase(), text: (element.textContent ?? '').trim().slice(0, 24), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
      })
      .filter((item) => item.bottom > viewportHeight - 220)
      .slice(0, 12);
    return { viewportHeight, scrollHeight: document.documentElement.scrollHeight, fixed, interactive };
  });
  console.log(JSON.stringify(geometry, null, 1));

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(1_500);
  await shot(page, '04b-mobile-run-bottom');
}, { mobile: true, viewport: { width: 402, height: 874 } });
