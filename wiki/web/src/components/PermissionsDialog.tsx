/** Who can see, edit and manage a space or a node.
 *
 *  `PermissionsEditor` is the body: the current effective access (who,
 *  level, and where it comes from — "Space", "Inherited from <folder>",
 *  "This page"), an add row (a principal type, then who, found by a server
 *  search, and a level) and Save. A node also has the "Inherit permissions
 *  from parent" switch: turned off, the current access is copied onto the
 *  node so nothing changes until it's edited (the server makes the copy).
 *  `PermissionsDialog` wraps the body in the modal header pattern; the
 *  space settings page shows the body inline. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';
import { ApiError } from '@portal/lib/api';
import { useToast } from '@portal/lib/notificationsContext';

import { noteAccessChanged } from '../lib/treeStore';
import type {
  EffectiveGrant, GrantIn, GrantOut, Level, NodeOut, NodePermissionsOut, PrincipalOut, PrincipalType,
  SpaceOut,
} from '../lib/types';
import {
  errorMessage, getNodePermissions, getSpaceGrants, putNodePermissions, putSpaceGrants, searchPrincipals,
} from '../lib/wikiApi';

export type PermissionsTarget = { kind: 'node'; node: NodeOut } | { kind: 'space'; space: SpaceOut };

export const PRINCIPAL_TYPES: { value: PrincipalType; label: string }[] = [
  { value: 'everyone', label: 'Everyone who can sign in' },
  { value: 'internal', label: 'All internal staff' },
  { value: 'role', label: 'Role' },
  { value: 'access_group', label: 'Access group' },
  { value: 'person', label: 'Person' },
  { value: 'client', label: 'Client' },
  { value: 'partner', label: 'Partner' },
];
const TYPE_LABEL = Object.fromEntries(PRINCIPAL_TYPES.map((t) => [t.value, t.label])) as Record<PrincipalType, string>;
/** What the "who" search looks through, per type. */
const SEARCH_NOUN: Partial<Record<PrincipalType, string>> = {
  role: 'roles', access_group: 'access groups', person: 'people', client: 'clients', partner: 'partners',
};
/** everyone / internal name a group by themselves; the rest need a "who". */
const needsWho = (type: PrincipalType) => type !== 'everyone' && type !== 'internal';

const LEVELS: { value: Level; label: string }[] = [
  { value: 'view', label: 'View' },
  { value: 'edit', label: 'Edit' },
  { value: 'manage', label: 'Manage' },
];
const LEVEL_LABEL: Record<Level, string> = { view: 'View', edit: 'Edit', manage: 'Manage' };
const RANK: Record<Level, number> = { view: 1, edit: 2, manage: 3 };

const SEARCH_DEBOUNCE_MS = 200;

interface Entry {
  principal_type: PrincipalType;
  principal_id: string | null;
  label: string;
  level: Level;
}

const sameWho = (a: Pick<Entry, 'principal_type' | 'principal_id'>, b: Pick<Entry, 'principal_type' | 'principal_id'>) =>
  a.principal_type === b.principal_type && a.principal_id === b.principal_id;

const fromGrant = (g: GrantOut | EffectiveGrant): Entry => ({
  principal_type: g.principal_type, principal_id: g.principal_id, label: g.principal_label, level: g.level,
});
const toGrantIn = (e: Entry): GrantIn => ({ principal_type: e.principal_type, principal_id: e.principal_id, level: e.level });

/** One entry per principal, at the highest level it has — what the server
 *  copies when inheritance is turned off. */
function dedupeHighest(rows: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const r of rows) {
    const i = out.findIndex((o) => sameWho(o, r));
    if (i < 0) out.push({ ...r });
    else if (RANK[r.level] > RANK[out[i].level]) out[i] = { ...out[i], level: r.level };
  }
  return out;
}

function nodeNoun(node: NodeOut): string {
  return node.kind === 'folder' ? 'folder' : node.kind === 'file' ? 'file' : 'page';
}

function LevelControl({ value, onChange, label, disabled }: {
  value: Level; onChange: (level: Level) => void; label: string; disabled?: boolean;
}) {
  return (
    <div className="segmented wiki-level" role="group" aria-label={label}>
      {LEVELS.map((l) => (
        <button key={l.value} type="button" className={value === l.value ? 'on' : undefined}
                aria-pressed={value === l.value} disabled={disabled} onClick={() => onChange(l.value)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** The "who" ComboBox: server search by type, debounced. */
function WhoPicker({ type, value, onChange, disabled }: {
  type: PrincipalType; value: PrincipalOut | null; onChange: (p: PrincipalOut | null) => void; disabled?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrincipalOut[]>([]);

  useEffect(() => {
    if (!opened) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      searchPrincipals(type, query.trim())
        .then((found) => { if (live) setResults(found); })
        .catch(() => { if (live) setResults([]); });
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [opened, type, query]);

  const options = useMemo(() => {
    const list = results.filter((p) => p.id).map((p) => ({ value: p.id as string, label: p.label }));
    // the pick keeps its label after the results move on
    if (value?.id && !list.some((o) => o.value === value.id)) list.unshift({ value: value.id, label: value.label });
    return list;
  }, [results, value]);

  return (
    <ComboBox
      options={options}
      value={value?.id ?? ''}
      ariaLabel="Who"
      placeholder={`Search ${SEARCH_NOUN[type] ?? 'names'}…`}
      disabled={disabled}
      portal
      onOpen={() => setOpened(true)}
      onSearch={setQuery}
      onChange={(id) => {
        const hit = results.find((p) => p.id === id) ?? (value?.id === id ? value : null);
        onChange(hit);
      }}
    />
  );
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

interface Baseline {
  inherit: boolean;
  own: Entry[];
  /** Effective entries that come from above this node (node mode). */
  inherited: EffectiveGrant[];
  /** Everything in effect, for the copy made when inheritance is turned off. */
  effective: Entry[];
}

export function PermissionsEditor({ target, layout = 'inline', onSaved, onCancel }: {
  target: PermissionsTarget;
  layout?: 'inline' | 'modal';
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const toast = useToast();
  const isNode = target.kind === 'node';
  const targetId = target.kind === 'node' ? target.node.id : target.space.key;
  const noun = target.kind === 'node' ? nodeNoun(target.node) : 'space';
  const ownSource = `This ${noun}`;

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [base, setBase] = useState<Baseline>({ inherit: true, own: [], inherited: [], effective: [] });
  const [inherit, setInherit] = useState(true);
  const [own, setOwn] = useState<Entry[]>([]);
  /** Inheritance was just turned off and nothing edited since: the server copies. */
  const [copyPending, setCopyPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [addType, setAddType] = useState<PrincipalType | ''>('');
  const [addWho, setAddWho] = useState<PrincipalOut | null>(null);
  const [addLevel, setAddLevel] = useState<Level>('view');

  const targetRef = useRef(target);
  targetRef.current = target;

  const applyNode = useCallback((out: NodePermissionsOut, nodeId: string) => {
    const next: Baseline = {
      inherit: out.inherit,
      own: out.grants.map(fromGrant),
      inherited: out.effective.filter((e) => !(e.source.kind === 'node' && e.source.node_id === nodeId)),
      effective: out.effective.map(fromGrant),
    };
    setBase(next);
    setInherit(next.inherit);
    setOwn(next.own);
    setCopyPending(false);
    setDirty(false);
  }, []);

  const applySpace = useCallback((grants: GrantOut[]) => {
    const own = grants.map(fromGrant);
    setBase({ inherit: true, own, inherited: [], effective: own });
    setOwn(own);
    setDirty(false);
  }, []);

  useEffect(() => {
    let live = true;
    setLoaded({ status: 'loading' });
    const t = targetRef.current;
    const load = t.kind === 'node'
      ? getNodePermissions(t.node.id).then((out) => { if (live) applyNode(out, t.node.id); })
      : getSpaceGrants(t.space.key).then((grants) => { if (live) applySpace(grants); });
    load
      .then(() => { if (live) setLoaded({ status: 'ready' }); })
      .catch((err) => {
        if (live) setLoaded({ status: 'error', message: errorMessage(err, 'Couldn\'t load the permissions.') });
      });
    return () => { live = false; };
  }, [targetId, applyNode, applySpace]);

  const edit = (next: Entry[]) => {
    setOwn(next);
    setCopyPending(false);
    setDirty(true);
    setError('');
  };

  const toggleInherit = (on: boolean) => {
    setInherit(on);
    setDirty(true);
    setError('');
    if (!on) {
      // what the server will copy: nothing changes until it's edited
      setOwn(dedupeHighest(base.inherit ? base.effective : base.own));
      setCopyPending(base.inherit);
    } else {
      setOwn(base.own);
      setCopyPending(false);
    }
  };

  const canAdd = !!addType && (!needsWho(addType) || !!addWho?.id) && !busy;
  const add = () => {
    if (!addType || !canAdd) return;
    const entry: Entry = needsWho(addType)
      ? { principal_type: addType, principal_id: addWho!.id, label: addWho!.label, level: addLevel }
      : { principal_type: addType, principal_id: null, label: TYPE_LABEL[addType], level: addLevel };
    const i = own.findIndex((o) => sameWho(o, entry));
    edit(i < 0 ? [...own, entry] : own.map((o, j) => (j === i ? { ...o, level: entry.level } : o)));
    setAddWho(null);
  };

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError('');
    try {
      const t = targetRef.current;
      if (t.kind === 'node') {
        const out = await putNodePermissions(t.node.id, copyPending
          ? { inherit: false }
          : { inherit, grants: own.map(toGrantIn) });
        applyNode(out, t.node.id);
        noteAccessChanged(t.node.space_key);
      } else {
        applySpace(await putSpaceGrants(t.space.key, own.map(toGrantIn)));
        noteAccessChanged(t.space.key);
      }
      toast('Permissions saved.');
      setBusy(false);
      onSaved?.();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'no_manager') {
        setError(errorMessage(err, 'Keep at least one entry with Manage access, so someone can look after the space.'));
      } else if (err instanceof ApiError && err.code === 'would_lock_out') {
        setError(errorMessage(err, 'That change would remove your own Manage access here.'));
      } else {
        setError(errorMessage(err, 'Couldn\'t save the permissions. Try again.'));
      }
    }
  };

  // inherited entries show while this node follows its parent (as loaded)
  const showInherited = isNode && inherit && base.inherit;
  const sourceOf = (e: EffectiveGrant): string => {
    if (e.source.kind === 'space') return 'Space';
    return e.source.title ? `Inherited from ${e.source.title}` : 'Inherited from a parent folder';
  };
  const grid = { gridTemplateColumns: isNode
    ? 'minmax(200px, 2fr) 232px minmax(150px, 1.3fr) 36px'
    : 'minmax(220px, 2fr) 232px 36px' };

  let body;
  if (loaded.status === 'loading') {
    body = <p className="page-hint">Loading…</p>;
  } else if (loaded.status === 'error') {
    body = <p className="pf-error">{loaded.message}</p>;
  } else {
    body = (
      <>
        {isNode && (
          <div className="wiki-perm-inherit">
            <label className="switch">
              <input type="checkbox" checked={inherit} disabled={busy} aria-label="Inherit permissions from parent"
                     onChange={(e) => toggleInherit(e.target.checked)} />
              <span className="track" />
            </label>
            <div>
              <b>Inherit permissions from parent</b>
              <span className="wiki-field-note">
                {inherit
                  ? `Everyone with access above this ${noun} has it here too; entries added here add to that.`
                  : `Only the entries below have access to this ${noun} and what's inside it. Space managers always keep access.`}
              </span>
              {!inherit && copyPending && (
                <p className="wiki-perm-note">Current access will be copied here so nothing changes until you edit it.</p>
              )}
              {inherit && !base.inherit && (
                <p className="wiki-perm-note">Access from the parent shows here once you save.</p>
              )}
            </div>
          </div>
        )}

        <div className="dir-list list-scroll wiki-perm-list">
          <div className="list-head" style={grid} aria-hidden="true">
            <span>Who</span><span>Access</span>{isNode && <span>From</span>}<span />
          </div>
          <div role="list" aria-label="Current access">
            {showInherited && base.inherited.map((e, i) => (
              <div className="dir-row" role="listitem" key={`in-${i}`}>
                <div className="row-main" style={grid}>
                  <div className="cell cell-primary wiki-perm-who">
                    <div className="pn"><b title={e.principal_label}>{e.principal_label}</b>
                      {needsWho(e.principal_type) && <span className="cell-sub">{TYPE_LABEL[e.principal_type]}</span>}
                    </div>
                  </div>
                  <div className="cell"><span className="chip">{LEVEL_LABEL[e.level]}</span></div>
                  <div className="cell"><span className="cell-top cell-line">{sourceOf(e)}</span></div>
                  <div className="cell" />
                </div>
              </div>
            ))}
            {own.map((e) => (
              <div className="dir-row" role="listitem" key={`${e.principal_type}:${e.principal_id ?? ''}`}>
                <div className="row-main" style={grid}>
                  <div className="cell cell-primary wiki-perm-who">
                    <div className="pn"><b title={e.label}>{e.label}</b>
                      {needsWho(e.principal_type) && <span className="cell-sub">{TYPE_LABEL[e.principal_type]}</span>}
                    </div>
                  </div>
                  <div className="cell">
                    <LevelControl value={e.level} label={`Level for ${e.label}`} disabled={busy}
                                  onChange={(level) => edit(own.map((o) => (sameWho(o, e) ? { ...o, level } : o)))} />
                  </div>
                  {isNode && <div className="cell"><span className="cell-top cell-line">{ownSource}</span></div>}
                  <div className="cell">
                    <button type="button" className="wiki-icon-btn wiki-perm-remove" aria-label={`Remove ${e.label}`}
                            title="Remove" disabled={busy} onClick={() => edit(own.filter((o) => !sameWho(o, e)))}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {own.length === 0 && !(showInherited && base.inherited.length) && (
            <div className="dir-empty"><b>No one has access yet</b>Add people or groups below.</div>
          )}
        </div>

        <div className="modal-section">Add access</div>
        <div className="wiki-perm-add">
          <div className="wiki-perm-add-type">
            <ComboBox
              options={PRINCIPAL_TYPES}
              value={addType}
              ariaLabel="Principal type"
              placeholder="Who gets access…"
              disabled={busy}
              portal
              onChange={(v) => { setAddType(v as PrincipalType | ''); setAddWho(null); }}
            />
          </div>
          {addType && needsWho(addType) && (
            <div className="wiki-perm-add-who">
              <WhoPicker key={addType} type={addType} value={addWho} onChange={setAddWho} disabled={busy} />
            </div>
          )}
          <LevelControl value={addLevel} onChange={setAddLevel} label="Level to add" disabled={busy} />
          <button type="button" className="btn-ghost" disabled={!canAdd} onClick={add}>Add</button>
        </div>

        {error && <p className="pf-error wiki-perm-error">{error}</p>}
      </>
    );
  }

  const saveButton = (
    <button type="button" className="btn-solid" disabled={!dirty || busy || loaded.status !== 'ready'}
            onClick={() => void save()}>
      {busy ? 'Saving…' : 'Save changes'}
    </button>
  );

  if (layout === 'modal') {
    return (
      <>
        <div className="modal-body wiki-perm-body">{body}</div>
        <div className="modal-foot">
          {saveButton}
          <button type="button" className="mini-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </>
    );
  }
  return (
    <div className="wiki-perm-inline">
      {body}
      <div className="wiki-perm-actions">{saveButton}</div>
    </div>
  );
}

export default function PermissionsDialog({ target, onClose }: { target: PermissionsTarget; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = target.kind === 'node' ? target.node.title : target.space.name;
  const description = target.kind === 'node'
    ? `Access comes from the space and the folders above unless this ${nodeNoun(target.node)} stops inheriting.`
    : 'Who can read, edit and manage everything in this space.';

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-perm-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-perm-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Permissions</div>
            <h3 id="wiki-perm-title">Who can access “{title}”</h3>
            <p className="page-hint">{description}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <PermissionsEditor target={target} layout="modal" onSaved={onClose} onCancel={onClose} />
      </div>
    </div>
  );
}
