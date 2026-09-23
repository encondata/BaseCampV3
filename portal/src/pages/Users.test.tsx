// @vitest-environment jsdom
/** The Users list expansion offers a Full details link to the detail page. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LIST_FIT } from '../lib/listTools';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 100, godMode: false,
    can: () => true,
    preferences: { list_prefs: {}, list_size: 'default' }, updatePreferences: vi.fn(),
  }),
}));

const ROW = {
  person_id: 'p1', first_name: 'Wan', last_name: 'Worker', preferred_name: null, display_name: 'Wan Worker',
  job_title: null, phone: null, contact_email: null, login_email: 'wan@x.test', roles: ['staff'],
  status: 'active', must_change_password: false, last_login_at: null, account_created_at: '2026-01-01T00:00:00Z',
  archived_at: null, avatar_url: null, max_rank: 40,
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([ROW]), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const { default: Users } = await import('./Users');

it('the Actions menu shows a Full details link to /people/users/:id, without expanding the row', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getAllByRole('button', { name: /actions/i })[0]);
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Full details' }));
  expect(await screen.findByText('DETAIL PAGE')).toBeTruthy();
});

it('a manage-able row lists Full details, Edit profile, Reset password, Manage roles, Disable account', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getAllByRole('button', { name: /actions/i })[0]);
  expect(await screen.findByRole('menuitem', { name: 'Full details' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Edit profile' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Reset password' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Manage roles' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Disable account' })).toBeTruthy();
});

it('clicking the Actions trigger does not expand the row', async () => {
  const { container } = render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Wan Worker');
  fireEvent.click(screen.getAllByRole('button', { name: /actions/i })[0]);
  await screen.findByRole('menuitem', { name: 'Full details' });
  // Expansion is driven by the `open` class on `.dir-row` (CSS
  // grid-rows collapse, not conditional mounting), so the real signal
  // that the row did NOT expand is the class staying off, not the
  // detail markup's absence from the tree.
  const row = container.querySelector('.dir-row');
  expect(row?.className).not.toMatch(/\bopen\b/);
});

it('Users list: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  const row = (await screen.findByText('Wan Worker')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});
