/**
 * Plan settings › Calendar: the plan's working calendar (spec Calendar and
 * durations). The week as seven lines — the day, a Working switch, and up
 * to two ranges of hours (HH:MM; `24:00` can end a range, so a day can run
 * to midnight) — then the units a day, a week and a month stand for, the
 * default start and end times, and the exceptions: a date, a name, and a
 * Nonworking switch or the hours worked that day (moves often run on
 * weekends). The form is lib/plans/settingsForm's; its checks show by the
 * line they are about. A CSS grid, not a table.
 */
import { useRef } from 'react';

import type { DayKey } from '../../lib/plans/api';
import {
  CALENDAR_LIMITS, DAYS, MAX_RANGES, type CalendarForm, type ExceptionForm, type RangeForm, type SettingsErrors,
} from '../../lib/plans/settingsForm';
import { Switch } from '../Switch';

const STANDARD_HOURS: RangeForm[] = [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }];

function Hours({ label, ranges, disabled, onChange }: {
  label: string;
  ranges: RangeForm[];
  disabled: boolean;
  onChange(next: RangeForm[]): void;
}) {
  const put = (i: number, patch: Partial<RangeForm>) => onChange(ranges.map((r, at) => (at === i ? { ...r, ...patch } : r)));
  return (
    <div className="pln-cal-hours">
      {ranges.map((r, i) => (
        <span key={i} className="pln-cal-range">
          <input type="text" className="pln-cal-time" inputMode="numeric" maxLength={5} placeholder="HH:MM"
                 aria-label={`${label} hours ${i + 1} start`} value={r.start} disabled={disabled}
                 onChange={(e) => put(i, { start: e.target.value })} />
          <span aria-hidden="true">–</span>
          <input type="text" className="pln-cal-time" inputMode="numeric" maxLength={5} placeholder="HH:MM"
                 aria-label={`${label} hours ${i + 1} end`} value={r.end} disabled={disabled}
                 onChange={(e) => put(i, { end: e.target.value })} />
          {ranges.length > 1 && (
            <button type="button" className="mini-btn pln-icon-btn" aria-label={`Remove ${label} hours ${i + 1}`}
                    title="Remove these hours" disabled={disabled}
                    onClick={() => onChange(ranges.filter((_, at) => at !== i))}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
                   aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </span>
      ))}
      {ranges.length < MAX_RANGES && (
        <button type="button" className="mini-btn" disabled={disabled}
                onClick={() => onChange([...ranges, { start: '', end: '' }])}>
          Add hours
        </button>
      )}
    </div>
  );
}

function Err({ text }: { text: string | undefined }) {
  return text ? <p className="pf-error pln-cal-error" role="alert">{text}</p> : null;
}

export default function CalendarEditor({ value, onChange, errors, disabled }: {
  value: CalendarForm;
  onChange(next: CalendarForm): void;
  errors: SettingsErrors;
  disabled: boolean;
}) {
  const seq = useRef(0);
  const set = (patch: Partial<CalendarForm>) => onChange({ ...value, ...patch });
  const setDay = (key: DayKey, patch: Partial<CalendarForm['week'][DayKey]>) =>
    set({ week: { ...value.week, [key]: { ...value.week[key], ...patch } } });
  /** Hours a day just made working starts with: the first working day's, else the Standard calendar's. */
  const usualHours = (): RangeForm[] => {
    const first = DAYS.map(({ key }) => value.week[key]).find((d) => d.working && d.ranges.length);
    return (first?.ranges ?? STANDARD_HOURS).map((r) => ({ ...r }));
  };
  const setException = (key: string, patch: Partial<ExceptionForm>) =>
    set({ exceptions: value.exceptions.map((e) => (e.key === key ? { ...e, ...patch } : e)) });
  const addException = () => {
    seq.current += 1;
    set({ exceptions: [...value.exceptions, { key: `new-${seq.current}`, date: '', name: '', working: false, ranges: [] }] });
  };

  const unit = (key: 'hoursPerDay' | 'hoursPerWeek' | 'daysPerMonth', label: string, max: number) => (
    <div>
      <label htmlFor={`pln-cal-${key}`}>{label}</label>
      <input id={`pln-cal-${key}`} type="number" min={0} max={max} step="any" value={value[key]} disabled={disabled}
             onChange={(e) => set({ [key]: e.target.value })} />
      <Err text={errors[`calendar.${key}`]} />
    </div>
  );

  return (
    <div className="pf-form pln-cal">
      <section className="pln-cal-part" aria-label="Working week">
        <h4 className="pln-cal-title">Working week</h4>
        <Err text={errors['calendar.week']} />
        <div className="pln-cal-week">
          {DAYS.map(({ key, label }) => {
            const day = value.week[key];
            return (
              <div key={key} className="pln-cal-day">
                <span className="pln-cal-dayname">{label}</span>
                <Switch checked={day.working} label={`${label} working`} disabled={disabled}
                        onChange={(on) => setDay(key, on && !day.ranges.length
                          ? { working: true, ranges: usualHours() } : { working: on })} />
                {day.working
                  ? <Hours label={label} ranges={day.ranges} disabled={disabled} onChange={(ranges) => setDay(key, { ranges })} />
                  : <span className="pln-cal-off">Nonworking</span>}
                {errors[`calendar.week.${key}`] && (
                  <p className="pf-error pln-cal-error pln-cal-day-error" role="alert">{errors[`calendar.week.${key}`]}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="pln-cal-part" aria-label="Units and default times">
        <h4 className="pln-cal-title">Units and default times</h4>
        <div className="pln-cal-units">
          {unit('hoursPerDay', 'Hours per day', CALENDAR_LIMITS.hoursPerDay)}
          {unit('hoursPerWeek', 'Hours per week', CALENDAR_LIMITS.hoursPerWeek)}
          {unit('daysPerMonth', 'Days per month', CALENDAR_LIMITS.daysPerMonth)}
          <div>
            <label htmlFor="pln-cal-default-start">Default start time</label>
            <input id="pln-cal-default-start" type="time" value={value.defaultStart} disabled={disabled}
                   onChange={(e) => set({ defaultStart: e.target.value })} />
          </div>
          <div>
            <label htmlFor="pln-cal-default-end">Default end time</label>
            <input id="pln-cal-default-end" type="time" value={value.defaultEnd} disabled={disabled}
                   onChange={(e) => set({ defaultEnd: e.target.value })} />
          </div>
        </div>
        <Err text={errors['calendar.defaults']} />
        <p className="pln-note">A duration typed as 1d, 1w or 1mo counts these hours. A date typed alone starts or ends at
          the default time.</p>
      </section>

      <section className="pln-cal-part" aria-label="Exceptions">
        <h4 className="pln-cal-title">Exceptions</h4>
        {value.exceptions.length > 0 ? (
          <div className="pln-cal-excs">
            {value.exceptions.map((e, i) => {
              const n = i + 1;
              const err = errors[`calendar.exceptions.${e.key}`];
              return (
                <div key={e.key} className="pln-cal-exc" role="group" aria-label={`Exception ${n}`}>
                  <input type="date" aria-label={`Exception ${n} date`} value={e.date} disabled={disabled}
                         onChange={(ev) => setException(e.key, { date: ev.target.value })} />
                  <input type="text" aria-label={`Exception ${n} name`} placeholder="Name (Thanksgiving, Move weekend)"
                         value={e.name} maxLength={120} disabled={disabled}
                         onChange={(ev) => setException(e.key, { name: ev.target.value })} />
                  <span className="pln-cal-exc-kind">
                    <Switch checked={!e.working} label={`Exception ${n} nonworking`} disabled={disabled}
                            onChange={(off) => setException(e.key, off ? { working: false } : {
                              working: true,
                              ranges: e.ranges.length ? e.ranges : [{ start: value.defaultStart, end: value.defaultEnd }],
                            })} />
                    <span>Nonworking</span>
                  </span>
                  {e.working
                    ? <Hours label={`Exception ${n}`} ranges={e.ranges} disabled={disabled}
                             onChange={(ranges) => setException(e.key, { ranges })} />
                    : <span />}
                  <button type="button" className="mini-btn pln-icon-btn" aria-label={`Remove exception ${n}`}
                          title="Remove this exception" disabled={disabled}
                          onClick={() => set({ exceptions: value.exceptions.filter((x) => x.key !== e.key) })}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
                         aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                  {err && <p className="pf-error pln-cal-error pln-cal-exc-error" role="alert">{err}</p>}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="pln-note">No exceptions: every date follows the working week.</p>
        )}
        <div>
          <button type="button" className="mini-btn" disabled={disabled} onClick={addException}>Add exception</button>
        </div>
      </section>
    </div>
  );
}
