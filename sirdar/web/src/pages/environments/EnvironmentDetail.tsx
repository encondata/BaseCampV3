/** /deploy/environments/:name — one environment, in tabs. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getDeployTargets, getEnvironment, type DeployTarget, type Environment } from '../../lib/sirdarApi';

import DeployModal from './DeployModal';
import EnvOverview from './EnvOverview';
import { ENV_STATUS, StatusChip, TYPE_LABEL, targetLabel } from './labels';

type Tab = 'overview';
const TABS: [Tab, string][] = [['overview', 'Overview']];

export default function EnvironmentDetail() {
  const { name = '' } = useParams();
  const { can } = useAuth();
  const [env, setEnv] = useState<Environment | null>(null);
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [deploying, setDeploying] = useState(false);

  const load = useCallback(() => getEnvironment(name)
    .then((e) => { setEnv(e); setError(''); })
    .catch((e) => setError(errorText(e, "Couldn't load this environment."))), [name]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    getDeployTargets().then((r) => setTargets(r.targets)).catch(() => { /* target ids stand in for labels */ });
  }, []);

  const started = () => { setDeploying(false); void load(); };

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
      {deploying && <DeployModal env={env} onStarted={started} onClose={() => setDeploying(false)} />}
    </div>
  );
}
