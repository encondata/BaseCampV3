/**
 * WatchButton — the Watch / Watching toggle in the header of an initiative, a
 * site, a truck or an RFID Station kiosk page. It is the wiki's page watch button
 * (wiki/web/src/components/WatchButton.tsx) for the person's own watch: it reads
 * whether they watch the thing themselves (a group's watch of it does not count),
 * renders nothing until that is known, and a failure to read it counts as not
 * watching.
 *
 * A click stops the watch they have, or starts one on every event that applies
 * to the thing; narrowing its events is done on /me, under "What you watch". The
 * button waits for the answer. A call the server refuses because the watch is
 * already there or already gone (`already_watching`, `watch_not_found`) means the
 * button was out of date: it reads the state again and shows the real one, with no
 * toast. Any other failure leaves the button as it was, with a toast: the server's
 * own message for read-only maintenance, else "Couldn't update your watch.".
 */

import { useEffect, useRef, useState } from 'react';

import {
  ApiError, createMyWatch, deleteMyWatch, getWatchState, type WatchThing,
} from '../../lib/api';
import { useToast } from '../../lib/notificationsContext';
import { isOutOfDate } from '../../lib/watches';
import '../../styles/notifications.css';  // .watch-btn.on, and its size in a page header

/** The toast for a failure the person can do nothing about (the wiki's sentence). */
const FAILED = "Couldn't update your watch.";

interface State {
  watching: boolean;
  /** The person's own watch, while they have one. */
  watchId: string | null;
}

export default function WatchButton({ thing, id }: { thing: WatchThing; id: string }) {
  const toast = useToast();
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  // The thing the button is on right now. An answer that comes back after the page has moved
  // to another one is not this button's to show.
  const shown = useRef(`${thing}:${id}`);
  shown.current = `${thing}:${id}`;

  useEffect(() => {
    let live = true;
    setState(null);
    setBusy(false);
    getWatchState(thing, id)
      .then((s) => { if (live) setState({ watching: s.watching, watchId: s.watch_id }); })
      .catch(() => { if (live) setState({ watching: false, watchId: null }); });
    return () => { live = false; };
  }, [thing, id]);

  if (!state) return null;

  const toggle = async () => {
    if (busy) return;
    const target = shown.current;
    setBusy(true);
    try {
      if (state.watching && state.watchId) {
        await deleteMyWatch(state.watchId);
        if (shown.current === target) setState({ watching: false, watchId: null });
      } else {
        const watch = await createMyWatch({ thing, id, kinds: [] });
        if (shown.current === target) setState({ watching: true, watchId: watch.id });
      }
    } catch (err) {
      if (isOutOfDate(err)) {
        // Made or ended somewhere else: show what is true now, and say nothing.
        try {
          if (shown.current === target) {
            const now = await getWatchState(thing, id);
            if (shown.current === target) setState({ watching: now.watching, watchId: now.watch_id });
          }
        } catch {
          toast(FAILED);     // it can't be told which way it is: leave the button, and say so
        }
      } else {
        toast(err instanceof ApiError && err.code === 'read_only_mode' ? err.message : FAILED);
      }
    } finally {
      if (shown.current === target) setBusy(false);
    }
  };

  return (
    <button type="button" className={`btn-ghost watch-btn${state.watching ? ' on' : ''}`}
            aria-pressed={state.watching} disabled={busy}
            title={state.watching ? 'Stop watching' : 'Get notified about changes here'}
            onClick={() => void toggle()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="2.8" />
      </svg>
      {state.watching ? 'Watching' : 'Watch'}
    </button>
  );
}
