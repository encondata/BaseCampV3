/**
 * Move Asset Details — one roster row in full: parent-asset summary,
 * complete move details, scan history. Editable via the shared
 * AssetEditDialog; chrome mirrors InitiativeDetail (idet-*).
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AssetEditDialog from '../components/initiatives/AssetEditDialog';
import ScanHistoryTable from '../components/scans/ScanHistoryTable';
import {
  getAsset, getInitiative, listAssetStatuses, listInitiativeAssets,
  type AssetItem, type InitiativeAssetRow, type StatusValue,
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

export default function MoveAssetDetail() {
  const { id, rowId } = useParams<{ id: string; rowId: string }>();
  const { can } = useAuth();
  const canChange = can('initiatives', 'change');
  const canViewScans = can('scans', 'view');

  const [initiativeName, setInitiativeName] = useState<string | null>(null);
  const [row, setRow] = useState<InitiativeAssetRow | null>(null);
  const [asset, setAsset] = useState<AssetItem | null>(null);
  const [moveStatuses, setMoveStatuses] = useState<StatusValue[]>([]);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!id || !rowId) return;
    try {
      const rows = await listInitiativeAssets(id);
      const found = rows.find((r) => r.id === rowId) ?? null;
      setRow(found);
      setMissing(found === null);
      setLoadError(false);
      if (found) void getAsset(found.asset_id).then(setAsset).catch(() => {});
    } catch {
      setLoadError(true);
    }
  }, [id, rowId]);

  useEffect(() => {
    void load();
    if (id) {
      void getInitiative(id).then((i) => {
        setInitiativeName(i.name);
        // Asset status vocabulary (merged: lifecycle + move workflow keys) —
        // only needed for moves, feeds the edit dialog's Status ComboBox
        // below. Same fetcher + gating as InitiativeDetail.tsx.
        if (i.initiative_type === 'move') {
          void listAssetStatuses().then(setMoveStatuses).catch(() => {});
        }
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rowId]);

  const back = (
    <Link to={`/initiatives/${id}`} className="idet-back">
      ← {initiativeName ?? 'Initiative'}
    </Link>
  );

  if (loadError) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Could not load this asset.</b>
        </div>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Not on this initiative</b>This asset is no longer on the initiative.
        </div>
      </div>
    );
  }
  if (!row) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');
  const title = row.asset.name ?? row.asset.serial_number ?? 'Asset';

  return (
    <div className="portal-page">
      {back}
      <div className="idet-header">
        <div className="idet-heading">
          <h1 className="page-title">{title}</h1>
          <p className="page-hint">
            {[row.asset.serial_number, asset?.model
              ? `${asset.model.make} ${asset.model.model}` : null]
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
        <p className="eyebrow-sm">Parent Asset</p>
        <dl className="kv">
          <dt>Name</dt><dd>{asset?.name ?? '—'}</dd>
          <dt>Serial</dt><dd className="mono">{asset?.serial_number ?? '—'}</dd>
          <dt>RFID tag</dt><dd className="mono">{asset?.rfid_tag ?? '—'}</dd>
          <dt>Model</dt>
          <dd>{asset?.model ? `${asset.model.make} ${asset.model.model}` : '—'}</dd>
          <dt>Category</dt><dd>{asset?.model?.category_label ?? '—'}</dd>
          <dt>Status</dt>
          <dd>{asset ? (chip(asset.status_label, asset.status_color)
            ?? asset.status_label) : '—'}</dd>
          <dt>Client</dt><dd>{asset?.client_name ?? 'House'}</dd>
          <dt>Site</dt><dd>{asset?.site_name ?? '—'}</dd>
          <dt>Location</dt><dd>{asset?.location_detail || '—'}</dd>
          <dt>Last seen</dt>
          <dd>{asset?.last_seen_at
            ? new Date(asset.last_seen_at).toLocaleString() : '—'}</dd>
        </dl>
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Move Details</p>
        <div className="detail-grid">
          <div className="detail-block">
            <p className="eyebrow-sm">Placement</p>
            <dl className="kv">
              <dt>Source rack</dt><dd>{row.source_rack ?? '—'}</dd>
              <dt>Source RU</dt><dd>{row.source_ru ?? '—'}</dd>
              <dt>Source position</dt><dd>{row.source_position ?? '—'}</dd>
              <dt>Source verified</dt><dd>{yesNo(row.source_verified)}</dd>
              <dt>Destination rack</dt><dd>{row.destination_rack ?? '—'}</dd>
              <dt>Destination RU</dt><dd>{row.destination_ru ?? '—'}</dd>
              <dt>Destination position</dt><dd>{row.destination_position ?? '—'}</dd>
              <dt>Destination verified</dt><dd>{yesNo(row.destination_verified)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Logistics</p>
            <dl className="kv">
              <dt>Wave</dt><dd>{row.priority_wave ?? '—'}</dd>
              <dt>Disposition</dt><dd>{row.disposition ?? '—'}</dd>
              <dt>Owner</dt><dd>{row.owner ?? '—'}</dd>
              <dt>Cable info</dt><dd>{row.cable_info ?? '—'}</dd>
              <dt>Vendor involved</dt><dd>{yesNo(row.vendor_involved)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Status</p>
            <dl className="kv">
              <dt>Move status</dt>
              <dd>
                <StatusHover entityType="initiative_asset" entityId={row.id} status={row.status}>
                  {chip(row.status_label, row.status_color) ?? row.status_label}
                </StatusHover>
              </dd>
              <dt>Asset status</dt>
              <dd>
                <StatusHover entityType="asset" entityId={row.asset_id} status={row.asset.status}>
                  {chip(row.asset.status_label, row.asset.status_color)
                    ?? row.asset.status_label}
                </StatusHover>
              </dd>
              <dt>Added</dt><dd>{new Date(row.created_at).toLocaleDateString()}</dd>
              <dt>Updated</dt><dd>{new Date(row.updated_at).toLocaleDateString()}</dd>
            </dl>
          </div>
        </div>
      </div>

      {canViewScans && (
        <div className="init-panel">
          <p className="eyebrow-sm">Scan History</p>
          <ScanHistoryTable assetId={row.asset_id} />
        </div>
      )}

      {editing && (
        <AssetEditDialog
          asset={row}
          moveStatuses={moveStatuses}
          onClose={() => setEditing(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}
