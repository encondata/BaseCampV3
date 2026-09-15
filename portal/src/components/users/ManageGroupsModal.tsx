/**
 * ManageGroupsModal — toggle one person in or out of any access group and
 * save the whole set through PUT /users/{id}/access-groups. Mirrors
 * ManageRolesModal's shape with the report-generate modal header.
 */
import { useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { canTouchRank } from '../../lib/access';
import { ApiError, setUserAccessGroups, type AccessSummary } from '../../lib/api';

const ERRORS: Record<string, string> = {
  rank_too_low: "Their rank is at or above yours — you can't change their groups.",
  cannot_target_self: "That's you — groups you belong to are managed on the Access page.",
  group_not_found: 'One of those groups no longer exists — refresh and try again.',
  user_not_found: 'This user no longer exists.',
};

export default function ManageGroupsModal({ user, summary, currentIds, onClose, onSaved }: {
  user: { person_id: string; display_name: string; max_rank: number };
  summary: AccessSummary;
  currentIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { maxRank } = useAuth();
  const [picked, setPicked] = useState<Set<string>>(new Set(currentIds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const actorCanTouch = canTouchRank(maxRank, user.max_rank);
  const gateCount = (gid: string) =>
    summary.resources.filter((r) => r.gated_by.includes(gid)).length;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      // keep the summary's order so the payload is stable
      await setUserAccessGroups(user.person_id,
        summary.groups.filter((g) => picked.has(g.id)).map((g) => g.id));
      onSaved();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(ERRORS[code] ?? 'Could not save — try again.');
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card ud-groups-card" role="dialog" aria-label="Manage access groups">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Access groups</div>
            <h3>Groups — {user.display_name}</h3>
            <p className="page-hint">Members of a group can open the pages gated behind it.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {summary.groups.length === 0 ? (
            <div className="dir-empty"><b>No groups yet</b>Create one on the Access page first.</div>
          ) : (
            <div className="ud-group-picks">
              {summary.groups.map((g) => {
                const on = picked.has(g.id);
                const n = gateCount(g.id);
                return (
                  <button key={g.id} type="button"
                          className={`ud-group-pick ${on ? 'on' : ''}`}
                          aria-pressed={on}
                          disabled={!actorCanTouch}
                          title={actorCanTouch ? undefined : `${user.display_name}'s rank is at or above yours`}
                          onClick={() => setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
                            return next;
                          })}>
                    <span className="cell-top">{g.name}</span>
                    {g.description && <span className="ud-group-meta">{g.description}</span>}
                    <span className="ud-group-meta">gates {n} page{n === 1 ? '' : 's'}</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="set-note" style={{ padding: '12px 0 0' }}>
            Adding someone to a group does not grant a role — it only unlocks gated pages.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn-solid" onClick={() => void save()} disabled={saving || !actorCanTouch}>
            {saving ? 'Saving…' : 'Save groups'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
