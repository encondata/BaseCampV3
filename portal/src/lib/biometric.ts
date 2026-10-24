/**
 * Biometric sign-in in the portal (spec 2026-10-23-kiosk-biometric-sign-in
 * §Portal): the device page's Personal device row and the Biometric sign-in
 * panels on the user page and /me share this copy.
 */
import type { DeviceDetail, PersonalBiometric } from './api';

/** A Label, RFID or Time Clock station (or a station-key kiosk, which the
 *  server refuses as `shared_station`) is never anyone's personal phone. */
export const SHARED_STATION_LINE = "Shared station — can't be a personal device";

/** "Nov 22" in the viewer's time zone. */
export function monthDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** True once the 30-day window has run out (the key is still live, but the
 *  next sign-in on the phone needs the password). */
export function renewalPassed(renewsAt: string | null, now = Date.now()): boolean {
  return renewsAt != null && Date.parse(renewsAt) <= now;
}

/** The expired line, the same on the device page, the user page and /me:
 *  it names no one, so it reads right whoever is looking. */
export const EXPIRED_RENEWS = 'expired · renews at the next password sign-in';

/** The renews part of a key line: "renews by Nov 22", or expired. */
export function renewsText(renewsAt: string, now = Date.now()): string {
  return renewalPassed(renewsAt, now) ? EXPIRED_RENEWS : `renews by ${monthDay(renewsAt)}`;
}

export type FingerprintState = 'on' | 'expired' | 'off';

export function fingerprintState(b: PersonalBiometric | null | undefined, now = Date.now()): FingerprintState {
  if (!b?.on) return 'off';
  return renewalPassed(b.renews_at, now) ? 'expired' : 'on';
}

/** The device page's status line for the personal person's key. */
export function fingerprintStatus(b: PersonalBiometric | null | undefined, now = Date.now()): string {
  const state = fingerprintState(b, now);
  if (state === 'off') return 'Fingerprint off';
  if (state === 'expired') return `Fingerprint ${EXPIRED_RENEWS}`;
  return b?.renews_at ? `Fingerprint on · renews by ${monthDay(b.renews_at)}` : 'Fingerprint on';
}

/** The server's `shared_station` (a station type or a station key), with
 *  the station type as a fallback for a payload without the flag. */
export function isSharedStation(
  d: Pick<DeviceDetail, 'station_type' | 'shared_station'>
    & { setup: Pick<DeviceDetail['setup'], 'station_type'> },
): boolean {
  return d.shared_station === true || (d.station_type ?? d.setup.station_type) != null;
}

const NOT_ELIGIBLE: Record<string, string> = {
  no_account: 'They need a portal login first.',
  no_kiosk_view: "They don't have kiosk access.",
  move_identity: "That's a move's kiosk identity, not a person.",
  account_disabled: 'Their account is disabled.',
  shared_station: SHARED_STATION_LINE,
};

const DEVICE_ERRORS: Record<string, string> = {
  person_not_found: 'That person is no longer on file.',
  device_not_found: 'This kiosk no longer exists.',
  not_a_kiosk: 'This device is not a kiosk.',
  forbidden: "You don't have the rights to change this kiosk.",
  forbidden_rank: "You don't have the rights to change this kiosk.",
};

type ErrLike = { code?: string; message?: string; detail?: unknown } | null;

/** A failed Personal device write (Save, Clear, Forget fingerprint). */
export function personalErrorMessage(err: unknown): string {
  const e = err as ErrLike;
  const code = e?.code;
  if (code === 'read_only_mode' && e?.message) return e.message;
  if (code === 'not_eligible') {
    const reason = (e?.detail as { reason?: string } | undefined)?.reason;
    return (reason && NOT_ELIGIBLE[reason]) ?? "They can't use this phone.";
  }
  if (typeof code === 'string') return DEVICE_ERRORS[code] ?? `Couldn't save (${code}).`;
  return "Couldn't save. Try again.";
}

const KEY_FORGET_ERRORS: Record<string, string> = {
  cannot_target_self: 'Manage your own on My account.',
  forbidden: "You don't have the rights to change this person.",
  rank_too_low: "You don't have the rights to change this person.",
  user_not_found: 'That person no longer exists.',
};

/** A failed key forget on the user page or /me: the API's read-only
 *  sentence, the self, rights and gone refusals, otherwise a plain retry
 *  line. */
export function keyForgetErrorMessage(err: unknown, which: 'one' | 'all' = 'all'): string {
  const e = err as ErrLike;
  if (e?.code === 'read_only_mode' && e.message) return e.message;
  if (e?.code && KEY_FORGET_ERRORS[e.code]) return KEY_FORGET_ERRORS[e.code];
  return which === 'one'
    ? 'Could not forget that fingerprint. Try again.'
    : 'Could not forget the fingerprints. Try again.';
}
