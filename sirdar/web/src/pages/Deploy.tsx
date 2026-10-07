/** /deploy: tabs for the step-by-step flow that creates and deploys an
 *  environment, the Environments list and the Snapshots list (?tab=new |
 *  environments | snapshots). Every tab stays mounted, so switching mid-flow
 *  keeps the flow's choices. Targets, the connection test and trusted SSH
 *  hosts live in the flow's Target step. */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getDeployTargets, type DeployTarget } from '../lib/sirdarApi';

import DeployFlow from './deploy/DeployFlow';
import EnvironmentsSection from './environments/EnvironmentsSection';
import SnapshotsSection from './snapshots/SnapshotsSection';

type Tab = 'new' | 'environments' | 'snapshots';
const TABS: [Tab, string][] = [['new', 'New environment'], ['environments', 'Environments'], ['snapshots', 'Snapshots']];

export default function Deploy() {
  const { can } = useAuth();
  const canAdd = can('deploy', 'add');
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: Tab = asked === 'environments' || asked === 'snapshots' ? asked : canAdd ? 'new' : 'environments';
  const tabs = canAdd ? TABS : TABS.filter(([key]) => key !== 'new');
  const pick = (key: Tab) => setParams((p) => { p.set('tab', key); return p; }, { replace: true });

  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [loadError, setLoadError] = useState('');
  const loadTargets = useCallback(() => getDeployTargets()
    .then((r) => { setTargets(r.targets); setLoadError(''); })
    .catch((e) => setLoadError(errorText(e, "Couldn't load deployment targets."))), []);
  useEffect(() => { void loadTargets(); }, [loadTargets]);
  const reloadTargets = useCallback(() => { void loadTargets(); }, [loadTargets]);
  return (
    <div className="portal-page">
      <div className="eyebrow">Deployments</div>
      <div className="dir-head">
        <h1>Deploy</h1>
        <p>Create an environment and deploy it, step by step, or manage your environments and snapshots.</p>
      </div>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      <div className="segmented sirdar-env-tabs" role="tablist" aria-label="Deploy">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''} onClick={() => pick(key)}>{label}</button>
        ))}
      </div>
      {!canAdd && (
        <p className="page-hint">You can view deployments but not create them. Ask a super admin for access.</p>
      )}
      {canAdd && (
        <div role="tabpanel" aria-label="New environment" hidden={tab !== 'new'}>
          <DeployFlow targets={targets} reloadTargets={reloadTargets} />
        </div>
      )}
      <div role="tabpanel" aria-label="Environments" hidden={tab !== 'environments'}>
        <EnvironmentsSection targets={targets} />
      </div>
      <div role="tabpanel" aria-label="Snapshots" hidden={tab !== 'snapshots'}>
        <SnapshotsSection />
      </div>
    </div>
  );
}
