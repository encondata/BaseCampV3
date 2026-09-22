/**
 * RoleReviewModal — the blast radius of a role-matrix edit before it is
 * saved: which grants change, and for every member whether their effective
 * access actually flips or is masked by an override, gate or another role.
 */
import { useEffect, useState } from 'react';

import { RANK_LABELS } from '../../lib/access';
import {
  ApiError, previewRoleMatrix,
  type AccessResourceOut, type AccessRole, type MatrixPreviewOut,
} from '../../lib/api';
import { avatarGradient, initials } from '../../lib/format';

type Matrix = Record<string, Record<string, boolean>>;

const BY_LABEL: Record<string, string> = {
  override: 'override', gate: 'group gate', hard_gate: 'hard gate',
  floor: 'always-viewable floor', role: 'another role they hold',
};
const ERRORS: Record<string, string> = {
  rank_too_low: 'Your rank is too low to change this role.',
  cannot_edit_own_role: 'You cannot edit a role you hold.',
  developer_only_resource: 'Developer-only pages can only be granted to the developer role.',
  access_view_locked: 'Access · view is locked on — a role that can reach this page must keep it.',
};
const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

const rankLabel = (rank: number): string =>
  RANK_LABELS.find(([r]) => rank >= r)?.[1] ?? 'Custom';

export default function RoleReviewModal({ role, matrix, resources, onBack, onConfirm }: {
  role: AccessRole;
  matrix: Matrix;
  resources: AccessResourceOut[];
  onBack: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<MatrixPreviewOut | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    previewRoleMatrix(role.name, matrix as never).then(setPreview).catch((e) => setError(msgFor(e)));
  }, [role.name, matrix]);

  const label = (cell: string) => {
    const [res, action] = cell.split(':');
    return `${resources.find((r) => r.id === res)?.label ?? res} · ${action}`;
  };
  const cellLabel = (res: string, action: string) => label(`${res}:${action}`);

  const confirm = async () => {
    setSaving(true);
    setError('');
    try { await onConfirm(); } catch (e) { setError(msgFor(e)); setSaving(false); }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onBack(); }}>
      <div className="modal-card reports-modal-card rgm-card role-review-card" role="dialog" aria-label="Review role changes">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Roles</div>
            <h3>Review changes to {role.label}</h3>
            <p className="page-hint">Everyone holding this role is affected the moment you confirm.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onBack} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {!preview && !error && <p className="set-note">Working out who this affects…</p>}
          {preview && (
            <>
              <div className="rr-summary">
                <span className="chip c-green">+{preview.granted.length} grants</span>
                <span className="chip c-red">−{preview.revoked.length} grants</span>
                <span className="chip c-slate">{preview.affected_count} of {preview.member_count} members affected</span>
              </div>
              <div className="rr-grants">
                <div><b>Added</b>{preview.granted.length === 0 ? <span>—</span>
                  : preview.granted.map((c) => <span key={c}>{label(c)}</span>)}</div>
                <div><b>Removed</b>{preview.revoked.length === 0 ? <span>—</span>
                  : preview.revoked.map((c) => <span key={c}>{label(c)}</span>)}</div>
              </div>
              {preview.members.length === 0 ? (
                <div className="dir-empty"><b>No one holds this role</b>The change takes effect for anyone granted it later.</div>
              ) : (
                <div className="rr-members">
                  {preview.members.map((m) => {
                    const isOpen = open.has(m.person_id);
                    return (
                      <div key={m.person_id} className="rr-member">
                        <button type="button" className="rr-member-head" aria-expanded={isOpen}
                                onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(m.person_id)) n.delete(m.person_id); else n.add(m.person_id); return n; })}>
                          <span className="dir-avatar" style={{ background: m.avatar_url ? 'var(--surface-2)' : avatarGradient(m.display_name) }}>
                            {m.avatar_url ? <img src={m.avatar_url} alt="" /> : initials(m.display_name)}
                          </span>
                          <span className="rr-name">{m.display_name}</span>
                          <span className="rr-rank">{rankLabel(m.max_rank)}</span>
                          <span className={`rr-count ${m.flips.length ? 'on' : ''}`}>
                            {m.flips.length ? `${m.flips.length} permission${m.flips.length === 1 ? '' : 's'} change` : 'no effective change'}
                          </span>
                        </button>
                        {isOpen && (
                          <ul className="rr-detail">
                            {m.flips.map((f) => (
                              <li key={`${f.resource}:${f.action}`}>{cellLabel(f.resource, f.action)}: {f.from ? 'on' : 'off'} → {f.to ? 'on' : 'off'}</li>
                            ))}
                            {m.masked.map((k) => (
                              <li key={`${k.resource}:${k.action}`} className="rr-masked">
                                {cellLabel(k.resource, k.action)} — unchanged, decided by {BY_LABEL[k.by]}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!preview || saving} onClick={() => void confirm()}>
            {saving ? 'Saving…' : 'Confirm'}
          </button>
          <button className="mini-btn" onClick={onBack} disabled={saving}>Back</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
