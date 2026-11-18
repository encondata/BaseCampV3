// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: auth.can }) }));
vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import { grants, json, stubApi } from '../testing/fakeApi';
import DevicesPage from './DevicesPage';

const pad2 = (n: number) => String(n).padStart(2, '0');

function device(over: Record<string, unknown> = {}) {
  return {
    id: 'd-1', name: "Pat's iPhone", product: 'iPhone14,5', os_version: '18.1',
    added_by_name: 'Pat Admin', added_at: '2026-11-09T14:05:00Z', status: 'registered', error: null,
    ...over,
  };
}

const PAT = device();
const CREW = device({ id: 'd-2', name: 'Crew iPhone', status: 'failed', error: 'Apple refused this device.' });
const NEW = device({ id: 'd-3', name: 'New iPhone', status: 'pending' });
const OLD = device({ id: 'd-4', name: 'Old iPhone', status: 'disabled' });

function listing(syncedAt: string) {
  return {
    devices: [PAT, CREW, NEW, OLD],
    counts: [
      { device_class: 'IPHONE', count: 7, synced_at: syncedAt },
      { device_class: 'IPAD', count: 2, synced_at: syncedAt },
    ],
  };
}

function renderPage() {
  return render(<MemoryRouter><DevicesPage /></MemoryRouter>);
}

async function rowWith(text: string) {
  const cell = await screen.findByText(text);
  return cell.closest('tr') as HTMLElement;
}

beforeEach(() => {
  auth.can = grants('view', 'add', 'change', 'delete');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DevicesPage', () => {
  it('counts line renders', async () => {
    const synced = new Date();
    synced.setHours(9, 7, 0, 0);
    stubApi({ 'GET /api/devices': listing(synced.toISOString()) });
    renderPage();
    expect(await screen.findByText('iPhone 7 of 100 this membership year')).toBeTruthy();
    expect(screen.getByText('iPad 2 of 100 this membership year')).toBeTruthy();
    expect(screen.getByText('Last checked 09:07')).toBeTruthy();
  });

  it('an older check shows its date too', async () => {
    const synced = new Date(2026, 10, 2, 18, 45);
    stubApi({ 'GET /api/devices': listing(synced.toISOString()) });
    renderPage();
    expect(await screen.findByText('Last checked 2026-11-02 18:45')).toBeTruthy();
  });

  it('lists the iPhones with a status chip each', async () => {
    stubApi({ 'GET /api/devices': listing(new Date().toISOString()) });
    renderPage();
    const pat = await rowWith("Pat's iPhone");
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Name', 'Model', 'iOS', 'Added by', 'Added', 'Status', '']);
    expect(within(pat).getByText('iPhone14,5')).toBeTruthy();
    expect(within(pat).getByText('18.1')).toBeTruthy();
    expect(within(pat).getByText('Pat Admin')).toBeTruthy();
    const added = new Date(PAT.added_at);
    expect(within(pat).getByText(`${added.getFullYear()}-${pad2(added.getMonth() + 1)}-${pad2(added.getDate())}`)).toBeTruthy();
    expect(within(pat).getByText('Registered').className).toBe('chip c-green');
    expect(within(await rowWith('New iPhone')).getByText('Pending').className).toBe('chip c-amber');
    expect(within(await rowWith('Old iPhone')).getByText('Disabled').className).toBe('chip c-slate');
    const crew = await rowWith('Crew iPhone');
    expect(within(crew).getByText('Failed').className).toBe('chip c-red');
    expect(within(crew).getByText('Apple refused this device.')).toBeTruthy();
  });

  it('Disable shows review copy', async () => {
    const calls = stubApi({
      'GET /api/devices': listing(new Date().toISOString()),
      'POST /api/devices/d-1/disable': () => json(200, { ...PAT, status: 'disabled' }),
    });
    renderPage();
    const pat = await rowWith("Pat's iPhone");
    await userEvent.click(within(pat).getByRole('button', { name: 'Actions' }));
    await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Disable' }));
    const dialog = screen.getByRole('dialog', { name: "Disable Pat's iPhone?" });
    expect(within(dialog).getByText(
      "It can no longer install or update apps. Apple won't free its slot until the membership renews.",
    )).toBeTruthy();
    // nothing sent before the review is confirmed
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/devices/d-1/disable']);
    // the list is loaded again
    expect(calls.filter((c) => c.path === '/api/devices')).toHaveLength(2);
  });

  it('a disabled iPhone Apple never confirmed shows why', async () => {
    const why = "Apple didn't confirm disabling this iPhone, so Apple still lists it as enabled. "
      + "It's out of every profile here; disable it in Apple's developer site too.";
    stubApi({ 'GET /api/devices': { ...listing(new Date().toISOString()), devices: [{ ...OLD, error: why }] } });
    renderPage();
    const old = await rowWith('Old iPhone');
    expect(within(old).getByText('Disabled').className).toBe('chip c-slate');
    expect(within(old).getByText(why)).toBeTruthy();
  });

  it('an already disabled iPhone has no Disable', async () => {
    stubApi({ 'GET /api/devices': listing(new Date().toISOString()) });
    renderPage();
    const old = await rowWith('Old iPhone');
    expect(within(old).queryByRole('button', { name: 'Actions' })).toBeNull();
  });

  it('staff see no Disable', async () => {
    auth.can = grants('view');
    stubApi({ 'GET /api/devices': listing(new Date().toISOString()) });
    renderPage();
    const pat = await rowWith("Pat's iPhone");
    expect(within(pat).queryByRole('button', { name: 'Actions' })).toBeNull();
    expect(screen.queryByText('Disable')).toBeNull();
  });

  it('shows the API error when the list fails', async () => {
    stubApi({ 'GET /api/devices': () => json(503, { detail: { code: 'main_api_unavailable', message: 'Sign-in is unavailable right now.' } }) });
    renderPage();
    expect(await screen.findByText('Sign-in is unavailable right now.')).toBeTruthy();
  });
});
