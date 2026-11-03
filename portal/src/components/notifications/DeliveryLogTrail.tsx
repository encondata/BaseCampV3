/**
 * DeliveryLogTrail — an opened Delivery log row: every entry of the same
 * notification (or, for template mail that mirrors no notification, of the
 * same email) in the order it happened, in a real table (Time, Event, Detail,
 * Process), fetched fresh on each open. A held notification's trail runs
 * inbox → held for the summary → in the summary (or dropped, with the
 * reason). A summary email is template mail, so its trail is found by its
 * outbox id: queued, one "In summary" row for each notification it carries
 * (the Detail names which), then sent. An inbox row that was never written
 * has neither id, so it is its own one-line trail. Under the table: the
 * address the email went to (from its outbox row, never from the log) and
 * links to the person's page and to the notification's own link.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { getDeliveryLogPage, type DeliveryLogEntry } from '../../lib/api';
import { ADDRESS_SOURCE_LABELS, describeEntry, outcomeOf } from '../../lib/deliveryLog';
import { fullDateTime } from '../../lib/format';
import { resolveInboxLink } from '../../lib/inboxLinks';
import DataTable, { type DataTableColumn } from '../DataTable';

const COLUMNS: DataTableColumn[] = [
  { key: 'time', label: 'Time', mono: true },
  { key: 'event', label: 'Event' },
  { key: 'detail', label: 'Detail' },
  { key: 'process', label: 'Process', mono: true },
];

/** Oldest first; entries written in the same instant keep the order they were recorded in. */
const inOrder = (rows: DeliveryLogEntry[]) =>
  [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);

/** "Email to ada@example.com (contact email)", from the trail's outbox row and
 *  the queued entry's address source; null when no email was queued. */
function emailTo(rows: DeliveryLogEntry[]): string | null {
  const address = rows.find((r) => r.to_address)?.to_address;
  if (!address) return null;
  const via = rows.find((r) => r.event === 'email_queued')?.detail?.via;
  const source = typeof via === 'string' ? ADDRESS_SOURCE_LABELS[via] ?? via : null;
  return `Email to ${address}${source ? ` (${source})` : ''}`;
}

/** A trail row's Detail. On a summary email's trail (found by outbox id, not
 *  by notification) each "In summary" row names the notification it carries;
 *  everywhere else that event has nothing to add. */
function detailOf(r: DeliveryLogEntry, summaryTrail: boolean): string {
  if (summaryTrail && r.event === 'email_summarized') return r.notification_title ?? '—';
  return describeEntry(r) || '—';
}

/** The notification's own link: in the portal through the router, another
 *  app's (the wiki's) as a plain link that leaves. */
function NotificationLink({ link }: { link: string }) {
  const target = resolveInboxLink(link);
  return target.kind === 'app'
    ? <Link className="mini-btn" to={target.to}>Open notification link</Link>
    : <a className="mini-btn" href={target.href}>Open notification link</a>;
}

export default function DeliveryLogTrail({ entry }: { entry: DeliveryLogEntry }) {
  const { notification_id: notificationId, outbox_id: outboxId } = entry;
  const lone = !notificationId && !outboxId;
  const [rows, setRows] = useState<DeliveryLogEntry[] | null>(lone ? [entry] : null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!notificationId && !outboxId) return undefined;
    const controller = new AbortController();
    setError('');
    getDeliveryLogPage({
      events: [], channel: null, category: null, since: null,
      ...(notificationId ? { notificationId } : { outboxId: outboxId as string }),
      search: '', cursor: null,
    }, controller.signal)
      .then((page) => setRows(inOrder(page.rows)))
      .catch(() => { if (!controller.signal.aborted) setError("Couldn't load the trail."); });
    return () => controller.abort();
  }, [notificationId, outboxId, attempt]);

  const to = rows ? emailTo(rows) : null;

  return (
    <div className="detail-block dlog-trail">
      <p className="eyebrow-sm">Trail</p>
      {error ? (
        <div className="dlog-trail-foot">
          <span className="pf-error" role="alert">{error}</span>
          <button type="button" className="mini-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      ) : rows === null ? (
        <p className="cell-sub nm-hint" role="status">Loading the trail…</p>
      ) : (
        <DataTable
          ariaLabel="Delivery trail"
          columns={COLUMNS}
          emptyText="Nothing else was logged for it."
          rows={rows.map((r) => {
            const outcome = outcomeOf(r);
            return {
              key: String(r.id),
              cells: [
                fullDateTime(r.at),
                <span key="event" className={`chip ${outcome.chip}`}>{outcome.label}</span>,
                detailOf(r, !notificationId),
                r.process ?? '—',
              ],
            };
          })}
        />
      )}
      {(to || entry.person_id || entry.notification_link) && (
        <div className="dlog-trail-foot">
          {to && <p className="cell-sub nm-hint">{to}</p>}
          <span className="dlog-trail-links">
            {entry.person_id && (
              <Link className="mini-btn" to={`/people/users/${entry.person_id}`}>Open user page</Link>
            )}
            {entry.notification_link && <NotificationLink link={entry.notification_link} />}
          </span>
        </div>
      )}
    </div>
  );
}
