/** Deployments tab: the open deployment (if any) above the history. */
import { useCallback, useEffect, useRef, useState } from 'react';

import DataTable from '@portal/components/DataTable';

import { errorText, listDeployments, type DeploymentSummary, type Environment } from '../../lib/sirdarApi';

import DeploymentView from './DeploymentView';
import { DEPLOYMENT_STATUS, MODE_LABEL, StatusChip, shortSha, when } from './labels';

export default function DeploymentsTab({ env, selected, onSelect, onChanged }: {
  env: Environment; selected: string | null; onSelect: (id: string | null) => void; onChanged: () => void;
}) {
  const [rows, setRows] = useState<DeploymentSummary[] | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);

  // Only the newest request's answer lands.
  const load = useCallback(() => {
    const n = ++seq.current;
    return listDeployments(env.name)
      .then((r) => { if (n === seq.current) { setRows(r.deployments); setError(''); } })
      .catch((e) => { if (n === seq.current) setError(errorText(e, "Couldn't load the deployments.")); });
  }, [env.name]);
  // A newly selected deployment (just started or retried) joins the list.
  useEffect(() => { void load(); }, [load, selected]);
  useEffect(() => () => { seq.current += 1; }, []);

  const latestId = rows?.[0]?.id ?? null;
  return (
    <>
      {selected && (
        <DeploymentView key={selected} id={selected} env={env} isLatest={rows === null ? null : selected === latestId}
                        onFinished={() => { void load(); onChanged(); }}
                        onRetried={(dep) => { onChanged(); onSelect(dep.id); }}
                        onClose={() => onSelect(null)} />
      )}
      <section className="sirdar-section">
        <h2>History</h2>
        {error && <p className="form-error" role="alert">{error}</p>}
        <DataTable
          ariaLabel="Deployments"
          columns={[
            { key: 'when', label: 'Started', mono: true }, { key: 'mode', label: 'Mode' },
            { key: 'ref', label: 'Ref · SHA', mono: true }, { key: 'status', label: 'Status' },
            { key: 'by', label: 'By' }, { key: 'act', label: '', align: 'right' },
          ]}
          rows={(rows ?? []).map((d) => ({
            key: d.id,
            cells: [
              when(d.started_at), MODE_LABEL[d.mode] ?? d.mode, `${d.git_ref} · ${shortSha(d.sha)}`,
              <StatusChip map={DEPLOYMENT_STATUS} status={d.status} />, d.actor_name ?? '—',
              d.id === selected
                ? <span className="cell-sub">Open</span>
                : <button type="button" className="mini-btn" aria-label={`Open the deployment from ${when(d.started_at)}`}
                          onClick={() => onSelect(d.id)}>Open</button>,
            ],
          }))}
          emptyText={rows === null ? 'Loading…' : 'No deployments yet.'}
        />
      </section>
    </>
  );
}
