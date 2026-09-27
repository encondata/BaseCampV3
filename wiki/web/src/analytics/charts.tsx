/** The analytics page's two marks — plain SVG/HTML, no chart library.
 *  (The portal's dashboard charts are React modules the wiki may not
 *  import; see portalImports.test.ts.) Single-series marks ride
 *  var(--accent), and every number is also written out beside them. */

const W = 640;
const H = 150;
const PAD_TOP = 6;
const PAD_BOTTOM = 20;

/** "2026-09-26" (a UTC day) → "Sep 26". */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/** Views per day as bars, oldest on the left; each bar's title reads
 *  out its day and count. The first, middle and last days are labeled. */
export function ViewsBars({ days }: { days: { day: string; views: number }[] }) {
  if (!days.length) return null;
  const total = days.reduce((sum, d) => sum + d.views, 0);
  const max = Math.max(...days.map((d) => d.views), 1);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const slot = W / days.length;
  const barW = Math.max(Math.min(slot * 0.7, 28), 1);
  const labeled = new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]);

  return (
    <svg className="wiki-an-bars" viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={`${total} views over the last ${days.length} days`}>
      <line x1="0" x2={W} y1={H - PAD_BOTTOM + 0.5} y2={H - PAD_BOTTOM + 0.5} className="wiki-an-axis" />
      {days.map((d, i) => {
        const h = d.views ? Math.max((d.views / max) * plotH, 2) : 0;
        const x = i * slot + (slot - barW) / 2;
        return (
          <rect key={d.day} data-day={d.day} x={x} y={H - PAD_BOTTOM - h} width={barW} height={h} rx={Math.min(3, barW / 2)}
                className="wiki-an-bar">
            <title>{`${dayLabel(d.day)}: ${d.views} ${d.views === 1 ? 'view' : 'views'}`}</title>
          </rect>
        );
      })}
      {days.map((d, i) => (labeled.has(i) ? (
        <text key={`l-${d.day}`} x={Math.min(Math.max(i * slot + slot / 2, 22), W - 22)} y={H - 5}
              textAnchor="middle" className="wiki-an-tick">{dayLabel(d.day)}</text>
      ) : null))}
    </svg>
  );
}
