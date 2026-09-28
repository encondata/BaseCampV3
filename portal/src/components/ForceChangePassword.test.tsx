// @vitest-environment jsdom
/**
 * The forced-change screen renders INSTEAD of .portal-shell, where the
 * theme variables live. Regression: .btn-solid's background is
 * var(--accent), so without a local definition the submit renders as
 * bare text (screenshot bug, 2026-08-06). Pins the local variable and
 * the button actually carrying the solid-button class.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

const auth = vi.hoisted(() => ({
  person: { display_name: 'Bobby Henderson' },
  logout: vi.fn(),
  clearMustChange: vi.fn(),
  passwordMinLength: 8,
  mustChangeReason: 'temporary' as 'temporary' | 'expired' | null,
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));

import ForceChangePassword from './ForceChangePassword';

afterEach(cleanup);

it('defines the theme accent locally so the submit renders as a real button', () => {
  const { container } = render(<ForceChangePassword />);
  const wrapper = container.firstElementChild as HTMLElement;
  expect(wrapper.style.getPropertyValue('--accent')).toBe('#ffa12e');
  const submit = screen.getByRole('button', { name: /change password/i });
  expect(submit.className).toContain('btn-solid');
});

it('explains an expired password differently from a temporary one', () => {
  auth.mustChangeReason = 'expired';
  render(<ForceChangePassword />);
  expect(screen.getByRole('heading', { name: 'Your password has expired' })).toBeTruthy();
  expect(screen.getByText(/used recently/)).toBeTruthy();
  cleanup();
  auth.mustChangeReason = 'temporary';
  render(<ForceChangePassword />);
  expect(screen.getByRole('heading', { name: 'Set your password' })).toBeTruthy();
});
