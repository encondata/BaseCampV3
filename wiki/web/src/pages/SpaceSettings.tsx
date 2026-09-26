/** /library/:spaceKey/settings — for space managers: the space's name,
 *  description, icon and color; its members (the permissions editor,
 *  inline); collaboration settings, with a link to the pages due for
 *  review; sharing (public links); archiving (unarchiving is for wiki
 *  administrators); and a link to the space's trash. */
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import ComboBox from '@portal/components/ComboBox';
import { Switch } from '@portal/components/Switch';
import { ApiError } from '@portal/lib/api';
import { useToast } from '@portal/lib/notificationsContext';
import { PRESET_COLORS } from '@portal/lib/variables';

import ConfirmDialog from '../components/ConfirmDialog';
import { SpaceBadge } from '../components/NodeIcon';
import { PermissionsEditor } from '../components/PermissionsDialog';
import { atLeast } from '../components/RowMenu';
import { useWikiShell } from '../layout/shellContext';
import { libraryPath } from '../lib/paths';
import { spaceSetting } from '../lib/spaceSettings';
import type { SpaceOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { archiveSpace, errorMessage, getSpace, unarchiveSpace, updateSpace } from '../lib/wikiApi';
import NotFound from './NotFound';

const REVIEW_INTERVAL_OPTIONS = [
  { value: '', label: 'None' },
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
  { value: '24', label: '24 months' },
];

/** Saves one setting at a time (merging just that key); `busyKey` is the
 *  one being saved. */
function useSettingSaver(space: SpaceOut, onSaved: (space: SpaceOut) => void) {
  const toast = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const save = async (key: string, value: boolean | number | null) => {
    setBusyKey(key);
    try {
      onSaved(await updateSpace(space.key, { settings: { [key]: value } }));
    } catch (err) {
      toast(errorMessage(err, 'Couldn\'t save this setting. Try again.'));
    } finally {
      setBusyKey(null);
    }
  };
  return { busyKey, save };
}

function CollaborationSection({ space, onSaved }: { space: SpaceOut; onSaved: (space: SpaceOut) => void }) {
  const { busyKey, save } = useSettingSaver(space, onSaved);

  const readersCanComment = spaceSetting(space, 'readers_can_comment');
  const requireApproval = spaceSetting(space, 'require_approval');
  const reviewInterval = spaceSetting(space, 'review_interval_months');

  return (
    <section className="wiki-settings-section" aria-label="Collaboration">
      <div className="wiki-section-label">Collaboration</div>
      <div className="wiki-settings-row">
        <div>
          <span className="wiki-settings-label">Readers can comment</span>
          <p className="page-hint">Off restricts commenting to editors and managers.</p>
        </div>
        <Switch checked={readersCanComment} disabled={busyKey === 'readers_can_comment'}
                label="Readers can comment" onChange={(v) => void save('readers_can_comment', v)} />
      </div>
      <div className="wiki-settings-row">
        <div>
          <span className="wiki-settings-label">Require approval to publish</span>
          <p className="page-hint">An editor's changes wait for a manager to approve before they go live.</p>
        </div>
        <Switch checked={requireApproval} disabled={busyKey === 'require_approval'}
                label="Require approval to publish" onChange={(v) => void save('require_approval', v)} />
      </div>
      <div className="wiki-settings-row">
        <div>
          <span className="wiki-settings-label">Review reminders</span>
          <p className="page-hint">Nudges an editor to confirm a page is still accurate, on this schedule (a page can set its own instead).</p>
        </div>
        <ComboBox
          options={REVIEW_INTERVAL_OPTIONS}
          value={reviewInterval === null ? '' : String(reviewInterval)}
          disabled={busyKey === 'review_interval_months'}
          ariaLabel="Review reminders"
          onChange={(v) => void save('review_interval_months', v === '' ? null : Number(v))}
        />
      </div>
      <div className="wiki-settings-row">
        <p className="page-hint">Pages whose review is overdue or due within two weeks.</p>
        <Link className="btn-ghost" to={libraryPath(space.key, 'due')}>Pages due for review</Link>
      </div>
    </section>
  );
}

function SharingSection({ space, onSaved }: { space: SpaceOut; onSaved: (space: SpaceOut) => void }) {
  const { busyKey, save } = useSettingSaver(space, onSaved);
  const allowPublicLinks = spaceSetting(space, 'allow_public_links');
  return (
    <section className="wiki-settings-section" aria-label="Sharing">
      <div className="wiki-section-label">Sharing</div>
      <div className="wiki-settings-row">
        <div>
          <span className="wiki-settings-label">Allow public links</span>
          <p className="page-hint">
            Managers of a page or file can create a link anyone can open without signing in (a page shares only
            its published version). Turning this off stops every existing link from working.
          </p>
        </div>
        <Switch checked={allowPublicLinks} disabled={busyKey === 'allow_public_links'}
                label="Allow public links" onChange={(v) => void save('allow_public_links', v)} />
      </div>
    </section>
  );
}

type State =
  | { key: string; status: 'ready'; space: SpaceOut }
  | { key: string; status: 'missing' }
  | { key: string; status: 'error'; message: string };

function DetailsForm({ space, onSaved }: { space: SpaceOut; onSaved: (space: SpaceOut) => void }) {
  const toast = useToast();
  // a null color shows the first swatch, but that's a display default, not
  // a change — dirty-checking against it (not the raw `space.color`) keeps
  // a freshly loaded form clean until someone actually picks a color
  const initialColor = space.color ?? PRESET_COLORS[0].value;
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? '');
  const [icon, setIcon] = useState(space.icon ?? '');
  const [color, setColor] = useState(initialColor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const trimmed = name.trim();
  const tooLong = trimmed.length > 200;
  const changed = trimmed !== space.name || description.trim() !== (space.description ?? '')
    || icon.trim() !== (space.icon ?? '') || color !== initialColor;
  const canSave = !!trimmed && !tooLong && changed && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError('');
    try {
      const saved = await updateSpace(space.key, {
        name: trimmed, description: description.trim() || null, icon: icon.trim() || null, color,
      });
      onSaved(saved);
      toast('Settings saved.');
    } catch (err) {
      setError(errorMessage(err, 'Couldn\'t save the settings. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="wiki-settings-form" onSubmit={(e) => void submit(e)}>
      <div className="pf-form">
        <div className="full">
          <label htmlFor="ss-name">Name</label>
          <input id="ss-name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
          {tooLong && <p className="pf-error">Names can be up to 200 characters.</p>}
        </div>
        <div className="full">
          <label htmlFor="ss-desc">Description</label>
          <input id="ss-desc" value={description} disabled={busy} placeholder="What lives here"
                 onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ss-icon">Icon</label>
          <input id="ss-icon" value={icon} disabled={busy} placeholder="📘" maxLength={8}
                 onChange={(e) => setIcon(e.target.value)} />
          <p className="wiki-field-note">An emoji, or leave it blank for the first letter.</p>
        </div>
        <div>
          <span className="wiki-settings-label">Key</span>
          <p className="wiki-settings-key mono">{libraryPath(space.key)}</p>
          <p className="wiki-field-note">A library's key can't be changed.</p>
        </div>
      </div>
      <div className="modal-section">Color</div>
      <div className="wiki-settings-color">
        <div className="cf-swatches wiki-swatches">
          {PRESET_COLORS.map((p) => (
            <button key={p.value} type="button" aria-label={p.label} title={p.label}
                    aria-pressed={color === p.value} disabled={busy}
                    className={`cf-swatch${color === p.value ? ' selected' : ''}`}
                    style={{ background: p.value }} onClick={() => setColor(p.value)} />
          ))}
        </div>
        <SpaceBadge space={{ icon: icon.trim() || null, name: trimmed || space.name, color }} size="lg" />
      </div>
      {error && <p className="pf-error">{error}</p>}
      <div className="wiki-settings-actions">
        <button className="btn-solid" type="submit" disabled={!canSave}>{busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>
  );
}

export default function SpaceSettings() {
  const { spaceKey = '' } = useParams();
  const toast = useToast();
  const me = useWikiMe();
  const { setCurrentSpace, setCurrentNode, requestExport } = useWikiShell();
  const [state, setState] = useState<State | null>(null);
  const [archiving, setArchiving] = useState<{ busy: boolean; error: string } | null>(null);
  const [unarchiving, setUnarchiving] = useState(false);

  useEffect(() => {
    let live = true;
    getSpace(spaceKey)
      .then((s) => {
        if (!live) return;
        setState({ key: spaceKey, status: 'ready', space: s });
        setCurrentSpace(s);
        setCurrentNode(null);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setState({ key: spaceKey, status: 'missing' });
        else setState({ key: spaceKey, status: 'error', message: errorMessage(err, 'Couldn\'t load this library.') });
      });
    return () => { live = false; };
  }, [spaceKey, setCurrentSpace, setCurrentNode]);

  const shown = state?.key === spaceKey ? state : null;
  if (!shown) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (shown.status === 'missing') return <NotFound what="library" />;
  if (shown.status === 'error') {
    return <div className="portal-page wiki-page"><p className="pf-error">{shown.message}</p></div>;
  }

  const { space } = shown;
  const replace = (next: SpaceOut) => {
    setState({ key: spaceKey, status: 'ready', space: next });
    setCurrentSpace(next);
  };
  const isAdmin = !!me?.is_admin;
  const archived = !!space.archived_at;
  const archivedLinksNote = archived && spaceSetting(space, 'allow_public_links') && (
    <p className="page-hint">
      Its public links keep working until a wiki administrator revokes them on
      the <Link to="/admin">Admin page</Link>.
    </p>
  );

  const head = (
    <>
      <nav className="wiki-crumbs" aria-label="Breadcrumb"><Link to={libraryPath(space.key)}>{space.name}</Link></nav>
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Library settings</div>
          <h1 className="page-title">{space.name}</h1>
        </div>
        {archived && <span className="chip c-amber"><span className="dot" />Archived</span>}
      </div>
    </>
  );

  const unarchive = async () => {
    setUnarchiving(true);
    try {
      replace(await unarchiveSpace(space.key));
      toast(`“${space.name}” is back in use.`);
    } catch (err) {
      toast(errorMessage(err, 'Couldn\'t unarchive the library.'));
    } finally {
      setUnarchiving(false);
    }
  };

  const archive = async () => {
    setArchiving({ busy: true, error: '' });
    try {
      replace(await archiveSpace(space.key));
      setArchiving(null);
      toast(`Archived “${space.name}”.`);
    } catch (err) {
      setArchiving({ busy: false, error: errorMessage(err, 'Couldn\'t archive the library.') });
    }
  };

  const archiveSection = (
    <section className="wiki-settings-section" aria-label="Archive">
      <div className="wiki-section-label">Archive</div>
      {archived ? (
        <div className="wiki-settings-row">
          <p className="page-hint">
            Archived libraries are read-only and hidden from the library list.
            {isAdmin ? '' : ' Ask a wiki administrator to unarchive it.'}
          </p>
          {isAdmin && (
            <button type="button" className="btn-ghost" disabled={unarchiving} onClick={() => void unarchive()}>
              {unarchiving ? 'Unarchiving…' : 'Unarchive library'}
            </button>
          )}
        </div>
      ) : (
        <div className="wiki-settings-row">
          <p className="page-hint">
            Archiving makes the library read-only and hides it from the library list. Only a wiki administrator can undo it.
          </p>
          <button type="button" className="btn-ghost wiki-danger" onClick={() => setArchiving({ busy: false, error: '' })}>
            Archive library
          </button>
        </div>
      )}
    </section>
  );

  // an archived space is read-only for everyone but wiki admins, so its
  // managers read as viewers — admins can still unarchive it here
  if (!atLeast(space.my_level, 'manage')) {
    return (
      <div className="portal-page wiki-page">
        {head}
        <p className="page-hint">
          {archived ? 'This library is archived.' : 'Only library managers can change these settings.'}
        </p>
        {archivedLinksNote}
        {archived && isAdmin && archiveSection}
      </div>
    );
  }

  return (
    <div className="portal-page wiki-page wiki-settings" data-testid="space-settings">
      {head}

      <section className="wiki-settings-section" aria-label="Details">
        <div className="wiki-section-label">Details</div>
        <DetailsForm key={space.updated_at} space={space} onSaved={replace} />
      </section>

      <section className="wiki-settings-section" aria-label="Members">
        <div className="wiki-section-label">Members</div>
        <p className="page-hint">Who can read, edit and manage everything in this library. Pages and folders can add to this or replace it.</p>
        <PermissionsEditor target={{ kind: 'space', space }} />
      </section>

      <CollaborationSection space={space} onSaved={replace} />

      <SharingSection space={space} onSaved={replace} />

      <section className="wiki-settings-section" aria-label="Export">
        <div className="wiki-section-label">Export</div>
        <div className="wiki-settings-row">
          <p className="page-hint">Download the whole library as a .zip — every page and file you can see, in its folders.</p>
          <button type="button" className="btn-ghost" onClick={() => requestExport({ kind: 'space', space })}>
            Export library…
          </button>
        </div>
      </section>

      <section className="wiki-settings-section" aria-label="Trash">
        <div className="wiki-section-label">Trash</div>
        <div className="wiki-settings-row">
          <p className="page-hint">Deleted pages, folders and files wait in the trash until they're purged.</p>
          <Link className="btn-ghost" to={libraryPath(space.key, 'trash')}>Open the Trash</Link>
        </div>
      </section>

      {archiveSection}
      {archivedLinksNote}

      {archiving && (
        <ConfirmDialog
          eyebrow="Archive"
          title={`Archive “${space.name}”?`}
          description="Everyone keeps read access, but nothing can be changed and it leaves the library list. Only a wiki administrator can unarchive it."
          confirmLabel="Archive"
          busyLabel="Archiving…"
          danger
          busy={archiving.busy}
          error={archiving.error}
          onConfirm={() => void archive()}
          onCancel={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
