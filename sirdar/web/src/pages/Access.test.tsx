// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const viewer = vi.hoisted(() => ({ maxRank: 80, roles: ['super_admin'] as string[] }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, maxRank: viewer.maxRank, roles: viewer.roles }),
}));
const putRoleMatrix = vi.hoisted(() => vi.fn());
putRoleMatrix.mockResolvedValue({ role: 'admin', grants: 5 });
const full = vi.hoisted(() => (on: string[]) =>
  Object.fromEntries(['view', 'add', 'change', 'delete'].map((a) => [a, on.includes(a)])));
vi.mock('../lib/sirdarApi', async (orig) => ({
  ...(await orig<typeof import('../lib/sirdarApi')>()),
  putRoleMatrix,
  getAccessSummary: vi.fn().mockResolvedValue({
    resources: [{ id: 'users', label: 'Users', developer_only: false, always_viewable: false, gated_by: [] },
                { id: 'access', label: 'Roles & access', developer_only: false, always_viewable: false, gated_by: [] },
                { id: 'devtools', label: 'Developer tools', developer_only: true, always_viewable: false, gated_by: [] }],
    roles: [
      { name: 'developer', label: 'Developer', color: null, rank: 100, member_count: 1,
        matrix: { users: full(['view', 'delete']), access: full(['view', 'change']),
                  devtools: full(['view', 'add', 'change', 'delete']) } },
      { name: 'super_admin', label: 'Super admin', color: null, rank: 80, member_count: 1,
        matrix: { users: full(['view']), access: full(['view', 'change']) } },
      { name: 'admin', label: 'Administrator', color: null, rank: 60, member_count: 2,
        matrix: { users: full(['view']), access: full(['view']) } },
    ],
  }),
}));

import Access from './Access';

afterEach(() => {
  cleanup();
  viewer.maxRank = 80;
  viewer.roles = ['super_admin'];
});

it('own role is read-only; a lower role can be edited and saved', async () => {
  render(<Access />);
  await waitFor(() => expect(screen.getByRole('radio', { name: /super admin/i })).toBeTruthy());
  await userEvent.click(screen.getByRole('radio', { name: /super admin/i }));
  expect(screen.getByText(/you hold this role/i)).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: /administrator/i }));
  await userEvent.click(screen.getByRole('button', { name: /toggle add for every row/i }));
  await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
  expect(putRoleMatrix).toHaveBeenCalledWith('admin', expect.objectContaining({
    users: expect.objectContaining({ add: true }),
  }));
  const saved = putRoleMatrix.mock.calls[0][1] as Record<string, Record<string, boolean>>;
  expect(saved.users.add).toBe(true);
});

it('switching roles with unsaved edits asks first and stays put when declined', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<Access />);
  await waitFor(() => expect(screen.getByRole('radio', { name: /administrator/i })).toBeTruthy());
  await userEvent.click(screen.getByRole('radio', { name: /administrator/i }));
  await userEvent.click(screen.getByRole('button', { name: /toggle add for every row/i }));
  await userEvent.click(screen.getByRole('radio', { name: /super admin/i }));
  expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes to Administrator?');
  expect(screen.getByRole('radio', { name: /administrator/i }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('button', { name: /save changes/i }).hasAttribute('disabled')).toBe(false);
  confirm.mockRestore();
});

it('a founder sees the developer role read-only with the developer-only message', async () => {
  viewer.maxRank = 100;
  viewer.roles = ['founder'];
  render(<Access />);
  await waitFor(() => expect(screen.getByRole('radio', { name: /developer/i })).toBeTruthy());
  expect(screen.getByText('Only developers can change the developer role.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
});

it('a developer can edit the developer role, with the core cells locked', async () => {
  viewer.maxRank = 100;
  viewer.roles = ['developer'];
  render(<Access />);
  await waitFor(() => expect(screen.getByRole('radio', { name: /developer/i })).toBeTruthy());
  expect(screen.queryByText(/you hold this role/i)).toBeNull();
  expect(screen.queryByText('Only developers can change the developer role.')).toBeNull();
  const cells = Array.from(document.querySelectorAll<HTMLButtonElement>('button.pm-chk'));
  expect(cells.length).toBe(12);
  // devtools (4) + access view/change (2) are locked; the other six are editable
  expect(cells.filter((c) => c.title === 'Locked').length).toBe(6);
  const enabled = cells.filter((c) => !c.disabled);
  expect(enabled.length).toBe(6);
  await userEvent.click(enabled[0]);
  expect(screen.getByRole('button', { name: /save changes/i }).hasAttribute('disabled')).toBe(false);
});
