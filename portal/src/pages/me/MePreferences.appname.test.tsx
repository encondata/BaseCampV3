// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { display_name: 'Ada Lovelace', email: 'ada@test.example.com' },
    roles: ['developer'],
    preferences: {
      accent: 'amber', theme: 'light', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: false, sound: 'chime' },
      list_prefs: {},
    },
    updatePreferences: vi.fn(async () => true),
    can: () => false,
  }),
}));

afterEach(cleanup);

const { default: MePreferences } = await import('./MePreferences');

const text = (c: HTMLElement) => c.textContent ?? '';

it('with no prop the copy is exactly today\'s portal wording', () => {
  const { container } = render(<MePreferences />);
  const t = text(container);
  expect(t).toContain(
    'Preferences are saved to your account — sign in on any device and the portal looks the way you left it.',
  );
  expect(t).toContain('How the portal looks and moves, everywhere you sign in.');
  expect(t).toContain('Highlights, active states, and focus rings across the portal.');
});

it('appName="Sirdar" replaces "the portal" without an article', () => {
  const { container } = render(<MePreferences appName="Sirdar" />);
  const t = text(container);
  expect(t).toContain('sign in on any device and Sirdar looks the way you left it.');
  expect(t).toContain('How Sirdar looks and moves, everywhere you sign in.');
  expect(t).toContain('focus rings across Sirdar.');
  expect(t).not.toMatch(/portal/i);
});
