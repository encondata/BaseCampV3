// @vitest-environment jsdom
/**
 * /stakeholders/clients (OrgDirectory) — narrow regression coverage for
 * security-fixes task 11b: `Organization.notes` is staff-internal (the
 * API nulls it on read and refuses a PATCH naming it with 403
 * notes_internal for any non-global actor), so the Edit modal must hide
 * the Notes field and leave `notes` out of the PATCH body for a scoped
 * client/vendor contact — otherwise their every edit would 403. Global
 * staff keep the field and still send it.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { UiPreferences } from '../lib/api';
import type { OrgItem } from '../lib/orgs';

const auth = vi.hoisted(() => ({ global: true }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    scope: { global: auth.global, client_ids: auth.global ? [] : ['c1'], partner_ids: [] },
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  listPartnerTypes: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: OrgDirectory } = await import('./OrgDirectory');

const ORG: OrgItem = {
  id: 'c1', name: 'Acme', code: null, partner_types: [], status: 'active',
  tier: 'preferred', service_region: null, phone: null, website: null,
  address_line1: null, address_line2: null, city: null, region: null,
  postal_code: null, country: 'US', notes: null,
  account_manager: null, contact_count: 0, logo_url: null, archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  api.listPartnerTypes.mockResolvedValue([]);
  api.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/clients' && !init?.method) return jsonResponse([ORG]);
    if (path === '/clients/c1/contacts') return jsonResponse([]);
    if (path === '/people') return jsonResponse([]);
    if (path === '/clients/c1' && init?.method === 'PATCH') return jsonResponse(ORG);
    return jsonResponse({ code: 'unexpected' }, 500);
  });
});

afterEach(cleanup);

async function openEditModal() {
  render(
    <MemoryRouter>
      <OrgDirectory cfg={{
        kind: 'client', apiBase: '/clients', title: 'Clients', blurb: '',
        addLabel: 'Add client', hasType: false,
      }} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(document.querySelector('.dir-row .row-main')).not.toBeNull());
  fireEvent.click(document.querySelector('.dir-row .row-main') as HTMLElement);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit client' }));
  await screen.findByRole('heading', { name: 'Edit Acme' });
  // scope to the modal — the expanded row's detail list and the column
  // picker also render the word "Notes"
  return within(document.querySelector('.modal-card') as HTMLElement);
}

function patchCall() {
  return api.apiFetch.mock.calls.find(
    ([path, init]) => path === '/clients/c1' && (init as RequestInit | undefined)?.method === 'PATCH');
}

function patchBody(): Record<string, unknown> {
  const call = patchCall();
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string);
}

it('scoped (non-global) contact: Edit modal has no Notes field and the PATCH omits notes', async () => {
  auth.global = false;
  const modal = await openEditModal();

  expect(modal.queryByText('Notes')).toBeNull();
  expect(modal.getByText('Phone')).not.toBeNull();   // the modal did render its fields

  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(patchCall()).toBeDefined());
  const body = patchBody();
  expect('notes' in body).toBe(false);
  expect(body.name).toBe('Acme');   // the rest of the payload is intact
});

it('global staff: Edit modal keeps the Notes field and the PATCH sends notes', async () => {
  auth.global = true;
  const modal = await openEditModal();

  const notes = modal.getByText('Notes').parentElement!.querySelector('input') as HTMLInputElement;
  expect(notes).not.toBeNull();
  fireEvent.change(notes, { target: { value: 'late payer' } });

  fireEvent.click(modal.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(patchCall()).toBeDefined());
  expect(patchBody().notes).toBe('late payer');
});

it('Clients list: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(
    <MemoryRouter>
      <OrgDirectory cfg={{
        kind: 'client', apiBase: '/clients', title: 'Clients', blurb: '',
        addLabel: 'Add client', hasType: false,
      }} />
    </MemoryRouter>,
  );
  const row = (await screen.findByText('Acme')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(1176);
});
