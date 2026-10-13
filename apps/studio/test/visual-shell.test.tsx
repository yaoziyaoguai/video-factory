import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from '../src/client/components/AppShell.js';
import { studioApi } from '../src/client/api.js';
import { useDialogFocus } from '../src/client/hooks/useDialogFocus.js';

afterEach(() => vi.restoreAllMocks());

it('shows the current workspace without changing navigation or loading business data', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const runs = vi.spyOn(studioApi, 'runs');
  render(<MemoryRouter initialEntries={['/projects/a-film']}><AppShell><main>稿件正文</main></AppShell></MemoryRouter>);
  expect(screen.getByLabelText('当前工作区')).toHaveTextContent('作品工作区');
  const nav = within(screen.getByRole('navigation', { name: '主导航' }));
  expect(nav.getAllByRole('link')).toHaveLength(6);
  expect(nav.getByRole('link', { name: '制作记录' })).toHaveAttribute('href', '/projects');
  await waitFor(() => expect(screen.getByRole('status', { name: '基础工具检查' })).toHaveTextContent('基础工具可用'));
  expect(screen.getAllByRole('status', { name: '基础工具检查' })).toHaveLength(1);
  expect(screen.getByRole('status', { name: '基础工具检查' })).toHaveAttribute('title', expect.stringContaining('不代表模型、配音与成片合成能力可用'));
  expect(screen.getByLabelText('当前工作区')).not.toContainElement(screen.getByRole('status', { name: '基础工具检查' }));
  expect(runs).not.toHaveBeenCalled();
});

it('keeps global search keyboard-accessible from the quiet navigation shell', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  vi.spyOn(studioApi, 'runs').mockResolvedValue([]);
  vi.spyOn(studioApi, 'opportunities').mockResolvedValue([]);
  vi.spyOn(studioApi, 'templates').mockResolvedValue({ templates: [], storeRevision: 0 });
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/assets']}><AppShell><main>素材内容</main></AppShell></MemoryRouter>);
  expect(screen.getByLabelText('当前工作区')).toHaveTextContent('素材库');
  const trigger = screen.getByRole('button', { name: '搜索项目、选题、模板或功能' });
  trigger.focus();
  await user.keyboard('{Enter}');
  await user.type(screen.getByRole('textbox', { name: '搜索项目、选题、模板或功能' }), '素材');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '搜索项目、选题、模板或功能' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('uses one responsive navigation and one account entry without losing secondary destinations', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const onLogout = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/experiments']}><AppShell username="创作者" onLogout={onLogout}><main>制作复盘正文</main></AppShell></MemoryRouter>);

  expect(screen.getAllByRole('navigation')).toHaveLength(1);
  const nav = within(screen.getByRole('navigation', { name: '主导航' }));
  expect(nav.getAllByRole('link')).toHaveLength(6);
  expect(nav.getByRole('link', { name: '制作复盘' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getAllByRole('link', { name: 'VideoFactory 创作台' })).toHaveLength(1);
  expect(within(screen.getByRole('banner')).getAllByRole('button', { name: '打开创作向导' })).toHaveLength(1);
  expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content');

  await user.click(screen.getByRole('button', { name: '账号菜单：创作者' }));
  expect(onLogout).not.toHaveBeenCalled();
  await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
  await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
});

it('keeps secondary destinations in the same navigation and closes more after a choice or Escape', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell><main>当前页面</main></AppShell></MemoryRouter>);
  const more = screen.getByRole('button', { name: '更多页面' });
  expect(more).toHaveAttribute('aria-expanded', 'false');
  await user.click(more);
  expect(more).toHaveAttribute('aria-expanded', 'true');
  await user.click(screen.getByRole('link', { name: '创作设置' }));
  expect(screen.getByLabelText('当前工作区')).toHaveTextContent('创作设置');
  expect(more).toHaveAttribute('aria-expanded', 'false');
  await user.click(more);
  screen.getByRole('link', { name: '模板资料' }).focus();
  await user.keyboard('{Escape}');
  expect(more).toHaveAttribute('aria-expanded', 'false');
  expect(more).toHaveFocus();
  expect(within(screen.getByRole('navigation', { name: '主导航' })).getAllByRole('link')).toHaveLength(6);
});

it('does not show a ready service indicator while the health request is unresolved', () => {
  vi.spyOn(studioApi, 'health').mockReturnValue(new Promise(() => undefined));
  render(<MemoryRouter><AppShell><main>当前页面</main></AppShell></MemoryRouter>);
  expect(screen.getAllByRole('status', { name: '基础工具检查' })).toHaveLength(1);
  expect(screen.getByRole('status', { name: '基础工具检查' })).toHaveTextContent('检查基础工具');
  expect(screen.queryByText('基础工具可用')).not.toBeInTheDocument();
  expect(screen.getByText('检查基础工具').previousElementSibling).toHaveClass('health-checking');
});

it('keeps an unavailable basic-tool state distinct from a production capability result', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'degraded', runtime: {} });
  render(<MemoryRouter><AppShell><main>当前页面</main></AppShell></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('status', { name: '基础工具检查' })).toHaveTextContent('基础工具需检查'));
  expect(screen.getAllByRole('status', { name: '基础工具检查' })).toHaveLength(1);
  expect(screen.queryByText('基础工具可用')).not.toBeInTheDocument();
  expect(screen.getByText('基础工具需检查').previousElementSibling).toHaveClass('health-down');
});

it('closes more before opening search so Escape restores the search trigger instead of navigation', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  vi.spyOn(studioApi, 'runs').mockResolvedValue([]);
  vi.spyOn(studioApi, 'opportunities').mockResolvedValue([]);
  vi.spyOn(studioApi, 'templates').mockResolvedValue({ templates: [], storeRevision: 0 });
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell username="创作者" onLogout={vi.fn()}><main>当前页面</main></AppShell></MemoryRouter>);
  const more = screen.getByRole('button', { name: '更多页面' });
  const search = screen.getByRole('button', { name: '搜索项目、选题、模板或功能' });
  await user.click(more);
  await user.click(search);
  expect(more).toHaveAttribute('aria-expanded', 'false');
  await user.keyboard('{Escape}');
  expect(search).toHaveFocus();
  await user.click(more);
  const account = screen.getByRole('button', { name: '账号菜单：创作者' });
  await user.click(account);
  expect(more).toHaveAttribute('aria-expanded', 'false');
  await user.keyboard('{Escape}');
  expect(account).toHaveFocus();
  expect(screen.queryByRole('menu', { name: '账号菜单' })).not.toBeInTheDocument();
});

it('dismisses more when focus enters a body dialog and lets that dialog own Escape and return focus', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  function BodyDialog() {
    const [open, setOpen] = useState(false);
    const dialogRef = useDialogFocus<HTMLElement>(open, () => setOpen(false));
    return <main>
      <button type="button" onClick={() => setOpen(true)}>正文确认操作</button>
      {open ? <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="正文确认窗口">
        <label>确认意见<input /></label>
        <button type="button" onClick={() => setOpen(false)}>取消</button>
      </section> : null}
    </main>;
  }
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell><BodyDialog /></AppShell></MemoryRouter>);
  const more = screen.getByRole('button', { name: '更多页面' });
  const bodyTrigger = screen.getByRole('button', { name: '正文确认操作' });
  await user.click(more);
  expect(more).toHaveAttribute('aria-expanded', 'true');
  await user.click(bodyTrigger);
  expect(more).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('textbox', { name: '确认意见' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '正文确认窗口' })).not.toBeInTheDocument();
  expect(bodyTrigger).toHaveFocus();
});
