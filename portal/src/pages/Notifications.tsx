/**
 * Notifications — the directory list of notification groups (who gets
 * notified, how, and when). Directory pattern, modeled on
 * pages/AssetModels.tsx: dir-head/dir-toolbar/dir-list, VirtualRows,
 * ColumnMenu per-column filters, usePersistentListState, toolbar
 * FilterButton facets (Status, Channels, Categories), CSV export.
 *
 * Row click navigates straight to the group's detail page — no inline
 * expansion (the detail view, with membership management, is Tasks 4-5).
 * "+ New group" opens a create-only modal (model:
 * components/access/GroupsTab.tsx's CreateGroupModal) that hands off to
 * that detail page on success.
 *
 * Super admins and above (global access and rank 80+, the API's own gate)
 * also get a `.subs-tabs` strip (pages/Access.tsx): Groups, the list above
 * with its pending requests, and Delivery log (DeliveryLogTab), kept in
 * ?tab=log. Everyone else sees the groups with no strip, whatever the URL
 * says. The header's hint and count follow the tab.
 */

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import DataTable, { type DataTableColumn, type DataTableRow } from '../components/DataTable';
import { RowActionsMenu } from '../components/hardware/RowActionsMenu';
import CategoryChips, { NO_CATEGORIES } from '../components/notifications/CategoryChips';
import ChannelChips, { NO_EMAIL } from '../components/notifications/ChannelChips';
import DeliveryLogTab from '../components/notifications/DeliveryLogTab';
import NotificationModal from '../components/notifications/NotificationModal';
import { SUPER_ADMIN_RANK } from '../lib/access';
import {
  ApiError, approveMembershipRequest, createNotificationGroup, listMembershipRequests,
  listNotificationGroups, rejectMembershipRequest,
  type MembershipRequest, type NotificationGroup,
} from '../lib/api';
import {
  ColumnMenu, EmptyClearFilters, FilterSummaryChip, passesColumnFilters,
  usePersistentListState, type CellText,
} from '../lib/columnMenu';
import { DELIVERY_LOG_HINT } from '../lib/deliveryLog';
import { relativeTime } from '../lib/format';
import {
  ColHead, ColumnsButton, ExportButton, FilterButton, applyColumnOrder, exportCsv,
  listGridStyle, listScale, moveKey, passesFacets, titleFor, useReorderDrag, useSearchHaystacks,
  visibleColumnsFor, type ColumnDef, type FacetGroup, type FacetState,
} from '../lib/listTools';
import { GROUP_ERRORS } from '../lib/notificationGroups';
import { NOTIFICATION_CATEGORIES, categoryLabels } from '../lib/notificationKinds';
import {
  CHANNEL_LABELS, LIVE_CHANNELS, formatDays, formatQuietHours, liveChannels,
} from '../lib/notifications';
import { naturalCompare } from '../lib/sites';
import { VirtualRows } from '../lib/virtualRows';
import '../styles/access.css';   /* .subs-tabs — the page-local tab strip */
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';

type Tab = 'groups' | 'log';

const TABS: { key: Tab; label: string }[] = [
  { key: 'groups', label: 'Groups' },
  { key: 'log', label: 'Delivery log' },
];

const GROUPS_HINT = 'Notification groups — who gets notified, how, and when.';

/** Copy for request-decision error codes — same mapping as the popover's
 *  strip (NotificationsPanel.tsx), plus the one code unique to a second
 *  click on an already-decided request. */
const REQUEST_ERRORS: Record<string, string> = {
  ...GROUP_ERRORS,
  already_decided: 'That request was already decided.',
};

const requestErrorMsg = (err: unknown): string =>
  err instanceof ApiError ? (REQUEST_ERRORS[err.code] ?? `Request failed (${err.code}).`) : 'Network error — try again.';

/* Most tracks carry an explicit `min` — the px floor keeps the header
 * label and the column's real content (chips, the nowrap quiet-hours
 * string, the status chip) from colliding with its neighbor at narrow
 * viewports (~1024px), the plain `fr` width keeps the original relative
 * growth once there's slack; see notif-polish1-brief.md fix 6.
 * listGridStyle (lib/listTools.tsx, spec 2026-09-23-list-column-floors)
 * now owns turning `min` into the track's `minmax(floor, fr)` — these
 * used to be literal `minmax()` strings in `width` itself; the numbers
 * are unchanged, just moved onto `min`. Members/Days/Status/Created carry
 * short, low-variance content (a count, a day summary, a two-word chip, a
 * locale date) that gains nothing from growing, so those four stay plain
 * fixed px instead — this is what keeps the floors + gaps inside the fit
 * below (polish pass 2, fix 3). Categories chips wrap onto extra lines and
 * a long label ellipsizes at the floor (.cell .chip, directory.css);
 * Channels now holds one short chip (Email / No email), so it carries only
 * the floor its header derives. Description is clamped to 2 lines and
 * shrinks furthest, Quiet hours stays a nowrap ellipsis at its ~150px floor.
 *
 * Fit: default columns + trailing ≤ LIST_FIT.page
 * (1172px — .portal-page at a 1512px window, nav expanded). */
const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Name', width: '1.3fr', default: true, min: 110 },
  // 'Desc' isn't wordy enough on its own to need a short label (11 chars,
  // under the ~12 rule of thumb) — it's here so the *derived* floor for
  // the full "Description" label (~112px) doesn't outgrow the deliberately
  // tight 75px tuned floor above; see columnFloor (lib/listTools.tsx).
  {
    key: 'description', label: 'Description', short: 'Desc',
    width: '2fr', default: true, min: 75,
  },
  { key: 'members', label: 'Members', width: '60px', default: true },
  { key: 'categories', label: 'Categories', width: '1.6fr', default: true, min: 140 },
  { key: 'channels', label: 'Channels', width: '1fr', default: true },
  { key: 'quiet_hours', label: 'Quiet hours', width: '1.2fr', default: true, min: 144 },
  { key: 'days', label: 'Days', width: '70px', default: true },
  { key: 'status', label: 'Status', width: '90px', default: true },
  { key: 'created', label: 'Created', width: '85px', default: true },
];

const ALL_COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key));
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

const formatCreated = (iso: string): string => new Date(iso).toLocaleDateString();

/** Labels of the channels that can send — the only ones the Channels cell,
 *  filter, search and export ever show (stored text/push/web stay hidden). */
const channelLabels = (g: NotificationGroup): string[] =>
  liveChannels(g.channels).map((c) => CHANNEL_LABELS[c]);

/** Column-menu / search accessor — mirrors cellFor's display text exactly. */
const groupCellText: CellText<NotificationGroup> = (g, colKey) => {
  switch (colKey) {
    case 'name': return g.name;
    case 'description': return g.description;
    case 'members': return String(g.member_count);
    case 'categories': return categoryLabels(g.categories).join(', ') || NO_CATEGORIES;
    case 'channels': return channelLabels(g).join(', ') || NO_EMAIL;
    case 'quiet_hours': return formatQuietHours(g.quiet_start, g.quiet_end, g.timezone);
    case 'days': return formatDays(g.active_days);
    case 'status': return g.enabled ? 'Enabled' : 'Paused';
    case 'created': return formatCreated(g.created_at);
    default: return '';
  }
};

// The empty-state words ("No email", "None — inbox only") are left out of the
// search text on purpose: "email" must find the groups that email, not also
// every group that says it does not.
const groupSearchText = (g: NotificationGroup): string => [
  g.name, g.description, channelLabels(g).join(' '), categoryLabels(g.categories).join(' '),
  formatDays(g.active_days), g.enabled ? 'enabled' : 'paused', g.timezone,
].join(' ').toLowerCase();

function sortValueFor(g: NotificationGroup, key: string): string {
  switch (key) {
    case 'name': return g.name.toLowerCase();
    case 'description': return g.description.toLowerCase();
    case 'members': return String(g.member_count);
    case 'categories': return categoryLabels(g.categories).join(', ').toLowerCase();
    case 'channels': return channelLabels(g).join(', ').toLowerCase();
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
  ['Categories', (g) => categoryLabels(g.categories).join('; ') || 'None'],
  ['Channels', (g) => channelLabels(g).join('; ') || NO_EMAIL],
  ['Quiet hours', (g) => formatQuietHours(g.quiet_start, g.quiet_end, g.timezone)],
  ['Timezone', (g) => g.timezone],
  ['Days', (g) => formatDays(g.active_days)],
  ['Status', (g) => (g.enabled ? 'Enabled' : 'Paused')],
  ['Created', (g) => g.created_at],
];

const ERRORS: Record<string, string> = {
  group_exists: 'A group with that name already exists.',
};

const REQUEST_COLUMNS: DataTableColumn[] = [
  { key: 'person', label: 'Person' },
  { key: 'wants', label: 'Wants to' },
  { key: 'group', label: 'Group' },
  { key: 'note', label: 'Note' },
  { key: 'requested', label: 'Requested', mono: true },
  // 88px is the "Actions ▾" trigger's track everywhere else on the branch.
  // `.data-table` is table-layout: auto (directory.css:585), so this is a
  // preferred width, not a cap: the rejecting row — which swaps the cell for
  // a reason input plus Confirm reject / Cancel — still forces the column
  // out to its own content width. One constant covers both states.
  { key: 'actions', label: 'Actions', width: '88px' },
];

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

export default function Notifications() {
  const { can, preferences, maxRank, scope } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const canAdd = can('notifications', 'add');
  const canChange = can('notifications', 'change');
  const navigate = useNavigate();

  // The Delivery log's gate mirrors the API's (ensure_super_admin): global
  // access and super admin rank or above.
  const superAdmin = maxRank >= SUPER_ADMIN_RANK && !!scope?.global;
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = superAdmin && searchParams.get('tab') === 'log' ? 'log' : 'groups';
  const [logCount, setLogCount] = useState<number | null>(null);
  const selectTab = (next: Tab) => {
    if (next === tab) return;
    setLogCount(null);
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'groups') p.delete('tab'); else p.set('tab', next);
      return p;
    }, { replace: true });
  };

  const [groups, setGroups] = useState<NotificationGroup[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<FacetState>({});
  const [creating, setCreating] = useState(false);

  const [pendingRequests, setPendingRequests] = useState<MembershipRequest[]>([]);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [requestError, setRequestError] = useState('');

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

  const loadRequests = async () => {
    try {
      setPendingRequests(await listMembershipRequests('pending'));
    } catch {
      /* the panel just stays empty on a transient failure — the groups
         list above already surfaces the page-level error banner. */
    }
  };

  useEffect(() => { if (canChange) void loadRequests(); }, [canChange]);

  const approveRequestRow = async (id: string) => {
    setBusyRequestId(id);
    setRequestError('');
    try {
      await approveMembershipRequest(id);
      await loadRequests();
    } catch (err) {
      setRequestError(requestErrorMsg(err));
    } finally {
      setBusyRequestId(null);
    }
  };

  const confirmRejectRequestRow = async (id: string) => {
    setBusyRequestId(id);
    setRequestError('');
    try {
      await rejectMembershipRequest(id, rejectNote.trim());
      setRejectingId(null);
      setRejectNote('');
      await loadRequests();
    } catch (err) {
      setRequestError(requestErrorMsg(err));
    } finally {
      setBusyRequestId(null);
    }
  };

  const facetGroups = useMemo<FacetGroup[]>(() => [
    { key: 'status', title: 'Status', options: [
      { value: 'enabled', label: 'Enabled' },
      { value: 'paused', label: 'Paused' },
    ] },
    { key: 'channels', title: 'Channels', options: [
      ...LIVE_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
      { value: 'none', label: NO_EMAIL },
    ] },
    { key: 'categories', title: 'Categories', options: [
      ...NOTIFICATION_CATEGORIES.map((c) => ({ value: c.key, label: c.label })),
      { value: 'none', label: 'None' },
    ] },
  ], []);

  const facetValues = (g: NotificationGroup) => (groupKey: string): string[] => {
    if (groupKey === 'status') return [g.enabled ? 'enabled' : 'paused'];
    if (groupKey === 'channels') {
      const live = liveChannels(g.channels);
      return live.length ? live : ['none'];
    }
    if (groupKey === 'categories') {
      // Registry keys only, like the chips — an unknown stored key is not a category here.
      const keys = NOTIFICATION_CATEGORIES.filter((c) => g.categories.includes(c.key)).map((c) => c.key);
      return keys.length ? keys : ['none'];
    }
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

  const orderedCols = applyColumnOrder(COLUMNS, colOrder);
  const shownCols = visibleColumnsFor(orderedCols, visibleCols, false);
  const headerDrag = useReorderDrag(
    (src, dst, before) => setColOrder(moveKey(orderedCols.map((c) => c.key), src, dst, before)),
    'x', { ignoreFrom: '.pop-menu' },
  );
  const grid = listGridStyle(shownCols, ['30px'], undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  const cellFor = (g: NotificationGroup, key: string) => {
    switch (key) {
      case 'name':
        return <span className="cell-top cell-line" title={titleFor(g.name)}><b>{g.name}</b></span>;
      case 'description':
        return <span className="cell-sub cell-clamp2">{g.description || '—'}</span>;
      case 'members':
        return <span className="mono cell-line" style={{ display: 'block', textAlign: 'right' }}>{g.member_count}</span>;
      case 'categories':
        return <CategoryChips categories={g.categories} />;
      case 'channels':
        return <ChannelChips channels={g.channels} />;
      case 'quiet_hours': {
        const text = formatQuietHours(g.quiet_start, g.quiet_end, g.timezone);
        return <span className="mono cell-nowrap cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'days': {
        const text = formatDays(g.active_days);
        return <span className="cell-top cell-line" title={titleFor(text)}>{text}</span>;
      }
      case 'status':
        return (
          <span className={`chip ${g.enabled ? 'c-green' : 'tag'}`}>
            {g.enabled ? 'Enabled' : 'Paused'}
          </span>
        );
      case 'created': {
        const text = formatCreated(g.created_at);
        return <span className="mono cell-line" title={titleFor(text)}>{text}</span>;
      }
      default:
        return null;
    }
  };

  const requestRows: DataTableRow[] = pendingRequests.map((r) => ({
    key: r.id,
    cells: [
      <span className="cell-top" key="person"><b>{r.person_name}</b></span>,
      <span className="chip tag" key="wants">{r.action === 'join' ? 'Join' : 'Leave'}</span>,
      <span className="cell-sub" key="group">{r.group_name}</span>,
      <span className="cell-sub" key="note">{r.note || '—'}</span>,
      relativeTime(r.created_at),
      rejectingId === r.id ? (
        <span key="actions" className="pf-form" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input placeholder="Reason (optional)" value={rejectNote} disabled={busyRequestId === r.id}
                 onChange={(e) => setRejectNote(e.target.value)} />
          <button type="button" className="mini-btn sm" disabled={busyRequestId === r.id}
                  onClick={() => void confirmRejectRequestRow(r.id)}>
            Confirm reject
          </button>
          <button type="button" className="mini-btn sm" disabled={busyRequestId === r.id}
                  onClick={() => { setRejectingId(null); setRejectNote(''); }}>
            Cancel
          </button>
        </span>
      ) : (
        // Reject only *enters* the reject flow — the row then swaps to the
        // reason input above, which keeps its own Confirm reject / Cancel
        // buttons rather than a menu.
        <span key="actions" style={{ display: 'flex' }}>
          <RowActionsMenu actions={[
            {
              key: 'approve',
              label: 'Approve',
              onSelect: () => void approveRequestRow(r.id),
              disabled: busyRequestId === r.id,
            },
            {
              key: 'reject',
              label: 'Reject',
              destructive: true,
              onSelect: () => { setRejectingId(r.id); setRejectNote(''); setRequestError(''); },
              disabled: busyRequestId === r.id,
            },
          ]} />
        </span>
      ),
    ],
  }));

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">System</div>
          <h1 className="page-title">
            Notifications
            <span className="badge-count">{(tab === 'log' ? logCount : groups?.length) ?? '…'}</span>
          </h1>
          <p className="page-hint">{tab === 'log' ? DELIVERY_LOG_HINT : GROUPS_HINT}</p>
        </div>
      </div>

      {superAdmin && (
        <div className="subs-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                    className={tab === t.key ? 'on' : ''}
                    onClick={() => selectTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === 'log' && <DeliveryLogTab onCount={setLogCount} />}

      {tab === 'groups' && canChange && pendingRequests.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h3>Pending requests</h3>
          </div>
          <div className="panel-body">
            {requestError && <div className="pf-error" style={{ marginBottom: 10 }}>{requestError}</div>}
            <DataTable ariaLabel="Pending membership requests" columns={REQUEST_COLUMNS} rows={requestRows} />
          </div>
        </div>
      )}

      {tab === 'groups' && (
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
      )}

      {tab === 'groups' && error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}><b>Cannot load notification groups</b>{error}</div>
      )}

      {tab === 'groups' && !error && (
        <div className="dir-list list-scroll">
          <div className="list-head" style={rowStyle}>
            {shownCols.map((c) => (
              <ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
                       onToggleSort={() => toggleSort(c.key)}
                       className={headerDrag.dropClass(c.key)}
                       dragProps={headerDrag.dragProps(c.key)}>
                <ColumnMenu colKey={c.key} label={c.label}
                            allRows={groups ?? []} filters={filters}
                            text={groupCellText}
                            filter={filters[c.key]} onFilter={setFilter}
                            sortDir={sortKey === c.key ? sortDir : null}
                            onSort={(dir) => setSort(c.key, dir)} />
              </ColHead>
            ))}
            <span className="col-head" aria-hidden="true" />
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
              <div key={g.id} className="dir-row" {...vp}
                   style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
                <div className="row-main" style={rowStyle} onClick={() => navigate(`/system/notifications/${g.id}`)}>
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
 * Model: components/access/GroupsTab.tsx's CreateGroupModal — the same
 * ERRORS/msgFor pattern, in the shared NotificationModal shell (standard
 * header; the Create button sits in the footer and submits the form by id, so
 * Enter in a field still creates). Create-only (no edit here); settings
 * beyond name/description are configured on the detail page. */

function NewGroupModal({ onClose, onDone }: {
  onClose: () => void; onDone: (id: string) => void;
}) {
  const formId = useId();
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
    <NotificationModal
      eyebrow="Notifications" title="New notification group"
      description="Name the group. Delivery settings and members come next."
      onClose={onClose} busy={saving}
      footer={(
        <>
          <button className="btn-solid" type="submit" form={formId} disabled={saving}>
            {saving ? 'Creating…' : 'Create group'}
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <form id={formId} onSubmit={submit}>
        <div className="pf-form">
          <div className="full">
            <label htmlFor="new-group-name">Name *</label>
            <input id="new-group-name" value={name} required disabled={saving}
                   onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="full">
            <label htmlFor="new-group-description">Description</label>
            <input id="new-group-description" value={description} disabled={saving}
                   onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
      </form>
    </NotificationModal>
  );
}
