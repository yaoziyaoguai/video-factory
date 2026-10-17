import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from '../src/client/components/AppShell.js';
import { studioApi } from '../src/client/api.js';
import { useDialogFocus } from '../src/client/hooks/useDialogFocus.js';
import { initializeStudioAppearance } from '../src/client/studio-appearance.js';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem('videofactory.studio.appearance');
  delete document.documentElement.dataset.appearance;
});

function mockSearchSources() {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  vi.spyOn(studioApi, 'runs').mockResolvedValue([]);
  vi.spyOn(studioApi, 'opportunities').mockResolvedValue([]);
}

it('shows the current workspace without changing navigation or loading business data', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const runs = vi.spyOn(studioApi, 'runs');
  render(<MemoryRouter initialEntries={['/projects/a-film']}><AppShell><main>稿件正文</main></AppShell></MemoryRouter>);
  expect(screen.getByLabelText('当前工作区')).toHaveTextContent('作品工作区');
  const nav = within(screen.getByRole('navigation', { name: '主导航' }));
  expect(nav.getAllByRole('link')).toHaveLength(5);
  expect(nav.getByRole('link', { name: '制作记录' })).toHaveAttribute('href', '/projects');
  await waitFor(() => expect(screen.getByRole('status', { name: '基础工具检查' })).toHaveTextContent('基础工具可用'));
  expect(screen.getAllByRole('status', { name: '基础工具检查' })).toHaveLength(1);
  expect(screen.getByRole('status', { name: '基础工具检查' })).toHaveAttribute('title', expect.stringContaining('不代表模型、配音与成片合成能力可用'));
  expect(screen.getByLabelText('当前工作区')).not.toContainElement(screen.getByRole('status', { name: '基础工具检查' }));
  expect(runs).not.toHaveBeenCalled();
});

it('keeps global search keyboard-accessible and returns focus to its trigger', async () => {
  mockSearchSources();
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/assets']}><AppShell><main>素材内容</main></AppShell></MemoryRouter>);
  expect(screen.getByLabelText('当前工作区')).toHaveTextContent('素材库');
  const trigger = screen.getByRole('button', { name: '搜索项目、选题或功能' });
  trigger.focus();
  await user.keyboard('{Enter}');
  const search = screen.getByRole('combobox', { name: '搜索项目、选题或功能' });
  await waitFor(() => expect(search).toHaveFocus());
  await user.type(search, '素材');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '搜索项目、选题或功能' })).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('uses one responsive navigation and one account entry without losing secondary destinations', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const onLogout = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/experiments']}><AppShell username="创作者" onLogout={onLogout}><main>制作复盘正文</main></AppShell></MemoryRouter>);

  expect(screen.getAllByRole('navigation')).toHaveLength(1);
  const nav = within(screen.getByRole('navigation', { name: '主导航' }));
  expect(nav.getAllByRole('link')).toHaveLength(5);
  expect(nav.getByRole('link', { name: '制作复盘' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getAllByRole('link', { name: 'VideoFactory 创作台' })).toHaveLength(1);
  expect(within(screen.getByRole('banner')).getAllByRole('button', { name: '打开创作向导' })).toHaveLength(1);
  expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute('href', '#main-content');

  await user.click(screen.getByRole('button', { name: '账号菜单：创作者' }));
  expect(onLogout).not.toHaveBeenCalled();
  await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
  await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
});

it('makes all five destinations directly reachable and moves focus to the selected workspace', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell><main>当前页面<button>正文操作</button></main></AppShell></MemoryRouter>);
  const nav = within(screen.getByRole('navigation', { name: '主导航' }));
  expect(nav.getAllByRole('link')).toHaveLength(5);
  for (const label of ['创作设置', '制作复盘']) {
    const link = nav.getByRole('link', { name: label });
    link.focus();
    await user.keyboard('{Enter}');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('当前工作区')).toHaveTextContent(label);
    expect(document.getElementById('main-content')).toHaveFocus();
  }
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

it('navigates command results with arrows and Enter, then focuses the destination content', async () => {
  mockSearchSources();
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell><main>当前页面<button>正文操作</button></main></AppShell></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '搜索项目、选题或功能' }));
  const search = screen.getByRole('combobox', { name: '搜索项目、选题或功能' });
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('option', { name: /创作台/ })).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{ArrowUp}');
  expect(screen.getByRole('option', { name: /声音演员与配音设置/ })).toHaveAttribute('aria-selected', 'true');
  await user.type(search, '素材库');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByLabelText('当前工作区')).toHaveTextContent('素材库');
  await waitFor(() => expect(document.getElementById('main-content')).toHaveFocus());
});

it('opens one command dialog with a shortcut and preserves the original input on cancellation', async () => {
  mockSearchSources();
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell><main><label>未发送意见<textarea /></label></main></AppShell></MemoryRouter>);
  const draft = screen.getByRole('textbox', { name: '未发送意见' });
  await user.type(draft, '保留这一句');
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(draft).toHaveFocus());
  expect(screen.getByRole('textbox', { name: '未发送意见' })).toBe(draft);
  expect(draft).toHaveValue('保留这一句');
});

it('lets an existing body dialog own shortcuts, Escape, and return focus', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const runs = vi.spyOn(studioApi, 'runs');
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
  const bodyTrigger = screen.getByRole('button', { name: '正文确认操作' });
  await user.click(bodyTrigger);
  expect(screen.getByRole('textbox', { name: '确认意见' })).toHaveFocus();
  await user.keyboard('{Control>}k{/Control}');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.queryByRole('dialog', { name: '搜索项目、选题或功能' })).not.toBeInTheDocument();
  expect(runs).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '正文确认窗口' })).not.toBeInTheDocument();
  expect(bodyTrigger).toHaveFocus();
});

it('restores the chosen appearance and changes it without remounting unsent input', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const runs = vi.spyOn(studioApi, 'runs');
  localStorage.setItem('videofactory.studio.appearance', 'dark');
  expect(initializeStudioAppearance()).toBe('dark');
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell><main><label>未发送意见<textarea /></label></main></AppShell></MemoryRouter>);
  expect(screen.getByRole('button', { name: '暗房外观' })).toHaveAttribute('aria-pressed', 'true');
  const draft = screen.getByRole('textbox', { name: '未发送意见' });
  await user.type(draft, '切换后继续写');
  await user.click(screen.getByRole('button', { name: '日光外观' }));
  expect(document.documentElement).toHaveAttribute('data-appearance', 'light');
  expect(localStorage.getItem('videofactory.studio.appearance')).toBe('light');
  expect(screen.getByRole('textbox', { name: '未发送意见' })).toBe(draft);
  expect(draft).toHaveValue('切换后继续写');
  expect(runs).not.toHaveBeenCalled();
});

it('still changes appearance when browser storage is unavailable', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage is disabled', 'SecurityError'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage is disabled', 'SecurityError'); });
  expect(initializeStudioAppearance()).toBe('light');
  const user = userEvent.setup();
  render(<MemoryRouter><AppShell><main>当前页面</main></AppShell></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: '暗房外观' }));
  expect(document.documentElement).toHaveAttribute('data-appearance', 'dark');
  expect(screen.getByRole('button', { name: '暗房外观' })).toHaveAttribute('aria-pressed', 'true');
});
