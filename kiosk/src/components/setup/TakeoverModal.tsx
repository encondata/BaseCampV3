/** Pair: the reader already sends tag data to another ServerSherpa kiosk.
 *  Asked before the edge replaces that kiosk's connection with ours. */

import { Fragment, useEffect } from 'react';

const STEPS = ['Confirm', 'Pair'];

interface Props {
  otherKiosk: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function TakeoverModal({ otherKiosk, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-reset-card" role="dialog"
           aria-label="Pair this reader">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">RFID reader</div>
            <h3>Take over this reader?</h3>
            <p className="page-hint">
              This reader is paired with <b>{otherKiosk}</b>. Pair it with this kiosk instead?
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="rgm-steps">
          {STEPS.map((label, i) => (
            <Fragment key={label}>
              {i > 0 && <span className="rgm-step-sep" />}
              <span className={`rgm-step ${i === 0 ? 'on' : ''}`}>
                <span className="rgm-step-num">{i + 1}</span><span className="rgm-step-label">{label}</span>
              </span>
            </Fragment>
          ))}
        </div>
        <div className="modal-body">
          <div className="zp-col">
            <p className="page-hint">
              The other kiosk stops getting this reader&apos;s tag data.
              If that name is this laptop (for example after a reset), choose Pair anyway.
            </p>
          </div>
        </div>
        <div className="modal-foot">
          {/* Cancel first and focused, so a stray Enter never takes a reader */}
          <button type="button" className="mini-btn" autoFocus onClick={onCancel}>Cancel</button>
          <button type="button" className="btn-solid" onClick={onConfirm}>Pair anyway</button>
        </div>
      </div>
    </div>
  );
}
