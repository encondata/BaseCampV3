/**
 * The mini timeline on an initiative's Learning tab: the invite, each
 * reminder, the due date and the start, in date order. Events are spaced
 * evenly along the rail (not to scale), so reminders a day apart never sit
 * on top of each other; the dates say how far apart they really are. Dates
 * already past are green, the due date is red, the start is violet, and
 * what's still ahead is the accent color.
 */

import type { InitiativeLearning } from '../../lib/learning';
import { dayLabel } from './initiativeLearning';

type Event = InitiativeLearning['timeline'][number];

const WHAT: Record<Event['kind'], string> = {
  invite: 'Invites', reminder: 'Reminder', due: 'Due', start: 'Starts',
};

/** Local calendar day as YYYY-MM-DD — the same shape the API's dates have. */
function todayKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export default function LearningTimeline({ events, now = new Date() }: {
  events: Event[];
  now?: Date;
}) {
  if (events.length === 0) {
    return <p className="lrn-hint">Dates appear once the initiative has a start date.</p>;
  }
  const today = todayKey(now);
  return (
    <ol className="lrn-tl" aria-label="Invite schedule">
      {events.map((e, i) => (
        <li key={`${e.kind}-${e.date}-${i}`}
            className={`lrn-tl-ev lrn-tl-${e.kind}${e.date <= today ? ' is-past' : ''}`}>
          <span className="lrn-tl-pin" aria-hidden="true" />
          <span className="lrn-tl-date">{dayLabel(e.date)}</span>
          <span className="lrn-tl-what">{WHAT[e.kind]}</span>
        </li>
      ))}
    </ol>
  );
}
