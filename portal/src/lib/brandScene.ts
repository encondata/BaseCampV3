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

/* Builds the brand panel scene (ridgelines, migration route, traveler) inside
   the svg element and animates it. Returns a cleanup function. Ported from the
   approved design (fable-serversherpa-login.html). */
export function buildBrandScene(
  brandPanel: HTMLElement,
  svg: SVGSVGElement,
  reduceMotion: boolean,
): () => void {
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

  /* migration route: origin → destination, climbing the right half */
  const routeGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(routeGroup);

  const A = { x: W * 0.63, y: H * 0.78 };
  const B = { x: W * 0.86, y: Math.max(H * 0.24, 112) };
  const m1 = { x: A.x + 0.05 * W, y: A.y - 0.3 * H };
  const routeD = `M ${A.x} ${A.y}
    C ${A.x + 0.16 * W} ${A.y - 0.06 * H}, ${A.x - 0.06 * W} ${A.y - 0.22 * H}, ${m1.x} ${m1.y}
    C ${m1.x + 0.11 * W} ${m1.y - 0.08 * H}, ${B.x - 0.16 * W} ${B.y + 0.1 * H}, ${B.x} ${B.y}`;

  const route = document.createElementNS(SVG_NS, 'path');
  route.setAttribute('d', routeD);
  route.setAttribute('class', 'route-path');
  routeGroup.appendChild(route);

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

  const nodeA = makeNode(A, 'ORIGIN · DAL-7', 'Las Vegas, NV — HALL B', 'middle');
  const nodeB = makeNode(B, 'DEST · ZRH-3', 'ZÜRICH, CH — HALL A', 'end');

  // the traveler rides the route as one group holding two figures that swap:
  // a mini sherpa (rack on his back, trekking pole) and a box truck for the
  // highway leg. Both share a ground line at local y≈9 so the handoff is seamless.
  const traveler = document.createElementNS(SVG_NS, 'g');
  traveler.setAttribute('class', 'walker');
  traveler.innerHTML = `
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
  routeGroup.appendChild(traveler);
  const sherpaFig = traveler.querySelector('#sherpaFig');
  const truckFig = traveler.querySelector('#truckFig');

  const routeLen = route.getTotalLength();
  route.style.strokeDasharray = String(routeLen);
  route.style.strokeDashoffset = String(routeLen);

  let mouseHandler: ((e: MouseEvent) => void) | null = null;

  const ctx = gsap.context(() => {
    if (reduceMotion) {
      route.style.strokeDasharray = '7 7';
      route.style.strokeDashoffset = '0';
      gsap.set(traveler, { opacity: 0 });
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
      .from('.logo', { y: -18, opacity: 0, duration: 0.7 }, '-=1.0')
      .from('.coords', { y: -14, opacity: 0, duration: 0.7 }, '-=0.55')
      .from('.headline .line > span', {
        yPercent: 110, duration: 0.9, stagger: 0.12, ease: 'power4.out',
      }, '-=0.5')
      .from('.sub', { opacity: 0, y: 14, duration: 0.7 }, '-=0.45')
      .from('.brand-bottom', { opacity: 0, duration: 0.8 }, '-=0.4')
      .to(route, {
        strokeDashoffset: 0,
        duration: 1.6,
        ease: 'power2.inOut',
        onComplete() { route.style.strokeDasharray = '7 7'; },
      }, '-=0.9')
      .from([nodeA.g, nodeB.g], { opacity: 0, scale: 0.5, transformOrigin: 'center', duration: 0.5, stagger: 0.25 }, '<+0.1')
      .from('[data-reveal]', {
        opacity: 0, y: 22, duration: 0.65, stagger: 0.075, ease: 'power3.out',
      }, 0.45);

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

    [nodeA.pulse, nodeB.pulse].forEach((p, i) => {
      gsap.fromTo(p,
        { attr: { r: 9 }, opacity: 0.8 },
        { attr: { r: 26 }, opacity: 0, duration: 2.2, repeat: -1, delay: i * 1.1, ease: 'power1.out' });
    });

    // gentle ridge drift + mouse parallax
    gsap.to(ridgeGroup, { y: -10, duration: 6, yoyo: true, repeat: -1, ease: 'sine.inOut' });

    const qx = gsap.quickTo(ridgeGroup, 'x', { duration: 1.2, ease: 'power3.out' });
    const rx = gsap.quickTo(routeGroup, 'x', { duration: 1.6, ease: 'power3.out' });
    mouseHandler = (e: MouseEvent) => {
      const r = brandPanel.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      qx(nx * -18);
      rx(nx * -30);
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
    clearInterval(elevTicker);
    if (mouseHandler) brandPanel.removeEventListener('mousemove', mouseHandler);
    ctx.revert();
    svg.innerHTML = '';
  };
}
