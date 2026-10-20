// @vitest-environment jsdom
/** Label Station setup's calls: the edge printer transport and settings,
 *  and the kiosk font + test-render routes. */
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

const SETTINGS: api.LabelStationSettings = {
  label_kind: 'front', printer: { type: 'network', ip: '10.0.0.40', model: 'ZT411', serial: null },
  dpi: 300, offset_x: -12, offset_y: 4, peel: true,
};

it('saves the settings with PUT /edge/label-station and reads them back with GET', async () => {
  const fetchMock = vi.fn(async () => json(SETTINGS));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.putLabelStation(SETTINGS)).toEqual(SETTINGS);
  expect(lastCall(fetchMock)).toEqual({ url: 'http://api.test/edge/label-station', method: 'PUT', body: SETTINGS });
  expect(await api.getLabelStation()).toEqual(SETTINGS);
  expect(lastCall(fetchMock)).toMatchObject({ url: 'http://api.test/edge/label-station', method: 'GET' });
});

it('surfaces not_label_station as an ApiError', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'not_label_station' } }, 409)));
  await expect(api.putLabelStation(SETTINGS)).rejects.toMatchObject({ status: 409, code: 'not_label_station' });
});

it('scans, queries, sends and installs fonts through /edge/printers', async () => {
  const fetchMock = vi.fn(async () => json({ scan_id: 's1' }));
  vi.stubGlobal('fetch', fetchMock);
  await api.startPrinterScan();
  expect(lastCall(fetchMock)).toMatchObject({ url: 'http://api.test/edge/printers/scan', method: 'POST' });
  await api.getPrinterScan();
  expect(lastCall(fetchMock)).toMatchObject({ url: 'http://api.test/edge/printers/scan', method: 'GET' });
  fetchMock.mockImplementation(async () => json({ response: 'x', truncated: false }));
  expect(await api.printerQuery('10.0.0.40', '~HI')).toEqual({ response: 'x', truncated: false });
  expect(lastCall(fetchMock)).toEqual({
    url: 'http://api.test/edge/printers/query', method: 'POST', body: { ip: '10.0.0.40', command: '~HI' },
  });
  fetchMock.mockImplementation(async () => json({ ok: true }));
  await api.printerSend('10.0.0.40', '^XA^XZ');
  expect(lastCall(fetchMock)).toEqual({
    url: 'http://api.test/edge/printers/send', method: 'POST', body: { ip: '10.0.0.40', zpl: '^XA^XZ' },
  });
  const font = { ip: '10.0.0.40', font_id: 'f', name: 'A.TTF', initiative_id: 'i-1' };
  await api.printerSendFont(font);
  expect(lastCall(fetchMock)).toEqual({ url: 'http://api.test/edge/printers/send-font', method: 'POST', body: font });
});

it('lists the move fonts, downloads one, and renders a test label', async () => {
  const fetchMock = vi.fn(async () => json({ fonts: [{ id: 'f', name: 'A.TTF', size: 3 }], missing: ['B.TTF'] }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.fetchKioskLabelFonts('i 1')).toEqual({ fonts: [{ id: 'f', name: 'A.TTF', size: 3 }], missing: ['B.TTF'] });
  expect(lastCall(fetchMock).url).toBe('http://api.test/kiosk/labels/fonts?initiative_id=i%201');

  fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  expect(Array.from(await api.fetchKioskFontContent('f', 'i-1'))).toEqual([1, 2, 3]);
  expect(lastCall(fetchMock).url).toBe('http://api.test/kiosk/labels/fonts/f/content?initiative_id=i-1');

  fetchMock.mockImplementation(async () => json({ zpl: '^XA^XZ', template_name: 'G' }));
  const body = { initiative_id: 'i-1', template_id: 't', dpi_key: '203' };
  expect(await api.postTestRender(body)).toEqual({ zpl: '^XA^XZ', template_name: 'G' });
  expect(lastCall(fetchMock)).toEqual({ url: 'http://api.test/kiosk/labels/test-render', method: 'POST', body });
});

it('reads the label run status, the plan, and one station label from /edge/labels', async () => {
  const status = { state: 'running', reason: 'setup', total: 10, done: 3, ready: 3, errors: 0 };
  const fetchMock = vi.fn(async () => json(status));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.getLabelRunStatus()).toEqual(status);
  expect(lastCall(fetchMock)).toMatchObject({ url: 'http://api.test/edge/labels/status', method: 'GET' });

  const plan = { template: { id: 't1', name: 'Top 203', family: 'Top', dpi_key: '203', version: 2 }, notes: [] };
  fetchMock.mockImplementation(async () => json(plan));
  expect(await api.getLabelPlan()).toEqual(plan);
  expect(lastCall(fetchMock).url).toBe('http://api.test/edge/labels/plan');
  await api.getLabelPlan({ dpi: 203, kind: 'front' });
  expect(lastCall(fetchMock).url).toBe('http://api.test/edge/labels/plan?dpi=203&kind=front');

  const label = { asset_id: 'a 1', zpl: '^XA^XZ', error: null, template_name: 'Top 203', dpi: 203, label_kind: 'top' };
  fetchMock.mockImplementation(async () => json(label));
  expect(await api.getStationLabel('a 1')).toEqual(label);
  expect(lastCall(fetchMock).url).toBe('http://api.test/edge/labels/asset/a%201');
});

it('surfaces label_not_found and labels_regenerating as ApiErrors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'labels_regenerating' } }, 409)));
  await expect(api.getStationLabel('a1')).rejects.toMatchObject({ status: 409, code: 'labels_regenerating' });
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'label_not_found' } }, 404)));
  await expect(api.getStationLabel('a1')).rejects.toMatchObject({ status: 404, code: 'label_not_found' });
});

it('posts a printed scan to /edge/labels/printed', async () => {
  const fetchMock = vi.fn(async () => json({ queued: true, client_scan_id: 'c1' }));
  vi.stubGlobal('fetch', fetchMock);
  const body = { asset_id: 'a1', scanned_value: 'SN1', scanned_at: '2026-10-19T12:00:00Z' };
  await expect(api.postLabelPrinted(body)).resolves.toBe('c1');
  expect(lastCall(fetchMock)).toEqual({ url: 'http://api.test/edge/labels/printed', method: 'POST', body });
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'scan_value_mismatch' } }, 422)));
  await expect(api.postLabelPrinted(body)).rejects.toMatchObject({ status: 422, code: 'scan_value_mismatch' });
});

it('asks /edge/labels/recorded which printed scans the portal accepted', async () => {
  const fetchMock = vi.fn(async () => json({ recorded: ['c1'] }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(api.getRecordedScans(['c1', 'c2'])).resolves.toEqual(['c1']);
  expect(lastCall(fetchMock)).toMatchObject({ url: 'http://api.test/edge/labels/recorded?ids=c1%2Cc2' });
});
