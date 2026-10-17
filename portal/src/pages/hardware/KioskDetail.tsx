/**
 * KioskDetail — one kiosk's details page (/hardware/kiosks/:id), layout A of
 * the kiosk-settings spec (docs/superpowers/specs/2026-10-17-kiosk-config-in-portal-design.md
 * §6): a header, then tabs across the top — Overview, Settings, Devices,
 * Setup & move, History — each on its own sub-path like UserDetail's.
 *
 * Anyone with scanning_hardware view sees the page. Editing (settings,
 * Reset, scan type, sound upload) needs super admin (rank 80+) AND
 * scanning_hardware change; the API enforces the same gate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import KioskDevicesTab from '../../components/hardware/kiosk/KioskDevicesTab';
import KioskHistoryTab from '../../components/hardware/kiosk/KioskHistoryTab';
import KioskOverviewTab, { statusChip } from '../../components/hardware/kiosk/KioskOverviewTab';
import KioskSettingsTab from '../../components/hardware/kiosk/KioskSettingsTab';
import KioskSetupTab from '../../components/hardware/kiosk/KioskSetupTab';
import { SUPER_ADMIN_RANK } from '../../lib/access';
import {
  ApiError, getDevice, getDeviceConfigHistory, listKioskSounds, listStatusValues,
  type DeviceConfigHistoryItem, type DeviceDetail, type KioskSoundItem, type StatusValue,
} from '../../lib/api';
import { stationTypeLabel } from '../../lib/devices';
import { fullDateTime } from '../../lib/format';
import { agoText, syncLine } from '../../lib/kioskConfig';
import '../../styles/directory.css';
import '../../styles/profile.css';
import '../../styles/settings.css';
import '../../styles/initiatives.css';
import '../../styles/reports.css';
import '../../styles/hardware.css';
import '../../styles/kiosk-detail.css';

type Tab = 'overview' | 'settings' | 'devices' | 'setup' | 'history';

const TABS: [Tab, string, string][] = [
  ['overview', 'Overview', ''],
  ['settings', 'Settings', 'settings'],
  ['devices', 'Devices', 'devices'],
  ['setup', 'Setup & move', 'setup'],
  ['history', 'History', 'history'],
];

const ROLE_LABELS: Record<string, string> = { source: 'source', destination: 'destination' };

export default function KioskDetail() {
  const { id = '', tab: tabParam } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const { can, maxRank } = useAuth();
  const canEdit = maxRank >= SUPER_ADMIN_RANK && can('scanning_hardware', 'change');
  const tab: Tab = (TABS.find(([, , path]) => path && path === tabParam)?.[0]) ?? 'overview';
  const base = `/hardware/kiosks/${id}`;

  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [history, setHistory] = useState<DeviceConfigHistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [sounds, setSounds] = useState<KioskSoundItem[]>([]);
  const [statuses, setStatuses] = useState<StatusValue[] | null>(null);

  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoadError('');
    try {
      const next = await getDevice(id);
      if (seq !== reqSeq.current) return;
      setDetail(next);
      setMissing(false);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setLoadError(err instanceof ApiError && err.status === 403
        ? "You don't have access to scanning hardware." : "Couldn't load this kiosk.");
    }
  }, [id]);

  const histSeq = useRef(0);
  const loadHistory = useCallback(async () => {
    const seq = ++histSeq.current;
    setHistoryError('');
    try {
      const rows = await getDeviceConfigHistory(id);
      if (seq === histSeq.current) setHistory(rows);
    } catch {
      if (seq === histSeq.current) { setHistory([]); setHistoryError("Couldn't load the history."); }
    }
  }, [id]);

  const loadSounds = useCallback(() => {
    listKioskSounds().then(setSounds).catch(() => setSounds([]));
  }, []);

  useEffect(() => {
    setDetail(null);
    setHistory(null);
    void load();
    void loadHistory();
    loadSounds();
  }, [load, loadHistory, loadSounds]);

  useEffect(() => {
    // the checkpoint labels; a failure leaves the raw keys showing
    listStatusValues().then(setStatuses).catch(() => setStatuses(null));
  }, []);

  const onSaved = (next: DeviceDetail) => {
    setDetail(next);
    void loadHistory();
    loadSounds();   // in_use flags follow the stored config
  };

  const back = <Link to="/hardware/kiosks" className="idet-back">← Kiosk Devices</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Kiosk not found</b>This kiosk does not exist or was deleted.
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>{loadError}</b>
          <button type="button" className="mini-btn" style={{ marginTop: 8 }} onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }
  if (!detail) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }
  if (detail.device_type !== 'kiosk') {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Not a kiosk</b>{detail.name} is a {detail.device_type.replace(/_/g, ' ')}, not a kiosk.
        </div>
      </div>
    );
  }

  const s = detail.setup;
  const where = [
    s.initiative_name,
    s.site_name ? `${s.site_name}${s.site_role ? ` (${ROLE_LABELS[s.site_role] ?? s.site_role})` : ''}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="portal-page">
      {back}
      <div className="idet-header">
        <div className="idet-heading">
          <div className="eyebrow">Scanning Hardware › Kiosk Devices</div>
          <div className="idet-title-row">
            <h1 className="page-title">{detail.name}</h1>
            {statusChip(detail)}
            <span className="chip tag">{stationTypeLabel(detail)}</span>
          </div>
          <p className="page-hint">
            {where && <>{where} · </>}
            last check-in <span title={fullDateTime(detail.last_seen_at)}>{agoText(detail.last_seen_at)}</span>
            {' · '}
            <span data-testid="kiosk-sync-line">settings sync: <b>{syncLine(detail)}</b></span>
          </p>
        </div>
      </div>

      <div className="segmented me-tabs" role="tablist" aria-label="Kiosk details">
        {TABS.map(([key, label, path]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
                  className={tab === key ? 'on' : ''}
                  onClick={() => navigate(path ? `${base}/${path}` : base)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <KioskOverviewTab detail={detail} />}
      {tab === 'settings' && (
        <KioskSettingsTab detail={detail} history={history} sounds={sounds} statuses={statuses}
                          canEdit={canEdit} onSaved={onSaved} onSoundsChanged={loadSounds} />
      )}
      {tab === 'devices' && <KioskDevicesTab detail={detail} />}
      {tab === 'setup' && <KioskSetupTab detail={detail} canEdit={canEdit} onSaved={onSaved} />}
      {tab === 'history' && (
        <KioskHistoryTab history={history} sounds={sounds} error={historyError}
                         onRetry={() => void loadHistory()} />
      )}
    </div>
  );
}
