// @vitest-environment jsdom
/**
 * lib/virtualRows.tsx: VirtualRows, the shared windowed-rendering
 * primitive every standard directory list will route its row loop
 * through. Pins the two behaviors every later conversion depends on:
 * the plain full-list branch below VIRTUAL_THRESHOLD, and the windowed
 * subset-with-spacer branch above it.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VirtualRows, VIRTUAL_THRESHOLD, type VirtualRowProps } from './virtualRows';

afterEach(cleanup);

// jsdom performs no layout — every box is 0x0 and offsetHeight/Width are
// always 0. @tanstack/react-virtual's viewport-size math collapses to an
// empty range when the scroll container measures as 0-height, so give
// every element a real, uniform box: a 600px-tall scroller and a 58px
// row height (matching virtualRows.tsx's ESTIMATED_ROW_PX) so the
// virtualizer's dynamic remeasurement is a no-op against the estimate.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
    x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true, value: 58,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ROW_ESTIMATE_PX = 58;

/** Mirrors the reference RawScansTab row shape: a plain .dir-row div,
 *  scrolling inside .portal-main like every real list page. */
function Harness({ rows }: { rows: number[] }) {
  return (
    <div className="portal-main">
      <div className="dir-list">
        <VirtualRows<number> rows={rows} rowKey={(r) => r}
          renderRow={(r, vp?: VirtualRowProps) => (
            <div key={r} className="dir-row" data-id={r} {...vp} style={vp?.style} />
          )} />
      </div>
    </div>
  );
}

describe('VirtualRows', () => {
  it('renders every row with no positioning props when at/below the threshold', () => {
    const rows = Array.from({ length: 10 }, (_, i) => i);
    const { container } = render(<Harness rows={rows} />);
    const dirRows = container.querySelectorAll('.dir-row');
    expect(dirRows.length).toBe(10);
    dirRows.forEach((el) => {
      expect(el.hasAttribute('data-index')).toBe(false);
      expect((el as HTMLElement).style.position).toBe('');
    });
  });

  it('renders a windowed subset inside a sized spacer above the threshold', () => {
    expect(VIRTUAL_THRESHOLD).toBe(300);
    const total = 1000;
    const rows = Array.from({ length: total }, (_, i) => i);
    const { container } = render(<Harness rows={rows} />);

    const dirRows = container.querySelectorAll('.dir-row');
    expect(dirRows.length).toBeGreaterThan(0);
    expect(dirRows.length).toBeLessThan(total);
    dirRows.forEach((el) => {
      expect(el.hasAttribute('data-index')).toBe(true);
      expect((el as HTMLElement).style.position).toBe('absolute');
    });

    const spacer = container.querySelector('.dir-list > div') as HTMLElement;
    expect(spacer).not.toBeNull();
    expect(spacer.style.height).toBe(`${total * ROW_ESTIMATE_PX}px`);
  });
});
