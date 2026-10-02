// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  roles: ['admin'],
  person: { id: 'p1', display_name: 'Ada Lovelace', email: 'ada@x.co' },
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 } as {
    enrolled: boolean; enrolled_at: string | null; required: boolean; backup_codes_remaining: number;
  },
  applyTotp: vi.fn(),
  applyProfile: vi.fn(),
  clearMustChange: vi.fn(),
  passwordMinLength: 8,
  passwordExpiresAt: null,
}));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@portal/lib/api', async (orig) => ({
  ...(await orig<typeof import('@portal/lib/api')>()),
  getSessionsRequest: vi.fn(),
  revokeSessionRequest: vi.fn(),
  updateProfileRequest: vi.fn(),
}));

vi.mock('@portal/components/ChangePasswordForm', () => ({
  default: ({ onSuccess }: { onSuccess: () => void }) => <button type="button" onClick={onSuccess}>mock pw done</button>,
}));
vi.mock('@portal/components/totp/TotpEnrollModal', () => ({
  default: ({ onEnrolled }: { onEnrolled: (n: number) => void }) => <button type="button" onClick={() => onEnrolled(10)}>mock enroll done</button>,
}));
vi.mock('@portal/components/totp/RegenerateCodesModal', () => ({
  default: ({ onRegenerated }: { onRegenerated: (n: number) => void }) => <button type="button" onClick={() => onRegenerated(9)}>mock regen done</button>,
}));

import * as api from '@portal/lib/api';
import { ApiError } from '@portal/lib/api';

import type { SirdarProfile } from '../../lib/sirdarApi';
import MeProfile from './MeProfile';

const profile = (over: Partial<SirdarProfile> = {}): SirdarProfile => ({
  id: 'p1', first_name: 'Ada', last_name: 'Lovelace', preferred_name: null,
  display_name: 'Ada Lovelace', email: 'ada@contact.co', phone: null, job_title: 'Engineer',
  address_line1: null, address_line2: null, city: 'London', region: null, postal_code: null,
  country: 'GB', badge_uid: null as unknown as string, created_at: '2026-01-01T00:00:00Z',
  avatar_key: null, avatar_url: null, password_updated_at: '2026-02-01T00:00:00Z',
  login_email: 'ada@login.co', source: 'local', ...over,
});

const sessions = [
  { family_id: 'f-current', started_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z', ip_address: '10.0.0.1', user_agent: 'Mozilla/5.0 (Macintosh; Mac OS X) Chrome/120', current: true },
  { family_id: 'f-other', started_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z', ip_address: '10.0.0.2', user_agent: 'Mozilla/5.0 (Windows) Firefox/120', current: false },
];

function Harness({ initial }: { initial: SirdarProfile }) {
  const [p, setP] = useState(initial);
  const [editing, setEditing] = useState(false);
  return <MeProfile profile={p} onProfile={setP} editing={editing} onEditingChange={setEditing} />;
}

beforeEach(() => {
  auth.totp = { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 };
  vi.mocked(api.getSessionsRequest).mockResolvedValue(sessions);
  vi.mocked(api.revokeSessionRequest).mockResolvedValue();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const security = () => screen.getByRole('heading', { name: 'Security' }).closest('.panel') as HTMLElement;

it('a local user gets Change password and Set up 2FA buttons', async () => {
  render(<Harness initial={profile()} />);
  const panel = security();
  expect(within(panel).getByRole('button', { name: 'Change password' })).toBeTruthy();
  expect(within(panel).getByRole('button', { name: 'Set up 2FA' })).toBeTruthy();
  expect(within(panel).getByText(/Last changed/)).toBeTruthy();
  expect(within(panel).queryByText('Managed in the portal')).toBeNull();
  await waitFor(() => expect(api.getSessionsRequest).toHaveBeenCalled());
});

it('a local user with 2FA on sees backup codes and Regenerate', async () => {
  auth.totp = { enrolled: true, enrolled_at: '2026-03-01T00:00:00Z', required: false, backup_codes_remaining: 7 };
  render(<Harness initial={profile()} />);
  const panel = security();
  expect(within(panel).getByText(/On since/)).toBeTruthy();
  expect(within(panel).getByText('7 backup codes left')).toBeTruthy();
  expect(within(panel).getByRole('button', { name: 'Regenerate backup codes' })).toBeTruthy();
  await waitFor(() => expect(api.getSessionsRequest).toHaveBeenCalled());
});

it('a portal user sees read-only security rows managed in the portal', async () => {
  render(<Harness initial={profile({ source: 'portal' })} />);
  const panel = security();
  expect(within(panel).queryByRole('button')).toBeNull();
  expect(within(panel).getAllByText('Managed in the portal')).toHaveLength(2);
  expect(within(panel).getByText('Off')).toBeTruthy();
  expect(screen.getByText(/The next import from the portal overwrites these/)).toBeTruthy();
  await waitFor(() => expect(api.getSessionsRequest).toHaveBeenCalled());
});

it('shows the sign-in email read-only', async () => {
  render(<Harness initial={profile()} />);
  expect(screen.getByText('ada@login.co')).toBeTruthy();
  await waitFor(() => expect(api.getSessionsRequest).toHaveBeenCalled());
});

it('the profile edit sends only the changed fields, blank as null, then applies the profile', async () => {
  const updated = profile({ job_title: null, phone: '555-1234' });
  vi.mocked(api.updateProfileRequest).mockResolvedValue(updated);
  render(<Harness initial={profile()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Sign-in email')).toHaveProperty('readOnly', true);
  await userEvent.clear(screen.getByLabelText('Job title'));
  await userEvent.type(screen.getByLabelText('Phone'), '555-1234');
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(api.updateProfileRequest).toHaveBeenCalledTimes(1));
  expect(api.updateProfileRequest).toHaveBeenCalledWith({ job_title: null, phone: '555-1234' });
  expect(auth.applyProfile).toHaveBeenCalledWith(updated);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
});

it('maps a {field}_required error and falls back for anything else', async () => {
  vi.mocked(api.updateProfileRequest)
    .mockRejectedValueOnce(new ApiError(422, 'first_name_required'))
    .mockRejectedValueOnce(new ApiError(422, 'something_else'));
  render(<Harness initial={profile()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  await userEvent.clear(screen.getByLabelText('First name *'));
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('First name is required.')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText('Could not save — check the fields and try again.')).toBeTruthy();
});

it('signs out the non-current session and refreshes the list', async () => {
  render(<Harness initial={profile()} />);
  expect(await screen.findByText('2 live')).toBeTruthy();
  const current = screen.getByText('Current').closest('.session-item') as HTMLElement;
  expect(within(current).queryByRole('button', { name: 'Sign out' })).toBeNull();
  vi.mocked(api.getSessionsRequest).mockResolvedValue([sessions[0]]);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(api.revokeSessionRequest).toHaveBeenCalledWith('f-other'));
  expect(await screen.findByText('1 live')).toBeTruthy();
  expect(api.getSessionsRequest).toHaveBeenCalledTimes(2);
});

it('a failed sign-out shows an alert and still re-fetches', async () => {
  vi.mocked(api.revokeSessionRequest).mockRejectedValue(new Error('boom'));
  render(<Harness initial={profile()} />);
  await screen.findByText('2 live');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe("Couldn't sign that session out.");
  await waitFor(() => expect(api.getSessionsRequest).toHaveBeenCalledTimes(2));
});

it('a failed sessions load says so instead of "No live sessions"', async () => {
  vi.mocked(api.getSessionsRequest).mockRejectedValue(new Error('down'));
  render(<Harness initial={profile()} />);
  expect(await screen.findByText("Couldn't load sessions.")).toBeTruthy();
  expect(screen.queryByText('No live sessions found.')).toBeNull();
});

it('a successful password change clears must-change, re-fetches sessions and shows the chip', async () => {
  render(<Harness initial={profile()} />);
  await screen.findByText('2 live');
  await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
  await userEvent.click(screen.getByRole('button', { name: 'mock pw done' }));
  expect(auth.clearMustChange).toHaveBeenCalled();
  await waitFor(() => expect(api.getSessionsRequest).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/changed — other sessions signed out/)).toBeTruthy();
});

it('applyTotp is called after enrolling', async () => {
  render(<Harness initial={profile()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Set up 2FA' }));
  await userEvent.click(screen.getByRole('button', { name: 'mock enroll done' }));
  expect(auth.applyTotp).toHaveBeenCalledWith(expect.objectContaining({ enrolled: true, backup_codes_remaining: 10 }));
});

it('applyTotp is called after regenerating backup codes', async () => {
  auth.totp = { enrolled: true, enrolled_at: '2026-03-01T00:00:00Z', required: false, backup_codes_remaining: 7 };
  render(<Harness initial={profile()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Regenerate backup codes' }));
  await userEvent.click(screen.getByRole('button', { name: 'mock regen done' }));
  expect(auth.applyTotp).toHaveBeenCalledWith(expect.objectContaining({ backup_codes_remaining: 9 }));
});
