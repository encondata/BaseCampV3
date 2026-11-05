/**
 * AddGroupWatchModal — "Add watch" on a notification group's page: point the
 * group at an initiative, a site, a truck or a device, at a library, folder or page of
 * the wiki, or at chosen events everywhere (Everything), and say which events its
 * members hear about.
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
 * in on their own (an RFID or Dock Station, a fixed reader, an approved router). Each shows its kind
 * beside its name, and a search matches the kind too.
 *
 * Wiki is the one picker that searches the server as the text is typed (the ComboBox's
 * `onSearch`). Its list is the wiki's libraries (GET /wiki/spaces, the admin's own), asked for
 * like any other kind's, and offered with nothing typed. Once the typing pauses, the libraries
 * whose name has the text in it come first, then the wiki's folders and pages that match it
 * (GET /wiki/search, the best 8 of each kind, never logged: it is a search as the person
 * types; a text longer than the 200 characters the wiki takes is searched by its first 200).
 * Each option is the thing's name with, beside it, its kind ("Wiki library", "Wiki folder",
 * "Wiki page") and, for a folder or page, where it is (its library, then the folders above it),
 * as plain text: a hit's snippet is never shown. The answer to an older text, or to a kind
 * since left, is dropped. A search that fails ("Could not load the wiki.", the same sentence as
 * a library list that does not load, and for the same reasons: no wiki access among them) leaves
 * the picker on, and the notice goes with the next search that works, the text being cleared, or
 * another kind being chosen. What was picked is kept as an option while the text is empty, so
 * the box still names it once the list closes. A wiki watch names no events (it hears every page
 * update and comment), so a note stands where the events editor is, and it is saved with none.
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
  createGroupWatch, listDevices, listInitiatives, listSites, listTrucks, listWikiSpaces, searchWiki,
  type DeviceItem, type NotificationGroupDetail, type NotificationKindSetting, type WatchIn,
  type WikiSearchHit, type WikiThing,
} from '../../lib/api';
import { routerDisplayName, stationLabel } from '../../lib/devices';
import { isReaderStation } from '../../lib/kioskConfig';
import { THING_LABELS, watchErrorMessage, wikiNodeLabel } from '../../lib/watches';
import ComboBox, { type ComboOption } from '../ComboBox';
import ChoiceField from './ChoiceField';
import NotificationModal from './NotificationModal';
import WatchEventsEditor, {
  canSaveEvents, kindsToSave, type WatchEvents,
} from './WatchEventsEditor';
import '../../styles/directory.css';       // .mini-btn
import '../../styles/profile.css';         // .pf-form, .btn-solid, .pf-error
import '../../styles/notifications.css';   // .watch-add-body

/** What the "Watch" strip picks. Wiki is one choice for the wiki's two kinds of thing: a
 *  library, and a folder or page of one. */
type Segment = 'initiative' | 'site' | 'truck' | 'device' | 'wiki' | 'everything';

/** The segments that pick a thing from a list. */
type ListedSegment = Exclude<Segment, 'everything'>;

const WIKI_LABEL = 'Wiki';

/** What the "Watch" strip offers, in its order. */
const TARGETS: { key: Segment; label: string }[] = [
  { key: 'initiative', label: THING_LABELS.initiative },
  { key: 'site', label: THING_LABELS.site },
  { key: 'truck', label: THING_LABELS.truck },
  { key: 'device', label: THING_LABELS.device },
  { key: 'wiki', label: WIKI_LABEL },
  { key: 'everything', label: THING_LABELS.everything },
];

/** A thing a picker offers: its id and name, and the kind shown beside the name (a device's). */
interface PickerItem { id: string; name: string; sub?: string }

/** The sentence for a wiki that can't be read: its libraries not loading, and a search failing. */
const WIKI_FAILED = 'Could not load the wiki.';

/** Stands where the events editor is for a wiki watch, which names no events. */
const WIKI_NOTE = 'Wiki watches hear every page update and comment, as today.';

/** How many folders, and how many pages, one search brings back (as the wiki's top bar shows). */
const HITS_PER_KIND = 8;

/** How long the typing must pause before the wiki is searched (as the wiki's top bar waits). */
const SEARCH_PAUSE_MS = 200;

/** The longest text the wiki's search takes (any other is 422 `bad_query`): a longer one is
 *  searched by its first characters, not refused. */
const SEARCH_TEXT_MAX = 200;

/** The Wiki picker's value for a wiki thing: its kind of thing and its id (a UUID, which has no
 *  colon), `wiki_space:<id>` or `wiki_node:<id>`. */
const wikiValue = (thing: WikiThing, id: string) => `${thing}:${id}`;

/** The wiki thing a Wiki picker value names. */
function wikiTarget(value: string): { thing: WikiThing; id: string } {
  const [thing, id] = value.split(':');
  return { thing: thing as WikiThing, id };
}

/** A folder or page the wiki found, as the picker offers it: its title, and beside it its kind
 *  and where it is, the library and then the folders above it, as the wiki's own search shows
 *  it. The hit's snippet is not used: it is the wiki's HTML. */
function nodeOption(hit: WikiSearchHit): ComboOption {
  const where = [hit.node.space_name, ...hit.breadcrumbs].join(' / ');
  return {
    value: wikiValue('wiki_node', hit.node.id), label: hit.node.title,
    sub: `${wikiNodeLabel(hit.node.kind)} · ${where}`,
  };
}

/** A device as the Device picker offers it, or null when people can't watch it. Only the devices
 *  notifications check can be watched (the API's `covered`, services/device_online.py), the
 *  ones that check in on their own: an RFID or Dock Station (a laptop kiosk set up as one), a fixed
 *  reader, an approved router. The API refuses any other (422 `invalid_thing`). A router is
 *  named as the Routers list names it. */
function watchableDevice(d: DeviceItem): PickerItem | null {
  if (d.device_type === 'kiosk') {
    return isReaderStation(d) ? { id: d.id, name: d.name, sub: stationLabel(d.station_type) } : null;
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
 *  its flag), a device list holds only the devices that can be watched, in the order
 *  the API gives them, and the wiki's holds its libraries, by name (the folders and pages
 *  are searched as the text is typed). */
const PICKERS: Record<ListedSegment, {
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
  wiki: {
    placeholder: 'Search the wiki…', loadFailed: WIKI_FAILED,
    load: async () => (await listWikiSpaces()).map((space) => ({
      id: wikiValue('wiki_space', space.id), name: space.name, sub: THING_LABELS.wiki_space,
    })),
  },
};

/** The events a kind of watch starts with: every event, or (Everything) none picked. */
const freshEvents = (thing: Segment): WatchEvents => ({ all: thing !== 'everything', picked: [] });

export default function AddGroupWatchModal({ group, kinds, onAdded, onClose }: {
  group: NotificationGroupDetail;
  /** Every registered kind (GET /notifications/settings). */
  kinds: NotificationKindSetting[];
  /** Called once the watch is created; the caller closes the dialog. */
  onAdded: () => void;
  onClose: () => void;
}) {
  const fieldId = useId();
  const [thing, setThing] = useState<Segment>('initiative');
  const [thingId, setThingId] = useState('');
  const [events, setEvents] = useState<WatchEvents>(() => freshEvents('initiative'));
  // Each kind's picker options, once its list has come in.
  const [choices, setChoices] = useState<Partial<Record<ListedSegment, ComboOption[]>>>({});
  const [saving, setSaving] = useState(false);
  // A save's error, and (apart from it) the notice of a list that did not load.
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  // The Wiki picker: the text typed in it, the folders and pages found for that text (the
  // libraries are the kind's list), whether the last search failed, and what was picked.
  const [wikiText, setWikiText] = useState('');
  const [wikiNodes, setWikiNodes] = useState<ComboOption[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const [wikiPicked, setWikiPicked] = useState<ComboOption | null>(null);

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

  // The Wiki picker's search: once the typing has paused, the wiki's folders and pages that
  // match the text. It is keyed on the text as it is searched, without the spaces around it
  // and cut to what the wiki takes, so typing that changes nothing searched (a space at the
  // end) asks nothing again. Both are asked for together and answer together, so one that
  // fails is a search that failed. Only the newest text counts: the answer to an older one,
  // or to a kind since left, is dropped. With no text there is nothing to ask (the libraries
  // are the kind's list), and nothing that failed.
  const wikiQuery = wikiText.trim().slice(0, SEARCH_TEXT_MAX);
  useEffect(() => {
    if (thing !== 'wiki' || wikiQuery === '') {
      setWikiNodes((nodes) => (nodes.length > 0 ? [] : nodes));
      setSearchFailed(false);
      return undefined;
    }
    let current = true;
    const timer = setTimeout(() => {
      Promise.all([
        searchWiki(wikiQuery, 'folder', HITS_PER_KIND),
        searchWiki(wikiQuery, 'page', HITS_PER_KIND),
      ])
        .then(([folders, pages]) => {
          if (!current) return;
          setWikiNodes([...folders, ...pages].map(nodeOption));
          setSearchFailed(false);
        })
        .catch(() => {
          if (!current) return;
          setWikiNodes([]);
          setSearchFailed(true);
        });
    }, SEARCH_PAUSE_MS);
    return () => { current = false; clearTimeout(timer); };
  }, [thing, wikiQuery]);

  const needsThing = thing !== 'everything';
  // A wiki watch names no events, so the events say nothing about whether it can be saved.
  const canSave = (!needsThing || thingId !== '') && (thing === 'wiki' || canSaveEvents(events));
  // The notice is the chosen kind's, and only for as long as its list is not in.
  const listError = needsThing && !choices[thing] ? loadError : '';
  const searchError = thing === 'wiki' && searchFailed ? WIKI_FAILED : '';
  const shownError = error || listError || searchError;

  // What the Wiki picker offers (the box leaves the search to us, with `onSearch`). With text
  // typed: the libraries whose name has it in it, then what the wiki found. Without: the
  // libraries, and first the folder or page picked, which no search is listing, so that the
  // box can still name it.
  const libraries = choices.wiki ?? [];
  const typed = wikiText.trim().toLowerCase();
  let wikiOptions: ComboOption[];
  if (typed !== '') {
    wikiOptions = [...libraries.filter((o) => o.label.toLowerCase().includes(typed)), ...wikiNodes];
  } else if (wikiPicked && !libraries.some((o) => o.value === wikiPicked.value)) {
    wikiOptions = [wikiPicked, ...libraries];
  } else {
    wikiOptions = libraries;
  }

  const pickTarget = (next: Segment) => {
    if (saving || next === thing) return;
    setThing(next);
    setThingId('');
    setEvents(freshEvents(next));
    setError('');
    setLoadError('');
    setWikiText('');
    setWikiPicked(null);
    setSearchFailed(false);
  };

  const pickThing = (id: string) => {
    setThingId(id);
    if (thing === 'wiki') setWikiPicked(wikiOptions.find((o) => o.value === id) ?? null);
    setError('');
  };

  const changeEvents = (next: WatchEvents) => {
    if (saving) return;
    setEvents(next);
    setError('');
  };

  /** What Add watch creates: a wiki thing is named by the picker's value and has no events. */
  const body = (): WatchIn => (thing === 'wiki'
    ? { ...wikiTarget(thingId), kinds: [] }
    : { thing, id: needsThing ? thingId : null, kinds: kindsToSave(events) });

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    setError('');
    try {
      await createGroupWatch(group.id, body());
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
              <label htmlFor={fieldId}>{thing === 'wiki' ? WIKI_LABEL : THING_LABELS[thing]}</label>
              <ComboBox key={thing} inputId={fieldId}
                        options={thing === 'wiki' ? wikiOptions : (choices[thing] ?? [])}
                        value={thingId} onChange={pickThing}
                        disabled={saving || !choices[thing]}
                        placeholder={PICKERS[thing].placeholder}
                        onSearch={thing === 'wiki' ? setWikiText : undefined} />
            </div>
          )}
        </div>
        {thing === 'wiki'
          ? <p className="cell-sub nm-hint">{WIKI_NOTE}</p>
          : (
            <WatchEventsEditor thing={thing} kinds={kinds} all={events.all} picked={events.picked}
                               onChange={changeEvents} />
          )}
      </div>
    </NotificationModal>
  );
}
