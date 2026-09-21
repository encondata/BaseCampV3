/**
 * RackViewModal — SVG rack elevation(s) for one Source/Destination rack on
 * a move (Task 6, docs/superpowers/specs/2026-08-25-move-assets-design.md's
 * "Rack view" section). Opened by clicking a non-empty rack cell on the
 * Assets table (InitiativeDetail.tsx); the placement math itself lives in
 * lib/initiatives.ts's `rackLayout` so it's unit-testable without jsdom,
 * and the SVG geometry lives in `RackElevation` (RackElevation.tsx),
 * shared verbatim with the report worker's server-side renderer. What is
 * left here is the hover state, the tooltip, the device manifest beside
 * the elevations, the category legend, the Print layout sheet and the
 * modal chrome; the helpers are re-exported below so existing importers
 * (and their tests) keep resolving them through this module.
 *
 * Print-friendly redesign: two independent, self-contained rack frames
 * (FRONT and REAR) side by side, each with its own posts/caps and U
 * numbering (clean outlined rails — no cage-nut hole pattern). Faceplates
 * are filled with the asset's category color (contrast-picked label text
 * via `readableTextColor`, uncategorized assets fall back to
 * `UNCATEGORIZED_FILL`), with verified vs. planned kept distinguishable
 * even in grayscale by border alone — solid green for verified, dashed
 * dark for planned — rather than by fill or an LED (see RackElevation).
 * The REAR frame is omitted entirely — not just emptied — when no asset in
 * this rack/side carries a "rear" position note. Each elevation also
 * shows a blank "ghost" box for every asset actually mounted on the
 * OPPOSITE physical side at the same RU/height, so occupied space reads
 * correctly from both faces of the rack (see `ghostBlocksFor`).
 * A side whose devices house nodes gets a SECOND frame right after it —
 * "FRONT · NODES" / "REAR · NODES" — drawing each node as its own cell
 * filling an equal share of its chassis's RU span (`nodeBlocks`), with
 * the side's child-less devices as blank ghosts for RU context. The
 * devices frame draws every chassis as an ordinary faceplate: the nodes
 * are never marked on it. Hover
 * detail (name/serial/make-model/RU/category/position, the last two
 * omitted when they wouldn't add information — see `tooltipRows`) is a
 * real HTML tooltip positioned off each faceplate's (or ghost's) bounding
 * rect, not a native `<title>` tooltip.
 */
import { useRef, useState, useEffect } from 'react';

import {
  rackLayout, nodeBlocks, deviceListRows, legendCategories,
} from '../../lib/initiatives';
import type { InitiativeAssetRow } from '../../lib/api';
import { buildRackPrintHtml } from '../../lib/rackPrint';

import RackDeviceList from './RackDeviceList';
import {
  RackElevation, ghostBlocksFor, isRearPosition, tooltipRows,
} from './RackElevation';
import type { DisplayBlock } from './RackElevation';

export {
  FACEPLATE_USABLE_WIDTH, assignLanes, ghostBlocksFor, isRearPosition, laneGeometry,
  nodeColumnGeometry, rackLabel, tooltipRows,
} from './RackElevation';
export type { DisplayBlock, LaneRect, NodeColumnRect, TooltipRow } from './RackElevation';

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
  // Rows assigned to this rack but with no usable RU (0 or blank) are never
  // drawn — say so, or an all-unplaced rack reads as "no assets" while the
  // table clearly shows assets on it.
  const rackKey = side === 'source' ? 'source_rack' : 'destination_rack';
  // Nodes live in `blocks[].children`, not in `blocks` — count them as
  // drawn or every attached node reads as "assigned without an RU".
  const drawn = blocks.length + blocks.reduce((n, b) => n + b.children.length, 0);
  const unplaced = rows.filter((r) => r[rackKey] === rackName).length - drawn;
  const frontBlocks = blocks.filter((b) => !isRearPosition(b.position));
  const rearBlocks = blocks.filter((b) => isRearPosition(b.position));
  // REAR renders only when a REAL rear-mounted asset exists — unaffected
  // by ghosts, per the spec: a rack with only front devices never shows a
  // rear elevation full of nothing but their ghosts.
  const showRear = rearBlocks.length > 0;
  const frontDisplay: DisplayBlock[] = [...frontBlocks, ...ghostBlocksFor(rearBlocks)];
  const rearDisplay: DisplayBlock[] = [...rearBlocks, ...ghostBlocksFor(frontBlocks)];
  // Nodes get their own elevation per side rather than markings on the
  // chassis faceplate: the node cells fill their chassis's RU span, and
  // every child-less device of that side comes along as a blank ghost so
  // the frame still reads against the same rack.
  const frontNodes = nodeBlocks(frontBlocks);
  const rearNodes = nodeBlocks(rearBlocks);
  const nodeDisplay = (sideBlocks: typeof blocks, cells: typeof blocks): DisplayBlock[] =>
    [...cells, ...ghostBlocksFor(sideBlocks.filter((b) => b.children.length === 0))];
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const listRows = deviceListRows(frontBlocks, rearBlocks);
  const categories = legendCategories(blocks);

  const place = (e: React.MouseEvent<SVGGElement>) => {
    const container = containerRef.current;
    if (!container) return null;
    const targetRect = e.currentTarget.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      x: targetRect.left - containerRect.left + targetRect.width / 2,
      y: targetRect.top - containerRect.top,
    };
  };
  const handleHover = (block: DisplayBlock, e: React.MouseEvent<SVGGElement>) => {
    const at = place(e);
    if (at) setHover({ block, ...at });
  };
  const handleLeave = () => setHover(null);

  const sideLabel = side === 'source' ? 'Source' : 'Destination';

  const handlePrint = () => {
    // Read the frames off the rendered DOM — heading and SVG together —
    // so the sheet captions whatever is actually on screen (FRONT, FRONT ·
    // NODES, REAR, REAR · NODES) without re-deriving the conditions here.
    const frames = [...(containerRef.current?.querySelectorAll('.rack-elevation') ?? [])]
      .map((el) => ({
        heading: el.querySelector('.rack-elevation-heading')?.textContent ?? '',
        svg: el.querySelector('.rack-svg')?.outerHTML ?? '',
      }))
      .filter((f) => f.svg);
    const win = window.open('', '_blank');
    if (!win) return; // popup blocked — quiet no-op
    win.document.write(buildRackPrintHtml({
      rackName, sideLabel, frames, listRows, grouped: showRear,
      legend: categories,
    }));
    win.document.close();
  };

  // A node cell's id IS its roster row's id (see `nodeBlocks`), so one
  // lookup serves every kind of cell — chassis, node, orphan or ghost.
  const hoveredRow = hover ? rowsById.get(hover.block.id) : undefined;
  const hoveredAsset = hoveredRow?.asset;
  const hoveredMakeModel = hoveredAsset
    ? [hoveredAsset.model_make, hoveredAsset.model_name].filter(Boolean).join(' ')
    : '';
  // A node cell is drawn on its CHASSIS's face, so its block carries the
  // chassis's position; the node's own side note lives on its roster row.
  const hoveredPosition = hoveredRow
    ? (side === 'source' ? hoveredRow.source_position : hoveredRow.destination_position)
    : hover?.block.position ?? null;
  const hoveredRows = hover ? tooltipRows({
    serial: hoveredAsset?.serial_number,
    makeModel: hoveredMakeModel,
    ru: hover.block.parentRu !== undefined
      ? `${hover.block.parentRu}.${hover.block.slot}`
      : hover.block.orphan ? `${hover.block.ru}.${hover.block.slot}` : hover.block.ru,
    position: hoveredPosition,
    categoryLabel: hover.block.categoryLabel,
    parentLabel: hover.block.parentLabel ?? null,
    orphan: hover.block.orphan,
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
            {frontNodes.length > 0 && (
              <RackElevation
                heading="FRONT · NODES" blocks={nodeDisplay(frontBlocks, frontNodes)}
                ariaLabel={`Rack ${rackName} — ${sideLabel} — front nodes elevation`}
                onHoverBlock={handleHover} onLeaveBlock={handleLeave}
              />
            )}
            {showRear && (
              <RackElevation
                heading="REAR" blocks={rearDisplay}
                ariaLabel={`Rack ${rackName} — ${sideLabel} — rear elevation`}
                onHoverBlock={handleHover} onLeaveBlock={handleLeave}
              />
            )}
            {showRear && rearNodes.length > 0 && (
              <RackElevation
                heading="REAR · NODES" blocks={nodeDisplay(rearBlocks, rearNodes)}
                ariaLabel={`Rack ${rackName} — ${sideLabel} — rear nodes elevation`}
                onHoverBlock={handleHover} onLeaveBlock={handleLeave}
              />
            )}
            <RackDeviceList rows={listRows} grouped={showRear} />
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
          {unplaced > 0 && (
            <p className="rack-unplaced-note" role="status">
              {unplaced} {unplaced === 1 ? 'asset is' : 'assets are'} assigned to this rack
              without a RU position (RU 0) and {unplaced === 1 ? 'is' : 'are'} not drawn.
            </p>
          )}
          <div className="rack-legend" aria-hidden="true">
            {categories.map((c) => (
              <span key={c.label} className="rack-legend-item">
                <span className="rack-legend-swatch" style={{ background: c.color }} />
                {c.label}
              </span>
            ))}
            <span className="rack-legend-item">
              <span className="rack-legend-swatch rack-legend-swatch-verified" />
              Verified
            </span>
            <span className="rack-legend-item">
              <span className="rack-legend-swatch rack-legend-swatch-planned" />
              Planned
            </span>
          </div>
          <button className="mini-btn" type="button" onClick={handlePrint}>
            Print layout
          </button>
        </div>
      </div>
    </div>
  );
}
