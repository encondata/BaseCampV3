// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, maxRank: 80, roles: ['super_admin'] }),
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
                { id: 'access', label: 'Roles & access', developer_only: false, always_viewable: false, gated_by: [] }],
    roles: [
      { name: 'super_admin', label: 'Super admin', color: null, rank: 80, member_count: 1,
        matrix: { users: full(['view']), access: full(['view', 'change']) } },
      { name: 'admin', label: 'Administrator', color: null, rank: 60, member_count: 2,
        matrix: { users: full(['view']), access: full(['view']) } },
    ],
  }),
}));

import Access from './Access';

afterEach(cleanup);

it('own role is read-only; a lower role can be edited and saved', async () => {
  render(<Access />);
  await waitFor(() => expect(screen.getByRole('tab', { name: /super admin/i })).toBeTruthy());
  expect(screen.getByText(/you hold this role/i)).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: /administrator/i }));
  await userEvent.click(screen.getByRole('button', { name: /toggle add for every row/i }));
  await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
  expect(putRoleMatrix).toHaveBeenCalledWith('admin', expect.objectContaining({ users: expect.any(Object) }));
});
