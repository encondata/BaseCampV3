// @vitest-environment jsdom
/**
 * The top bar's ? button: hidden without wiki:view; asks the wiki for this
 * screen's guide (`portal:<pathname>`) and opens it in a new tab, or says
 * there's none yet — with "Link a guide" for wiki admins (wiki:delete). It
 * also looks the screen up on load and turns the accent color when a guide
 * exists, so people notice it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

const auth = vi.hoisted(() => ({
  can: (_resource: string, _action?: string) => true as boolean,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: auth.can }) }));
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
