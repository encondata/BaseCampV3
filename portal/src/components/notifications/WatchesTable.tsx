/**
 * WatchesTable — watches as a DataTable: /me › "What you watch" (a person's own
 * and their groups') and a group's "What this group watches".
 *
 *  - Watching: a thing's name, linked to its page, with its kind as a chip; or
 *    "Everything".
 *  - Events: "All events", or the chosen events' labels.
 *  - Via (when `showVia`): "You", or the name of the group whose watch it is.
 *  - Actions: a RowActionsMenu with the actions `actionsFor` gives the row. The
 *    column is there only when some row has actions, so a list nobody may change
 *    has no empty column (as the group page's Members table).
 *
 * `div.watch-table` scopes the table's themed scrollbar (notifications.css). The
 * table renders no Since column: DataTable has no column menu to switch it on.
 */

import { Link } from 'react-router-dom';

import type { NotificationKindSetting, Watch } from '../../lib/api';
import { THING_LABELS, eventsText } from '../../lib/watches';
import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';
import { RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import '../../styles/directory.css';       // .data-table, .chip, .cell-top
import '../../styles/notifications.css';   // .watch-table, .watch-thing, .watch-actions

/** The Watching cell. The kind's chip is the neutral `tag` one, as a category's is
 *  in the Delivery log and the critical list. */
function Watching({ watch }: { watch: Watch }) {
  if (watch.thing === 'everything') return <b className="cell-top">{THING_LABELS.everything}</b>;
  const name = watch.thing_name ?? '—';
  return (
    <div className="watch-thing">
      {watch.link
        ? <Link className="cell-top" to={watch.link}>{name}</Link>
        : <b className="cell-top">{name}</b>}
      <span className="chip tag">{THING_LABELS[watch.thing]}</span>
    </div>
  );
}

export default function WatchesTable({ watches, kinds, showVia, actionsFor, emptyText }: {
  watches: Watch[];
  /** Every registered kind, to name each watch's events. */
  kinds: NotificationKindSetting[];
  showVia: boolean;
  actionsFor: (watch: Watch) => RowAction[];
  emptyText: string;
}) {
  const actions = watches.map(actionsFor);
  const hasActions = actions.some((list) => list.length > 0);

  const columns: DataTableColumn[] = [
    { key: 'watching', label: 'Watching' },
    { key: 'events', label: 'Events' },
    ...(showVia ? [{ key: 'via', label: 'Via' }] : []),
    // 88px: the width the other converted lists give a single RowActionsMenu trigger.
    ...(hasActions ? [{ key: 'actions', label: 'Actions', width: '88px' }] : []),
  ];

  const rows: DataTableRow[] = watches.map((watch, i) => ({
    key: watch.id,
    cells: [
      <Watching watch={watch} />,
      eventsText(watch.kinds, kinds),
      ...(showVia ? [watch.via.type === 'group' ? (watch.via.name ?? '—') : 'You'] : []),
      ...(hasActions ? [
        actions[i].length > 0
          ? <div className="watch-actions"><RowActionsMenu actions={actions[i]} /></div>
          : null,
      ] : []),
    ],
  }));

  return (
    <div className="watch-table">
      <DataTable ariaLabel="Watches" columns={columns} rows={rows} emptyText={emptyText} />
    </div>
  );
}
