/**
 * GroupsTab — group picker (shared type-to-filter ComboBox) + a details
 * panel with inline membership management, and the page-access panel
 * (which pages are gated behind which groups).
 */

import { useMemo, useRef, useState, type FormEvent } from 'react';

import {
  ApiError, createAccessGroup, deleteAccessGroup, listUsers,
  setGroupMembers, setResourceGates,
  type AccessGroupOut, type AccessResourceOut, type AccessSummary,
  type UserSummary,
} from '../../lib/api';
import { avatarGradient, initials } from '../../lib/format';
import ComboBox, { type ComboOption } from '../ComboBox';

interface Props {
  summary: AccessSummary;
  canEdit: boolean;
  onChanged: () => void;
}

/** access + devtools are hard-wired and can never be group-gated. */
const NOT_GATEABLE = new Set(['access', 'devtools']);

const ERRORS: Record<string, string> = {
  rank_too_low: 'Your rank is too low to manage one of those members.',
  group_exists: 'A group with that name already exists.',
  group_not_found: 'That group no longer exists — refresh and try again.',
  resource_not_gateable: 'That page cannot be gated behind a group.',
  unknown_resource: 'Unknown page — refresh and try again.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

const GROUP_GLYPH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9.5" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16.5 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export default function GroupsTab({ summary, canEdit, onChanged }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [gateResource, setGateResource] = useState<AccessResourceOut | null>(null);

  const gateable = summary.resources.filter((r) => !NOT_GATEABLE.has(r.id));
  const restricted = gateable.filter((r) => r.gated_by.length > 0).length;

  const gatesFor = (g: AccessGroupOut) =>
    gateable.filter((r) => r.gated_by.includes(g.id)).length;
  const groupName = (gid: string) =>
    summary.groups.find((g) => g.id === gid)?.name ?? 'unknown group';

  // The detail panel reads the group out of the freshest summary, so a
  // refetch after add/remove keeps it current.
  const group: AccessGroupOut | undefined =
    summary.groups.find((g) => g.id === selectedId) ?? summary.groups[0];

  // Option rows: name left, member count right.
  const groupOptions: ComboOption[] = summary.groups.map((g) => ({
    value: g.id,
    label: g.name,
    sub: `${g.member_count} user${g.member_count === 1 ? '' : 's'}`,
  }));

  return (
    <div>
      <div className="tab-picker">
        <ComboBox options={groupOptions} value={group?.id ?? ''}
                  placeholder={summary.groups.length ? 'Select a group…' : 'No groups yet'}
                  disabled={summary.groups.length === 0}
                  onChange={(id) => setSelectedId(id)} />
        {canEdit && (
          <button className="btn-solid" style={{ flex: 'none' }}
                  onClick={() => setCreateOpen(true)}>
            + New group
          </button>
        )}
      </div>

      {group ? (
        <GroupDetail key={group.id} group={group} canEdit={canEdit}
                     gates={gatesFor(group)}
                     onChanged={onChanged}
                     onDeleted={() => setSelectedId(null)} />
      ) : (
        <div className="access-empty">
          <b>No groups yet</b>
          {canEdit
            ? 'Create one to gate pages to a subset of members.'
            : 'Nothing has been gated yet.'}
        </div>
      )}

      <div className="gate-panel">
        <div className="gate-head">
          <div className="mtx-title">
            <b>Page access</b>
            <span>gate a page so only group members (and top-rank admins) see it</span>
          </div>
          <span className="chip tag">
            {restricted} restricted · {gateable.length - restricted} open
          </span>
        </div>
        {gateable.map((r) => (
          <div key={r.id} className="gate-row">
            <span className="gate-label">{r.label}</span>
            <div className="gate-chips">
              {r.gated_by.length === 0 ? (
                <span className="chip c-green"><span className="dot" />Open to all</span>
              ) : (
                r.gated_by.map((gid) => (
                  <span key={gid} className="chip c-violet">{groupName(gid)}</span>
                ))
              )}
            </div>
            {canEdit && (
              <button className="mini-btn" onClick={() => setGateResource(r)}>
                Manage
              </button>
            )}
          </div>
        ))}
      </div>

      {createOpen && (
        <CreateGroupModal
          onClose={() => setCreateOpen(false)}
          onDone={(id) => { setCreateOpen(false); setSelectedId(id); onChanged(); }} />
      )}

      {gateResource && (
        <GatesModal resource={gateResource} groups={summary.groups}
          onClose={() => setGateResource(null)}
          onDone={() => { setGateResource(null); onChanged(); }} />
      )}
    </div>
  );
}

/* ── group detail panel (inline membership management) ──────────── */

function GroupDetail({ group, canEdit, gates, onChanged, onDeleted }: {
  group: AccessGroupOut;
  canEdit: boolean;
  gates: number;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const loadStarted = useRef(false);

  const loadUsers = () => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void listUsers().then(setUsers).catch(() => setError('Could not load the user list.'));
  };

  const memberIds = useMemo(
    () => group.members.map((m) => m.person_id), [group.members]);

  const options: ComboOption[] = useMemo(() => {
    const current = new Set(memberIds);
    return (users ?? [])
      .filter((u) => !current.has(u.person_id))
      .map((u) => ({ value: u.person_id, label: u.display_name, sub: u.login_email }));
  }, [users, memberIds]);

  const apply = async (ids: string[]) => {
    setBusy(true);
    setError('');
    try {
      await setGroupMembers(group.id, ids);
      onChanged();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setBusy(false);
    }
  };

  const removeGroup = async () => {
    setBusy(true);
    setError('');
    try {
      await deleteAccessGroup(group.id);
      onDeleted();
      onChanged();
    } catch (err) {
      setError(msgFor(err));
      setConfirmDel(false);
      setBusy(false);
    }
  };

  return (
    <div className="grp-card grp-detail">
      <div className="rd-head">
        <div className="gc-head">
          <span className="gc-icon">{GROUP_GLYPH}</span>
          <span className="gc-name">{group.name}</span>
        </div>
        <span className="gc-sub">
          {group.member_count} member{group.member_count === 1 ? '' : 's'}
          {' · '}gates {gates} page{gates === 1 ? '' : 's'}
        </span>
        <div className="mtx-actions">
          {error && <span className="pf-error">{error}</span>}
          {canEdit && (
            confirmDel ? (
              <>
                <button className="mini-btn danger" disabled={busy}
                        onClick={() => void removeGroup()}>
                  {busy ? 'Deleting…' : 'Really delete?'}
                </button>
                <button className="mini-btn" disabled={busy}
                        onClick={() => setConfirmDel(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="mini-btn danger" disabled={busy}
                      onClick={() => setConfirmDel(true)}>
                Delete group
              </button>
            )
          )}
        </div>
      </div>
      {group.description && <div className="rc-desc">{group.description}</div>}

      <div className="av-stack">
        {group.members.slice(0, 6).map((m) => (
          <span key={m.person_id} className="av-sm" title={m.display_name}
                style={{ background: m.avatar_url ? 'var(--surface-2)' : avatarGradient(m.display_name) }}>
            {m.avatar_url ? <img src={m.avatar_url} alt="" /> : initials(m.display_name)}
          </span>
        ))}
        {group.member_count > 6 && (
          <span className="av-sm av-more">+{group.member_count - 6}</span>
        )}
      </div>

      <p className="eyebrow-sm" style={{ marginTop: 14 }}>Members</p>
      <div className="mem-list">
        {group.members.length === 0 && (
          <span className="rd-note">No members yet.</span>
        )}
        {group.members.map((m) => (
          <div key={m.person_id} className="mem-row">
            <span className="av-sm"
                  style={{ background: m.avatar_url ? 'var(--surface-2)' : avatarGradient(m.display_name) }}>
              {m.avatar_url ? <img src={m.avatar_url} alt="" /> : initials(m.display_name)}
            </span>
            <span className="mem-name">{m.display_name}</span>
            {canEdit && (
              <button className="mini-btn danger" disabled={busy}
                      onClick={() => void apply(memberIds.filter((id) => id !== m.person_id))}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="mem-add">
          <ComboBox
            options={options}
            value=""
            placeholder={users === null ? 'Add a member — type a name…' : 'Type a name…'}
            onOpen={loadUsers}
            disabled={busy}
            onChange={(pid) => { if (pid) void apply([...memberIds, pid]); }}
          />
        </div>
      )}
    </div>
  );
}

/* ── create group ───────────────────────────────────────────────── */

function CreateGroupModal({ onClose, onDone }: {
  onClose: () => void; onDone: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const created = await createAccessGroup({
        name: name.trim(), description: description.trim(),
      });
      onDone(created.id);
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>New group</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full"><label>Name *</label>
                <input value={name} required onChange={(e) => setName(e.target.value)} /></div>
              <div className="full"><label>Description</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create group'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── per-resource gates ─────────────────────────────────────────── */

function GatesModal({ resource, groups, onClose, onDone }: {
  resource: AccessResourceOut;
  groups: AccessGroupOut[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(resource.gated_by));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggle = (gid: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(gid)) next.delete(gid); else next.add(gid);
    return next;
  });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await setResourceGates(resource.id, [...selected]);
      onDone();
    } catch (err) {
      setError(msgFor(err));
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Who can see “{resource.label}”?</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <p className="set-note" style={{ padding: 0, marginTop: 0 }}>
            No groups selected = open to every role that has the permission.
            Selecting groups restricts the page to their members
            (top-rank admins always keep access).
          </p>
          {groups.length === 0 && (
            <p className="set-note" style={{ padding: 0 }}>
              No groups exist yet — create one first.
            </p>
          )}
          {groups.map((g) => {
            const on = selected.has(g.id);
            return (
              <button key={g.id} className={`pop-item ${on ? 'on' : ''}`}
                      style={{ width: '100%' }}
                      onClick={() => toggle(g.id)}>
                <span className="pop-check">
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor"
                       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                </span>
                {g.name}
                <span className="gate-opt-sub">
                  {g.member_count} member{g.member_count === 1 ? '' : 's'}
                </span>
              </button>
            );
          })}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
