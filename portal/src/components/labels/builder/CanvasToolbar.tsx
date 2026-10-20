/**
 * The bar over the builder canvas: the tools (select, static text, barcode,
 * QR code, box, line), zoom (out, in, fit, true size), the Grid / Snap /
 * Rulers toggles, the Align group (one element aligns to the label, two or
 * more to the first selected, the anchor; distribute needs three, match
 * size two) and the Field names / Sample values choice. Each button has a
 * hover tip (components/Tip.tsx) with its label and shortcut keys, and,
 * when it's off, why; no native `title`, so never two tooltips.
 */

import type { ReactNode } from 'react';

import { shortcutKeys as keysOf, type Platform } from '../../../labels/builder/shortcuts';
import Tip from '../../Tip';
import {
  canAlign, stepZoom, type AlignOp, type CanvasTool, type CanvasView, type Zoom,
} from './canvasActions';

export interface CanvasToolbarProps {
  tool: CanvasTool;
  onTool: (tool: CanvasTool) => void;
  /** The zoom on screen, in pixels per dot (`fit` resolved). */
  zoom: number;
  onZoom: (zoom: Zoom) => void;
  view: CanvasView;
  onView: (view: CanvasView) => void;
  selectionCount: number;
  onAlign: (op: AlignOp) => void;
  readOnly?: boolean;
  platform: Platform;
  /** Right-hand readout (label size, pointer position). */
  status?: ReactNode;
}

/** Why a control is off while an older version is open. */
const READ_ONLY_NOTE = 'An older version is open.';

const I = ({ d, fill = false }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={fill ? 'lbc-icon is-filled' : 'lbc-icon'}><path d={d} /></svg>
);

const TOOLS: { tool: CanvasTool; id: string; label: string; icon: ReactNode }[] = [
  { tool: 'select', id: 'tool.select', label: 'Select', icon: <I fill d="M4 2v11l3-3 2 4.5 1.8-.8-2-4.4H13z" /> },
  { tool: 'text', id: 'tool.text', label: 'Text', icon: <I d="M3 3.5h10M8 3.5V13M6 13h4" /> },
  { tool: 'barcode', id: 'tool.barcode', label: 'Barcode', icon: <I d="M2.5 3v10M5 3v10M6.5 3v10M9 3v10M11.5 3v10M13.5 3v10" /> },
  { tool: 'qr', id: 'tool.qr', label: 'QR code', icon: <I d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h1.5v1.5M12.5 12.5h1M9.5 13.5h1M13.5 9.5v1" /> },
  { tool: 'box', id: 'tool.box', label: 'Box', icon: <I d="M2.5 4.5h11v7h-11z" /> },
  { tool: 'line', id: 'tool.line', label: 'Line', icon: <I d="M2.5 13.5l11-11" /> },
];

const ALIGNS: { op: AlignOp; id: string | null; label: string; icon: ReactNode }[] = [
  { op: 'left', id: 'align.left', label: 'Align left', icon: <I d="M2.5 1.5v13M4.5 4h8v2.5h-8zM4.5 9.5h5V12h-5z" /> },
  { op: 'center', id: 'align.center', label: 'Align centers', icon: <I d="M8 1.5v13M3.5 4h9v2.5h-9zM5.5 9.5h5V12h-5z" /> },
  { op: 'right', id: 'align.right', label: 'Align right', icon: <I d="M13.5 1.5v13M3.5 4h8v2.5h-8zM6.5 9.5h5V12h-5z" /> },
  { op: 'top', id: 'align.top', label: 'Align top', icon: <I d="M1.5 2.5h13M4 4.5h2.5v8H4zM9.5 4.5H12v5H9.5z" /> },
  { op: 'middle', id: 'align.middle', label: 'Align middles', icon: <I d="M1.5 8h13M4 3.5h2.5v9H4zM9.5 5.5H12v5H9.5z" /> },
  { op: 'bottom', id: 'align.bottom', label: 'Align bottom', icon: <I d="M1.5 13.5h13M4 3.5h2.5v8H4zM9.5 6.5H12v5H9.5z" /> },
  { op: 'distributeH', id: 'align.distributeH', label: 'Distribute horizontally', icon: <I d="M1.5 2v12M14.5 2v12M6.5 4.5h3v7h-3z" /> },
  { op: 'distributeV', id: 'align.distributeV', label: 'Distribute vertically', icon: <I d="M2 1.5h12M2 14.5h12M4.5 6.5h7v3h-7z" /> },
  { op: 'matchW', id: null, label: 'Match width', icon: <I d="M3 3.5h10v3H3zM3 9.5h10v3H3z" /> },
  { op: 'matchH', id: null, label: 'Match height', icon: <I d="M3.5 3v10h3V3zM9.5 3v10h3V3z" /> },
];

/** What an align button's tooltip says it lines up on, by selection size. */
const TO_ANCHOR: Partial<Record<AlignOp, string>> = {
  left: 'Align left edges to the first selected',
  center: 'Align centers to the first selected',
  right: 'Align right edges to the first selected',
  top: 'Align top edges to the first selected',
  middle: 'Align middles to the first selected',
  bottom: 'Align bottom edges to the first selected',
  matchW: 'Match the first selected’s width',
  matchH: 'Match the first selected’s height',
};
const EDGES: readonly AlignOp[] = ['left', 'center', 'right', 'top', 'middle', 'bottom'];

function alignLabel(op: AlignOp, label: string, count: number): string {
  if (count >= 2) return TO_ANCHOR[op] ?? label;
  if (count === 1 && EDGES.includes(op)) return `${label} to the label`;
  return label;
}

/** Why an align button is off with this many selected (canAlign's rule):
 *  an edge needs one (it aligns to the label), match two, distribute three. */
function alignNote(op: AlignOp): string {
  if (op === 'distributeH' || op === 'distributeV') return 'Select three or more elements';
  if (op === 'matchW' || op === 'matchH') return 'Select two or more elements';
  return 'Select one or more elements';
}

export default function CanvasToolbar({
  tool, onTool, zoom, onZoom, view, onView, selectionCount, onAlign, readOnly = false, platform, status,
}: CanvasToolbarProps) {
  const toggle = (key: 'grid' | 'snap' | 'rulers', label: string, id: string) => (
    <Tip label={`${label} ${view[key] ? 'on' : 'off'}`} keys={keysOf(id, platform)}>
      <button type="button" className={`mini-btn lbc-toggle${view[key] ? ' on' : ''}`} aria-pressed={view[key]}
        onClick={() => onView({ ...view, [key]: !view[key] })}>
        {label}
      </button>
    </Tip>
  );
  return (
    <div className="lbc-toolbar" role="toolbar" aria-label="Canvas">
      <div className="segmented lbc-tools" role="group" aria-label="Tools">
        {TOOLS.map((t) => {
          const off = readOnly && t.tool !== 'select';
          return (
            <Tip key={t.tool} label={t.label} keys={keysOf(t.id, platform)} note={off ? READ_ONLY_NOTE : null}>
              <button type="button" className={tool === t.tool ? 'on' : ''} aria-pressed={tool === t.tool}
                aria-label={t.label} disabled={off} onClick={() => onTool(t.tool)}>
                {t.icon}
              </button>
            </Tip>
          );
        })}
      </div>

      <div className="lbc-group" role="group" aria-label="Zoom">
        <Tip label="Zoom out" keys={keysOf('canvas.zoomOut', platform)}>
          <button type="button" className="mini-btn lbc-icon-btn" aria-label="Zoom out"
            onClick={() => onZoom(stepZoom(zoom, 'out'))}>
            <I d="M3 8h10" />
          </button>
        </Tip>
        <span className="lbc-zoom" aria-live="polite">{`${Math.round(zoom * 100)}%`}</span>
        <Tip label="Zoom in" keys={keysOf('canvas.zoomIn', platform)}>
          <button type="button" className="mini-btn lbc-icon-btn" aria-label="Zoom in"
            onClick={() => onZoom(stepZoom(zoom, 'in'))}>
            <I d="M3 8h10M8 3v10" />
          </button>
        </Tip>
        <Tip label="Zoom to fit" keys={keysOf('canvas.fit', platform)}>
          <button type="button" className={`mini-btn${view.zoom === 'fit' ? ' on' : ''}`} aria-label="Fit"
            onClick={() => onZoom('fit')}>
            Fit
          </button>
        </Tip>
        <Tip label="True size, one dot a pixel" keys={keysOf('canvas.trueSize', platform)}>
          <button type="button" className={`mini-btn${view.zoom === 1 ? ' on' : ''}`} aria-label="True size"
            onClick={() => onZoom(1)}>
            1:1
          </button>
        </Tip>
      </div>

      <div className="lbc-group" role="group" aria-label="Guides">
        {toggle('grid', 'Grid', 'canvas.grid')}
        {toggle('snap', 'Snap', 'canvas.snap')}
        {toggle('rulers', 'Rulers', 'canvas.rulers')}
      </div>

      <div className="lbc-group" role="group" aria-label="Align">
        {ALIGNS.map((a) => {
          const note = readOnly ? READ_ONLY_NOTE : canAlign(a.op, selectionCount) ? null : alignNote(a.op);
          return (
            <Tip key={a.op} label={alignLabel(a.op, a.label, selectionCount)} keys={keysOf(a.id, platform)}
              note={note}>
              <button type="button" className="mini-btn lbc-icon-btn" aria-label={a.label}
                disabled={note !== null} onClick={() => onAlign(a.op)}>
                {a.icon}
              </button>
            </Tip>
          );
        })}
      </div>

      <div className="segmented lbc-show" role="group" aria-label="Show">
        <Tip label="Field names" keys={keysOf('canvas.samples', platform)}>
          <button type="button" className={view.showSamples ? '' : 'on'} aria-pressed={!view.showSamples}
            onClick={() => onView({ ...view, showSamples: false })}>
            Field names
          </button>
        </Tip>
        <Tip label="Sample values" keys={keysOf('canvas.samples', platform)}>
          <button type="button" className={view.showSamples ? 'on' : ''} aria-pressed={view.showSamples}
            onClick={() => onView({ ...view, showSamples: true })}>
            Sample values
          </button>
        </Tip>
      </div>

      {status && <span className="lbc-status">{status}</span>}
    </div>
  );
}
