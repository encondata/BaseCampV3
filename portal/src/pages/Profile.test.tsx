// @vitest-environment jsdom
/**
 * /me tab strip: Profile vs Preferences (see
 * docs/superpowers/specs/2026-09-10-me-preferences-design.md). The
 * Preferences tab renders MePreferences.tsx for real (not mocked) — both
 * modules import '../auth/AuthContext' from the same resolved path, so
 * mocking it once here covers both.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { PersonDetail, TotpStatus, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async () => true),
  applyProfile: vi.fn(),
  applyTotp: vi.fn(),
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 } as TotpStatus,
  person: { email: 'ada@test.example.com' },
}));

const api = vi.hoisted(() => ({
  getProfileRequest: vi.fn(),
  getSessionsRequest: vi.fn(async () => []),
  getMyActivityRequest: vi.fn(async () => []),
  revokeSessionRequest: vi.fn(async () => {}),
  updateProfileRequest: vi.fn(),
  // MeNotifications (the Notifications tab) loads the person's groups on mount
  listMyNotificationGroups: vi.fn(async () => []),
}));

const PROFILE: PersonDetail = {
  id: 'p1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  preferred_name: null,
  display_name: 'Ada Lovelace',
  email: 'ada@test.example.com',
  phone: null,
  job_title: 'Developer',
  address_line1: null,
  address_line2: null,
  city: null,
  region: null,
  postal_code: null,
  country: 'US',
  badge_uid: 'BADGE-1',
  created_at: '2024-01-01T00:00:00Z',
  avatar_key: null,
  avatar_url: null,
  password_updated_at: null,
};

api.getProfileRequest.mockImplementation(async () => PROFILE);

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    roles: ['developer'],
    applyProfile: auth.applyProfile,
    applyTotp: auth.applyTotp,
    totp: auth.totp,
    person: auth.person,
    preferences: {
      accent: 'amber',
      theme: 'light',
      density: 'comfortable',
      list_size: 'default',
      motion: true,
      nav_mode: 'expanded',
      nav_bg: 'default',
      nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: false, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: auth.updatePreferences,
    can: () => false,
  }),
}));

vi.mock('../lib/api', () => api);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.getProfileRequest.mockImplementation(async () => PROFILE);
  api.getSessionsRequest.mockImplementation(async () => []);
  api.getMyActivityRequest.mockImplementation(async () => []);
  auth.totp = { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 };
});

const { default: Profile } = await import('./Profile');

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="loc">{location.pathname}</span>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/me" element={<Profile />} />
        <Route path="/me/preferences" element={<Profile />} />
        <Route path="/me/notifications" element={<Profile />} />
        <Route path="/me/history" element={<Profile />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('shows four tabs, Profile active by default at /me', async () => {
  renderAt('/me');

  await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());

  const profileTab = screen.getByRole('tab', { name: 'Profile' });
  const prefsTab = screen.getByRole('tab', { name: 'Preferences' });
  expect(profileTab.getAttribute('aria-selected')).toBe('true');
  expect(prefsTab.getAttribute('aria-selected')).toBe('false');
  expect(screen.getByRole('tab', { name: 'Notifications' }).getAttribute('aria-selected')).toBe('false');
  expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('false');
});

it('/me shows the Profile panel and not the preferences sections', async () => {
  renderAt('/me');

  await waitFor(() => expect(
    screen.getByRole('heading', { name: 'Profile', level: 3 }),
  ).toBeTruthy());

  expect(screen.queryByText('Appearance')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Notifications', level: 3 })).toBeNull();
});

it('/me/preferences shows Appearance only, not Notifications or the Profile panel', async () => {
  renderAt('/me/preferences');

  await waitFor(() => expect(screen.getByText('Appearance')).toBeTruthy());

  expect(screen.queryByRole('heading', { name: 'Notifications', level: 3 })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Profile', level: 3 })).toBeNull();
});

it('/me/notifications shows the Notifications section only', async () => {
  renderAt('/me/notifications');

  await waitFor(() => expect(
    screen.getByRole('heading', { name: 'Notifications', level: 3 }),
  ).toBeTruthy());

  expect(screen.getByText('Weekly digest')).toBeTruthy();
  expect(screen.queryByText('Appearance')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Profile', level: 3 })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Notifications' }).getAttribute('aria-selected')).toBe('true');
});

it('clicking the Preferences tab navigates to /me/preferences', async () => {
  renderAt('/me');

  await waitFor(() => expect(screen.getByRole('tablist')).toBeTruthy());

  fireEvent.click(screen.getByRole('tab', { name: 'Preferences' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/me/preferences'));
  expect(screen.getByText('Appearance')).toBeTruthy();
});

it('hides the hero Edit details button on the Preferences tab', async () => {
  renderAt('/me/preferences');

  await waitFor(() => expect(screen.getByText('Appearance')).toBeTruthy());

  expect(screen.queryByText('Edit details')).toBeNull();
});

it('/me shows Profile, Security and Active sessions but not User history; /me/history shows only the history', async () => {
  renderAt('/me');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Profile', level: 3 })).toBeTruthy());
  expect(screen.getByRole('heading', { name: 'Security', level: 3 })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Active sessions', level: 3 })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'User history', level: 3 })).toBeNull();
  cleanup();
  renderAt('/me/history');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'User history', level: 3 })).toBeTruthy());
  expect(screen.queryByRole('heading', { name: 'Profile', level: 3 })).toBeNull();
  expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
});

it('Security shows Set up 2FA when not enrolled and the status when enrolled', async () => {
  renderAt('/me');
  expect(await screen.findByRole('button', { name: /set up 2fa/i })).toBeTruthy();
  auth.totp = { enrolled: true, enrolled_at: '2026-09-23T00:00:00Z', required: false, backup_codes_remaining: 3 };
  cleanup();
  renderAt('/me');
  expect(await screen.findByText(/3 backup codes left/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /regenerate backup codes/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /turn off/i })).toBeNull();
});
