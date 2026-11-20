/** Devices: the iPhones and iPads added for installs, as a list, under the Apple
 *  team's device count for each class this membership year. Loading the
 *  page asks the API to check the counts with Apple when they're over a
 *  minute old. Roles that may delete get Disable (with a review first). */
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable, { type DataTableColumn } from '@portal/components/DataTable';
import StandardModal from '@portal/components/StandardModal';
import { RowActionsMenu, type RowAction } from '@portal/components/hardware/RowActionsMenu';

import {
  disableDevice, errorText, listDevices, type DeviceCount, type DeviceOut, type DevicesOut, type DeviceStatus,
} from '../lib/appsApi';
import { day, dayTime } from '../lib/dates';

/** Apple's limit per device class each membership year. */
const CLASS_LIMIT = 100;

const CLASS_LABEL: Record<string, string> = {
  IPHONE: 'iPhone', IPAD: 'iPad', IPOD: 'iPod touch', APPLE_WATCH: 'Apple Watch', APPLE_TV: 'Apple TV',
  APPLE_VISION_PRO: 'Apple Vision Pro', MAC: 'Mac', UNKNOWN: 'Other devices',
};

const STATUS_CHIP: Record<DeviceStatus, [label: string, color: string]> = {
  pending: ['Pending', 'c-amber'],
  registered: ['Registered', 'c-green'],
  failed: ['Failed', 'c-red'],
  disabled: ['Disabled', 'c-slate'],
};

const COLUMNS: DataTableColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'model', label: 'Model', mono: true },
  { key: 'os', label: 'iOS', mono: true },
  { key: 'by', label: 'Added by' },
  { key: 'added', label: 'Added', mono: true },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: '', align: 'right' },
];

/** "Last checked 14:05" today; an older check carries its date. */
function lastChecked(counts: DeviceCount[]): string | null {
  if (counts.length === 0) return null;
  const latest = counts.reduce((a, b) => (Date.parse(b.synced_at) > Date.parse(a.synced_at) ? b : a)).synced_at;
  const when = dayTime(latest);
  return `Last checked ${day(latest) === day(new Date().toISOString()) ? when.slice(-5) : when}`;
}

export default function DevicesPage() {
  const { can } = useAuth();
  const [data, setData] = useState<DevicesOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState<DeviceOut | null>(null);
  const canDelete = can('app_distribution', 'delete');

  const load = useCallback(async () => {
    try {
      setData(await listDevices());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const actionsFor = (d: DeviceOut): RowAction[] => (canDelete && d.status !== 'disabled'
    ? [{ key: 'disable', label: 'Disable', destructive: true, onSelect: () => setDisabling(d) }]
    : []);

  const rows = (data?.devices ?? []).map((d) => {
    const [label, color] = STATUS_CHIP[d.status];
    return {
      key: d.id,
      cells: [
        <b className="cell-top">{d.name}</b>,
        d.product,
        d.os_version,
        d.added_by_name,
        day(d.added_at),
        <div className="devices-status-cell">
          <span className={`chip ${color}`}>{label}</span>
          {(d.status === 'failed' || d.status === 'disabled') && d.error && <span className="cell-sub">{d.error}</span>}
        </div>,
        <RowActionsMenu actions={actionsFor(d)} />,
      ],
    };
  });
  const checked = data ? lastChecked(data.counts) : null;

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Devices</div>
          <h1 className="page-title">Devices</h1>
        </div>
      </div>
      {data && data.counts.length > 0 && (
        <div className="devices-counts">
          {data.counts.map((c) => (
            <p key={c.device_class} className="devices-count">
              {`${CLASS_LABEL[c.device_class] ?? c.device_class} ${c.count} of ${CLASS_LIMIT} this membership year`}
            </p>
          ))}
          {checked && <p className="page-hint">{checked}</p>}
        </div>
      )}
      {error && <p className="pf-error">{error}</p>}
      {data && <DataTable columns={COLUMNS} rows={rows} ariaLabel="iPhones and iPads" emptyText="No iPhones or iPads added yet." />}

      {disabling && (
        <DisableDialog device={disabling} onClose={() => setDisabling(null)}
                       onDone={() => { setDisabling(null); void load(); }} />
      )}
    </div>
  );
}

/** The review before disabling: what it means, then the action. */
function DisableDialog({ device, onClose, onDone }: { device: DeviceOut; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await disableDevice(device.id);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <StandardModal
      eyebrow="Devices" title={`Disable ${device.name}?`}
      description="It can no longer install or update apps. Apple won't free its slot until the membership renews."
      onClose={onClose} busy={busy} cardClass="devices-modal devices-modal-narrow"
      footer={(
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-solid btn-danger" disabled={busy} onClick={() => void go()}>Disable</button>
        </>
      )}
    >
      {error && <p className="pf-error">{error}</p>}
    </StandardModal>
  );
}
