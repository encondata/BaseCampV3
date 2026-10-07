/** Sirdar Dashboard — the Deployments overview: health, the spotlight (the
 *  selected environment's flow: live traffic → load balancer or Nginx Proxy
 *  Manager → its servers, with Activate, Deploy and Open), the environment
 *  cards (Production first) and the infrastructure tree. `?demo=1` swaps in
 *  the API's sample; `?env=<id>` picks the spotlight, remembered per viewer. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { Switch } from '@portal/components/Switch';

import ActivateModal from '../../components/ActivateModal';
import {
  errorText, getDashboard, getEnvironment, type DashboardData, type DashEnvironment, type DashServer, type Environment,
} from '../../lib/sirdarApi';
import DeployModal from '../environments/DeployModal';

import EnvCard from './EnvCard';
import { RocketIcon } from './icons';
import InfraTree from './InfraTree';
import { Dot, SoonButton } from './parts';
import Spotlight from './Spotlight';
import './dashboard.css';

const STORAGE_KEY = 'sirdar.dashboard.env';
function remembered(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function remember(id: string): void {
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* storage blocked: the URL still carries it */ }
}

/** The production environment, else the first real one, else the first card (a placeholder). */
function defaultCard(cards: DashEnvironment[]): DashEnvironment | undefined {
  return cards.find((c) => c.production && c.environment) ?? cards.find((c) => c.environment) ?? cards[0];
}

function Skeleton() {
  return (
    <div className="sd-skeleton" aria-busy="true" aria-label="Loading the dashboard">
      <div className="sd-card"><div className="sd-shimmer" style={{ height: 24, width: 180 }} />
        <div className="sd-shimmer" style={{ height: 200, marginTop: 20 }} /></div>
      <div className="sd-env-grid">
        <div className="sd-card"><div className="sd-shimmer" style={{ height: 96 }} /></div>
        <div className="sd-card"><div className="sd-shimmer" style={{ height: 96 }} /></div>
      </div>
      <div className="sd-card"><div className="sd-shimmer" style={{ height: 220 }} /></div>
    </div>
  );
}

export default function DashboardPage() {
  const { preferences, can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const demo = params.get('demo') === '1';
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deployEnv, setDeployEnv] = useState<Environment | null>(null);
  const [deployError, setDeployError] = useState('');
  const [activating, setActivating] = useState<{ card: DashEnvironment; server: DashServer } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await getDashboard({ demo, refresh });
      if (mine === seq.current) setData(d);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e, "Couldn't load the dashboard."));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [demo]);

  // a demo switch shows the skeleton rather than the other mode's data
  useEffect(() => { setData(null); void load(false); }, [load]);

  const setDemo = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('demo', '1'); else next.delete('demo');
    next.delete('env');   // the two modes' cards differ: each starts from its own default
    setParams(next, { replace: true });
  };

  const openDeploy = async (name: string) => {
    setDeployError('');
    try { setDeployEnv(await getEnvironment(name)); }
    catch (e) { setDeployError(errorText(e, "Couldn't open that environment.")); }
  };

  const cards = data?.environments ?? [];
  // the URL, then the remembered pick (real data only), then the default; each must name a card
  const byId = (id: string | null) => (id ? cards.find((c) => c.id === id) : undefined);
  const selected = byId(params.get('env')) ?? (demo ? undefined : byId(remembered())) ?? defaultCard(cards);
  const select = (id: string) => {
    if (!demo) remember(id);   // a demo pick never leaks into the real dashboard
    const next = new URLSearchParams(params);
    next.set('env', id);
    setParams(next, { replace: true });
  };
  const canDeploy = can('deploy', 'add');

  const health = data?.health;
  const healthTone = health?.status === 'healthy' ? 'ok' : health?.status === 'degraded' ? 'warn' : 'muted';
  const motion = preferences?.motion !== false;

  return (
    <>
      <div className="portal-page sd-dash">
        <div className="sd-head">
          <div>
            <h1>Deployments</h1>
            <p className="sd-sub">Independent environments. Blue/Green routing for production.</p>
          </div>
          <div className="sd-head-actions">
            {health && (
              <span className={`sd-health is-${health.status === 'healthy' || health.status === 'degraded'
                ? health.status : 'unknown'}`}>
                <Dot tone={healthTone} />{health.label}
              </span>
            )}
            <SoonButton className="sd-btn-primary"><RocketIcon size={16} />Deploy release</SoonButton>
            <span className="sd-demo-toggle">
              <Switch checked={demo} onChange={setDemo} label="Demo data" />
              <span aria-hidden="true">Demo data</span>
            </span>
          </div>
        </div>

        {demo && <div className="sd-demo-strip">Showing demo data — nothing here is real.</div>}

        {error && (
          <div className="sd-alert" role="alert">
            <span>{error}</span>
            <button type="button" className="sd-btn sd-btn-outline sd-btn-sm" onClick={() => void load(false)}>
              Retry
            </button>
          </div>
        )}
        {deployError && <div className="sd-alert" role="alert"><span>{deployError}</span></div>}

        {!data && loading && <Skeleton />}

        {data && (
          <div className="sd-stack">
            {selected && (
              <Spotlight card={selected} demo={data.demo} motion={motion} canDeploy={canDeploy}
                         canView={can('deploy', 'view')} canActivate={canDeploy && can('deploy', 'change')}
                         onDeploy={(name) => void openDeploy(name)} onSetUp={() => navigate('/deploy')}
                         onActivate={(server) => setActivating({ card: selected, server })} />
            )}
            <div className="sd-env-grid">
              {cards.map((env) => (
                <EnvCard key={env.id} env={env} demo={data.demo} canDeploy={canDeploy}
                         selected={env.id === selected?.id} onSelect={() => select(env.id)}
                         onDeploy={(name) => void openDeploy(name)} onSetUp={() => navigate('/deploy')} />
              ))}
            </div>
            <InfraTree source={data.infrastructure.source} error={data.infrastructure.error}
                       tree={data.infrastructure.tree} selected={selected?.id ?? null} refreshing={loading}
                       onRefresh={() => void load(true)} />
          </div>
        )}
      </div>
      {/* A sibling of .sd-dash, so its h3 / b rules don't restyle the modal; not portaled,
          so it keeps the .portal-shell[data-theme] tokens. */}
      {deployEnv && (
        <DeployModal env={deployEnv} onClose={() => setDeployEnv(null)}
                     onStarted={(dep) => navigate(`/deploy/environments/${encodeURIComponent(deployEnv.name)}?deployment=${dep.id}`)} />
      )}
      {activating && activating.card.environment && (
        <ActivateModal envName={activating.card.environment} production={activating.card.production}
                       slot={activating.server.id} fromSlot={activating.card.flow.active_slot}
                       version={activating.server.version} onClose={() => setActivating(null)}
                       onStarted={(dep) => navigate(`/deploy/environments/${encodeURIComponent(activating.card.environment!)}?deployment=${dep.id}`)} />
      )}
    </>
  );
}
