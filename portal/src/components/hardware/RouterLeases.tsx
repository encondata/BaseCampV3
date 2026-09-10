/** Expansion panel for a router row: DHCP leases in a view-switched
 *  real table (Active / Reserved), fetched fresh on each open. House
 *  detail-surface rules: aligned columns, '—' per empty cell, explicit
 *  switcher buttons — never a joined-string dump. */

import { useEffect, useState } from 'react';

import DataTable from '../DataTable';
import { listDeviceLeases, type DeviceLease } from '../../lib/api';

type View = 'active' | 'reserved';

export default function RouterLeases({ deviceId }: { deviceId: string }) {
  const [leases, setLeases] = useState<DeviceLease[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('active');

  const load = () => {
    setError('');
    listDeviceLeases(deviceId)
      .then(setLeases)
      .catch(() => setError("Couldn't load leases."));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  if (error) {
    return (
      <div>
        <p className="set-note" style={{ padding: 0 }}>{error}</p>
        <button className="mini-btn" onClick={load}>Retry</button>
      </div>
    );
  }

  if (leases === null) {
    return <p className="set-note" style={{ padding: 0 }}>Loading leases…</p>;
  }

  const active = leases.filter((l) => !l.reserved);
  const reserved = leases.filter((l) => l.reserved);
  const shown = view === 'active' ? active : reserved;

  return (
    <div>
      <div className="lease-tabs">
        <button type="button" className="lease-tab" aria-pressed={view === 'active'}
                onClick={() => setView('active')}>
          Active ({active.length})
        </button>
        <button type="button" className="lease-tab" aria-pressed={view === 'reserved'}
                onClick={() => setView('reserved')}>
          Reserved ({reserved.length})
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="set-note" style={{ padding: 0 }}>
          {view === 'active' ? 'No active leases.' : 'No reservations.'}
        </p>
      ) : (
        <DataTable
          ariaLabel="DHCP leases"
          columns={[
            { key: 'up', label: 'Up', width: '44px', align: 'center' },
            { key: 'host', label: 'Hostname' },
            { key: 'ip', label: 'IP', mono: true },
            { key: 'mac', label: 'MAC', mono: true },
            { key: 'seen', label: 'Last seen', mono: true },
          ]}
          rows={shown.map((l) => ({
            key: l.id,
            cells: [
              <span className={l.up ? 'lease-dot up' : 'lease-dot'} title={l.up ? 'Up' : 'Down'} />,
              l.hostname ?? '—',
              l.ip ?? '—',
              l.mac,
              l.last_seen_at ? new Date(l.last_seen_at).toLocaleString() : '—',
            ],
          }))}
        />
      )}
    </div>
  );
}
