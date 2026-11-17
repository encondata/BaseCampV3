// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  newItems: [] as { id: string; kind: string; title: string; body: string; link: string | null; payload: Record<string, unknown> }[],
  dismissNew: vi.fn(), markRead: vi.fn(() => Promise.resolve()), refresh: vi.fn(() => Promise.resolve()), local: [] as { id: number; message: string; action?: { label: string; onClick: () => void } }[],
  dismissLocal: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({
  useNotifications: () => ctx,
  useLocalToasts: () => ({ toasts: ctx.local, dismiss: ctx.dismissLocal }),
}));
const api = vi.hoisted(() => ({
  getReportRunDownloadUrl: vi.fn(), clearAddressBlock: vi.fn(() => Promise.resolve({})),
  blockAddressPermanently: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));

vi.mock('../lib/inboxLinks', async (importActual) => ({
  ...(await importActual<typeof import('../lib/inboxLinks')>()),
  leaveFor: vi.fn(),
}));
const { leaveFor } = await import('../lib/inboxLinks');

const { default: ToastHost, INBOX_TOAST_MS } = await import('./ToastHost');
afterEach(() => { cleanup(); vi.clearAllMocks(); ctx.newItems = []; ctx.local = []; });

it('shows a Download toast for report_ready and marks it read on click', async () => {
  const user = userEvent.setup();
  api.getReportRunDownloadUrl.mockResolvedValue('https://spaces/r1.pdf');
  const tab = { location: { href: '' }, close: vi.fn() };
  const openSpy = vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
  ctx.newItems = [{ id: 'n1', kind: 'report_ready', title: 'Move Report is ready', body: 'NAP11',
    link: '/reports?tab=history&run=r1', payload: { run_id: 'r1' } }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toContain('Move Report is ready');
  await user.click(screen.getByRole('button', { name: 'Download' }));
  // the tab is claimed synchronously, then pointed at the presigned URL
  expect(openSpy).toHaveBeenCalledWith('', '_blank');
  await waitFor(() => expect(tab.location.href).toBe('https://spaces/r1.pdf'));
  expect(ctx.markRead).toHaveBeenCalledWith('n1');
  expect(ctx.dismissNew).toHaveBeenCalledWith('n1');
});

it('leaves the toast in place when the download URL fetch fails', async () => {
  const user = userEvent.setup();
  api.getReportRunDownloadUrl.mockRejectedValue(new Error('boom'));
  const tab = { location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
  ctx.newItems = [{ id: 'n1', kind: 'report_ready', title: 'Move Report is ready', body: 'NAP11',
    link: '/reports?tab=history&run=r1', payload: { run_id: 'r1' } }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Download' }));
  await waitFor(() => expect(api.getReportRunDownloadUrl).toHaveBeenCalledWith('r1'));
  await waitFor(() => expect(tab.close).toHaveBeenCalled());   // blank tab cleaned up
  expect(tab.location.href).toBe('');
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

it('Open navigates in-app by default, or hands the link to openLink when given', async () => {
  const user = userEvent.setup();
  ctx.newItems = [{ id: 'n4', kind: 'report_failed', title: 'Move Report failed', body: 'x', link: '/reports', payload: {} }];
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ToastHost />} />
        <Route path="/reports" element={<div>reports page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByText('reports page')).toBeTruthy();
  expect(ctx.markRead).toHaveBeenCalledWith('n4');
  cleanup();

  const openLink = vi.fn();
  render(<MemoryRouter><ToastHost openLink={openLink} /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Open' }));
  expect(openLink).toHaveBeenCalledWith('/reports');
  expect(ctx.dismissNew).toHaveBeenCalledWith('n4');
});

it('Open leaves the portal for an absolute link on another origin', async () => {
  const user = userEvent.setup();
  ctx.newItems = [{ id: 'n5', kind: 'wiki_update', title: 'Pat published Runbook', body: '',
    link: 'https://wiki.example.com/n/abc', payload: {} }];
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<><ToastHost /><div>home page</div></>} />
        <Route path="*" element={<div>somewhere else</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Open' }));
  expect(leaveFor).toHaveBeenCalledWith('https://wiki.example.com/n/abc');
  expect(screen.getByText('home page')).toBeTruthy();         // no in-app navigation
  expect(ctx.markRead).toHaveBeenCalledWith('n5');
  expect(ctx.dismissNew).toHaveBeenCalledWith('n5');
});

it('Open keeps an absolute link on the portal origin in the app', async () => {
  const user = userEvent.setup();
  ctx.newItems = [{ id: 'n6', kind: 'report_failed', title: 'Move Report failed', body: 'x',
    link: `${window.location.origin}/reports`, payload: {} }];
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ToastHost />} />
        <Route path="/reports" element={<div>reports page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByText('reports page')).toBeTruthy();
  expect(leaveFor).not.toHaveBeenCalled();
});

it('renders local message toasts', () => {
  ctx.local = [{ id: 1, message: "We'll let you know when it's ready" }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByText("We'll let you know when it's ready")).toBeTruthy();
});

it('a local toast with an action shows its button, which acts and dismisses the toast', async () => {
  const user = userEvent.setup();
  const undo = vi.fn();
  ctx.local = [{ id: 7, message: 'Start No Earlier Than constraint added', action: { label: 'Undo', onClick: undo } }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Undo' }));
  expect(undo).toHaveBeenCalledTimes(1);
  expect(ctx.dismissLocal).toHaveBeenCalledWith(7);
});

it('inbox toasts dismiss themselves after INBOX_TOAST_MS', async () => {
  vi.useFakeTimers();
  ctx.newItems = [{ id: 'n3', kind: 'report_failed', title: 'Move Report failed', body: 'x',
    link: '/reports', payload: {} }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(ctx.dismissNew).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(INBOX_TOAST_MS - 1); });
  expect(ctx.dismissNew).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(ctx.dismissNew).toHaveBeenCalledWith('n3');
  vi.useRealTimers();
});

const HOUR = 3_600_000;
const blocked = (over: Record<string, unknown> = {}) => ({
  id: 'b1', kind: 'address_blocked', body: '', link: '/system/blocked-addresses',
  title: 'Sign-ins blocked from 203.0.113.7 for 1 hour (10 failed attempts)',
  payload: { address: '203.0.113.7', level: 1, ends_at: new Date(Date.now() + HOUR).toISOString(),
    failure_count: 10, state: 'open', ...over },
});

it('an address_blocked toast shows the three actions instead of Open and does not fade', async () => {
  vi.useFakeTimers();
  ctx.newItems = [blocked()];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toContain('Sign-ins blocked from 203.0.113.7 for 1 hour (10 failed attempts)');
  expect(screen.getByRole('button', { name: 'Clear block' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Block permanently' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Leave as is' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  act(() => { vi.advanceTimersByTime(INBOX_TOAST_MS * 3); });
  expect(ctx.dismissNew).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Clear block' })).toBeTruthy();
  vi.useRealTimers();
});

it('an address_blocked toast does not hold back the fade of the other toasts', () => {
  vi.useFakeTimers();
  ctx.newItems = [blocked(), { id: 'n3', kind: 'report_failed', title: 'Move Report failed', body: 'x', link: '/reports', payload: {} }];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  act(() => { vi.advanceTimersByTime(INBOX_TOAST_MS); });
  expect(ctx.dismissNew).toHaveBeenCalledTimes(1);
  expect(ctx.dismissNew).toHaveBeenCalledWith('n3');
  vi.useRealTimers();
});

it('Clear block clears the address, marks the item read and closes the toast', async () => {
  const user = userEvent.setup();
  ctx.newItems = [blocked()];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Clear block' }));
  expect(api.clearAddressBlock).toHaveBeenCalledWith('203.0.113.7');
  expect(api.blockAddressPermanently).not.toHaveBeenCalled();
  await waitFor(() => expect(ctx.markRead).toHaveBeenCalledWith('b1'));
  expect(ctx.dismissNew).toHaveBeenCalledWith('b1');
});

it('Block permanently blocks the address permanently and marks the item read', async () => {
  const user = userEvent.setup();
  ctx.newItems = [blocked()];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Block permanently' }));
  expect(api.blockAddressPermanently).toHaveBeenCalledWith('203.0.113.7');
  await waitFor(() => expect(ctx.markRead).toHaveBeenCalledWith('b1'));
});

it('Leave as is marks the item read and calls no block API', async () => {
  const user = userEvent.setup();
  ctx.newItems = [blocked()];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Leave as is' }));
  await waitFor(() => expect(ctx.markRead).toHaveBeenCalledWith('b1'));
  expect(ctx.dismissNew).toHaveBeenCalledWith('b1');
  expect(api.clearAddressBlock).not.toHaveBeenCalled();
  expect(api.blockAddressPermanently).not.toHaveBeenCalled();
});

it('a 409 from another admin\'s decision refreshes instead of showing an error', async () => {
  const { ApiError } = await import('../lib/api');
  api.clearAddressBlock.mockRejectedValueOnce(new ApiError(409, 'block_not_active'));
  const user = userEvent.setup();
  ctx.newItems = [blocked()];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Clear block' }));
  await waitFor(() => expect(ctx.markRead).toHaveBeenCalledWith('b1'));
  expect(ctx.dismissNew).toHaveBeenCalledWith('b1');
  expect(document.querySelector('.pf-error')).toBeNull();
});

it('a failed decision keeps the toast and says so', async () => {
  api.clearAddressBlock.mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup();
  ctx.newItems = [blocked()];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Clear block' }));
  expect(await screen.findByText('Network error — try again.')).toBeTruthy();
  expect(ctx.markRead).not.toHaveBeenCalled();
  expect(ctx.dismissNew).not.toHaveBeenCalled();
});

it('a permanent block offers no Block permanently', () => {
  ctx.newItems = [blocked({ level: 5, ends_at: null })];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.getByRole('button', { name: 'Clear block' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Block permanently' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Leave as is' })).toBeTruthy();
});

it('a timed-out block shows no actions, only that it ended', () => {
  ctx.newItems = [blocked({ ends_at: new Date(Date.now() - 1000).toISOString() })];
  render(<MemoryRouter><ToastHost /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'Clear block' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Block permanently' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Leave as is' })).toBeNull();
  expect(screen.getByText('Ended')).toBeTruthy();
});
