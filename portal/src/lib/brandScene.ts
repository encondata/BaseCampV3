/**
 * Login brand-panel scene — GSAP ridgeline terrain, origin→destination
 * migration route, sherpa/truck traveler, and the [data-reveal] form
 * entrance. Ported from BaseCampV2 (fable-serversherpa-login.html).
 * React-free on purpose: pages/Login.tsx (portal) and the kiosk app's
 * login page both call buildBrandScene() from a ref effect.
 */

import { gsap } from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';

gsap.registerPlugin(MotionPathPlugin);

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface BrandSceneOptions {
  /** 'classic' (default): the original right-half climb, used by the kiosk.
   *  'map': the portal's Dallas → Las Vegas route across a faint state map,
   *  with a mid-route waypoint and a route callout. */
  layout?: 'classic' | 'map';
}

type Pt = { x: number; y: number };

/* Catmull-Rom through the points, emitted as cubic Béziers, so a route can be
   described by where it passes rather than by hand-tuned control points. */
function smoothPath(pts: Pt[]): string {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6},`
      + ` ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function svgText(x: number, y: number, cls: string, text: string, anchor = 'start') {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('class', cls);
  t.textContent = text;
  return t;
}

/* Builds the brand panel scene (ridgelines, migration route, traveler) inside
   the svg element and animates it. Returns a cleanup function. Ported from the
   approved design (fable-serversherpa-login.html). */
export function buildBrandScene(
  brandPanel: HTMLElement,
  svg: SVGSVGElement,
  reduceMotion: boolean,
  options: BrandSceneOptions = {},
): () => void {
  const map = options.layout === 'map';
  // below this width a right-hand label on the destination would run off the panel
  const narrow = brandPanel.clientWidth < 600;
  svg.innerHTML = '';

  const W = Math.max(brandPanel.clientWidth, 320);
  const H = Math.max(brandPanel.clientHeight, 320);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // deterministic pseudo-random so the terrain is stable across loads
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const peaks = Array.from({ length: 5 }, () => ({
    x: 80 + rand() * (W - 160),
    amp: (70 + rand() * 150) * (H / 1100),
    width: (90 + rand() * 160) * (W / 900),
  }));

  function ridgeY(x: number, base: number, t: number): number {
    let y = base;
    for (const p of peaks) {
      const d = (x - p.x) / p.width;
      y -= p.amp * t * Math.exp(-d * d);
    }
    y += Math.sin(x * 0.012 + base) * 9 * t + Math.sin(x * 0.031 + base * 2) * 4 * t;
    return y;
  }

  const ridgeGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(ridgeGroup);

  const SPACING = Math.min(Math.max(28, H / 26), 48);
  const RIDGES = Math.floor((H * 0.9) / SPACING);
  const ridgePaths: SVGPathElement[] = [];
  for (let i = 0; i < RIDGES; i++) {
    const t = (i + 1) / RIDGES; // upper ridges = taller peaks
    const base = H - 30 - i * SPACING;
    let d = '';
    for (let x = -20; x <= W + 20; x += 12) {
      const y = ridgeY(x, base, t);
      d += (x === -20 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'ridge' + (i % 5 === 4 ? ' lit' : ''));
    ridgeGroup.appendChild(path);
    ridgePaths.push(path);
  }

  const mapGroup = document.createElementNS(SVG_NS, 'g');
  if (map) {
    // faint state names place the route on a map without drawing borders
    const states: [string, number, number][] = [
      ['NEVADA', 0.638, 0.14], ['CALIFORNIA', 0.145, 0.351],
      ['ARIZONA', 0.84, 0.456], ['TEXAS', 0.124, 0.596],
    ];
    for (const [name, fx, fy] of states) {
      mapGroup.appendChild(svgText(fx * W, fy * H, 'map-state', name, 'middle'));
    }
    svg.appendChild(mapGroup);
  }

  /* migration route: origin → destination. classic climbs the right half;
     map crosses the panel from Dallas (lower left) to Las Vegas (top). */
  const routeGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(routeGroup);

  let A: Pt, B: Pt, routeD: string;
  let waypointAt = 0;
  let destSide: 'left' | 'right' = 'right';
  let steepRouteD = '';
  const DEST_LABEL = 'DESTINATION · LAS-9';
  const DEST_SUB = 'Las Vegas, NV · HALL D';
  if (map) {
    const at = (fx: number, fy: number): Pt => ({ x: fx * W, y: fy * H });
    A = at(0.304, 0.531);
    // phones: keep the top of the route clear of the logo block
    B = at(0.734, Math.max(0.085, (narrow ? 128 : 80) / H));
    destSide = narrow || !fitsRightOf(B, DEST_LABEL, DEST_SUB) ? 'left' : 'right';
    // a left-side label (stacked above-left of the pin) can run into the logo
    // block on mid-width panels; drop the pin until the label clears it
    const logo = brandPanel.querySelector('.logo');
    if (destSide === 'left' && logo) {
      const pr = brandPanel.getBoundingClientRect();
      const lr = logo.getBoundingClientRect();
      const logoRight = lr.right - pr.left + 16;
      const logoBottom = lr.bottom - pr.top + 10;
      const labelLeft = B.x - 22
        - Math.max(estWidth(DEST_LABEL, 13.5, 0.08), estWidth(DEST_SUB, 11.5, 0.04));
      if (lr.width > 0 && labelLeft < logoRight) {
        // label top sits ~49px above the pin (see makeMapNode, dy = -30)
        B = { x: B.x, y: Math.max(B.y, logoBottom + 49) };
      }
    }
    // interior points: x as a panel fraction, height as progress from the
    // origin (0) up to the destination (1) — so a short phone panel squashes
    // the climb instead of overshooting the destination
    const via = (fx: number, u: number): Pt => ({ x: fx * W, y: A.y + (B.y - A.y) * u });
    // the mockup's gentle profile, and a steep one that climbs out of the
    // origin first (so the path clears the origin's label, right of the node)
    // and arrives from below the destination's label; the gentle profile is
    // tried first and replaced below if it would cross the origin label
    const gentle = smoothPath([A, via(0.37, 0.1), via(0.45, 0.137), via(0.5, 0.25),
      via(0.575, 0.34), via(0.625, 0.45), via(0.646, 0.6), via(0.69, 0.765), via(0.72, 0.9), B]);
    steepRouteD = smoothPath([A, via(0.33, 0.45), via(0.42, 0.62), via(0.55, 0.7),
      via(0.66, 0.8), B]);
    routeD = narrow ? steepRouteD : gentle;
    waypointAt = 0.6;
  } else {
    A = { x: W * 0.63, y: H * 0.78 };
    B = { x: W * 0.86, y: Math.max(H * 0.24, 112) };
    const m1 = { x: A.x + 0.05 * W, y: A.y - 0.3 * H };
    routeD = `M ${A.x} ${A.y}
      C ${A.x + 0.16 * W} ${A.y - 0.06 * H}, ${A.x - 0.06 * W} ${A.y - 0.22 * H}, ${m1.x} ${m1.y}
      C ${m1.x + 0.11 * W} ${m1.y - 0.08 * H}, ${B.x - 0.16 * W} ${B.y + 0.1 * H}, ${B.x} ${B.y}`;
  }

  const route = document.createElementNS(SVG_NS, 'path');
  route.setAttribute('d', routeD);
  route.setAttribute('class', 'route-path');
  routeGroup.appendChild(route);

  // a flatter climb (short panel, or a pin lowered to clear the logo) can run
  // the gentle profile's first leg straight through the origin's label
  if (map && steepRouteD && routeD !== steepRouteD) {
    const box = {
      x0: A.x + 30,
      x1: A.x + 36 + Math.max(estWidth('ORIGIN · DAL-7', 13.5, 0.08),
        estWidth('Dallas, TX · HALL B', 11.5, 0.04)),
      y0: A.y - 24, y1: A.y + 18,
    };
    const L = route.getTotalLength();
    const crosses = Array.from({ length: 120 }, (_, i) => route.getPointAtLength(L * i / 119))
      .some((p) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1);
    if (crosses) {
      routeD = steepRouteD;
      route.setAttribute('d', routeD);
    }
  }

  /* Would these labels, set right of the node, end inside the panel?
     Estimated from character counts, NOT measured: the scene is built once,
     often before the web font arrives, and the fallback monospace can be
     narrower than Fragment Mono — a measured "fits" then overflows when the
     font swaps in. 0.7em per character over-counts Fragment Mono's 0.6em
     advance. Font sizes and letter-spacing mirror .map-node-label/-sub in
     auth-theme.css. */
  function estWidth(text: string, px: number, trackEm: number): number {
    return [...text].length * px * (0.7 + trackEm);
  }
  function fitsRightOf(pt: Pt, label: string, sub: string): boolean {
    const widest = Math.max(estWidth(label, 13.5, 0.08), estWidth(sub, 11.5, 0.04));
    // 32px of air: a label that merely fits still reads as clipped against
    // the panel's dashed divider
    return pt.x + 36 + widest <= W - 32;
  }

  function makeMapNode(pt: Pt, label: string, sub: string, coords: string, elev: string,
                       side: 'right' | 'left' = 'right') {
    const g = document.createElementNS(SVG_NS, 'g');
    const pulse = document.createElementNS(SVG_NS, 'circle');
    pulse.setAttribute('cx', String(pt.x)); pulse.setAttribute('cy', String(pt.y));
    pulse.setAttribute('r', '8'); pulse.setAttribute('class', 'node-pulse');
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', String(pt.x)); ring.setAttribute('cy', String(pt.y));
    ring.setAttribute('r', '14'); ring.setAttribute('class', 'node-ring');
    const inner = document.createElementNS(SVG_NS, 'circle');
    inner.setAttribute('cx', String(pt.x)); inner.setAttribute('cy', String(pt.y));
    inner.setAttribute('r', '8'); inner.setAttribute('class', 'node-ring');
    const core = document.createElementNS(SVG_NS, 'circle');
    core.setAttribute('cx', String(pt.x)); core.setAttribute('cy', String(pt.y));
    core.setAttribute('r', '3.5'); core.setAttribute('class', 'node-core');
    // 'left' stacks the text above-left of the node so the route can arrive
    // underneath it
    const x = side === 'right' ? pt.x + 36 : pt.x - 22;
    const anchor = side === 'right' ? 'start' : 'end';
    const dy = side === 'right' ? 0 : -30;
    g.append(pulse, ring, inner, core,
      svgText(x, pt.y - 7 + dy, 'map-node-label', label, anchor),
      svgText(x, pt.y + 13 + dy, 'map-node-sub', sub, anchor));
    // coordinates only beside a right-hand label: on the left, the route
    // arrives from below-left exactly where they would sit
    if (side === 'right') {
      g.append(
        svgText(x, pt.y + 38, 'map-node-coord', coords, anchor),
        svgText(x, pt.y + 53, 'map-node-coord', elev, anchor));
    }
    routeGroup.appendChild(g);
    return { g, pulse };
  }

  function makeNode(pt: { x: number; y: number }, label: string, sub: string, anchor: string) {
    const g = document.createElementNS(SVG_NS, 'g');
    const pulse = document.createElementNS(SVG_NS, 'circle');
    pulse.setAttribute('cx', String(pt.x)); pulse.setAttribute('cy', String(pt.y));
    pulse.setAttribute('r', '8'); pulse.setAttribute('class', 'node-pulse');
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', String(pt.x)); ring.setAttribute('cy', String(pt.y));
    ring.setAttribute('r', '9'); ring.setAttribute('class', 'node-ring');
    const core = document.createElementNS(SVG_NS, 'circle');
    core.setAttribute('cx', String(pt.x)); core.setAttribute('cy', String(pt.y));
    core.setAttribute('r', '3.5'); core.setAttribute('class', 'node-core');
    const t1 = document.createElementNS(SVG_NS, 'text');
    t1.setAttribute('x', String(pt.x)); t1.setAttribute('y', String(pt.y - 34));
    t1.setAttribute('text-anchor', anchor); t1.setAttribute('class', 'node-label');
    t1.textContent = label;
    const t2 = document.createElementNS(SVG_NS, 'text');
    t2.setAttribute('x', String(pt.x)); t2.setAttribute('y', String(pt.y - 20));
    t2.setAttribute('text-anchor', anchor); t2.setAttribute('class', 'node-sub');
    t2.textContent = sub;
    g.append(pulse, ring, core, t1, t2);
    routeGroup.appendChild(g);
    return { g, pulse };
  }

  const nodeA = map
    ? makeMapNode(A, 'ORIGIN · DAL-7', 'Dallas, TX · HALL B', '32.776° N / 96.797° W', 'ELEV 430′')
    : makeNode(A, 'ORIGIN · DAL-7', 'Las Vegas, NV — HALL B', 'middle');
  const nodeB = map
    ? makeMapNode(B, DEST_LABEL, DEST_SUB, '36.086° N / 115.139° W',
        'ELEV 2,030′', destSide)
    : makeNode(B, 'DEST · ZRH-3', 'ZÜRICH, CH — HALL A', 'end');

  // state names are decoration: step any that collide with node text down
  // until clear (the flipped destination's coordinates land near NEVADA).
  // Text boxes change when the web font swaps in, so settle again then.
  let disposed = false;
  // The route itself counts too: a name the route runs through is moved to a
  // nearby clear spot, or hidden if there is none (they are decoration).
  const settleStateNames = () => {
    if (disposed) return;
    const boxes = [...routeGroup.querySelectorAll('text')].map((t) => t.getBBox());
    const L = route.getTotalLength();
    const routePts = Array.from({ length: 160 }, (_, i) => route.getPointAtLength(L * i / 159));
    // 10px of padding: merely not overlapping still reads as one stacked block
    const P = 10;
    const hit = (a: DOMRect, b: DOMRect) => a.x < b.x + b.width + P && b.x < a.x + a.width + P
      && a.y < b.y + b.height + P && b.y < a.y + a.height + P;
    const onRoute = (a: DOMRect) => routePts.some((p) =>
      p.x >= a.x - 8 && p.x <= a.x + a.width + 8 && p.y >= a.y - 8 && p.y <= a.y + a.height + 8);
    const offsets = [[0, 0], [0, 26], [-50, 0], [50, 0], [-50, 26], [50, 26], [0, 52], [-100, 0]];
    mapGroup.querySelectorAll<SVGTextElement>('.map-state').forEach((s) => {
      // re-settles (after the font loads) start again from the home spot
      s.dataset.hx ??= s.getAttribute('x') ?? '0';
      s.dataset.hy ??= s.getAttribute('y') ?? '0';
      s.style.display = '';
      const clear = offsets.some(([dx, dy]) => {
        s.setAttribute('x', String(Number(s.dataset.hx) + dx));
        s.setAttribute('y', String(Number(s.dataset.hy) + dy));
        const b = s.getBBox();
        return b.x >= 0 && b.x + b.width <= W && !onRoute(b) && !boxes.some((o) => hit(b, o));
      });
      if (!clear) s.style.display = 'none';
    });
  };
  if (map) {
    settleStateNames();
    document.fonts?.ready.then(settleStateNames);
  }

  // map layout: a glowing mid-route waypoint and the route's status callout
  const mapExtras: SVGGElement[] = [];
  if (map) {
    const len = route.getTotalLength();
    const wp = route.getPointAtLength(len * waypointAt);
    const wpg = document.createElementNS(SVG_NS, 'g');
    const halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('cx', String(wp.x)); halo.setAttribute('cy', String(wp.y));
    halo.setAttribute('r', '13'); halo.setAttribute('class', 'waypoint-halo');
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(wp.x)); dot.setAttribute('cy', String(wp.y));
    dot.setAttribute('r', '6.5'); dot.setAttribute('class', 'waypoint-dot');
    wpg.append(halo, dot);
    routeGroup.appendChild(wpg);

    // callout box hangs just left of and below the waypoint (as in the
    // mockup), so it tracks the dot at any panel width; the route falls away
    // down-left from the dot, so slide the box further left until the path
    // no longer runs through it
    const cw = 168, ch = 78;
    const cy = wp.y + 10;
    const samples = Array.from({ length: 160 }, (_, i) => route.getPointAtLength(len * i / 159));
    const crosses = (x: number) => samples.some((p) =>
      p.x >= x - 6 && p.x <= x + cw + 6 && p.y >= cy - 6 && p.y <= cy + ch + 6);
    let cx = wp.x - 44 - cw;
    while (cx > 8 && crosses(cx)) cx -= 8;
    cx = Math.max(8, cx);
    const call = document.createElementNS(SVG_NS, 'g');
    call.setAttribute('class', 'route-callout');
    const box = document.createElementNS(SVG_NS, 'path');
    const tx = cx + cw - 34;
    box.setAttribute('d', `M ${cx + 6} ${cy} H ${cx + cw - 6} Q ${cx + cw} ${cy} ${cx + cw} ${cy + 6}
      V ${cy + ch - 6} Q ${cx + cw} ${cy + ch} ${cx + cw - 6} ${cy + ch}
      H ${tx + 8} L ${tx} ${cy + ch + 10} L ${tx - 8} ${cy + ch}
      H ${cx + 6} Q ${cx} ${cy + ch} ${cx} ${cy + ch - 6} V ${cy + 6} Q ${cx} ${cy} ${cx + 6} ${cy} Z`);
    box.setAttribute('class', 'callout-box');
    call.append(box,
      svgText(cx + 14, cy + 25, 'callout-title', 'ROUTE 07'),
      svgText(cx + 14, cy + 46, 'callout-line', '1,284 ASSETS'),
      svgText(cx + 14, cy + 64, 'callout-line', 'WAVE 03 · ETA 2H 14M'));
    routeGroup.appendChild(call);
    mapExtras.push(wpg, call);
  }

  const routeLen = route.getTotalLength();

  /* map layout's signature loop: a glowing marker travels the route and the
     dashes light up behind it. The lit copy of the route is revealed through
     a mask whose stroke tracks the marker, so its dashes stay aligned with the
     dim base route underneath. */
  let trip: { lit: SVGPathElement; revealStroke: SVGPathElement;
              marker: SVGGElement; markerBody: SVGGElement } | null = null;
  if (map) {
    const uid = Math.random().toString(36).slice(2, 8);
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = `
      <radialGradient id="markerGlow-${uid}">
        <stop offset="0" stop-color="#ffa12e" stop-opacity=".55"/>
        <stop offset=".45" stop-color="#ffa12e" stop-opacity=".18"/>
        <stop offset="1" stop-color="#ffa12e" stop-opacity="0"/>
      </radialGradient>`;
    const mask = document.createElementNS(SVG_NS, 'mask');
    mask.setAttribute('id', `routeReveal-${uid}`);
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    const revealStroke = document.createElementNS(SVG_NS, 'path');
    revealStroke.setAttribute('d', routeD);
    revealStroke.setAttribute('fill', 'none');
    revealStroke.setAttribute('stroke', '#fff');
    revealStroke.setAttribute('stroke-width', '16');
    revealStroke.style.strokeDasharray = String(routeLen);
    revealStroke.style.strokeDashoffset = String(routeLen);
    mask.appendChild(revealStroke);
    defs.appendChild(mask);
    routeGroup.insertBefore(defs, route);

    const lit = document.createElementNS(SVG_NS, 'path');
    lit.setAttribute('d', routeD);
    lit.setAttribute('class', 'route-lit');
    lit.setAttribute('mask', `url(#routeReveal-${uid})`);
    route.after(lit);

    // outer group carries the position; the inner one scales/fades, so the
    // two transforms never fight
    const marker = document.createElementNS(SVG_NS, 'g');
    marker.setAttribute('class', 'route-marker');
    const markerBody = document.createElementNS(SVG_NS, 'g');
    const glow = document.createElementNS(SVG_NS, 'circle');
    glow.setAttribute('r', '18');
    glow.setAttribute('fill', `url(#markerGlow-${uid})`);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '4.2');
    dot.setAttribute('class', 'marker-dot');
    markerBody.append(glow, dot);
    marker.appendChild(markerBody);
    const start = route.getPointAtLength(0);
    marker.setAttribute('transform', `translate(${start.x} ${start.y})`);
    routeGroup.appendChild(marker);
    trip = { lit, revealStroke, marker, markerBody };
  }

  // the traveler rides the route as one group holding two figures that swap:
  // a mini sherpa (rack on his back, trekking pole) and a box truck for the
  // highway leg. Both share a ground line at local y≈9 so the handoff is seamless.
  // Classic layout only; the map layout's marker takes its place.
  const traveler = document.createElementNS(SVG_NS, 'g');
  traveler.setAttribute('class', 'walker');
  traveler.innerHTML = map ? '' : `
    <g id="sherpaFig">
      <g id="sherpaBob">
        <path id="legBack"  d="M0 0 L-2.6 8.6" stroke="#b3ad94" stroke-width="2.1" stroke-linecap="round"/>
        <path id="legFront" d="M0 0 L2.6 8.6"  stroke="#ece5d0" stroke-width="2.1" stroke-linecap="round"/>
        <path id="stick" d="M5.6 -7.5 L7 8.8" stroke="#ffa12e" stroke-width="1.5" stroke-linecap="round"/>
        <rect x="-10.2" y="-17" width="7" height="11.5" rx="1.4" fill="#b3ad94"/>
        <path d="M-8.7 -14.2 h3.6 M-8.7 -11.6 h3.6 M-8.7 -9 h3.6" stroke="#0c1117" stroke-width="1" stroke-linecap="round"/>
        <circle cx="-4.6" cy="-15.4" r=".6" fill="#ffa12e"/>
        <rect x="-3.8" y="-11.5" width="7" height="12.5" rx="3.2" fill="#ece5d0"/>
        <path d="M1.2 -8.5 L5.4 -5.2" stroke="#ece5d0" stroke-width="2" stroke-linecap="round"/>
        <circle cx="0.6" cy="-14" r="3.4" fill="#b3ad94"/>
        <circle cx="2" cy="-13.6" r="2.1" fill="#ece5d0"/>
      </g>
    </g>
    <g id="truckFig">
      <g id="truckBody">
        <rect x="-14" y="-10" width="17" height="13.5" rx="1.6" fill="#b3ad94"/>
        <path d="M-11.5 -6.5 h12 M-11.5 -3 h12 M-11.5 0.5 h12" stroke="#0c1117" stroke-width="1" stroke-linecap="round" opacity=".5"/>
        <circle cx="-12" cy="-8" r=".6" fill="#ffa12e"/>
        <path d="M3 -5 h6.2 l3.6 4 v4.5 h-9.8 z" fill="#ece5d0"/>
        <path d="M4.6 -3.4 h4 l2.6 3 h-6.6 z" fill="#0c1117" opacity=".85"/>
        <rect x="12.4" y="0.4" width="1.6" height="2" rx=".5" fill="#ffa12e"/>
      </g>
      <g id="wheelB" transform="translate(-9,6)">
        <circle r="3" fill="#0c1117" stroke="#ece5d0" stroke-width="1.3"/>
        <path d="M0 -1.7 V1.7 M-1.7 0 H1.7" stroke="#b3ad94" stroke-width=".9"/>
      </g>
      <g id="wheelF" transform="translate(7.5,6)">
        <circle r="3" fill="#0c1117" stroke="#ece5d0" stroke-width="1.3"/>
        <path d="M0 -1.7 V1.7 M-1.7 0 H1.7" stroke="#b3ad94" stroke-width=".9"/>
      </g>
    </g>`;
  if (!map) routeGroup.appendChild(traveler);
  const sherpaFig = traveler.querySelector('#sherpaFig');
  const truckFig = traveler.querySelector('#truckFig');

  route.style.strokeDasharray = String(routeLen);
  route.style.strokeDashoffset = String(routeLen);

  let mouseHandler: ((e: MouseEvent) => void) | null = null;

  const ctx = gsap.context(() => {
    if (reduceMotion) {
      route.style.strokeDasharray = '7 7';
      route.style.strokeDashoffset = '0';
      gsap.set(traveler, { opacity: 0 });
      if (trip) {
        // the completed trip, still: whole route lit, no marker
        trip.revealStroke.style.strokeDashoffset = '0';
        gsap.set(trip.marker, { opacity: 0 });
      }
      return;
    }

    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from(ridgePaths, {
        opacity: 0,
        y: 60,
        duration: 1.4,
        stagger: { each: 0.05, from: 'end' },
        ease: 'power2.out',
      })
      .from('.logo', { y: -18, opacity: 0, duration: 0.7 }, '-=1.0');
    // only animate what this page renders (gsap warns on missing targets)
    const has = (sel: string) => brandPanel.querySelector(sel) !== null;
    if (has('.coords')) tl.from('.coords', { y: -14, opacity: 0, duration: 0.7 }, '-=0.55');
    if (map) {
      tl.from(mapGroup, { opacity: 0, duration: 1.2, ease: 'power1.out' }, '-=0.6');
      if (has('.brand-mountains')) {
        tl.from('.brand-mountains', { opacity: 0, y: 24, duration: 1.4, ease: 'power2.out' }, '<');
      }
    }
    tl.from('.headline .line > span', {
        yPercent: 110, duration: 0.9, stagger: 0.12, ease: 'power4.out',
      }, '-=0.5')
      .from('.sub', { opacity: 0, y: 14, duration: 0.7 }, '-=0.45');
    if (has('.features')) {
      tl.from('.features > li', { opacity: 0, y: 12, duration: 0.55, stagger: 0.08 }, '-=0.35');
    }
    if (has('.brand-aside')) tl.from('.brand-aside', { opacity: 0, duration: 0.9 }, '-=0.4');
    tl.from('.brand-bottom', { opacity: 0, duration: 0.8 }, '-=0.4')
      .to(route, {
        strokeDashoffset: 0,
        duration: 1.6,
        ease: 'power2.inOut',
        onComplete() { route.style.strokeDasharray = '7 7'; },
      }, '-=0.9')
      .from([nodeA.g, nodeB.g], { opacity: 0, scale: 0.5, transformOrigin: 'center', duration: 0.5, stagger: 0.25 }, '<+0.1');
    if (mapExtras.length) {
      tl.from(mapExtras, { opacity: 0, y: 8, duration: 0.6, stagger: 0.2 }, '>-0.2');
    }
    tl
      .from('[data-reveal]', {
        opacity: 0, y: 22, duration: 0.65, stagger: 0.075, ease: 'power3.out',
      }, 0.45);

    if (trip) {
      /* origin pulse → marker travels (eased, 5s) lighting the dashes →
         destination pulse → lit trail fades slowly → 6s pause → repeat */
      const { lit, revealStroke, marker, markerBody } = trip;
      const TRAVEL = 5;
      const wpLen = routeLen * waypointAt;
      const halo = routeGroup.querySelector('.waypoint-halo');
      const place = (p: number) => {
        const pt = route.getPointAtLength(routeLen * p);
        marker.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
        revealStroke.style.strokeDashoffset = String(routeLen * (1 - p));
      };
      const pulse = (ring: SVGCircleElement, to: number, duration: number) =>
        gsap.fromTo(ring, { attr: { r: 9 }, opacity: 0.85 },
          { attr: { r: to }, opacity: 0, duration, ease: 'power2.out' });

      gsap.set(markerBody, { opacity: 0, scale: 0.4, transformOrigin: '50% 50%' });
      const state = { p: 0 };
      let passedWaypoint = false;
      // starts when the entrance finishes (route drawn, nodes in), not on a
      // fixed timer: the entrance runs longer than any guess, and a marker
      // departing before its route exists looks broken
      const loop = gsap.timeline({ id: 'routeTrip', repeat: -1, repeatDelay: 6, paused: true });
      // (the delayed call is created outside this context's recording, so
      // cleanup can't cancel it — hence the disposed check)
      tl.eventCallback('onComplete', () => {
        gsap.delayedCall(0.6, () => { if (!disposed) loop.play(0); });
      });
      loop
        .call(() => {
          state.p = 0; passedWaypoint = false; place(0);
          gsap.set(lit, { opacity: 1 });
          pulse(nodeA.pulse as SVGCircleElement, 30, 0.95);
        }, [], 0)
        .to(markerBody, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(2)' }, 0.25)
        .to(state, {
          p: 1, duration: TRAVEL, ease: 'power2.inOut',
          onUpdate() {
            place(state.p);
            // brief brightening as the marker crosses the waypoint
            // (scale on the group: the halo's own opacity/r are busy breathing)
            if (!passedWaypoint && halo && routeLen * state.p >= wpLen) {
              passedWaypoint = true;
              gsap.fromTo(halo.parentNode, { scale: 1.35 },
                { scale: 1, duration: 0.7, ease: 'power2.out', transformOrigin: '50% 50%' });
            }
          },
        }, 0.35)
        .to(markerBody, { opacity: 0, scale: 0.4, duration: 0.35, ease: 'power2.in' }, `>-0.1`)
        .call(() => { pulse(nodeB.pulse as SVGCircleElement, 38, 1.3); }, [], '<')
        .to(lit, { opacity: 0, duration: 1.8, ease: 'sine.inOut' }, '>+0.5')
        .call(() => place(0), [], '>');
    }

    if (!map) {
      // walk cycle: alternating legs pivot at the hip, pole plants, body bobs per step
      const walk = gsap.timeline({ paused: true });
      walk
        .fromTo('#legBack',  { rotation: -24 }, { rotation: 24,  duration: 0.3, repeat: -1, yoyo: true, ease: 'sine.inOut', transformOrigin: '100% 0%' }, 0)
        .fromTo('#legFront', { rotation: 24 },  { rotation: -24, duration: 0.3, repeat: -1, yoyo: true, ease: 'sine.inOut', transformOrigin: '0% 0%' }, 0)
        .fromTo('#stick',    { rotation: -14 }, { rotation: 12,  duration: 0.3, repeat: -1, yoyo: true, ease: 'sine.inOut', transformOrigin: '20% 15%' }, 0)
        .to('#sherpaBob', { y: -1.1, duration: 0.15, repeat: -1, yoyo: true, ease: 'sine.inOut' }, 0);

      // drive cycle: wheels spin, cargo box rides the suspension
      const drive = gsap.timeline({ paused: true });
      drive
        .to(['#wheelB', '#wheelF'], { rotation: 360, duration: 0.55, repeat: -1, ease: 'none', transformOrigin: '50% 50%' }, 0)
        .to('#truckBody', { y: -0.7, duration: 0.38, repeat: -1, yoyo: true, ease: 'sine.inOut' }, 0);

      // the trek, in three legs: on foot out of the origin hall, by truck for
      // the long middle haul, then on foot for the final approach.
      const WP1 = 0.18, WP2 = 0.85;
      const mp = (s: number, e: number) => ({
        path: route, align: route, alignOrigin: [0.5, 0.88] as [number, number],
        autoRotate: false, start: s, end: e,
      });

      gsap.set(traveler, { opacity: 0, scale: 1.3, transformOrigin: '50% 88%' });
      gsap.set(truckFig, { opacity: 0 });

      const trek = gsap.timeline({ repeat: -1, repeatDelay: 1.8, delay: 2.8 });
      trek
        .set(sherpaFig, { opacity: 1 }, 0)
        .set(truckFig, { opacity: 0 }, 0)
        .to(traveler, { opacity: 1, duration: 0.35, ease: 'power1.out' }, 0)
        .to(traveler, { motionPath: mp(0, WP1), duration: 4.2, ease: 'power1.inOut',
            onStart() { walk.play(); } }, 0)
        .to(sherpaFig, { opacity: 0, duration: 0.3, onComplete() { walk.pause(); } }, '>+0.25')
        .to(truckFig,  { opacity: 1, duration: 0.3 }, '<+0.15')
        .to(traveler, { motionPath: mp(WP1, WP2), duration: 6.5, ease: 'power2.inOut',
            onStart() { drive.play(); }, onComplete() { drive.pause(); } }, '>+0.2')
        .to(truckFig,  { opacity: 0, duration: 0.3 }, '>+0.25')
        .to(sherpaFig, { opacity: 1, duration: 0.3, onStart() { walk.play(); } }, '<+0.15')
        .to(traveler, { motionPath: mp(WP2, 1), duration: 3.4, ease: 'power1.inOut' }, '>+0.2')
        .to(traveler, { opacity: 0, duration: 0.45, ease: 'power1.in', onComplete() { walk.pause(); } }, '>-0.15');
    }

    // classic: both nodes pulse continuously; map: the trip fires the pulses
    if (!map) {
      [nodeA.pulse, nodeB.pulse].forEach((p, i) => {
        gsap.fromTo(p,
          { attr: { r: 9 }, opacity: 0.8 },
          { attr: { r: 26 }, opacity: 0, duration: 2.2, repeat: -1, delay: i * 1.1, ease: 'power1.out' });
      });
    }
    const halo = routeGroup.querySelector('.waypoint-halo');
    if (halo) {
      gsap.to(halo, { attr: { r: 18 }, opacity: 0.35, duration: 1.4, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    }

    // gentle ridge drift + mouse parallax
    gsap.to(ridgeGroup, { y: -10, duration: 6, yoyo: true, repeat: -1, ease: 'sine.inOut' });

    const qx = gsap.quickTo(ridgeGroup, 'x', { duration: 1.2, ease: 'power3.out' });
    const rx = gsap.quickTo(routeGroup, 'x', { duration: 1.6, ease: 'power3.out' });
    // state names sit on the same map plane as the route, so they drift together
    const sx = map ? gsap.quickTo(mapGroup, 'x', { duration: 1.6, ease: 'power3.out' }) : null;
    mouseHandler = (e: MouseEvent) => {
      const r = brandPanel.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      qx(nx * -18);
      rx(nx * -30);
      sx?.(nx * -30);
    };
    brandPanel.addEventListener('mousemove', mouseHandler);
  }, brandPanel.parentElement ?? undefined);

  // drifting elevation readout
  const elevEl = brandPanel.querySelector('.elev');
  let elev = 128;
  const elevTicker = setInterval(() => {
    elev += Math.round((rand() - 0.5) * 4);
    if (elevEl) elevEl.textContent = elev + 'M';
  }, 3000);

  return () => {
    disposed = true;
    clearInterval(elevTicker);
    if (mouseHandler) brandPanel.removeEventListener('mousemove', mouseHandler);
    ctx.revert();
    svg.innerHTML = '';
  };
}
