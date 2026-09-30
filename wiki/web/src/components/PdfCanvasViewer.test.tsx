// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderPage = vi.fn(() => ({ promise: Promise.resolve() }));
const destroy = vi.fn(() => Promise.resolve());
const getDocument = vi.fn((_: { url: string }) => ({
  promise: Promise.resolve({
    numPages: 3,
    getPage: async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: renderPage }),
  }),
  destroy,
}));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.js' }));

import PdfCanvasViewer from './PdfCanvasViewer';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  renderPage.mockClear();
  destroy.mockClear();
  getDocument.mockClear();
});

describe('PdfCanvasViewer', () => {
  it('draws every page on its own canvas, with no links, toolbar or download', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/plan.pdf" title="plan.pdf" />);
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBe(3));
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(3));
    expect(getDocument).toHaveBeenCalledWith({ url: 'https://s3/plan.pdf' });
    expect(screen.getByRole('img', { name: 'Page 2 of 3' })).toBeTruthy();
    expect(container.querySelector('a, button, iframe, object, embed')).toBeNull();
    await waitFor(() => expect(screen.queryByText('Loading preview…')).toBeNull());
  });

  it('turns the context menu off', async () => {
    const { container } = render(<PdfCanvasViewer url="https://s3/plan.pdf" />);
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBe(3));
    const notPrevented = fireEvent.contextMenu(container.querySelector('canvas') as HTMLElement);
    expect(notPrevented).toBe(false);
  });

  it('says so when the PDF can\'t be loaded', async () => {
    getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error('nope')), destroy } as never);
    render(<PdfCanvasViewer url="https://s3/bad.pdf" />);
    expect(await screen.findByText('Couldn\'t show this PDF.')).toBeTruthy();
  });

  it('releases the document when it goes away', async () => {
    const { unmount, container } = render(<PdfCanvasViewer url="https://s3/plan.pdf" />);
    await waitFor(() => expect(container.querySelectorAll('canvas').length).toBe(3));
    unmount();
    expect(destroy).toHaveBeenCalled();
  });
});
