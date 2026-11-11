/** /deploy, the Environments page: New deployment (/deploy/new, the
 *  step-by-step flow) and Adopt existing, then two tabs, Environments (the
 *  Dashboard's environment cards, no traffic graph) and Snapshots
 *  (?tab=environments | snapshots). The old ?tab=new link goes to /deploy/new. */
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import AdoptEnvironmentModal from './environments/AdoptEnvironmentModal';
import EnvironmentCards from './environments/EnvironmentCards';
import SnapshotsSection from './snapshots/SnapshotsSection';

type Tab = 'environments' | 'snapshots';
const TABS: [Tab, string][] = [['environments', 'Environments'], ['snapshots', 'Snapshots']];

export const NO_ADD_NOTE = 'You can view deployments but not create them. Ask a super admin for access.';

export default function Deploy() {
  const { can } = useAuth();
  const canAdd = can('deploy', 'add');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [adopting, setAdopting] = useState(false);
  const [reload, setReload] = useState(0);
  const asked = params.get('tab');
  if (asked === 'new') return <Navigate to="/deploy/new" replace />;
  const tab: Tab = asked === 'snapshots' ? 'snapshots' : 'environments';
  const pick = (key: Tab) => setParams((p) => { p.set('tab', key); return p; }, { replace: true });

  return (
    <div className="portal-page">
      <div className="eyebrow">Deployments</div>
      <div className="dir-head sirdar-env-head">
        <div>
          <h1>Environments</h1>
          <p>Your environments and snapshots. Start a new deployment, or adopt an environment that already runs.</p>
        </div>
        {canAdd && (
          <div className="sirdar-head-actions">
            <button type="button" className="btn-ghost" onClick={() => setAdopting(true)}>Adopt existing</button>
            <button type="button" className="btn-solid" onClick={() => navigate('/deploy/new')}>New deployment</button>
          </div>
        )}
      </div>
      <div className="segmented sirdar-env-tabs" role="tablist" aria-label="Environments">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''} onClick={() => pick(key)}>{label}</button>
        ))}
      </div>
      {!canAdd && <p className="page-hint">{NO_ADD_NOTE}</p>}
      <div role="tabpanel" aria-label="Environments" hidden={tab !== 'environments'}>
        <EnvironmentCards reload={reload} />
      </div>
      <div role="tabpanel" aria-label="Snapshots" hidden={tab !== 'snapshots'}>
        <SnapshotsSection />
      </div>
      {adopting && (
        <AdoptEnvironmentModal
          onClose={() => { setAdopting(false); setReload((n) => n + 1); }}   // an adopt may have added one
          onAdopted={(env) => {
            setAdopting(false);
            navigate(`/deploy/environments/${encodeURIComponent(env.name)}`);
          }} />
      )}
    </div>
  );
}
