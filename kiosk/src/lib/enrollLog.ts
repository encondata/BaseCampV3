/**
 * What this kiosk has already tagged, this session.
 *
 * RFID uniqueness is the portal's to enforce — `assets_rfid_uniq` is the
 * only thing that can actually decide it, and the enroll endpoint
 * answers 409 `rfid_in_use` naming the holder. But a 409 costs a round
 * trip, and the operator is standing at a rack with a reader in hand:
 * the common way to get one is to wave the tag that was just enrolled on
 * the previous asset, seconds ago. This log catches exactly that case
 * instantly, before the call, and the call still runs its own check —
 * the log is a courtesy, never the enforcement.
 *
 * It is deliberately small and deliberately in memory:
 *   - the roster in IndexedDB already holds every tag the portal knew
 *     about at sync time, and RFID Enroll writes each new tag back into
 *     it, so what survives a reload is the roster, not this;
 *   - a persisted log would eventually disagree with the portal (a tag
 *     moved on the portal, an asset unarchived) and start refusing saves
 *     the portal would have accepted. Forgetting on reload is the point.
 *
 * Module-level rather than React state so it survives leaving the screen
 * and coming back — the same reader, the same shift, the same box of
 * tags. `clearEnrollLog()` exists for tests and for "Clear local data".
 *
 * Keys are the stored 24-character form (`padRfid`), so a handheld
 * reading "100348" and a fixed reader reading the full EPC are one key.
 */

import { padRfid } from './rfid';

export interface TagHolder {
  assetId: string;
  assetName: string;
  /** When this kiosk learned it, ISO-8601. */
  at: string;
}

export interface Enrollment {
  tag: string;
  assetId: string;
  assetName: string;
}

const byTag = new Map<string, TagHolder>();

/** The canonical key, or null when the value could never be a tag —
 *  callers pass raw reader output, so junk must not become a key. */
function tagKey(raw: string): string | null {
  return padRfid(raw).tag;
}

/** An asset this kiosk just tagged. The asset's previous tag (if this
 *  session gave it one) is released: the portal has moved on from it, so
 *  holding it would refuse a re-use the portal would allow. */
export function recordEnrollment({ tag, assetId, assetName }: Enrollment): void {
  const key = tagKey(tag);
  if (!key) return;
  for (const [other, holder] of byTag) {
    if (holder.assetId === assetId && other !== key) byTag.delete(other);
  }
  byTag.set(key, { assetId, assetName, at: new Date().toISOString() });
}

/** A holder the PORTAL named (the 409's `asset_id`/`asset_name`), so an
 *  immediate retry of the same tag is refused here instead of making the
 *  same round trip again. */
export function noteTagHolder(tag: string, assetId: string, assetName: string): void {
  const key = tagKey(tag);
  if (!key) return;
  byTag.set(key, { assetId, assetName, at: new Date().toISOString() });
}

/** Who holds this tag, as far as this session knows. Null means "no
 *  opinion" — not "free". */
export function tagHolder(tag: string): TagHolder | null {
  const key = tagKey(tag);
  if (!key) return null;
  return byTag.get(key) ?? null;
}

export function clearEnrollLog(): void {
  byTag.clear();
}

/** Rows held, for tests and the Developer tab. */
export function enrollLogSize(): number {
  return byTag.size;
}
