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
  fetchTimeclockStatus, postClockIn, postClockOut,
  type KioskPersonRow, type KioskTimeclockStatus,
} from '../lib/api';
import { getAll } from '../lib/localDb';
import { kioskZone } from './format';
import {
  stationClockIn, stationClockOut, stationPeople, stationStatus,
} from './stationApi';

export interface TimeclockBackend {
  people(): Promise<KioskPersonRow[]>;
  status(personId: string): Promise<KioskTimeclockStatus>;
  clockIn(personId: string): Promise<KioskTimeclockStatus>;
  clockOut(personId: string): Promise<KioskTimeclockStatus>;
}

export function sessionBackend(serial: string): TimeclockBackend {
  return {
    people: () => getAll<KioskPersonRow>('people'),
    status: (personId) => fetchTimeclockStatus(personId, serial, kioskZone()),
    clockIn: (personId) => postClockIn({ serial, person_id: personId, tz: kioskZone() }),
    clockOut: (personId) => postClockOut({ serial, person_id: personId, tz: kioskZone() }),
  };
}

export function stationBackend(): TimeclockBackend {
  return {
    people: stationPeople,
    status: stationStatus,
    clockIn: stationClockIn,
    clockOut: stationClockOut,
  };
}
