// R11 接管轮 QA 浏览器驱动器：只读本地凭据文件完成正常登录，凭据不进入调用方上下文。
// 会话用 storageState 持久化，后续步骤脚本复用同一登录态。
import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 复用本机已缓存的 chromium-1234：固定用与之匹配的 playwright 版本，不新装浏览器。
export const playwright = require('/Users/jinkun.wang/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');

export const ROOT = '/Users/jinkun.wang/work_space/veidofactory';
export const ASSETS = path.join(ROOT, 'docs/qa/videofactory-real-local-qa-20260914-r11-takeover-assets');
export const BASE = process.env.QA_BASE_URL ?? 'http://127.0.0.1:4319';
export const STATE_PATH = path.join(ASSETS, 'harness/.storage-state.json');
const AUTH_ENV = path.join(ROOT, '.local/runtime/qa-auth-20260912.env');

function credentials() {
  const env = parseEnv(readFileSync(AUTH_ENV, 'utf8'));
  const username = env.VIDEO_FACTORY_AUTH_USERNAME;
  const password = env.QA_LOCAL_PASSWORD;
  if (!username || !password) throw new Error('local QA credentials are not configured');
  return { username, password };
}

// React 首屏先渲染 loading 再渲染登录面板/工作台，导航刚结束时的 evaluate 可能落在旧文档上；
// 先等两种终态之一出现，再判定登录态。
async function settleAuth(page) {
  await page.waitForFunction(
    () => document.querySelector('form.auth-form') !== null || document.querySelector('nav') !== null,
    undefined,
    { timeout: 30_000 },
  ).catch(() => {});
  await page.waitForTimeout(400);
  return await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    if (!response.ok) return false;
    const session = await response.json().catch(() => null);
    return session?.enabled === false || session?.authenticated === true;
  }).catch(() => false);
}

// 登录态失效时重新走一次页面登录；不打印任何凭据。
async function performLogin(page) {
  const { username, password } = credentials();
  const form = page.locator('form.auth-form');
  await form.waitFor({ state: 'visible', timeout: 20_000 });
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    const session = await response.json().catch(() => null);
    return session?.authenticated === true;
  }, undefined, { timeout: 20_000 }).catch(() => {});
}

export async function withSession(run, options = {}) {
  const browser = await playwright.chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 960 },
    locale: 'zh-CN',
    ...(options.mobile ? { hasTouch: true, isMobile: true } : {}),
    ...(existsSync(STATE_PATH) ? { storageState: STATE_PATH } : {}),
  });
  const page = await context.newPage();
  const consoleMessages = [];
  page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: String(error) }));
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    if (!(await settleAuth(page))) await performLogin(page);
    await context.storageState({ path: STATE_PATH });
    return await run({ page, context, consoleMessages });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function shot(page, name) {
  const file = path.join(ASSETS, 'screenshots', `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}
