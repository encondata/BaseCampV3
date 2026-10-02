/** Production card: live traffic → load balancer → Blue/Green slots, with SVG
 *  connectors drawn behind the boxes and glowing dots that GSAP moves along
 *  the active path. Paths are measured from the laid-out boxes and recomputed
 *  on resize. Motion off (portal preference, `data-motion="off"` on the shell
 *  or prefers-reduced-motion) leaves the dots static. */
import { gsap } from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import type { DashProduction, DashSlot } from '../../lib/sirdarApi';

import { CloudIcon, LoadBalancerIcon, ServerRackIcon } from './icons';
import { Dot, SoonButton } from './parts';

gsap.registerPlugin(MotionPathPlugin);

const DOTS_PER_PATH = 6;
const TRIP_SECONDS = 2.5;

type Pt = { x: number; y: number };
type Line = { a: Pt; b: Pt };
type Curve = { a: Pt; c1: Pt; c2: Pt; b: Pt };
type Geo = { seg: Line; curves: Curve[] };

const ZERO: Pt = { x: 0, y: 0 };
const EMPTY_GEO: Geo = { seg: { a: ZERO, b: ZERO }, curves: [] };

const lineD = ({ a, b }: Line) => `M${a.x},${a.y} L${b.x},${b.y}`;
const curveD = ({ a, c1, c2, b }: Curve) => `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;

function onLine({ a, b }: Line, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function onCurve({ a, c1, c2, b }: Curve, t: number): Pt {
  const u = 1 - t;
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: k[0] * a.x + k[1] * c1.x + k[2] * c2.x + k[3] * b.x,
    y: k[0] * a.y + k[1] * c1.y + k[2] * c2.y + k[3] * b.y,
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function title(id: string) {
  return id ? id[0].toUpperCase() + id.slice(1) : id;
}

function SlotCard({ slot, slotRef }: { slot: DashSlot; slotRef: (el: HTMLDivElement | null) => void }) {
  const active = slot.state === 'active';
  const empty = slot.state === 'empty';
  const healthTone = slot.health === 'healthy' ? 'ok' : slot.health === 'degraded' ? 'warn' : 'muted';
  return (
    <div ref={slotRef} className={`sd-slot is-${active ? 'active' : empty ? 'empty' : 'standby'}`}>
      <div className="sd-slot-icon">
        <ServerRackIcon size={30} />
        <span className={`sd-icon-dot is-${active ? 'blue' : 'muted'}`} aria-hidden="true" />
      </div>
      <div className="sd-slot-main">
        <div className="sd-slot-title">
          <b>{slot.label}</b>
          {!empty && <span className={`sd-slot-tag is-${active ? 'active' : 'standby'}`}>{title(slot.state)}</span>}
        </div>
        {empty ? (
          <div className="sd-muted">Not deployed</div>
        ) : (
          <>
            {slot.version && <div className="sd-slot-version">{slot.version}</div>}
            <div className="sd-slot-health">
              {active
                ? <><Dot tone={healthTone} />{title(slot.health)}</>
                : <><Dot tone="muted" />Standby</>}
            </div>
          </>
        )}
      </div>
      {!empty && (
        <>
          <div className="sd-vdivider" aria-hidden="true" />
          <div className="sd-slot-stats">
            <div>{slot.instances.running} / {slot.instances.total} instances</div>
            <div className={`sd-slot-traffic${active ? ' is-active' : ''}`}>{slot.traffic_pct}% traffic</div>
          </div>
          {!active && <SoonButton className="sd-btn-outline sd-slot-action">Activate {title(slot.id)}</SoonButton>}
        </>
      )}
    </div>
  );
}

export default function ProductionFlow({ production, motion }: { production: DashProduction; motion: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const headingId = `${uid}-h`;
  const live = production.status === 'active' && !!production.active_slot;
  const lbOn = production.load_balancer.present;

  const diagramRef = useRef<HTMLDivElement>(null);
  const trafficRef = useRef<HTMLDivElement>(null);
  const lbRef = useRef<HTMLDivElement>(null);
  const slotEls = useRef<(HTMLDivElement | null)[]>([]);
  const segPathRef = useRef<SVGPathElement>(null);
  const curvePathRefs = useRef<(SVGPathElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const [geo, setGeo] = useState<Geo>(EMPTY_GEO);
  const geoKey = useRef('');

  const measure = useCallback(() => {
    const root = diagramRef.current, t = trafficRef.current, lb = lbRef.current;
    if (!root || !t || !lb) return;
    const o = root.getBoundingClientRect();
    const r = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { l: b.left - o.left, r: b.right - o.left, cy: b.top - o.top + b.height / 2 };
    };
    const tr = r(t), lr = r(lb);
    const seg: Line = { a: { x: tr.r, y: tr.cy }, b: { x: lr.l - 1, y: lr.cy } };
    const curves = slotEls.current.filter(Boolean).map((el) => {
      const s = r(el!);
      const a = { x: lr.r, y: lr.cy }, b = { x: s.l - 1, y: s.cy };
      const mid = (a.x + b.x) / 2;
      return { a, c1: { x: mid, y: a.y }, c2: { x: mid, y: b.y }, b };
    });
    const next = { seg, curves };
    const key = JSON.stringify(next);
    if (key !== geoKey.current) { geoKey.current = key; setGeo(next); }
  }, []);

  useLayoutEffect(() => {
    measure();
    const root = diagramRef.current;
    if (!root) return;
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => measure());
      ro.observe(root);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, production.slots.length]);

  const activeIdx = live ? production.slots.findIndex((s) => s.id === production.active_slot) : -1;
  const activeCurve = activeIdx >= 0 ? geo.curves[activeIdx] : undefined;
  const showDots = live && activeIdx >= 0;

  const staticDots: Pt[] = [];
  if (showDots) {
    for (let i = 0; i < DOTS_PER_PATH; i += 1) staticDots.push(onLine(geo.seg, (i + 0.5) / DOTS_PER_PATH));
    for (let i = 0; i < DOTS_PER_PATH; i += 1) {
      staticDots.push(activeCurve ? onCurve(activeCurve, (i + 0.5) / DOTS_PER_PATH) : ZERO);
    }
  }

  useEffect(() => {
    const root = diagramRef.current;
    if (!root || !showDots || !motion || !geo.curves.length || prefersReducedMotion()) return undefined;
    if (root.closest('.portal-shell')?.getAttribute('data-motion') === 'off') return undefined;
    const seg = segPathRef.current, curve = curvePathRefs.current[activeIdx];
    // jsdom (and very old engines) have no SVG geometry; keep the static dots
    if (!seg || !curve || typeof (seg as { getTotalLength?: unknown }).getTotalLength !== 'function') {
      return undefined;
    }
    const ctx = gsap.context(() => {
      dotRefs.current.forEach((dot, i) => {
        if (!dot) return;
        const path = i < DOTS_PER_PATH ? seg : curve;
        gsap.set(dot, { attr: { cx: 0, cy: 0 } });
        gsap.to(dot, {
          motionPath: { path, align: path, alignOrigin: [0.5, 0.5] },
          duration: TRIP_SECONDS,
          ease: 'none',
          repeat: -1,
          onUpdate(this: gsap.core.Tween) {
            const p = this.progress();
            dot.style.opacity = String(Math.min(1, p * 8, (1 - p) * 8));
          },
        }).progress((i % DOTS_PER_PATH) / DOTS_PER_PATH);
      });
    }, root);
    return () => ctx.revert();
  }, [showDots, motion, activeIdx, geo]);

  const markerBlue = `${uid}-ab`, markerGray = `${uid}-ag`;

  return (
    <section className="sd-card sd-prod" aria-labelledby={headingId}>
      <header className="sd-card-head">
        <h2 id={headingId}>Production</h2>
        {live
          ? <span className="sd-pill is-ok"><Dot tone="ok" />Deployment active</span>
          : <span className="sd-pill is-muted"><Dot tone="muted" />No active deployment</span>}
      </header>
      <div className="sd-flow">
        <div className="sd-flow-diagram" ref={diagramRef}>
          <svg className="sd-flow-svg" aria-hidden="true" focusable="false">
            <defs>
              {[[markerBlue, 'is-live'], [markerGray, 'is-idle']].map(([id, cls]) => (
                <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8"
                        markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M0,0 L10,5 L0,10 Z" className={`sd-flow-arrow ${cls}`} />
                </marker>
              ))}
            </defs>
            <path ref={segPathRef} d={lineD(geo.seg)} className={`sd-flow-seg ${live || lbOn ? 'is-live' : 'is-idle'}`}
                  markerEnd={`url(#${live || lbOn ? markerBlue : markerGray})`} />
            {production.slots.map((s, i) => {
              const on = i === activeIdx;
              const c = geo.curves[i];
              return (
                <path key={s.id} ref={(el) => { curvePathRefs.current[i] = el; }}
                      d={c ? curveD(c) : 'M0,0'} className={`sd-flow-curve ${on ? 'is-live' : 'is-idle'}`}
                      markerEnd={`url(#${on ? markerBlue : markerGray})`} />
              );
            })}
            {staticDots.map((p, i) => (
              <circle key={i} ref={(el) => { dotRefs.current[i] = el; }} className="sd-flow-dot"
                      r="3.5" cx={p.x} cy={p.y} />
            ))}
          </svg>

          <div className="sd-node sd-node-traffic" ref={trafficRef}>
            <CloudIcon size={40} className="sd-node-icon" />
            <div>
              <b>{production.traffic.label}</b>
              <div className="sd-muted">{production.traffic.sub}</div>
            </div>
          </div>

          <div className="sd-node sd-node-lb" ref={lbRef}>
            <LoadBalancerIcon size={34} className="sd-node-icon" />
            <div>
              <b>{production.load_balancer.label}</b>
              <div className={lbOn ? 'sd-accent' : 'sd-muted'}>{production.load_balancer.sub}</div>
            </div>
          </div>

          <div className="sd-slots">
            {production.slots.map((s, i) => (
              <SlotCard key={s.id} slot={s} slotRef={(el) => { slotEls.current[i] = el; }} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
