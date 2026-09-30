/** A PDF drawn onto <canvas> elements with pdf.js, for a file whose
 *  printing is off: unlike the browser's own viewer there's no toolbar, no
 *  print or download button, no selectable text and no links, and the
 *  context menu is off. Pages render one after another, scaled to the
 *  container's width, so a long PDF shows its first pages at once. pdf.js
 *  loads on first use (it's a large chunk nobody else needs). Fetching the
 *  file is a cross-origin request, unlike an iframe's, so the storage
 *  bucket must allow this origin (CORS GET). */
import { useEffect, useRef, useState } from 'react';

const FALLBACK_WIDTH = 800;

export default function PdfCanvasViewer({ url, title }: { url: string; title?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let live = true;
    let destroy: (() => void) | undefined;
    setStatus('loading');
    host.replaceChildren();

    (async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const task = pdfjs.getDocument({ url });
      destroy = () => { void task.destroy(); };
      const doc = await task.promise;
      if (!live) return;
      const width = host.clientWidth || FALLBACK_WIDTH;
      const ratio = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        if (!live) return;
        const scale = width / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale: scale * ratio });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className = 'wiki-pdf-canvas';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
        host.appendChild(canvas);
        const canvasContext = canvas.getContext('2d');
        if (!canvasContext) throw new Error('no canvas context');
        await page.render({ canvasContext, viewport }).promise;
        if (n === 1 && live) setStatus('ready');
      }
      if (live) setStatus('ready');
    })().catch(() => { if (live) setStatus('error'); });

    return () => {
      live = false;
      destroy?.();
    };
  }, [url]);

  return (
    <div className="wiki-pdf-viewer" aria-label={title ? `Preview of ${title}` : 'PDF preview'}
         onContextMenu={(e) => e.preventDefault()}>
      {status === 'loading' && <p className="page-hint">Loading preview…</p>}
      {status === 'error' && <p className="page-hint">Couldn't show this PDF.</p>}
      <div ref={hostRef} className="wiki-pdf-pages" />
    </div>
  );
}
