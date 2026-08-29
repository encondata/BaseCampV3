/**
 * Notifications — the directory list of notification groups (who gets
 * notified, how, and when). Directory pattern, modeled on
 * pages/AssetModels.tsx: dir-head/dir-toolbar/dir-list, VirtualRows,
 * ColumnMenu per-column filters, usePersistentListState, toolbar
 * FilterButton facets (Status, Channels), CSV export.
 *
 * Row click navigates straight to the group's detail page — no inline
 * expansion (the detail view, with membership management, is Tasks 4-5).
 * "+ New group" opens a create-only modal (model:
 * components/access/GroupsTab.tsx's CreateGroupModal) that hands off to
 * that detail page on success.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import {
  ApiError, createNotificationGroup, listNotificationGroups,
  type NotificationGroup,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import {
  ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  moveKey, passesFacets, useReorderDrag, useSearchHaystacks, visibleColumnsFor,
  type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import {
  CHANNEL_LABELS, CHANNELS, formatDays, formatQuietHours, type Channel,
} from '../lib/notifications';
import { naturalCompare } from '../lib/sites';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';

/* Each width is a minmax(<px>, <fr>) — the px floor keeps the header
 * label and the column's real content (chips, the nowrap quiet-hours
 * string, the status chip) from colliding with its neighbor at narrow
 * viewports (~1024px), the fr keeps the original relative growth once
 * there's slack; see notif-polish1-brief.md fix 6. */
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: 'minmax(130px, 1.5fr)', default: true },
  { key: 'description', label: 'Description', width: 'minmax(160px, 2fr)', default: true },
  { key: 'members', label: 'Members', width: 'minmax(70px, 0.7fr)', default: true },
  { key: 'channels', label: 'Channels', width: 'minmax(160px, 1.8fr)', default: true },
  { key: 'quiet_hours', label: 'Quiet hours', width: 'minmax(170px, 1.8fr)', default: true },
  { key: 'days', label: 'Days', width: 'minmax(90px, 1fr)', default: true },
  { key: 'status', label: 'Status', width: 'minmax(100px, 0.8fr)', default: true },
  { key: 'created', label: 'Created', width: 'minmax(100px, 1fr)', default: true },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

const channelLabel = (c: string): string => CHANNEL_LABELS[c as Channel] ?? c;
const formatCreated = (iso: string): string => new Date(iso).toLocaleDateString();

/** Column-menu / search accessor — mirrors cellFor's display text exactly. */
const groupCellText: CellText<NotificationGroup> = (g, colKey) => {
  switch (colKey) {
    case 'name': return g.name;
    case 'description': return g.description;
    case 'members': return String(g.member_count);
    case 'channels': return g.channels.map(channelLabel).join(', ');
    case 'quiet_hours': return formatQuietHours(g.quiet_start, g.quiet_end, g.timezone);
    case 'days': return formatDays(g.active_days);
    case 'status': return g.enabled ? 'Enabled' : 'Paused';
    case 'created': return formatCreated(g.created_at);
    default: return '';
  }
};

const groupSearchText = (g: NotificationGroup): string => [
  g.name, g.description, g.channels.map(channelLabel).join(' '),
  formatDays(g.active_days), g.enabled ? 'enabled' : 'paused', g.timezone,
].join(' ').toLowerCase();

function sortValueFor(g: NotificationGroup, key: string): string {
  switch (key) {
    case 'name': return g.name.toLowerCase();
    case 'description': return g.description.toLowerCase();
    case 'members': return String(g.member_count);
    case 'channels': return g.channels.map(channelLabel).join(', ').toLowerCase();
    case 'quiet_hours': return formatQuietHours(g.quiet_start, g.quiet_end, g.timezone).toLowerCase();
    case 'days': return formatDays(g.active_days).toLowerCase();
    case 'status': return g.enabled ? 'enabled' : 'paused';
    case 'created': return g.created_at;
    default: return '';
  }
}

const CSV_COLUMNS: [string, (g: NotificationGroup) => string][] = [
  ['ID', (g) => g.id],
  ['Name', (g) => g.name],
  ['Description', (g) => g.description],
  ['Members', (g) => String(g.member_count)],
  ['Channels', (g) => g.channels.map(channelLabel).join('; ')],
  ['Quiet hours', (g) => formatQuietHours(g.quiet_start, g.quiet_end, g.timezone)],
  ['Timezone', (g) => g.timezone],
  ['Days', (g) => formatDays(g.active_days)],
  ['Status', (g) => (g.enabled ? 'Enabled' : 'Paused')],
  ['Created', (g) => g.created_at],
];

const ERRORS: Record<string, string> = {
  group_exists: 'A group with that name already exists.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

export default function Notifications() {
  const { can } = useAuth();
  const canAdd = can('notifications', 'add');
  const navigate = useNavigate();

  const [groups, setGroups] = useState<NotificationGroup[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [creating, setCreating] = useState(false);

  const {
    visibleCols, setVisibleCols,
    sortKey, sortDir, setSort, toggleSort,
    filters, setFilter, clearFilters,
    colOrder, setColOrder,
  } = usePersistentListState(
    'notification_groups', { visible: DEFAULT_VISIBLE, sortKey: 'name', sortDir: 1 }, ALL_COLUMN_KEYS,
  );

  const load = async () => {
    try {
      setGroups(await listNotificationGroups());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view notification groups.'
        : 'Failed to load notification groups.');
    }
  };

  useEffect(() => { void load(); }, []);

  const facetGroups = useMemo<FacetGroup[]>(() => [
    { key: 'status', title: 'Status', options: [
      { value: 'enabled', label: 'Enabled' },
      { value: 'paused', label: 'Paused' },
    ] },
    { key: 'channels', title: 'Channels', options: CHANNELS.map((c) => (
      { value: c, label: CHANNEL_LABELS[c] }
    )) },
  ], []);

  const facetValues = (g: NotificationGroup) => (groupKey: string): string[] => {
    if (groupKey === 'status') return [g.enabled ? 'enabled' : 'paused'];
    if (groupKey === 'channels') return g.channels;
    return [];
  };

  const haystack = useSearchHaystacks(groups, groupSearchText);

  const visible = useMemo(() => {
    if (!groups) return [];
    const q = query.trim().toLowerCase();
    const rows = groups.filter((g) => {
      if (!passesFacets(facets, facetValues(g))) return false;
      if (!passesColumnFilters(g, filters, groupCellText)) return false;
      if (!q) return true;
      return haystack(g).includes(q);
    });
    return rows.sort((a, b) => naturalCompare(sortValueFor(a, sortKey), sortValueFor(b, sortKey)) * sortDir);
  }, [groups, facets, filters, query, sortKey, sortDir, haystack]);

  const caret = (key: string) =>
    sortKey === key ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = { gridTemplateColumns: `${shownCols.map((c) => c.width).join(' ')} 30px` };

  const cellFor = (g: NotificationGroup, key: string) => {
    switch (key) {
      case 'name':
        return <span className="cell-top"><b>{g.name}</b></span>;
      case 'description':
        return <span className="cell-sub cell-clamp2">{g.description || '—'}</span>;
      case 'members':
        return <span className="mono" style={{ display: 'block', textAlign: 'right' }}>{g.member_count}</span>;
      case 'channels':
        return (
          <div className="chips">
            {g.channels.length
              ? g.channels.map((c) => <span key={c} className="chip tag">{channelLabel(c)}</span>)
              : <span className="chip tag">—</span>}
          </div>
        );
      case 'quiet_hours':
        return <span className="cell-top cell-nowrap">{formatQuietHours(g.quiet_start, g.quiet_end, g.timezone)}</span>;
      case 'days':
        return <span className="cell-top">{formatDays(g.active_days)}</span>;
      case 'status':
        return (
          <span className={`chip ${g.enabled ? 'c-green' : 'tag'}`}>
            {g.enabled ? 'Enabled' : 'Paused'}
          </span>
        );
      case 'created':
        return <span className="cell-sub">{formatCreated(g.created_at)}</span>;
      default:
        return null;
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">System</div>
          <h1 className="page-title">
            Notifications
            <span className="badge-count">{groups?.length ?? '…'}</span>
          </h1>
          <p className="page-hint">
            Notification groups — who gets notified, how, and when.
          </p>
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
          <span className="result-count">{visible.length} of {groups?.length ?? 0} shown</span>
          <FilterButton groups={facetGroups} state={facets} onChange={setFacets} />
          <FilterSummaryChip filters={filters} onClear={clearFilters} />
          <ColumnsButton columns={orderedCols} visible={visibleCols} onChange={setVisibleCols}
                         onReorder={setColOrder} />
          <ExportButton onExport={() => exportCsv('notification-groups', CSV_COLUMNS, visible)} />
          {canAdd && (
            <button className="btn-solid" onClick={() => setCreating(true)}>
              + New group
            </button>
          )}
        </div>
      </div>

      {error && <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load notification groups</b>{error}</div>}

      {!error && (
        <div className="dir-list ngd-notif-grid">
          <div className="list-head" style={grid}>
            {shownCols.map((c) => (
              <span key={c.key} className={`col-head ${headerDrag.dropClass(c.key)}`}
                    {...headerDrag.dragProps(c.key)}>
                <button className="sortable" onClick={() => toggleSort(c.key)}>
                  {c.label} {caret(c.key)}
                </button>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={groups ?? []} filters={filters}
                            text={groupCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </span>
            ))}
            <span />
          </div>

          {groups && visible.length === 0 && (
            groups.length === 0 ? (
              <div className="dir-empty">
                <b>No notification groups yet</b>
                Create a group to define who gets notified and how.
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
            renderRow={(g, vp) => (
              <div key={g.id} className="dir-row" {...vp} style={vp?.style}>
                <div className="row-main" style={grid} onClick={() => navigate(`/system/notifications/${g.id}`)}>
                  {shownCols.map((c) => (
                    <div className="cell" key={c.key}>{cellFor(g, c.key)}</div>
                  ))}
                  <div className="cell chevron-cell">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </div>
                </div>
              </div>
            )} />
        </div>
      )}

      {creating && (
        <NewGroupModal
          onClose={() => setCreating(false)}
          onDone={(id) => { setCreating(false); navigate(`/system/notifications/${id}`); }}
        />
      )}
    </div>
  );
}

/* ── create group modal ─────────────────────────────────────────────
 * Model: components/access/GroupsTab.tsx's CreateGroupModal (lines
 * ~295-353) — same .modal-scrim/.modal-card skeleton and ERRORS/msgFor
 * pattern. Create-only (no edit here); settings beyond name/description
 * are configured on the detail page (Task 4). */

function NewGroupModal({ onClose, onDone }: {
  onClose: () => void; onDone: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const created = await createNotificationGroup({
        name: name.trim(), description: description.trim(),
      });
      onDone(created.id);
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>New notification group</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full"><label>Name *</label>
                <input value={name} required onChange={(e) => setName(e.target.value)} /></div>
              <div className="full"><label>Description</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create group'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
