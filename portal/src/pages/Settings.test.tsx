// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getAdminConfig: vi.fn(),
  updateAdminConfig: vi.fn(),
  refreshSystemStatus: vi.fn(),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  ...api,
}));

const auth = vi.hoisted(() => ({ can: vi.fn(() => true) }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

const base = { read_only: false, read_only_message: '', pause_workers: false,
               banner_enabled: false, banner_message: '' };

beforeEach(() => {
  vi.clearAllMocks();
  auth.can.mockReturnValue(true);
  api.getAdminConfig.mockResolvedValue({ ...base });
  api.updateAdminConfig.mockImplementation(async (patch) => ({ ...base, ...patch }));
});
afterEach(cleanup);

const { default: Settings } = await import('./Settings');

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {['/settings', '/settings/security', '/settings/maintenance', '/settings/about'].map((p) => (
          <Route key={p} path={p} element={<Settings />} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}

const switches = () => screen.getAllByRole('checkbox') as HTMLInputElement[];

it('renders "System settings" and Administration', async () => {
  renderAt('/settings');
  expect(screen.getByText('System settings')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Administration', level: 3 })).toBeTruthy();
  await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());
});

it('shows the read-only hint and disables every switch when change is not allowed', async () => {
  auth.can.mockReturnValue(false);
  renderAt('/settings');
  await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());

  expect(screen.getByText(/Read-only — you can see the current state/)).toBeTruthy();
  for (const sw of switches()) expect(sw.disabled).toBe(true);
});

it('enables the switches when change is allowed', async () => {
  // read_only: true so the pause-workers switch (independently gated on
  // read-only being on) is enabled too, isolating the canChange effect.
  api.getAdminConfig.mockResolvedValue({ ...base, read_only: true });
  renderAt('/settings');
  await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());

  expect(screen.queryByText(/Read-only — you can see the current state/)).toBeNull();
  for (const sw of switches()) expect(sw.disabled).toBe(false);
});

it('contains no Appearance, Notifications, or Account content', async () => {
  renderAt('/settings');
  await waitFor(() => expect(api.getAdminConfig).toHaveBeenCalled());

  expect(screen.queryByText('Appearance')).toBeNull();
  expect(screen.queryByText('Notifications')).toBeNull();
  expect(screen.queryByText('Account')).toBeNull();
});

it('shows four tabs; placeholder tabs render their placeholder card instead of Administration', async () => {
  renderAt('/settings');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Administration', 'Security', 'Maintenance', 'About']);
  expect(screen.getByRole('tab', { name: 'Administration' }).getAttribute('aria-selected')).toBe('true');
  cleanup();
  renderAt('/settings/maintenance');
  expect(screen.getByRole('tab', { name: 'Maintenance' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Maintenance', level: 3 })).toBeTruthy();
  expect(screen.getByText(/placeholder/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Administration', level: 3 })).toBeNull();
});
