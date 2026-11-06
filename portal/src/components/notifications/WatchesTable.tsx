/**
 * WatchesTable — watches as a DataTable: /me › "What you watch" (a person's own
 * and their groups') and a group's "What this group watches".
 *
 *  - Watching: a thing's name, linked to its page, with its kind as a chip; or
 *    "Everything". The chip says what the API labels the row ("Wiki folder"), else
 *    the portal's own label for its kind of thing. A portal thing's link is a path,
 *    through the router; a wiki thing's is the absolute URL of its page in the wiki,
 *    a plain link that leaves the portal in the same tab (as the Delivery log's
 *    "Open notification link" does for the wiki's notices).
 *  - Events: "All events", or the chosen events' labels.
 *  - Via (when `showVia`): "You", or the name of the group whose watch it is.
 *  - Actions: a RowActionsMenu with the actions `actionsFor` gives the row. The
 *    column is there only when some row has actions, so a list nobody may change
 *    has no empty column (as the group page's Members table).
 *
 * /me also gives it the person's asset watches (`assetWatches`, with their own
 * `assetActionsFor`), which are rows of the same table after the others, in the order
 * given. An asset watch is not a `Watch`: it names no events and ends once it has
 * fired, so its row reads differently. Watching is the asset's name, linked to where
 * the watch was set, then "on {initiative}" for a watch set on one, and an Asset chip;
 * Events is what it waits for ("Next update", or "Status becomes {label}", never
 * "All events"); Via is "You", since a group can't hold one. The group page passes
 * none, so its table is as it was.
 *
 * `div.watch-table` scopes the table's themed scrollbar (notifications.css). The
 * table renders no Since column: DataTable has no column menu to switch it on.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { AssetWatch, NotificationKindSetting, Watch } from '../../lib/api';
import { resolveInboxLink } from '../../lib/inboxLinks';
import { ASSET_THING_LABEL, THING_LABELS, assetWatchEventsText, eventsText } from '../../lib/watches';
import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';
import { RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import '../../styles/directory.css';       // .data-table, .chip, .cell-top, .cell-sub
import '../../styles/notifications.css';   // .watch-table, .watch-thing, .watch-actions

/** A thing's name, linked to its page when it has one, by the rule the inbox opens
 *  links by (lib/inboxLinks): through the router for a path in the portal, as a plain
 *  link (same tab) for another app's absolute URL, and to the portal's home page for
 *  anything else (another scheme, "//host"). */
function ThingName({ name, link }: { name: string; link: string | null }) {
  if (!link) return <b className="cell-top">{name}</b>;
  const target = resolveInboxLink(link);
  return target.kind === 'app'
    ? <Link className="cell-top" to={target.to}>{name}</Link>
    : <a className="cell-top" href={target.href}>{name}</a>;
}

/** The Watching cell. The kind's chip is the neutral `tag` one, as a category's is
 *  in the Delivery log and the critical list. */
function Watching({ watch }: { watch: Watch }) {
  if (watch.thing === 'everything') return <b className="cell-top">{THING_LABELS.everything}</b>;
  return (
    <div className="watch-thing">
      <ThingName name={watch.thing_name ?? '—'} link={watch.link} />
      <span className="chip tag">{watch.thing_label ?? THING_LABELS[watch.thing]}</span>
    </div>
  );
}

/** The Watching cell of an asset watch: the asset's name, linked to where the watch was set,
 *  "on {initiative}" for a watch set on one (secondary text, outside the link), and the Asset
 *  chip. */
function AssetWatching({ watch }: { watch: AssetWatch }) {
  return (
    <div className="watch-thing">
      <ThingName name={watch.asset_name} link={watch.link} />
      {watch.initiative_name && <span className="cell-sub">on {watch.initiative_name}</span>}
      <span className="chip tag">{ASSET_THING_LABEL}</span>
    </div>
  );
}

export default function WatchesTable({
  watches, kinds, showVia, actionsFor, emptyText, assetWatches = [], assetActionsFor = () => [],
}: {
  watches: Watch[];
  /** Every registered kind, to name each watch's events. */
  kinds: NotificationKindSetting[];
  showVia: boolean;
  actionsFor: (watch: Watch) => RowAction[];
  emptyText: string;
  /** The person's asset watches, listed after `watches`. Only /me has any. */
  assetWatches?: AssetWatch[];
  /** The actions of an asset watch's row; none by default. */
  assetActionsFor?: (watch: AssetWatch) => RowAction[];
}) {
  const actions = watches.map(actionsFor);
  const assetActions = assetWatches.map(assetActionsFor);
  const hasActions = [...actions, ...assetActions].some((list) => list.length > 0);

  const columns: DataTableColumn[] = [
    { key: 'watching', label: 'Watching' },
    { key: 'events', label: 'Events' },
    ...(showVia ? [{ key: 'via', label: 'Via' }] : []),
    // 88px: the width the other converted lists give a single RowActionsMenu trigger.
    ...(hasActions ? [{ key: 'actions', label: 'Actions', width: '88px' }] : []),
  ];

  /** One row's cells, in the columns above: the Via and Actions cells only where the table has
   *  the column, and an empty Actions cell for a row with no actions. */
  const cellsOf = (
    watching: ReactNode, events: string, via: string, rowActions: RowAction[],
  ): ReactNode[] => [
    watching,
    events,
    ...(showVia ? [via] : []),
    ...(hasActions ? [
      rowActions.length > 0
        ? <div className="watch-actions"><RowActionsMenu actions={rowActions} /></div>
        : null,
    ] : []),
  ];

  const rows: DataTableRow[] = [
    ...watches.map((watch, i) => ({
      key: watch.id,
      cells: cellsOf(
        <Watching watch={watch} />,
        eventsText(watch.kinds, kinds),
        watch.via.type === 'group' ? (watch.via.name ?? '—') : 'You',
        actions[i],
      ),
    })),
    // The asset watches' ids are another table's: the key says which, so a row of each can't clash.
    ...assetWatches.map((watch, i) => ({
      key: `asset:${watch.id}`,
      cells: cellsOf(<AssetWatching watch={watch} />, assetWatchEventsText(watch), 'You', assetActions[i]),
    })),
  ];

  return (
    <div className="watch-table">
      <DataTable ariaLabel="Watches" columns={columns} rows={rows} emptyText={emptyText} />
    </div>
  );
}
