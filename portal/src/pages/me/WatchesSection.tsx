/**
 * WatchesSection — "What you watch" on /me › Notifications: the things the person
 * watches themselves and the ones their Active groups watch (the groups' rows say
 * which group, and can't be changed here), then their asset watches. What reaches the
 * person still follows their switches and schedule; a watch only decides what they can
 * hear about.
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
 * The person's asset watches (GET /auth/me/asset-watches) are rows of the same table,
 * after all the others, in the order the API sends them (newest first). An asset watch has
 * no events to choose and ends once it has fired, so its menu is its own: "Change…" opens
 * the Watch asset dialog on it, which saves or stops the watch itself and says what became of
 * it (a change or a stop that goes through, or a watch found already ended, loads the lists
 * again and takes the last stop's error away), and "Stop watching", which ends it by the same
 * rules as any other stop. The two lists are asked for together and one's failure never takes
 * the other's answer away: if the asset watches can't be loaded the other watches are still
 * listed, with one fixed sentence (whatever went wrong) in an error line of its own, which goes
 * when a load goes through (a reload that fails keeps the asset watches that are there); if
 * the watches can't be loaded, nothing is listed.
 *
 * Until both first answers have landed the list says nothing, not even that it is empty
 * (a half-loaded list would read as an empty one), and the count beside the title, which
 * counts every row, waits for them too.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RowAction } from '../../components/hardware/RowActionsMenu';
import WatchAssetModal from '../../components/notifications/WatchAssetModal';
import WatchEventsModal from '../../components/notifications/WatchEventsModal';
import WatchesTable from '../../components/notifications/WatchesTable';
import {
  ApiError, createMyWatch, deleteMyAssetWatch, deleteMyWatch, listMyAssetWatches, listMyWatches,
  updateMyWatch, type AssetWatch, type NotificationKindSetting, type Watch,
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
type EventsDialog = { kind: 'row'; watch: Watch } | { kind: 'everywhere' };

/** The dialog that is open: an events dialog, or the Watch asset dialog on one of the
 *  asset watches. */
type Dialog = EventsDialog | { kind: 'asset'; watch: AssetWatch };

/** The key an asset watch is stopped under: its id is another table's, so it can't be
 *  the key of a watch. */
const assetKey = (watch: AssetWatch) => `asset:${watch.id}`;

export default function WatchesSection({ kinds }: { kinds: NotificationKindSetting[] }) {
  // null until the first answer; a failed reload keeps the list that is there.
  const [watches, setWatches] = useState<Watch[] | null>(null);
  // The same for the asset watches, except that a first load that fails leaves it empty (the
  // other watches still show) and says so (`assetsFailed`).
  const [assetWatches, setAssetWatches] = useState<AssetWatch[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [assetsFailed, setAssetsFailed] = useState(false);
  const [actionError, setActionError] = useState('');
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // Only the newest list call counts (an older answer arriving late is stale),
  // and none counts once the section is gone.
  const newest = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    const call = ++newest.current;
    const current = () => mounted.current && call === newest.current;

    const loadWatches = async () => {
      try {
        const rows = await listMyWatches();
        if (current()) {
          setWatches(rows);
          setLoadFailed(false);
        }
      } catch {
        if (current()) setLoadFailed(true);
      }
    };
    const loadAssetWatches = async () => {
      try {
        const rows = await listMyAssetWatches();
        if (current()) {
          setAssetWatches(rows);
          setAssetsFailed(false);
        }
      } catch {
        if (current()) {
          setAssetWatches((had) => had ?? []);
          setAssetsFailed(true);
        }
      }
    };

    await Promise.all([loadWatches(), loadAssetWatches()]);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  // The person's own Everything watch, once the list says they have one.
  const everywhere = watches?.find((w) => w.thing === 'everything' && w.via.type === 'you');

  // Every row, once both lists are in.
  const count = watches !== null && assetWatches !== null
    ? watches.length + assetWatches.length : null;

  /** Ends a watch: `end` is the call that does it, `key` the row that is busy until it is done. */
  const stop = async (key: string, end: () => Promise<void>) => {
    setStopping((s) => ({ ...s, [key]: true }));
    setActionError('');
    try {
      await end();
    } catch (err) {
      // A watch that is already gone is as good as stopped.
      if (!(err instanceof ApiError && err.code === 'watch_not_found')) {
        setActionError(watchErrorMessage(err));
      }
    }
    await load();     // stopped or not, show what is true now
    if (mounted.current) setStopping((s) => ({ ...s, [key]: false }));
  };

  const actionsFor = (watch: Watch): RowAction[] => {
    if (watch.via.type !== 'you') return [];
    const stopWatching: RowAction = {
      key: 'stop', label: 'Stop watching', destructive: true, disabled: stopping[watch.id],
      onSelect: () => void stop(watch.id, () => deleteMyWatch(watch.id)),
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

  /** An asset watch is always the person's own, and has no events to choose: Change… opens the
   *  Watch asset dialog on it, and Stop watching ends it. */
  const assetActionsFor = (watch: AssetWatch): RowAction[] => {
    const key = assetKey(watch);
    return [
      {
        key: 'change', label: 'Change…', disabled: stopping[key],
        onSelect: () => setDialog({ kind: 'asset', watch }),
      },
      {
        key: 'stop', label: 'Stop watching', destructive: true, disabled: stopping[key],
        onSelect: () => void stop(key, () => deleteMyAssetWatch(watch.id)),
      },
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

  /** The open events dialog's props. The everywhere dialog saves to the person's Everything
   *  watch as the list has it when they press Save: a change if there is one, else a
   *  new one. */
  const dialogProps = (current: EventsDialog) => {
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

  const shown = dialog && dialog.kind !== 'asset' ? dialogProps(dialog) : null;
  const changing = dialog?.kind === 'asset' ? dialog.watch : null;

  return (
    <>
      <section className="set-section me-watch-card" aria-label="What you watch">
        <div className="set-head set-head-actions">
          <div>
            <h3>
              What you watch{count !== null && <>{' '}<span className="badge-count">{count}</span></>}
            </h3>
            <p>{HINT}</p>
          </div>
          <button type="button" className="mini-btn" onClick={() => setDialog({ kind: 'everywhere' })}>
            {everywhere ? 'Edit events everywhere…' : 'Watch events everywhere…'}
          </button>
        </div>
        {loadFailed && <p className="pf-error set-hint">Could not load your watches.</p>}
        {assetsFailed && <p className="pf-error set-hint" role="alert">Could not load your asset watches.</p>}
        {actionError && <p className="pf-error set-hint" role="alert">{actionError}</p>}
        {watches && assetWatches && (
          <WatchesTable watches={watches} kinds={kinds} showVia actionsFor={actionsFor}
                        assetWatches={assetWatches} assetActionsFor={assetActionsFor}
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

      {changing && (
        // The dialog saves or stops the watch itself; whatever it reports (a change, a stop, a
        // watch found already ended) means the lists are out of date.
        <WatchAssetModal
          key={assetKey(changing)}
          assetId={changing.asset_id} assetName={changing.asset_name}
          initiativeId={changing.initiative_id} initiativeName={changing.initiative_name}
          currentStatus={changing.current_status} currentStatusLabel={changing.current_status_label}
          watch={changing}
          onSaved={() => { setActionError(''); void load(); }}
          onClose={() => setDialog(null)} />
      )}
    </>
  );
}
