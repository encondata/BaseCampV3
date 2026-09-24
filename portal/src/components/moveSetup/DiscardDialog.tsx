import '../../styles/reports.css';
import '../../styles/moveSetup.css';

interface Props { busy: boolean; onDiscard: () => void; onKeep: () => void }

export default function DiscardDialog({ busy, onDiscard, onKeep }: Props) {
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onKeep(); }}>
      <div className="modal-card ms-discard-card" role="dialog" aria-modal="true"
           aria-labelledby="ms-discard-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Bulk Actions</div>
            <h3 id="ms-discard-title">Discard this move setup?</h3>
            <p className="page-hint">Nothing has been created yet. Discarding deletes what you entered on every step.</p>
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini-btn danger" type="button" disabled={busy} onClick={onDiscard}>
            {busy ? 'Discarding…' : 'Discard'}
          </button>
          <button className="btn-solid" type="button" disabled={busy} onClick={onKeep}>Keep editing</button>
        </div>
      </div>
    </div>
  );
}
