/**
 * Matching a scanned string against the kiosk's local copy of the move.
 *
 * One input box takes whatever the reader or the keyboard produces — an
 * RFID EPC, an asset ID, or a serial number — because the person at the
 * kiosk should not have to tell the screen which kind of thing they
 * just waved. So the index holds all three, and `matchScan` tries them
 * in the order a scan is most likely to be: RFID first (the readers),
 * then asset ID (the labels the move prints), then serial (the
 * manufacturer's own barcode).
 *
 * RFID keys are stored with their leading zeros stripped — the same
 * `displayRfid` rule the portal lists use — because a handheld reading
 * the same tag as a fixed reader may or may not include the EPC's
 * padding. Everything is upper-cased, so case never decides a match.
 *
 * The match is informational as far as the API is concerned: the server
 * re-matches `scanned_value` from scratch. Its RFID match is exact, so an
 * RFID match here sends the stored tag (`sentScanValue`), never the
 * short form a label's barcode carries. What it decides here is what
 * the operator sees (green or red, and which asset) and whether the
 * scan is worth sending at all.
 */

import { displayRfid } from '@portal/lib/format';

export interface ScanAsset {
  id: string;
  asset_id: string;
  name: string | null;
  rfid: string | null;
  serial_number: string | null;
  make?: string | null;
  model?: string | null;
  make_model: string;
}

export type ScanMatchKind = 'rfid' | 'asset_id' | 'serial';

export interface ScanMatch {
  kind: ScanMatchKind;
  asset: ScanAsset;
}

export interface ScanIndex {
  byRfid: Map<string, ScanAsset>;
  byAssetId: Map<string, ScanAsset>;
  bySerial: Map<string, ScanAsset>;
  size: number;
}

function key(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toUpperCase();
  return trimmed || null;
}

/** The RFID key: zero-padding stripped, upper-cased. `displayRfid`
 *  renders a missing tag as an em dash, so an absent tag is filtered
 *  out before it can become a key that matches "—". */
function rfidKey(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  return key(displayRfid(value.trim()));
}

export function buildScanIndex(assets: readonly ScanAsset[]): ScanIndex {
  const byRfid = new Map<string, ScanAsset>();
  const byAssetId = new Map<string, ScanAsset>();
  const bySerial = new Map<string, ScanAsset>();
  for (const asset of assets) {
    // First row wins on a duplicate key: re-registering it would make
    // the match depend on roster order in a way nothing else does.
    const r = rfidKey(asset.rfid);
    if (r && !byRfid.has(r)) byRfid.set(r, asset);
    const a = key(asset.asset_id);
    if (a && !byAssetId.has(a)) byAssetId.set(a, asset);
    const s = key(asset.serial_number);
    if (s && !bySerial.has(s)) bySerial.set(s, asset);
  }
  return { byRfid, byAssetId, bySerial, size: assets.length };
}

export function matchScan(index: ScanIndex, raw: string): ScanMatch | null {
  const plain = key(raw);
  if (!plain) return null;
  const tag = rfidKey(raw);
  const byTag = tag ? index.byRfid.get(tag) : undefined;
  if (byTag) return { kind: 'rfid', asset: byTag };
  const byAssetId = index.byAssetId.get(plain);
  if (byAssetId) return { kind: 'asset_id', asset: byAssetId };
  const bySerial = index.bySerial.get(plain);
  if (bySerial) return { kind: 'serial', asset: bySerial };
  return null;
}

/** Asset ID or serial only, in that order — RFID Enroll's first step,
 *  where the operator is identifying the asset they are about to tag.
 *  Deliberately NOT `matchScan`: that tries RFID first, so scanning a
 *  tag that already belongs to some asset would silently pick it as the
 *  thing to re-tag. Here an RFID read simply does not match, and the
 *  screen says which input the operator is standing in. */
export function matchAssetOrSerial(index: ScanIndex, raw: string): ScanMatch | null {
  const plain = key(raw);
  if (!plain) return null;
  const byAssetId = index.byAssetId.get(plain);
  if (byAssetId) return { kind: 'asset_id', asset: byAssetId };
  const bySerial = index.bySerial.get(plain);
  if (bySerial) return { kind: 'serial', asset: bySerial };
  return null;
}

/** What a matched scan sends as `scanned_value`. An RFID match sends the
 *  record's stored tag, not the value as read: this kiosk ignores leading
 *  zeros, the server's RFID match does not, so a label's short form
 *  (`100348`) would match here and never there. Anything else is sent
 *  exactly as scanned, for the server to re-match. */
export function sentScanValue(raw: string, kind: string, storedTag: string | null | undefined): string {
  const tag = storedTag?.trim();
  return kind === 'rfid' && tag ? tag : raw;
}

/** What the ingest endpoint's `scan_type` should say. The vocabulary
 *  also has `manual`, but the kiosk has no keyed-entry mode yet — a
 *  typed serial is indistinguishable from a scanned one here. */
export function scanTypeFor(kind: ScanMatchKind): 'rfid' | 'barcode' {
  return kind === 'rfid' ? 'rfid' : 'barcode';
}
