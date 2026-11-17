// @vitest-environment jsdom
/** globalOnly routes (the Move dashboard): staff only, even by URL. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ global: true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authed', mustChangePassword: false, maxRank: 30, can: () => true,
    scope: { global: auth.global, client_ids: [], partner_ids: [] },
  }),
}));

const { default: ProtectedRoute } = await import('./ProtectedRoute');

afterEach(cleanup);

const show = () => render(
  <MemoryRouter>
    <ProtectedRoute resource="dashboard" globalOnly>page body</ProtectedRoute>
  </MemoryRouter>);

it('lets global staff in', () => {
  auth.global = true;
  show();
  expect(screen.getByText('page body')).toBeTruthy();
});

it('refuses a client login that holds the resource', () => {
  auth.global = false;
  show();
  expect(screen.getByText('No access')).toBeTruthy();
  expect(screen.queryByText('page body')).toBeNull();
});
