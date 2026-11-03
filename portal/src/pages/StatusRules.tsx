/** Admin → Status rules: tabbed manager for scan automation. Rules =
 *  CRUD list + editor; Executions = the per-fire log. Schema comes
 *  from /status-rules/schema so the UI can never drift from the
 *  engine's operators/fields/actions.
 *
 *  The tab and the rule the Executions tab lists are the URL's:
 *  /admin/status-rules?tab=executions&rule=<rule id> (where a rule's
 *  grouped notice links) opens that rule's executions, and the page follows
 *  the URL when it moves while it is open. Rules, the default tab, and
 *  "all rules" leave no key behind. */

import { useCallback, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import ExecutionsTab from '../components/statusRules/ExecutionsTab';
import RulesTab from '../components/statusRules/RulesTab';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/system.css';

const TABS = [
  { key: 'rules', label: 'Rules' },
  { key: 'executions', label: 'Executions' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function StatusRules() {
  const [searchParams, setSearchParams] = useSearchParams();
  const active: TabKey = searchParams.get('tab') === 'executions' ? 'executions' : 'rules';
  // only the Executions tab has a rule to list; ?rule= anywhere else is ignored
  const ruleId = active === 'executions' ? searchParams.get('rule') ?? '' : '';

  /** Show `tab` (and, on Executions, `rule`'s executions: '' for every rule's). Replaces the
   *  history entry, as the other tabbed pages do, and leaves any other query keys alone. */
  const show = (tab: TabKey, rule: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'rules') next.delete('tab'); else next.set('tab', tab);
      if (tab === 'executions' && rule) next.set('rule', rule); else next.delete('rule');
      return next;
    }, { replace: true });
  };

  // The header count belongs to the tab that reported it: another tab, or a link moving the
  // page to one, reads "…" until its own arrives. A tab that was left may still be answering
  // (a slow request): its count is dropped, not shown on the tab now open.
  const [reported, setReported] = useState<{ tab: TabKey; n: number | null } | null>(null);
  const count = reported?.tab === active ? reported.n : null;
  const openTab = useRef(active);
  openTab.current = active;
  const onCount = useCallback((n: number | null) => {
    if (openTab.current === active) setReported({ tab: active, n });
  }, [active]);

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
                  onClick={() => { if (t.key !== active) show(t.key, ''); }}>
            {t.label}
          </button>
        ))}
      </div>
      {active === 'executions'
        ? <ExecutionsTab onCount={onCount} ruleId={ruleId}
                         onRuleChange={(rule) => show('executions', rule)} />
        : <RulesTab onCount={onCount} />}
    </div>
  );
}
