/** /deploy/environments/:name — one environment, in tabs. `?deployment=<id>`
 *  opens the Deployments tab on that deployment (the Dashboard links here). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { ApiError } from '@portal/lib/api';

import ActivateModal from '../../components/ActivateModal';
import {
  errorText, getDeployTargets, getEnvironment, type DeployTarget, type Deployment, type Environment,
} from '../../lib/sirdarApi';

import BackupsTab from './BackupsTab';
import DeploymentsTab from './DeploymentsTab';
import DeployModal from './DeployModal';
import EnvOverview from './EnvOverview';
import EnvSettings from './EnvSettings';
import PublishTab from './PublishTab';

import { ENV_STATUS, StatusChip, TYPE_LABEL, deploymentRunning, targetLabel } from './labels';

/** While a deployment runs (the environment is deploying or deleting, or a
 *  publish or snapshot job is running) it is reloaded this often, on every tab,
 *  so the header, Deploy, Publish and Settings notice when the run ends. */
export const ENV_POLL_MS = 5000;

type Tab = 'overview' | 'deployments' | 'publish' | 'backups' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['deployments', 'Deployments'], ['publish', 'Publish'], ['backups', 'Backups'],
  ['settings', 'Settings'],
];

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
  const [activating, setActivating] = useState<{ slot: string | null } | null>(null);
  // A teardown ends by deleting the environment: a 404 after it loaded means gone.
  const [gone, setGone] = useState(false);
  const loaded = useRef(false);
  const seq = useRef(0);

  // A new ?deployment= link on the same environment opens that deployment.
  useEffect(() => { if (linked) { setSelected(linked); setTab('deployments'); } }, [linked]);

  // Only the newest request's answer lands; nothing lands after unmount.
  const load = useCallback(() => {
    const n = ++seq.current;
    return getEnvironment(name)
      .then((e) => { if (n === seq.current) { loaded.current = true; setEnv(e); setError(''); } })
      .catch((e) => {
        if (n !== seq.current) return;
        if (loaded.current && e instanceof ApiError && e.code === 'environment_not_found') setGone(true);
        else setError(errorText(e, "Couldn't load this environment."));
      });
  }, [name]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { seq.current += 1; }, []);
  // One reload at a time: the next is scheduled only after the last settles.
  const busy = !!env && deploymentRunning(env);
  useEffect(() => {
    if (!busy || gone) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => { void load().finally(() => { if (live) schedule(); }); }, ENV_POLL_MS);
    };
    schedule();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [busy, load, gone]);
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
  if (gone) {
    return (
      <div className="portal-page">
        {crumb}
        <p className="page-hint" role="status">{name} was deleted.</p>
        <Link to="/deploy">Back to Deploy</Link>
      </div>
    );
  }
  if (!env) {
    return (
      <div className="portal-page">
        {crumb}
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="page-hint">Loading…</p>}
      </div>
    );
  }
  const running = deploymentRunning(env);
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
      {tab === 'overview' && (
        <EnvOverview env={env} canActivate={can('deploy', 'add') && can('deploy', 'change') && !running}
                     onActivate={(slot) => setActivating({ slot })} />
      )}
      {tab === 'deployments' && (
        <DeploymentsTab env={env} selected={selected} onSelect={setSelected} onChanged={() => void load()} />
      )}
      {tab === 'publish' && <PublishTab env={env} onStarted={started} onChanged={setEnv} />}
      {tab === 'backups' && <BackupsTab env={env} onStarted={started} />}
      {tab === 'settings' && <EnvSettings env={env} targets={targets} onSaved={setEnv} onDeleteStarted={started} />}
      {deploying && <DeployModal env={env} onStarted={started} onClose={() => setDeploying(false)} />}
      {activating && (
        <ActivateModal envName={env.name} production={env.type === 'production'} slot={activating.slot}
                       fromSlot={env.active_slot}
                       version={env.do?.slots.find((s) => s.slot === activating.slot)?.image_tag ?? null}
                       onStarted={(dep) => { setActivating(null); started(dep); }}
                       onClose={() => setActivating(null)} />
      )}
    </div>
  );
}
