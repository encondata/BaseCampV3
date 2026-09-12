// @vitest-environment jsdom
/** The Print Labels offline cache against fake-indexeddb. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import type { GeneratedLabelBundle, InitiativeAssetRow, InitiativeItem } from './api';
import {
  bundleKey, cacheAvailable, clearAll, deleteBundle, deleteInitiative, getBundle, getInitiative,
  listBundles, listInitiatives, putBundle, putInitiative,
} from './labelCache';

const ini = (id: string, name: string) => ({ id, name, client_name: 'Acme' } as unknown as InitiativeItem);
const row = (assetId: string) => ({ id: `j-${assetId}`, asset_id: assetId } as unknown as InitiativeAssetRow);
const bundle = (initiativeId: string, type: string, n: number): GeneratedLabelBundle => ({
  initiative_id: initiativeId, label_type: type, fetched_at: '2026-09-12T00:00:00Z',
  labels: Array.from({ length: n }, (_, i) => ({
    id: `${type}-${i}`, entity_type: 'asset', entity_id: `a${i}`, template_id: 't', template_name: 'T',
    template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false,
    generated_at: '2026-09-12T00:00:00Z', code: '^XA^XZ',
  })),
});

beforeEach(() => {
  // fresh database per test
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe('labelCache', () => {
  it('reports availability and builds keys', () => {
    expect(cacheAvailable()).toBe(true);
    expect(bundleKey('i1', 'top')).toBe('i1:top');
  });

  it('stores and lists initiatives with their rosters', async () => {
    await putInitiative({ initiative: ini('i1', 'NAP11'), roster: [row('a1'), row('a2')] });
    await putInitiative({ initiative: ini('i2', 'NAP22'), roster: [] });
    const got = await getInitiative('i1');
    expect(got?.initiative.name).toBe('NAP11');
    expect(got?.roster.map((r) => r.asset_id)).toEqual(['a1', 'a2']);
    expect(got?.cached_at).toBeTruthy();
    expect((await listInitiatives()).map((e) => e.initiative.id).sort()).toEqual(['i1', 'i2']);
    expect(await getInitiative('nope')).toBeNull();
  });

  it('stores bundles per initiative + type, replacing on re-put', async () => {
    await putBundle(bundle('i1', 'top', 2), 'NAP11');
    await putBundle(bundle('i1', 'front', 1), 'NAP11');
    await putBundle(bundle('i1', 'top', 3), 'NAP11');
    const top = await getBundle('i1', 'top');
    expect(top?.labels.length).toBe(3);
    expect(top?.initiative_name).toBe('NAP11');
    expect(top?.cached_at).toBeTruthy();
    expect((await listBundles()).length).toBe(2);
    expect(await getBundle('i1', 'rail')).toBeNull();
  });

  it('deletes one bundle, an initiative with its bundles, or everything', async () => {
    await putInitiative({ initiative: ini('i1', 'NAP11'), roster: [] });
    await putInitiative({ initiative: ini('i2', 'NAP22'), roster: [] });
    await putBundle(bundle('i1', 'top', 1), 'NAP11');
    await putBundle(bundle('i1', 'front', 1), 'NAP11');
    await putBundle(bundle('i2', 'top', 1), 'NAP22');
    await deleteBundle('i1', 'front');
    expect((await listBundles()).map((b) => bundleKey(b.initiative_id, b.label_type)).sort()).toEqual(['i1:top', 'i2:top']);
    await deleteInitiative('i1');
    expect(await getInitiative('i1')).toBeNull();
    expect((await listBundles()).map((b) => b.initiative_id)).toEqual(['i2']);
    await clearAll();
    expect(await listInitiatives()).toEqual([]);
    expect(await listBundles()).toEqual([]);
  });

  it('degrades to no-ops without IndexedDB', async () => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = undefined;
    expect(cacheAvailable()).toBe(false);
    await expect(putBundle(bundle('i1', 'top', 1), 'NAP11')).resolves.toBeUndefined();
    expect(await getBundle('i1', 'top')).toBeNull();
    expect(await listBundles()).toEqual([]);
    expect(await listInitiatives()).toEqual([]);
  });
});
