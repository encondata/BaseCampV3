/** A PDF drawn onto <canvas> elements with pdf.js, for a file whose
 *  printing is off: unlike the browser's own viewer there's no toolbar, no
 *  print or download button, no selectable text and no links, and the
 *  context menu is off. Every page gets a placeholder sized from its own
 *  shape, scaled to the container's width; only pages within about a screen
 *  of the viewport are drawn, and ones that scroll far away are freed again,
 *  so a long PDF can't exhaust a tablet's canvas memory. pdf.js (the legacy
 *  build, for older tablets) loads on first use: it's a large chunk nobody
 *  else needs. Fetching the file is a cross-origin request, unlike an
 *  iframe's, so the storage bucket must allow this origin (CORS GET). */
import { useEffect, useRef, useState } from 'react';

const FALLBACK_WIDTH = 800;
/** Pages drawn up front where the browser has no IntersectionObserver. */
const FALLBACK_PAGES = 3;
const MAX_PIXEL_RATIO = 2;

type Status = 'loading' | 'ready' | 'partial' | 'error';
interface Slot {
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  state: 'idle' | 'drawing' | 'drawn';
  cancel?: () => void;
}

export default function PdfCanvasViewer({ url, title }: { url: string; title?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let live = true;
    let task: { destroy: () => Promise<void> | void } | undefined;
    let observer: IntersectionObserver | undefined;
    const slots: Slot[] = [];
    setStatus('loading');
    host.replaceChildren();

    (async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ]);
      if (!live) return;
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const loading = pdfjs.getDocument({ url, isEvalSupported: false });
      task = loading;
      const doc = await loading.promise;
      if (!live) return;
      const width = host.clientWidth || FALLBACK_WIDTH;
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

      // a placeholder per page, sized from its shape, so the scroll height is right
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        if (!live) return;
        const { width: w, height: h } = page.getViewport({ scale: 1 });
        page.cleanup();
        const wrap = document.createElement('div');
        wrap.className = 'wiki-pdf-page';
        wrap.style.aspectRatio = `${w} / ${h}`;
        const canvas = document.createElement('canvas');
        canvas.width = 0;
        canvas.height = 0;
        canvas.className = 'wiki-pdf-canvas';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
        wrap.appendChild(canvas);
        host.appendChild(wrap);
        slots.push({ wrap, canvas, state: 'idle' });
      }

      const wanted = new Set<number>();
      let drawnAny = false;
      let failed = false;
      let pumping = false;

      const free = (i: number) => {
        const slot = slots[i];
        slot.cancel?.();
        slot.cancel = undefined;
        slot.canvas.width = 0;
        slot.canvas.height = 0;
        slot.state = 'idle';
      };

      const draw = async (i: number) => {
        const slot = slots[i];
        slot.state = 'drawing';
        const page = await doc.getPage(i + 1);
        if (!live || slot.state !== 'drawing') { page.cleanup(); return; }
        const scale = width / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale: scale * ratio });
        slot.canvas.width = Math.floor(viewport.width);
        slot.canvas.height = Math.floor(viewport.height);
        const canvasContext = slot.canvas.getContext('2d');
        if (!canvasContext) throw new Error('no canvas context');
        const rendering = page.render({ canvasContext, viewport });
        slot.cancel = () => rendering.cancel();
        try {
          await rendering.promise;
          slot.state = 'drawn';
          drawnAny = true;
        } catch (err) {
          // scrolled far away mid-draw: freed on purpose, not a failure
          if (slot.state !== 'drawing') return;
          throw err;
        } finally {
          page.cleanup();
        }
      };

      const pump = async () => {
        if (pumping) return;
        pumping = true;
        try {
          while (live && !failed) {
            const next = [...wanted].sort((a, b) => a - b).find((i) => slots[i].state === 'idle');
            if (next === undefined) break;
            await draw(next);
            if (live && drawnAny) setStatus('ready');
          }
        } catch {
          failed = true;
          if (live) setStatus(drawnAny ? 'partial' : 'error');
        } finally {
          pumping = false;
        }
      };

      if (typeof IntersectionObserver === 'undefined') {
        for (let i = 0; i < Math.min(FALLBACK_PAGES, slots.length); i += 1) wanted.add(i);
        void pump();
        return;
      }
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const i = slots.findIndex((s) => s.wrap === entry.target);
          if (i < 0) continue;
          if (entry.isIntersecting) {
            wanted.add(i);
          } else {
            wanted.delete(i);
            if (slots[i].state !== 'idle') free(i);
          }
        }
        void pump();
      }, { rootMargin: `${window.innerHeight}px 0px` });
      for (const s of slots) observer.observe(s.wrap);
    })().catch(() => { if (live) setStatus('error'); });

    return () => {
      live = false;
      observer?.disconnect();
      for (let i = 0; i < slots.length; i += 1) slots[i].cancel?.();
      void task?.destroy();
    };
  }, [url]);

  return (
    <div className="wiki-pdf-viewer" aria-label={title ? `Preview of ${title}` : 'PDF preview'}
         onContextMenu={(e) => e.preventDefault()}>
      {status === 'loading' && <p className="page-hint">Loading preview…</p>}
      {status === 'error' && <p className="page-hint">Couldn't show this PDF.</p>}
      {status === 'partial' && <p className="page-hint">Couldn't show the rest of this PDF.</p>}
      <div ref={hostRef} className="wiki-pdf-pages" />
    </div>
  );
}
