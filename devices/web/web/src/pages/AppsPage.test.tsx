// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: auth.can }) }));
const viewer = vi.hoisted(() => ({ platform: 'ios' as 'android' | 'ios' | 'desktop' }));
vi.mock('../lib/platform', () => ({ viewerPlatform: () => viewer.platform }));
vi.mock('../lib/goTo', () => ({ goTo: vi.fn() }));
vi.mock('@portal/lib/qr', () => ({ qrDataUrl: () => 'data:image/png;qr' }));
vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  accessTokenForService: vi.fn(async () => 'tok'),
  refreshSession: vi.fn(async () => null),
}));

import { androidApp, FakeXhr, grants, iosApp, json, stubApi, type ApiCall } from '../testing/fakeApi';
import AppsPage from './AppsPage';

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function renderAt(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes><Route path="/" element={<AppsPage />} /></Routes>
      <Where />
    </MemoryRouter>,
  );
}

const appsCalls = (calls: ApiCall[]) => calls.filter((c) => c.method === 'GET' && c.path === '/api/apps');
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(() => {
  auth.can = grants('view');
  viewer.platform = 'ios';
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AppsPage', () => {
  it('AppsPage stores ?added ref and polls until ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const calls = stubApi({
      'GET /api/apps': () => {
        n += 1;
        const state = n < 3
          ? { state: n === 1 ? 'registering' : 'preparing', message: n === 1 ? 'Registering this iPhone with Apple…' : 'Preparing the app for this iPhone…' }
          : { state: 'ready', message: '', install_url: 'itms-services://x' };
        return json(200, [iosApp({ ios_state: state })]);
      },
    });
    renderAt('/?added=dev-9');

    expect(await screen.findByText('Registering this iPhone with Apple…')).toBeTruthy();
    expect(localStorage.getItem('devices.iosDeviceRef')).toBe('dev-9');
    expect(screen.getByTestId('where').textContent).toBe('/');
    expect(appsCalls(calls)[0].search).toBe('?device_ref=dev-9');

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText('Preparing the app for this iPhone…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByRole('button', { name: 'Install' })).toBeTruthy();
    const count = appsCalls(calls).length;
    expect(count).toBe(3);

    // ready: polling stops
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(appsCalls(calls)).toHaveLength(count);
  });

  it('stops polling after 10 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem('devices.iosDeviceRef', 'dev-9');
    const calls = stubApi({
      'GET /api/apps': [iosApp({ ios_state: { state: 'registering', message: 'Registering this iPhone with Apple…' } })],
    });
    renderAt('/');
    await screen.findByText('Registering this iPhone with Apple…');
    expect(appsCalls(calls)[0].search).toBe('?device_ref=dev-9');
    // step by step: each poll is scheduled only once the last answer lands
    const advance = async (ms: number) => {
      for (let t = 0; t < ms; t += 1000) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    };
    await advance(10 * 60_000);
    const count = appsCalls(calls).length;
    expect(count).toBeGreaterThan(100);
    expect(count).toBeLessThanOrEqual(121);
    await advance(2 * 60_000);
    expect(appsCalls(calls)).toHaveLength(count);
  });

  it('staff see no Upload button', async () => {
    const calls = stubApi({ 'GET /api/apps': [androidApp()] });
    renderAt('/');
    expect(await screen.findByText('ServerSherpa Kiosk')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    // staff never ask for the Apple settings
    expect(calls.some((c) => c.path === '/api/apple')).toBe(false);
  });

  it('warns admins when the certificate or a profile expires within 30 days', async () => {
    auth.can = grants('view', 'add', 'change', 'delete');
    stubApi({
      'GET /api/apps': [androidApp()],
      'GET /api/apple': {
        configured: true, team_id: 'T', key_id: 'K', issuer_id: 'I', cert_name: 'Apple Distribution: X',
        cert_expires_at: daysFromNow(20),
        profiles: [
          { app_name: 'ServerSherpa Kiosk', expires_at: daysFromNow(10) },
          { app_name: 'Label Station', expires_at: daysFromNow(200) },
        ],
        ios_owner_url: null,
      },
    });
    renderAt('/');
    expect(await screen.findByText(/The Apple Distribution certificate expires on \d{4}-\d{2}-\d{2}\./)).toBeTruthy();
    expect(screen.getByText(/The ServerSherpa Kiosk profile expires on \d{4}-\d{2}-\d{2}\./)).toBeTruthy();
    expect(screen.queryByText(/Label Station profile/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeTruthy();
  });

  it('UploadModal commit refreshes the list', async () => {
    auth.can = grants('view', 'add');
    viewer.platform = 'desktop';
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.sent = [];
    let saved = false;
    const calls = stubApi({
      'GET /api/apps': () => json(200, saved ? [androidApp()] : []),
      'POST /api/uploads': () => json(201, { upload_id: 'up-1', put_url: 'https://bucket.test/x', headers: {} }),
      'POST /api/uploads/up-1/inspect': {
        app: { exists: false, name: 'ServerSherpa Kiosk', platform: 'android', identifier: 'com.serversherpa.kiosk' },
        version_name: '0.1.1', build: '2', signing_digest: 'ab12cd34ef56ab12', problems: [],
      },
      'POST /api/uploads/up-1/commit': () => { saved = true; return json(201, { app_id: 'app-a', version: {} }); },
    });
    const { container } = renderAt('/');
    expect(await screen.findByText('No apps yet.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const dialog = screen.getByRole('dialog', { name: 'Upload a version' });
    await userEvent.upload(container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['x'], 'kiosk.apk'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Upload' }));
    await within(dialog).findByText('New app');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('ServerSherpa Kiosk')).toBeTruthy();
    expect(appsCalls(calls)).toHaveLength(2);
  });
});
