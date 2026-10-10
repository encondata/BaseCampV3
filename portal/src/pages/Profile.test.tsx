// @vitest-environment jsdom
/**
 * /me tab strip: Profile vs Preferences (see
 * docs/superpowers/specs/2026-09-10-me-preferences-design.md). The
 * Preferences tab renders MePreferences.tsx for real (not mocked) — both
 * modules import '../auth/AuthContext' from the same resolved path, so
 * mocking it once here covers both.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { PersonDetail, TotpStatus, TrustedBrowser, UiPreferences } from '../lib/api';

type TB = TrustedBrowser;

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async () => true),
  applyProfile: vi.fn(),
  applyTotp: vi.fn(),
  clearMustChange: vi.fn(),
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 } as TotpStatus,
  person: { email: 'ada@test.example.com' },
}));

const api = vi.hoisted(() => ({
  getProfileRequest: vi.fn(),
  getSessionsRequest: vi.fn(async () => []),
  getMyActivityRequest: vi.fn(async () => []),
  revokeSessionRequest: vi.fn(async () => {}),
  updateProfileRequest: vi.fn(),
  listMyTrustedBrowsers: vi.fn(async () => ({ trust_days: 7, browsers: [] as TB[] })),
  forgetMyTrustedBrowser: vi.fn(async () => {}),
  forgetAllMyTrustedBrowsers: vi.fn(async () => {}),
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
    clearMustChange: auth.clearMustChange,
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
      list_view: 'expanded',
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
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
  api.listMyTrustedBrowsers.mockImplementation(async () => ({ trust_days: 7, browsers: [] }));
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

  expect(screen.getByText('Approvals & requests')).toBeTruthy();
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

const ENROLLED: TotpStatus = {
  enrolled: true, enrolled_at: '2026-09-23T00:00:00Z', required: false, backup_codes_remaining: 3,
};

function iso(msAgo: number) {
  return new Date(Date.now() - msAgo).toISOString();
}

const MAC: TB = {
  id: 'tb1', user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
  created_at: iso(2 * 86_400_000), last_used_at: iso(3_600_000),
  expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), current: true,
};
const PHONE: TB = {
  id: 'tb2', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1',
  created_at: iso(4 * 86_400_000), last_used_at: null,
  expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), current: false,
};

it('Remembered browsers sits directly under Active sessions with rows, chip, hint and header', async () => {
  auth.totp = ENROLLED;
  api.listMyTrustedBrowsers.mockImplementation(async () => ({ trust_days: 7, browsers: [MAC, PHONE] }));
  renderAt('/me');
  const heading = await screen.findByRole('heading', { name: 'Remembered browsers', level: 3 });
  const sessions = screen.getByRole('heading', { name: 'Active sessions', level: 3 });
  // document order: Active sessions first, Remembered browsers right after
  expect(sessions.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const panel = heading.closest('.panel') as HTMLElement;
  expect(panel.closest('.profile-full')?.previousElementSibling).toBe(sessions.closest('.profile-full'));
  expect(within(panel).getByText('2 remembered')).toBeTruthy();
  expect(within(panel).getByText('This browser')).toBeTruthy();
  expect(within(panel).getAllByRole('button', { name: 'Forget' })).toHaveLength(2);
  expect(within(panel).getByRole('button', { name: 'Forget all' })).toBeTruthy();
  expect(within(panel).getByText(/remembered 2d ago · last used 1h ago · expires in 5d/)).toBeTruthy();
  expect(within(panel).getByText(/never used/)).toBeTruthy();
  expect(within(panel).getByText(
    'A remembered browser skips the two-factor code for 7 days. Forget one to ask for the code again.',
  )).toBeTruthy();
});

it('Forget on a row calls the API with that id and drops the row, no confirm', async () => {
  auth.totp = ENROLLED;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.listMyTrustedBrowsers.mockImplementation(async () => ({ trust_days: 7, browsers: [MAC, PHONE] }));
  renderAt('/me');
  const panel = (await screen.findByRole('heading', { name: 'Remembered browsers', level: 3 })).closest('.panel') as HTMLElement;
  fireEvent.click(within(panel).getAllByRole('button', { name: 'Forget' })[1]);
  await waitFor(() => expect(api.forgetMyTrustedBrowser).toHaveBeenCalledWith('tb2'));
  await waitFor(() => expect(within(panel).getAllByRole('button', { name: 'Forget' })).toHaveLength(1));
  expect(within(panel).getByText('1 remembered')).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  confirm.mockRestore();
});

it('Forget all asks first; cancel does nothing, OK clears the list and shows the empty note', async () => {
  auth.totp = ENROLLED;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  api.listMyTrustedBrowsers.mockImplementation(async () => ({ trust_days: 7, browsers: [MAC, PHONE] }));
  renderAt('/me');
  const panel = (await screen.findByRole('heading', { name: 'Remembered browsers', level: 3 })).closest('.panel') as HTMLElement;
  fireEvent.click(within(panel).getByRole('button', { name: 'Forget all' }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(
    'Forget every remembered browser? Each one will ask for the two-factor code again.',
  );
  expect(api.forgetAllMyTrustedBrowsers).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(within(panel).getByRole('button', { name: 'Forget all' }));
  await waitFor(() => expect(api.forgetAllMyTrustedBrowsers).toHaveBeenCalledTimes(1));
  expect(await within(panel).findByText(
    'No remembered browsers. When you tick Remember this browser at the code step, it shows up here.',
  )).toBeTruthy();
  expect(within(panel).queryByRole('button', { name: 'Forget all' })).toBeNull();
  confirm.mockRestore();
});

it('an enrolled person with no remembered browsers sees the empty note', async () => {
  auth.totp = ENROLLED;
  renderAt('/me');
  expect(await screen.findByText(
    'No remembered browsers. When you tick Remember this browser at the code step, it shows up here.',
  )).toBeTruthy();
  expect(screen.getByText('0 remembered')).toBeTruthy();
});

it('Remembered browsers is hidden when not enrolled and no rows, shown when not enrolled but rows exist', async () => {
  renderAt('/me');
  await screen.findByRole('heading', { name: 'Active sessions', level: 3 });
  await waitFor(() => expect(api.listMyTrustedBrowsers).toHaveBeenCalled());
  expect(screen.queryByRole('heading', { name: 'Remembered browsers', level: 3 })).toBeNull();
  cleanup();
  api.listMyTrustedBrowsers.mockImplementation(async () => ({ trust_days: 7, browsers: [PHONE] }));
  renderAt('/me');
  expect(await screen.findByRole('heading', { name: 'Remembered browsers', level: 3 })).toBeTruthy();
});

it('a failed Forget shows an inline error and keeps the row; a failed Forget all keeps the list', async () => {
  auth.totp = ENROLLED;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.listMyTrustedBrowsers.mockImplementation(async () => ({ trust_days: 7, browsers: [MAC, PHONE] }));
  api.forgetMyTrustedBrowser.mockRejectedValueOnce(new Error('network'));
  renderAt('/me');
  const panel = (await screen.findByRole('heading', { name: 'Remembered browsers', level: 3 })).closest('.panel') as HTMLElement;
  fireEvent.click(within(panel).getAllByRole('button', { name: 'Forget' })[0]);
  const err = await within(panel).findByRole('alert');
  expect(err.textContent).toBe('Could not forget the browsers. Try again.');
  expect(err.className).toContain('pf-error');
  expect(within(panel).getAllByRole('button', { name: 'Forget' })).toHaveLength(2);
  // a retry clears the message
  fireEvent.click(within(panel).getAllByRole('button', { name: 'Forget' })[0]);
  await waitFor(() => expect(within(panel).queryByRole('alert')).toBeNull());
  expect(within(panel).getAllByRole('button', { name: 'Forget' })).toHaveLength(1);
  api.forgetAllMyTrustedBrowsers.mockRejectedValueOnce(new Error('network'));
  fireEvent.click(within(panel).getByRole('button', { name: 'Forget all' }));
  expect((await within(panel).findByRole('alert')).textContent).toBe('Could not forget the browsers. Try again.');
  expect(within(panel).getAllByRole('button', { name: 'Forget' })).toHaveLength(1);
  confirm.mockRestore();
});
