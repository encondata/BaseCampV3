/** Overview tab: what's running, and where each service answers. */
import DataTable from '@portal/components/DataTable';

import type { Environment } from '../../lib/sirdarApi';

import { DEPLOYMENT_STATUS, MODE_LABEL, StatusChip, when } from './labels';

export default function EnvOverview({ env }: { env: Environment }) {
  const last = env.last_deployment;
  return (
    <>
      <section className="sirdar-section">
        <h2>Running</h2>
        <dl className="sirdar-kv">
          <dt>Running commit</dt><dd className="mono">{env.current_sha ?? 'Not deployed yet'}</dd>
          <dt>Image tag</dt><dd className="mono">{env.image_tag ?? '—'}</dd>
          <dt>Default ref</dt><dd className="mono">{env.git_ref}</dd>
          <dt>Folder</dt><dd className="mono">{env.env_dir}</dd>
          {env.seed_snapshot && (
            <>
              <dt>Seed snapshot</dt>
              <dd>{env.seed_snapshot.name}{env.current_sha === null ? ' (the first deploy restores it)' : ''}</dd>
            </>
          )}
          <dt>Last deployment</dt>
          <dd>
            {last ? (
              <>
                <StatusChip map={DEPLOYMENT_STATUS} status={last.status} /> {MODE_LABEL[last.mode] ?? last.mode} ·{' '}
                <span className="mono">{when(last.finished_at ?? last.started_at)}</span>
                {last.actor_name && <> · {last.actor_name}</>}
              </>
            ) : 'None yet'}
          </dd>
        </dl>
      </section>
      <section className="sirdar-section">
        <h2>Services</h2>
        <DataTable
          ariaLabel="Services"
          columns={[{ key: 'service', label: 'Service' }, { key: 'url', label: 'Public URL' },
                    { key: 'addr', label: 'Address', mono: true }]}
          rows={env.services.map((s) => ({
            key: s.service,
            cells: [
              <b className="cell-top">{s.service}</b>,
              s.hostname
                ? <a href={`https://${s.hostname}`} target="_blank" rel="noreferrer">{`https://${s.hostname}`}</a>
                : <span className="cell-sub">LAN only</span>,
              s.service === 'mailpit'
                ? <a href={`http://${s.host_ip}:${s.port}`} target="_blank" rel="noreferrer">{`${s.host_ip}:${s.port}`}</a>
                : `${s.host_ip}:${s.port}`,
            ],
          }))}
        />
        <p className="page-hint">
          Public URLs answer once their DNS records and proxy hosts exist. Mailpit catches this environment's email on the LAN.
        </p>
      </section>
    </>
  );
}
