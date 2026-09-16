/**
 * What RFID Enroll refuses to send, and why.
 *
 * The tag box accepts whatever the reader types, and a reader is a
 * keyboard: the two ways an operator ruins an asset record here are both
 * a second scan of something that was never a tag.
 *
 *   1. **The asset scanned twice.** The barcode on the rack is right
 *      there, and scanning it again while the tag box has focus would
 *      write an asset ID into `rfid_tag` — a value the portal would
 *      accept (it is alphanumeric and short enough) and nobody would
 *      notice until a reader failed to find the asset. So an entry that
 *      matches any asset ID or serial in the synced roster is refused,
 *      naming what it actually is.
 *   2. **A tag that already belongs to something.** `assets_rfid_uniq`
 *      makes this the portal's call, and the endpoint answers 409
 *      `rfid_in_use` — but the common case is the tag enrolled seconds
 *      ago on the previous asset, and a round trip to be told so is
 *      slower than the operator's next move. The roster and this
 *      session's log (`enrollLog`) both get asked first.
 *
 * Neither check replaces the server's. This is the fast, local half; the
 * save still runs, still gets 409'd on anything this could not know, and
 * feeds what it learns back into the log.
 *
 * The order matters: the roster is consulted before the format, so
 * scanning a hyphenated serial says "that's the serial for X" rather
 * than complaining about the hyphen.
 */

import { tagHolder } from './enrollLog';
import { padRfid, rfidProblemText } from './rfid';
import {
  matchAssetOrSerial, matchScan, type ScanAsset, type ScanIndex, type ScanMatchKind,
} from './scanMatch';

export type GateResult =
  | { ok: true; tag: string }
  | { ok: false; message: string };

/** How an asset is named in a refusal — assets can reach the kiosk
 *  without a name, and "That's the asset ID for null" helps nobody. */
function nameOf(asset: ScanAsset): string {
  return asset.name || asset.asset_id || 'another asset';
}

function kindWord(kind: ScanMatchKind): string {
  return kind === 'asset_id' ? 'asset ID' : 'serial';
}

/** Decide whether `raw` may be written onto `asset` as its RFID tag.
 *  On success the tag comes back in the stored 24-character form. */
export function checkTagEntry(
  index: ScanIndex, asset: ScanAsset, raw: string,
): GateResult {
  // 1. Is this the asset's own barcode, or some other asset's?
  const asAsset = matchAssetOrSerial(index, raw);
  if (asAsset) {
    const word = kindWord(asAsset.kind);
    return {
      ok: false,
      message: asAsset.asset.id === asset.id
        ? `That's this asset's own ${word}, not an RFID tag.`
        : `That's the ${word} for ${nameOf(asAsset.asset)}, not an RFID tag.`,
    };
  }

  // 2. Is it a tag at all?
  const { tag, problem } = padRfid(raw);
  if (problem) return { ok: false, message: rfidProblemText(problem) };

  // 3. Does something else already hold it? The session's own log first
  //    — it knows about saves the roster has not been re-synced for.
  const logged = tagHolder(tag!);
  if (logged && logged.assetId !== asset.id) {
    return { ok: false, message: `That tag is already on ${logged.assetName}.` };
  }
  const onRoster = matchScan(index, tag!);
  if (onRoster?.kind === 'rfid' && onRoster.asset.id !== asset.id) {
    return { ok: false, message: `That tag is already on ${nameOf(onRoster.asset)}.` };
  }

  return { ok: true, tag: tag! };
}
