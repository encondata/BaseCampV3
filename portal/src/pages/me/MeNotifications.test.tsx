// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../../lib/api';

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async (_prefs: UiPreferences) => true),
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { display_name: 'Ada Lovelace', email: 'ada@test.example.com' },
    roles: ['developer'],
    preferences: {
      accent: 'amber',
      theme: 'light',
      density: 'comfortable',
      list_size: 'default',
      motion: true,
      nav_mode: 'expanded',
      nav_bg: 'default',
      nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: false },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: auth.updatePreferences,
    can: () => false,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const { default: MeNotifications } = await import('./MeNotifications');

it('renders the four notification rows', () => {
  render(<MeNotifications />);
  for (const label of ['Critical incidents', 'Email alerts', 'Maintenance windows', 'Weekly digest']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText('Appearance')).toBeNull();
});

it('toggling a switch saves the merged notif object', async () => {
  render(<MeNotifications />);
  const row = screen.getByText('Weekly digest').closest('.set-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('checkbox'));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
  const sent = auth.updatePreferences.mock.calls[0][0];
  expect(sent.notif).toEqual({ critical: true, email: true, maint: true, digest: true });
  expect(sent.accent).toBe('amber');
  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
});
