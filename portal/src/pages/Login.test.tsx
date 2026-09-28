// @vitest-environment jsdom
/** The portal sign-in page: keyboard path (email → Tab → password → Tab →
 *  Sign in; "Forgot password?" and the eye toggle sit between them in the
 *  DOM and must not interrupt it), the light-mockup wording, SSO hint,
 *  support card, and both two-factor steps. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import Login from './Login';

const auth = vi.hoisted(() => ({ login: vi.fn(), completeLogin: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));
const api = vi.hoisted(() => ({
  totpVerify: vi.fn(), totpEnrollStart: vi.fn(), totpEnrollConfirm: vi.fn(),
  isTotpChallenge: (r: { status: string }) => r.status !== 'ok',
  // No ApiError override here — Login.tsx does `err instanceof ApiError`,
  // so the mock must leave the real class (from importActual below) in
  // place rather than shadow it with a differently-shaped stub.
}));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));
vi.mock('../lib/systemStatus', () => ({ getSystemStatus: async () => ({ totp_trust_days: 7 }) }));
vi.mock('../lib/qr', () => ({ qrDataUrl: () => 'data:qr' }));
vi.mock('../components/SystemBanners', () => ({ default: () => null }));

// jsdom has no matchMedia; the error shake asks it about reduced motion
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

it('a verify challenge swaps the form for the code card and completes the login', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  api.totpVerify.mockResolvedValue({ status: 'ok', totp: {} });
  const { email, password } = renderLogin();
  await user.type(email, 'jimmy@example.com');
  await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  // Not findAllByRole('textbox') alone: the email input is itself a
  // textbox and is still mounted the instant this runs (state flips to
  // the challenge card only after the awaited `login()` settles), so an
  // immediate query would resolve on that stale 1-element snapshot. Key
  // the wait to something that only exists once the code card renders.
  await waitFor(() => expect(screen.queryByLabelText('Digit 1')).toBeTruthy());
  const boxes = screen.getAllByRole('textbox');
  expect(boxes).toHaveLength(6);
  expect(screen.getByLabelText(/remember this browser for 7 days/i)).toBeTruthy();
  await user.click(screen.getByLabelText(/remember this browser/i));
  await user.type(boxes[0], '123456');
  await waitFor(() => expect(api.totpVerify).toHaveBeenCalledWith('ch', '123456', true));
  await waitFor(() => expect(auth.completeLogin).toHaveBeenCalled());
});

it('Use a backup code swaps the boxes for one field', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  const { email, password } = renderLogin();
  await user.type(email, 'j@x'); await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  await waitFor(() => expect(screen.queryByLabelText('Digit 1')).toBeTruthy());
  await user.click(screen.getByRole('button', { name: /use a backup code/i }));
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
});

it('an enroll challenge shows the QR step', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_enroll', challenge_token: 'ch', backup_codes_remaining: null });
  api.totpEnrollStart.mockResolvedValue({ secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://x' });
  const { email, password } = renderLogin();
  await user.type(email, 'j@x'); await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  expect(await screen.findByAltText(/scan this/i)).toBeTruthy();
  expect(api.totpEnrollStart).toHaveBeenCalledWith('ch');
});

it('a wrong code shows the error inside the card, keeps it mounted, and refocuses box 1', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  api.totpVerify.mockRejectedValue(new ApiError(401, 'totp_invalid'));
  const { email, password } = renderLogin();
  await user.type(email, 'jimmy@example.com');
  await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  await waitFor(() => expect(screen.queryByLabelText('Digit 1')).toBeTruthy());

  const boxes = screen.getAllByLabelText(/^Digit \d$/);
  await user.type(boxes[0], '000000');

  expect(await screen.findByText(/didn.t match/i)).toBeTruthy();
  // still the code card, not dropped back to the password form
  expect(screen.getByText('Enter your code')).toBeTruthy();
  expect(screen.getAllByLabelText(/^Digit \d$/)).toHaveLength(6);
  await waitFor(() => expect(document.activeElement).toBe(screen.getAllByLabelText(/^Digit \d$/)[0]));
});

it('account_locked drops the code card back to the password form with the locked message', async () => {
  const user = userEvent.setup();
  auth.login.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  api.totpVerify.mockRejectedValue(new ApiError(403, 'account_locked'));
  const { email, password } = renderLogin();
  await user.type(email, 'jimmy@example.com');
  await user.type(password, 'pw');
  fireEvent.submit(email.closest('form')!);
  await waitFor(() => expect(screen.queryByLabelText('Digit 1')).toBeTruthy());

  const boxes = screen.getAllByLabelText(/^Digit \d$/);
  await user.type(boxes[0], '000000');

  await waitFor(() => expect(screen.queryByLabelText('Digit 1')).toBeNull());
  expect(screen.getByText(/temporarily locked/i)).toBeTruthy();
});

it('uses the mockup wording and the light scene with the real logo', () => {
  const { container } = render(<MemoryRouter><Login /></MemoryRouter>);
  expect(container.querySelector('.login-shell.login-light')).not.toBeNull();
  expect(screen.getByRole('heading', { level: 2, name: 'Sign in' })).toBeTruthy();
  expect(screen.getByText('Use the account credentials provided by your migration coordination team.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue with SSO' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Forgot password?' })).toBeTruthy();
  expect(screen.getByAltText('ServerSherpa logo').getAttribute('src')).toBe('/images/serversherpa-logo.png');
  // the entrance animation is gone, so nothing is tagged for it
  expect(container.querySelector('[data-reveal]')).toBeNull();
});

it('Continue with SSO explains that SSO is not enabled yet', async () => {
  const user = userEvent.setup();
  renderLogin();
  await user.click(screen.getByRole('button', { name: 'Continue with SSO' }));
  expect(screen.getByText("Company SSO isn't enabled yet — sign in with your email and password.")).toBeTruthy();
});

it('Forgot password? and Contact support both open the support card', async () => {
  const user = userEvent.setup();
  renderLogin();
  await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Got it' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Contact support' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('the eye toggle shows and hides the password', async () => {
  const user = userEvent.setup();
  const { password } = renderLogin();
  expect(password.getAttribute('type')).toBe('password');
  await user.click(screen.getByRole('button', { name: 'Show password' }));
  expect(password.getAttribute('type')).toBe('text');
  await user.click(screen.getByRole('button', { name: 'Hide password' }));
  expect(password.getAttribute('type')).toBe('password');
});
