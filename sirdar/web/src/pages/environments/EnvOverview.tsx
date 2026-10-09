/** Overview tab: what's running, and where each service answers. */
import DataTable from '@portal/components/DataTable';

import type { Environment } from '../../lib/sirdarApi';

import DoMachineSection from './DoMachineSection';
import {
  DEPLOYMENT_STATUS, StatusChip, deploymentLabel, onBluegreen, onDo, onVmHost, vmNetwork, vmRef, vmSize, when,
} from './labels';
import LanMachinesSection from './LanMachinesSection';

export default function EnvOverview({ env, canActivate = false, onActivate }: {
  env: Environment; canActivate?: boolean; onActivate?: (slot: string | null) => void;
}) {
  const last = env.last_deployment;
  const cloud = onDo(env);
  const bluegreen = onBluegreen(env);
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
                <StatusChip map={DEPLOYMENT_STATUS} status={last.status} /> {deploymentLabel(last)} ·{' '}
                <span className="mono">{when(last.finished_at ?? last.started_at)}</span>
                {last.actor_name && <> · {last.actor_name}</>}
              </>
            ) : 'None yet'}
          </dd>
        </dl>
      </section>
      {cloud && (
        <DoMachineSection env={env} canActivate={canActivate && !!onActivate} onActivate={(s) => onActivate?.(s)} />
      )}
      {bluegreen && (
        <LanMachinesSection env={env} canActivate={canActivate && !!onActivate} onActivate={(s) => onActivate?.(s)} />
      )}
      {onVmHost(env) && env.vm && (
        <section className="sirdar-section">
          <h2>Machine</h2>
          <dl className="sirdar-kv">
            <dt>VM</dt>
            <dd className="mono">
              {vmRef(env.vm) ? `${env.vm.name} (${vmRef(env.vm)})` : `${env.vm.name} · built by the first deploy`}
            </dd>
            <dt>{env.vm.kind === 'esxi' ? 'Host' : 'Node'}</dt><dd className="mono">{env.vm.host}</dd>
            <dt>Size</dt><dd>{vmSize(env.vm)}</dd>
            <dt>Network</dt><dd className="mono">{vmNetwork(env.vm)}</dd>
            <dt>Address</dt><dd className="mono">{env.vm.ip ?? 'Not known yet'}</dd>
            <dt>VM snapshots kept</dt><dd>{env.vm.keep_snapshots}</dd>
          </dl>
        </section>
      )}
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
              s.service === 'home'
                ? <span className="cell-sub">Redirects to the portal</span>
                : cloud
                ? `:${s.port} on each droplet`
                : bluegreen && s.service !== 'spaces'
                ? `:${s.port} on the live app VM`
                : s.service === 'mailpit'
                ? <a href={`http://${s.host_ip}:${s.port}`} target="_blank" rel="noreferrer">{`${s.host_ip}:${s.port}`}</a>
                : `${s.host_ip}:${s.port}`,
            ],
          }))}
        />
        <p className="page-hint">
          {cloud
            ? "The load balancer serves the public names; DNS points at it. Mailpit catches this environment's email "
              + 'on each droplet.'
            : env.publish
            ? 'Sirdar keeps their DNS records and proxy hosts up to date on every deploy (Publish tab). '
            : 'Public URLs answer once their DNS records and proxy hosts exist: set up by hand, or turn Publish on. '}
          {!cloud && "Mailpit catches this environment's email on the LAN."}
        </p>
      </section>
    </>
  );
}
