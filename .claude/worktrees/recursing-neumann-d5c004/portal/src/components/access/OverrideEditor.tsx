/**
 * OverrideEditor — per-member modal for the tri-state permission overrides
 * (allow / deny / inherit). Loads the person's sparse overrides plus their
 * resolved effective grants (for ghosting the inherited value behind each
 * still-inherited cell), then PUTs the full override board back on save —
 * the endpoint replaces a person's entire override set per call, so the
 * draft always carries every override the person should keep, not just
 * the cells touched this session.
 */

import { useEffect, useState } from 'react';

import { ACTIONS, canTouchRank, type Action } from '../../lib/access';
import {
  ApiError, getEffective, getOverrides, putOverrides,
  type AccessSummary, type MemberItem,
} from '../../lib/api';
import { avatarGradient, initials } from '../../lib/format';
import MatrixTable from './MatrixTable';

type Draft = Record<string, Partial<Record<Action, boolean>>>;

interface Props {
  summary: AccessSummary;
  member: MemberItem;
  canEdit: boolean;
  maxRank: number;
  selfId: string | null;
  onClose: () => void;
  onSaved: () => void;
  /** Reports the loaded override count back to the list (lazy has-overrides). */
  onLoaded?: (count: number) => void;
}

const ERRORS: Record<string, string> = {
  rank_too_low: 'Your rank is too low to set overrides for this member.',
  cannot_target_self: 'You cannot set overrides on your own account.',
  not_your_record: 'You can only view your own effective access.',
  developer_only_resource: 'Developer-only pages cannot be overridden.',
  person_not_found: 'That member no longer exists — refresh and try again.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

const overrideCount = (draft: Draft): number =>
  Object.values(draft).reduce((n, acts) => n + Object.keys(acts).length, 0);

export default function OverrideEditor({
  summary, member, canEdit, maxRank, selfId, onClose, onSaved, onLoaded,
}: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [inherited, setInherited] = useState<Record<string, Record<Action, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([getOverrides(member.person_id), getEffective(member.person_id)])
      .then(([ov, eff]) => {
        if (cancelled) return;
        const sparse = ov.overrides as Draft;
        setDraft(sparse);
        onLoaded?.(overrideCount(sparse));

        const inh: Record<string, Record<Action, boolean>> = {};
        for (const res of summary.resources) {
          const cellsForRes = eff.cells[res.id];
          inh[res.id] = Object.fromEntries(
            ACTIONS.map((a) => [a, cellsForRes?.[a]?.value === true]),
          ) as Record<Action, boolean>;
        }
        setInherited(inh);
      })
      .catch((err) => setError(msgFor(err)))
      .finally(() => { if (!cancelled) setLoading(false); })
      ;
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member.person_id]);

  const isSelf = member.person_id === selfId;
  const editable = canEdit && canTouchRank(maxRank, member.max_rank) && !isSelf;
  const lockedResources = new Set(
    summary.resources.filter((r) => r.developer_only).map((r) => r.id));

  const cycle = (resId: string, action: Action) => {
    setDraft((prev) => {
      const cur = prev ?? {};
      const curVal = cur[resId]?.[action];
      // inherit (undefined) -> allow (true) -> deny (false) -> inherit
      const next = curVal === undefined ? true : curVal === true ? false : undefined;
      const nextActs = { ...cur[resId] };
      if (next === undefined) delete nextActs[action]; else nextActs[action] = next;
      const nextDraft = { ...cur };
      if (Object.keys(nextActs).length === 0) delete nextDraft[resId];
      else nextDraft[resId] = nextActs;
      return nextDraft;
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const payload: Record<string, Record<Action, boolean | null>> = {};
      for (const [resId, acts] of Object.entries(draft)) {
        payload[resId] = Object.fromEntries(
          ACTIONS.map((a) => [a, acts[a] ?? null]),
        ) as Record<Action, boolean | null>;
      }
      await putOverrides(member.person_id, payload);
      onLoaded?.(overrideCount(draft));
      onSaved();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => { if (!saving) onClose(); };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) dismiss();
    }}>
      <div className="modal-card override-modal">
        <div className="modal-head">
          <div className="ov-head">
            <span className="av-sm"
                  style={{ background: member.avatar_url ? 'var(--surface-2)' : avatarGradient(member.display_name) }}>
              {member.avatar_url ? <img src={member.avatar_url} alt="" /> : initials(member.display_name)}
            </span>
            <div>
              <h3>Overrides — {member.display_name}</h3>
              <span className="ov-sub">{member.roles.join(', ') || 'no roles'}</span>
            </div>
          </div>
          <button className="modal-close" aria-label="Close" onClick={dismiss}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {loading && <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
          {!loading && isSelf && (
            <p className="set-note" style={{ padding: 0 }}>
              You cannot set overrides on your own account.
            </p>
          )}
          {!loading && !isSelf && !canTouchRank(maxRank, member.max_rank) && (
            <p className="set-note" style={{ padding: 0 }}>
              Read-only — {member.display_name}'s rank is at or above yours.
            </p>
          )}
          {!loading && draft && (
            <>
              <p className="set-note" style={{ padding: '0 0 12px' }}>
                Click a cell to cycle inherit → allow → deny → inherit. Ghosted icons show
                the inherited value behind a still-inherited cell.
              </p>
              <MatrixTable
                mode="override"
                resources={summary.resources}
                overrides={draft}
                inherited={inherited}
                editable={editable && !saving}
                lockedResources={lockedResources}
                onCycle={cycle}
              />
            </>
          )}
        </div>
        <div className="modal-foot">
          {editable && (
            <button className="btn-solid" disabled={saving || loading} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save overrides'}
            </button>
          )}
          <button className="mini-btn" onClick={dismiss} disabled={saving}>
            {editable ? 'Cancel' : 'Close'}
          </button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
