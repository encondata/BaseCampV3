/**
 * GroupWatchesPanel — "What this group watches" on a notification group's page,
 * under Members: the things and events every member of the group hears about
 * (while the group is Active). It is the /me list of watches without Via, since
 * every row is this group's.
 *
 * People who can change notifications get "Add watch" (AddGroupWatchModal) and,
 * on each row, "Choose events…" (WatchEventsModal, saved with PATCH) and "Remove"; a
 * wiki row (a library, folder or page) has only "Remove", since a wiki watch names no
 * events. Everyone else reads the list. Every change reads the list again, so the panel
 * shows what the server says; a Remove that finds the watch already gone is as good
 * as removed. The error a failed Remove leaves stays until a later Remove, or an
 * add or an events save that goes through, clears it. The company settings' `kinds`
 * name the events; until they have answered the list is not shown (so no event
 * flashes as its code), and if they can't be loaded the panel says the watches could
 * not be loaded, as it does for the list itself, and shows no list: events are never
 * listed as their codes.
 *
 * Until the first answer lands the panel says nothing about the list: no count and
 * not even that it is empty. Only the newest list call counts (an older answer
 * arriving late is stale), and moving to another group starts the panel over.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError, deleteGroupWatch, getNotificationSettings, listGroupWatches, updateGroupWatch,
  type NotificationGroupDetail, type NotificationKindSetting, type Watch,
} from '../../lib/api';
import { THING_LABELS, isWikiWatch, watchErrorMessage } from '../../lib/watches';
import type { RowAction } from '../hardware/RowActionsMenu';
import AddGroupWatchModal from './AddGroupWatchModal';
import WatchEventsModal from './WatchEventsModal';
import WatchesTable from './WatchesTable';
import '../../styles/directory.css';      // .mini-btn
import '../../styles/profile.css';        // .pf-error
import '../../styles/initiatives.css';    // .init-panel, .idet-panel-head

const EMPTY = "This group isn't watching anything yet.";
const LOAD_FAILED = "Could not load this group's watches.";
const DIALOG_HINT = 'Pick the events this group hears about.';

/** The dialog that is open: Add watch, or one row's events. */
type Dialog = { kind: 'add' } | { kind: 'choose'; watch: Watch };

export default function GroupWatchesPanel({ group, canChange }: {
  group: NotificationGroupDetail;
  canChange: boolean;
}) {
  // One panel per group: its list, dialogs and errors are the group's own.
  return <PanelFor key={group.id} group={group} canChange={canChange} />;
}

function PanelFor({ group, canChange }: { group: NotificationGroupDetail; canChange: boolean }) {
  const groupId = group.id;
  // null until the first answer; a failed reload keeps the list that is there.
  const [watches, setWatches] = useState<Watch[] | null>(null);
  // null until the company settings have answered, and for good if they failed.
  const [kinds, setKinds] = useState<NotificationKindSetting[] | null>(null);
  const [kindsFailed, setKindsFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState('');
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<Dialog | null>(null);

  // Only the newest list call counts: an older answer arriving late is stale.
  const newest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const call = ++newest.current;
    try {
      const rows = await listGroupWatches(groupId);
      if (call === newest.current) {
        setWatches(rows);
        setLoadFailed(false);
      }
    } catch {
      if (call === newest.current) setLoadFailed(true);
    }
  }, [groupId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let alive = true;
    getNotificationSettings()
      .then((settings) => { if (alive) setKinds(settings.kinds); })
      .catch(() => { if (alive) setKindsFailed(true); });
    return () => { alive = false; };
  }, []);

  const remove = async (watch: Watch) => {
    setRemoving((r) => ({ ...r, [watch.id]: true }));
    setActionError('');
    try {
      await deleteGroupWatch(groupId, watch.id);
    } catch (err) {
      // A watch that is already gone is as good as removed.
      if (!(err instanceof ApiError && err.code === 'watch_not_found')) {
        setActionError(watchErrorMessage(err));
      }
    }
    await load();     // removed or not, show what is true now
    setRemoving((r) => ({ ...r, [watch.id]: false }));
  };

  const actionsFor = (watch: Watch): RowAction[] => {
    if (!canChange) return [];
    const removeWatch: RowAction = {
      key: 'remove', label: 'Remove', destructive: true, disabled: removing[watch.id],
      onSelect: () => void remove(watch),
    };
    // The wiki has no event choice: its rows can only be removed.
    if (isWikiWatch(watch)) return [removeWatch];
    return [
      {
        key: 'choose', label: 'Choose events…', disabled: removing[watch.id],
        onSelect: () => setDialog({ kind: 'choose', watch }),
      },
      removeWatch,
    ];
  };

  const chosen = dialog?.kind === 'choose' ? dialog.watch : null;

  return (
    <>
      <div className="init-panel" style={{ marginTop: 18 }}>
        <div className="idet-panel-head">
          <p className="eyebrow-sm">
            What this group watches{watches ? ` — ${watches.length}` : ''}
          </p>
          {canChange && (
            <button type="button" className="mini-btn" onClick={() => setDialog({ kind: 'add' })}>
              Add watch
            </button>
          )}
        </div>
        {(loadFailed || kindsFailed) && <p className="pf-error">{LOAD_FAILED}</p>}
        {actionError && <p className="pf-error" role="alert">{actionError}</p>}
        {watches && kinds && (
          <WatchesTable watches={watches} kinds={kinds} showVia={false} actionsFor={actionsFor}
                        emptyText={EMPTY} />
        )}
      </div>

      {dialog?.kind === 'add' && (
        <AddGroupWatchModal
          group={group} kinds={kinds ?? []}
          onAdded={() => { setDialog(null); setActionError(''); void load(); }}
          onClose={() => setDialog(null)} />
      )}

      {chosen && (
        <WatchEventsModal
          key={chosen.id}
          eyebrow={group.name}
          title={chosen.thing_name ?? THING_LABELS[chosen.thing]}
          description={DIALOG_HINT}
          thing={chosen.thing} kinds={kinds ?? []} initial={chosen.kinds}
          onSave={async (picked) => {
            try {
              await updateGroupWatch(groupId, chosen.id, picked);
              setActionError('');
            } finally {
              void load();     // changed or refused, show what is true now
            }
          }}
          onClose={() => setDialog(null)} />
      )}
    </>
  );
}
