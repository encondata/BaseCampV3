// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: auth.can }) }));
const viewer = vi.hoisted(() => ({
  platform: 'desktop' as 'android' | 'ios' | 'desktop',
  device: 'iPhone' as 'iPad' | 'iPhone',
}));
vi.mock('../lib/platform', () => ({ viewerPlatform: () => viewer.platform, viewerDevice: () => viewer.device }));
vi.mock('../lib/goTo', () => ({ goTo: vi.fn() }));
vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import { goTo } from '../lib/goTo';
import { androidApp, grants, json, stubApi, version, type ApiCall } from '../testing/fakeApi';
import AppDetailPage from './AppDetailPage';

const CURRENT = version({ id: 'v-2', version_name: '0.1.1', build: '2', is_current: true, notes: 'QR label changes' });
const OLDER = version({ id: 'v-1', version_name: '0.1.0', build: '1', is_current: false, notes: 'First build', uploaded_at: '2026-11-01T08:30:00Z' });

function detail(versions = [CURRENT, OLDER]) {
  const current = versions.find((v) => v.is_current) ?? null;
  return { ...androidApp({ current }), versions };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/apps/app-a']}>
      <Routes><Route path="/apps/:id" element={<AppDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

/** The versions table row holding `text`. */
async function rowWith(text: string) {
  const cell = await screen.findByText(text);
  return cell.closest('tr') as HTMLElement;
}

async function openActions(versionName: string) {
  const row = await rowWith(versionName);
  await userEvent.click(within(row).getByRole('button', { name: 'Actions' }));
  return screen.getByRole('menu');
}

const writes = (calls: ApiCall[]) => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  auth.can = grants('view', 'add', 'change', 'delete');
  viewer.platform = 'desktop';
  vi.mocked(goTo).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppDetailPage', () => {
  it('shows the app and its versions as a list', async () => {
    stubApi({ 'GET /api/apps/app-a': detail() });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'ServerSherpa Kiosk' })).toBeTruthy();
    expect(screen.getByText('Android · com.serversherpa.kiosk')).toBeTruthy();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Version', 'Build', 'Uploaded', 'By', 'Size', 'Notes', 'Current', '']);
    const current = await rowWith('0.1.1');
    expect(within(current).getByText('Current').className).toBe('chip c-green');
    const older = await rowWith('0.1.0');
    expect(within(older).queryByText('Current')).toBeNull();
    expect(within(older).getByText('First build')).toBeTruthy();
    expect(within(older).getByText(/^2026-11-0[01] \d{2}:30$/)).toBeTruthy();
    expect(within(older).getByText('J. Henderson')).toBeTruthy();
  });

  it('Delete action disabled on current version', async () => {
    const calls = stubApi({
      'GET /api/apps/app-a': detail(),
      'DELETE /api/versions/v-1': () => json(204, null),
    });
    renderPage();
    let menu = await openActions('0.1.1');
    const del = within(menu).getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(within(menu).getByText('Make another version current first')).toBeTruthy();
    // the current version can't be made current again
    expect(within(menu).queryByRole('menuitem', { name: 'Make current' })).toBeNull();
    await userEvent.keyboard('{Escape}');

    menu = await openActions('0.1.0');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete 0.1.0 (1)?' });
    expect(writes(calls)).toEqual([]);   // a review first
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(calls)).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/versions/v-1' })]);
    expect(calls.filter((c) => c.path === '/api/apps/app-a')).toHaveLength(2);   // refreshed
  });

  it('Make current shows review then calls the endpoint', async () => {
    let made = false;
    const calls = stubApi({
      'GET /api/apps/app-a': () => json(200, made
        ? detail([{ ...CURRENT, is_current: false }, { ...OLDER, is_current: true }])
        : detail()),
      'POST /api/versions/v-1/make-current': () => { made = true; return json(200, { ...OLDER, is_current: true }); },
    });
    renderPage();
    const menu = await openActions('0.1.0');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Make current' }));
    const dialog = screen.getByRole('dialog', { name: 'Make 0.1.0 (1) current?' });
    expect(within(dialog).getByText(
      'New installs get this version. Phones that already have a newer version keep it.',
    )).toBeTruthy();
    expect(writes(calls)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make current' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(calls)).toEqual([expect.objectContaining({ method: 'POST', path: '/api/versions/v-1/make-current' })]);
    const older = await rowWith('0.1.0');
    await waitFor(() => expect(within(older).getByText('Current')).toBeTruthy());
  });

  it('edits a version\'s notes', async () => {
    const calls = stubApi({
      'GET /api/apps/app-a': detail(),
      'PATCH /api/versions/v-1': (c: ApiCall) => json(200, { ...OLDER, notes: (c.body as { notes: string }).notes }),
    });
    renderPage();
    const menu = await openActions('0.1.0');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Edit notes' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit notes for 0.1.0 (1)' });
    const notes = within(dialog).getByLabelText('Release notes');
    await userEvent.clear(notes);
    await userEvent.type(notes, 'Fixed scanning');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(calls)).toEqual([
      expect.objectContaining({ method: 'PATCH', path: '/api/versions/v-1', body: { notes: 'Fixed scanning' } }),
    ]);
  });

  it('staff on Android get only Install, for that version', async () => {
    auth.can = grants('view');
    viewer.platform = 'android';
    const calls = stubApi({
      'GET /api/apps/app-a': detail(),
      'POST /api/apps/app-a/install': { url: 'https://devices.test/dl/t/kiosk.apk' },
    });
    renderPage();
    const menu = await openActions('0.1.0');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Install']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Install' }));
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('https://devices.test/dl/t/kiosk.apk'));
    expect(writes(calls)[0].body).toEqual({ version_id: 'v-1' });
  });

  it('staff on a desktop get no actions at all', async () => {
    auth.can = grants('view');
    stubApi({ 'GET /api/apps/app-a': detail() });
    renderPage();
    const row = await rowWith('0.1.0');
    expect(within(row).queryByRole('button', { name: 'Actions' })).toBeNull();
  });
});
