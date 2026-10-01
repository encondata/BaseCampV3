/**
 * NavPanel — the left-nav's actual markup (logo, accordion sections, rail
 * icon rail + flyout, footer slot). Presentational only: AppShell owns all
 * state (which section is open, which mode is active, the account menu,
 * the collapse toggle) and renders this TWICE when the overlay is showing
 * (once for the docked column, once for the overlay) so the two never
 * drift apart — see AppShell.tsx.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import type { NavMode } from '../lib/settings';
import type { NavItem, NavSection } from './navSections';

export interface NavPanelProps {
  sections: NavSection[];
  openSection: string;
  onToggleSection: (label: string) => void;
  mode: NavMode;
  onNavigate?: () => void;
  footer?: ReactNode;
  className?: string;
  tag?: string;
  godMode?: boolean;
  godNavColor?: string | null;
}


/** A routed link, or — for an `href` item — a link to another app that
 *  opens in a new tab (which the browser then brings to the front). */
function NavItemLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  if (item.href) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
        {item.icon}
        {item.label}
        <svg className="nav-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 5h5v5M19 5l-8 8M9 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3" />
        </svg>
      </a>
    );
  }
  return (
    <NavLink to={item.to} end={item.end || item.to === '/'} onClick={onNavigate}>
      {item.icon}
      {item.label}
    </NavLink>
  );
}

export default function NavPanel({
  sections,
  openSection,
  onToggleSection,
  mode,
  onNavigate,
  footer,
  className,
  tag = 'Portal',
  godMode,
  godNavColor,
}: NavPanelProps) {
  const rail = mode === 'rail';
  const hidden = mode === 'hidden';
  const railButtons = useRef<Map<string, HTMLButtonElement>>(new Map());
  const flyoutRef = useRef<HTMLDivElement>(null);
  // Unmeasured (0) until the layout effect below reads the flyout's actual
  // rendered height — first paint falls back to clamping the anchor point
  // only (the old behaviour), same as before this got measured.
  const [flyoutHeight, setFlyoutHeight] = useState(0);

  const navClassName = ['portal-nav', godMode ? 'god' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const navStyle = godMode && godNavColor
    ? ({ '--god-color': godNavColor } as CSSProperties)
    : undefined;

  const openFlyoutSection = rail ? sections.find((s) => s.label === openSection) : undefined;
  const flyoutButton = openFlyoutSection ? railButtons.current.get(openFlyoutSection.label) : undefined;
  const flyoutRect = flyoutButton?.getBoundingClientRect();
  // Clamp the anchor point first (same as before), then re-clamp against
  // the flyout's own measured height so its bottom edge never overflows
  // the viewport — a section opened near the bottom of a short viewport
  // no longer lets the flyout's content spill past window.innerHeight.
  const flyoutTop = flyoutRect
    ? Math.min(
        Math.max(flyoutRect.top, 8),
        Math.max(8, window.innerHeight - 8 - flyoutHeight),
      )
    : 8;
  const flyoutLeft = flyoutRect ? flyoutRect.right + 8 : 72;

  // Measure the flyout after it (re)renders so the clamp above can account
  // for its real height, not just the anchor button's position. Runs
  // synchronously before paint, so there's no visible jump.
  useLayoutEffect(() => {
    const height = openFlyoutSection ? (flyoutRef.current?.offsetHeight ?? 0) : 0;
    setFlyoutHeight((prev) => (prev === height ? prev : height));
  }, [openFlyoutSection]);

  return (
    <nav className={navClassName} aria-label="Primary" style={navStyle}>
      <div className="logo">
        <img
          className="logo-mark"
          src="/images/serversherpa-logo.png"
          alt=""
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        <div>
          <div className="logo-name">Server<em>Sherpa</em></div>
          <div className="logo-tag">{tag}</div>
        </div>
      </div>

      {!hidden && rail && (
        <ul className="nav-list">
          {sections.map((section) => {
            const open = openSection === section.label;
            return (
              <li className={`nav-sec ${open ? 'open' : ''}`} key={section.label}>
                <button
                  type="button"
                  ref={(el) => {
                    if (el) railButtons.current.set(section.label, el);
                    else railButtons.current.delete(section.label);
                  }}
                  className="nav-sec-head"
                  aria-expanded={open}
                  aria-label={section.label}
                  title={section.label}
                  onClick={() => onToggleSection(section.label)}
                >
                  {section.icon}
                  <span className="nav-sec-label">{section.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!hidden && !rail && (
        <ul className="nav-list">
          {sections.map((section) => {
            const open = openSection === section.label;
            return (
              <li className={`nav-sec ${open ? 'open' : ''}`} key={section.label}>
                <button
                  type="button"
                  className="nav-sec-head"
                  aria-expanded={open}
                  onClick={() => onToggleSection(section.label)}
                >
                  {section.label}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                       strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                </button>
                <div className="nav-sec-body">
                  <div className="nav-sec-clip">
                    <ul className="nav-list">
                      {section.items.map((item) => (
                        <li className="nav-item" key={item.to}>
                          <NavItemLink item={item} onNavigate={onNavigate} />
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {rail && openFlyoutSection && (
        <div ref={flyoutRef} className="nav-flyout" role="menu" style={{ top: flyoutTop, left: flyoutLeft }}>
          <ul className="nav-list">
            {openFlyoutSection.items.map((item) => (
              <li className="nav-item" key={item.to}>
                <NavItemLink item={item} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {footer}
    </nav>
  );
}
