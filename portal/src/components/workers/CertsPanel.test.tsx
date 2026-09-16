// @vitest-environment jsdom
/**
 * CertsPanel — the worker profile's certifications list. Narrow
 * regression coverage for the date-only off-by-one: `issued_on` and
 * `expires_on` are true DATE columns (bare "YYYY-MM-DD", not a
 * TIMESTAMP), so `longDate` (built on `new Date(iso)`) parses them as
 * UTC midnight and names the day before anywhere west of UTC — and
 * `certState`'s expired/expiring check has the same root cause, since it
 * also diffs off a naive `new Date(c.expires_on)`.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true }),
}));

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: CertsPanel } = await import('./CertsPanel');

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('renders issued/expires on the picked calendar day, not the evening before, west of UTC', async () => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/Denver';
  try {
    api.apiFetch.mockResolvedValue(jsonResponse([
      { id: 'cert-1', name: 'OSHA 30', issuer: 'OSHA', issued_on: '2026-01-05', expires_on: '2026-06-05' },
    ]));
    render(<CertsPanel personId="p1" onChanged={() => {}} />);

    expect(await screen.findByText(/issued Jan 5, 2026/)).toBeTruthy();
    expect(await screen.findByText(/expires Jun 5, 2026/)).toBeTruthy();
    expect(screen.queryByText(/Jan 4, 2026/)).toBeNull();
    expect(screen.queryByText(/Jun 4, 2026/)).toBeNull();
  } finally {
    process.env.TZ = prevTz;
  }
});

it('classifies expiry against the local calendar day, not a UTC-midnight instant', async () => {
  // 2026-01-05T02:00:00Z is 2026-01-04, 7pm in America/Denver (UTC-7,
  // no DST in January). A cert expiring on the picked local day
  // "2026-01-05" has not expired yet at that real moment — but reading
  // expires_on as UTC midnight (`new Date('2026-01-05')` = 2026-01-05
  // 00:00 UTC) puts that instant 2 hours in the PAST, misreporting the
  // cert as already expired.
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/Denver';
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-05T02:00:00Z'));
  try {
    api.apiFetch.mockResolvedValue(jsonResponse([
      { id: 'cert-1', name: 'OSHA 30', issuer: 'OSHA', issued_on: null, expires_on: '2026-01-05' },
    ]));
    render(<CertsPanel personId="p1" onChanged={() => {}} />);

    await screen.findByText('OSHA 30');
    expect(screen.queryByText('expired')).toBeNull();
    expect(screen.getByText('expiring')).toBeTruthy();
  } finally {
    nowSpy.mockRestore();
    process.env.TZ = prevTz;
  }
});
