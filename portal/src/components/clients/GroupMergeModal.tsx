/**
 * GroupMergeModal — fold one group (the source) into another. Picking the
 * target runs a dry run and shows what would move; Merge sends the same
 * request for real. Conflicts block the merge.
 */
import { useEffect, useState } from 'react';

import { mergeClientGroups, type ClientGroup, type MergePlan } from '../../lib/api';
import { groupMsgFor } from '../../lib/clientGroups';
import ComboBox from '../ComboBox';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function GroupMergeModal({ clientId, source, groups, onClose, onMerged }: {
  clientId: string;
  source: ClientGroup;
  groups: ClientGroup[];
  onClose: () => void;
  onMerged: () => void;
}) {
  const [targetId, setTargetId] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [busy, setBusy] = useState<'plan' | 'merge' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPlan(null);
    setError('');
    if (!targetId) return;
    let live = true;
    setBusy('plan');
    mergeClientGroups(clientId, targetId, source.id, true)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(groupMsgFor(e)); })
      .finally(() => { if (live) setBusy(null); });
    return () => { live = false; };
  }, [clientId, targetId, source.id]);

  const merge = async () => {
    if (!plan) return;
    setBusy('merge');
    setError('');
    try {
      await mergeClientGroups(clientId, targetId, source.id, false);
      onMerged();
    } catch (e) {
      setError(groupMsgFor(e));
      setBusy(null);
    }
  };

  const options = groups.filter((g) => g.id !== source.id).map((g) => ({ value: g.id, label: g.name }));
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card" role="dialog" aria-label="Merge into another group"
           style={{ width: 'min(560px, 96vw)', overflow: 'visible', maxHeight: 'none' }}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Client groups</div>
            <h3>Merge into another group</h3>
            <p className="page-hint">The name and aliases of this group become aliases of the one you pick, rows and people move over, and this group is deleted.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={!!busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full"><label>Merging</label>
              <div className="mm-source"><b>{source.name}</b></div></div>
            <div className="full"><label>Merge into</label>
              <ComboBox options={options} value={targetId} placeholder="Type to search groups…"
                        disabled={busy === 'merge'} onChange={setTargetId} /></div>
          </div>
          {busy === 'plan' && <p className="set-note">Working out what would move…</p>}
          {plan && (
            <div className="mm-plan">
              <p className="set-note">
                {plural(plan.rows_moved, 'asset row moves', 'asset rows move')};
                {' '}{plural(plan.people_moved, 'person moves', 'people move')}.
              </p>
              <div className="chips">
                {plan.aliases_added.length
                  ? plan.aliases_added.map((a) => <span key={a} className="chip tag">{a}</span>)
                  : <span className="chip tag">no new aliases</span>}
              </div>
              {plan.conflicts.length > 0 && (
                <ul className="mm-conflicts">
                  {plan.conflicts.map((c) => (
                    <li key={c}>‘{c}’ already belongs to another group — remove it there first.</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!plan || plan.conflicts.length > 0 || !!busy}
                  onClick={() => void merge()}>
            {busy === 'merge' ? 'Merging…' : 'Merge'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
