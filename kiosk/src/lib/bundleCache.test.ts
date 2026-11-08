// @vitest-environment jsdom
/** The label bundle / vocab cache: write-through online, served from
 *  IndexedDB when the API is unreachable. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';

import * as api from './api';
import {
  bundleKey, cachedBundleTypes, getCachedBundle, loadBundle, loadVocab, putCachedBundle,
} from './bundleCache';
import { closeDb, readMeta, writeMeta } from './localDb';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const bundle = (iid: string, type: string, codes: string[] = ['^XA1']) => ({
  initiative_id: iid, label_type: type, fetched_at: '2026-11-08T10:00:00Z',
  labels: codes.map((code, n) => ({
    id: `g${n}`, entity_type: 'asset' as const, entity_id: `e${n}`, template_id: 't', template_name: 'T',
    template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false,
    generated_at: '2026-11-08T09:00:00Z', code,
  })),
});
const VOCAB = [{ kind: 'size', key: '4x2', label: '4x2', description: '', meta: {}, sort_order: 1, is_active: true, usage_count: 0 }];

const OFFLINE = [
  ['a network failure', () => vi.fn(async () => { throw new TypeError('down'); })],
  ['edge_offline', () => vi.fn(async () => json({ detail: { code: 'edge_offline' } }, 503))],
  ['cloud_sign_in_required', () => vi.fn(async () => json({ detail: { code: 'cloud_sign_in_required' } }, 403))],
] as const;

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  api.clearLocalSession();
  window.__KIOSK_CONFIG__ = { apiUrl: 'http://api.test' };
});

it('an online load is written through and served', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(bundle('i-1', 'top', ['a', 'b']))));
  const out = await loadBundle('i-1', 'top');
  expect(out.offlineSince).toBeNull();
  expect(out.bundle.labels).toHaveLength(2);
  const cached = await getCachedBundle('i-1', 'top');
  expect(cached?.cached_at).toBeTruthy();
  expect(cached?.labels.map((l) => l.code)).toEqual(['a', 'b']);
  expect(bundleKey('i-1', 'top')).toBe('i-1:top');
});

it.each(OFFLINE)('falls back to the cache on %s', async (_name, makeFetch) => {
  const when = new Date('2026-11-08T08:30:00Z');
  await putCachedBundle(bundle('i-1', 'top', ['cached']), when);
  await writeMeta('label_vocab', { rows: VOCAB, cached_at: when.toISOString() });
  vi.stubGlobal('fetch', makeFetch());

  const out = await loadBundle('i-1', 'top');
  expect(out.bundle.labels[0].code).toBe('cached');
  expect(out.offlineSince).toBe(when.toISOString());

  const vocab = await loadVocab();
  expect(vocab).toEqual({ vocab: VOCAB, offline: true });
});

it('loadVocab online writes meta, offline with nothing stored is empty', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(VOCAB)));
  expect(await loadVocab()).toEqual({ vocab: VOCAB, offline: false });
  expect((await readMeta('label_vocab'))?.rows).toEqual(VOCAB);

  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
  expect(await loadVocab()).toEqual({ vocab: [], offline: true });
});

it('rethrows offline with no cache', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
  await expect(loadBundle('i-1', 'top')).rejects.toMatchObject({ code: 'network' });
});

it('rethrows a non-offline error even with a cache', async () => {
  await putCachedBundle(bundle('i-1', 'top'));
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'forbidden' } }, 403)));
  await expect(loadBundle('i-1', 'top')).rejects.toMatchObject({ code: 'forbidden' });
});

it("cachedBundleTypes lists only this move's types", async () => {
  await putCachedBundle(bundle('i-1', 'top'));
  await putCachedBundle(bundle('i-1', 'front'));
  await putCachedBundle(bundle('i-2', 'rail'));
  expect(await cachedBundleTypes('i-1')).toEqual(['front', 'top']);
});

it("another move's bundle never serves", async () => {
  await putCachedBundle(bundle('i-2', 'top'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('down'); }));
  await expect(loadBundle('i-1', 'top')).rejects.toMatchObject({ code: 'network' });
});
