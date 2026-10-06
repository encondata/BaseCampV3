/**
 * CollapsePanel — a collapsible section body with the house eyebrow
 * header. Header stays visible when collapsed (title + optional badge,
 * e.g. counts), chevron rotates open/closed. Purely presentational;
 * children stay MOUNTED so lazily-fetched counts appear while collapsed.
 * Pass `render`="lazy" if a body must not mount until first open.
 * Uncontrolled by default (`defaultOpen`); pass `open` (and `onToggle`)
 * to own the state, e.g. via `useListCollapse` (lib/listCollapse.ts),
 * which drives it from the account's List view preference.
 */
import { useState, type ReactNode } from 'react';

export default function CollapsePanel({
  title, badge, defaultOpen = false, open, onToggle, render = 'always', children,
}: {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode: pass `open` (and `onToggle`) to own the state. */
  open?: boolean;
  onToggle?: (next: boolean) => void;
  render?: 'always' | 'lazy';
  children: ReactNode;
}) {
  const controlled = open !== undefined;
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = controlled ? open : innerOpen;
  const [everOpened, setEverOpened] = useState(isOpen);
  if (isOpen && !everOpened) setEverOpened(true);
  const body = render === 'lazy' && !everOpened ? null : children;
  const toggle = () => {
    const next = !isOpen;
    if (!controlled) setInnerOpen(next);
    onToggle?.(next);
  };
  return (
    <div className={`collapse-panel ${isOpen ? 'open' : ''}`}>
      <button type="button" className="collapse-head"
              aria-expanded={isOpen}
              onClick={toggle}>
        <span className="eyebrow-sm">{title}</span>
        {badge}
        <svg className="collapse-chevron" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round"
             strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <div className="collapse-body" hidden={!isOpen}>{body}</div>
    </div>
  );
}
