// @vitest-environment jsdom
/**
 * The top bar's ? button: hidden without wiki:view; asks the wiki for this
 * screen's guide (`portal:<pathname>`) and opens it in a new tab, or says
 * there's none yet — with "Link a guide" for wiki admins (wiki:delete). It
 * also looks the screen up on load and turns the accent color when a guide
 * exists, so people notice it.
 */
import { StrictMode, useLayoutEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

const auth = vi.hoisted(() => ({
  can: (_resource: string, _action?: string) => true as boolean,
  person: { id: 'person-a' } as { id: string } | null,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: auth.can, person: auth.person }) }));
vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../lib/api';
import HelpButton, { clearHelpCache } from './HelpButton';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let open: MockInstance<typeof window.open>;
beforeEach(() => {
  open = vi.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
  vi.mocked(apiFetch).mockReset();
  clearHelpCache();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.can = () => true;
  auth.person = { id: 'person-a' };
});

function renderAt(path = '/bulk/time') {
  return render(<MemoryRouter initialEntries={[path]}><HelpButton /></MemoryRouter>);
}

it('is hidden without wiki:view', () => {
  auth.can = (resource, action) => !(resource === 'wiki' && action === 'view');
  renderAt();
  expect(screen.queryByRole('button', { name: 'Help for this page' })).toBeNull();
});

it('opens this screen’s guide in a new tab', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(200, {
    node_id: 'n1', title: 'Time Guide', url: 'https://wiki.test/n/n1', context: 'portal:/bulk/time',
  }));
  renderAt('/bulk/time');
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('https://wiki.test/n/n1', '_blank'));
  expect(apiFetch).toHaveBeenCalledWith('/wiki/help?context=portal%3A%2Fbulk%2Ftime');
  expect(screen.queryByText('No guide for this page yet')).toBeNull();
});

it('offers the guide as a link when the browser blocks the new tab', async () => {
  // a slow lookup can outlast the click's permission to open a tab
  open.mockReturnValue(null);
  vi.mocked(apiFetch).mockImplementation(async () => json(200, {
    node_id: 'n1', title: 'Time Guide', url: 'https://wiki.test/n/n1', context: 'portal:/bulk/time',
  }));
  renderAt('/bulk/time');
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  const link = await screen.findByRole('link', { name: 'Open “Time Guide”' });
  expect(link.getAttribute('href')).toBe('https://wiki.test/n/n1');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  fireEvent.click(link);
  expect(screen.queryByRole('link', { name: 'Open “Time Guide”' })).toBeNull();
});

it('says there’s no guide yet, without Link a guide for someone who isn’t a wiki admin', async () => {
  auth.can = (resource, action) => !(resource === 'wiki' && action === 'delete');
  vi.mocked(apiFetch).mockImplementation(async () => json(404, { detail: { code: 'not_found' } }));
  renderAt('/assets');
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  expect(await screen.findByText('No guide for this page yet')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Link a guide' })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it('offers wiki admins Link a guide, opening the wiki’s Help links page on this context', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(404, { detail: { code: 'not_found' } }));
  renderAt('/sites/42');
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Link a guide' }));
  expect(open).toHaveBeenCalledWith(
    `${location.protocol}//${location.hostname}:5176/admin/help-links?context=portal%3A%2Fsites%2F42`,
    '_blank');
  // the popover closes once it's done its job
  expect(screen.queryByText('No guide for this page yet')).toBeNull();
});

it('says so when the lookup fails', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(500, {}));
  renderAt();
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  expect(await screen.findByText('Couldn’t look up a guide. Try again.')).toBeTruthy();
});

it('closes the popover on a second click, Escape, or a click outside', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(404, {}));
  renderAt();
  const button = screen.getByRole('button', { name: 'Help for this page' });
  fireEvent.click(button);
  await screen.findByText('No guide for this page yet');
  fireEvent.click(button);
  expect(screen.queryByText('No guide for this page yet')).toBeNull();

  fireEvent.click(button);
  await screen.findByText('No guide for this page yet');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByText('No guide for this page yet')).toBeNull();

  fireEvent.click(button);
  await screen.findByText('No guide for this page yet');
  fireEvent.mouseDown(document.body);
  expect(screen.queryByText('No guide for this page yet')).toBeNull();
});

// ── the accent: the ? looks the screen up on load ────────────────────────

const guideBody = (path: string, title = 'Time Guide') => ({
  node_id: 'n1', title, url: 'https://wiki.test/n/n1', context: `portal:${path}`,
});
const GUIDE_LABEL = 'Guide for this page: “Time Guide”';

it('turns the accent and names the guide when this screen has one', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(200, guideBody('/bulk/time')));
  renderAt('/bulk/time');
  const button = await screen.findByRole('button', { name: GUIDE_LABEL });
  expect(button.classList.contains('has-guide')).toBe(true);
  expect(button.getAttribute('data-tip')).toBe(GUIDE_LABEL);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(apiFetch).toHaveBeenCalledWith('/wiki/help?context=portal%3A%2Fbulk%2Ftime');
});

it('stays normal when this screen has no guide', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(404, { detail: { code: 'not_found' } }));
  renderAt('/assets');
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  const button = screen.getByRole('button', { name: 'Help for this page' });
  expect(button.classList.contains('has-guide')).toBe(false);
  expect(button.getAttribute('data-tip')).toBe('Help for this page');
});

it('stays normal, with no popover, when the load-time lookup fails', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(500, {}));
  renderAt();
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole('button', { name: 'Help for this page' }).classList.contains('has-guide')).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not look anything up without wiki:view', async () => {
  auth.can = (resource, action) => !(resource === 'wiki' && action === 'view');
  renderAt();
  await new Promise((r) => setTimeout(r, 0));
  expect(apiFetch).not.toHaveBeenCalled();
});

it('opens a known guide at once, without a second lookup', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(200, guideBody('/bulk/time')));
  renderAt('/bulk/time');
  fireEvent.click(await screen.findByRole('button', { name: GUIDE_LABEL }));
  expect(open).toHaveBeenCalledWith('https://wiki.test/n/n1', '_blank');
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('offers a known guide as a link when the browser blocks the new tab', async () => {
  open.mockReturnValue(null);
  vi.mocked(apiFetch).mockImplementation(async () => json(200, guideBody('/bulk/time')));
  renderAt('/bulk/time');
  fireEvent.click(await screen.findByRole('button', { name: GUIDE_LABEL }));
  const link = await screen.findByRole('link', { name: 'Open “Time Guide”' });
  expect(link.getAttribute('href')).toBe('https://wiki.test/n/n1');
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

function Go({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>go {to}</button>;
}

it('looks the next screen up on navigation, drops the accent when it has no guide, and caches', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path: string) =>
    path.includes(encodeURIComponent('/bulk/time')) ? json(200, guideBody('/bulk/time')) : json(404, {}));
  render(
    <MemoryRouter initialEntries={['/bulk/time']}>
      <HelpButton />
      <Go to="/assets" />
      <Go to="/bulk/time" />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: GUIDE_LABEL });
  expect(apiFetch).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByText('go /assets'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(
    screen.getByRole('button', { name: 'Help for this page' }).classList.contains('has-guide')).toBe(false));

  // back to a screen already looked up: from the cache, no new fetch
  fireEvent.click(screen.getByText('go /bulk/time'));
  expect(await screen.findByRole('button', { name: GUIDE_LABEL })).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(2);

  // and the not-found answer is cached too
  fireEvent.click(screen.getByText('go /assets'));
  await screen.findByRole('button', { name: 'Help for this page' });
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('ignores a lookup that finishes after leaving the screen', async () => {
  let release: (r: Response) => void = () => {};
  vi.mocked(apiFetch).mockImplementation((path: string) =>
    path.includes(encodeURIComponent('/bulk/time'))
      ? new Promise<Response>((res) => { release = res; })
      : Promise.resolve(json(404, {})));
  render(
    <MemoryRouter initialEntries={['/bulk/time']}>
      <HelpButton />
      <Go to="/assets" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('go /assets'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  release(json(200, guideBody('/bulk/time')));
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole('button', { name: 'Help for this page' }).classList.contains('has-guide')).toBe(false);
});

it('turns the accent on when a click finds a guide that was added since the load', async () => {
  vi.mocked(apiFetch)
    .mockImplementationOnce(async () => json(404, {}))
    .mockImplementationOnce(async () => json(200, guideBody('/bulk/time')));
  renderAt('/bulk/time');
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 0));
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('https://wiki.test/n/n1', '_blank'));
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: GUIDE_LABEL }).classList.contains('has-guide')).toBe(true);
});

// ── dedupe, per-person scope, expiry, no stale window ───────────────────

it('looks a screen up once under StrictMode', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(200, guideBody('/bulk/time')));
  render(<StrictMode><MemoryRouter initialEntries={['/bulk/time']}><HelpButton /></MemoryRouter></StrictMode>);
  await screen.findByRole('button', { name: GUIDE_LABEL });
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('fetches A once for a quick A to B to A before A resolves', async () => {
  const resolvers: Record<string, (r: Response) => void> = {};
  vi.mocked(apiFetch).mockImplementation((path: string) =>
    new Promise<Response>((res) => { resolvers[decodeURIComponent(path.split('=')[1])] = res; }));
  render(
    <MemoryRouter initialEntries={['/a']}>
      <HelpButton />
      <Go to="/b" />
      <Go to="/a" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('go /b'));
  fireEvent.click(screen.getByText('go /a'));
  expect(apiFetch).toHaveBeenCalledTimes(2); // portal:/a once, portal:/b once
  resolvers['portal:/a'](json(200, guideBody('/a')));
  expect(await screen.findByRole('button', { name: GUIDE_LABEL })).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('does not cache a failed lookup: the next visit asks again', async () => {
  vi.mocked(apiFetch)
    .mockImplementationOnce(async () => json(500, {}))
    .mockImplementation(async () => json(200, guideBody('/a')));
  render(
    <MemoryRouter initialEntries={['/a']}>
      <HelpButton />
      <Go to="/b" />
      <Go to="/a" />
    </MemoryRouter>,
  );
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 0));
  fireEvent.click(screen.getByText('go /b'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText('go /a'));
  expect(await screen.findByRole('button', { name: GUIDE_LABEL })).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(3);
});

it('does not show one person’s guide to the next person who signs in', async () => {
  vi.mocked(apiFetch)
    .mockImplementationOnce(async () => json(200, guideBody('/bulk/time')))
    .mockImplementationOnce(async () => json(404, {}));
  const ui = () => <MemoryRouter initialEntries={['/bulk/time']}><HelpButton /></MemoryRouter>;
  const { rerender } = render(ui());
  await screen.findByRole('button', { name: GUIDE_LABEL });

  auth.person = { id: 'person-b' };
  rerender(ui());
  const button = screen.getByRole('button', { name: 'Help for this page' });
  expect(button.classList.contains('has-guide')).toBe(false);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole('button', { name: 'Help for this page' }).classList.contains('has-guide')).toBe(false);
});

it('forgets everything on sign-out (person becomes null)', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => json(200, guideBody('/bulk/time')));
  const ui = () => <MemoryRouter initialEntries={['/bulk/time']}><HelpButton /></MemoryRouter>;
  const { rerender } = render(ui());
  await screen.findByRole('button', { name: GUIDE_LABEL });
  auth.person = null;
  auth.can = () => false;
  rerender(ui());
  auth.can = () => true;
  auth.person = { id: 'person-c' };
  rerender(ui());
  expect(screen.getByRole('button', { name: 'Help for this page' })).toBeTruthy();
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
});

it('looks a screen up again once its cached answer is five minutes old', async () => {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(apiFetch).mockImplementation(async (path: string) =>
    path.includes(encodeURIComponent('/bulk/time')) ? json(200, guideBody('/bulk/time')) : json(404, {}));
  render(
    <MemoryRouter initialEntries={['/bulk/time']}>
      <HelpButton />
      <Go to="/assets" />
      <Go to="/bulk/time" />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: GUIDE_LABEL });
  fireEvent.click(screen.getByText('go /assets'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));

  now += 4 * 60_000;                      // still fresh: cache
  fireEvent.click(screen.getByText('go /bulk/time'));
  expect(await screen.findByRole('button', { name: GUIDE_LABEL })).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByText('go /assets'));
  now += 2 * 60_000;                      // 6 minutes since the lookup: expired
  fireEvent.click(screen.getByText('go /bulk/time'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
});

it('never shows the old screen’s guide in the commit after navigating', async () => {
  vi.mocked(apiFetch).mockImplementation((path: string) =>
    path.includes(encodeURIComponent('/bulk/time'))
      ? Promise.resolve(json(200, guideBody('/bulk/time')))
      : new Promise<Response>(() => {}));   // /assets never answers
  const seen: string[] = [];
  function Probe() {
    const { pathname } = useLocation();
    useLayoutEffect(() => {
      seen.push(`${pathname}|${document.querySelector('.icon-btn')?.getAttribute('aria-label')}`);
    });
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/bulk/time']}>
      <HelpButton />
      <Probe />
      <Go to="/assets" />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: GUIDE_LABEL });
  fireEvent.click(screen.getByText('go /assets'));
  const after = seen.filter((x) => x.startsWith('/assets|'));
  expect(after.length).toBeGreaterThan(0);
  expect(new Set(after)).toEqual(new Set(['/assets|Help for this page']));
  // and a click on the new screen asks the wiki, it doesn't open the old guide
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  expect(open).not.toHaveBeenCalled();
});

// ── round 2: display vs freshness, in-flight stale write, popover scope ──

it('keeps the accent past five minutes on a screen, and refetches once on arriving again', async () => {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(apiFetch).mockImplementation(async (path: string) =>
    path.includes(encodeURIComponent('/bulk/time')) ? json(200, guideBody('/bulk/time')) : json(404, {}));
  const ui = () => (
    <MemoryRouter initialEntries={['/bulk/time']}>
      <HelpButton />
      <Go to="/assets" />
      <Go to="/bulk/time" />
    </MemoryRouter>
  );
  const { rerender } = render(ui());
  await screen.findByRole('button', { name: GUIDE_LABEL });

  now += 6 * 60_000;
  rerender(ui());                         // a re-render is not an arrival
  expect(screen.getByRole('button', { name: GUIDE_LABEL }).classList.contains('has-guide')).toBe(true);
  expect(apiFetch).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByText('go /assets'));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText('go /bulk/time'));
  // the expired answer still shows while the one refetch runs
  expect(screen.getByRole('button', { name: GUIDE_LABEL })).toBeTruthy();
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  await new Promise((r) => setTimeout(r, 0));
  expect(apiFetch).toHaveBeenCalledTimes(3);
});

it('ignores a lookup for the previous person that finishes after the person changed', async () => {
  const pending: Array<(r: Response) => void> = [];
  vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((res) => { pending.push(res); }));
  const ui = () => <MemoryRouter initialEntries={['/bulk/time']}><HelpButton /></MemoryRouter>;
  const { rerender } = render(ui());
  await waitFor(() => expect(pending.length).toBe(1));

  auth.person = { id: 'person-b' };
  rerender(ui());
  await waitFor(() => expect(pending.length).toBe(2));

  pending[0](json(200, guideBody('/bulk/time')));   // A's answer arrives late
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole('button', { name: 'Help for this page' }).classList.contains('has-guide')).toBe(false);

  pending[1](json(404, {}));                         // B's own lookup decides
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByRole('button', { name: 'Help for this page' }).classList.contains('has-guide')).toBe(false);
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('never renders the old screen’s popover in the commit after navigating', async () => {
  open.mockReturnValue(null);
  vi.mocked(apiFetch).mockImplementation((path: string) =>
    path.includes(encodeURIComponent('/bulk/time'))
      ? Promise.resolve(json(200, guideBody('/bulk/time')))
      : new Promise<Response>(() => {}));
  const seen: string[] = [];
  function Probe() {
    const { pathname } = useLocation();
    useLayoutEffect(() => {
      seen.push(`${pathname}|${document.querySelector('[role="dialog"]') ? 'popover' : 'none'}`);
    });
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/bulk/time']}>
      <HelpButton />
      <Probe />
      <Go to="/assets" />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: GUIDE_LABEL }));
  await screen.findByRole('link', { name: 'Open “Time Guide”' });   // blocked: link in a popover
  fireEvent.click(screen.getByText('go /assets'));
  const after = seen.filter((x) => x.startsWith('/assets|'));
  expect(after.length).toBeGreaterThan(0);
  expect(new Set(after)).toEqual(new Set(['/assets|none']));
});
