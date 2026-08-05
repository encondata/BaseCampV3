/**
 * ImageCropModal — global crop/reposition step for image uploads.
 * Drag to pan, slider or scroll-wheel to zoom, circular mask preview
 * for avatars (square output either way). Exports a JPEG blob at
 * outputSize² via canvas; the caller uploads it.
 */

import { useEffect, useRef, useState } from 'react';

const VIEW = 320;        // on-screen viewport (px)
const MAX_ZOOM = 4;      // multiplier over the cover-fit scale

interface Props {
  file: File;
  title?: string;
  round?: boolean;
  outputSize?: number;
  onCancel: () => void;
  onSave: (blob: Blob) => void;
}

export default function ImageCropModal({
  file, title = 'Position your photo', round = true, outputSize = 512,
  onCancel, onSave,
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(0);           // 0..100 → sMin..sMin*MAX_ZOOM
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // create/revoke paired inside the effect — survives StrictMode remounts
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    setDims(null);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const sMin = dims ? Math.max(VIEW / dims.w, VIEW / dims.h) : 1;
  const scale = sMin * Math.pow(MAX_ZOOM, zoom / 100);

  const clamp = (v: { x: number; y: number }, s = scale) => {
    if (!dims) return v;
    const mx = Math.max(0, (dims.w * s - VIEW) / 2);
    const my = Math.max(0, (dims.h * s - VIEW) / 2);
    return {
      x: Math.min(mx, Math.max(-mx, v.x)),
      y: Math.min(my, Math.max(-my, v.y)),
    };
  };

  const setZoomClamped = (z: number) => {
    const zz = Math.min(100, Math.max(0, z));
    setZoom(zz);
    const s = sMin * Math.pow(MAX_ZOOM, zz / 100);
    setOffset((o) => clamp(o, s));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setOffset(clamp({
      x: drag.current.ox + (e.clientX - drag.current.px),
      y: drag.current.oy + (e.clientY - drag.current.py),
    }));
  };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (e: React.WheelEvent) => {
    setZoomClamped(zoom - e.deltaY * 0.15);
  };

  const save = async () => {
    const img = imgRef.current;
    if (!img || !dims || saving) return;
    setSaving(true);
    // viewport center in source coords, then the square crop around it
    const cx = dims.w / 2 - offset.x / scale;
    const cy = dims.h / 2 - offset.y / scale;
    const half = VIEW / (2 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      img,
      cx - half, cy - half, half * 2, half * 2,
      0, 0, outputSize, outputSize,
    );
    canvas.toBlob((blob) => {
      if (blob) onSave(blob);
      else setSaving(false);
    }, 'image/jpeg', 0.92);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}>
      <div className="modal-card crop-card">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Cancel" onClick={onCancel}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body crop-body">
          <div
            className="crop-viewport"
            style={{ width: VIEW, height: VIEW }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          >
            {url && (
              <img
                ref={imgRef}
                src={url}
                alt=""
                draggable={false}
                onLoad={(e) => setDims({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })}
                style={dims ? {
                  width: dims.w * scale,
                  height: dims.h * scale,
                  left: VIEW / 2 + offset.x - (dims.w * scale) / 2,
                  top: VIEW / 2 + offset.y - (dims.h * scale) / 2,
                } : { opacity: 0 }}
              />
            )}
            <div className={`crop-mask ${round ? 'round' : ''}`} />
          </div>

          <div className="crop-zoom">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /></svg>
            <input
              type="range" min={0} max={100} value={zoom}
              onChange={(e) => setZoomClamped(Number(e.target.value))}
              aria-label="Zoom"
            />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6M11 8v6" /></svg>
          </div>
          <p className="crop-hint">Drag to reposition · scroll or slide to zoom</p>
        </div>
        <div className="modal-foot">
          <button className="btn-solid" onClick={() => void save()} disabled={saving || !dims}>
            {saving ? 'Saving…' : 'Save photo'}
          </button>
          <button className="mini-btn" onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
