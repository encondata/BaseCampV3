/**
 * RolesTab — role picker (shared type-to-filter ComboBox) + a details
 * panel and the selected role's permission matrix.
 * Editing is rank-gated client-side (the server re-checks): a viewer can
 * only change roles strictly below their own rank (peers too at rank 100).
 */

import { useLayoutEffect, useMemo, useState, type FormEvent } from 'react';

import type { Action } from '../../lib/access';
import { ACTIONS, canTouchRank, RANK_LABELS } from '../../lib/access';
import {
  ApiError, cloneRole, deleteRole, patchRole, putRoleMatrix,
  type AccessRole, type AccessSummary,
} from '../../lib/api';
import ComboBox, { type ComboOption } from '../ComboBox';
import { Switch } from '../Switch';
import MatrixTable from './MatrixTable';
import RoleReviewModal from './RoleReviewModal';

type Matrix = Record<string, Record<Action, boolean>>;

interface Props {
  summary: AccessSummary;
  canEdit: boolean;
  maxRank: number;
  /** Refetches the summary; save() awaits the returned promise so the
   *  matrix stays locked until the fresh role object has landed. */
  onChanged: () => void | Promise<void>;
}

const ERRORS: Record<string, string> = {
  rank_too_low: 'Your rank is too low to change this role.',
  developer_only_resource: 'Developer-only pages can only be granted to the developer role.',
  access_view_locked: 'Access · view is locked on — a role that can reach this page must keep it.',
  role_not_found: 'That role no longer exists — refresh and try again.',
  role_exists: 'A role with that name already exists.',
  system_role: 'System roles cannot be deleted.',
  role_in_use: 'This role has (or had) members and cannot be deleted.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

const rankLabel = (rank: number): string =>
  RANK_LABELS.find(([r]) => rank >= r)?.[1] ?? 'Custom';

const copyMatrix = (m: Matrix): Matrix =>
  Object.fromEntries(Object.entries(m).map(([res, acts]) => [res, { ...acts }]));

const sameMatrix = (a: Matrix, b: Matrix): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export default function RolesTab({ summary, canEdit, maxRank, onChanged }: Props) {
  // Default selection: highest-rank role the viewer may inspect (their own
  // tier or below); roles arrive rank-descending from the API.
  const defaultRole = useMemo(
    () => summary.roles.find((r) => r.rank <= maxRank) ?? summary.roles[0],
    [summary.roles, maxRank]);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const role: AccessRole | undefined =
    summary.roles.find((r) => r.name === selectedName) ?? defaultRole;

  // Option rows: label left, member count right (rank/key stay out of the
  // dropdown — they live in the details panel below).
  const roleOptions: ComboOption[] = summary.roles.map((r) => ({
    value: r.name,
    label: r.label,
    sub: `${r.member_count} user${r.member_count === 1 ? '' : 's'}`,
  }));

  const [draft, setDraft] = useState<Matrix>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [cloneOpen, setCloneOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Re-sync the working copy whenever the selection or server truth
  // changes. Layout effect (not useEffect): it must run BEFORE paint so
  // there is never a visible frame where the matrix is enabled (saving
  // just flipped false) but the draft still predates the refetched role —
  // a click in that frame would be clobbered by this resync.
  useLayoutEffect(() => {
    if (role) setDraft(copyMatrix(role.matrix));
    setErr('');
    setConfirmDel(false);
  }, [role]);

  if (!role) {
    return <div className="access-empty"><b>No roles</b>Nothing to show yet.</div>;
  }

  // Locked while a save is in flight: onChanged()'s refetch replaces the
  // role object underneath the draft-resync effect below, so any click
  // made during that round-trip must be prevented rather than silently
  // discarded when the resync fires.
  const editable = canEdit && canTouchRank(maxRank, role.rank) && !saving;
  const lockedResources = new Set(
    summary.resources
      .filter((r) => r.developer_only && role.name !== 'developer')
      .map((r) => r.id));
  const lockedCells = new Set(['access:view']);
  const dirty = !sameMatrix(draft, role.matrix);

  const cellLocked = (resId: string, action: Action) =>
    lockedResources.has(resId) || lockedCells.has(`${resId}:${action}`);

  const toggle = (resId: string, action: Action) => {
    setDraft((d) => ({
      ...d,
      [resId]: { ...d[resId], [action]: !d[resId]?.[action] },
    }));
  };

  // Column toggle: flip every unlocked row to the inverse of the majority.
  const toggleColumn = (action: Action) => {
    const rows = summary.resources.filter((r) => !cellLocked(r.id, action));
    const onCount = rows.filter((r) => draft[r.id]?.[action]).length;
    const target = onCount <= rows.length / 2;
    setDraft((d) => {
      const next = copyMatrix(d);
      for (const r of rows) {
        next[r.id] = { ...next[r.id], [action]: target };
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      await putRoleMatrix(role.name, draft);
      // Close the review before the refetch: left mounted, its effect would
      // re-run against the refreshed role and preview the matrix that was
      // just saved (a preview of no change at all).
      setReviewOpen(false);
      // Await the refetch: `saving` must stay true (matrix locked) until
      // the fresh role object has landed and the resync has adopted it.
      await onChanged();
    } catch (e) {
      setErr(msgFor(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const setTotp = async (v: boolean) => {
    // Guard against a double click firing two PATCHes: `editable` (and thus
    // the switch's `disabled`) already reflects `saving` after the first
    // click's state update, but this belt-and-suspenders check keeps the
    // call itself a no-op if a second click still lands before that re-render.
    if (saving) return;
    setSaving(true);
    setErr('');
    try {
      await patchRole(role.name, { totp_required: v });
      await onChanged();
    } catch (e) {
      setErr(msgFor(e));
    } finally {
      setSaving(false);
    }
  };

  const removeRole = async () => {
    setSaving(true);
    setErr('');
    try {
      await deleteRole(role.name);
      setSelectedName(null);
      await onChanged();
    } catch (e) {
      setErr(msgFor(e));
      setConfirmDel(false);
    } finally {
      setSaving(false);
    }
  };

  const grantCount = ACTIONS.reduce(
    (n, a) => n + summary.resources.filter((r) => draft[r.id]?.[a]).length, 0);

  return (
    <div>
      <div className="tab-picker">
        <ComboBox options={roleOptions} value={role.name}
                  placeholder="Select a role…"
                  onChange={(name) => setSelectedName(name)} />
      </div>

      <div className="role-card role-detail">
        <div className="rd-head">
          <span className="rc-name">{role.label}</span>
          <span className="rank-badge">{role.rank} · {rankLabel(role.rank)}</span>
          <span className="chip tag">{role.scope_anchor} scope</span>
          {role.is_system && <span className="chip c-blue">system</span>}
          <span className="totp-require">
            <Switch label="Require 2FA" checked={role.totp_required} disabled={!editable}
                    onChange={(v) => void setTotp(v)} />
            <span>Require 2FA</span>
          </span>
          <div className="mtx-actions">
            {err && <span className="pf-error">{err}</span>}
            {canEdit && (
              <button className="mini-btn accent" onClick={() => setCloneOpen(true)}>
                Clone role
              </button>
            )}
            {editable && !role.is_system && (
              confirmDel ? (
                <>
                  <button className="mini-btn danger" disabled={saving}
                          onClick={() => void removeRole()}>
                    {saving ? 'Deleting…' : 'Really delete?'}
                  </button>
                  <button className="mini-btn" disabled={saving}
                          onClick={() => setConfirmDel(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="mini-btn danger" onClick={() => setConfirmDel(true)}>
                  Delete
                </button>
              )
            )}
          </div>
        </div>
        <div className="rc-desc">{role.description || '—'}</div>
        <div className="rd-meta">
          <span className="rc-count">
            {role.member_count}<span> member{role.member_count === 1 ? '' : 's'}</span>
          </span>
          <span className="rd-note">
            {grantCount} grants · {editable ? 'editable' : 'read-only at your rank'}
          </span>
        </div>
      </div>

      <MatrixTable
        mode="role"
        resources={summary.resources}
        matrix={draft}
        editable={editable}
        lockedResources={lockedResources}
        lockedCells={lockedCells}
        onToggle={toggle}
        onToggleColumn={toggleColumn}
      />

      {dirty && (
        <div className="save-bar">
          <span>Unsaved changes to <b>{role.label}</b></span>
          <button className="btn-solid" disabled={saving} onClick={() => setReviewOpen(true)}>
            Save changes
          </button>
          <button className="mini-btn" disabled={saving}
                  onClick={() => { setDraft(copyMatrix(role.matrix)); setErr(''); }}>
            Discard
          </button>
        </div>
      )}

      {cloneOpen && (
        <CloneRoleModal source={role} maxRank={maxRank}
                        onClose={() => setCloneOpen(false)}
                        onDone={() => { setCloneOpen(false); void onChanged(); }} />
      )}

      {reviewOpen && (
        <RoleReviewModal role={role} matrix={draft} resources={summary.resources}
                         onBack={() => setReviewOpen(false)} onConfirm={save} />
      )}
    </div>
  );
}

/* ── clone modal ────────────────────────────────────────────────── */

function CloneRoleModal({ source, maxRank, onClose, onDone }: {
  source: AccessRole;
  maxRank: number;
  onClose: () => void;
  onDone: () => void;
}) {
  // Ranks strictly below the viewer's; top-rank (100) viewers may mint peers.
  const rankCap = maxRank >= 100 ? 100 : maxRank - 1;
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [rank, setRank] = useState(Math.min(source.rank, rankCap));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (rank < 1 || rank > rankCap) {
      setError(`Rank must be between 1 and ${rankCap}.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await cloneRole({ source: source.name, name: name.trim(), label: label.trim(), rank });
      onDone();
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
          <h3>Clone “{source.label}”</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="modal-section">New role</div>
            <div className="pf-form">
              <div><label>Name (slug) *</label>
                <input value={name} required pattern="[a-z][a-z0-9_]*"
                       title="Lowercase letters, digits and underscores; starts with a letter"
                       onChange={(e) => setName(e.target.value.toLowerCase())} /></div>
              <div><label>Label *</label>
                <input value={label} required
                       onChange={(e) => setLabel(e.target.value)} /></div>
              <div><label>Rank * (1–{rankCap})</label>
                <input type="number" value={rank} required min={1} max={rankCap}
                       onChange={(e) => setRank(Number(e.target.value))} /></div>
            </div>
            <p className="set-note" style={{ padding: 0 }}>
              Starts with a copy of {source.label}'s grants and its
              “{source.scope_anchor}” scope anchor.
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Cloning…' : 'Clone role'}
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
