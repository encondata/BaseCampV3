/**
 * GroupsList — the /me/notifications group lists ("My groups" and "Join a
 * group") in the portal's STANDARD directory-list layout: a heading with a
 * count badge, the dir-toolbar with the filter box and result count, then
 * a dir-list with a list-head and row-main rows using the golden cell
 * classes. Both sections render this one component so they stay
 * symmetrical; only the columns and the row actions differ by `kind`.
 */

import { useMemo, useState } from 'react';

import { RowActionsMenu, type RowAction } from '../../components/hardware/RowActionsMenu';
import type { MyNotificationGroup } from '../../lib/api';
import { ColHead, listGridStyle, type ColumnDef } from '../../lib/listTools';
import { CHANNEL_LABELS, type Channel } from '../../lib/notifications';
import { daysText, hasOverrides, quietHoursText } from '../../lib/notificationGroups';

/** No tooltip for a blank cell — "—" repeated as a title on hover reads
 *  as noise, not information. */
const titleFor = (text: string) => (text === '—' ? undefined : text);

const CHANNEL_CHIP: Record<string, string> = {
  email: 'c-blue', web: 'c-green', sms: 'c-amber', text: 'c-amber', push: 'c-violet',
};

function ChannelChips({ channels }: { channels: string[] }) {
  return (
    <div className="chips">
      {channels.length === 0 && <span className="chip c-slate">None</span>}
      {channels.map((c) => (
        <span key={c} className={`chip ${CHANNEL_CHIP[c] ?? 'c-slate'}`}>
          {CHANNEL_LABELS[c as Channel] ?? c}
        </span>
      ))}
    </div>
  );
}

/** Status cell: the pending request (if any) wins over "Customized". */
function StatusChip({ group }: { group: MyNotificationGroup }) {
  const pending = group.pending_request;
  if (pending) {
    return (
      <span className="chip c-amber">
        <span className="dot" />{pending.action === 'leave' ? 'Leave requested' : 'Join requested'}
      </span>
    );
  }
  if (group.is_member && hasOverrides(group.overrides)) {
    return <span className="chip c-aqua">Customized</span>;
  }
  return <span className="cell-sub">—</span>;
}

export type GroupsListKind = 'member' | 'joinable';

// No column registry pre-migration (hand-written header spans) — this
// local COLUMNS mirrors them (recipe R1). ONE grid for both lists so the
// stacked sections align column-for-column; the trailing "max-content"
// track sizes to the "Actions ▾" trigger, same as before.
// Fit: default columns + trailing ≤ 1176px (.portal-page at a 1512px
// window, nav expanded — GroupsList sits directly in .portal-page under
// /me/notifications).
const COLUMNS: ColumnDef[] = [
  { key: 'group', label: 'Group', width: '2fr', default: true, min: 200 },
  { key: 'channels', label: 'Channels', width: '1.3fr', default: true },
  { key: 'quiet_hours', label: 'Quiet hours', width: '1.2fr', default: true },
  { key: 'days', label: 'Days', width: '0.7fr', default: true },
  { key: 'members', label: 'Members', width: '0.6fr', default: true },
  { key: 'status', label: 'Status', width: '0.9fr', default: true },
];
const TRAILING = ['max-content'];

export default function GroupsList({
  kind, title, hint, groups, loaded, busyRequestIds, onEditOverrides, onRequest, onCancel,
}: {
  kind: GroupsListKind;
  title: string;
  hint: string;
  groups: MyNotificationGroup[];
  loaded: boolean;
  busyRequestIds: Record<string, boolean>;
  onEditOverrides?: (g: MyNotificationGroup) => void;
  onRequest: (g: MyNotificationGroup, action: 'join' | 'leave') => void;
  onCancel: (requestId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((g) =>
      g.name.toLowerCase().includes(needle) || g.description.toLowerCase().includes(needle));
  }, [groups, query]);

  const actionsFor = (g: MyNotificationGroup): RowAction[] => {
    const pending = g.pending_request;
    const actions: RowAction[] = [];
    if (kind === 'member' && onEditOverrides) {
      actions.push({ key: 'edit', label: 'Edit overrides', onSelect: () => onEditOverrides(g) });
    }
    if (pending) {
      actions.push({
        key: 'cancel',
        label: busyRequestIds[pending.id] ? 'Cancelling…' : 'Cancel request',
        onSelect: () => { if (!busyRequestIds[pending.id]) onCancel(pending.id); },
      });
    } else if (kind === 'member') {
      actions.push({ key: 'leave', label: 'Leave group', destructive: true,
                     onSelect: () => onRequest(g, 'leave') });
    } else {
      actions.push({ key: 'join', label: 'Ask to join', onSelect: () => onRequest(g, 'join') });
    }
    return actions;
  };

  const emptyCopy = kind === 'member'
    ? "You're not in any notification groups yet."
    : 'No other groups to join.';
  // GroupsList has no useAuth() call today (no other reason to touch
  // AuthContext) — scale is omitted rather than adding that dependency
  // just for list_size; listGridStyle defaults to scale 1.
  const grid = listGridStyle(COLUMNS, TRAILING);
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

        {visible.map((g) => {
          const quietHours = quietHoursText(g);
          const days = daysText(g.active_days);
          return (
            <div className="dir-row" key={g.id} style={{ minWidth: rowStyle.minWidth }}>
              <div className="row-main" style={rowStyle}>
                <div className="cell cell-primary">
                  <div className="pn"><b>{g.name}</b><span>{g.description || '—'}</span></div>
                </div>
                <div className="cell"><ChannelChips channels={g.channels} /></div>
                <div className="cell mono cell-line" title={titleFor(quietHours)}>{quietHours}</div>
                <div className="cell cell-top cell-line" title={titleFor(days)}>{days}</div>
                <div className="cell mono cell-line">{g.member_count}</div>
                <div className="cell"><StatusChip group={g} /></div>
                <div className="cell row-actions-cell" style={{ justifySelf: 'end' }} onClick={(e) => e.stopPropagation()}>
                  <RowActionsMenu actions={actionsFor(g)} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
