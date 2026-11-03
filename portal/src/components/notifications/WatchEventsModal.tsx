/**
 * WatchEventsModal — "Choose events…": the standard notification dialog around
 * WatchEventsEditor, for the events of one watch (a person's, a group's, or the
 * person's Everything watch). The caller gives the header, the kind of thing and
 * the watch's present events (`initial`, none meaning every event that applies)
 * and does the saving.
 *
 * It opens on All events when `initial` names none (never for Everything, which
 * has to name some) and on the named events otherwise. Save is off while nothing
 * is chosen: All events off with nothing picked, which for Everything is where it
 * starts. A save hands `onSave` the kinds (`[]` for All events) and, once that has
 * gone through, closes the dialog through `onClose`. A save that is refused keeps
 * the dialog open with the reason beside the buttons, and any change to the choice
 * takes the old reason away. While a save is on its way nothing can close it.
 */

import { useState } from 'react';

import type { NotificationKindSetting, WatchTarget } from '../../lib/api';
import { watchErrorMessage } from '../../lib/watches';
import NotificationModal from './NotificationModal';
import WatchEventsEditor, { canSaveEvents, kindsToSave, type WatchEvents } from './WatchEventsEditor';
import '../../styles/directory.css';   // .mini-btn
import '../../styles/profile.css';     // .btn-solid, .pf-error

export default function WatchEventsModal({
  eyebrow, title, description, thing, kinds, initial, saveLabel, onSave, onClose,
}: {
  eyebrow: string;
  title: string;
  description: string;
  thing: WatchTarget;
  /** Every registered kind (GET /notifications/settings). */
  kinds: NotificationKindSetting[];
  /** The watch's events now: none means every event that applies. */
  initial: string[];
  /** The Save button's label; "Save" by default. */
  saveLabel?: string;
  /** Called with the events to save (none for All events). */
  onSave: (kinds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<WatchEvents>(
    () => ({ all: thing !== 'everything' && initial.length === 0, picked: initial }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSave = canSaveEvents(events);

  const change = (next: WatchEvents) => {
    setEvents(next);
    setError('');
  };

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    setError('');
    try {
      await onSave(kindsToSave(events));
      onClose();
    } catch (err) {
      setError(watchErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <NotificationModal
      eyebrow={eyebrow} title={title} description={description}
      onClose={onClose} busy={saving}
      footer={(
        <>
          <button className="btn-solid" type="button" disabled={saving || !canSave}
                  onClick={() => void save()}>
            {saveLabel ?? 'Save'}
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <WatchEventsEditor thing={thing} kinds={kinds} all={events.all} picked={events.picked}
                         onChange={change} />
    </NotificationModal>
  );
}
