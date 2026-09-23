// @vitest-environment jsdom
/** Keyboard path through the sign-in form: email → Tab → password → Tab →
 *  Sign in. The Forgot?/show-password/remember controls sit between them in
 *  the DOM and must not interrupt that path. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import Login from './Login';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));
vi.mock('../lib/brandScene', () => ({ buildBrandScene: () => () => {} }));
vi.mock('../components/SystemBanners', () => ({ default: () => null }));

// jsdom has no matchMedia; the page asks it about reduced motion
window.matchMedia = ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as typeof window.matchMedia;

afterEach(cleanup);

function renderLogin() {
  render(<MemoryRouter><Login /></MemoryRouter>);
  return {
    email: screen.getByLabelText('Email'),
    password: screen.getByPlaceholderText('••••••••••••'),
    signIn: screen.getByRole('button', { name: /sign in/i }),
  };
}

it('Tab goes email → password → Sign in', async () => {
  const user = userEvent.setup();
  const { email, password, signIn } = renderLogin();
  email.focus();
  await user.type(email, 'jimmy@example.com');
  await user.tab();
  expect(document.activeElement).toBe(password);
  await user.tab();
  expect(document.activeElement).toBe(signIn);
});

it('Shift+Tab walks the same path backward', async () => {
  const user = userEvent.setup();
  const { email, password, signIn } = renderLogin();
  signIn.focus();
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(password);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(email);
});

it('account recovery stays reachable from the keyboard via Contact support', async () => {
  const user = userEvent.setup();
  const { signIn } = renderLogin();
  signIn.focus();
  await user.tab();
  const next = document.activeElement as HTMLElement;
  // after Sign in: the SSO button, then Contact support
  expect(next.textContent).toMatch(/sso/i);
  await user.tab();
  expect(document.activeElement?.textContent).toMatch(/contact support/i);
});
