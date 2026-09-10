// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async () => true),
}));

vi.mock('../auth/AuthContext', () => ({
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

const { default: Settings } = await import('./Settings');

it('List text size row updates the preference', async () => {
  render(<Settings />);

  expect(screen.getByText('List text size')).toBeTruthy();

  fireEvent.click(screen.getByText('Extra large'));

  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ list_size: 'xlarge' }),
  ));
});
