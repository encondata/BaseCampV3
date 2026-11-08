/**
 * Asset Lookup, the offline half. The online path asks the API
 * (`lookupAssets` / `fetchAssetDetail`); when the network is down, or the
 * laptop edge holds no cloud session (403 `cloud_sign_in_required`), the
 * same questions are answered from the move's synced devices, by the same
 * rules as `GET /kiosk/assets/lookup`, as closely as the synced data
 * allows. Read-only: nothing here writes.
 */

import { naturalCompare } from '@portal/lib/naturalSort';

import {
  ApiError, fetchAssetDetail, lookupAssets,
  type KioskAssetDetail, type KioskAssetEnd, type KioskLookupMatch, type KioskLookupResult,
  type LookupMatchKind,
} from './api';
import { getAll, readMeta, readRawBody } from './localDb';
import { padRfid } from './rfid';

export const LOOKUP_CAP = 25;

export const MATCH_LABEL: Record<LookupMatchKind, string> = {
  asset_tag: 'Asset tag', serial: 'Serial', rfid: 'RFID', name: 'Name',
};

/** The synced `KioskAssetOut` fields this file reads. */
export interface LocalAsset {
  id: string;
  asset_id: string;
  name: string | null;
  rfid: string | null;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  make_model: string;
  container_id: string | null;
  source_pod: string | null;
  source_rack: string | null;
  source_ru: string | null;
  source_position: string | null;
  destination_pod: string | null;
  destination_rack: string | null;
  destination_ru: string | null;
  destination_position: string | null;
  asset_status: string | null;
  asset_status_label: string | null;
  location_detail: string | null;
}

export interface LocalLookupData {
  assets: LocalAsset[];
  containerNames: Map<string, string>;
  moveId: string;
  moveName: string;
  sourceSite: string | null;
  destinationSite: string | null;
}

// `sync.ts` keeps this key private.
const SYNC_META_KEY = 'sync';

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export async function loadLocalLookup(): Promise<LocalLookupData> {
  const [assets, containers, meta, raw] = await Promise.all([
    getAll<LocalAsset>('assets'),
    getAll<{ id: string; name: string }>('containers'),
    readMeta(SYNC_META_KEY),
    readRawBody('assets_raw'),
  ]);
  let sourceSite: string | null = null;
  let destinationSite: string | null = null;
  if (raw) {
    try {
      const ctx = (JSON.parse(raw.text) as { label_context?: Record<string, unknown> | null })
        .label_context;
      sourceSite = textOrNull(ctx?.source_site);
      destinationSite = textOrNull(ctx?.destination_site);
    } catch { /* unreadable body: sites stay unknown */ }
  }
  return {
    assets,
    containerNames: new Map(containers.map((c) => [c.id, c.name])),
    moveId: typeof meta?.initiativeId === 'string' ? meta.initiativeId : '',
    moveName: typeof meta?.initiativeName === 'string' ? meta.initiativeName : '',
    sourceSite,
    destinationSite,
  };
}

/** An asset tag is looked up only as plain digits with no leading zero
 *  (the server's rule; `asset_id` is the human Asset ID text). */
const TAG_VALUE = /^[1-9][0-9]*$/;

function toMatch(a: LocalAsset, matched: LookupMatchKind[]): KioskLookupMatch {
  return {
    id: a.id, name: a.name, asset_tag: a.asset_id, serial_number: a.serial_number, matched,
  };
}

export function matchLocal(assets: readonly LocalAsset[], raw: string): KioskLookupResult {
  const value = raw.trim();
  if (!value) return { matches: [], truncated: false };
  const wantTag = TAG_VALUE.test(value) && value.length <= 18;
  const serial = value.toUpperCase();
  const rfid = padRfid(value).tag;

  const exact: KioskLookupMatch[] = [];
  for (const a of assets) {
    const kinds: LookupMatchKind[] = [];
    if (wantTag && a.asset_id === value) kinds.push('asset_tag');
    if (a.serial_number && a.serial_number.trim().toUpperCase() === serial) kinds.push('serial');
    if (rfid && a.rfid && padRfid(a.rfid).tag === rfid) kinds.push('rfid');
    if (kinds.length) exact.push(toMatch(a, kinds));
  }
  if (exact.length) {
    exact.sort((x, y) => naturalCompare(x.name, y.name) || naturalCompare(x.asset_tag, y.asset_tag));
    return { matches: exact.slice(0, LOOKUP_CAP), truncated: exact.length > LOOKUP_CAP };
  }

  const needle = value.toLowerCase();
  const named = assets
    .filter((a) => a.name?.toLowerCase().includes(needle))
    .sort((x, y) => naturalCompare(x.name, y.name))
    .map((a) => toMatch(a, ['name']));
  return { matches: named.slice(0, LOOKUP_CAP), truncated: named.length > LOOKUP_CAP };
}

export function localDetail(
  asset: LocalAsset, data: LocalLookupData, admin: boolean,
): KioskAssetDetail {
  const end = (site: string | null, pod: string | null, rack: string | null,
    ru: string | null, position: string | null): KioskAssetEnd =>
    ({ site_name: site, pod, rack, ru, position });
  return {
    id: asset.id,
    name: asset.name,
    make: asset.make,
    model: asset.model,
    make_model: asset.make_model,
    asset_tag: asset.asset_id,
    serial_number: asset.serial_number,
    rfid: asset.rfid,
    routes: [{
      initiative_id: data.moveId,
      initiative_name: data.moveName,
      source: end(data.sourceSite, asset.source_pod, asset.source_rack, asset.source_ru,
        asset.source_position),
      destination: end(data.destinationSite, asset.destination_pod, asset.destination_rack,
        asset.destination_ru, asset.destination_position),
    }],
    full: admin ? {
      status: asset.asset_status ?? '',
      status_label: asset.asset_status_label ?? '',
      status_color: '',
      moves: [],
      container_name: asset.container_id ? data.containerNames.get(asset.container_id) ?? null : null,
      truck_name: null,
      location_detail: asset.location_detail ?? '',
    } : null,
  };
}

/** The network is down (including the edge's `edge_offline`), or the laptop
 *  was signed in offline and holds no cloud session. */
function isOfflineError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.code === 'cloud_sign_in_required');
}

export async function findAssets(
  serial: string, raw: string,
): Promise<{ offline: boolean; result: KioskLookupResult }> {
  try {
    return { offline: false, result: await lookupAssets(serial, raw) };
  } catch (e) {
    if (!isOfflineError(e)) throw e;
    const data = await loadLocalLookup();
    return { offline: true, result: matchLocal(data.assets, raw) };
  }
}

export async function assetDetail(
  serial: string, id: string, offline: boolean, admin: boolean,
): Promise<{ offline: boolean; detail: KioskAssetDetail | null }> {
  if (!offline) {
    try {
      return { offline: false, detail: await fetchAssetDetail(serial, id) };
    } catch (e) {
      if (!isOfflineError(e)) throw e;
    }
  }
  const data = await loadLocalLookup();
  const asset = data.assets.find((a) => a.id === id);
  return { offline: true, detail: asset ? localDetail(asset, data, admin) : null };
}

/** A scan time, 24-hour. */
export function scanWhenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  });
}
