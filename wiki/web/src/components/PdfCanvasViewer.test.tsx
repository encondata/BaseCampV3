// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderPage = vi.fn((_: unknown) => ({ promise: Promise.resolve(), cancel: vi.fn() }));
const pageCleanup = vi.fn();
const destroy = vi.fn(() => Promise.resolve());
const PAGES = 12;
/** Page shapes by 1-based number; any other page is 600 x 800. */
const shapes: Record<number, [number, number]> = {};
const getPage = vi.fn(async (n: number) => {
  const [w, h] = shapes[n] ?? [600, 800];
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: w * scale, height: h * scale }),
    render: renderPage,
    cleanup: pageCleanup,
  };
});
const makeTask = () => ({ promise: Promise.resolve({ numPages: PAGES, getPage }), destroy });
const getDocument = vi.fn((_: { url: string; isEvalSupported: boolean }) => makeTask());
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.js' }));

import PdfCanvasViewer from './PdfCanvasViewer';

/** jsdom has no IntersectionObserver: a stand-in the test drives by hand. */
class FakeObserver {
  static all: FakeObserver[] = [];
  targets = new Set<Element>();
  disconnected = false;
  constructor(public cb: (entries: { target: Element; isIntersecting: boolean }[]) => void,
              public options?: IntersectionObserverInit) { FakeObserver.all.push(this); }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.disconnected = true; }
  /** Tells the viewer which 0-based pages are on (or near) the screen. */
  show(container: HTMLElement, pages: number[]) {
    const wraps = [...container.querySelectorAll('.wiki-pdf-page')];
    act(() => {
      this.cb(wraps.map((w, i) => ({ target: w, isIntersecting: pages.includes(i) })));
    });
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeObserver.all = [];
  renderPage.mockClear();
  pageCleanup.mockClear();
  destroy.mockClear();
  getDocument.mockClear();
  getPage.mockClear();
  for (const k of Object.keys(shapes)) delete shapes[Number(k)];
});

const canvases = (c: HTMLElement) => [...c.querySelectorAll('canvas')];

describe('PdfCanvasViewer without IntersectionObserver', () => {
  it('draws the first pages, with no links, toolbar or download', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/plan.pdf" title="plan.pdf" />);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(3));
    expect(canvases(container)).toHaveLength(PAGES);
    expect(canvases(container).filter((c) => c.width > 0)).toHaveLength(3);
    expect(getDocument).toHaveBeenCalledWith({ url: 'https://s3/plan.pdf', isEvalSupported: false });
    expect(screen.getByRole('img', { name: 'Page 2 of 12' })).toBeTruthy();
    expect(container.querySelector('a, button, iframe, object, embed')).toBeNull();
    await waitFor(() => expect(screen.queryByText('Loading preview…')).toBeNull());
  });

  it('turns the context menu off', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/plan.pdf" />);
    await waitFor(() => expect(canvases(container)).toHaveLength(PAGES));
    expect(fireEvent.contextMenu(canvases(container)[0])).toBe(false);
  });

  it('says so when the PDF can\'t be loaded', async () => {
    getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error('nope')), destroy } as never);
    render(<PdfCanvasViewer url="https://s3/bad.pdf" />);
    expect(await screen.findByText('Couldn\'t show this PDF.')).toBeTruthy();
  });

  it('releases the document when it goes away', async () => {
    const { unmount } = render(<PdfCanvasViewer url="https://s3/plan.pdf" />);
    await waitFor(() => expect(renderPage).toHaveBeenCalled());
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it('never loads the document when it goes away before pdf.js has loaded', async () => {
    const { unmount } = render(<PdfCanvasViewer url="https://s3/plan.pdf" />);
    unmount();
    await new Promise((r) => { setTimeout(r, 20); });
    expect(getDocument).not.toHaveBeenCalled();
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('caps the pixel ratio at 2 and releases each page after drawing it', async () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const { container } = render(<PdfCanvasViewer url="https://s3/plan.pdf" />);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(3));
    // 800px fallback width on a 600pt page, drawn at ratio 2
    expect(canvases(container)[0].width).toBe(1600);
    expect(pageCleanup.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps what drew and says so when a later page fails', async () => {
    renderPage.mockImplementationOnce(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
      .mockImplementationOnce(() => ({ promise: Promise.reject(new Error('boom')), cancel: vi.fn() }));
    const { container } = render(<PdfCanvasViewer url="https://s3/plan.pdf" />);
    expect(await screen.findByText('Couldn\'t show the rest of this PDF.')).toBeTruthy();
    expect(screen.queryByText('Couldn\'t show this PDF.')).toBeNull();
    expect(canvases(container)[0].width).toBeGreaterThan(0);
  });
});

describe('PdfCanvasViewer with IntersectionObserver', () => {
  beforeEach(() => { vi.stubGlobal('IntersectionObserver', FakeObserver); });

  it('sizes a placeholder per page but draws only the pages near the viewport', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/big.pdf" />);
    await waitFor(() => expect(FakeObserver.all).toHaveLength(1));
    const observer = FakeObserver.all[0];
    expect(observer.targets.size).toBe(PAGES);
    expect(observer.options?.rootMargin).toBe(`${window.innerHeight}px 0px`);
    const wraps = [...container.querySelectorAll<HTMLElement>('.wiki-pdf-page')];
    expect(wraps).toHaveLength(PAGES);
    expect(wraps[0].style.aspectRatio).toBe('600 / 800');
    expect(renderPage).not.toHaveBeenCalled();

    observer.show(container, [0, 1]);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
    expect(canvases(container).filter((c) => c.width > 0)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText('Loading preview…')).toBeNull());
  });

  it('observes within the viewer\'s own scroller, so the one-screen margin applies', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/big.pdf" />);
    await waitFor(() => expect(FakeObserver.all).toHaveLength(1));
    const viewer = container.querySelector('.wiki-pdf-viewer');
    expect(viewer).toBeTruthy();
    expect(FakeObserver.all[0].options?.root).toBe(viewer);
  });

  it('sizes every placeholder from page 1 without waiting on the others, then corrects a page when it draws', async () => {
    shapes[3] = [800, 600];
    const { container } = render(<PdfCanvasViewer url="https://s3/big.pdf" />);
    await waitFor(() => expect(FakeObserver.all).toHaveLength(1));
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getPage).toHaveBeenCalledWith(1);
    const wraps = [...container.querySelectorAll<HTMLElement>('.wiki-pdf-page')];
    expect(wraps).toHaveLength(PAGES);
    expect(wraps.every((w) => w.style.aspectRatio === '600 / 800')).toBe(true);

    FakeObserver.all[0].show(container, [2]);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    expect(wraps[2].style.aspectRatio).toBe('800 / 600');
    expect(wraps[3].style.aspectRatio).toBe('600 / 800');
  });

  it('does not cancel a render that already finished when its page is freed', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/big.pdf" />);
    await waitFor(() => expect(FakeObserver.all).toHaveLength(1));
    const observer = FakeObserver.all[0];
    observer.show(container, [0]);
    await waitFor(() => expect(canvases(container)[0].width).toBeGreaterThan(0));
    const cancelFirst = renderPage.mock.results[0].value.cancel as ReturnType<typeof vi.fn>;

    observer.show(container, [5]);
    await waitFor(() => expect(canvases(container)[5].width).toBeGreaterThan(0));
    expect(canvases(container)[0].width).toBe(0);
    expect(cancelFirst).not.toHaveBeenCalled();
  });

  it('frees a page that scrolls far away, and draws it again when it returns', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/big.pdf" />);
    await waitFor(() => expect(FakeObserver.all).toHaveLength(1));
    const observer = FakeObserver.all[0];
    observer.show(container, [0]);
    await waitFor(() => expect(canvases(container)[0].width).toBeGreaterThan(0));

    observer.show(container, [5]);
    await waitFor(() => expect(canvases(container)[5].width).toBeGreaterThan(0));
    expect(canvases(container)[0].width).toBe(0);
    expect(canvases(container)[0].height).toBe(0);

    observer.show(container, [0]);
    await waitFor(() => expect(canvases(container)[0].width).toBeGreaterThan(0));
    expect(canvases(container)[5].width).toBe(0);
  });

  it('stops observing when it goes away', async () => {
    const { unmount } = render(<PdfCanvasViewer url="https://s3/big.pdf" />);
    await waitFor(() => expect(FakeObserver.all).toHaveLength(1));
    unmount();
    expect(FakeObserver.all[0].disconnected).toBe(true);
    expect(destroy).toHaveBeenCalled();
  });
});
