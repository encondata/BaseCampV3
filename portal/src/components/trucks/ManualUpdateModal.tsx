/** Trucks › Actions › Manual update: tracking updates entered by hand from
 *  a carrier's emails. MacroPoint is built; Copeland and 3rd-Party are
 *  placeholders. Panels stay mounted so switching tabs keeps their state. */
import { useState } from 'react';

import '../../styles/reports.css';      // rgm-card / rgm-steps
import '../../styles/macropoint.css';
import MacroPointPanel from './MacroPointPanel';

type Tab = 'macropoint' | 'copeland' | 'third_party';
const TABS: { key: Tab; label: string }[] = [
  { key: 'macropoint', label: 'MacroPoint' },
  { key: 'copeland', label: 'Copeland' },
  { key: 'third_party', label: '3rd-Party' },
];

function ComingSoon({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <>
      <div className="modal-body">
        <div className="dir-empty"><b>Coming soon</b>{text}</div>
      </div>
      <div className="modal-foot">
        <button className="mini-btn" onClick={onClose}>Close</button>
      </div>
    </>
  );
}

export default function ManualUpdateModal({ onClose, onApplied }: {
  onClose: () => void; onApplied: () => void;
}) {
  const [tab, setTab] = useState<Tab>('macropoint');
  const [busy, setBusy] = useState(false);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card manual-update-card" role="dialog" aria-label="Manual update">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Trucks</div>
            <h3>Manual update</h3>
            <p className="page-hint">Turn tracking emails into truck locations and trip events. Nothing changes until you apply.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="mu-tabs">
          <div className="segmented" role="tablist" aria-label="Update source">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                      className={tab === t.key ? 'on' : ''} disabled={busy}
                      onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div hidden={tab !== 'macropoint'} className="mu-panel">
          <MacroPointPanel onClose={onClose} onApplied={onApplied} onBusy={setBusy} />
        </div>
        <div hidden={tab !== 'copeland'} className="mu-panel">
          <ComingSoon text="Copeland updates are not built yet." onClose={onClose} />
        </div>
        <div hidden={tab !== 'third_party'} className="mu-panel">
          <ComingSoon text="Third-party updates are not built yet." onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
