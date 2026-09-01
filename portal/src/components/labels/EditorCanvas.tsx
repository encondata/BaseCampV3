/**
 * SVG WYSIWYG canvas. viewBox is in inches so the element model renders
 * without unit conversion; on-screen scale is 96 css-px/in x zoom. The
 * canvas is layout-true but glyph-approximate: barcodes/QRs draw as
 * striped/crosshatched boxes with their data underneath — Labelary owns
 * printer-accurate rendering. Drag = pointer capture + client-px ->
 * inch conversion via the svg's bounding rect; commits go through
 * onPatch with snap() applied.
 *
 * Live drag/resize position is kept in a local overlay (not dispatched)
 * so intermediate pointermove frames never hit history — onPatch fires
 * once, on pointerUp, with the final geometry. This is what keeps undo
 * semantics sane (one history entry per drag, not one per pixel).
 */

import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import { clampToLabel, snap, type LabelDesign, type LabelEl } from '../../lib/labelModel';

const PPI = 96;
const GRID = 0.025;
const GRID_STEP = 0.25;

interface Props {
  design: LabelDesign;
  selectedId: string | null;
  hasTab: boolean;
  zoom: number;
  onSelect: (id: string | null) => void;
  onPatch: (id: string, patch: Partial<LabelEl>) => void;
}

interface DragState {
  id: string;
  px: number;
  py: number;
  ox: number;
  oy: number;
  ow: number;
  oh: number;
  mode: 'move' | 'resize';
}

interface Overlay { id: string; patch: Partial<LabelEl> }

export default function EditorCanvas({
  design, selectedId, hasTab, zoom, onSelect, onPatch,
}: Props) {
  const { w, h } = design.size;
  const px = w * PPI * zoom;
  const pxH = h * PPI * zoom;
  const drag = useRef<DragState | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  const liveEl = (el: LabelEl): LabelEl =>
    (overlay && overlay.id === el.id ? ({ ...el, ...overlay.patch } as LabelEl) : el);

  const commitDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    setOverlay((cur) => {
      if (cur && cur.id === d.id) {
        const el = design.elements.find((e) => e.id === d.id);
        if (el) {
          const merged = { ...el, ...cur.patch } as LabelEl;
          onPatch(d.id, { ...cur.patch, ...clampToLabel(merged, design.size) });
        }
      }
      return null;
    });
  };

  const startDrag = (el: LabelEl) => (e: PointerEvent<SVGGElement>) => {
    e.stopPropagation();
    onSelect(el.id);
    (e.currentTarget as unknown as { setPointerCapture?: (id: number) => void })
      .setPointerCapture?.(e.pointerId);
    drag.current = {
      id: el.id, px: e.clientX, py: e.clientY, ox: el.x, oy: el.y, ow: el.w, oh: el.h,
      mode: 'move',
    };
  };

  const startResize = (el: LabelEl) => (e: PointerEvent<SVGRectElement>) => {
    e.stopPropagation();
    onSelect(el.id);
    (e.currentTarget as unknown as { setPointerCapture?: (id: number) => void })
      .setPointerCapture?.(e.pointerId);
    drag.current = {
      id: el.id, px: e.clientX, py: e.clientY, ox: el.x, oy: el.y, ow: el.w, oh: el.h,
      mode: 'resize',
    };
  };

  const onPointerMove = (e: PointerEvent<SVGGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dxIn = (e.clientX - d.px) / (PPI * zoom);
    const dyIn = (e.clientY - d.py) / (PPI * zoom);
    if (d.mode === 'move') {
      setOverlay({ id: d.id, patch: { x: snap(d.ox + dxIn), y: snap(d.oy + dyIn) } });
    } else {
      setOverlay({
        id: d.id,
        patch: { w: Math.max(GRID, snap(d.ow + dxIn)), h: Math.max(GRID, snap(d.oh + dyIn)) },
      });
    }
  };

  const nudge = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!selectedId) return;
    const el = design.elements.find((e2) => e2.id === selectedId);
    if (!el) return;
    switch (e.key) {
      case 'ArrowLeft':
        onPatch(selectedId, { x: snap(el.x - GRID) });
        break;
      case 'ArrowRight':
        onPatch(selectedId, { x: snap(el.x + GRID) });
        break;
      case 'ArrowUp':
        onPatch(selectedId, { y: snap(el.y - GRID) });
        break;
      case 'ArrowDown':
        onPatch(selectedId, { y: snap(el.y + GRID) });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const gridLines: JSX.Element[] = [];
  for (let gx = GRID_STEP; gx < w; gx += GRID_STEP) {
    gridLines.push(<line key={`gv${gx}`} x1={gx} y1={0} x2={gx} y2={h} className="lbl-grid" />);
  }
  for (let gy = GRID_STEP; gy < h; gy += GRID_STEP) {
    gridLines.push(<line key={`gh${gy}`} x1={0} y1={gy} x2={w} y2={gy} className="lbl-grid" />);
  }

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={px}
      height={pxH}
      tabIndex={0}
      onKeyDown={nudge}
      className="lbl-canvas"
    >
      <rect data-canvas-bg width={w} height={h} className="lbl-bg" onPointerDown={() => onSelect(null)} />
      {gridLines}
      {hasTab && <rect x={0} y={0} width={w} height={0.5} className="lbl-tab" />}
      {design.elements.map((raw) => {
        const el = liveEl(raw);
        const selected = el.id === selectedId;
        const handleSide = 0.08 / zoom;
        return (
          <g
            key={el.id}
            data-el-id={el.id}
            transform={`rotate(${el.rotation} ${el.x} ${el.y})`}
            onPointerDown={startDrag(el)}
            onPointerMove={onPointerMove}
            onPointerUp={commitDrag}
            onPointerCancel={commitDrag}
          >
            {renderShape(el)}
            {selected && (
              <>
                <rect className="lbl-selected" x={el.x} y={el.y} width={el.w} height={el.h} />
                <rect
                  data-resize-handle
                  x={el.x + el.w - handleSide}
                  y={el.y + el.h - handleSide}
                  width={handleSide}
                  height={handleSide}
                  className="lbl-selected"
                  onPointerDown={startResize(el)}
                />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function renderShape(el: LabelEl) {
  switch (el.type) {
    case 'text': {
      const fontSize = el.fontSizePt / 72;
      const anchor = el.align === 'center' ? 'middle' : el.align === 'right' ? 'end' : 'start';
      const tx = el.align === 'center' ? el.x + el.w / 2 : el.align === 'right' ? el.x + el.w : el.x;
      return (
        <text
          x={tx}
          y={el.y + fontSize}
          fontSize={fontSize}
          fontWeight={el.bold ? 700 : 400}
          textAnchor={anchor}
        >
          {el.content}
        </text>
      );
    }
    case 'barcode': {
      const bars = [];
      const n = 12;
      const barW = el.w / (n * 2);
      for (let i = 0; i < n; i += 1) {
        const bx = el.x + (i * 2 + 0.5) * barW;
        bars.push(
          <rect key={i} x={bx} y={el.y + 0.02} width={barW} height={Math.max(0, el.h - 0.04)}
                fill="#2b2f33" />,
        );
      }
      return (
        <>
          <rect x={el.x} y={el.y} width={el.w} height={el.h} className="lbl-barcode" />
          {bars}
          {el.showText && (
            <text x={el.x + el.w / 2} y={el.y + el.h + 0.12} fontSize={0.1} textAnchor="middle">
              {el.data}
            </text>
          )}
        </>
      );
    }
    case 'qr':
      return (
        <>
          <rect x={el.x} y={el.y} width={el.w} height={el.h} className="lbl-qr" />
          <line x1={el.x} y1={el.y} x2={el.x + el.w} y2={el.y + el.h} className="lbl-qr" />
          <line x1={el.x + el.w} y1={el.y} x2={el.x} y2={el.y + el.h} className="lbl-qr" />
          <text x={el.x + el.w / 2} y={el.y + el.h + 0.12} fontSize={0.1} textAnchor="middle">
            {el.data}
          </text>
        </>
      );
    case 'line':
      return (
        <line x1={el.x} y1={el.y} x2={el.x + el.w} y2={el.y + el.h}
              strokeWidth={el.strokeIn} stroke="#2b2f33" fill="none" />
      );
    case 'box':
      return (
        <rect x={el.x} y={el.y} width={el.w} height={el.h}
              strokeWidth={el.strokeIn} stroke="#2b2f33" fill="none" />
      );
    default:
      return null;
  }
}
