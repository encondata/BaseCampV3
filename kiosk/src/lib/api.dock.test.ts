// @vitest-environment jsdom
/** The Dock screen's edge calls: the overview, one pass's detail, the
 *  settings save and the Start / Pause / Stop control, with their paths,
 *  methods and body. */
import { beforeEach, expect, it, vi } from 'vitest';

import * as api from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Call = [string, RequestInit | undefined];

beforeEach(() => {
  api.clearLocalSession();
  window.__KIOSK_CONFIG__ = { apiUrl: 'http://api.test' };
});

function lastCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  return { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

const PASS: api.DockPassRow = {
  id: 7, opened_at: '2026-11-05T14:00:00Z', closed_at: '2026-11-05T14:00:09Z',
  status: 'would_pack', flag: null, dry_run: true, container_name: 'Crate 12',
  asset_count: 3, moved_count: 1, refused_count: 0, refuse_code: null,
};

const OVERVIEW: api.DockOverview = {
  settings: { dry_run: true, quiet_gap_s: 5 },
  open: {
    id: 8, opened_at: '2026-11-05T14:01:00Z', seconds_left: 3.25, crate_count: 1, asset_count: 2,
    tags: [{ epc: 'E200001', kind: 'container', label: 'Crate 12' }],
  },
  passes: [PASS],
  control: null,
};

it('getDock reads the overview from GET /edge/dock', async () => {
  const fetchMock = vi.fn(async () => json(OVERVIEW));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.getDock()).toEqual(OVERVIEW);
  expect(lastCall(fetchMock)).toEqual({ url: 'http://api.test/edge/dock', method: 'GET', body: undefined });
});

it('getDockPass reads one pass from GET /edge/dock/passes/{id}', async () => {
  const detail: api.DockPassDetail = {
    pass: PASS,
    // A dry-run pass is never sent, so its tags carry no packing result.
    tags: [{ epc: 'E200002', kind: 'asset', label: 'Server 4', result: null,
             moved_from: null, reason: null }],
    reads: [{ id: 1, read_at: '2026-11-05T14:00:01Z', epc: 'E200002', kind: 'asset', antenna: 2,
              peak_rssi: -52 }],
  };
  const fetchMock = vi.fn(async () => json(detail));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.getDockPass(7)).toEqual(detail);
  expect(lastCall(fetchMock)).toEqual({ url: 'http://api.test/edge/dock/passes/7', method: 'GET', body: undefined });
});

it('getDockPass surfaces pass_not_found', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'pass_not_found' } }, 404)));
  await expect(api.getDockPass(99)).rejects.toMatchObject({ status: 404, code: 'pass_not_found' });
});

it('saveDockSettings sends only the given fields with PUT /edge/dock/settings', async () => {
  const fetchMock = vi.fn(async () => json({ dry_run: false, quiet_gap_s: 5 }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.saveDockSettings({ dry_run: false })).toEqual({ dry_run: false, quiet_gap_s: 5 });
  expect(lastCall(fetchMock)).toEqual({
    url: 'http://api.test/edge/dock/settings', method: 'PUT', body: { dry_run: false },
  });
});

it('saveDockSettings surfaces invalid_dock_settings', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'invalid_dock_settings' } }, 422)));
  await expect(api.saveDockSettings({ quiet_gap_s: 0 }))
    .rejects.toMatchObject({ status: 422, code: 'invalid_dock_settings' });
});

it('controlDock posts the action to POST /edge/dock/control and returns the result', async () => {
  const result: api.DockControlResult = { reading: false, control: 'stop', decided: 2 };
  const fetchMock = vi.fn(async () => json(result));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.controlDock('stop')).toEqual(result);
  expect(lastCall(fetchMock)).toEqual({
    url: 'http://api.test/edge/dock/control', method: 'POST', body: { action: 'stop' },
  });
});
