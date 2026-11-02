/**
 * GroupsList — the /me/notifications group lists ("My groups" and "Join a
 * group") in the portal's STANDARD directory-list layout: a heading with a
 * count badge, the dir-toolbar with the filter box and result count, then
 * a dir-list with a list-head and row-main rows using the golden cell
 * classes. Both sections render this one component so they stay
 * symmetrical; only the row actions differ by `kind`.
 *
 * A group is a name, a description and its members: it no longer decides what
 * a person gets, so the columns are Group, Members and Status (a waiting join
 * or leave request), and a member has nothing of their own to edit per group.
 */

import { useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { RowActionsMenu, type RowAction } from '../../components/hardware/RowActionsMenu';
import type { MyNotificationGroup } from '../../lib/api';
import { ColHead, listGridStyle, listScale, type ColumnDef } from '../../lib/listTools';

/** Status cell: the request waiting on an admin, or nothing. */
function StatusChip({ group }: { group: MyNotificationGroup }) {
  const pending = group.pending_request;
  if (pending) {
    return (
      <span className="chip c-amber">
        <span className="dot" />{pending.action === 'leave' ? 'Leave requested' : 'Join requested'}
      </span>
    );
  }
  return <span className="cell-sub">—</span>;
}

export type GroupsListKind = 'member' | 'joinable';

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1). ONE grid for both lists so the
// stacked sections align column-for-column; the trailing 88px track is a
// fixed RowActionsMenu trigger width, which counts toward the row minimum.
// Fit: default columns + trailing ≤ LIST_FIT.page (1172px — .portal-page at a
// 1512px window, nav expanded — GroupsList sits directly in .portal-page
// under /me/notifications).
const COLUMNS: ColumnDef[] = [
  { key: 'group', label: 'Group', width: '3fr', default: true, min: 200 },
  // Holds a count: the header's own floor is enough.
  { key: 'members', label: 'Members', width: '0.7fr', default: true },
  // 140px holds the longest chip, "Leave requested" (measured 129px at the
  // default list size; the floor scales with the list size preference).
  { key: 'status', label: 'Status', width: '1fr', default: true, min: 140 },
];
const TRAILING = ['88px'];

export default function GroupsList({
  kind, title, hint, groups, loaded, busyRequestIds, onRequest, onCancel,
}: {
  kind: GroupsListKind;
  title: string;
  hint: string;
  groups: MyNotificationGroup[];
  loaded: boolean;
  busyRequestIds: Record<string, boolean>;
  onRequest: (g: MyNotificationGroup, action: 'join' | 'leave') => void;
  onCancel: (requestId: string) => void;
}) {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((g) =>
      g.name.toLowerCase().includes(needle) || g.description.toLowerCase().includes(needle));
  }, [groups, query]);

  const actionsFor = (g: MyNotificationGroup): RowAction[] => {
    const pending = g.pending_request;
    if (pending) {
      return [{
        key: 'cancel',
        label: busyRequestIds[pending.id] ? 'Canceling…' : 'Cancel request',
        onSelect: () => { if (!busyRequestIds[pending.id]) onCancel(pending.id); },
      }];
    }
    return kind === 'member'
      ? [{ key: 'leave', label: 'Leave group', destructive: true, onSelect: () => onRequest(g, 'leave') }]
      : [{ key: 'join', label: 'Ask to join', onSelect: () => onRequest(g, 'join') }];
  };

  const emptyCopy = kind === 'member'
    ? "You're not in any notification groups yet."
    : 'No other groups to join.';
  const grid = listGridStyle(COLUMNS, TRAILING, undefined, listGridScale);
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  return (
    <section className="me-groups" aria-label={title}>
      <div className="dir-head">
        <div>
          <h3 className="me-groups-title">
            {title} <span className="badge-count">{groups.length}</span>
          </h3>
          <p className="page-hint">{hint}</p>
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
          <span className="result-count">{visible.length} of {groups.length} shown</span>
        </div>
      </div>

      <div className="dir-list list-scroll">
        <div className="list-head" style={rowStyle}>
          {COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
          <span className="col-head" style={{ justifySelf: 'end' }}>Actions</span>
        </div>

        {loaded && visible.length === 0 && (
          <div className="dir-empty">{query ? 'No groups match that filter.' : emptyCopy}</div>
        )}

        {visible.map((g) => (
          <div className="dir-row" key={g.id} style={{ minWidth: rowStyle.minWidth }}>
            <div className="row-main" style={rowStyle}>
              <div className="cell cell-primary">
                <div className="pn"><b>{g.name}</b><span>{g.description || '—'}</span></div>
              </div>
              <div className="cell mono cell-line">{g.member_count}</div>
              <div className="cell"><StatusChip group={g} /></div>
              <div className="cell row-actions-cell" style={{ justifySelf: 'end' }} onClick={(e) => e.stopPropagation()}>
                <RowActionsMenu actions={actionsFor(g)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
