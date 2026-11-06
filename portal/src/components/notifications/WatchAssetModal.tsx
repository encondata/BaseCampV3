/**
 * WatchAssetModal — "Watch…" on an asset: the standard notification dialog in which the person
 * says what to wait for, and watches it. A "Watch for" strip picks Next update (any scan, status
 * change or edit, or a move into or out of a container or truck) or Status becomes, which adds a
 * status picker (the house ComboBox) over the active asset statuses (GET /status-values, asked for
 * as the dialog opens) and, as a hint, the status the asset has now (`currentStatus`: its own, or
 * its status on the initiative when the watch is set on one). The status it has now is left out of
 * the picker, since a watch for it would mean nothing; watching for its next update covers that.
 * With no `currentStatus` (a watch whose initiative row is gone) the hint is left out and nothing
 * is left out of the picker. A status list that fails to load is told beside the buttons while
 * Status becomes is chosen ("Could not load the status list."), leaves the picker off, and leaves
 * Next update as it was.
 *
 * It opens on Next update, or on the condition and status of the watch it is opened on (`watch`).
 * The primary button is Watch for a new watch and Save for an existing one, which also has Stop
 * watching. It is off while Status becomes has no status picked: a status the picker does not
 * offer (the one the asset has now, or one since retired) counts as none. A save sends no status
 * with a Next update, which the API refuses.
 *
 * Once a watch is set or changed `onSaved` is called with it, and once it is stopped with null,
 * then the dialog closes through `onClose`. A save that is refused keeps the dialog open with the
 * reason beside the buttons; any change to the choice takes the old reason away. The asset
 * watch's own refusals have their own sentences (`already_at_status`, `thing_not_found`,
 * `not_on_initiative`), any other is the watch screens' (lib/watches.ts `watchErrorMessage`).
 * While a request is on its way nothing can close the dialog or change the choice.
 *
 * A watch can be set or ended elsewhere (another tab, the once-a-minute check) while the dialog is
 * open. Watch answered `already_watching` reads the state again and takes the watch that is there
 * (`onSaved` with it) and closes, saying nothing; if the state cannot be read, it says what the
 * server said. Save answered `watch_not_found` means the check ended the watch: `onSaved(null)`,
 * and the dialog stays open as a new watch (the primary button now reads Watch), with a sentence
 * saying so. Stop watching answered `watch_not_found` counts as stopped.
 */

import { useEffect, useId, useMemo, useState } from 'react';

import {
  ApiError, createMyAssetWatch, deleteMyAssetWatch, getAssetWatchState, listAssetStatuses,
  updateMyAssetWatch, type AssetWatch, type AssetWatchCondition, type StatusValue,
} from '../../lib/api';
import { watchErrorMessage } from '../../lib/watches';
import ComboBox from '../ComboBox';
import ChoiceField from './ChoiceField';
import NotificationModal from './NotificationModal';
import '../../styles/directory.css';   // .mini-btn, .segmented
import '../../styles/profile.css';     // .pf-form, .btn-solid, .pf-error

/** Under the title: what a watch does. */
const HINT = "You'll get one notification the first time this happens. Then the watch ends.";

/** Under Next update: what counts as an update. */
const NEXT_UPDATE_HINT = 'Any scan, status change or edit, or a move into or out of a container or truck.';

/** What the "Watch for" strip offers, in its order. */
const CONDITIONS: { key: AssetWatchCondition; label: string }[] = [
  { key: 'next_update', label: 'Next update' },
  { key: 'status', label: 'Status becomes' },
];

/** What the asset watch says for its own refusals (the sentence for each code). */
const ALREADY_AT_STATUS = 'It already has that status. Pick another one, or watch for its next update.';
const CANT_WATCH = "You can't watch this asset.";
const LEFT_INITIATIVE = 'This asset is no longer on this initiative.';

/** Said when the dialog finds its watch already ended (the check ended it since it opened). */
const ENDED = 'This watch has already ended. Press Watch to set a new one.';

/** The sentence for a status list that can't be loaded (as the group watch pickers word theirs). */
const STATUSES_FAILED = 'Could not load the status list.';

/** What a failed save says: the asset watch's own sentence for its three refusals, else the
 *  watch screens' (read-only maintenance says its own, any other answer its code, no answer at all
 *  the plain one). */
function failureText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'already_at_status') return ALREADY_AT_STATUS;
    if (err.code === 'thing_not_found') return CANT_WATCH;
    if (err.code === 'not_on_initiative') return LEFT_INITIATIVE;
  }
  return watchErrorMessage(err);
}

const isCode = (err: unknown, code: string) => err instanceof ApiError && err.code === code;

/** Stops the watch. One that is already gone (`watch_not_found`) is as good as stopped. */
async function endWatch(id: string): Promise<void> {
  try {
    await deleteMyAssetWatch(id);
  } catch (err) {
    if (!isCode(err, 'watch_not_found')) throw err;
  }
}

export default function WatchAssetModal({
  assetId, assetName, initiativeId, initiativeName, currentStatus, currentStatusLabel,
  watch, onClose, onSaved,
}: {
  assetId: string;
  /** The asset as the notices name it: its serial number, else its name, else its id. */
  assetName: string;
  /** The initiative the watch is set on; none for a watch on the asset itself. */
  initiativeId?: string | null;
  initiativeName?: string | null;
  /** The status the watch reads now: the asset's own, or its status on the initiative. Null
   *  when there is none to read (the asset has left the initiative). */
  currentStatus: string | null;
  /** `currentStatus`'s label; its key is shown for one with no label. */
  currentStatusLabel: string | null;
  /** The person's watch of the asset in this place, if they have one: Save and Stop watching. */
  watch: AssetWatch | null;
  onClose: () => void;
  /** Called with the watch that was set or changed, or with null once it has been stopped (or
   *  was found already ended); the dialog then closes, unless the watch was found ended on Save. */
  onSaved: (watch: AssetWatch | null) => void;
}) {
  const fieldId = useId();
  // The person's watch here as far as the dialog knows: a new watch once Save finds it ended.
  const [current, setCurrent] = useState<AssetWatch | null>(watch);
  const [condition, setCondition] = useState<AssetWatchCondition>(watch?.condition ?? 'next_update');
  const [status, setStatus] = useState(watch?.status ?? '');
  // The active asset statuses, once the list is in, and whether it could not be had.
  const [statuses, setStatuses] = useState<StatusValue[] | null>(null);
  const [statusesFailed, setStatusesFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    listAssetStatuses()
      .then((list) => { if (live) setStatuses(list); })
      .catch(() => { if (live) setStatusesFailed(true); });
    return () => { live = false; };
  }, []);

  // What the picker offers: the active statuses (the route lists only those), except the one it
  // has now.
  const options = useMemo(
    () => (statuses ?? []).filter((s) => s.key !== currentStatus)
      .map((s) => ({ value: s.key, label: s.label })),
    [statuses, currentStatus]);

  const canSave = condition === 'next_update' || options.some((o) => o.value === status);
  // The notice is Status becomes', and only for as long as its list is not in.
  const listError = condition === 'status' && !statuses && statusesFailed ? STATUSES_FAILED : '';
  const shownError = error || listError;
  const now = currentStatus === null ? null : (currentStatusLabel ?? currentStatus);

  const pickCondition = (next: AssetWatchCondition) => {
    if (saving) return;
    setCondition(next);
    setError('');
  };

  const pickStatus = (next: string) => {
    setStatus(next);
    setError('');
  };

  /** Takes the watch that is there once Watch finds it already set: false when the state can't
   *  be read, so that the refusal is told as it was. */
  const takeWhatIsThere = async (): Promise<boolean> => {
    try {
      const state = await getAssetWatchState(assetId, initiativeId ?? null);
      onSaved(state.watch);
      onClose();
      return true;
    } catch {
      return false;
    }
  };

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    setError('');
    try {
      const body = { condition, status: condition === 'status' ? status : null };
      const saved = current
        ? await updateMyAssetWatch(current.id, body)
        : await createMyAssetWatch({ asset_id: assetId, initiative_id: initiativeId ?? null, ...body });
      onSaved(saved);
      onClose();
    } catch (err) {
      if (!current && isCode(err, 'already_watching')) {
        if (await takeWhatIsThere()) return;
      } else if (current && isCode(err, 'watch_not_found')) {
        // The check ended it since the dialog opened: it is a new watch now.
        setCurrent(null);
        onSaved(null);
        setError(ENDED);
        return;
      }
      setError(failureText(err));
    } finally {
      setSaving(false);
    }
  };

  const stop = async () => {
    if (saving || !current) return;
    setSaving(true);
    setError('');
    try {
      await endWatch(current.id);
      onSaved(null);
      onClose();
    } catch (err) {
      setError(failureText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <NotificationModal
      eyebrow="Watch asset" title={`Watch ${assetName}`}
      description={initiativeName ? <>{HINT} <br />On {initiativeName}.</> : HINT}
      onClose={onClose} busy={saving}
      footer={(
        <>
          <button className="btn-solid" type="button" disabled={saving || !canSave}
                  onClick={() => void save()}>
            {current ? 'Save' : 'Watch'}
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {current && (
            <button className="mini-btn danger" type="button" disabled={saving}
                    onClick={() => void stop()}>
              Stop watching
            </button>
          )}
          {shownError && <span className="pf-error" role="alert">{shownError}</span>}
        </>
      )}>
      <div className="pf-form">
        <div className="full">
          <ChoiceField label="Watch for" options={CONDITIONS} value={condition}
                       onChange={pickCondition} />
          {condition === 'next_update' && <p className="cell-sub nm-hint">{NEXT_UPDATE_HINT}</p>}
        </div>
        {condition === 'status' && (
          <div className="full">
            <label htmlFor={fieldId}>Status</label>
            <ComboBox inputId={fieldId} options={options} value={status} onChange={pickStatus}
                      disabled={saving || !statuses} placeholder="Search statuses…" />
            {now !== null && (
              <p className="cell-sub nm-hint">
                {initiativeId ? `Its status on this initiative is ${now} now.` : `Its status is ${now} now.`}
              </p>
            )}
          </div>
        )}
      </div>
    </NotificationModal>
  );
}
