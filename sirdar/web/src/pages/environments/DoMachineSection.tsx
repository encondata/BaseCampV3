/** Overview of a DigitalOcean environment: where it runs, its load balancer,
 *  certificate, database and bucket, and its slots — Activate on a deployed
 *  idle slot, Deactivate on a retiring production. */
import DataTable from '@portal/components/DataTable';

import Breakable from '../../components/Breakable';
import type { Environment } from '../../lib/sirdarApi';

import { certDaysLeft, shortSha, slotTitle, when } from './labels';

export default function DoMachineSection({ env, canActivate, onActivate }: {
  env: Environment; canActivate: boolean; onActivate: (slot: string | null) => void;
}) {
  const d = env.do;
  if (!d) return null;
  const days = certDaysLeft(d.cert_not_after);
  const retiringProduction = env.type === 'production' && env.retiring;
  const cert = d.cert_not_after
    ? `${new Date(d.cert_not_after).toLocaleDateString()} (${Math.max(days ?? 0, 0)} days)`
      + (d.acme_staging ? " · Let's Encrypt staging" : '')
    : 'Issued by the first deploy';
  return (
    <section className="sirdar-section" aria-labelledby="sirdar-do-heading">
      <h2 id="sirdar-do-heading">DigitalOcean</h2>
      <dl className="sirdar-kv">
        <dt>Account</dt><dd>{d.account_label} · {d.region}</dd>
        <dt>Load balancer</dt><dd className="mono">{d.lb_ip ?? 'Built by the first deploy'}</dd>
        <dt>Certificate</dt>
        <dd>
          {cert}
          {days !== null && days < 0 && <> <span className="chip c-red">Expired</span></>}
          {days !== null && days >= 0 && days <= 14 && <> <span className="chip c-amber">Renews soon</span></>}
        </dd>
        <dt>Database</dt><dd className="mono"><Breakable text={d.db_host ?? '—'} /></dd>
        <dt>Sizes</dt><dd className="mono">{d.droplet_size} · {d.db_size}{d.db_standby ? ' · standby node' : ''}</dd>
        <dt>Bucket</dt><dd className="mono">{d.bucket ?? '—'}</dd>
      </dl>
      <DataTable
        ariaLabel="Slots"
        columns={[{ key: 'slot', label: 'Slot' }, { key: 'droplet', label: 'Droplet', mono: true },
                  { key: 'commit', label: 'Commit', mono: true }, { key: 'check', label: 'Last smoke test' },
                  { key: 'live', label: '', align: 'right' }]}
        rows={d.slots.map((s) => ({
          key: s.slot,
          cells: [
            <b className="cell-top">{slotTitle(s.slot)}</b>,
            s.public_ip ? `${s.droplet_id} · ${s.public_ip}` : 'Not built yet',
            shortSha(s.sha),
            s.last_check_ok === null ? '—' : `${s.last_check_ok ? 'Passed' : 'Failed'} · ${when(s.last_check_at)}`,
            s.active
              ? (canActivate && retiringProduction
                ? <button type="button" className="mini-btn danger" onClick={() => onActivate(null)}>Deactivate</button>
                : <span className="chip c-green">Live</span>)
              : canActivate && s.sha && env.slots.length > 1 && !retiringProduction
                ? <button type="button" className="mini-btn" aria-label={`Activate ${slotTitle(s.slot)}`}
                          onClick={() => onActivate(s.slot)}>Activate</button>
                : <span className="cell-sub">{s.sha ? 'Idle' : 'Not deployed'}</span>,
          ],
        }))}
      />
      <p className="page-hint">
        {env.slots.length === 1
          ? 'One slot: it updates in place on each deploy. Add a second slot in Settings. The database and the bucket '
            + 'live outside the droplet.'
          : 'Each deploy goes to the idle slot; Activate moves traffic to it. The database and the bucket are shared '
            + 'by both slots.'}
      </p>
    </section>
  );
}
