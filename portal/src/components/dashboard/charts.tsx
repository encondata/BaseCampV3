/**
 * Dashboard chart primitives — pure SVG, no chart libraries (same stance
 * as InitiativeDetail's status donut). Single-series marks ride
 * var(--accent); multi-color segments always carry a direct label +
 * count in the owning panel (hue is never the only encoding — the
 * portal's palette fails pairwise CVD checks without labels, verified
 * with the dataviz validator).
 */

import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

/* ── sparkline: tiny single-series trend inside a KPI tile ── */

export function Sparkline({ points, width = 76, height = 30 }: {
  points: number[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const step = width / (points.length - 1);
  const pad = 2;
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const areaD = `${d} L ${width} ${height} L 0 ${height} Z`;
  return (
    <svg className="dash-kpi-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={areaD} fill="rgba(var(--accent-rgb), 0.12)" stroke="none" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── daily bar chart: scan activity, single series ────────── */

export interface DayPoint { key: string; label: string; value: number }

const BAR_W = 560;
const BAR_H = 170;
const BAR_PAD_BOTTOM = 18;
const BAR_PAD_TOP = 8;

export function DailyBars({ days, ariaLabel, formatTooltip }: {
  days: DayPoint[];
  ariaLabel: string;
  formatTooltip: (d: DayPoint) => string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);

  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.value), 1);
  const plotH = BAR_H - BAR_PAD_BOTTOM - BAR_PAD_TOP;
  const slot = BAR_W / days.length;
  const barW = Math.min(slot * 0.62, 34);

  const handleHover = (key: string, e: ReactMouseEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const t = (e.currentTarget as SVGElement).getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    setHover({ key, x: t.left - w.left + t.width / 2, y: t.top - w.top });
  };

  const hovered = hover ? days.find((d) => d.key === hover.key) : undefined;
  // quarter/half/full reference lines, skipping 0
  const refs = [0.5, 1].map((f) => Math.round(max * f)).filter((v, i, a) => v > 0 && a.indexOf(v) === i);

  return (
    <div className="dash-chart-wrap" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      <svg className="dash-chart-svg" viewBox={`0 0 ${BAR_W} ${BAR_H}`} role="img"
           aria-label={ariaLabel} preserveAspectRatio="none">
        {refs.map((v) => {
          const ry = BAR_PAD_TOP + plotH - (v / max) * plotH;
          return <line key={v} className="dash-grid-line" x1="0" x2={BAR_W} y1={ry} y2={ry} />;
        })}
        {days.map((d, i) => {
          const h = Math.max((d.value / max) * plotH, d.value > 0 ? 2 : 0);
          const x = i * slot + (slot - barW) / 2;
          const y = BAR_PAD_TOP + plotH - h;
          return (
            <g key={d.key}>
              {h > 0 && (
                <rect className={`dash-bar${hover && hover.key !== d.key ? ' dim' : ''}`}
                      x={x} y={y} width={barW} height={h} rx="3" />
              )}
              {/* full-height hit target so hover works on short bars */}
              <rect className="dash-bar-hit" x={i * slot} y="0" width={slot} height={BAR_H - BAR_PAD_BOTTOM}
                    onMouseEnter={(e) => handleHover(d.key, e)}>
                <title>{formatTooltip(d)}</title>
              </rect>
            </g>
          );
        })}
        {days.map((d, i) => (
          // sparse x labels: first, last, and every ~4th slot between
          (i === 0 || i === days.length - 1 || i % 4 === 0) && i !== days.length - 2 ? (
            <text key={`l-${d.key}`} className="dash-axis-label"
                  x={i * slot + slot / 2} y={BAR_H - 4} textAnchor="middle">
              {d.label}
            </text>
          ) : null
        ))}
      </svg>
      {hovered && hover && (
        <div className="dash-chart-tooltip" style={{ left: hover.x, top: hover.y }}>
          {formatTooltip(hovered)}
        </div>
      )}
    </div>
  );
}

/* ── labeled distribution: color strip + label/count rows ──── */

export interface DistEntry { key: string; label: string; color: string; count: number }

export function Distribution({ entries, total }: { entries: DistEntry[]; total: number }) {
  const shown = entries.filter((e) => e.count > 0);
  if (total === 0 || shown.length === 0) return null;
  return (
    <>
      <div className="dash-strip" role="img"
           aria-label={shown.map((e) => `${e.label} ${e.count}`).join(', ')}>
        {shown.map((e) => (
          <span key={e.key} className="seg"
                style={{ background: e.color, flexGrow: e.count }} />
        ))}
      </div>
      <div className="mini-list dash-dist-rows">
        {shown.map((e) => (
          <div key={e.key} className="mini-row dash-dist-row">
            <span className="dash-dist-swatch" style={{ background: e.color }} aria-hidden="true" />
            <span className="cell-top dash-dist-label">{e.label}</span>
            <span className="dash-dist-count mono">{e.count}</span>
            <span className="dash-dist-pct mono">{Math.round((e.count / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </>
  );
}
