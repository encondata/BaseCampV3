/**
 * GroupMatchModal — match an unmatched Owner value to one of the client's
 * groups. Saving adds the value as an alias of that group. "Create group
 * instead" hands the value to the create modal.
 */
import { useState } from 'react';

import { matchGroupReview, type ClientGroup } from '../../lib/api';
import { groupMsgFor } from '../../lib/clientGroups';
import ComboBox from '../ComboBox';

export default function GroupMatchModal({ clientId, value, groups, onClose, onMatched, onCreate }: {
  clientId: string;
  value: string;
  groups: ClientGroup[];
  onClose: () => void;
  onMatched: () => void;
  onCreate: () => void;
}) {
  const [groupId, setGroupId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!groupId) return;
    setSaving(true);
    setError('');
    try {
      await matchGroupReview(clientId, { value, group_id: groupId });
      onMatched();
    } catch (e) {
      setError(groupMsgFor(e));
      setSaving(false);
    }
  };

  const options = groups.map((g) => ({ value: g.id, label: g.name }));
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card" role="dialog" aria-label="Match to group"
           style={{ width: 'min(480px, 96vw)', overflow: 'visible', maxHeight: 'none' }}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Client groups</div>
            <h3>Match to group</h3>
            <p className="page-hint">The value is added as an alias of the group you pick.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full"><label>Owner value</label>
              <div className="mm-source"><b>{value}</b></div></div>
            <div className="full"><label>Group</label>
              <ComboBox options={options} value={groupId} placeholder="Type to search groups…"
                        disabled={saving} onChange={setGroupId} /></div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!groupId || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Match'}
          </button>
          <button className="mini-btn" onClick={onCreate} disabled={saving}>Create group instead</button>
          <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
