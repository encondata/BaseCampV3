/**
 * useDeviceWatches — the person's own watches of devices, for the row menus of the
 * Fixed Readers and Routers lists. A fixed reader or an approved router has no page
 * of its own, so no Watch button (an RFID or Dock Station's page has one): its row menu offers
 * "Watch" or "Stop watching" instead, and this hook is what that menu asks.
 *
 * The person's watches are read once (GET /auth/me/watches), and only their own watches
 * of devices are kept: a group's watch of a device does not count as theirs, as with the
 * Watch button's state. Until the list lands, and if it never does, they watch nothing as
 * far as the menu knows; starting a watch they already have is answered `already_watching`,
 * which reads the list again like any other out-of-date click.
 *
 * `toggle` stops the watch they have, or starts one on every event that applies (narrowing
 * its events is done on /me, under "What you watch"), then reads the list again. A change the
 * server refuses because the menu was out of date (the watch is already there, or already
 * gone: `isOutOfDate`) reads the list again and shows what is true now, with no toast. Any
 * other failure leaves the menu as it was, with the Watch button's toast (lib/watches.ts
 * `watchToggleMessage`): the server's own message for read-only maintenance, else "Couldn't
 * update your watch.". A toggle is one at a time per device; `busy` says one is on its way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createMyWatch, deleteMyWatch, listMyWatches, type Watch,
} from '../../lib/api';
import { useToast } from '../../lib/notificationsContext';
import { isOutOfDate, watchToggleMessage } from '../../lib/watches';

export interface DeviceWatches {
  /** Whether the person watches this device themselves. */
  watching: (deviceId: string) => boolean;
  /** Stops the watch they have on the device, or starts one. It does not reject: a
   *  failure is told in a toast. */
  toggle: (deviceId: string) => Promise<void>;
  /** Whether a toggle for this device is on its way. */
  busy: (deviceId: string) => boolean;
}

/** Device id → the id of the person's own watch of it. */
type Own = ReadonlyMap<string, string>;

/** The person's own watches of devices among `watches`. */
function ownDeviceWatches(watches: Watch[]): Own {
  const own = new Map<string, string>();
  for (const w of watches) {
    if (w.thing === 'device' && w.via.type === 'you' && w.thing_id) own.set(w.thing_id, w.id);
  }
  return own;
}

export function useDeviceWatches(): DeviceWatches {
  const toast = useToast();
  const [own, setOwn] = useState<Own>(() => new Map());
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());

  // `toggle` reads the watch it is about to stop from here, not from the render it was made in.
  const ownRef = useRef(own);
  ownRef.current = own;
  // Only the newest read counts (an older answer arriving late is stale), and none counts
  // once the list is gone.
  const newest = useRef(0);
  const mounted = useRef(true);
  // The devices whose toggle is on its way, known at once (state lags a render).
  const inFlight = useRef(new Set<string>());

  /** Reads the person's watches again. False when the list could not be read. */
  const read = useCallback(async (): Promise<boolean> => {
    const call = ++newest.current;
    try {
      const rows = await listMyWatches();
      if (mounted.current && call === newest.current) setOwn(ownDeviceWatches(rows));
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => { mounted.current = false; };
  }, [read]);

  const toggle = useCallback(async (deviceId: string): Promise<void> => {
    if (inFlight.current.has(deviceId)) return;
    inFlight.current.add(deviceId);
    setWorking((cur) => new Set(cur).add(deviceId));
    try {
      const watchId = ownRef.current.get(deviceId);
      try {
        if (watchId) {
          await deleteMyWatch(watchId);
          if (mounted.current) {
            setOwn((cur) => { const next = new Map(cur); next.delete(deviceId); return next; });
          }
        } else {
          const watch = await createMyWatch({ thing: 'device', id: deviceId, kinds: [] });
          if (mounted.current) setOwn((cur) => new Map(cur).set(deviceId, watch.id));
        }
      } catch (err) {
        if (!isOutOfDate(err)) {
          toast(watchToggleMessage(err));
          return;       // nothing changed, so there is nothing to read again
        }
        // Made or ended somewhere else: show what is true now, and say nothing.
        if (!(await read())) toast(watchToggleMessage());     // it can't be told which way it is: leave the menu, and say so
        return;
      }
      // What is true now. A list that can't be read leaves the change as it was just made.
      await read();
    } finally {
      inFlight.current.delete(deviceId);
      if (mounted.current) {
        setWorking((cur) => { const next = new Set(cur); next.delete(deviceId); return next; });
      }
    }
  }, [read, toast]);

  const watching = useCallback((deviceId: string) => own.has(deviceId), [own]);
  const busy = useCallback((deviceId: string) => working.has(deviceId), [working]);

  return { watching, toggle, busy };
}
