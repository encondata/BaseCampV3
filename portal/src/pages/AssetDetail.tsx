/**
 * Asset Details — full read view of a single asset: identity, location &
 * status, notes/files, scan history. Editable via the shared
 * AssetEditModal; chrome mirrors MoveAssetDetail (idet- classes, init-panel).
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AssetEditModal from '../components/assets/AssetEditModal';
import NotesFilesPanel from '../components/NotesFilesPanel';
import ScanHistoryTable from '../components/scans/ScanHistoryTable';
import {
  getAsset, listAssetStatuses, listAssets, listClients, listSites,
  type AssetItem, type OrgRef, type SiteItem, type StatusValue,
} from '../lib/api';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/system.css';

import StatusHover from '../components/StatusHover';

const chip = (label: string | null, color: string | null) =>
  label && color ? (
    <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  ) : null;

export default function AssetDetail() {
  const { assetId } = useParams<{ assetId: string }>();
  const { can } = useAuth();
  const canChange = can('assets', 'change');
  const canViewScans = can('scans', 'view');
  const canViewSites = can('sites', 'view');

  const [asset, setAsset] = useState<AssetItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);

  const [statuses, setStatuses] = useState<StatusValue[]>([]);
  const [clients, setClients] = useState<OrgRef[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [allAssets, setAllAssets] = useState<AssetItem[]>([]);

  const load = useCallback(async () => {
    if (!assetId) return;
    try {
      setAsset(await getAsset(assetId));
      setMissing(false);
    } catch {
      setMissing(true);
    }
  }, [assetId]);

  useEffect(() => {
    void load();
    if (canChange) {
      void listAssetStatuses().then(setStatuses).catch(() => {});
      void listClients().then(setClients).catch(() => {});
      if (canViewSites) void listSites().then(setSites).catch(() => {});
      void listAssets().then(setAllAssets).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const existingSerials = useMemo(() => new Set(
    allAssets.map((a) => a.serial_number?.trim().toLowerCase()).filter((s): s is string => !!s),
  ), [allAssets]);

  const back = <Link to="/assets" className="idet-back">← Assets</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Asset not found</b>This asset does not exist or was removed.
        </div>
      </div>
    );
  }
  if (!asset) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const title = asset.name ?? asset.serial_number ?? 'Asset';

  return (
    <div className="portal-page">
      {back}
      <div className="idet-header">
        <div className="idet-heading">
          <h1 className="page-title">{title}</h1>
          <p className="page-hint">
            {[asset.model ? `${asset.model.make} ${asset.model.model}` : null, asset.status_label]
              .filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        {canChange && (
          <div className="idet-header-actions">
            <button className="btn-solid" onClick={() => setEditing(true)}>Edit</button>
          </div>
        )}
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Identity</p>
        <dl className="kv">
          <dt>Serial</dt><dd className="mono">{asset.serial_number ?? '—'}</dd>
          <dt>Name</dt><dd>{asset.name ?? '—'}</dd>
          <dt>RFID tag</dt><dd className="mono">{asset.rfid_tag ?? '—'}</dd>
          <dt>Model</dt>
          <dd>{asset.model ? `${asset.model.make} ${asset.model.model}` : '—'}</dd>
          <dt>Category</dt><dd>{asset.model?.category_label ?? '—'}</dd>
          <dt>RU</dt><dd>{asset.model?.ru_size ?? '—'}</dd>
          <dt>Rails present</dt>
          <dd>{asset.has_rails === null ? 'Unknown' : asset.has_rails ? 'Yes' : 'No'}</dd>
        </dl>
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Location & status</p>
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <StatusHover entityType="asset" entityId={asset.id} status={asset.status}>
              {chip(asset.status_label, asset.status_color) ?? asset.status_label}
            </StatusHover>
          </dd>
          <dt>Client</dt><dd>{asset.client_name ?? 'House'}</dd>
          <dt>Site</dt><dd>{asset.site_name ?? '—'}</dd>
          <dt>Location</dt><dd>{asset.location_detail || '—'}</dd>
          <dt>Last seen</dt>
          <dd>{asset.last_seen_at ? new Date(asset.last_seen_at).toLocaleString() : '—'}</dd>
          <dt>Created</dt><dd>{new Date(asset.created_at).toLocaleDateString()}</dd>
        </dl>
      </div>

      <div className="init-panel">
        <NotesFilesPanel entityType="asset" entityId={asset.id} canWrite={canChange} />
      </div>

      {canViewScans && (
        <div className="init-panel">
          <p className="eyebrow-sm">Scan History</p>
          <ScanHistoryTable assetId={asset.id} />
        </div>
      )}

      {editing && (
        <AssetEditModal
          asset={asset}
          statuses={statuses}
          clients={clients}
          sites={sites}
          existingSerials={existingSerials}
          canChange={canChange}
          onClose={() => setEditing(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}
