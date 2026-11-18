/** RFID Station step 2: what kind of RFID station is it? Tapping a card
 *  picks it and moves on, like the station type step. A Doorway walks the
 *  scan type step; a Dock Portal skips it (it always scans RFID 10 - Dock
 *  to Truck). Truck Portal is shown but can't be picked yet. */

import type { RfidType } from '../../lib/kioskSetup';

// Copy approved by Jimmy (2026-11-17).
const CHOICES: { type: RfidType | 'truck_portal'; title: string; meta: string }[] = [
  {
    type: 'doorway',
    title: 'Doorway',
    meta: "Today's RFID station: the reader at a doorway. Next: Move → Reader → Site → Scan type.",
  },
  {
    type: 'dock_portal',
    title: 'Dock Portal',
    meta: 'Reads crates at the dock and sets them to RFID 10 - Dock to Truck. Next: Move → Reader → Site.',
  },
  { type: 'truck_portal', title: 'Truck Portal', meta: 'Coming soon.' },
];

interface Props {
  selected: RfidType | '';
  onSelect: (type: RfidType) => void;
  onBack: () => void;
}

export default function RfidTypeStep({ selected, onSelect, onBack }: Props) {
  return (
    <>
      <h2>Which RFID type?</h2>
      <div className="setup-cards" role="listbox" aria-label="RFID types">
        {CHOICES.map((c) => {
          const type = c.type;
          const soon = type === 'truck_portal';
          return (
            <button key={type} type="button" role="option" aria-selected={selected === type}
                    className="setup-card" disabled={soon} aria-disabled={soon || undefined}
                    onClick={soon ? undefined : () => onSelect(type)}>
              <div className="setup-card-title">{c.title}</div>
              <div className="setup-card-meta">{c.meta}</div>
            </button>
          );
        })}
      </div>
      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack}>Back</button>
      </div>
    </>
  );
}
