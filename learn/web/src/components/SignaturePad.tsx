/** A signature drawn with a finger or a mouse. Reports the PNG as base64
 *  (no data: prefix) after every stroke, and null once cleared. The pad
 *  stays blank-aware: nothing is reported until something is drawn. */
import { useEffect, useRef } from 'react';

import { t } from '../lib/i18n';

const INK = '#1f3a8a';
const HEIGHT = 140;

export default function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    // a sharp backing store at the screen's pixel density
    const ratio = window.devicePixelRatio || 1;
    const width = el.getBoundingClientRect().width || 300;
    el.width = Math.round(width * ratio);
    el.height = Math.round(HEIGHT * ratio);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    drawing.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable: strokes still draw */ }
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    // a tap leaves a dot
    ctx.lineTo(x + 0.01, y);
    ctx.stroke();
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    const url = e.currentTarget.toDataURL('image/png');
    onChange(url.replace(/^data:image\/png;base64,/, ''));
  };

  const clear = () => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (el && ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.restore();
    }
    onChange(null);
  };

  return (
    <div className="learn-sigpad">
      <canvas ref={canvas} aria-label={t('reader.drawSignature')} style={{ blockSize: HEIGHT }}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <button type="button" className="learn-link" onClick={clear}>{t('reader.clear')}</button>
    </div>
  );
}
