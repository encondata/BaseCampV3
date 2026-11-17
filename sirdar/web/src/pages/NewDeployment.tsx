/** /deploy/new: New deployment, the step-by-step flow that creates an
 *  environment and deploys it (DeployFlow), from step 1 with fresh choices
 *  each time the page opens. Needs deploy:add, as the Environments page's
 *  New deployment button does. The topbar shows Sirdar / Environments / New
 *  deployment; the eyebrow links back to Environments. Targets, the
 *  connection test and trusted SSH hosts live in the flow's Target step. */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import { errorText, getDeployTargets, type DeployTarget } from '../lib/sirdarApi';

import { NO_ADD_NOTE } from './Deploy';
import DeployFlow from './deploy/DeployFlow';

export default function NewDeployment() {
  const { can } = useAuth();
  const canAdd = can('deploy', 'add');
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [loadError, setLoadError] = useState('');
  const loadTargets = useCallback(() => getDeployTargets()
    .then((r) => { setTargets(r.targets); setLoadError(''); })
    .catch((e) => setLoadError(errorText(e, "Couldn't load deployment targets."))), []);
  useEffect(() => { if (canAdd) void loadTargets(); }, [canAdd, loadTargets]);
  const reloadTargets = useCallback(() => { void loadTargets(); }, [loadTargets]);

  return (
    <div className="portal-page">
      <div className="eyebrow"><Link to="/deploy">Environments</Link></div>
      <div className="dir-head">
        <h1>New deployment</h1>
        <p>Create an environment and deploy it, step by step.</p>
      </div>
      {!canAdd ? (
        <p className="page-hint">{NO_ADD_NOTE}</p>
      ) : (
        <>
          {loadError && <p className="form-error" role="alert">{loadError}</p>}
          <DeployFlow targets={targets} reloadTargets={reloadTargets} />
        </>
      )}
    </div>
  );
}
