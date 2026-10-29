/** The signed documents as done-style rows ("Signed Nov 4 · v2 · Acme move",
 *  plus "Updated since" when a newer version is out). Each opens the
 *  document read-only; `from` rides along as router state so the reader's
 *  Back returns to the page that listed it. */
import { Link } from 'react-router-dom';

import { signedDay } from '../lib/format';
import { t } from '../lib/i18n';
import type { HistoryItem } from '../lib/training';

const ICON = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
               strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

function sub(item: HistoryItem): string {
  return [
    t('history.signed', { date: signedDay(item.signed_at), v: item.version_no }),
    item.initiative?.name ?? t('training.general'),
    ...(item.newer_version ? [t('history.updated')] : []),
  ].join(' · ');
}

export default function HistoryList({ items, from }: { items: HistoryItem[]; from?: string }) {
  return (
    <ul className="learn-tasks">
      {items.map((item) => (
        <li key={item.assignment_id} className="learn-task done">
          <Link className="row" to={`/training/${encodeURIComponent(item.assignment_id)}`}
                state={from ? { from } : undefined}>
            <span className="ck" aria-hidden="true"><svg {...ICON}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg></span>
            <span className="txt">
              <span className="t">{item.title}</span>
              <span className="s">{sub(item)}</span>
            </span>
            <svg {...ICON} className="chev"><path d="m9 6 6 6-6 6" /></svg>
          </Link>
        </li>
      ))}
    </ul>
  );
}
