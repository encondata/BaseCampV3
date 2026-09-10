// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../../lib/api';

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async () => true),
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
      notif: { critical: true, email: true, maint: true, digest: false, sound: 'chime' },
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

const { default: MePreferences } = await import('./MePreferences');

/** Scopes a query to the `set-row` whose label matches, since "Sidebar
 * text size" duplicates "List text size"'s Small/Default/Large/Extra
 * large button labels within the same page. */
const row = (label: string) => screen.getByText(label).closest('.set-row') as HTMLElement;

it('List text size row updates the preference', async () => {
  render(<MePreferences />);

  expect(screen.getByText('List text size')).toBeTruthy();

  fireEvent.click(within(row('List text size')).getByText('Extra large'));

  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ list_size: 'xlarge' }),
  ));
});

it('renders the three Navigation rows', () => {
  render(<MePreferences />);

  expect(screen.getByText('Sidebar')).toBeTruthy();
  expect(screen.getByText('Sidebar background')).toBeTruthy();
  expect(screen.getByText('Sidebar text size')).toBeTruthy();
});

it('Sidebar row updates nav_mode', async () => {
  render(<MePreferences />);

  fireEvent.click(screen.getByText('Rail'));

  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ nav_mode: 'rail' }),
  ));
});

it('Sidebar background row updates nav_bg from a named swatch', async () => {
  render(<MePreferences />);

  fireEvent.click(screen.getByRole('button', { name: 'Sidebar background: Navy' }));

  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ nav_bg: '#0f2a4a' }),
  ));
});

it('Sidebar background row updates nav_bg from the custom color input', async () => {
  render(<MePreferences />);

  fireEvent.change(screen.getByLabelText('Custom sidebar background'), {
    target: { value: '#123456' },
  });

  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ nav_bg: '#123456' }),
  ));
});

it('Sidebar background row resets nav_bg to default', async () => {
  render(<MePreferences />);

  fireEvent.click(screen.getByRole('button', { name: 'Sidebar background: Default' }));

  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ nav_bg: 'default' }),
  ));
});

it('Sidebar text size row updates nav_size', async () => {
  render(<MePreferences />);

  fireEvent.click(within(row('Sidebar text size')).getByText('Large'));

  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ nav_size: 'large' }),
  ));
});

it('shows the "saved" hint after a successful update', async () => {
  render(<MePreferences />);

  fireEvent.click(screen.getByText('Rail'));

  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
});
