/**
 * The canvas rulers: printer dots at the DPI being viewed, counted from the
 * label's top-left corner, along the top and down the left of the stage.
 * The label's own span is shaded and the pointer's position marked.
 */

/** A ruler's thickness in screen pixels. */
export const RULER_PX = 24;

/** Numbered tick spacings, in dots. */
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

/** The smallest spacing whose numbers stand `minPx` apart at `zoom`. */
export function rulerStep(zoom: number, minPx = 48): number {
  return STEPS.find((s) => s * zoom >= minPx) ?? STEPS[STEPS.length - 1];
}

function ticks(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let d = Math.ceil(from / step) * step; d <= to + 1e-9; d += step) out.push(Math.round(d * 1000) / 1000);
  return out;
}

export interface RulersProps {
  /** Screen pixels per dot. */
  zoom: number;
  /** The label's top-left in stage pixels. */
  origin: { x: number; y: number };
  /** The stage in pixels (0 before it has been measured). */
  stage: { w: number; h: number };
  /** The label in dots. */
  label: { w: number; h: number };
  /** The pointer in dots, when it is over the stage. */
  cursor?: { x: number; y: number } | null;
}

interface AxisProps {
  zoom: number;
  /** Where dot 0 falls along the ruler, in ruler pixels. */
  zero: number;
  /** The ruler's length in pixels. */
  length: number;
  span: number;
  cursor: number | null;
  vertical: boolean;
}

function Axis({ zoom, zero, length, span, cursor, vertical }: AxisProps) {
  const step = rulerStep(zoom);
  const minor = step >= 5 ? step / 5 : step / 2;
  const from = -zero / zoom;
  const to = (length - zero) / zoom;
  const at = (d: number) => zero + d * zoom;
  const across = RULER_PX;
  const line = (p: number, len: number, key: string, cls: string) => (vertical
    ? <line key={key} className={cls} x1={across - len} x2={across} y1={p} y2={p} />
    : <line key={key} className={cls} x1={p} x2={p} y1={across - len} y2={across} />);
  return (
    <svg width={vertical ? across : length} height={vertical ? length : across} aria-hidden="true">
      {vertical
        ? <rect className="lbc-ruler-span" x={0} y={at(0)} width={across} height={span * zoom} />
        : <rect className="lbc-ruler-span" x={at(0)} y={0} width={span * zoom} height={across} />}
      {minor * zoom >= 4 && ticks(from, to, minor).map((d) => line(at(d), 4, `m${d}`, 'lbc-tick'))}
      {ticks(from, to, step).map((d) => (
        <g key={`t${d}`}>
          {line(at(d), across, `l${d}`, 'lbc-tick lbc-tick-major')}
          {vertical
            ? <text transform={`translate(${across - 13} ${at(d) + 3}) rotate(-90)`} textAnchor="end">{d}</text>
            : <text x={at(d) + 3} y={10}>{d}</text>}
        </g>
      ))}
      {cursor !== null && line(at(cursor), across, 'cursor', 'lbc-tick lbc-ruler-cursor')}
    </svg>
  );
}

export default function Rulers({ zoom, origin, stage, label, cursor = null }: RulersProps) {
  // before the stage is measured, run the rulers over the label itself
  const width = stage.w > RULER_PX ? stage.w - RULER_PX : origin.x - RULER_PX + label.w * zoom;
  const height = stage.h > RULER_PX ? stage.h - RULER_PX : origin.y - RULER_PX + label.h * zoom;
  return (
    <>
      <div className="lbc-ruler lbc-ruler-x">
        <Axis zoom={zoom} zero={origin.x - RULER_PX} length={Math.max(0, width)} span={label.w}
          cursor={cursor ? cursor.x : null} vertical={false} />
      </div>
      <div className="lbc-ruler lbc-ruler-y">
        <Axis zoom={zoom} zero={origin.y - RULER_PX} length={Math.max(0, height)} span={label.h}
          cursor={cursor ? cursor.y : null} vertical />
      </div>
      <div className="lbc-ruler-corner" aria-hidden="true">dots</div>
    </>
  );
}
