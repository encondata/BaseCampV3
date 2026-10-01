// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = { allowed: true };
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: () => state.allowed }),
}));

import Gate from './Gate';

afterEach(cleanup);

it('renders children when the permission is held', () => {
  state.allowed = true;
  render(<Gate resource="users"><div>secret</div></Gate>);
  expect(screen.getByText('secret')).toBeTruthy();
});

it('shows a no-access notice otherwise', () => {
  state.allowed = false;
  render(<Gate resource="users"><div>secret</div></Gate>);
  expect(screen.queryByText('secret')).toBeNull();
  expect(screen.getByText("You don't have access to this page.")).toBeTruthy();
});
