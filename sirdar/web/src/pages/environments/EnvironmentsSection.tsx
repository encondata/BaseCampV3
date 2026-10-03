/** The Environments section at the top of /deploy. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import { errorText, listEnvironments, type DeployTarget, type Environment } from '../../lib/sirdarApi';

import {
  DEPLOYMENT_STATUS, ENV_STATUS, StatusChip, TYPE_LABEL, shortSha, targetLabel, when,
} from './labels';
import NewEnvironmentModal from './NewEnvironmentModal';

export default function EnvironmentsSection({ targets }: { targets: DeployTarget[] }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => listEnvironments()
    .then((r) => { setEnvs(r.environments); setError(''); })
    .catch((e) => setError(errorText(e, "Couldn't load environments."))), []);
  useEffect(() => { void load(); }, [load]);

  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Environments</h2>
        {can('deploy', 'add') && (
          <button type="button" className="btn-solid" onClick={() => setCreating(true)}>New environment</button>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Environments"
        columns={[
          { key: 'name', label: 'Name' }, { key: 'target', label: 'Target' }, { key: 'type', label: 'Type' },
          { key: 'ref', label: 'Ref · SHA', mono: true }, { key: 'status', label: 'Status' },
          { key: 'last', label: 'Last deploy' },
        ]}
        rows={(envs ?? []).map((e) => ({
          key: e.id,
          cells: [
            <Link to={`/deploy/environments/${encodeURIComponent(e.name)}`}><b className="cell-top">{e.name}</b></Link>,
            targetLabel(targets, e.target),
            TYPE_LABEL[e.type] ?? e.type,
            `${e.git_ref} · ${shortSha(e.current_sha)}`,
            <StatusChip map={ENV_STATUS} status={e.status} />,
            e.last_deployment
              ? <><StatusChip map={DEPLOYMENT_STATUS} status={e.last_deployment.status} />{' '}
                  <span className="mono">{when(e.last_deployment.finished_at ?? e.last_deployment.started_at)}</span></>
              : '—',
          ],
        }))}
        emptyText={envs === null ? 'Loading…' : 'No environments yet.'}
      />
      {creating && (
        <NewEnvironmentModal
          onClose={() => setCreating(false)}
          onCreated={(env) => { setCreating(false); navigate(`/deploy/environments/${encodeURIComponent(env.name)}`); }} />
      )}
    </section>
  );
}
