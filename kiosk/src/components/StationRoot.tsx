/**
 * `/`. On a laptop set up as a Time Clock station whose display has been
 * armed (Start Time Clock), and with nobody signed in, it is the
 * signed-out time clock's Welcome screen. Everywhere else it is the
 * guarded Home exactly as before: an anonymous kiosk goes to sign-in, a
 * signed-in person gets Home — even on the station, which is how an
 * administrator reaches Setup and Settings there.
 *
 * Nothing renders while the station info loads (as KioskGuard does while
 * the session restores). The info is re-read every minute so a station
 * whose key is renewed (or lapses) un-pauses (or pauses) on its own; a
 * failed re-read keeps the last answer rather than dropping a running
 * time clock onto the sign-in page.
 */

import { useEffect, useMemo, useRef } from 'react';

import { useKioskAuth } from '../auth/KioskAuthContext';
import KioskShell from '../layout/KioskShell';
import Home from '../pages/Home';
import { stationBackend } from '../timeclock/backend';
import { useStationInfo, type StationInfo } from '../timeclock/stationApi';
import TimeclockFlow from '../timeclock/TimeclockFlow';
import KioskGuard from './KioskGuard';

const REFRESH_MS = 60_000;

export default function StationRoot() {
  const { loading, info, refresh } = useStationInfo();
  const { status } = useKioskAuth();
  const backend = useMemo(() => stationBackend(), []);

  const last = useRef<StationInfo | null>(null);
  if (info) last.current = info;
  const station = info ?? last.current;

  const timeclock = !!station?.timeclock;
  useEffect(() => {
    if (!timeclock) return undefined;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [timeclock, refresh]);

  if (loading) return null;
  if (station?.timeclock && station.armed && status === 'anon') {
    return (
      <TimeclockFlow mode="station" backend={backend} paused={!station.ready}
                     keyMissing={!!station.key_missing && !station.paused} />
    );
  }
  return <KioskGuard><KioskShell><Home /></KioskShell></KioskGuard>;
}
