/** Biometric sign-in copy: the device page's status line and refusal
 *  messages, and the key panels' forget errors. */
import { expect, it } from 'vitest';

import { ApiError } from './api';
import {
  SHARED_STATION_LINE, fingerprintStatus, isSharedStation, keyForgetErrorMessage, monthDay,
  personalErrorMessage,
} from './biometric';

const NOW = Date.parse('2026-10-24T12:00:00Z');

it('monthDay is "Mon D"', () => {
  expect(monthDay('2026-11-22T12:00:00Z')).toBe('Nov 22');
  expect(monthDay('2026-03-05T12:00:00Z')).toBe('Mar 5');
});

it('fingerprintStatus: on while renews_at is ahead, expired after, off with no key', () => {
  expect(fingerprintStatus({ on: true, renews_at: '2026-11-22T12:00:00Z' }, NOW))
    .toBe('Fingerprint on · renews by Nov 22');
  expect(fingerprintStatus({ on: true, renews_at: '2026-10-20T12:00:00Z' }, NOW))
    .toBe('Fingerprint expired · renews at their next password sign-in');
  expect(fingerprintStatus({ on: false, renews_at: null }, NOW)).toBe('Fingerprint off');
  expect(fingerprintStatus(null, NOW)).toBe('Fingerprint off');
});

it('isSharedStation: any station type is shared', () => {
  expect(isSharedStation({ station_type: 'rfid', setup: { station_type: 'rfid' } })).toBe(true);
  expect(isSharedStation({ station_type: null, setup: { station_type: 'timeclock' } })).toBe(true);
  expect(isSharedStation({ station_type: null, setup: { station_type: null } })).toBe(false);
});

it('personalErrorMessage maps each not_eligible reason', () => {
  const ne = (reason: string) => new ApiError(422, 'not_eligible', { code: 'not_eligible', reason });
  expect(personalErrorMessage(ne('no_account'))).toBe('They need a portal login first.');
  expect(personalErrorMessage(ne('no_kiosk_view'))).toBe("They don't have kiosk access.");
  expect(personalErrorMessage(ne('move_identity'))).toBe("That's a move's kiosk identity, not a person.");
  expect(personalErrorMessage(ne('shared_station'))).toBe(SHARED_STATION_LINE);
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
  expect(keyForgetErrorMessage(new Error('x'), 'one')).toBe('Could not forget that fingerprint. Try again.');
  expect(keyForgetErrorMessage(new Error('x'))).toBe('Could not forget the fingerprints. Try again.');
});
