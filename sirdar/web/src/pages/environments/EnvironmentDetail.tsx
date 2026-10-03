/** /deploy/environments/:name — one environment, in tabs. `?deployment=<id>`
 *  opens the Deployments tab on that deployment (the Dashboard links here). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import {
  errorText, getDeployTargets, getEnvironment, type DeployTarget, type Deployment, type Environment,
} from '../../lib/sirdarApi';

import DeploymentsTab from './DeploymentsTab';
import DeployModal from './DeployModal';
import EnvOverview from './EnvOverview';
import EnvSettings from './EnvSettings';

import { ENV_STATUS, StatusChip, TYPE_LABEL, targetLabel } from './labels';

type Tab = 'overview' | 'deployments' | 'settings';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['deployments', 'Deployments'], ['settings', 'Settings']];

/** Keyed by name: moving to another environment starts from a clean page
 *  (no stale environment, tab or open deployment). */
export default function EnvironmentDetail() {
  const { name = '' } = useParams();
  return <EnvironmentPage key={name} name={name} />;
}

function EnvironmentPage({ name }: { name: string }) {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const [env, setEnv] = useState<Environment | null>(null);
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [error, setError] = useState('');
  const linked = params.get('deployment');
  const [selected, setSelected] = useState<string | null>(linked);
  const [tab, setTab] = useState<Tab>(linked ? 'deployments' : 'overview');
  const [deploying, setDeploying] = useState(false);
  const seq = useRef(0);

  // A new ?deployment= link on the same environment opens that deployment.
  useEffect(() => { if (linked) { setSelected(linked); setTab('deployments'); } }, [linked]);

  // Only the newest request's answer lands; nothing lands after unmount.
  const load = useCallback(() => {
    const n = ++seq.current;
    return getEnvironment(name)
      .then((e) => { if (n === seq.current) { setEnv(e); setError(''); } })
      .catch((e) => { if (n === seq.current) setError(errorText(e, "Couldn't load this environment.")); });
  }, [name]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { seq.current += 1; }, []);
  useEffect(() => {
    let live = true;
    getDeployTargets().then((r) => { if (live) setTargets(r.targets); })
      .catch(() => { /* target ids stand in for labels */ });
    return () => { live = false; };
  }, []);

  const started = (dep: Deployment) => {
    setDeploying(false);
    setSelected(dep.id);
    setTab('deployments');
    void load();
  };

  const crumb = <div className="eyebrow"><Link to="/deploy">Deploy</Link></div>;
  if (!env) {
    return (
      <div className="portal-page">
        {crumb}
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="page-hint">Loading…</p>}
      </div>
    );
  }
  const running = env.status === 'deploying';
  return (
    <div className="portal-page">
      {crumb}
      <div className="dir-head sirdar-env-head">
        <div>
          <div className="page-title"><h1>{env.name}</h1><StatusChip map={ENV_STATUS} status={env.status} /></div>
          <p>{`${TYPE_LABEL[env.type] ?? env.type} · ${targetLabel(targets, env.target)} · ${env.base_domain}`}</p>
        </div>
        {can('deploy', 'add') && (
          <button type="button" className="btn-solid" disabled={running}
                  title={running ? 'A deployment is running.' : undefined} onClick={() => setDeploying(true)}>
            Deploy
          </button>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="segmented sirdar-env-tabs" role="tablist" aria-label="Environment">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'overview' && <EnvOverview env={env} />}
      {tab === 'deployments' && (
        <DeploymentsTab env={env} selected={selected} onSelect={setSelected} onChanged={() => void load()} />
      )}
      {tab === 'settings' && <EnvSettings env={env} targets={targets} onSaved={setEnv} />}
      {deploying && <DeployModal env={env} onStarted={started} onClose={() => setDeploying(false)} />}
    </div>
  );
}
