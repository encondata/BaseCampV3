/** Overview › Blue/Green: a LAN Blue/Green environment's data VM and two app
 *  VMs, which slot is live, and Activate on the idle one once it ran a deploy. */
import DataTable from '@portal/components/DataTable';

import type { Environment } from '../../lib/sirdarApi';

import { slotTitle, vmSize, when } from './labels';

const ROLE_LABEL: Record<string, string> = { data: 'Data', orange: 'Orange', purple: 'Purple' };

export default function LanMachinesSection({ env, canActivate, onActivate }: {
  env: Environment; canActivate: boolean; onActivate: (slot: string) => void;
}) {
  const slots = new Map((env.lan_slots ?? []).map((s) => [s.slot, s]));
  return (
    <section className="sirdar-section" aria-labelledby="sirdar-lan-heading">
      <h2 id="sirdar-lan-heading">Blue/Green</h2>
      <p className="page-hint">
        Nginx Proxy Manager sends traffic to the live app VM; both app VMs use the data VM's database and storage.
      </p>
      <DataTable
        ariaLabel="Blue/Green VMs"
        columns={[
          { key: 'role', label: 'Role' }, { key: 'name', label: 'VM', mono: true },
          { key: 'ip', label: 'Address', mono: true }, { key: 'size', label: 'Size' },
          { key: 'state', label: 'Traffic' }, { key: 'version', label: 'Version', mono: true },
          { key: 'check', label: 'Last check' }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={env.machines.map((m) => {
          const s = slots.get(m.role);
          const live = !!s?.active;
          const state = m.role === 'data'
            ? <span className="chip tag">Shared</span>
            : live ? <span className="chip c-green">Live</span>
              : s?.sha ? <span className="chip c-blue">Idle</span> : <span className="chip tag">Not deployed</span>;
          const check = s?.last_check_ok == null ? '—'
            : `${s.last_check_ok ? 'Passed' : 'Failed'} · ${when(s.last_check_at)}`;
          return {
            key: m.role,
            cells: [
              <b className="cell-top">{ROLE_LABEL[m.role] ?? m.role}</b>, m.name, m.ip ?? 'Not built yet',
              vmSize(m), state, s?.image_tag ?? '—', check,
              canActivate && s && !live && s.sha
                ? (
                  <button type="button" className="mini-btn" onClick={() => onActivate(m.role)}>
                    {`Activate ${slotTitle(m.role)}`}
                  </button>
                )
                : '',
            ],
          };
        })}
      />
    </section>
  );
}
