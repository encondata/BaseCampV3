/**
 * VirtualRows — windowed rendering for the standard directory lists.
 * Headless wrapper over @tanstack/react-virtual: pages keep their own
 * .dir-row markup and spread `vp` (ref/style/data-index) onto it, so
 * there is no wrapper element around each row and row CSS/semantics stay
 * untouched. Below VIRTUAL_THRESHOLD rows it renders the plain full list
 * (keeps browser find-in-page for small lists). Dynamic row measurement
 * (ResizeObserver, via virtualizer.measureElement) tracks the row-
 * expansion animation. The scroll container is .portal-main (lists
 * scroll inside it, not the window).
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react';

export const VIRTUAL_THRESHOLD = 300;
const ESTIMATED_ROW_PX = 58;
/** `onNearEnd` fires once the end of the list is this close to the bottom of
 *  the scroller (about ten rows below the fold). */
const NEAR_END_PX = 600;

export interface VirtualRowProps {
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
  'data-index': number;
}

export function VirtualRows<T>({ rows, renderRow, onNearEnd }: {
  rows: T[];
  renderRow: (row: T, vp?: VirtualRowProps) => ReactNode;
  /** Server-paged lists: called when the scroller is within a few rows of the
   *  end of what is loaded (on scroll, on mount, and whenever the row count
   *  changes, so a short page keeps loading until it fills the screen). May
   *  be called repeatedly — the callee must ignore calls while it is busy. */
  onNearEnd?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [margin, setMargin] = useState(0);

  const virtual = rows.length > VIRTUAL_THRESHOLD;

  // The list's offset from the top of the scroller's content is re-measured
  // when row counts change (e.g., filtering), since those changes shift the
  // list's position. Other above-list height changes are absorbed by the
  // virtualizer's overscan instead of an exact remeasure.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const scroller = el?.closest('.portal-main');
    if (el && scroller) {
      setMargin(el.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top + scroller.scrollTop);
    }
  }, [virtual, rows.length]);

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: virtual ? rows.length : 0,
    getScrollElement: () =>
      (wrapRef.current?.closest('.portal-main') as HTMLElement | null) ?? null,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 12,
    scrollMargin: margin,
  });

  const nearEndRef = useRef(onNearEnd);
  nearEndRef.current = onNearEnd;
  const watchEnd = Boolean(onNearEnd);
  useEffect(() => {
    if (!watchEnd) return;
    const wrap = wrapRef.current;
    const scroller = wrap?.closest('.portal-main');
    if (!wrap || !scroller) return;
    const check = () => {
      const below = wrap.getBoundingClientRect().bottom
        - scroller.getBoundingClientRect().bottom;
      if (below < NEAR_END_PX) nearEndRef.current?.();
    };
    check();
    scroller.addEventListener('scroll', check, { passive: true });
    return () => scroller.removeEventListener('scroll', check);
  }, [watchEnd, virtual, rows.length]);

  if (!virtual) {
    return <div ref={wrapRef}>{rows.map((r) => renderRow(r))}</div>;
  }

  return (
    <div ref={wrapRef}
         style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const row = rows[vi.index];
        return renderRow(row, {
          ref: virtualizer.measureElement,
          'data-index': vi.index,
          style: {
            position: 'absolute', top: 0, left: 0, width: '100%',
            transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
          },
        });
      })}
    </div>
  );
}
