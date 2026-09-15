// @vitest-environment jsdom
/** The Users list expansion offers a Full details link to the detail page. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

it('the expansion shows a Full details link to /people/users/:id', async () => {
  render(
    <MemoryRouter initialEntries={['/people/users']}>
      <Routes>
        <Route path="/people/users" element={<Users />} />
        <Route path="/people/users/:personId" element={<div>DETAIL PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText('Wan Worker'));
  fireEvent.click(await screen.findByRole('button', { name: 'Full details' }));
  expect(await screen.findByText('DETAIL PAGE')).toBeTruthy();
});
