/**
 * LoginScene — everything on the portal sign-in page except the form: faint
 * topo lines, the real logo, the static Dallas → Las Vegas route map, the
 * headline and feature row, the status line and the mountain art (light
 * mockup, 2026-09-28). Pure markup, no effects. Map positions are the
 * mockup's pixel positions inside a 1040×560 map box, set as percentages so
 * the map scales as one piece (login-light.css sizes the box and scales its
 * text with container units).
 */
import type { CSSProperties } from 'react';

import { IconBarChart, IconBox, IconShield, IconTarget } from './loginIcons';

const MAP_W = 1040;
const MAP_H = 560;
const at = (x: number, y: number): CSSProperties => ({
  left: `${(x / MAP_W) * 100}%`,
  top: `${(y / MAP_H) * 100}%`,
});

const STATES = [
  { name: 'NEVADA', x: 576, y: 138 },
  { name: 'CALIFORNIA', x: 138, y: 319 },
  { name: 'ARIZONA', x: 813, y: 403 },
  { name: 'TEXAS', x: 183, y: 509 },
];

const PINS = [
  { key: 'destination', x: 790, y: 95, title: 'DESTINATION · LAS-9', place: 'Las Vegas, NV · HALL D',
    coords: '36.1696° N / 115.1398° W', elev: "ELEV. 2,061'" },
  { key: 'origin', x: 358, y: 458, title: 'ORIGIN · DAL-7', place: 'Dallas, TX · HALL B',
    coords: '32.7767° N / 96.7970° W', elev: "ELEV. 438'" },
];

const ROUTE_D = 'M373 421 C 392 330 440 244 573 213 C 670 190 745 160 776 112';

const FEATURES = [
  { label: 'Track assets', Icon: IconBox },
  { label: 'Monitor progress', Icon: IconBarChart },
  { label: 'Verify work', Icon: IconShield },
  { label: 'Complete on time', Icon: IconTarget },
];

/* Faint contour lines in a fixed 1672×941 frame that covers the page
   (slice), drawn in code so they stay sharp at any size. Deterministic. */
function contour(i: number): string {
  const base = -30 + i * 64;
  let d = '';
  for (let x = -40; x <= 1720; x += 24) {
    const y = base + 26 * Math.sin(x / 230 + i * 0.8) + 11 * Math.sin(x / 91 + i * 1.9);
    d += `${d ? ' L' : 'M'}${x} ${y.toFixed(1)}`;
  }
  return d;
}
const CONTOURS = Array.from({ length: 17 }, (_, i) => contour(i));

export default function LoginScene() {
  return (
    <>
      <svg className="lx-topo" viewBox="0 0 1672 941" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {CONTOURS.map((d, i) => <path key={i} d={d} />)}
      </svg>

      <img className="lx-mountains" src="/images/login-mountains-light.webp" alt="" aria-hidden="true" />

      <header className="lx-logo">
        <img
          className="lx-logo-mark"
          src="/images/serversherpa-logo.png"
          alt="ServerSherpa logo"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        <div>
          <div className="lx-logo-name">Server<em>Sherpa</em></div>
          <div className="lx-logo-tag">Datacenter Relocation Tools</div>
        </div>
      </header>

      <div className="lx-map" aria-hidden="true">
        <svg className="lx-map-art" viewBox={`0 0 ${MAP_W} ${MAP_H}`}>
          <path className="lx-leader" d="M432 242 H 470" />
          <path className="lx-route" d={ROUTE_D} />
          <circle className="lx-glow-halo" cx="573" cy="213" r="16" />
          <circle className="lx-glow-dot" cx="573" cy="213" r="6.5" />
          <circle className="lx-glow-halo" cx="373" cy="421" r="11" />
          <circle className="lx-glow-dot" cx="373" cy="421" r="4.5" />
          {PINS.map((p) => (
            <g key={p.key} className="lx-pin" transform={`translate(${p.x} ${p.y})`}>
              <circle className="lx-pin-ring" r="19" />
              <circle className="lx-pin-ring" r="11" />
              <circle className="lx-pin-core" r="4.5" />
            </g>
          ))}
        </svg>
        {STATES.map((s) => (
          <span key={s.name} className="lx-state" style={at(s.x, s.y)}>{s.name}</span>
        ))}
        {PINS.map((p) => (
          <div key={p.key} className="lx-pin-label" style={at(p.x + 36, p.y - 19)}>
            <span className="lx-pin-title">{p.title}</span>
            <span>{p.place}</span>
            <span className="lx-pin-meta">{p.coords}</span>
            <span className="lx-pin-meta">{p.elev}</span>
          </div>
        ))}
        <div className="lx-card" style={at(240, 205)}>
          <b>ROUTE 07</b>
          <span>1,241 ASSETS</span>
          <span>RACK 83 · ETA 2h 14m</span>
        </div>
      </div>

      <div className="lx-story">
        <h1 className="lx-hero">
          <span>Migration Control.</span>{' '}
          <span className="accent">From First Scan to Final Rack.</span>
        </h1>
        <p className="lx-sub">
          Track relocation progress, review manifests, verify assets,
          and access complete migration records.
        </p>
        <ul className="lx-features">
          {FEATURES.map(({ label, Icon }) => (
            <li key={label}>
              <Icon />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </div>

      <footer className="lx-status">
        <span className="lx-status-dot" />
        <b>ALL SYSTEMS OPERATIONAL</b>
        <span className="lx-status-sep" aria-hidden="true">|</span>
        <span>STATUS.SERVERSHERPA.COM</span>
      </footer>
    </>
  );
}
