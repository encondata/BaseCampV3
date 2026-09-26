// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
}));

import { clearWikiMe } from '../lib/useWikiMe';
import { getMe, listSpaces, unarchiveSpace } from '../lib/wikiApi';
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
});
afterEach(cleanup);

describe('AdminPage', () => {
  it('is not found for a non-admin', async () => {
    renderAdmin(false);
    expect(await screen.findByText('Nothing here')).toBeTruthy();
    expect(listSpaces).not.toHaveBeenCalled();
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
});
