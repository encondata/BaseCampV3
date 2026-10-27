/**
 * The time clock's full-screen frame: faint topo lines on the light
 * paper, the logo and wordmark with the live date and time on top, the
 * mountain scene with "TRACK | MONITOR | VERIFY | COMPLETE" along the
 * bottom, and Back pinned bottom-left. No kiosk top bar or footer — the
 * flow owns the whole screen in both modes (spec §5). Always light,
 * whatever the person's theme: `.tcx` sets its own tokens.
 *
 * The kiosk's scan flash is painted by `KioskShell`, which this screen
 * replaces, so the overlay is rendered here too.
 */

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import ScanFlash from '../components/ScanFlash';
import { formatClock } from './format';
import { IconGear } from './icons';

/** The clock reads to the minute; checking a few times a minute keeps it
 *  within seconds of the turn without a timer per second. */
const CLOCK_TICK_MS = 10_000;

/* Faint contour lines in a fixed frame that covers the screen (slice),
   the portal sign-in page's recipe. Deterministic. */
function contour(i: number): string {
  const base = -30 + i * 70;
  let d = '';
  for (let x = -40; x <= 1720; x += 24) {
    const y = base + 26 * Math.sin(x / 230 + i * 0.8) + 11 * Math.sin(x / 91 + i * 1.9);
    d += `${d ? ' L' : 'M'}${x} ${y.toFixed(1)}`;
  }
  return d;
}
const CONTOURS = Array.from({ length: 28 }, (_, i) => contour(i));

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

export interface TcShellProps {
  /** The current step, as `data-step`, so the stylesheet can lay a step out. */
  step: string;
  children: ReactNode;
  /** Back, bottom-left. Left out on screens with no way back. */
  back?: ReactNode;
  /** A modal over the whole screen, header and footer included. */
  overlay?: ReactNode;
  /** The small gear in the header (station Welcome only). */
  onSettings?: () => void;
  onMouseDown?: (e: MouseEvent<HTMLDivElement>) => void;
}

export default function TcShell({
  step, children, back, overlay, onSettings, onMouseDown,
}: TcShellProps) {
  const now = useNow();
  const date = now.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  return (
    <div className="tcx" data-step={step} onMouseDown={onMouseDown}>
      <svg className="tcx-topo" viewBox="0 0 1672 1900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {CONTOURS.map((d, i) => <path key={i} d={d} />)}
      </svg>

      <header className="tcx-head">
        <div className="tcx-brand">
          <img className="tcx-logo" src="/images/serversherpa-logo.png" alt="" />
          <div>
            <div className="tcx-wordmark">Server<em>Sherpa</em></div>
            <div className="tcx-tagline">DATACENTER RELOCATION TOOLS</div>
          </div>
        </div>
        <div className="tcx-head-end">
          <div className="tcx-clock">
            <span className="tcx-date">{date}</span>
            <span className="tcx-time">{formatClock(now.toISOString())}</span>
          </div>
          {onSettings && (
            <button type="button" className="tcx-gear" aria-label="Settings" onClick={onSettings}>
              <IconGear />
            </button>
          )}
        </div>
      </header>

      <main className="tcx-main">{children}</main>

      <footer className="tcx-foot">
        <img className="tcx-mountains" src="/images/login-mountains-light.webp" alt="" aria-hidden="true" />
        <p className="tcx-motto">TRACK | MONITOR | VERIFY | COMPLETE</p>
      </footer>

      {back && <div className="tcx-back-slot">{back}</div>}
      {overlay}
      <ScanFlash />
    </div>
  );
}
