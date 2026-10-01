// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const seen: Record<string, unknown>[] = [];
vi.mock('@portal/pages/Login', () => ({
  default: (props: Record<string, unknown>) => { seen.push(props); return <div>{props.notice as never}</div>; },
}));

import SirdarLogin, { SIRDAR_ERRORS } from './SirdarLogin';

afterEach(() => { cleanup(); seen.length = 0; vi.unstubAllGlobals(); });

it('brands the shared Login and maps Sirdar-only codes', () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ needs_setup: false }) }));
  render(<SirdarLogin />);
  expect(seen[0].eyebrow).toBe('Sirdar');
  expect(seen[0].extraErrors).toBe(SIRDAR_ERRORS);
  expect(SIRDAR_ERRORS.password_change_required).toMatch(/portal/);
  expect(SIRDAR_ERRORS.totp_enrollment_required).toMatch(/portal/);
});

it('shows first-run instructions when Sirdar has no users', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ needs_setup: true }) }));
  render(<SirdarLogin />);
  await waitFor(() => expect(screen.getByText(/sirdar create-admin/)).toBeTruthy());
});
