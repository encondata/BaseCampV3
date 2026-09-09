/**
 * RackViewModal — SVG rack elevation(s) for one Source/Destination rack on
 * a move (Task 6, docs/superpowers/specs/2026-08-25-move-assets-design.md's
 * "Rack view" section). Opened by clicking a non-empty rack cell on the
 * Assets table (InitiativeDetail.tsx); the placement math itself lives in
 * lib/initiatives.ts's `rackLayout` so it's unit-testable without jsdom,
 * and the SVG geometry lives in `RackElevation` (RackElevation.tsx),
 * shared verbatim with the report worker's server-side renderer. What is
 * left here is the hover state, the tooltip and the modal chrome; the
 * helpers are re-exported below so existing importers (and their tests)
 * keep resolving them through this module.
 *
 * Print-friendly redesign: two independent, self-contained rack frames
 * (FRONT and REAR) side by side, each with its own posts/caps and U
 * numbering (clean outlined rails — no cage-nut hole pattern), rendered in
 * a light, high-contrast, grayscale-safe palette (no gradients, no
 * color-only distinctions) so it holds up printed on paper. The REAR
 * frame is omitted entirely — not just emptied — when no asset in this
 * rack/side carries a "rear" position note. Each elevation also shows a
 * blank "ghost" box for every asset actually mounted on the OPPOSITE
 * physical side at the same RU/height, so occupied space reads correctly
 * from both faces of the rack (see `ghostBlocksFor`). Hover detail
 * (name/serial/make-model/RU/position, the last omitted when it wouldn't
 * add information — see `tooltipRows`) is a real HTML tooltip positioned
 * off each faceplate's (or ghost's) bounding rect, not a native `<title>`
 * tooltip.
 */
import { useRef, useState, useEffect } from 'react';

import { rackLayout } from '../../lib/initiatives';
import type { InitiativeAssetRow } from '../../lib/api';

import {
  RackElevation, ghostBlocksFor, isRearPosition, tooltipRows,
} from './RackElevation';
import type { DisplayBlock } from './RackElevation';

export {
  FACEPLATE_USABLE_WIDTH, assignLanes, ghostBlocksFor, isRearPosition, laneGeometry,
  rackLabel, tooltipRows,
} from './RackElevation';
export type { DisplayBlock, LaneRect, TooltipRow } from './RackElevation';

interface HoverState { block: DisplayBlock; x: number; y: number; }

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
  // REAR renders only when a REAL rear-mounted asset exists — unaffected
  // by ghosts, per the spec: a rack with only front devices never shows a
  // rear elevation full of nothing but their ghosts.
  const showRear = rearBlocks.length > 0;
  const frontDisplay: DisplayBlock[] = [...frontBlocks, ...ghostBlocksFor(rearBlocks)];
  const rearDisplay: DisplayBlock[] = [...rearBlocks, ...ghostBlocksFor(frontBlocks)];
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  const handleHover = (block: DisplayBlock, e: React.MouseEvent<SVGGElement>) => {
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
  const hoveredRows = hover ? tooltipRows({
    serial: hoveredAsset?.serial_number,
    makeModel: hoveredMakeModel,
    ru: hover.block.ru,
    position: hover.block.position,
  }) : [];

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card rack-modal-card">
        <div className="modal-head">
          <div className="rack-modal-title">
            <h3>Rack {rackName} — {sideLabel}</h3>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body rack-modal-body">
          <div className="rack-elevations" ref={containerRef}>
            <RackElevation
              heading="FRONT" blocks={frontDisplay}
              ariaLabel={`Rack ${rackName} — ${sideLabel} — front elevation`}
              onHoverBlock={handleHover} onLeaveBlock={handleLeave}
            />
            {showRear && (
              <RackElevation
                heading="REAR" blocks={rearDisplay}
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
                  {hoveredRows.flatMap((row) => [
                    <dt key={`${row.label}-dt`}>{row.label}</dt>,
                    <dd key={`${row.label}-dd`}>{row.value}</dd>,
                  ])}
                </dl>
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot rack-modal-foot">
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
      </div>
    </div>
  );
}
