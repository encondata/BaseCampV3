/** Developer → System Config: tabbed system settings. Each tab is one
 *  component; adding a tab = one entry + one file. */

import { useState } from 'react';

import LoggingTab from '../components/system/LoggingTab';
import '../styles/system.css';

const TABS = [
  { key: 'logging', label: 'Logging', component: LoggingTab },
] as const;

export default function SystemConfig() {
  const [active, setActive] = useState<string>(TABS[0].key);
  const Tab = TABS.find((t) => t.key === active)?.component ?? LoggingTab;
  return (
    <div className="portal-page">
      <div className="eyebrow">Developer</div>
      <h1 className="page-title">System Config</h1>
      <div className="sysconf-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button"
                  className={`mini-btn${active === t.key ? ' active' : ''}`}
                  onClick={() => setActive(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <Tab />
    </div>
  );
}
