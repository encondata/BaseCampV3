/**
 * The pure rules behind watches: which events a watch on a thing can name (the
 * API's kinds_for), how a watch's events read, and what a failed watch call or
 * Watch toggle says.
 */
import { describe, expect, it } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE, type NotificationCategory, type NotificationKindSetting,
} from './api';
import {
  THING_LABELS, eventsText, isOutOfDate, kindsFor, watchErrorMessage, watchToggleMessage,
} from './watches';

function kind(
  key: string, label: string, category: NotificationCategory,
  extra: Partial<NotificationKindSetting> = {},
): NotificationKindSetting {
  return {
    kind: key, label, category, email: true, owner_always: false, critical: false, locked: false,
    watchable: false, everywhere: false, reaches: [], ...extra,
  };
}

// In registry order, as GET /notifications/settings lists them. "Kind A" reaches initiatives but
// is not marked everywhere, which is what tells the two rules apart.
const KINDS: NotificationKindSetting[] = [
  kind('report_ready', 'Report ready', 'reports'),
  kind('initiative_status_changed', 'Initiative status changed', 'initiatives',
    { watchable: true, everywhere: true, reaches: ['initiative', 'site'] }),
  kind('truck_status_changed', 'Truck status changed', 'trucks',
    { watchable: true, everywhere: true, reaches: ['truck', 'initiative', 'site'] }),
  kind('device_offline', 'Device offline', 'devices',
    { watchable: true, everywhere: true, reaches: ['device', 'site', 'initiative'] }),
  kind('kind_a', 'Kind A', 'initiatives',
    { watchable: true, everywhere: false, reaches: ['initiative'] }),
  kind('password_expiring', 'Password expiring', 'security', { owner_always: true, locked: true }),
];

const labels = (list: NotificationKindSetting[]) => list.map((k) => k.label);

describe('THING_LABELS', () => {
  it('names the four things and Everything', () => {
    expect(THING_LABELS).toEqual({
      initiative: 'Initiative', site: 'Site', truck: 'Truck', device: 'Device',
      everything: 'Everything',
    });
  });
});

describe('kindsFor', () => {
  it('a truck watch can name only Truck status changed', () => {
    expect(labels(kindsFor('truck', KINDS))).toEqual(['Truck status changed']);
  });

  it('a device watch can name only Device offline', () => {
    expect(labels(kindsFor('device', KINDS))).toEqual(['Device offline']);
  });

  it('an initiative watch names every kind that reaches initiatives, in registry order', () => {
    expect(labels(kindsFor('initiative', KINDS))).toEqual([
      'Initiative status changed', 'Truck status changed', 'Device offline', 'Kind A',
    ]);
  });

  it('a site watch names every kind that reaches sites', () => {
    expect(labels(kindsFor('site', KINDS))).toEqual([
      'Initiative status changed', 'Truck status changed', 'Device offline',
    ]);
  });

  it('an Everything watch names the kinds marked everywhere, not the ones that merely reach', () => {
    expect(labels(kindsFor('everything', KINDS))).toEqual([
      'Initiative status changed', 'Truck status changed', 'Device offline',
    ]);
  });

  it('never offers a kind nobody can watch for', () => {
    for (const thing of ['initiative', 'site', 'truck', 'device', 'everything'] as const) {
      expect(kindsFor(thing, KINDS).map((k) => k.kind)).not.toContain('report_ready');
      expect(kindsFor(thing, KINDS).map((k) => k.kind)).not.toContain('password_expiring');
    }
  });

  it('answers nothing while the kinds are not loaded', () => {
    expect(kindsFor('truck', [])).toEqual([]);
    expect(kindsFor('everything', [])).toEqual([]);
  });

  it('hands back the kinds themselves and leaves the list it was given alone', () => {
    const before = [...KINDS];
    const found = kindsFor('truck', KINDS);
    expect(found[0]).toBe(KINDS[2]);
    expect(KINDS).toEqual(before);
  });
});

describe('eventsText', () => {
  it('says "All events" for a watch that names none', () => {
    expect(eventsText([], KINDS)).toBe('All events');
  });

  it('is the event\'s label for one', () => {
    expect(eventsText(['truck_status_changed'], KINDS)).toBe('Truck status changed');
  });

  it('joins two labels with ", "', () => {
    expect(eventsText(['initiative_status_changed', 'truck_status_changed'], KINDS))
      .toBe('Initiative status changed, Truck status changed');
  });

  it('keeps the order the watch has them in', () => {
    expect(eventsText(['truck_status_changed', 'initiative_status_changed'], KINDS))
      .toBe('Truck status changed, Initiative status changed');
  });

  it('shows a kind the registry no longer has as itself', () => {
    expect(eventsText(['retired_kind', 'truck_status_changed'], KINDS))
      .toBe('retired_kind, Truck status changed');
    expect(eventsText(['truck_status_changed'], [])).toBe('truck_status_changed');
  });
});

describe('isOutOfDate', () => {
  it.each([
    [409, 'already_watching'], [404, 'watch_not_found'],
  ])('a %i %s means the screen was out of date', (status, code) => {
    expect(isOutOfDate(new ApiError(status, code))).toBe(true);
  });

  it.each([
    [404, 'thing_not_found'], [404, 'group_not_found'], [422, 'invalid_thing'],
    [422, 'invalid_kind'], [423, 'read_only_mode'], [403, 'forbidden'], [500, 'unknown_error'],
  ])('a %i %s does not', (status, code) => {
    expect(isOutOfDate(new ApiError(status, code))).toBe(false);
  });

  it('nothing that is not an API answer does (no connection, a bug)', () => {
    expect(isOutOfDate(new Error('already_watching'))).toBe(false);
    expect(isOutOfDate({ code: 'watch_not_found' })).toBe(false);
    expect(isOutOfDate('already_watching')).toBe(false);
    expect(isOutOfDate(undefined)).toBe(false);
  });
});

describe('watchErrorMessage', () => {
  it('already_watching says so', () => {
    expect(watchErrorMessage(new ApiError(409, 'already_watching')))
      .toBe("You're already watching this.");
  });

  it('read-only maintenance says its own sentence', () => {
    expect(watchErrorMessage(new ApiError(423, 'read_only_mode', undefined, READ_ONLY_MESSAGE)))
      .toBe(READ_ONLY_MESSAGE);
    expect(watchErrorMessage(new ApiError(423, 'read_only_mode', undefined, 'Cutover')))
      .toBe('Cutover');
  });

  it.each([
    [404, 'thing_not_found'], [404, 'watch_not_found'], [404, 'group_not_found'],
    [422, 'invalid_thing'], [422, 'invalid_kind'], [422, 'kinds_required'], [403, 'forbidden'],
  ])('a %i %s is the house fallback with its code', (status, code) => {
    expect(watchErrorMessage(new ApiError(status, code))).toBe(`Request failed (${code}).`);
  });

  it('anything that is not an API answer (no connection, a bug) is the plain sentence', () => {
    expect(watchErrorMessage(new Error('Failed to fetch'))).toBe("Couldn't update your watch.");
    expect(watchErrorMessage(new TypeError('x'))).toBe("Couldn't update your watch.");
    expect(watchErrorMessage('nope')).toBe("Couldn't update your watch.");
    expect(watchErrorMessage(undefined)).toBe("Couldn't update your watch.");
  });
});

describe('watchToggleMessage', () => {
  it('read-only maintenance says the server\'s own sentence', () => {
    expect(watchToggleMessage(new ApiError(423, 'read_only_mode', undefined, READ_ONLY_MESSAGE)))
      .toBe(READ_ONLY_MESSAGE);
    expect(watchToggleMessage(new ApiError(423, 'read_only_mode', undefined, 'Cutover')))
      .toBe('Cutover');
  });

  it.each([
    [409, 'already_watching'], [404, 'watch_not_found'], [404, 'thing_not_found'],
    [422, 'invalid_thing'], [403, 'forbidden'], [500, 'unknown_error'],
  ])('any other %i %s is the plain sentence, with no code', (status, code) => {
    expect(watchToggleMessage(new ApiError(status, code))).toBe("Couldn't update your watch.");
  });

  it('so is anything that is not an API answer, and no error at all', () => {
    expect(watchToggleMessage(new Error('Failed to fetch'))).toBe("Couldn't update your watch.");
    expect(watchToggleMessage({ code: 'read_only_mode', message: 'Cutover' }))
      .toBe("Couldn't update your watch.");
    expect(watchToggleMessage(undefined)).toBe("Couldn't update your watch.");
    expect(watchToggleMessage()).toBe("Couldn't update your watch.");
  });
});
