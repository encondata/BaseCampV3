/**
 * Where the time clock flow gets its people and its punches. The same
 * screens run in two places: on a signed-in kiosk (`sessionBackend`: the
 * synced people list in IndexedDB, the kiosk's own session for status and
 * punches) and on the signed-out Time Clock station (`stationBackend`:
 * the edge's `/edge/timeclock/*` routes, which hold the station key).
 * Both send the browser's own zone (`kioskZone`) for "today" when the
 * site has none.
 */

import {
  fetchTimeclockStatus, postClockIn, postClockOut, postLearningLink, postLearningOverride,
  type KioskPersonRow, type KioskTimeclockStatus, type LearningOverrideForm,
} from '../lib/api';
import { getAll } from '../lib/localDb';
import { kioskZone } from './format';
import {
  stationClockIn, stationClockOut, stationLearningLink, stationLearningOverride,
  stationPeople, stationStatus,
} from './stationApi';

export interface TimeclockBackend {
  people(): Promise<KioskPersonRow[]>;
  status(personId: string): Promise<KioskTimeclockStatus>;
  /** `learningOverrideId`: the admin override this clock-in rides on. */
  clockIn(personId: string, learningOverrideId?: string): Promise<KioskTimeclockStatus>;
  clockOut(personId: string): Promise<KioskTimeclockStatus>;
  /** "Email me the link" for a worker with unsigned learning. */
  learningLink(personId: string): Promise<{ sent: boolean }>;
  /** An admin lets the worker clock in; answers the override's id. */
  learningOverride(personId: string, form: LearningOverrideForm): Promise<{ override_id: string }>;
}

export function sessionBackend(serial: string): TimeclockBackend {
  return {
    people: () => getAll<KioskPersonRow>('people'),
    status: (personId) => fetchTimeclockStatus(personId, serial, kioskZone()),
    clockIn: (personId, learningOverrideId) => postClockIn({
      serial, person_id: personId, tz: kioskZone(),
      ...(learningOverrideId ? { learning_override_id: learningOverrideId } : {}),
    }),
    clockOut: (personId) => postClockOut({ serial, person_id: personId, tz: kioskZone() }),
    learningLink: (personId) => postLearningLink({ serial, person_id: personId, tz: kioskZone() }),
    learningOverride: (personId, form) => postLearningOverride({
      ...form, serial, person_id: personId, tz: kioskZone(),
    }),
  };
}

export function stationBackend(): TimeclockBackend {
  return {
    people: stationPeople,
    status: stationStatus,
    clockIn: stationClockIn,
    clockOut: stationClockOut,
    learningLink: stationLearningLink,
    learningOverride: stationLearningOverride,
  };
}
