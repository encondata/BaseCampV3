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
                onShowSidebar={() => {}} onNew={null} onUpload={null} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(clearSessionCaches).toHaveBeenCalled();
  });
});

describe('TopBar New › Upload files', () => {
  function renderBar(onUpload: ((files: File[]) => void) | null) {
    return render(
      <MemoryRouter>
        <TopBar me={null} spaces={[]} currentSpace={null} sidebarCollapsed={false}
                onShowSidebar={() => {}} onNew={null} onUpload={onUpload} />
      </MemoryRouter>,
    );
  }

  it('picks files and hands them to the shell', () => {
    const onUpload = vi.fn();
    renderBar(onUpload);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    const item = screen.getByRole('menuitem', { name: 'Upload files' }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    const input = screen.getByLabelText('Choose files to upload') as HTMLInputElement;
    const clicked = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(item);
    expect(clicked).toHaveBeenCalled();
    expect(screen.queryByRole('menu', { name: 'New' })).toBeNull();
    const files = [new File(['a'], 'a.pdf')];
    fireEvent.change(input, { target: { files } });
    expect(onUpload).toHaveBeenCalledWith(files);
  });

  it('is off where the user can\'t add files', () => {
    renderBar(null);
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect((screen.getByRole('menuitem', { name: 'Upload files' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Choose files to upload')).toBeNull();
  });
});
