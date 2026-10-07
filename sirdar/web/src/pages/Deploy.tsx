/** /deploy: the step-by-step flow that creates and deploys an environment,
 *  then the Environments and Snapshots lists. Targets, the connection test
 *  and trusted SSH hosts live in the flow's Target step. */
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getDeployTargets, type DeployTarget } from '../lib/sirdarApi';

import DeployFlow from './deploy/DeployFlow';
import EnvironmentsSection from './environments/EnvironmentsSection';
import SnapshotsSection from './snapshots/SnapshotsSection';

export default function Deploy() {
  const { can } = useAuth();
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
        <p>Create an environment and deploy it, step by step. Your environments and snapshots are below.</p>
      </div>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {can('deploy', 'add')
        ? <DeployFlow targets={targets} reloadTargets={reloadTargets} />
        : <p className="page-hint">You can view deployments but not create them. Ask a super admin for access.</p>}
      <EnvironmentsSection targets={targets} />
      <SnapshotsSection />
    </div>
  );
}
