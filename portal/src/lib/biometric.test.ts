/** Biometric sign-in copy: the device page's status line and refusal
 *  messages, and the key panels' forget errors. */
import { expect, it } from 'vitest';

import { ApiError } from './api';
import {
  EXPIRED_RENEWS, SHARED_STATION_LINE, fingerprintStatus, isSharedStation, keyForgetErrorMessage,
  monthDay, personalErrorMessage, renewsText,
} from './biometric';

/** Local noon on a day: "Mon D" reads the same in every time zone. */
const localNoon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();
const NOW = Date.parse(localNoon(2026, 10, 24));

it('monthDay is "Mon D"', () => {
  expect(monthDay(localNoon(2026, 11, 22))).toBe('Nov 22');
  expect(monthDay(localNoon(2026, 3, 5))).toBe('Mar 5');
});

it('the expired line names no one: one helper for the device page and the key panels', () => {
  expect(EXPIRED_RENEWS).toBe('expired · renews at the next password sign-in');
  expect(renewsText(localNoon(2026, 10, 20), NOW)).toBe(EXPIRED_RENEWS);
  expect(renewsText(localNoon(2026, 11, 22), NOW)).toBe('renews by Nov 22');
});

it('fingerprintStatus: on while renews_at is ahead, expired after, off with no key', () => {
  expect(fingerprintStatus({ on: true, renews_at: localNoon(2026, 11, 22) }, NOW))
    .toBe('Fingerprint on · renews by Nov 22');
  expect(fingerprintStatus({ on: true, renews_at: localNoon(2026, 10, 20) }, NOW))
    .toBe('Fingerprint expired · renews at the next password sign-in');
  expect(fingerprintStatus({ on: false, renews_at: null }, NOW)).toBe('Fingerprint off');
  expect(fingerprintStatus(null, NOW)).toBe('Fingerprint off');
});

it("isSharedStation: the server's shared_station flag (a station key too), or any station type", () => {
  expect(isSharedStation({ station_type: 'rfid', setup: { station_type: 'rfid' } })).toBe(true);
  expect(isSharedStation({ station_type: null, setup: { station_type: 'timeclock' } })).toBe(true);
  expect(isSharedStation({ station_type: null, setup: { station_type: null } })).toBe(false);
  // a station-key kiosk with no station type
  expect(isSharedStation({ shared_station: true, station_type: null, setup: { station_type: null } }))
    .toBe(true);
  expect(isSharedStation({ shared_station: false, station_type: null, setup: { station_type: null } }))
    .toBe(false);
});

it('personalErrorMessage maps each not_eligible reason', () => {
  const ne = (reason: string) => new ApiError(422, 'not_eligible', { code: 'not_eligible', reason });
  expect(personalErrorMessage(ne('no_account'))).toBe('They need a portal login first.');
  expect(personalErrorMessage(ne('no_kiosk_view'))).toBe("They don't have kiosk access.");
  expect(personalErrorMessage(ne('move_identity'))).toBe("That's a move's kiosk identity, not a person.");
  expect(personalErrorMessage(ne('shared_station'))).toBe(SHARED_STATION_LINE);
  expect(personalErrorMessage(ne('account_disabled'))).toBe('Their account is disabled.');
  expect(SHARED_STATION_LINE).toBe("Shared station — can't be a personal device");
});

it('personalErrorMessage: read-only wins, other codes fall back', () => {
  expect(personalErrorMessage(new ApiError(423, 'read_only_mode', undefined, 'The portal is read-only right now.')))
    .toBe('The portal is read-only right now.');
  expect(personalErrorMessage(new ApiError(404, 'person_not_found'))).toBe('That person is no longer on file.');
  expect(personalErrorMessage(new ApiError(500, 'boom'))).toBe("Couldn't save (boom).");
  expect(personalErrorMessage(new Error('network'))).toBe("Couldn't save. Try again.");
});

it('keyForgetErrorMessage: read-only, self, then a retry line', () => {
  expect(keyForgetErrorMessage(new ApiError(423, 'read_only_mode', undefined, 'Read-only.'))).toBe('Read-only.');
  expect(keyForgetErrorMessage(new ApiError(403, 'cannot_target_self'))).toBe('Manage your own on My account.');
  for (const code of ['forbidden', 'rank_too_low']) {
    expect(keyForgetErrorMessage(new ApiError(403, code), 'one'))
      .toBe("You don't have the rights to change this person.");
  }
  expect(keyForgetErrorMessage(new ApiError(404, 'user_not_found'))).toBe('That person no longer exists.');
  expect(keyForgetErrorMessage(new Error('x'), 'one')).toBe('Could not forget that fingerprint. Try again.');
  expect(keyForgetErrorMessage(new Error('x'))).toBe('Could not forget the fingerprints. Try again.');
});
