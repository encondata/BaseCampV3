/**
 * Labels → Printers. Structured placeholder ahead of the real printer
 * fleet feature: a tab strip (Zebra / Brother) mirroring Variables.tsx's
 * pattern, over inert "coming soon" option rows. No API calls yet.
 */

import { useState } from 'react';

import '../styles/access.css';    /* .subs-tabs / .access-tab-panel — page-local tab strip */
import '../styles/directory.css'; /* .dir-list / .chip / .dir-empty */

type Tab = 'zebra' | 'brother';

const TABS: { id: Tab; label: string }[] = [
  { id: 'zebra', label: 'Zebra Printers' },
  { id: 'brother', label: 'Brother Printers' },
];

const ZEBRA_OPTIONS: { key: string; title: string; description: string }[] = [
  {
    key: 'alignment',
    title: 'Test Label Alignment',
    description: 'Print a calibration label and dial in offsets.',
  },
  {
    key: 'fonts',
    title: 'Install Fonts',
    description: "Push the house label fonts to the printer's storage.",
  },
  {
    key: 'setup',
    title: 'Full Printer Setup',
    description: 'Guided first-time configuration for a new Zebra printer.',
  },
];

export default function Printers() {
  const [tab, setTab] = useState<Tab>('zebra');

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Printers</h1>
          <p className="page-hint">
            Registered Zebra and Brother label printers — configuration and status.
          </p>
        </div>
      </div>

      <div className="subs-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
                  className={tab === t.id ? 'on' : ''}
                  onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="access-tab-panel">
        {tab === 'zebra' && <ZebraTab />}
        {tab === 'brother' && <BrotherTab />}
      </div>
    </div>
  );
}

function ZebraTab() {
  return (
    <div className="dir-list">
      {ZEBRA_OPTIONS.map((opt) => (
        <div key={opt.key} className="dir-row">
          <div className="row-main" style={{ gridTemplateColumns: '1fr auto', cursor: 'default' }}>
            <div className="cell">
              <div className="cell-top"><b>{opt.title}</b></div>
              <div className="cell-sub">{opt.description}</div>
            </div>
            <div className="cell" style={{ display: 'flex', alignItems: 'center' }}>
              <span className="chip tag">Coming soon</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function BrotherTab() {
  return (
    <div className="dir-empty">
      Brother printer tools are coming soon.
    </div>
  );
}
