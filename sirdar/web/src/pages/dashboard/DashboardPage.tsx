/** Sirdar Dashboard — the Deployments overview: health, production Blue/Green
 *  routing, the other environments and the infrastructure tree. `?demo=1`
 *  swaps in the API's fixed sample. Deploy actions are shown but inert until
 *  deploy step 2. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { Switch } from '@portal/components/Switch';

import { errorText, getDashboard, type DashboardData } from '../../lib/sirdarApi';

import EnvCard from './EnvCard';
import { RocketIcon } from './icons';
import InfraTree from './InfraTree';
import { Dot, SoonButton } from './parts';
import ProductionFlow from './ProductionFlow';
import './dashboard.css';

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
  const { preferences } = useAuth();
  const [params, setParams] = useSearchParams();
  const demo = params.get('demo') === '1';
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    setParams(next, { replace: true });
  };

  const health = data?.health;
  const healthTone = health?.status === 'healthy' ? 'ok' : health?.status === 'degraded' ? 'warn' : 'muted';
  const motion = preferences?.motion !== false;

  return (
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

      {!data && loading && <Skeleton />}

      {data && (
        <div className="sd-stack">
          <ProductionFlow production={data.production} motion={motion} />
          <div className="sd-env-grid">
            {data.environments.map((env) => <EnvCard key={env.id} env={env} />)}
          </div>
          <InfraTree source={data.infrastructure.source} error={data.infrastructure.error}
                     tree={data.infrastructure.tree} refreshing={loading}
                     onRefresh={() => void load(true)} />
        </div>
      )}
    </div>
  );
}
