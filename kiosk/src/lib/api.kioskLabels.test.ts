// @vitest-environment jsdom
/** `fetchLabelVocab` hits the kiosk's own vocab route, not the portal's
 *  labels:view-gated one — a worker holds kiosk:view only. */
import { beforeEach, expect, it, vi } from 'vitest';

import * as api from './api';

const VOCAB = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: 0 },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: 0 },
];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Call = [string, RequestInit | undefined];

beforeEach(() => {
  api.clearLocalSession();
  window.__KIOSK_CONFIG__ = { apiUrl: 'http://api.test' };
});

it('gets /kiosk/labels/vocab and returns the rows', async () => {
  const fetchMock = vi.fn(async () => json(VOCAB));
  vi.stubGlobal('fetch', fetchMock);
  const rows = await api.fetchLabelVocab();
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/labels/vocab');
  expect(init?.method ?? 'GET').toBe('GET');
  expect(rows.map((r) => r.key)).toEqual(['4x2', '203']);
});

it('never falls back to the portal route', async () => {
  const fetchMock = vi.fn(async () => json(VOCAB));
  vi.stubGlobal('fetch', fetchMock);
  await api.fetchLabelVocab('size');
  const urls = fetchMock.mock.calls.map((c) => String((c as unknown as Call)[0]));
  expect(urls.some((u) => u.includes('/labels/vocab') && !u.includes('/kiosk/'))).toBe(false);
  expect(urls.at(-1)).toBe('http://api.test/kiosk/labels/vocab?kind=size');
});

it('surfaces a forbidden answer as an ApiError', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'forbidden' } }, 403)));
  await expect(api.fetchLabelVocab()).rejects.toMatchObject({ status: 403 });
});
