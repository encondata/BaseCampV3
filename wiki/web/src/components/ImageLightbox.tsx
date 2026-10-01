/** A full-screen viewer for an image on a page: opens fitted to the screen,
 *  zooms with the wheel (toward the cursor), a pinch, double-click, the
 *  toolbar or + / − / 0, and pans by dragging once zoomed. Esc, Close or a
 *  click beside the image closes it (no "Open original" or context menu
 *  when printing is off: CanPrintContext). Portaled to <body>, above the page. */
import {
  useCallback, useEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { useCanPrint } from '../lib/printPolicy';
import { clampView, FIT, zoomAt, type Point, type ZoomView } from '../lib/zoomView';

const STEP = 1.5;
const DOUBLE_CLICK_SCALE = 2.5;

type Props = { src: string; alt: string; caption: string; onClose: () => void };

function Svg({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

export default function ImageLightbox({ src, alt, caption, onClose }: Props) {
  const canPrint = useCanPrint();
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<ZoomView>(FIT);
  const [natural, setNatural] = useState(0);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ moved: boolean; pinch: number | null }>({ moved: false, pinch: null });

  /** A client position as an offset from the stage's center. */
  const toStage = useCallback((clientX: number, clientY: number): Point => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  }, []);

  const settle = useCallback((next: ZoomView): ZoomView => {
    const img = imgRef.current, stage = stageRef.current;
    if (!img || !stage) return next;
    return clampView(next, { width: img.offsetWidth, height: img.offsetHeight },
                     { width: stage.clientWidth, height: stage.clientHeight });
  }, []);

  const zoomTo = useCallback((scale: number, point: Point = { x: 0, y: 0 }) => {
    setView((v) => settle(zoomAt(v, scale, point)));
  }, [settle]);

  // keyboard, focus and the page behind
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === '+' || e.key === '=') setView((v) => settle(zoomAt(v, v.scale * STEP, { x: 0, y: 0 })));
      else if (e.key === '-') setView((v) => settle(zoomAt(v, v.scale / STEP, { x: 0, y: 0 })));
      else if (e.key === '0') setView(FIT);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, [onClose, settle]);

  // the wheel zooms toward the cursor (a native listener: React's is passive)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)); // trackpad pinch sends ctrl
      const point = toStage(e.clientX, e.clientY);
      setView((v) => settle(zoomAt(v, v.scale * factor, point)));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [settle, toStage]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.wiki-lightbox-bar')) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current.moved = false;
    gesture.current.pinch = null;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(e.pointerId);
    if (!last) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, now);
    const all = [...pointers.current.values()];
    if (all.length >= 2) {
      const [a, b] = all;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const prev = gesture.current.pinch;
      gesture.current.pinch = dist;
      gesture.current.moved = true;
      if (prev) {
        const mid = toStage((a.x + b.x) / 2, (a.y + b.y) / 2);
        setView((v) => settle(zoomAt(v, v.scale * (dist / prev), mid)));
      }
      return;
    }
    const dx = now.x - last.x, dy = now.y - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) gesture.current.moved = true;
    setView((v) => (v.scale > 1 ? settle({ ...v, x: v.x + dx, y: v.y + dy }) : v));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinch = null;
  };

  const onStageClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const moved = gesture.current.moved;
    gesture.current.moved = false;
    if (!moved && e.target === e.currentTarget) onClose();
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (view.scale > 1) setView(FIT);
    else zoomTo(DOUBLE_CLICK_SCALE, toStage(e.clientX, e.clientY));
  };

  const fitted = imgRef.current?.offsetWidth ?? 0;
  const percent = natural > 0 && fitted > 0 ? Math.round((fitted * view.scale * 100) / natural) : null;
  const label = caption || alt || 'Image';

  return createPortal(
    <div className="wiki-lightbox" role="dialog" aria-modal="true" aria-label={label}>
      <div className="wiki-lightbox-bar">
        <span className="wiki-lightbox-title">{caption || alt}</span>
        <div className="wiki-lightbox-tools">
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" disabled={view.scale <= 1}
                  onClick={() => zoomTo(view.scale / STEP)}><Svg d="M5 12h14" /></button>
          <span className="wiki-lightbox-pct" aria-live="polite">{percent === null ? '' : `${percent}%`}</span>
          <button type="button" aria-label="Zoom in" title="Zoom in (+)"
                  onClick={() => zoomTo(view.scale * STEP)}><Svg d="M12 5v14M5 12h14" /></button>
          <button type="button" aria-label="Fit to screen" title="Fit to screen (0)" disabled={view.scale <= 1}
                  onClick={() => setView(FIT)}>
            <Svg d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </button>
          {canPrint && (
            <a href={src} target="_blank" rel="noopener noreferrer" aria-label="Open original" title="Open original">
              <Svg d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            </a>
          )}
          <button ref={closeRef} type="button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <Svg d="M6 6l12 12M18 6L6 18" />
          </button>
        </div>
      </div>
      <div ref={stageRef} className={`wiki-lightbox-stage${view.scale > 1 ? ' is-zoomed' : ''}`}
           data-testid="lightbox-stage" onClick={onStageClick}
           onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <img ref={imgRef} src={src} alt={alt} draggable={false}
             style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
             onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
             onDoubleClick={onDoubleClick} {...(canPrint ? {} : { onContextMenu: (e) => e.preventDefault() })} />
      </div>
    </div>,
    document.body,
  );
}
