import '../../styles/reports.css';
import '../../styles/moveSetup.css';

interface Props {
  /** "discard": the draft is still editable and leaving deletes it.
   *  "creating": the worker holds it — leaving deletes nothing. */
  mode: 'discard' | 'creating';
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const COPY = {
  discard: {
    title: 'Discard this move setup?',
    hint: 'Nothing has been created yet. Discarding deletes what you entered on every step.',
    confirm: 'Discard', confirming: 'Discarding…', cancel: 'Keep editing',
  },
  creating: {
    title: 'Leave this page?',
    hint: 'The move is being created and will finish without you. Leave anyway?',
    confirm: 'Leave', confirming: 'Leaving…', cancel: 'Stay',
  },
} as const;

export default function DiscardDialog({ mode, busy, onConfirm, onCancel }: Props) {
  const copy = COPY[mode];
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal-card ms-discard-card" role="dialog" aria-modal="true"
           aria-labelledby="ms-discard-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Bulk Actions</div>
            <h3 id="ms-discard-title">{copy.title}</h3>
            <p className="page-hint">{copy.hint}</p>
          </div>
        </div>
        <div className="modal-foot">
          <button className={mode === 'discard' ? 'mini-btn danger' : 'mini-btn'} type="button"
                  disabled={busy} onClick={onConfirm}>
            {busy ? copy.confirming : copy.confirm}
          </button>
          <button className="btn-solid" type="button" disabled={busy} onClick={onCancel}>{copy.cancel}</button>
        </div>
      </div>
    </div>
  );
}
