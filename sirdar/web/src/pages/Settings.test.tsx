// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ deploy: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string) => r === 'settings' || (r === 'deploy' && perms.deploy) }),
}));
const api = vi.hoisted(() => ({ getSettings: vi.fn(), getIntegrations: vi.fn() }));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import Settings from './Settings';
import { INTEGRATIONS } from './environments/testData';

beforeEach(() => {
  perms.deploy = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getSettings.mockResolvedValue({ env: 'production', source_configured: true, session_ttl_seconds: 86400,
    access_token_ttl_seconds: 900, max_failed_logins: 10, lockout_seconds: 900 });
  api.getIntegrations.mockResolvedValue(INTEGRATIONS);
});
afterEach(cleanup);

it('shows Integrations to deploy readers', async () => {
  render(<Settings />);
  expect(await screen.findByRole('heading', { name: 'Integrations' })).toBeTruthy();
});

it('hides Integrations from people without deploy access', async () => {
  perms.deploy = false;
  render(<Settings />);
  expect(await screen.findByText('production')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Integrations' })).toBeNull();
  expect(api.getIntegrations).not.toHaveBeenCalled();
});
