/**
 * NavPanel — the left-nav's actual markup (logo, accordion sections, rail
 * icon rail + flyout, footer slot). Presentational only: AppShell owns all
 * state (which section is open, which mode is active, the account menu,
 * the collapse toggle) and renders this TWICE when the overlay is showing
 * (once for the docked column, once for the overlay) so the two never
 * drift apart — see AppShell.tsx.
 */

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import type { NavMode } from '../lib/settings';
import type { NavSection } from './navSections';

export interface NavPanelProps {
  sections: NavSection[];
  openSection: string;
  onToggleSection: (label: string) => void;
  mode: NavMode;
  onNavigate?: () => void;
  footer?: ReactNode;
  className?: string;
  godMode?: boolean;
  godNavColor?: string | null;
}

export default function NavPanel({
  sections,
  openSection,
  onToggleSection,
  mode,
  onNavigate,
  footer,
  className,
  godMode,
  godNavColor,
}: NavPanelProps) {
  const rail = mode === 'rail';
  const hidden = mode === 'hidden';
  const railButtons = useRef<Map<string, HTMLButtonElement>>(new Map());

  const navClassName = ['portal-nav', godMode ? 'god' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const navStyle = godMode && godNavColor
    ? ({ '--god-color': godNavColor } as CSSProperties)
    : undefined;

  const openFlyoutSection = rail ? sections.find((s) => s.label === openSection) : undefined;
  const flyoutButton = openFlyoutSection ? railButtons.current.get(openFlyoutSection.label) : undefined;
  const flyoutRect = flyoutButton?.getBoundingClientRect();
  const flyoutTop = flyoutRect
    ? Math.min(Math.max(flyoutRect.top, 8), Math.max(8, window.innerHeight - 8))
    : 8;
  const flyoutLeft = flyoutRect ? flyoutRect.right + 8 : 72;

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
          <div className="logo-tag">Portal</div>
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
                          <NavLink to={item.to} end={item.to === '/'} onClick={onNavigate}>
                            {item.icon}
                            {item.label}
                          </NavLink>
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
        <div className="nav-flyout" role="menu" style={{ top: flyoutTop, left: flyoutLeft }}>
          <ul className="nav-list">
            {openFlyoutSection.items.map((item) => (
              <li className="nav-item" key={item.to}>
                <NavLink to={item.to} end={item.to === '/'} onClick={onNavigate}>
                  {item.icon}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}

      {footer}
    </nav>
  );
}
