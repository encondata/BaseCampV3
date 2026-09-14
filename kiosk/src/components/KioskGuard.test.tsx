// @vitest-environment jsdom
/** KioskGuard: renders nothing while the cookie restore is in flight,
 *  bounces an anonymous session to /login, and holds a must-change-
 *  password session on the notice instead of the routed page. */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// jsdom implements no matchMedia; the must-change-password branch renders
// KioskShell, whose effect calls applyPreferences (prefers-reduced-motion).
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
});

const auth = vi.hoisted(() => ({
  status: 'loading' as 'loading' | 'authed' | 'anon',
  mustChangePassword: false,
  logout: vi.fn(() => Promise.resolve()),
  person: null,
  registration: null,
  preferences: null,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import KioskGuard from './KioskGuard';

function renderGuarded() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/login" element={<div>Login page</div>} />
        <Route path="/" element={<KioskGuard><div>Protected page</div></KioskGuard>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('renders nothing while loading', () => {
  auth.status = 'loading';
  const { container } = renderGuarded();
  expect(container.textContent).toBe('');
});

it('redirects to /login when anonymous', () => {
  auth.status = 'anon';
  renderGuarded();
  expect(screen.getByText('Login page')).toBeTruthy();
});

it('shows the password-change notice with a sign-out button instead of the page', () => {
  auth.status = 'authed';
  auth.mustChangePassword = true;
  renderGuarded();
  const notice = screen.getByText('Password change required').closest('.portal-page');
  expect(notice).toBeTruthy();
  expect(screen.queryByText('Protected page')).toBeNull();
  // The always-signed-in KioskShell header renders its own Sign out button
  // too, so scope to the notice itself rather than getByRole (two matches).
  expect(notice!.querySelector('button.btn-solid')?.textContent).toBe('Sign out');
});
