// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ roles: ['admin', 'viewer'], person: { id: 'p1' }, totp: null }),
}));
vi.mock('@portal/lib/api', async (orig) => ({
  ...(await orig<typeof import('@portal/lib/api')>()),
  getProfileRequest: vi.fn(),
}));
vi.mock('@portal/pages/me/MePreferences', () => ({
  default: ({ appName }: { appName?: string }) => <div>preferences for {appName}</div>,
}));
vi.mock('./MeProfile', () => ({
  default: ({ editing }: { editing: boolean }) => <div>profile tab{editing ? ' editing' : ''}</div>,
}));
vi.mock('./MeHistory', () => ({ default: () => <div>history tab</div> }));

import * as api from '@portal/lib/api';

import MeLayout from './MeLayout';

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/me/*" element={<><MeLayout /><Where /></>} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.mocked(api.getProfileRequest).mockResolvedValue({
    id: 'p1', first_name: 'Ada', last_name: 'Lovelace', preferred_name: null,
    display_name: 'Ada Lovelace', email: 'ada@contact.co', phone: '555-0100', job_title: null,
    address_line1: null, address_line2: null, city: 'London', region: 'Greater London',
    postal_code: null, country: 'GB', badge_uid: null as unknown as string,
    created_at: '2026-01-01T00:00:00Z', avatar_key: null, avatar_url: null,
    password_updated_at: null, login_email: 'ada@login.co', source: 'local',
  } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('renders the hero with initials, title, roles and contact line', async () => {
  renderAt('/me');
  expect(await screen.findByRole('heading', { name: /Ada Lovelace/ })).toBeTruthy();
  expect(screen.getByText('Account')).toBeTruthy();
  expect(screen.getByText('AL')).toBeTruthy();
  expect(screen.getByText('No title set · admin, viewer')).toBeTruthy();
  expect(screen.getByText(/ada@contact\.co/)).toBeTruthy();
  expect(screen.getByText(/555-0100/)).toBeTruthy();
  expect(screen.getByText(/London, Greater London/)).toBeTruthy();
});

it('routes between the Profile, Preferences and History tabs', async () => {
  renderAt('/me');
  expect(await screen.findByText('profile tab')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected')).toBe('true');

  await userEvent.click(screen.getByRole('tab', { name: 'Preferences' }));
  expect(screen.getByTestId('where').textContent).toBe('/me/preferences');
  expect(screen.getByText('preferences for Sirdar')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();

  await userEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(screen.getByTestId('where').textContent).toBe('/me/history');
  expect(screen.getByText('history tab')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
});

it('Edit details on the Profile tab puts the profile into edit mode', async () => {
  renderAt('/me');
  await userEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
  await waitFor(() => expect(screen.getByText('profile tab editing')).toBeTruthy());
});

it('opens directly on a deep-linked tab', async () => {
  renderAt('/me/history');
  expect(await screen.findByText('history tab')).toBeTruthy();
});
