// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const state = { status: 'anon' as 'anon' | 'authed' | 'loading' };
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => state }));

import RequireAuth from './RequireAuth';

afterEach(cleanup);

function renderAt() {
  render(
    <MemoryRouter initialEntries={['/admin/users']}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/*" element={<RequireAuth><div>secret</div></RequireAuth>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('sends anonymous visitors to /login', () => {
  state.status = 'anon';
  renderAt();
  expect(screen.getByText('login page')).toBeTruthy();
});

it('renders children when signed in', () => {
  state.status = 'authed';
  renderAt();
  expect(screen.getByText('secret')).toBeTruthy();
});
