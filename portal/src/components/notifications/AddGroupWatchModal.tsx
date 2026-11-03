/**
 * AddGroupWatchModal — "Add watch" on a notification group's page: point the
 * group at an initiative, a site, a truck or a device, or at chosen events everywhere
 * (Everything), and say which events its members hear about.
 *
 * A "Watch" strip picks what the group watches. Unless that is Everything, a
 * picker (the house ComboBox, labeled with the kind of thing) searches that kind's
 * things by name. They are what the admin can see: each list is the admin's own,
 * asked for as the kind is chosen (the dialog opens on Initiative) and kept for the
 * life of the dialog, so a list that lands after another kind was chosen is still
 * there when its kind is chosen again. The picker is off until its list is in (so it
 * never offers "No matches." for a list that is only on its way). A list that fails
 * to load is told beside the buttons ("Could not load the site list."; not at all if
 * another kind has been chosen since), leaves the picker off, and is asked for again
 * when the kind is chosen again. That notice is kept apart from a save's error: changing
 * the events leaves it up (the picker is still off), while choosing another kind takes
 * it away, and so does the list arriving after all. Below, the events editor.
 *
 * Only the devices people can watch are offered: the ones notifications check, which check
 * in on their own (an RFID Station, a fixed reader, an approved router). Each shows its kind
 * beside its name, and a search matches the kind too.
 *
 * Add watch is off until there is a thing (when one is needed) and the events can be
 * saved (WatchEventsEditor's `canSaveEvents`). Choosing another kind of thing starts
 * over: no thing, and All events (for Everything, which has no "all", nothing
 * picked). Pressing the kind that is already chosen changes nothing. A save that is
 * refused keeps the dialog open with the reason beside the buttons, and any change
 * to the choice takes the old reason away. While a save is on its way nothing can
 * close the dialog or change the choice.
 *
 * Once the watch is created `onAdded` is called, and the caller closes the dialog
 * and reads the list again (as EditGroupModal's `onSaved` does).
 */

import { useEffect, useId, useState } from 'react';

import {
  createGroupWatch, listDevices, listInitiatives, listSites, listTrucks,
  type DeviceItem, type NotificationGroupDetail, type NotificationKindSetting, type WatchTarget,
  type WatchThing,
} from '../../lib/api';
import { routerDisplayName } from '../../lib/devices';
import { isRfidStation } from '../../lib/kioskConfig';
import { THING_LABELS, watchErrorMessage } from '../../lib/watches';
import ComboBox, { type ComboOption } from '../ComboBox';
import ChoiceField from './ChoiceField';
import NotificationModal from './NotificationModal';
import WatchEventsEditor, {
  canSaveEvents, kindsToSave, type WatchEvents,
} from './WatchEventsEditor';
import '../../styles/directory.css';       // .mini-btn
import '../../styles/profile.css';         // .pf-form, .btn-solid, .pf-error
import '../../styles/notifications.css';   // .watch-add-body

/** What the "Watch" strip offers, in its order. */
const TARGETS: { key: WatchTarget; label: string }[] = [
  { key: 'initiative', label: THING_LABELS.initiative },
  { key: 'site', label: THING_LABELS.site },
  { key: 'truck', label: THING_LABELS.truck },
  { key: 'device', label: THING_LABELS.device },
  { key: 'everything', label: THING_LABELS.everything },
];

/** A thing a picker offers: its id and name, and the kind shown beside the name (a device's). */
interface PickerItem { id: string; name: string; sub?: string }

/** A device as the Device picker offers it, or null when people can't watch it. Only the devices
 *  notifications check can be watched (the API's `covered`, services/device_online.py), the
 *  ones that check in on their own: an RFID Station (a laptop kiosk set up as one), a fixed
 *  reader, an approved router. The API refuses any other (422 `invalid_thing`). A router is
 *  named as the Routers list names it. */
function watchableDevice(d: DeviceItem): PickerItem | null {
  if (d.device_type === 'kiosk') {
    return isRfidStation(d) ? { id: d.id, name: d.name, sub: 'RFID Station' } : null;
  }
  if (d.device_type === 'fixed_reader') return { id: d.id, name: d.name, sub: 'Fixed Reader' };
  if (d.device_type === 'router' && d.approval_state === 'approved') {
    return { id: d.id, name: routerDisplayName(d.name), sub: 'Router' };
  }
  return null;
}

/** What searching a kind of thing needs: the picker's placeholder, what is told when its
 *  list can't be loaded, and the list it offers. Each list is the admin's own, so it holds
 *  only what they can see. A truck list leaves archived trucks out (`listTrucks` without
 *  its flag), and a device list holds only the devices that can be watched, in the order
 *  the API gives them. */
const PICKERS: Record<WatchThing, {
  placeholder: string;
  loadFailed: string;
  load: () => Promise<PickerItem[]>;
}> = {
  initiative: {
    placeholder: 'Search initiatives…', loadFailed: 'Could not load the initiative list.',
    load: () => listInitiatives(),
  },
  site: {
    placeholder: 'Search sites…', loadFailed: 'Could not load the site list.',
    load: () => listSites(),
  },
  truck: {
    placeholder: 'Search trucks…', loadFailed: 'Could not load the truck list.',
    load: () => listTrucks(),
  },
  device: {
    placeholder: 'Search devices…', loadFailed: 'Could not load the device list.',
    load: async () => (await listDevices()).flatMap((d) => watchableDevice(d) ?? []),
  },
};

/** The events a kind of watch starts with: every event, or (Everything) none picked. */
const freshEvents = (thing: WatchTarget): WatchEvents => ({ all: thing !== 'everything', picked: [] });

export default function AddGroupWatchModal({ group, kinds, onAdded, onClose }: {
  group: NotificationGroupDetail;
  /** Every registered kind (GET /notifications/settings). */
  kinds: NotificationKindSetting[];
  /** Called once the watch is created; the caller closes the dialog. */
  onAdded: () => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [thing, setThing] = useState<WatchTarget>('initiative');
  const [thingId, setThingId] = useState('');
  const [events, setEvents] = useState<WatchEvents>(() => freshEvents('initiative'));
  // Each kind's picker options, once its list has come in.
  const [choices, setChoices] = useState<Partial<Record<WatchThing, ComboOption[]>>>({});
  const [saving, setSaving] = useState(false);
  // A save's error, and (apart from it) the notice of a list that did not load.
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  // Ask for the chosen kind's list unless it is in. A list is kept under its own kind
  // whenever it lands; a failure is told only while that kind is still the chosen one.
  useEffect(() => {
    if (thing === 'everything' || choices[thing]) return undefined;
    let chosen = true;
    PICKERS[thing].load()
      .then((items) => {
        setChoices((all) => ({
          ...all, [thing]: items.map((i) => ({ value: i.id, label: i.name, sub: i.sub })),
        }));
      })
      .catch(() => { if (chosen) setLoadError(PICKERS[thing].loadFailed); });
    return () => { chosen = false; };
    // `choices` only says whether the list is in: its arrival must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thing]);

  const needsThing = thing !== 'everything';
  const canSave = (!needsThing || thingId !== '') && canSaveEvents(events);
  // The notice is the chosen kind's, and only for as long as its list is not in.
  const listError = needsThing && !choices[thing] ? loadError : '';
  const shownError = error || listError;

  const pickTarget = (next: WatchTarget) => {
    if (saving || next === thing) return;
    setThing(next);
    setThingId('');
    setEvents(freshEvents(next));
    setError('');
    setLoadError('');
  };

  const pickThing = (id: string) => {
    setThingId(id);
    setError('');
  };

  const changeEvents = (next: WatchEvents) => {
    if (saving) return;
    setEvents(next);
    setError('');
  };

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    setError('');
    try {
      await createGroupWatch(group.id, {
        thing, id: needsThing ? thingId : null, kinds: kindsToSave(events),
      });
      onAdded();
    } catch (err) {
      setError(watchErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <NotificationModal
      eyebrow={group.name} title="Add watch"
      description="Pick what this group's members hear about."
      onClose={onClose} busy={saving}
      footer={(
        <>
          <button className="btn-solid" type="button" disabled={saving || !canSave}
                  onClick={() => void save()}>
            Add watch
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {shownError && <span className="pf-error" role="alert">{shownError}</span>}
        </>
      )}>
      <div className="watch-add-body">
        <div className="pf-form">
          <ChoiceField className="full" label="Watch" options={TARGETS} value={thing}
                       onChange={pickTarget} />
          {thing !== 'everything' && (
            <div className="full">
              <label htmlFor={fieldId}>{THING_LABELS[thing]}</label>
              <ComboBox key={thing} inputId={fieldId} options={choices[thing] ?? []}
                        value={thingId} onChange={pickThing}
                        disabled={saving || !choices[thing]}
                        placeholder={PICKERS[thing].placeholder} />
            </div>
          )}
        </div>
        <WatchEventsEditor thing={thing} kinds={kinds} all={events.all} picked={events.picked}
                           onChange={changeEvents} />
      </div>
    </NotificationModal>
  );
}
