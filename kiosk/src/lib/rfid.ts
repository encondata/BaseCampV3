/**
 * The house RFID format, on the kiosk's side of the wire.
 *
 * A tag is stored as 24 characters, zero-padded on the left
 * (`000000000000000000100348`), so a handheld reading "100348" and a
 * fixed reader reading the tag's full EPC land on one value —
 * `displayRfid` (`@portal/lib/format`) strips that padding again for
 * display only. RFID Enroll pads here so the operator can see the exact
 * value that will be stored before they commit to it; the endpoint
 * normalizes identically and independently (`normalize_rfid` in
 * api/.../routes/kiosk.py), because nothing the kiosk sends is trusted.
 *
 * Whitespace goes everywhere, not just at the ends: a reader may
 * space-separate an EPC's words, and those spaces are formatting, not
 * part of the tag.
 */

export const RFID_LENGTH = 24;

/** Why a value is not a tag: nothing was scanned, the reader produced
 *  something that is not a plain alphanumeric tag, or it is longer than
 *  the stored format can hold. */
export type RfidProblem = 'empty' | 'not_alphanumeric' | 'too_long';

export interface PaddedRfid {
  /** The value as it would be stored, or null when `problem` is set. */
  tag: string | null;
  problem: RfidProblem | null;
}

const ALPHANUMERIC = /^[0-9A-Z]+$/;

export function padRfid(raw: string): PaddedRfid {
  const tag = raw.replace(/\s+/g, '').toUpperCase();
  if (!tag) return { tag: null, problem: 'empty' };
  if (!ALPHANUMERIC.test(tag)) return { tag: null, problem: 'not_alphanumeric' };
  if (tag.length > RFID_LENGTH) return { tag: null, problem: 'too_long' };
  return { tag: tag.padStart(RFID_LENGTH, '0'), problem: null };
}

/** What a rejected value says out loud on the Enroll screen. */
export function rfidProblemText(problem: RfidProblem): string {
  switch (problem) {
    case 'empty': return 'Scan the RFID tag.';
    case 'too_long': return `That tag is longer than ${RFID_LENGTH} characters.`;
    default: return "That tag has characters we can't store — letters and numbers only.";
  }
}
