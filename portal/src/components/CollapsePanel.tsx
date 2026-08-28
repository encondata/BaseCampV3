/**
 * CollapsePanel — a collapsible section body with the house eyebrow
 * header. Header stays visible when collapsed (title + optional badge,
 * e.g. counts), chevron rotates open/closed. Purely presentational;
 * children stay MOUNTED so lazily-fetched counts appear while collapsed.
 * Pass `render`="lazy" if a body must not mount until first open.
 */
import { useState, type ReactNode } from 'react';

export default function CollapsePanel({
  title, badge, defaultOpen = false, render = 'always', children,
}: {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  render?: 'always' | 'lazy';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [everOpened, setEverOpened] = useState(defaultOpen);
  const body = render === 'lazy' && !everOpened ? null : children;
  return (
    <div className={`collapse-panel ${open ? 'open' : ''}`}>
      <button type="button" className="collapse-head"
              aria-expanded={open}
              onClick={() => { setOpen(!open); setEverOpened(true); }}>
        <p className="eyebrow-sm">{title}</p>
        {badge}
        <svg className="collapse-chevron" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round"
             strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <div className="collapse-body" hidden={!open}>{body}</div>
    </div>
  );
}
