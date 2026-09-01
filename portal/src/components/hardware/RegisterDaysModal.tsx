/** RegisterDaysModal — minimal confirm dialog for a kiosk's Register/Renew
 *  action. Pure UI: it hands the chosen day count back to the caller via
 *  `onConfirm` and never touches the API itself — KioskDevices owns the
 *  registerDevice call + reload, same division of labor the house
 *  window.confirm() de-register flow uses. Follows the modal-scrim/
 *  modal-card skeleton (model: WorkerLevelEditModal.tsx), sized down for
 *  its single field. */

import { useState, type FormEvent } from 'react';

interface Props {
  deviceName: string;
  onConfirm: (days: number) => void;
  onClose: () => void;
}

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

export default function RegisterDaysModal({ deviceName, onConfirm, onClose }: Props) {
  const [days, setDays] = useState(DEFAULT_DAYS);

  const canConfirm = Number.isFinite(days) && days >= MIN_DAYS && days <= MAX_DAYS;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canConfirm) return;
    onConfirm(days);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card" style={{ width: 'min(380px, 92vw)' }}>
        <div className="modal-head">
          <h3>Register {deviceName}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full">
                <label>Valid for (days)</label>
                <input aria-label="Valid for (days)" type="number"
                       min={MIN_DAYS} max={MAX_DAYS} value={days}
                       onChange={(e) => setDays(Number(e.target.value))} />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={!canConfirm}>Confirm</button>
            <button className="mini-btn" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
