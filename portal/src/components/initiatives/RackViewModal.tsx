/**
 * RackViewModal — SVG rack elevation(s) for one Source/Destination rack on
 * a move (Task 6, docs/superpowers/specs/2026-08-25-move-assets-design.md's
 * "Rack view" section). Opened by clicking a non-empty rack cell on the
 * Assets table (InitiativeDetail.tsx); the placement math itself lives in
 * lib/initiatives.ts's `rackLayout` so it's unit-testable without jsdom —
 * this component only turns those blocks into SVG geometry.
 *
 * Print-friendly redesign: two independent, self-contained rack frames
 * (FRONT and REAR) side by side, each with its own posts/rails/caps and
 * U numbering, rendered in a light, high-contrast, grayscale-safe palette
 * (no gradients, no color-only distinctions) so it holds up printed on
 * paper. The REAR frame is omitted entirely — not just emptied — when no
 * asset in this rack/side carries a "rear" position note. Hover detail
 * (name/serial/make-model/RU/position) is a real HTML tooltip positioned
 * off each faceplate's bounding rect, not a native `<title>` tooltip.
 */
import { useRef, useState, useEffect } from 'react';

import { rackLayout } from '../../lib/initiatives';
import type { RackBlock } from '../../lib/initiatives';
import type { InitiativeAssetRow } from '../../lib/api';

const RU_COUNT = 54;
const U_PX = 16;
const POST_WIDTH = 26; // left/right posts, per elevation
const CAP_HEIGHT = 10; // top/bottom caps, per elevation
const ELEV_FRAME_WIDTH = 190; // one elevation's own viewBox width
// The 24px gap between the FRONT and REAR elevations is a pure HTML/CSS
// layout concern (`.rack-elevations { gap: 24px }` in initiatives.css) —
// it never enters the SVG geometry math, so there's no JS constant for it.

const RU_AREA_HEIGHT = RU_COUNT * U_PX; // 864
const TOTAL_HEIGHT = RU_AREA_HEIGHT + CAP_HEIGHT * 2; // 884
const INTERIOR_TOP = CAP_HEIGHT;
const INTERIOR_BOTTOM = INTERIOR_TOP + RU_AREA_HEIGHT;
const INTERIOR_LEFT = POST_WIDTH;
const INTERIOR_RIGHT = ELEV_FRAME_WIDTH - POST_WIDTH;
const INTERIOR_WIDTH = INTERIOR_RIGHT - INTERIOR_LEFT;

const FACEPLATE_INSET = 4; // each side, within the interior
export const FACEPLATE_USABLE_WIDTH = INTERIOR_WIDTH - FACEPLATE_INSET * 2;
const FACEPLATE_X0 = INTERIOR_LEFT + FACEPLATE_INSET;
const LANE_PX = 14; // horizontal offset step for overlapping blocks

const HOLE_SIZE = 4;
const HOLE_INSET = 6; // from each post's interior-facing edge
const LEFT_HOLE_X = POST_WIDTH - HOLE_INSET - HOLE_SIZE;
const RIGHT_HOLE_X = ELEV_FRAME_WIDTH - POST_WIDTH + HOLE_INSET;
const U_LABEL_X = LEFT_HOLE_X - 3; // right-aligned against the rail holes

const RU_LIST = Array.from({ length: RU_COUNT }, (_, i) => i + 1);
const HOLE_FRACTIONS = [0.2, 0.5, 0.8];

/** Greedy interval-graph "lane" assignment for blocks that overlap in RU
 *  range — same idea as calendar-view event columns: walk blocks lowest-RU
 *  first, and give each the first lane whose current occupant no longer
 *  overlaps it. Kept simple (no lane count cap, no re-balancing) since a
 *  single rack rarely has more than a couple of asset collisions at once;
 *  overlapping blocks just nudge right and shrink slightly to stay legible.
 *  Exported for testing (RackViewModal.test.tsx) alongside `laneGeometry`
 *  below, which is what actually gets asserted against — this function
 *  alone doesn't say anything about on-canvas placement. */
export function assignLanes(
  blocks: { id: string; ru: number; height: number }[],
): Map<string, number> {
  const sorted = [...blocks].sort((a, b) => a.ru - b.ru);
  const laneEnds: number[] = []; // top RU currently occupied per lane
  const lanes = new Map<string, number>();
  for (const b of sorted) {
    const top = b.ru + b.height;
    let lane = laneEnds.findIndex((end) => b.ru >= end);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(top);
    } else {
      laneEnds[lane] = top;
    }
    lanes.set(b.id, lane);
  }
  return lanes;
}

export interface LaneRect { id: string; x: number; width: number; }

/** Splits `blocks` into groups that are mutually reachable through RU-range
 *  overlap ("connected components" of the overlap graph) — e.g. A overlaps
 *  B and B overlaps C puts all three in one group even if A and C don't
 *  directly overlap. Sorting by `ru` first and tracking only the running
 *  max top makes this a single linear sweep: the well-known technique for
 *  merging overlapping intervals produces exactly the connected components
 *  here, since a sorted-by-start interval graph's components are precisely
 *  the maximal runs where each interval starts before the running max end. */
function clusterOverlappingBlocks<T extends { ru: number; height: number }>(
  blocks: T[],
): T[][] {
  const sorted = [...blocks].sort((a, b) => a.ru - b.ru);
  const clusters: T[][] = [];
  let current: T[] = [];
  let currentTop = -Infinity;
  for (const b of sorted) {
    if (current.length > 0 && b.ru >= currentTop) {
      clusters.push(current);
      current = [];
    }
    current.push(b);
    currentTop = Math.max(currentTop, b.ru + b.height);
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/** Turns lane indices into actual x/width geometry within `usableWidth` —
 *  pulled out from the render so it's testable without mounting the SVG.
 *  Width is computed PER OVERLAP CLUSTER, not once globally across the
 *  whole `blocks` array: a lone, non-colliding block must fill the full
 *  `usableWidth` (minus the lane gutter) even when some unrelated pair of
 *  blocks elsewhere in the same elevation happens to collide and need two
 *  lanes — otherwise every block in the array gets squeezed to whatever
 *  the single busiest cluster needs, which is the bug this guards against.
 *  Within a cluster, `usableWidth` is still divided ACROSS the lanes (not
 *  just had the gap gutters subtracted off the front) or extra lanes push
 *  later blocks past the right edge of the frame instead of tiling inside
 *  it. */
export function laneGeometry(
  blocks: { id: string; ru: number; height: number }[], usableWidth: number,
): LaneRect[] {
  const result: LaneRect[] = [];
  for (const cluster of clusterOverlappingBlocks(blocks)) {
    const lanes = assignLanes(cluster);
    const laneCount = Math.max(1, ...cluster.map((b) => (lanes.get(b.id) ?? 0) + 1));
    const width = Math.max(40, (usableWidth - (laneCount - 1) * LANE_PX) / laneCount);
    for (const b of cluster) {
      const lane = lanes.get(b.id) ?? 0;
      result.push({ id: b.id, x: lane * (width + LANE_PX), width });
    }
  }
  return result;
}

/** One-line faceplate label — `${name} (${position})` when the side has a
 *  position note, else just the name — truncated with an ellipsis to fit
 *  `laneWidth` on a simple char-budget (laneWidth / 5.2px per mono char is
 *  a fine approximation for 8.5px var(--font-mono), no canvas measurement
 *  needed). */
export function rackLabel(
  name: string, position: string | null | undefined, laneWidth: number,
): string {
  const full = position ? `${name} (${position})` : name;
  const maxChars = Math.max(1, Math.floor(laneWidth / 5.2));
  if (full.length <= maxChars) return full;
  return maxChars === 1 ? '…' : `${full.slice(0, maxChars - 1)}…`;
}

/** Front/rear elevation assignment: a side position note that mentions
 *  "rear" (case-insensitively, substring match — "rear-left" counts)
 *  places the block in the REAR elevation; everything else (front,
 *  left/right, blank) lands in FRONT. Exported for testing without
 *  mounting the SVG. */
export function isRearPosition(position: string | null | undefined): boolean {
  return !!position && position.toLowerCase().includes('rear');
}

/** y (SVG, top-down) for the bottom edge of RU `ru` — RU 1 sits at the
 *  bottom of the elevation, so higher RU numbers move up (smaller y). */
const yForRu = (ru: number) => INTERIOR_BOTTOM - (ru - 1) * U_PX;
/** y for the top edge of RU `ru` (used for the rail hole/number rows). */
const ruTop = (ru: number) => INTERIOR_BOTTOM - ru * U_PX;

interface HoverState { block: RackBlock; x: number; y: number; }

/** One complete, self-contained rack frame — posts, top/bottom caps,
 *  interior, per-U hairlines, EIA rail holes on both posts, U numbering on
 *  the left post, and this elevation's own faceplates. Rendered twice by
 *  the modal below (FRONT always, REAR only when it has blocks) rather
 *  than as two halves of one shared frame, so each reads as a complete
 *  elevation on its own — including when only one of the two is shown. */
function RackElevation({ heading, ariaLabel, blocks, onHoverBlock, onLeaveBlock }: {
  heading: string;
  ariaLabel: string;
  blocks: RackBlock[];
  onHoverBlock: (block: RackBlock, e: React.MouseEvent<SVGGElement>) => void;
  onLeaveBlock: () => void;
}) {
  const geometry = new Map(
    laneGeometry(blocks, FACEPLATE_USABLE_WIDTH).map((g) => [g.id, g]),
  );

  return (
    <div className="rack-elevation">
      <div className="rack-elevation-heading">{heading}</div>
      <svg viewBox={`0 0 ${ELEV_FRAME_WIDTH} ${TOTAL_HEIGHT}`} className="rack-svg"
           role="img" aria-label={ariaLabel}>
        {/* frame: full-height posts + top/bottom caps, outlined line-work */}
        <rect x={0} y={0} width={POST_WIDTH} height={TOTAL_HEIGHT} className="rack-post" />
        <rect x={ELEV_FRAME_WIDTH - POST_WIDTH} y={0} width={POST_WIDTH} height={TOTAL_HEIGHT}
              className="rack-post" />
        <rect x={0} y={0} width={ELEV_FRAME_WIDTH} height={CAP_HEIGHT} className="rack-cap" />
        <rect x={0} y={TOTAL_HEIGHT - CAP_HEIGHT} width={ELEV_FRAME_WIDTH} height={CAP_HEIGHT}
              className="rack-cap" />

        {/* interior + per-U hairlines */}
        <rect x={INTERIOR_LEFT} y={INTERIOR_TOP} width={INTERIOR_WIDTH}
              height={RU_AREA_HEIGHT} className="rack-interior" />
        {Array.from({ length: RU_COUNT + 1 }, (_, i) => i).map((i) => (
          <line key={i} x1={INTERIOR_LEFT} x2={INTERIOR_RIGHT}
                y1={INTERIOR_TOP + i * U_PX} y2={INTERIOR_TOP + i * U_PX}
                className="rack-u-hairline" />
        ))}

        {/* EIA rail holes, one <g> per post — cheap flat rects, no filters */}
        <g className="rack-rail-holes">
          {RU_LIST.flatMap((ru) => HOLE_FRACTIONS.map((frac, i) => (
            <rect key={`l-${ru}-${i}`} x={LEFT_HOLE_X}
                  y={ruTop(ru) + frac * U_PX - HOLE_SIZE / 2}
                  width={HOLE_SIZE} height={HOLE_SIZE} className="rack-rail-hole" />
          )))}
        </g>
        <g className="rack-rail-holes">
          {RU_LIST.flatMap((ru) => HOLE_FRACTIONS.map((frac, i) => (
            <rect key={`r-${ru}-${i}`} x={RIGHT_HOLE_X}
                  y={ruTop(ru) + frac * U_PX - HOLE_SIZE / 2}
                  width={HOLE_SIZE} height={HOLE_SIZE} className="rack-rail-hole" />
          )))}
        </g>

        {/* U numbering, left post */}
        <g className="rack-u-labels">
          {RU_LIST.map((ru) => (
            <text key={ru} x={U_LABEL_X} y={ruTop(ru) + U_PX / 2} textAnchor="end"
                  dominantBaseline="middle"
                  className={ru % 5 === 0 ? 'rack-u-label rack-u-label-major' : 'rack-u-label'}>
              {ru}
            </text>
          ))}
        </g>

        {blocks.length === 0 ? (
          <text x={INTERIOR_LEFT + INTERIOR_WIDTH / 2} y={INTERIOR_TOP + RU_AREA_HEIGHT / 2}
                textAnchor="middle" dominantBaseline="middle" className="rack-empty-label">
            No assets recorded at this rack
          </text>
        ) : blocks.map((b) => {
          const g = geometry.get(b.id);
          const x = FACEPLATE_X0 + (g?.x ?? 0);
          const width = g?.width ?? FACEPLATE_USABLE_WIDTH;
          const fullHeight = b.height * U_PX;
          const y = yForRu(b.ru + b.height) + 1;
          const height = fullHeight - 2;
          const showVents = height >= 12;
          const label = rackLabel(b.label, b.position, width);
          const ledCx = x + width - 10;
          const ledCy = y + height / 2;
          return (
            <g key={b.id} onMouseEnter={(e) => onHoverBlock(b, e)} onMouseLeave={onLeaveBlock}>
              <rect x={x} y={y} width={width} height={height} rx={2}
                    className={`rack-faceplate ${b.verified ? 'rack-faceplate-verified'
                      : 'rack-faceplate-unverified'}`} />
              {showVents && [0.6, 0.75, 0.9].map((frac) => (
                <line key={frac} x1={x + 8} x2={x + 8 + width * 0.6}
                      y1={y + height * frac} y2={y + height * frac}
                      className="rack-faceplate-vent" />
              ))}
              <circle cx={ledCx} cy={ledCy} r={3}
                      className={b.verified ? 'rack-led-verified' : 'rack-led-unverified'} />
              <text x={x + 8} y={y + height / 2} dominantBaseline="middle"
                    className={`rack-block-label ${b.verified ? ''
                      : 'rack-block-label-unverified'}`}>
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function RackViewModal({ rackName, side, rows, onClose }: {
  rackName: string;
  side: 'source' | 'destination';
  rows: InitiativeAssetRow[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const blocks = rackLayout(rows, rackName, side);
  const frontBlocks = blocks.filter((b) => !isRearPosition(b.position));
  const rearBlocks = blocks.filter((b) => isRearPosition(b.position));
  const showRear = rearBlocks.length > 0;
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  const handleHover = (block: RackBlock, e: React.MouseEvent<SVGGElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const targetRect = e.currentTarget.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setHover({
      block,
      x: targetRect.left - containerRect.left + targetRect.width / 2,
      y: targetRect.top - containerRect.top,
    });
  };
  const handleLeave = () => setHover(null);

  const sideLabel = side === 'source' ? 'Source' : 'Destination';
  const hoveredRow = hover ? rowsById.get(hover.block.id) : undefined;
  const hoveredAsset = hoveredRow?.asset;
  const hoveredMakeModel = hoveredAsset
    ? [hoveredAsset.model_make, hoveredAsset.model_name].filter(Boolean).join(' ')
    : '';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card rack-modal-card">
        <div className="modal-head">
          <div className="rack-modal-title">
            <h3>Rack {rackName} — {sideLabel}</h3>
            <div className="rack-legend" aria-hidden="true">
              <span className="rack-legend-item">
                <span className="rack-legend-swatch rack-legend-swatch-verified" />
                Verified
              </span>
              <span className="rack-legend-item">
                <span className="rack-legend-swatch rack-legend-swatch-planned" />
                Planned
              </span>
            </div>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body rack-modal-body">
          <div className="rack-elevations" ref={containerRef}>
            <RackElevation
              heading="FRONT" blocks={frontBlocks}
              ariaLabel={`Rack ${rackName} — ${sideLabel} — front elevation`}
              onHoverBlock={handleHover} onLeaveBlock={handleLeave}
            />
            {showRear && (
              <RackElevation
                heading="REAR" blocks={rearBlocks}
                ariaLabel={`Rack ${rackName} — ${sideLabel} — rear elevation`}
                onHoverBlock={handleHover} onLeaveBlock={handleLeave}
              />
            )}
            {hover && (
              <div className="rack-tooltip" style={{ left: hover.x, top: hover.y }}>
                <div className="rack-tooltip-name">
                  {hoveredAsset?.name ?? hoveredAsset?.serial_number ?? '—'}
                </div>
                <dl className="rack-tooltip-kv">
                  <dt>Serial</dt><dd>{hoveredAsset?.serial_number ?? '—'}</dd>
                  <dt>Make/Model</dt><dd>{hoveredMakeModel || '—'}</dd>
                  <dt>RU</dt><dd>{hover.block.ru}</dd>
                  <dt>Position</dt><dd>{hover.block.position ?? '—'}</dd>
                </dl>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
