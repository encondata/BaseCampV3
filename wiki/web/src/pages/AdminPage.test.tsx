// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  listSpaces: vi.fn(),
  unarchiveSpace: vi.fn(),
  listAllShareLinks: vi.fn(),
  revokeShareLink: vi.fn(),
}));

import { clearWikiMe } from '../lib/useWikiMe';
import type { ShareLinkOut } from '../lib/types';
import { getMe, listAllShareLinks, listSpaces, revokeShareLink, unarchiveSpace } from '../lib/wikiApi';
import { makeMe, makeSpace } from '../testing/fixtures';
import AdminPage from './AdminPage';

function renderAdmin(admin = true) {
  vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: admin }));
  return render(<MemoryRouter><AdminPage /></MemoryRouter>);
}

beforeEach(() => {
  clearWikiMe();
  toast.mockReset();
  vi.mocked(listSpaces).mockReset();
  vi.mocked(unarchiveSpace).mockReset();
  vi.mocked(listAllShareLinks).mockReset().mockResolvedValue([]);
  vi.mocked(revokeShareLink).mockReset();
});
afterEach(cleanup);

describe('AdminPage', () => {
  it('is not found for a non-admin', async () => {
    renderAdmin(false);
    expect(await screen.findByText('Nothing here')).toBeTruthy();
    expect(listSpaces).not.toHaveBeenCalled();
    expect(listAllShareLinks).not.toHaveBeenCalled();
  });

  it('links to the analytics page', async () => {
    vi.mocked(listSpaces).mockResolvedValue([]);
    renderAdmin();
    const link = await screen.findByRole('link', { name: 'Open analytics' });
    expect(link.getAttribute('href')).toBe('/analytics');
  });

  it('lists every space including archived ones, with links to settings and trash', async () => {
    vi.mocked(listSpaces).mockResolvedValue([
      makeSpace({ id: 'space-1', key: 'ops', name: 'Operations' }),
      makeSpace({ id: 'space-2', key: 'old', name: 'Old Projects', archived_at: '2026-09-25T00:00:00Z' }),
    ]);
    renderAdmin();
    expect(await screen.findByText('Operations')).toBeTruthy();
    expect(listSpaces).toHaveBeenCalledWith(true);
    expect(screen.getByText('Old Projects')).toBeTruthy();
    expect(screen.getAllByText('Active')).toHaveLength(1);
    expect(screen.getAllByText('Archived')).toHaveLength(1);
    const links = screen.getAllByRole('link', { name: 'Settings' }).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/s/ops/settings', '/s/old/settings']);
    const trashLinks = screen.getAllByRole('link', { name: 'Trash' }).map((a) => a.getAttribute('href'));
    expect(trashLinks).toEqual(['/trash/ops', '/trash/old']);
  });

  it('unarchives a space', async () => {
    const archived = makeSpace({ id: 'space-2', key: 'old', name: 'Old Projects', archived_at: '2026-09-25T00:00:00Z' });
    vi.mocked(listSpaces).mockResolvedValue([archived]);
    vi.mocked(unarchiveSpace).mockResolvedValue({ ...archived, archived_at: null });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(unarchiveSpace).toHaveBeenCalledWith('old'));
    expect(await screen.findByText('Active')).toBeTruthy();
    expect(toast).toHaveBeenCalledWith('“Old Projects” is back in use.');
  });

  it('links to the Help links page', async () => {
    vi.mocked(listSpaces).mockResolvedValue([]);
    renderAdmin();
    const section = await screen.findByRole('region', { name: 'Help links' });
    expect(within(section).getByRole('link', { name: 'Manage help links' }).getAttribute('href'))
      .toBe('/admin/help-links');
  });

  it('lists every public link, and revokes an active one', async () => {
    const link = (over: Partial<ShareLinkOut>): ShareLinkOut => ({
      id: 'l1',
      node: { id: 'n1', title: 'Rack Guide', kind: 'page', space_key: 'ops', space_name: 'Operations' },
      status: 'active', created_by: { id: 'p-1', name: 'Jimmy Henderson' },
      created_at: '2026-09-20T12:00:00Z', expires_at: null, revoked_at: null,
      view_count: 12, last_viewed_at: '2026-09-25T12:00:00Z', ...over,
    });
    vi.mocked(listSpaces).mockResolvedValue([]);
    vi.mocked(listAllShareLinks).mockResolvedValue([
      link({}),
      link({ id: 'l2', node: { id: 'f1', title: 'manual.pdf', kind: 'file', space_key: 'ops', space_name: 'Operations' },
        status: 'revoked', revoked_at: '2026-09-21T00:00:00Z', view_count: 1 }),
    ]);
    vi.mocked(revokeShareLink).mockResolvedValue(undefined);
    renderAdmin();

    const list = await screen.findByRole('list', { name: 'Public links' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'Rack Guide' }).getAttribute('href')).toBe('/n/n1');
    expect(within(rows[0]).getByText('Active')).toBeTruthy();
    expect(within(rows[0]).getByText('12')).toBeTruthy();
    expect(within(rows[1]).getByText('Revoked')).toBeTruthy();
    expect(within(rows[1]).queryByRole('button', { name: 'Revoke' })).toBeNull();

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('l1'));
    await waitFor(() => expect(within(rows[0]).getByText('Revoked')).toBeTruthy());
    expect(toast).toHaveBeenCalledWith('Link revoked. It stops working right away.');
  });

  it('says when the list stops at 500 links, live ones first', async () => {
    const many: ShareLinkOut[] = Array.from({ length: 500 }, (_, i) => ({
      id: `l${i}`,
      node: { id: `n${i}`, title: `Page ${i}`, kind: 'page', space_key: 'ops', space_name: 'Operations' },
      status: 'active', created_by: null, created_at: '2026-09-20T12:00:00Z', expires_at: null,
      revoked_at: null, view_count: 0, last_viewed_at: null,
    }));
    vi.mocked(listSpaces).mockResolvedValue([]);
    vi.mocked(listAllShareLinks).mockResolvedValue(many);
    renderAdmin();
    expect(await screen.findByText('Showing 500 links, live ones first.')).toBeTruthy();
    cleanup();
    vi.mocked(listAllShareLinks).mockResolvedValue(many.slice(0, 3));
    renderAdmin();
    await screen.findByText('Page 0');
    expect(screen.queryByText('Showing 500 links, live ones first.')).toBeNull();
  });
});
