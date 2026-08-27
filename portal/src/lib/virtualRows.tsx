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
  useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react';

export const VIRTUAL_THRESHOLD = 300;
const ESTIMATED_ROW_PX = 58;

export interface VirtualRowProps {
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
  'data-index': number;
}

export function VirtualRows<T>({ rows, rowKey, renderRow }: {
  rows: T[];
  rowKey: (row: T) => string | number;
  renderRow: (row: T, vp?: VirtualRowProps) => ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [margin, setMargin] = useState(0);

  const virtual = rows.length > VIRTUAL_THRESHOLD;

  // The list's offset from the top of the scroller's content — stable
  // after mount (toolbar/header above it have fixed heights). Recomputed
  // whenever the list crosses the virtualization threshold, since the
  // plain branch below keeps `wrapRef` mounted too (unstyled) so this
  // measurement is always available the moment a filter change flips
  // `virtual` from false to true.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const scroller = el?.closest('.portal-main');
    if (el && scroller) {
      setMargin(el.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top + scroller.scrollTop);
    }
  }, [virtual]);

  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: virtual ? rows.length : 0,
    getScrollElement: () =>
      (wrapRef.current?.closest('.portal-main') as HTMLElement | null) ?? null,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 12,
    scrollMargin: margin,
  });

  if (!virtual) {
    return <div ref={wrapRef}>{rows.map((r) => renderRow(r))}</div>;
  }

  return (
    <div ref={wrapRef}
         style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const row = rows[vi.index];
        return (
          <span key={rowKey(row)} style={{ display: 'contents' }}>
            {renderRow(row, {
              ref: virtualizer.measureElement,
              'data-index': vi.index,
              style: {
                position: 'absolute', top: 0, left: 0, width: '100%',
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              },
            })}
          </span>
        );
      })}
    </div>
  );
}
