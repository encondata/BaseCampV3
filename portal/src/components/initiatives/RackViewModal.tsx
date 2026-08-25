/**
 * RackViewModal — SVG rack elevation for one Source/Destination rack on a
 * move (Task 6, docs/superpowers/specs/2026-08-25-move-assets-design.md's
 * "Rack view" section). Opened by clicking a non-empty rack cell on the
 * Assets table (InitiativeDetail.tsx); the placement math itself lives in
 * lib/initiatives.ts's `rackLayout` so it's unit-testable without jsdom —
 * this component only turns those blocks into SVG geometry.
 */
import { useEffect } from 'react';

import { rackLayout } from '../../lib/initiatives';
import type { InitiativeAssetRow } from '../../lib/api';

const RU_COUNT = 54;
const RU_PX = 18;
const FRAME_LEFT = 56; // room for the RU scale down the left edge
const FRAME_RIGHT = 16;
const FRAME_WIDTH = 320;
const RACK_HEIGHT = RU_COUNT * RU_PX;
const LANE_PX = 14; // horizontal offset step for overlapping blocks

/** Greedy interval-graph "lane" assignment for blocks that overlap in RU
 *  range — same idea as calendar-view event columns: walk blocks lowest-RU
 *  first, and give each the first lane whose current occupant no longer
 *  overlaps it. Kept simple (no lane count cap, no re-balancing) since a
 *  single rack rarely has more than a couple of asset collisions at once;
 *  overlapping blocks just nudge right and shrink slightly to stay legible. */
function assignLanes(blocks: { id: string; ru: number; height: number }[]): Map<string, number> {
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

/** y (SVG, top-down) for the bottom edge of RU `ru` — RU 1 sits at the
 *  bottom of the elevation, so higher RU numbers move up (smaller y). */
const yForRu = (ru: number) => RACK_HEIGHT - (ru - 1) * RU_PX;

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

  const blocks = rackLayout(rows, rackName, side);
  const lanes = assignLanes(blocks);
  const laneCount = Math.max(1, ...blocks.map((b) => (lanes.get(b.id) ?? 0) + 1));
  const usableWidth = FRAME_WIDTH - FRAME_LEFT - FRAME_RIGHT;
  const laneWidth = Math.max(40, usableWidth - (laneCount - 1) * LANE_PX);

  const scaleMarks: number[] = [];
  for (let ru = 5; ru < RU_COUNT; ru += 5) scaleMarks.push(ru);

  const sideLabel = side === 'source' ? 'Source' : 'Destination';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card rack-modal-card">
        <div className="modal-head">
          <h3>Rack {rackName} — {sideLabel}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body rack-modal-body">
          {blocks.length === 0
            ? <p className="page-hint">No assets on this move are racked here.</p>
            : (
              <div className="rack-svg-wrap">
                <svg viewBox={`0 0 ${FRAME_WIDTH} ${RACK_HEIGHT}`} className="rack-svg"
                     role="img" aria-label={`Rack ${rackName} elevation, ${sideLabel.toLowerCase()}`}>
                  <rect x={FRAME_LEFT} y={0} width={usableWidth} height={RACK_HEIGHT}
                        className="rack-frame" />
                  {scaleMarks.map((ru) => (
                    <g key={ru}>
                      <line x1={FRAME_LEFT} y1={yForRu(ru)} x2={FRAME_LEFT + usableWidth}
                            y2={yForRu(ru)} className="rack-scale-tick" />
                      <text x={FRAME_LEFT - 8} y={yForRu(ru)} textAnchor="end"
                            dominantBaseline="middle" className="rack-scale-label">
                        {ru}
                      </text>
                    </g>
                  ))}
                  {blocks.map((b) => {
                    const lane = lanes.get(b.id) ?? 0;
                    const x = FRAME_LEFT + lane * (laneWidth + LANE_PX);
                    const height = b.height * RU_PX;
                    const y = yForRu(b.ru + b.height);
                    return (
                      <g key={b.id}>
                        <rect x={x} y={y} width={laneWidth} height={height}
                              rx={3}
                              className={`rack-block ${b.verified ? 'rack-block-verified'
                                : 'rack-block-outline'}`} />
                        <text x={x + 6} y={y + height / 2 - (b.position ? 6 : 0)}
                              dominantBaseline="middle" className="rack-block-label">
                          {b.label}
                        </text>
                        {b.position && (
                          <text x={x + 6} y={y + height / 2 + 10}
                                dominantBaseline="middle" className="rack-block-position">
                            {b.position}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
