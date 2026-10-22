/**
 * The Time Clock station's edge client (laptop edition). The edge holds
 * the station key; the browser only ever talks to `/edge/timeclock/*`.
 *
 * - `getStationInfo` is public: the kiosk asks it on load to learn whether
 *   `/` with nobody signed in should show the time clock.
 * - `armDisplay` is the one signed-in call (Start Time Clock): it goes
 *   through `apiFetch` so the session bearer rides along, and the edge
 *   answers with the HttpOnly display cookie the signed-out routes need.
 * - Status and punches carry the browser's own zone (`tz`): the portal's
 *   "today" when the station's site has none.
 * - The people list, status and punches run signed out, so they are plain
 *   same-origin fetches (the display cookie rides along on its own), never
 *   `apiFetch`, which would read a 401 as the session ending. Their errors
 *   keep the edge's own code and status (`edge_offline` included), unlike
 *   `lib/api.ts`, which folds `edge_offline` into `network`.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError, apiFetch, type KioskPeopleSync, type KioskPersonRow, type KioskTimeclockStatus,
} from '../lib/api';
import { isLaptop } from '../lib/platform';
import { kioskZone } from './format';

export interface StationInfo {
  timeclock: boolean;
  ready: boolean;
  paused: boolean;
  armed: boolean;
  /** Set up as a Time Clock, but the station key never arrived (or was dropped). */
  key_missing: boolean;
  initiative_name: string | null;
  site_name: string | null;
}

const BASE = '/edge/timeclock';

async function edgeError(resp: Response): Promise<ApiError> {
  let code = 'unknown_error';
  let detail: unknown;
  try {
    const body = await resp.json();
    detail = body?.detail;
    code = body?.detail?.code ?? code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(resp.status, code, detail);
}

/** How long a read may hang before it counts as unreachable. A stuck
 *  status lookup would otherwise freeze the Welcome screen. */
export const READ_TIMEOUT_MS = 10_000;

async function edgeFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!resp.ok) throw await edgeError(resp);
  return resp.json() as Promise<T>;
}

/** A GET that gives up after READ_TIMEOUT_MS as `network`. Punches are
 *  never timed out here: an abandoned POST may still have been recorded,
 *  and "not recorded" would then be a lie. */
async function edgeRead<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    return await edgeFetch<T>(path, { signal: controller.signal });
  } catch (err) {
    // an abort while the body is still arriving rejects outside edgeFetch's guard
    throw err instanceof ApiError ? err : new ApiError(0, 'network');
  } finally {
    clearTimeout(timer);
  }
}

function postPerson(path: string, personId: string): Promise<KioskTimeclockStatus> {
  return edgeFetch<KioskTimeclockStatus>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ person_id: personId, tz: kioskZone() }),
  });
}

/** What the edge says about this laptop's station; null on any failure. */
export async function getStationInfo(): Promise<StationInfo | null> {
  try {
    return await edgeRead<StationInfo>('/station');
  } catch {
    return null;
  }
}

/** Marks this browser as the station's display (Start Time Clock). Throws
 *  `ApiError`: 409 `not_timeclock_station`, 403 `move_locked` for a
 *  move-password session. */
export async function armDisplay(): Promise<void> {
  const resp = await apiFetch(`${BASE}/arm`, { method: 'POST' });
  if (!resp.ok) throw await edgeError(resp);
}

export async function stationPeople(): Promise<KioskPersonRow[]> {
  return (await edgeRead<KioskPeopleSync>('/people')).people;
}

export function stationStatus(personId: string): Promise<KioskTimeclockStatus> {
  const tz = kioskZone();
  const query = tz ? `?tz=${encodeURIComponent(tz)}` : '';
  return edgeRead<KioskTimeclockStatus>(`/status/${encodeURIComponent(personId)}${query}`);
}

export function stationClockIn(personId: string): Promise<KioskTimeclockStatus> {
  return postPerson('/clock-in', personId);
}

export function stationClockOut(personId: string): Promise<KioskTimeclockStatus> {
  return postPerson('/clock-out', personId);
}

/** The station info on a laptop. `loading` is true only until the first
 *  answer; `refresh()` reads again and keeps the last info meanwhile, so a
 *  screen built on it never blanks. Web mode never asks. */
export function useStationInfo(): { loading: boolean; info: StationInfo | null; refresh(): void } {
  const laptop = isLaptop();
  const [loading, setLoading] = useState(laptop);
  const [info, setInfo] = useState<StationInfo | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!laptop) return undefined;
    let live = true;
    void getStationInfo().then((next) => {
      if (!live) return;
      setInfo(next);
      setLoading(false);
    });
    return () => { live = false; };
  }, [laptop, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { loading: laptop && loading, info: laptop ? info : null, refresh };
}
