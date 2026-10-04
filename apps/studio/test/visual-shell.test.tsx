import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from '../src/client/components/AppShell.js';
import { studioApi } from '../src/client/api.js';

afterEach(() => vi.restoreAllMocks());

it('shows the current workspace without changing navigation or loading business data', async () => {
  vi.spyOn(studioApi, 'health').mockResolvedValue({ status: 'ok', runtime: {} });
  const runs = vi.spyOn(studioApi, 'runs');
  render(<MemoryRouter initialEntries={['/projects/a-film']}><AppShell><main>稿件正文</main></AppShell></MemoryRouter>);
  expect(screen.getByLabelText('当前工作区')).toHaveTextContent('作品工作区');
  const nav = within(screen.getByRole('navigation', { name: '主导航' }));
  expect(nav.getAllByRole('link')).toHaveLength(6);
  expect(nav.getByRole('link', { name: '制作记录' })).toHaveAttribute('href', '/projects');
  await waitFor(() => expect(screen.getByText('制作服务就绪')).toBeInTheDocument());
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
