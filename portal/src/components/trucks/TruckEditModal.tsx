// Task 6 replaces this stub — it exists so Trucks.tsx has a real
// component to import for "+ New truck" / row Edit before the full
// pf-form (drivers, tracking, move/sites/containers pickers) lands.
import type { TruckItem } from '../../lib/api';

export default function TruckEditModal({ truck, onClose }: {
  truck: TruckItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{truck ? `Edit — ${truck.name}` : 'New truck'}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <p className="page-hint">Truck editing lands in a follow-up task.</p>
          <button className="mini-btn" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
