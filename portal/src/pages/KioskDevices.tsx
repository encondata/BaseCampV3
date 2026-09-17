/** Kiosk Devices — the device-fleet directory list for every device
 *  running the kiosk app. Standalone page (own .portal-page/.dir-head, model:
 *  Notifications.tsx) built on the shared directory-list pattern (model:
 *  components/statusRules/RulesTab.tsx — the freshest full-pattern list):
 *  search + toolbar FilterButton facet (Type/Registration/Site) +
 *  per-column ColumnMenu filters + persisted visible/sort/order state
 *  (usePersistentListState) + CSV export + virtualized rows.
 *
 *  Unlike Routers/FixedReaders, kiosks are provisioned from the portal
 *  (no device-agent self-registration yet), so this page owns the full
 *  create/edit/register lifecycle: "+ New kiosk" opens the shared
 *  DeviceEditModal (kiosk deviceType/noun/typeOptions) in create mode;
 *  row Actions → Edit opens it prefilled; Register/Renew opens
 *  RegisterDaysModal → registerDevice; De-Register confirms then
 *  deregisterDevice. Row actions live behind the shared RowActionsMenu.
 *  Row action gating mirrors the API's permission split — 'add' for
 *  create, 'change' for edit/register/deregister, 'delete' for delete.
 *
 *  "Clear offline" is the one bulk action: a dry run previews every kiosk
 *  unseen for 24h (a never-seen one counts once its row is a day old), the
 *  modal names them, and confirming posts those ids back. The server re-checks each one, so the
 *  notice is built from the confirm response — never from the preview. The
 *  button is gated on rank, not on a permission, and hidden below it. */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { useAuth } from '../auth/AuthContext';
import { ADMIN_RANK } from '../lib/access';
import {
  ApiError, clearOfflineKiosks, deleteDevice, deregisterDevice, listDevices, registerDevice,
  type ClearOfflineKioskItem, type ClearOfflineKiosksOut, type DeviceItem,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  deviceCellText, deviceSearchText, deviceSortValue, loginMethodLabel, registrationLabel,
  subTypeLabel, tokenExpiryState,
} from '../lib/devices';
import {
  ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  moveKey, passesFacets, useReorderDrag, useSearchHaystacks, visibleColumnsFor,
  type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import { VirtualRows } from '../lib/virtualRows';
import ClearOfflineKiosksModal from '../components/hardware/ClearOfflineKiosksModal';
import DeviceEditModal from '../components/hardware/DeviceEditModal';
import RegisterDaysModal from '../components/hardware/RegisterDaysModal';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';  /* .set-note */
import '../styles/hardware.css';

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: 'minmax(150px, 1.2fr)', default: true },
  { key: 'sub_type', label: 'Type', width: '90px', default: true },
  { key: 'ip', label: 'IP', width: 'minmax(110px, 1fr)', default: true },
  { key: 'mac', label: 'MAC', width: 'minmax(150px, 1fr)', default: true },
  { key: 'version', label: 'Version', width: '90px', default: true },
  { key: 'registration', label: 'Registration', width: '120px', default: true },
  { key: 'signed_in', label: 'Signed in', width: 'minmax(140px, 1fr)', default: true },
  { key: 'login_method', label: 'Login', width: '110px', default: true },
  { key: 'current_move', label: 'Current Move', width: 'minmax(160px, 1.2fr)', default: true },
  { key: 'scan_status', label: 'Scan Type', width: 'minmax(140px, 1fr)', default: true },
  { key: 'site', label: 'Site', width: 'minmax(120px, 1fr)', default: true },
  { key: 'expires', label: 'Expires', width: 'minmax(110px, 1fr)', default: false },
  { key: 'last_seen', label: 'Last seen', width: 'minmax(150px, 1fr)', default: false },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

const deviceCellTextTyped: CellText<DeviceItem> = (d, key) => deviceCellText(d, key);

const CSV_COLUMNS: [string, (d: DeviceItem) => string][] = [
  ['ID', (d) => d.id],
  ['Name', (d) => d.name],
  ['Type', (d) => deviceCellText(d, 'sub_type')],
  ['IP', (d) => deviceCellText(d, 'ip')],
  ['MAC', (d) => deviceCellText(d, 'mac')],
  ['Version', (d) => deviceCellText(d, 'version')],
  ['Registration', (d) => deviceCellText(d, 'registration')],
  ['Signed in', (d) => deviceCellText(d, 'signed_in')],
  ['Login', (d) => deviceCellText(d, 'login_method')],
  ['Current Move', (d) => deviceCellText(d, 'current_move')],
  ['Scan Type', (d) => deviceCellText(d, 'scan_status')],
  ['Site', (d) => deviceCellText(d, 'site')],
  ['Expires', (d) => deviceCellText(d, 'expires')],
  ['Last seen', (d) => deviceCellText(d, 'last_seen')],
];

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : "Couldn't complete that action.";

const kioskCount = (n: number) => `${n} ${n === 1 ? 'kiosk' : 'kiosks'}`;

/** Mirrors ClearOfflineKiosksIn.ids's max_length in
 *  api/src/serversherpa/api/schemas.py — confirming more ids than this in one
 *  request 422s. A preview that matches more than this just clears the first
 *  batch; the operator reruns "Clear offline" afterward for what's left,
 *  since a fresh preview only matches kiosks still offline. */
const CLEAR_OFFLINE_BATCH_LIMIT = 500;

/** The success notice is built from the CONFIRM response, never from the
 *  preview: the server re-checks every id, so it can delete fewer kiosks than
 *  the operator was shown. `not_found` is surfaced too, so the numbers
 *  reconcile against what was approved instead of quietly not adding up. */
function clearOfflineNotice(res: ClearOfflineKiosksOut): string {
  const deleted = res.kiosks.length;
  const skipped = res.skipped.length;
  const gone = res.not_found;

  const extras: string[] = [];
  if (skipped > 0) extras.push(`${skipped} skipped, seen since the preview`);
  if (gone > 0) extras.push(`${kioskCount(gone)} no longer existed`);

  if (deleted === 0) {
    if (skipped > 0) {
      const head = `Nothing deleted — ${kioskCount(skipped)} `
        + `${skipped === 1 ? 'has' : 'have'} been seen since the preview`;
      return gone > 0 ? `${head} · ${kioskCount(gone)} no longer existed` : head;
    }
    return gone > 0 ? `Nothing deleted — ${kioskCount(gone)} no longer existed` : 'Nothing deleted';
  }
  return [`Deleted ${kioskCount(deleted)}`, ...extras].join(' · ');
}

/** `matches` is what the confirm button will actually delete — capped to
 *  CLEAR_OFFLINE_BATCH_LIMIT. `total` is the server's real dry-run count,
 *  kept alongside so the modal can tell the operator when the two diverge. */
interface ClearOfflinePreview {
  matches: ClearOfflineKioskItem[];
  total: number;
}

export default function KioskDevices() {
  const { can, maxRank } = useAuth();
  const canAdd = can('scanning_hardware', 'add');
  const canChange = can('scanning_hardware', 'change');
  const canDelete = can('scanning_hardware', 'delete');
  // Bulk clear is admin-and-above only, matching the endpoint's own gate:
  // GATE_BYPASS_RANK in api/src/serversherpa/access/defaults.py. The button
  // is hidden rather than disabled below it — a disabled destructive
  // control just advertises a capability the viewer will never have.
  const canClearOffline = maxRank >= ADMIN_RANK;

  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [editing, setEditing] = useState<DeviceItem | 'new' | null>(null);
  const [registering, setRegistering] = useState<DeviceItem | null>(null);
  // null = the modal is closed; an object (even one with an empty `matches`)
  // = it is open on that preview. Preview failures never open it — see
  // startClearOffline. `total` can exceed `matches.length` when the dry run
  // matched more than CLEAR_OFFLINE_BATCH_LIMIT kiosks — the modal shows
  // both so the operator knows only the first batch will be cleared.
  const [clearPreview, setClearPreview] = useState<ClearOfflinePreview | null>(null);
  const [clearPreviewBusy, setClearPreviewBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'hardware-kiosks', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      setDevices(await listDevices('kiosk'));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? "You don't have access to scanning hardware."
        : "Couldn't load kiosks.");
    }
  };

  useEffect(() => { void load(); }, []);

  const searchText = (d: DeviceItem) => deviceSearchText(d).toLowerCase();
  const haystack = useSearchHaystacks(devices, searchText);

  const facetGroups = useMemo<FacetGroup[]>(() => {
    const subTypes = new Set<string>();
    const registrations = new Set<string>();
    const sites = new Set<string>();
    const loginMethods = new Set<string>();
    for (const d of devices ?? []) {
      subTypes.add(subTypeLabel(d.sub_type));
      registrations.add(registrationLabel(tokenExpiryState(d.token_expires_at)));
      sites.add(d.site_name ?? '—');
      loginMethods.add(loginMethodLabel(d.session_login_method));
    }
    return [
      { key: 'sub_type', title: 'Type', options: Array.from(subTypes).sort().map((v) => (
        { value: v, label: v }
      )) },
      { key: 'registration', title: 'Registration', options: Array.from(registrations).sort()
        .map((v) => ({ value: v, label: v })) },
      { key: 'site', title: 'Site', options: Array.from(sites).sort().map((v) => (
        { value: v, label: v }
      )) },
      { key: 'login_method', title: 'Login', options: Array.from(loginMethods).sort()
        .map((v) => ({ value: v, label: v })) },
    ];
  }, [devices]);

  const facetValues = (d: DeviceItem) => (groupKey: string): string[] => {
    if (groupKey === 'sub_type') return [subTypeLabel(d.sub_type)];
    if (groupKey === 'registration') return [registrationLabel(tokenExpiryState(d.token_expires_at))];
    if (groupKey === 'site') return [d.site_name ?? '—'];
    if (groupKey === 'login_method') return [loginMethodLabel(d.session_login_method)];
    return [];
  };

  const visible = useMemo(() => {
    if (!devices) return [];
    const q = query.trim().toLowerCase();
    const rows = devices.filter((d) => {
      if (!passesFacets(facets, facetValues(d))) return false;
      if (!passesColumnFilters(d, filters, deviceCellTextTyped)) return false;
      if (!q) return true;
      return haystack(d).includes(q);
    });
    return rows.sort((a, b) => {
      const va = deviceSortValue(a, sortKey), vb = deviceSortValue(b, sortKey);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
  }, [devices, facets, filters, query, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 110px` };

  const remove = async (d: DeviceItem) => {
    if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    setError('');
    setNotice('');
    try {
      await deleteDevice(d.id);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const doRegister = async (id: string, days: number) => {
    setRegistering(null);
    setError('');
    setNotice('');
    try {
      await registerDevice(id, days);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  const deregister = async (d: DeviceItem) => {
    if (!window.confirm(`De-register "${d.name}"? Its scan token will be revoked immediately.`)) return;
    setError('');
    setNotice('');
    try {
      await deregisterDevice(d.id);
      await load();
    } catch (err) {
      setError(msgFor(err));
    }
  };

  /** The preview is a POST too, so read-only maintenance mode rejects it with
   *  423 just like the delete. Report that instead of opening a modal whose
   *  empty list would read as "nothing to clear". Guarded against
   *  re-entrancy: a double-click would otherwise fire two dry runs, with no
   *  feedback while either is in flight and the later response winning. */
  const startClearOffline = async () => {
    if (clearPreviewBusy) return;
    setClearPreviewBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await clearOfflineKiosks({ dry_run: true });
      setClearPreview({
        matches: res.kiosks.slice(0, CLEAR_OFFLINE_BATCH_LIMIT),
        total: res.kiosks.length,
      });
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'read_only_mode'
        ? err.message
        : `Couldn't check which kiosks can be cleared. ${msgFor(err)}`);
    } finally {
      setClearPreviewBusy(false);
    }
  };

  const confirmClearOffline = async () => {
    if (!clearPreview) return;
    setClearBusy(true);
    setError('');
    try {
      const res = await clearOfflineKiosks({
        dry_run: false, ids: clearPreview.matches.map((k) => k.id),
      });
      setClearPreview(null);
      setNotice(clearOfflineNotice(res));
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'read_only_mode'
        ? err.message
        : `Couldn't clear the offline kiosks. ${msgFor(err)}`);
    } finally {
      setClearBusy(false);
    }
  };

  const cellFor = (d: DeviceItem, key: string) => {
    switch (key) {
      case 'mac':
        return <span className="mono">{deviceCellText(d, key)}</span>;
      case 'sub_type':
        return d.sub_type == null
          ? <span>—</span>
          : <span className="chip tag">{subTypeLabel(d.sub_type)}</span>;
      case 'registration': {
        const state = tokenExpiryState(d.token_expires_at);
        const cls = state === 'ok' ? 'chip c-green'
          : state === 'soon' ? 'chip c-amber'
          : state === 'expired' ? 'chip c-red'
          : 'chip tag';
        return <span className={cls}>{registrationLabel(state)}</span>;
      }
      case 'scan_status':
        return d.scan_status == null
          ? <span>—</span>
          : (
            <span className="chip custom" title={deviceCellText(d, 'scan_status')}
                  style={{ '--chip': d.scan_status_color } as CSSProperties}>
              <span className="dot" />{deviceCellText(d, 'scan_status')}
            </span>
          );
      case 'login_method':
        return d.session_login_method == null
          ? <span>—</span>
          : <span className="chip tag">{loginMethodLabel(d.session_login_method)}</span>;
      case 'signed_in':
        return d.session_person_name
          ? (
            <span title={d.session_started_at
              ? `Signed in ${new Date(d.session_started_at).toLocaleString()}` : undefined}>
              {deviceCellText(d, 'signed_in')}
            </span>
          )
          : <span>—</span>;
      default:
        return <span>{deviceCellText(d, key)}</span>;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Scanning Hardware</div>
          <h1 className="page-title">
            Kiosk Devices
            <span className="badge-count">{devices?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">Every device running the kiosk app — web, laptop, Pi, Android, Zebra handhelds and iPad.</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter this list…" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="result-count">{visible.length} of {devices?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('kiosks', CSV_COLUMNS, visible)} />
          {canClearOffline && (
            <button type="button" className="mini-btn danger" disabled={clearPreviewBusy}
                    onClick={() => void startClearOffline()}>
              {clearPreviewBusy ? 'Checking…' : 'Clear offline'}
            </button>
          )}
          {canAdd && (
            <button type="button" className="btn-solid" onClick={() => setEditing('new')}>
              + New kiosk
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>{devices ? "Couldn't complete that action" : 'Cannot load kiosks'}</b>{error}
        </div>
      )}

      {notice && (
        <div className="dir-empty" style={{ marginBottom: 12 }} role="status">
          <b>Clear offline kiosks</b>{notice}
        </div>
      )}

      {devices && (
        <div className="dir-list">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={devices ?? []} filters={filters}
                            text={deviceCellTextTyped}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {visible.length === 0 && (
            devices.length === 0 ? (
              <div className="dir-empty">
                No kiosks yet — provision the first one.
              </div>
            ) : (
              <div className="dir-empty">
                <b>No matches</b>Try a different filter.
                <EmptyClearFilters filters={filters}
                                    onClear={() => { clearFilters(); setFacets({}); }} />
              </div>
            )
          )}

          <VirtualRows rows={visible}
            renderRow={(d, vp) => {
              const state = tokenExpiryState(d.token_expires_at);
              return (
                <div key={d.id} className="dir-row" {...vp} style={vp?.style}>
                  <div className="row-main" style={grid}>
                    {shownCols.map((c) => (
                      <div className="cell" key={c.key}>{cellFor(d, c.key)}</div>
                    ))}
                    <div className="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <RowActionsMenu actions={[
                        ...(canChange ? [{ key: 'edit', label: 'Edit', onSelect: () => setEditing(d) }] : []),
                        ...(canChange ? [state === 'none'
                          ? { key: 'register', label: 'Register', onSelect: () => setRegistering(d) }
                          : { key: 'renew', label: 'Renew', onSelect: () => setRegistering(d) }] : []),
                        ...(canChange && state !== 'none'
                          ? [{ key: 'deregister', label: 'De-Register',
                               onSelect: () => void deregister(d) }] : []),
                        ...(canDelete ? [{ key: 'delete', label: 'Delete', destructive: true,
                                           onSelect: () => void remove(d) }] : []),
                      ]} />
                    </div>
                  </div>
                </div>
              );
            }} />
        </div>
      )}

      {editing !== null && (
        <DeviceEditModal
          deviceType="kiosk" noun="kiosk"
          // Every sub_type the kiosk heartbeat can derive. This select is
          // authoritative only for rows created by hand: a device that
          // actually checks in overwrites sub_type from its own client
          // info on the next heartbeat, so the derivation wins there.
          typeOptions={[
            { value: 'laptop', label: 'Laptop' },
            { value: 'pi', label: 'Pi' },
            { value: 'android', label: 'Android' },
            { value: 'zebra', label: 'Android (Zebra)' },
            { value: 'ios', label: 'iOS' },
            { value: 'web', label: 'Web' },
          ]}
          device={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setError(''); setNotice(''); void load(); }}
        />
      )}

      {clearPreview !== null && (
        <ClearOfflineKiosksModal
          kiosks={clearPreview.matches} totalMatched={clearPreview.total} busy={clearBusy}
          onConfirm={() => void confirmClearOffline()}
          onClose={() => { if (!clearBusy) setClearPreview(null); }}
        />
      )}

      {registering && (
        <RegisterDaysModal
          deviceName={registering.name}
          onConfirm={(days) => void doRegister(registering.id, days)}
          onClose={() => setRegistering(null)}
        />
      )}
    </div>
  );
}
