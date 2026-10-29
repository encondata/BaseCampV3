/** One document in the training list: done (green check, "Signed Nov 4",
 *  opens read-only), next (highlighted, opens), open (opens) or locked
 *  (lock icon, inert). */
import { Link } from 'react-router-dom';

import { signedDay } from '../lib/format';
import { t } from '../lib/i18n';
import type { TrainingItem } from '../lib/training';

const ICON = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
               strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

function sub(item: TrainingItem): string {
  if (item.status === 'signed' && item.signed_at) return t('training.signed', { date: signedDay(item.signed_at) });
  return item.has_quiz ? t('training.minQuiz', { n: item.minutes }) : t('training.minRead', { n: item.minutes });
}

export default function TaskRow({ item, next }: { item: TrainingItem; next: boolean }) {
  const done = item.status === 'signed';
  const locked = !done && item.locked;
  const body = (
    <>
      <span className="ck" aria-hidden={locked ? undefined : true}>
        {done && <svg {...ICON}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>}
        {!done && locked && <svg {...ICON} aria-hidden={undefined} role="img" aria-label={t('training.locked')}>
          <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>}
        {!done && !locked && <svg {...ICON}><path d="M8 5.5v13l11-6.5z" /></svg>}
      </span>
      <span className="txt">
        <span className="t">{item.title}</span>
        <span className="s">{sub(item)}</span>
      </span>
      {!locked && (
        <svg {...ICON} className="chev"><path d="m9 6 6 6-6 6" /></svg>
      )}
    </>
  );
  const cls = `learn-task ${done ? 'done' : ''} ${locked ? 'locked' : ''} ${next ? 'next' : ''}`.replace(/\s+/g, ' ').trim();
  if (locked) return <li className={cls}><div className="row">{body}</div></li>;
  return <li className={cls}><Link className="row" to={`/training/${item.assignment_id}`}>{body}</Link></li>;
}
