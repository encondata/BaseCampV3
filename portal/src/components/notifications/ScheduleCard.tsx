/**
 * ScheduleCard — "When email reaches you" on /me › Notifications: the
 * person's timezone, the days they work, quiet hours, and the shaded line
 * that says when the summary email goes out. House controls only: ComboBoxes
 * for the zone and the quarter-hour times, a Switch for quiet hours, the
 * `.day-pills` toggles for the days.
 *
 * The card keeps a draft of what is on screen, because not everything that
 * can be on screen can be saved: no day at all, or quiet hours switched on
 * before both times are picked, are steps on the way to a schedule. The
 * parent is only ever handed a valid one — at least one day, and quiet hours
 * either off or a start and an end that differ — and only when it differs
 * from `value`. Until then the summary line says what is missing and the last
 * saved schedule stands; whatever else was changed meanwhile is saved with the
 * rest once it is valid. A new `value` (a save landing, a reload) replaces the
 * draft.
 *
 * Quiet hours switched on propose no times: Start and End begin empty.
 * Switched off, both times are cleared. The ComboBox lists open outside the
 * card, which clips what overflows it.
 */

import { useMemo, useState } from 'react';

import type { NotifSchedule } from '../../lib/api';
import {
  DAYS, DEFAULT_TIMEZONE, timezoneOptions, tzOffsetLabel, type Day,
} from '../../lib/notifications';
import {
  DAY_LABELS, sameSchedule, summaryLine,
} from '../../lib/notificationSchedule';
import { timeOptions } from '../../lib/timeChoices';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';
import '../../styles/directory.css';      // .mini-btn, .org-select, the ComboBox
import '../../styles/settings.css';       // .set-section, .set-row, .switch
import '../../styles/notifications.css';  // .day-pills, .sched-*

/** What is on screen. `start` and `end` are "HH:MM", '' while not picked. */
interface Draft {
  timezone: string | null;
  days: Day[];
  quietOn: boolean;
  start: string;
  end: string;
}

/** The API's "HH:MM" (or "HH:MM:SS") as the pickers' "HH:MM"; null is not picked. */
const clock = (time: string | null): string => (time === null ? '' : time.slice(0, 5));

function draftOf(schedule: NotifSchedule): Draft {
  return {
    timezone: schedule.timezone,
    days: schedule.days,
    quietOn: schedule.quiet_start !== null || schedule.quiet_end !== null,
    start: clock(schedule.quiet_start),
    end: clock(schedule.quiet_end),
  };
}

/** The schedule the draft would save, or null while it is not one. */
function scheduleOf(draft: Draft): NotifSchedule | null {
  if (draft.days.length === 0) return null;
  const base = { timezone: draft.timezone, days: [...draft.days] };
  if (!draft.quietOn) return { ...base, quiet_start: null, quiet_end: null };
  if (!draft.start || !draft.end || draft.start === draft.end) return null;
  return { ...base, quiet_start: draft.start, quiet_end: draft.end };
}

export default function ScheduleCard({ value, onChange }: {
  /** The saved schedule. */
  value: NotifSchedule;
  /** Called with a schedule that can be saved, and only when it changes. */
  onChange: (next: NotifSchedule) => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(value));
  // A new saved schedule replaces the draft. Adjusting during render, not in
  // an effect, so no frame shows the old draft beside the new value.
  const [seen, setSeen] = useState(value);
  if (!sameSchedule(seen, value)) {
    setSeen(value);
    setDraft(draftOf(value));
  }

  const edit = (next: Draft) => {
    setDraft(next);
    const schedule = scheduleOf(next);
    if (schedule && !sameSchedule(schedule, value)) onChange(schedule);
  };

  const toggleDay = (day: Day) => {
    const on = new Set(draft.days);
    if (on.has(day)) on.delete(day);
    else on.add(day);
    edit({ ...draft, days: DAYS.filter((d) => on.has(d)) });
  };

  // Unset shows the company reference zone, but stays unset until one is picked.
  const zone = draft.timezone ?? DEFAULT_TIMEZONE;
  // A stored zone the browser no longer lists still shows, so it can be replaced.
  const zoneOptions = useMemo(() => {
    const zones = timezoneOptions();
    return zones.some((o) => o.value === zone)
      ? zones
      : [{ value: zone, label: zone, sub: tzOffsetLabel(zone) }, ...zones];
  }, [zone]);
  const startOptions = useMemo(() => timeOptions(draft.start || null), [draft.start]);
  const endOptions = useMemo(() => timeOptions(draft.end || null), [draft.end]);

  const line = summaryLine({
    timezone: draft.timezone, days: draft.days,
    quiet_start: draft.start || null, quiet_end: draft.end || null,
  }, draft.quietOn);

  return (
    <section className="set-section sched-card">
      <div className="set-head">
        <h3>When email reaches you</h3>
        <p>
          Email that arrives during quiet hours or on a day off waits, then comes as one summary
          an hour before your day starts. Your inbox in the portal still updates right away.
        </p>
      </div>

      <div className="set-row">
        <div className="set-label"><b>Timezone</b></div>
        <div className="sched-zone">
          <ComboBox ariaLabel="Timezone" options={zoneOptions} value={zone} portal
                    onChange={(next) => edit({ ...draft, timezone: next })} />
        </div>
      </div>

      <div className="set-row">
        <div className="set-label"><b>Days you work</b></div>
        <div className="day-pills" role="group" aria-label="Days you work">
          {DAYS.map((d) => {
            const on = draft.days.includes(d);
            return (
              <button type="button" key={d} aria-pressed={on}
                      className={`mini-btn${on ? ' active' : ''}`} onClick={() => toggleDay(d)}>
                {DAY_LABELS[d]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="set-row">
        <div className="set-label"><b>Quiet hours</b></div>
        <div className="sched-quiet">
          <Switch label="Quiet hours" checked={draft.quietOn}
                  onChange={(on) => edit({ ...draft, quietOn: on, start: '', end: '' })} />
          <div className="sched-time">
            <ComboBox ariaLabel="Quiet hours start" options={startOptions} value={draft.start}
                      placeholder="Start" disabled={!draft.quietOn} portal
                      onChange={(next) => edit({ ...draft, start: next })} />
          </div>
          <span className="sched-to">to</span>
          <div className="sched-time">
            <ComboBox ariaLabel="Quiet hours end" options={endOptions} value={draft.end}
                      placeholder="End" disabled={!draft.quietOn} portal
                      onChange={(next) => edit({ ...draft, end: next })} />
          </div>
        </div>
      </div>

      <p className={`sched-summary${line.warn ? ' warn' : ''}`} role="status">{line.text}</p>
    </section>
  );
}
