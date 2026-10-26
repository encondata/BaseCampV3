// @vitest-environment jsdom
/** The Learning pages' gate: learning:view or a global wiki:delete. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  can: ((_r: string, _a?: string): boolean => false) as (r: string, a?: string) => boolean,
  global: true,
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authed', mustChangePassword: false, maxRank: 60, can: auth.can,
    scope: { global: auth.global, client_ids: [], partner_ids: [] },
  }),
}));

const { default: ProtectedRoute } = await import('./ProtectedRoute');

afterEach(cleanup);

const show = () => render(
  <MemoryRouter><ProtectedRoute learningManager>page body</ProtectedRoute></MemoryRouter>);

it('lets a learning viewer in', () => {
  auth.can = (r) => r === 'learning';
  auth.global = false;
  show();
  expect(screen.getByText('page body')).toBeTruthy();
});

it('lets a global wiki administrator in without the learning resource', () => {
  auth.can = (r, a) => r === 'wiki' && a === 'delete';
  auth.global = true;
  show();
  expect(screen.getByText('page body')).toBeTruthy();
});

it('refuses a client-scoped wiki administrator and a plain worker', () => {
  auth.can = (r, a) => r === 'wiki' && a === 'delete';
  auth.global = false;
  show();
  expect(screen.getByText('No access')).toBeTruthy();
  cleanup();
  auth.can = () => false;
  show();
  expect(screen.getByText('No access')).toBeTruthy();
});
