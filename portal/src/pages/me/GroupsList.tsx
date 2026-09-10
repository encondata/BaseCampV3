/**
 * GroupsList — the /me/notifications group lists ("My groups" and "Join a
 * group") in the portal's STANDARD directory-list layout: a heading with a
 * count badge, the dir-toolbar with the filter box and result count, then
 * a dir-list with a list-head and row-main rows using the golden cell
 * classes. Both sections render this one component so they stay
 * symmetrical; only the columns and the row actions differ by `kind`.
 */

import { useMemo, useState, type CSSProperties } from 'react';

import { RowActionsMenu, type RowAction } from '../../components/hardware/RowActionsMenu';
import type { MyNotificationGroup } from '../../lib/api';
import { CHANNEL_LABELS, type Channel } from '../../lib/notifications';
import { daysText, hasOverrides, quietHoursText } from '../../lib/notificationGroups';

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

/** Status cell: the pending request (if any) wins over "Customised". */
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
    return <span className="chip c-aqua">Customised</span>;
  }
  return <span className="cell-sub">—</span>;
}

export type GroupsListKind = 'member' | 'joinable';

// last column holds the "Actions ▾" menu trigger, so it sizes to content
// (the 30px slot other lists use is for a chevron only)
const GRID: Record<GroupsListKind, CSSProperties> = {
  member: { gridTemplateColumns: 'minmax(220px, 2fr) minmax(160px, 1.2fr) minmax(200px, 1.2fr) minmax(90px, 0.7fr) minmax(130px, 0.9fr) max-content' },
  joinable: { gridTemplateColumns: 'minmax(220px, 2fr) minmax(220px, 1.4fr) minmax(100px, 0.7fr) minmax(130px, 0.9fr) max-content' },
};

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
  const grid = GRID[kind];

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

      <div className="dir-list">
        <div className="list-head" style={grid}>
          <span className="col-head">Group</span>
          <span className="col-head">Channels</span>
          {kind === 'member' && <span className="col-head">Quiet hours</span>}
          {kind === 'member' && <span className="col-head">Days</span>}
          {kind === 'joinable' && <span className="col-head">Members</span>}
          <span className="col-head">Status</span>
          <span className="col-head" style={{ justifySelf: 'end' }}>Actions</span>
        </div>

        {loaded && visible.length === 0 && (
          <div className="dir-empty">{query ? 'No groups match that filter.' : emptyCopy}</div>
        )}

        {visible.map((g) => (
          <div className="dir-row" key={g.id}>
            <div className="row-main" style={grid}>
              <div className="cell cell-primary">
                <div className="pn"><b>{g.name}</b><span>{g.description || '—'}</span></div>
              </div>
              <div className="cell"><ChannelChips channels={g.channels} /></div>
              {kind === 'member' && <div className="cell mono">{quietHoursText(g)}</div>}
              {kind === 'member' && <div className="cell cell-top">{daysText(g.active_days)}</div>}
              {kind === 'joinable' && (
                <div className="cell mono">{g.member_count} member{g.member_count === 1 ? '' : 's'}</div>
              )}
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
