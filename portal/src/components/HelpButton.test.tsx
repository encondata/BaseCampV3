// @vitest-environment jsdom
/**
 * The top bar's ? button: hidden without wiki:view; asks the wiki for this
 * screen's guide (`portal:<pathname>`) and opens it in a new tab, or says
 * there's none yet — with "Link a guide" for wiki admins (wiki:delete).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

const auth = vi.hoisted(() => ({
  can: (_resource: string, _action?: string) => true as boolean,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: auth.can }) }));
vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../lib/api';
import HelpButton from './HelpButton';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let open: MockInstance<typeof window.open>;
beforeEach(() => {
  open = vi.spyOn(window, 'open').mockReturnValue(null);
  vi.mocked(apiFetch).mockReset();
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
  vi.mocked(apiFetch).mockResolvedValue(json(200, {
    node_id: 'n1', title: 'Time Guide', url: 'https://wiki.test/n/n1', context: 'portal:/bulk/time',
  }));
  renderAt('/bulk/time');
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  await waitFor(() => expect(open).toHaveBeenCalledWith('https://wiki.test/n/n1', '_blank', 'noopener'));
  expect(apiFetch).toHaveBeenCalledWith('/wiki/help?context=portal%3A%2Fbulk%2Ftime');
  expect(screen.queryByText('No guide for this page yet')).toBeNull();
});

it('says there’s no guide yet, without Link a guide for someone who isn’t a wiki admin', async () => {
  auth.can = (resource, action) => !(resource === 'wiki' && action === 'delete');
  vi.mocked(apiFetch).mockResolvedValue(json(404, { detail: { code: 'not_found' } }));
  renderAt('/assets');
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  expect(await screen.findByText('No guide for this page yet')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Link a guide' })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it('offers wiki admins Link a guide, opening the wiki’s Help links page on this context', async () => {
  vi.mocked(apiFetch).mockResolvedValue(json(404, { detail: { code: 'not_found' } }));
  renderAt('/sites/42');
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Link a guide' }));
  expect(open).toHaveBeenCalledWith(
    `${location.protocol}//${location.hostname}:5176/admin/help-links?context=portal%3A%2Fsites%2F42`,
    '_blank', 'noopener');
  // the popover closes once it's done its job
  expect(screen.queryByText('No guide for this page yet')).toBeNull();
});

it('says so when the lookup fails', async () => {
  vi.mocked(apiFetch).mockResolvedValue(json(500, {}));
  renderAt();
  fireEvent.click(screen.getByRole('button', { name: 'Help for this page' }));
  expect(await screen.findByText('Couldn’t look up a guide. Try again.')).toBeTruthy();
});

it('closes the popover on a second click, Escape, or a click outside', async () => {
  vi.mocked(apiFetch).mockResolvedValue(json(404, {}));
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
