import { useState } from 'react';

import { barTone, dayUptime, formatDay, type DayBar } from '../lib/summary';

/** Bars older than this many days are hidden on phones (keeps bars tappable). */
const PHONE_DAYS = 30;

export default function UptimeStrip({ days }: { days: DayBar[] }) {
  const [active, setActive] = useState<number | null>(null);
  const cutoff = days.length - PHONE_DAYS;
  const bar = active === null ? null : days[active];
  return (
    <div className="ss-strip-wrap" onMouseLeave={() => setActive(null)}>
      <div className="ss-strip">
        {days.map((d, i) => {
          const label = `${formatDay(d.day)}: ${dayUptime(d)}`;
          return (
            <span
              key={d.day + i}
              role="img"
              aria-label={label}
              tabIndex={0}
              className={`ss-bar ss-bar-${barTone(d)}${i < cutoff ? ' ss-bar-old' : ''}${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            />
          );
        })}
      </div>
      {bar && active !== null && (
        <div
          className={`ss-tip${active > days.length / 2 ? ' ss-tip-left' : ''}`}
          style={{ left: `${((active + 0.5) / days.length) * 100}%` }}
          aria-hidden="true"
        >
          <div className="ss-tip-day">{formatDay(bar.day)}</div>
          <div className="ss-tip-pct">{dayUptime(bar)}</div>
          {bar.total ? <div className="ss-tip-count">{bar.ok} of {bar.total} checks passed</div> : null}
        </div>
      )}
      <div className="ss-axis">
        <span className="ss-axis-long">{days.length} days ago</span>
        <span className="ss-axis-short">{PHONE_DAYS} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
