/**
 * GroupMergeModal — fold one group (the source) into another. Picking the
 * target runs a dry run and shows what would move; Merge sends the same
 * request for real. Conflicts block the merge.
 */
import { useEffect, useState } from 'react';

import { mergeClientGroups, type ClientGroup, type MergePlan } from '../../lib/api';
import { groupMsgFor } from '../../lib/clientGroups';
import ComboBox from '../ComboBox';
import StandardModal from '../StandardModal';

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
    <StandardModal eyebrow="Client groups" title="Merge into another group" label="Merge into another group"
      busy={!!busy} onClose={onClose} cardClass="group-modal-card group-modal-open"
      description="The name and aliases of this group become aliases of the one you pick, rows and people move over, and this group is deleted."
      footer={<>
        <button className="btn-solid" disabled={!plan || plan.conflicts.length > 0 || !!busy}
                onClick={() => void merge()}>
          {busy === 'merge' ? 'Merging…' : 'Merge'}
        </button>
        <button className="mini-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
        {error && <span className="pf-error">{error}</span>}
      </>}>
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
    </StandardModal>
  );
}
