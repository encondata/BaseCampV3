/**
 * RackElevation — one complete SVG rack frame (posts, caps, per-U
 * hairlines, U numbering, faceplates) plus the pure placement helpers it
 * needs. Extracted out of RackViewModal.tsx so the report worker can
 * render the exact same elevation server-side under Node
 * (src/reports/renderRack.tsx) without pulling in the modal's hover
 * state, portal chrome, or React DOM event wiring — the hover callbacks
 * are optional here for that reason. RackViewModal re-exports the
 * helpers, so its existing tests keep importing them from there.
 *
 * Faceplates are filled with the asset's category color (contrast-picked
 * label text via `readableTextColor`, uncategorized assets fall back to
 * `UNCATEGORIZED_FILL`), with verified vs. planned kept distinguishable
 * even in grayscale by border alone — solid green for verified, dashed
 * dark for planned — rather than by fill or an LED. Fill/stroke/label
 * color are INLINE attributes, not classes: category colors are
 * data-driven, and both the modal's print sheet (lib/rackPrint.ts) and
 * the report worker serialize this markup outside the app's stylesheet.
 */
import { UNCATEGORIZED_FILL } from '../../lib/initiatives';
import type { RackBlock, RackChild } from '../../lib/initiatives';
import { readableTextColor } from '../../lib/color';

/** Racks render at 52U by default (standard cabinets are 42–48U; some run
 *  to 60U). When a device sits above that, the frame grows to the highest
 *  occupied RU plus one, rounded up to an even count, so nothing is ever
 *  clipped and the top always reads as a whole unit. */
export const DEFAULT_RU_COUNT = 52;
const U_PX = 16;
const POST_WIDTH = 26; // left/right posts, per elevation
const CAP_HEIGHT = 10; // top/bottom caps, per elevation
const ELEV_FRAME_WIDTH = 190; // one elevation's own viewBox width
// The 24px gap between the FRONT and REAR elevations is a pure HTML/CSS
// layout concern (`.rack-elevations { gap: 24px }` in initiatives.css) —
// it never enters the SVG geometry math, so there's no JS constant for it.

const INTERIOR_TOP = CAP_HEIGHT;
const INTERIOR_LEFT = POST_WIDTH;
const INTERIOR_RIGHT = ELEV_FRAME_WIDTH - POST_WIDTH;
const INTERIOR_WIDTH = INTERIOR_RIGHT - INTERIOR_LEFT;

const FACEPLATE_INSET = 4; // each side, within the interior
export const FACEPLATE_USABLE_WIDTH = INTERIOR_WIDTH - FACEPLATE_INSET * 2;
const FACEPLATE_X0 = INTERIOR_LEFT + FACEPLATE_INSET;
const LANE_PX = 14; // horizontal offset step for overlapping blocks

// U numbers sit centered in each post (round 5 — text-anchor="middle" at
// each post's own horizontal midpoint keeps single- and double-digit RUs
// centered alike, instead of hugging whichever edge the old end/start
// anchoring favored). Right rail is just the left one's x mirrored across
// the elevation's midline.
const U_LABEL_X = POST_WIDTH / 2;
const U_LABEL_X_RIGHT = ELEV_FRAME_WIDTH - U_LABEL_X;

/** RU count for one rack's frame — DEFAULT_RU_COUNT unless a block's top
 *  RU exceeds it, then (highest top RU + 1) rounded up to even. Pure and
 *  exported so both elevations of a rack (and tests) size identically:
 *  callers pass every block of the rack, ghosts included. */
export function rackRuCount(blocks: { ru: number; height: number }[]): number {
  const maxTop = blocks.reduce((m, b) => Math.max(m, b.ru + b.height - 1), 0);
  if (maxTop < DEFAULT_RU_COUNT) return DEFAULT_RU_COUNT;
  const withHeadroom = maxTop + 1;
  return withHeadroom % 2 === 0 ? withHeadroom : withHeadroom + 1;
}

/** Vertical geometry for a frame of `ruCount` units, derived per render
 *  now that the count is dynamic. RU 1 sits at the bottom of the frame, so
 *  higher RU numbers move up (smaller y): yForRu = bottom edge of RU `ru`,
 *  ruTop = its top edge (post number rows). */
function frameGeometry(ruCount: number) {
  const ruAreaHeight = ruCount * U_PX;
  const interiorBottom = INTERIOR_TOP + ruAreaHeight;
  return {
    ruAreaHeight,
    totalHeight: ruAreaHeight + CAP_HEIGHT * 2,
    ruList: Array.from({ length: ruCount }, (_, i) => i + 1),
    yForRu: (ru: number) => interiorBottom - (ru - 1) * U_PX,
    ruTop: (ru: number) => interiorBottom - ru * U_PX,
  };
}

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

/** A block placed in an elevation it doesn't actually belong to, standing
 *  in for "something is mounted here from the other physical side" — no
 *  label, no verified/unverified styling, just a blank outlined box at the
 *  same RU/height so the occupied space reads correctly from both faces of
 *  the rack. Still a real `RackBlock` (same id as the real block it
 *  mirrors — see `ghostBlocksFor`) so it flows through the same
 *  `laneGeometry` call and hover lookup as everything else. */
export interface DisplayBlock extends RackBlock { isGhost?: boolean; }

/** Mirrors every block in `sourceBlocks` (the OPPOSITE elevation's real
 *  blocks) into ghost boxes for the elevation being rendered — same id
 *  (so a hover on the ghost resolves to the same underlying row as the
 *  real block), ru, and height, tagged `isGhost: true`. Pure and exported
 *  for testing without mounting either elevation. */
export function ghostBlocksFor(sourceBlocks: RackBlock[]): DisplayBlock[] {
  return sourceBlocks.map((b) => ({ ...b, isGhost: true }));
}

export interface TooltipRow { label: string; value: string; }

/** Assembles the hover tooltip's detail rows below the name header: Serial,
 *  Make/Model, and RU always show; Category shows next, only when the
 *  asset's model has a category label; Position comes last and is omitted
 *  entirely when the side has no position note, or when it's just "front"
 *  (case-insensitive) — "front" is the unmarked default for most devices
 *  and would tell the viewer nothing a plain faceplate on the FRONT
 *  elevation doesn't already say, whereas "rear", "left", etc. are worth
 *  surfacing. Pure and exported so the suppression rules are testable
 *  without a hover/mount. */
export function tooltipRows(info: {
  serial: string | null | undefined;
  makeModel: string | null | undefined;
  ru: number | string;
  position: string | null | undefined;
  categoryLabel?: string | null | undefined;
  parentLabel?: string | null | undefined;
  orphan?: boolean;
}): TooltipRow[] {
  const rows: TooltipRow[] = [
    { label: 'Serial', value: info.serial ?? '—' },
    { label: 'Make/Model', value: info.makeModel || '—' },
    { label: 'RU', value: String(info.ru) },
  ];
  if (info.parentLabel) {
    rows.push({ label: 'Inside', value: info.parentLabel });
  }
  if (info.orphan) {
    rows.push({ label: 'Note', value: 'No device starts at this RU' });
  }
  if (info.categoryLabel) {
    rows.push({ label: 'Category', value: info.categoryLabel });
  }
  const position = info.position?.trim();
  if (position && position.toLowerCase() !== 'front') {
    rows.push({ label: 'Position', value: position });
  }
  return rows;
}


/** One complete, self-contained rack frame — posts, top/bottom caps,
 *  interior, per-U hairlines, U numbering on the left post, and this
 *  elevation's own faceplates (real devices mounted on this physical side,
 *  plus blank ghost boxes for devices mounted on the opposite side at the
 *  same RU — see `ghostBlocksFor`). Rendered twice by the modal below
 *  (FRONT always, REAR only when it has real blocks) rather than as two
 *  halves of one shared frame, so each reads as a complete elevation on
 *  its own — including when only one of the two is shown. */
export function RackElevation({
  heading, ariaLabel, blocks, onHoverBlock, onLeaveBlock, onHoverChild,
}: {
  heading: string;
  ariaLabel: string;
  blocks: DisplayBlock[];
  onHoverBlock?: (block: DisplayBlock, e: React.MouseEvent<SVGGElement>) => void;
  onLeaveBlock?: () => void;
  onHoverChild?: (block: DisplayBlock, child: RackChild, e: React.MouseEvent<SVGGElement>) => void;
}) {
  const geometry = new Map(
    laneGeometry(blocks, FACEPLATE_USABLE_WIDTH).map((g) => [g.id, g]),
  );
  const ruCount = rackRuCount(blocks);
  const { ruAreaHeight, totalHeight, ruList, yForRu, ruTop } = frameGeometry(ruCount);

  return (
    <div className="rack-elevation">
      <div className="rack-elevation-heading">{heading}</div>
      <svg viewBox={`0 0 ${ELEV_FRAME_WIDTH} ${totalHeight}`} className="rack-svg"
           role="img" aria-label={ariaLabel}>
        {/* frame: full-height posts + top/bottom caps, outlined line-work */}
        <rect x={0} y={0} width={POST_WIDTH} height={totalHeight} className="rack-post" />
        <rect x={ELEV_FRAME_WIDTH - POST_WIDTH} y={0} width={POST_WIDTH} height={totalHeight}
              className="rack-post" />
        <rect x={0} y={0} width={ELEV_FRAME_WIDTH} height={CAP_HEIGHT} className="rack-cap" />
        <rect x={0} y={totalHeight - CAP_HEIGHT} width={ELEV_FRAME_WIDTH} height={CAP_HEIGHT}
              className="rack-cap" />

        {/* interior + per-U hairlines */}
        <rect x={INTERIOR_LEFT} y={INTERIOR_TOP} width={INTERIOR_WIDTH}
              height={ruAreaHeight} className="rack-interior" />
        {Array.from({ length: ruCount + 1 }, (_, i) => i).map((i) => (
          <line key={i} x1={INTERIOR_LEFT} x2={INTERIOR_RIGHT}
                y1={INTERIOR_TOP + i * U_PX} y2={INTERIOR_TOP + i * U_PX}
                className="rack-u-hairline" />
        ))}

        {/* U numbering, both posts, centered in each (round 4 mirrored the
            right rail and dropped every-5 emphasis; round 5 centered both
            so single- vs. double-digit RUs no longer hug different edges).
            Posts otherwise stay clean outlined rails (round 3 dropped the
            cage-nut hole pattern entirely). */}
        <g className="rack-u-labels">
          {ruList.map((ru) => (
            <text key={ru} x={U_LABEL_X} y={ruTop(ru) + U_PX / 2} textAnchor="middle"
                  dominantBaseline="middle" className="rack-u-label">
              {ru}
            </text>
          ))}
        </g>
        <g className="rack-u-labels">
          {ruList.map((ru) => (
            <text key={ru} x={U_LABEL_X_RIGHT} y={ruTop(ru) + U_PX / 2} textAnchor="middle"
                  dominantBaseline="middle" className="rack-u-label">
              {ru}
            </text>
          ))}
        </g>

        {blocks.length === 0 ? (
          <text x={INTERIOR_LEFT + INTERIOR_WIDTH / 2} y={INTERIOR_TOP + ruAreaHeight / 2}
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
          if (b.isGhost) {
            // Blank box: no label, no category fill — just the outline
            // marking the space as occupied from the opposite side.
            return (
              <g key={b.id} onMouseEnter={onHoverBlock ? (e) => onHoverBlock(b, e) : undefined}
                 onMouseLeave={onLeaveBlock}>
                <rect x={x} y={y} width={width} height={height} rx={2}
                      className="rack-faceplate-ghost" />
              </g>
            );
          }
          const hasChildren = b.children.length > 0;
          // with nodes inside, the parent's label keeps the left half and the
          // slot pills take the right half
          const labelWidth = hasChildren ? width * 0.5 - 8 : width;
          const label = (b.orphan ? '! ' : '') + rackLabel(b.label, b.position, labelWidth);
          const fill = b.categoryColor ?? UNCATEGORIZED_FILL;
          const textColor = readableTextColor(fill);
          const border = b.orphan
            ? { stroke: '#b45309', strokeWidth: 1.5, strokeDasharray: '2 2' }
            : b.verified
              ? { stroke: '#15803d', strokeWidth: 2 }
              : { stroke: '#111827', strokeWidth: 1.25, strokeDasharray: '4 3' };
          const pillGap = 2;
          const pillAreaX = x + width * 0.5;
          const pillAreaWidth = width * 0.5 - 4;
          const pillWidth = Math.max(10,
            (pillAreaWidth - pillGap * (b.children.length - 1)) / Math.max(1, b.children.length));
          const pillHeight = Math.max(8, height - 4);
          const pillFill = textColor === '#ffffff' ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)';
          return (
            <g key={b.id} onMouseEnter={onHoverBlock ? (e) => onHoverBlock(b, e) : undefined}
               onMouseLeave={onLeaveBlock}>
              <rect x={x} y={y} width={width} height={height} rx={2}
                    fill={fill} {...border}
                    className={b.orphan ? 'rack-faceplate rack-faceplate-orphan' : 'rack-faceplate'} />
              <text x={x + 8} y={y + height / 2} dominantBaseline="middle"
                    fill={textColor} className="rack-block-label">
                {label}
              </text>
              {b.children.map((c, i) => {
                const px = pillAreaX + i * (pillWidth + pillGap);
                return (
                  <g key={c.id} role="img" aria-label={`Slot ${c.slot}: ${c.label}`}
                     className="rack-node"
                     onMouseEnter={onHoverChild ? (e) => { e.stopPropagation(); onHoverChild(b, c, e); } : undefined}>
                    <rect x={px} y={y + 2} width={pillWidth} height={pillHeight} rx={2}
                          fill={pillFill}
                          stroke={c.verified ? '#15803d' : textColor}
                          strokeWidth={0.75}
                          strokeDasharray={c.verified ? undefined : '2 2'} />
                    <text x={px + pillWidth / 2} y={y + 2 + pillHeight / 2}
                          textAnchor="middle" dominantBaseline="middle"
                          fill={textColor} className="rack-node-label">
                      {c.slot}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
