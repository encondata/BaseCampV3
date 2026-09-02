// @vitest-environment jsdom
/**
 * Home (/) — covers just the client-anchored redirect. The rest of the
 * page's panels are exercised in the browser/manually; this file only
 * asserts that a client-scoped user is bounced to /dashboards/clients
 * while a global user renders Home normally.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { ScopeInfo } from '../lib/access';

const auth = vi.hoisted(() => {
  const state: {
    can: (resource: string, action?: string) => boolean;
    mustChangePassword: boolean;
    scope: ScopeInfo | null;
  } = {
    can: () => false,
    mustChangePassword: false,
    scope: null,
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    mustChangePassword: auth.mustChangePassword,
    scope: auth.scope,
  }),
}));

const api = vi.hoisted(() => ({
  listAssets: vi.fn(() => new Promise(() => {})),
  listAssetStatuses: vi.fn(() => new Promise(() => {})),
  listAuditLog: vi.fn(() => new Promise(() => {})),
  listContainers: vi.fn(() => new Promise(() => {})),
  listInitiativeAssets: vi.fn(() => new Promise(() => {})),
  listInitiatives: vi.fn(() => new Promise(() => {})),
  listProcessedScans: vi.fn(() => new Promise(() => {})),
  listScanDailyStats: vi.fn(() => new Promise(() => {})),
  listSites: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: Home } = await import('./Home');

afterEach(() => {
  cleanup();
  auth.can = () => false;
  auth.mustChangePassword = false;
  auth.scope = null;
});

it('client-anchored users are redirected to the client dashboard', async () => {
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboards/clients" element={<div>CLIENT DASH</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText('CLIENT DASH')).not.toBeNull());
});

it('global users render Home normally', async () => {
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText('CLIENT DASH')).toBeNull());
});
