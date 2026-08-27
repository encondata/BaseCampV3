/** Admin → Scans: tabbed viewer over the scan pipeline. Raw = the
 *  unprocessed inbox (paged, Audit.tsx pattern); Processed = the
 *  permanent matched record (full standard list, Containers.tsx
 *  pattern). Each tab is one component. */

import { useState } from 'react';

import ProcessedScansTab from '../components/scans/ProcessedScansTab';
import RawScansTab from '../components/scans/RawScansTab';
import { initialOpenId } from '../lib/auditFormat';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/system.css';

const TABS = [
  { key: 'raw', label: 'Raw', component: RawScansTab },
  { key: 'processed', label: 'Processed', component: ProcessedScansTab },
] as const;

export default function Scans() {
  // ?open=<id> deep links target processed rows — land on that tab.
  const [active, setActive] = useState<string>(
    initialOpenId() ? 'processed' : 'raw');
  const [count, setCount] = useState<number | null>(null);
  const entry = TABS.find((t) => t.key === active) ?? TABS[0];
  const Tab = entry.component;
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="page-title">
            Scans
            <span className="badge-count">{count ?? '…'}</span>
          </h1>
          <p className="page-hint">
            RFID and barcode reads — the raw inbox and the matched record.
          </p>
        </div>
      </div>
      <div className="sysconf-tabbar" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={active === t.key}
                  className={`sysconf-tab${active === t.key ? ' active' : ''}`}
                  onClick={() => { setActive(t.key); setCount(null); }}>
            {t.label}
          </button>
        ))}
      </div>
      <Tab onCount={setCount} />
    </div>
  );
}
