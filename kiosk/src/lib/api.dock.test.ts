// @vitest-environment jsdom
/** The Dock screen's edge calls: the overview, one pass's detail and the
 *  Start / Stop control, with their paths, methods and body. The Dock has no
 *  settings to save. */
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
  open: {
    id: 8, opened_at: '2026-11-05T14:01:00Z', crate_count: 1, asset_count: 1,
    crates: [{ epc: 'E200001', label: 'Crate 12', first_read_at: '2026-11-05T14:01:01.250+00:00',
               conflict: false }],
    conflict: false, added_count: 1,
    tags: [
      { epc: 'E200001', kind: 'container', label: 'Crate 12', first_read_at: '2026-11-05T14:01:01.250+00:00',
        serial: null, in_window: null, crate_label: null },
      { epc: 'E200002', kind: 'asset', label: 'Server 4', first_read_at: '2026-11-05T14:01:00.000+00:00',
        serial: 'SN-4', in_window: true, crate_label: 'Crate 12' },
    ],
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

it('there is no Dock settings or pass detail call', () => {
  expect('saveDockSettings' in api).toBe(false);
  expect('getDockPass' in api).toBe(false);
});

it('controlDock posts the action to POST /edge/dock/control and returns the result', async () => {
  const result: api.DockControlResult = { reading: false, control: 'stop', decided: 2 };
  const fetchMock = vi.fn(async () => json(result));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.controlDock('stop')).toEqual(result);
  expect(lastCall(fetchMock)).toEqual({
    url: 'http://api.test/edge/dock/control', method: 'POST', body: { action: 'stop' },
  });
  fetchMock.mockImplementation(async () => json({ reading: true, control: 'start', decided: 0 }));
  await api.controlDock('start');
  expect(lastCall(fetchMock).body).toEqual({ action: 'start' });
});
