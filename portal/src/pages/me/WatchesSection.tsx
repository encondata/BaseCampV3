/**
 * WatchesSection — "What you watch" on /me › Notifications: the things the person
 * watches themselves and the ones their Active groups watch (the groups' rows say
 * which group, and can't be changed here). What reaches the person still follows
 * their switches and schedule; a watch only decides what they can hear about.
 *
 * Their own rows can have their events chosen ("Choose events…", a dialog that
 * saves with PATCH /auth/me/watches/{id}) or be stopped; a wiki row (a library, folder
 * or page) can only be stopped, since a wiki watch names no events. The head's button watches
 * chosen events everywhere (an Everything watch), or edits them once the person
 * has one. A change that goes through loads the list again; so does a stop, however it
 * ends, and a save the server refuses because the list was out of date (the watch is
 * already there, or already gone; the dialog still says why), so the section shows
 * what the server says. The error a failed stop leaves stays until the next stop, or a
 * save that goes through, clears it. `kinds` is the company settings' registry, which
 * names the events; until it arrives an event reads as its own code.
 *
 * Until the first answer lands the list says nothing, not even that it is empty, and
 * the count beside the title waits for it too.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RowAction } from '../../components/hardware/RowActionsMenu';
import WatchEventsModal from '../../components/notifications/WatchEventsModal';
import WatchesTable from '../../components/notifications/WatchesTable';
import {
  ApiError, createMyWatch, deleteMyWatch, listMyWatches, updateMyWatch,
  type NotificationKindSetting, type Watch,
} from '../../lib/api';
import { THING_LABELS, isOutOfDate, isWikiWatch, watchErrorMessage } from '../../lib/watches';
import '../../styles/directory.css';      // .badge-count, .mini-btn, the data table
import '../../styles/profile.css';        // .pf-error
import '../../styles/settings.css';       // .set-section, .set-head, .set-hint
import '../../styles/notifications.css';  // .me-watch-card

const HINT = 'Things you watch and the ones your groups watch. '
  + 'What reaches you still follows your switches and schedule.';
const EMPTY = "You aren't watching anything yet. Use Watch on a page to start.";
const DIALOG_HINT = 'Pick the events you want to hear about.';

/** The events dialog that is open: one of the rows' watches, or the person's
 *  Everything watch (which may not exist yet). */
type Dialog = { kind: 'row'; watch: Watch } | { kind: 'everywhere' };

export default function WatchesSection({ kinds }: { kinds: NotificationKindSetting[] }) {
  // null until the first answer; a failed reload keeps the list that is there.
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState('');
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // Only the newest list call counts (an older answer arriving late is stale),
  // and none counts once the section is gone.
  const newest = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const call = ++newest.current;
    try {
      const rows = await listMyWatches();
      if (mounted.current && call === newest.current) {
        setWatches(rows);
        setLoadFailed(false);
      }
    } catch {
      if (mounted.current && call === newest.current) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  // The person's own Everything watch, once the list says they have one.
  const everywhere = watches?.find((w) => w.thing === 'everything' && w.via.type === 'you');

  const stop = async (watch: Watch) => {
    setStopping((s) => ({ ...s, [watch.id]: true }));
    setActionError('');
    try {
      await deleteMyWatch(watch.id);
    } catch (err) {
      // A watch that is already gone is as good as stopped.
      if (!(err instanceof ApiError && err.code === 'watch_not_found')) {
        setActionError(watchErrorMessage(err));
      }
    }
    await load();     // stopped or not, show what is true now
    if (mounted.current) setStopping((s) => ({ ...s, [watch.id]: false }));
  };

  const actionsFor = (watch: Watch): RowAction[] => {
    if (watch.via.type !== 'you') return [];
    const stopWatching: RowAction = {
      key: 'stop', label: 'Stop watching', destructive: true, disabled: stopping[watch.id],
      onSelect: () => void stop(watch),
    };
    // The wiki has no event choice: its rows can only be stopped.
    if (isWikiWatch(watch)) return [stopWatching];
    return [
      {
        key: 'choose', label: 'Choose events…', disabled: stopping[watch.id],
        onSelect: () => setDialog({ kind: 'row', watch }),
      },
      stopWatching,
    ];
  };

  /** Runs a dialog's save. When it goes through the list is loaded again and the last
   *  stop's error goes. When the server refuses it because the list was out of date (the
   *  watch is already there, or already gone) the list is loaded again too, and the
   *  dialog still shows why (the error goes on to it). */
  const saved = async (save: () => Promise<unknown>): Promise<void> => {
    try {
      await save();
    } catch (err) {
      if (isOutOfDate(err)) void load();
      throw err;
    }
    setActionError('');
    void load();
  };

  /** The open dialog's props. The everywhere dialog saves to the person's Everything
   *  watch as the list has it when they press Save: a change if there is one, else a
   *  new one. */
  const dialogProps = (current: Dialog) => {
    if (current.kind === 'everywhere') {
      return {
        key: 'everywhere', title: THING_LABELS.everything, thing: 'everything' as const,
        initial: everywhere?.kinds ?? [],
        onSave: (picked: string[]) => saved(() => (everywhere
          ? updateMyWatch(everywhere.id, picked)
          : createMyWatch({ thing: 'everything', id: null, kinds: picked }))),
      };
    }
    const { watch } = current;
    return {
      key: watch.id,
      title: watch.thing === 'everything'
        ? THING_LABELS.everything : (watch.thing_name ?? THING_LABELS[watch.thing]),
      thing: watch.thing, initial: watch.kinds,
      onSave: (picked: string[]) => saved(() => updateMyWatch(watch.id, picked)),
    };
  };

  const shown = dialog ? dialogProps(dialog) : null;

  return (
    <>
      <section className="set-section me-watch-card" aria-label="What you watch">
        <div className="set-head set-head-actions">
          <div>
            <h3>
              What you watch{watches !== null && <>{' '}<span className="badge-count">{watches.length}</span></>}
            </h3>
            <p>{HINT}</p>
          </div>
          <button type="button" className="mini-btn" onClick={() => setDialog({ kind: 'everywhere' })}>
            {everywhere ? 'Edit events everywhere…' : 'Watch events everywhere…'}
          </button>
        </div>
        {loadFailed && <p className="pf-error set-hint">Could not load your watches.</p>}
        {actionError && <p className="pf-error set-hint" role="alert">{actionError}</p>}
        {watches && (
          <WatchesTable watches={watches} kinds={kinds} showVia actionsFor={actionsFor}
                        emptyText={EMPTY} />
        )}
      </section>

      {shown && (
        <WatchEventsModal
          key={shown.key}
          eyebrow="Watch" title={shown.title} description={DIALOG_HINT}
          thing={shown.thing} kinds={kinds} initial={shown.initial}
          onSave={shown.onSave} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
