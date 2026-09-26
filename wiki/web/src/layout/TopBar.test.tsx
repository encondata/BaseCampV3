// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const logout = vi.fn(async () => {});
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ person: { id: 'p-1', display_name: 'Jimmy Henderson', avatar_url: null }, logout }),
}));
vi.mock('../lib/sessionCaches', () => ({ clearSessionCaches: vi.fn() }));

import { clearSessionCaches } from '../lib/sessionCaches';
import TopBar from './TopBar';

afterEach(cleanup);

describe('TopBar sign-out', () => {
  it('clears the per-person caches before signing out', async () => {
    render(
      <MemoryRouter>
        <TopBar me={null} spaces={[]} currentSpace={null} sidebarCollapsed={false}
                onShowSidebar={() => {}} onNew={null} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(clearSessionCaches).toHaveBeenCalled();
  });
});
