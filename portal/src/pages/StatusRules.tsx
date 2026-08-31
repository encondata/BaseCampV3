/** Admin → Status rules: tabbed manager for scan automation. Rules =
 *  CRUD list + editor; Executions = the per-fire log. Schema comes
 *  from /status-rules/schema so the UI can never drift from the
 *  engine's operators/fields/actions. */

import { useState } from 'react';

import ExecutionsTab from '../components/statusRules/ExecutionsTab';
import RulesTab from '../components/statusRules/RulesTab';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/system.css';

const TABS = [
  { key: 'rules', label: 'Rules', component: RulesTab },
  { key: 'executions', label: 'Executions', component: ExecutionsTab },
] as const;

export default function StatusRules() {
  const [active, setActive] = useState<string>('rules');
  const [count, setCount] = useState<number | null>(null);
  const entry = TABS.find((t) => t.key === active) ?? TABS[0];
  const Tab = entry.component;
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="page-title">
            Status rules
            <span className="badge-count">{count ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Automation the scan matcher applies — when a scan with a
            checkpoint status matches an entity, these rules fire.
          </p>
        </div>
      </div>
      <div className="sysconf-tabbar" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab"
                  aria-selected={active === t.key}
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
