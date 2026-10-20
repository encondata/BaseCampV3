/**
 * The bar over the builder canvas: the tools (select, static text, barcode,
 * QR code, box, line), zoom (out, in, fit, true size), the Grid / Snap /
 * Rulers toggles, the Align group (one element aligns to the label;
 * distribute needs three, match size two) and the Field names / Sample
 * values choice. Each control's tooltip carries its shortcut.
 */

import type { ReactNode } from 'react';

import { SHORTCUTS, type Platform } from '../../../labels/builder/shortcuts';
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

function keysOf(id: string, platform: Platform): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? (platform === 'mac' ? s.mac : s.win) : '';
}

function tip(label: string, id: string | null, platform: Platform): string {
  const keys = id ? keysOf(id, platform) : '';
  return keys ? `${label} · ${keys}` : label;
}

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

export default function CanvasToolbar({
  tool, onTool, zoom, onZoom, view, onView, selectionCount, onAlign, readOnly = false, platform, status,
}: CanvasToolbarProps) {
  const toggle = (key: 'grid' | 'snap' | 'rulers', label: string, id: string) => (
    <button type="button" className={`mini-btn lbc-toggle${view[key] ? ' on' : ''}`} aria-pressed={view[key]}
      title={tip(`${label} ${view[key] ? 'on' : 'off'}`, id, platform)} onClick={() => onView({ ...view, [key]: !view[key] })}>
      {label}
    </button>
  );
  return (
    <div className="lbc-toolbar" role="toolbar" aria-label="Canvas">
      <div className="segmented lbc-tools" role="group" aria-label="Tools">
        {TOOLS.map((t) => (
          <button key={t.tool} type="button" className={tool === t.tool ? 'on' : ''} aria-pressed={tool === t.tool}
            aria-label={t.label} title={tip(t.label, t.id, platform)} disabled={readOnly && t.tool !== 'select'}
            onClick={() => onTool(t.tool)}>
            {t.icon}
          </button>
        ))}
      </div>

      <div className="lbc-group" role="group" aria-label="Zoom">
        <button type="button" className="mini-btn lbc-icon-btn" aria-label="Zoom out"
          title={tip('Zoom out', 'canvas.zoomOut', platform)} onClick={() => onZoom(stepZoom(zoom, 'out'))}>
          <I d="M3 8h10" />
        </button>
        <span className="lbc-zoom" aria-live="polite">{`${Math.round(zoom * 100)}%`}</span>
        <button type="button" className="mini-btn lbc-icon-btn" aria-label="Zoom in"
          title={tip('Zoom in', 'canvas.zoomIn', platform)} onClick={() => onZoom(stepZoom(zoom, 'in'))}>
          <I d="M3 8h10M8 3v10" />
        </button>
        <button type="button" className={`mini-btn${view.zoom === 'fit' ? ' on' : ''}`} aria-label="Fit"
          title={tip('Zoom to fit', 'canvas.fit', platform)} onClick={() => onZoom('fit')}>
          Fit
        </button>
        <button type="button" className={`mini-btn${view.zoom === 1 ? ' on' : ''}`} aria-label="True size"
          title={tip('True size, one dot a pixel', 'canvas.trueSize', platform)} onClick={() => onZoom(1)}>
          1:1
        </button>
      </div>

      <div className="lbc-group" role="group" aria-label="Guides">
        {toggle('grid', 'Grid', 'canvas.grid')}
        {toggle('snap', 'Snap', 'canvas.snap')}
        {toggle('rulers', 'Rulers', 'canvas.rulers')}
      </div>

      <div className="lbc-group" role="group" aria-label="Align">
        {ALIGNS.map((a) => (
          <button key={a.op} type="button" className="mini-btn lbc-icon-btn" aria-label={a.label}
            title={tip(selectionCount === 1 && a.id?.startsWith('align.') && !a.op.startsWith('distribute')
              ? `${a.label} to the label` : a.label, a.id, platform)}
            disabled={readOnly || !canAlign(a.op, selectionCount)} onClick={() => onAlign(a.op)}>
            {a.icon}
          </button>
        ))}
      </div>

      <div className="segmented lbc-show" role="group" aria-label="Show">
        <button type="button" className={view.showSamples ? '' : 'on'} aria-pressed={!view.showSamples}
          title={tip('Field names', 'canvas.samples', platform)} onClick={() => onView({ ...view, showSamples: false })}>
          Field names
        </button>
        <button type="button" className={view.showSamples ? 'on' : ''} aria-pressed={view.showSamples}
          title={tip('Sample values', 'canvas.samples', platform)} onClick={() => onView({ ...view, showSamples: true })}>
          Sample values
        </button>
      </div>

      {status && <span className="lbc-status">{status}</span>}
    </div>
  );
}
