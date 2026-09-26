// @vitest-environment jsdom
/**
 * The kiosk top bar's ? button: signed in with wiki:view and online only;
 * asks the wiki for this screen's guide (`kiosk:<pathname>`) through the
 * kiosk's own apiFetch and opens it in a new tab, or says there's none yet
 * — with "Link a guide" for wiki admins.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

const auth = vi.hoisted(() => ({
  status: 'authed' as 'authed' | 'anon',
  can: (_resource: string, _action: string) => true as boolean,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));
vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../lib/api';
import HelpButton from './HelpButton';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

let open: MockInstance<typeof window.open>;
beforeEach(() => {
  setOnline(true);
  open = vi.spyOn(window, 'open').mockReturnValue(null);
  vi.mocked(apiFetch).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.status = 'authed';
  auth.can = () => true;
  setOnline(true);
});

function renderAt(path = '/enroll') {
  return render(<MemoryRouter initialEntries={[path]}><HelpButton /></MemoryRouter>);
}

const button = () => screen.queryByRole('button', { name: 'Help for this page' });

it('is hidden when signed out or without wiki:view', () => {
  auth.status = 'anon';
  renderAt();
  expect(button()).toBeNull();
  cleanup();
  auth.status = 'authed';
  auth.can = (resource, action) => !(resource === 'wiki' && action === 'view');
  renderAt();
  expect(button()).toBeNull();
});

it('shows only while the kiosk is online', () => {
  setOnline(false);
  renderAt();
  expect(button()).toBeNull();
  act(() => { setOnline(true); window.dispatchEvent(new Event('online')); });
  expect(button()).not.toBeNull();
  act(() => { setOnline(false); window.dispatchEvent(new Event('offline')); });
  expect(button()).toBeNull();
});

it('opens this screen’s guide in a new tab', async () => {
  vi.mocked(apiFetch).mockResolvedValue(json(200, {
    node_id: 'n1', title: 'Enroll Guide', url: 'https://wiki.test/n/n1', context: 'kiosk:/enroll',
  }));
  renderAt('/enroll');
  fireEvent.click(button()!);
  await waitFor(() => expect(open).toHaveBeenCalledWith('https://wiki.test/n/n1', '_blank', 'noopener'));
  expect(apiFetch).toHaveBeenCalledWith('/wiki/help?context=kiosk%3A%2Fenroll');
});

it('says there’s no guide yet, with Link a guide only for wiki admins', async () => {
  vi.mocked(apiFetch).mockResolvedValue(json(404, {}));
  auth.can = (resource, action) => !(resource === 'wiki' && action === 'delete');
  renderAt('/scan');
  fireEvent.click(button()!);
  expect(await screen.findByText('No guide for this page yet')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Link a guide' })).toBeNull();
  cleanup();

  auth.can = () => true;
  renderAt('/scan');
  fireEvent.click(button()!);
  fireEvent.click(await screen.findByRole('button', { name: 'Link a guide' }));
  expect(open).toHaveBeenCalledWith(
    `${location.protocol}//${location.hostname}:5176/admin/help-links?context=kiosk%3A%2Fscan`,
    '_blank', 'noopener');
});

it('says so when the lookup fails', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('network'));
  renderAt();
  fireEvent.click(button()!);
  expect(await screen.findByText('Couldn’t look up a guide. Try again.')).toBeTruthy();
});
