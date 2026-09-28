// @vitest-environment jsdom
/**
 * Task 11: read-only "Spec lookup" tab in Developer › System Config —
 * config with the API key masked, worker health, and a Test connection
 * button. Follows the module-mocking idiom used by EnvTab.test.tsx rather
 * than the brief's vi.spyOn(api, ...) sketch, since this repo's vitest
 * setup doesn't register jest-dom matchers or support spying directly on
 * the real ESM module's named exports.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { SpecLookupDev } from '../../lib/api';

const api = vi.hoisted(() => ({
  getSpecLookupDev: vi.fn(),
  testSpecLookup: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: SpecLookupTab } = await import('./SpecLookupTab');

const DEV: SpecLookupDev = {
  model: 'claude-sonnet-5', max_searches: 4, max_fetches: 3,
  key_set: true, key_last4: 'a1b2', worker_status: 'running', worker_heartbeat_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSpecLookupDev.mockResolvedValue(DEV);
});

afterEach(cleanup);

it('shows config with the key masked', async () => {
  render(<SpecLookupTab />);
  expect(await screen.findByText('claude-sonnet-5')).toBeTruthy();
  expect(screen.getByText('Set (…a1b2)')).toBeTruthy();
  expect(screen.getByText('running')).toBeTruthy();
});

it('says not set and still allows a test', async () => {
  const user = userEvent.setup();
  api.getSpecLookupDev.mockResolvedValue({ ...DEV, key_set: false, key_last4: null });
  api.testSpecLookup.mockResolvedValue({ ok: false, latency_ms: null, error: 'not_configured' });
  render(<SpecLookupTab />);
  expect(await screen.findByText('Not set')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  expect(await screen.findByText(/not_configured/)).toBeTruthy();
});

it('reports a successful test with latency', async () => {
  const user = userEvent.setup();
  api.testSpecLookup.mockResolvedValue({ ok: true, latency_ms: 812, error: null });
  render(<SpecLookupTab />);
  await user.click(await screen.findByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(screen.getByText(/Connected in 812 ms/)).toBeTruthy());
});
