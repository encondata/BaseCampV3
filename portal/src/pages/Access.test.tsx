// @vitest-environment jsdom
/** /access?tab=groups&group=<id> opens the Groups tab with that group selected. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 100, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getAccessSummary: vi.fn(async () => ({
    stats: { members: 2, roles: 1, groups: 2, gated_resources: 0, overrides: 0 },
    resources: [{ id: 'clients', label: 'Clients', developer_only: false, always_viewable: false, gated_by: [] }],
    roles: [],
    groups: [
      { id: 'g1', name: 'Finance', description: '', icon: 'users', member_count: 0, members: [] },
      { id: 'g2', name: 'Ops', description: 'Second group', icon: 'users', member_count: 0, members: [] },
    ],
  })),
  listUsers: vi.fn(async () => []),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

afterEach(cleanup);
const { default: Access } = await import('./Access');

it('opens the Groups tab with the linked group selected', async () => {
  render(<MemoryRouter initialEntries={['/access?tab=groups&group=g2']}><Access /></MemoryRouter>);
  expect((await screen.findByRole('tab', { name: 'Groups' })).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Second group')).toBeTruthy();
});

it('defaults to Roles without params', async () => {
  render(<MemoryRouter initialEntries={['/access']}><Access /></MemoryRouter>);
  expect((await screen.findByRole('tab', { name: 'Roles' })).getAttribute('aria-selected')).toBe('true');
});
