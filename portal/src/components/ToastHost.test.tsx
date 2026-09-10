// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  newItems: [] as { id: string; kind: string; title: string; body: string; link: string | null; payload: Record<string, unknown> }[],
  dismissNew: vi.fn(), markRead: vi.fn(() => Promise.resolve()), local: [] as { id: number; message: string }[],
  dismissLocal: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({
  useNotifications: () => ctx,
  useLocalToasts: () => ({ toasts: ctx.local, dismiss: ctx.dismissLocal }),
}));
const api = vi.hoisted(() => ({ getReportRunDownloadUrl: vi.fn() }));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));

const { default: ToastHost } = await import('./ToastHost');
afterEach(() => { cleanup(); vi.clearAllMocks(); ctx.newItems = []; ctx.local = []; });

it('shows a Download toast for report_ready and marks it read on click', async () => {
  const user = userEvent.setup();
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/r1.pdf');
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  ctx.newItems = [{ id: 'n1', kind: 'report_ready', title: 'Move Report is ready', body: 'NAP11',
    link: '/reports?tab=history&run=r1', payload: { run_id: 'r1' } }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toContain('Move Report is ready');
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://spaces/r1.pdf', '_blank'));
  expect(ctx.markRead).toHaveBeenCalledWith('n1');
  expect(ctx.dismissNew).toHaveBeenCalledWith('n1');
});

it('leaves the toast in place when the download URL fetch fails', async () => {
  const user = userEvent.setup();
  api.getReportRunDownloadUrl.mockRejectedValue(new Error('boom'));
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  ctx.newItems = [{ id: 'n1', kind: 'report_ready', title: 'Move Report is ready', body: 'NAP11',
    link: '/reports?tab=history&run=r1', payload: { run_id: 'r1' } }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(api.getReportRunDownloadUrl).toHaveBeenCalledWith('r1'));
  expect(openSpy).not.toHaveBeenCalled();
  expect(ctx.markRead).not.toHaveBeenCalled();
  expect(ctx.dismissNew).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('Move Report is ready');
});

it('other kinds get an Open action; dismiss removes without marking read', async () => {
  const user = userEvent.setup();
  ctx.newItems = [{ id: 'n2', kind: 'report_failed', title: 'Move Report failed', body: 'x', link: '/reports', payload: {} }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(ctx.dismissNew).toHaveBeenCalledWith('n2');
  expect(ctx.markRead).not.toHaveBeenCalled();
});

it('renders local message toasts', () => {
  ctx.local = [{ id: 1, message: "We'll let you know when it's ready" }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByText("We'll let you know when it's ready")).toBeTruthy();
});
