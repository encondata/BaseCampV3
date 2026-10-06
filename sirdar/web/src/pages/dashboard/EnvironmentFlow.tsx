/** An environment's flow: live traffic → the middle box (a DigitalOcean load
 *  balancer, or Nginx Proxy Manager on the LAN) → its server(s), with SVG
 *  connectors drawn behind the boxes and glowing dots that GSAP moves along
 *  the live path only. Paths are measured from the laid-out boxes and
 *  recomputed on resize; a new environment remounts it (key), so it measures
 *  and animates afresh. Motion off (portal preference, `data-motion="off"` on
 *  the shell, or prefers-reduced-motion) leaves the dots static. */
import { gsap } from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type { DashFlow, DashServer } from '../../lib/sirdarApi';

import { CloudIcon, LoadBalancerIcon, ServerRackIcon } from './icons';
import { Dot, type Tone } from './parts';

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

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_QUERY).matches;
}

/** Tracks the OS reduced-motion setting, re-rendering when it is toggled. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

const title = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const healthTone = (h: string): Tone => (h === 'healthy' ? 'ok' : h === 'degraded' ? 'warn' : 'muted');
const MIDDLE_STATUS: Record<string, string> = { ok: 'Active', warn: 'Busy', down: 'Not found', unknown: 'Unknown' };

function ServerBox({ server, flow, action, boxRef }: {
  server: DashServer; flow: DashFlow; action: ReactNode; boxRef: (el: HTMLDivElement | null) => void;
}) {
  const live = server.state === 'live';
  const empty = server.state === 'empty';
  const deploying = flow.deploying_slot === server.id;
  const failed = flow.failed_slot === server.id;
  const [tagClass, tag] = deploying ? ['is-deploying', 'Deploying'] : failed ? ['is-failed', 'Failed']
    : live ? ['is-active', 'Live'] : server.state === 'idle' ? ['is-standby', 'Idle'] : ['', ''];
  return (
    <div ref={boxRef} className={`sd-slot is-${live ? 'active' : empty ? 'empty' : 'standby'}`
      + `${deploying ? ' is-deploying' : ''}${failed ? ' is-failed' : ''}`}>
      <div className="sd-slot-icon">
        <ServerRackIcon size={30} />
        <span className={`sd-icon-dot is-${live ? 'blue' : 'muted'}`} aria-hidden="true" />
      </div>
      <div className="sd-slot-main">
        <div className="sd-slot-title">
          <b>{server.label}</b>
          {tag && <span className={`sd-slot-tag ${tagClass}`}>{tag}</span>}
        </div>
        <div className="sd-muted">{server.sub}</div>
        {empty && !deploying ? <div className="sd-muted">Not deployed</div> : (
          <>
            {server.version && <div className="sd-slot-version">{server.version}</div>}
            <div className="sd-slot-health"><Dot tone={healthTone(server.health)} />{title(server.health)}</div>
          </>
        )}
      </div>
      {action}
    </div>
  );
}

export default function EnvironmentFlow({ flow, motion, serverAction }: {
  flow: DashFlow; motion: boolean; serverAction?: (server: DashServer) => ReactNode;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const liveIdx = flow.kind === 'none' ? -1 : flow.servers.findIndex((s) => s.state === 'live');
  const showDots = liveIdx >= 0;

  const diagramRef = useRef<HTMLDivElement>(null);
  const trafficRef = useRef<HTMLDivElement>(null);
  const lbRef = useRef<HTMLDivElement>(null);
  const boxEls = useRef<(HTMLDivElement | null)[]>([]);
  const segPathRef = useRef<SVGPathElement>(null);
  const curvePathRefs = useRef<(SVGPathElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const [geo, setGeo] = useState<Geo>(EMPTY_GEO);
  const geoKey = useRef('');
  const reducedMotion = useReducedMotion();

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
    const curves = boxEls.current.slice(0, flow.servers.length).filter(Boolean).map((el) => {
      const s = r(el!);
      const a = { x: lr.r, y: lr.cy }, b = { x: s.l - 1, y: s.cy };
      const mid = (a.x + b.x) / 2;
      return { a, c1: { x: mid, y: a.y }, c2: { x: mid, y: b.y }, b };
    });
    const next = { seg, curves };
    const key = JSON.stringify(next);
    if (key !== geoKey.current) { geoKey.current = key; setGeo(next); }
  }, [flow.servers.length]);

  useLayoutEffect(() => {
    measure();
    const root = diagramRef.current;
    if (!root) return undefined;
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => measure());
      ro.observe(root);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const liveCurve = liveIdx >= 0 ? geo.curves[liveIdx] : undefined;
  const staticDots: Pt[] = [];
  if (showDots) {
    for (let i = 0; i < DOTS_PER_PATH; i += 1) staticDots.push(onLine(geo.seg, (i + 0.5) / DOTS_PER_PATH));
    for (let i = 0; i < DOTS_PER_PATH; i += 1) {
      staticDots.push(liveCurve ? onCurve(liveCurve, (i + 0.5) / DOTS_PER_PATH) : ZERO);
    }
  }

  useEffect(() => {
    const root = diagramRef.current;
    if (!root || !showDots || !motion || !geo.curves.length || reducedMotion) return undefined;
    if (root.closest('.portal-shell')?.getAttribute('data-motion') === 'off') return undefined;
    const seg = segPathRef.current, curve = curvePathRefs.current[liveIdx];
    // jsdom (and very old engines) have no SVG geometry; keep the static dots
    if (!seg || !curve || typeof (seg as { getTotalLength?: unknown }).getTotalLength !== 'function') {
      return undefined;
    }
    const dots = dotRefs.current.slice();
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
    return () => {
      ctx.revert();
      // onUpdate writes inline opacity, which ctx.revert() does not know about
      dots.forEach((d) => { if (d) d.style.opacity = ''; });
    };
  }, [showDots, motion, reducedMotion, liveIdx, geo]);

  const markerBlue = `${uid}-ab`, markerGray = `${uid}-ag`;
  const middleTone: Tone = flow.middle.status === 'ok' ? 'ok' : flow.middle.status === 'unknown' ? 'muted' : 'warn';

  return (
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
          <path ref={segPathRef} d={lineD(geo.seg)} className={`sd-flow-seg ${showDots ? 'is-live' : 'is-idle'}`}
                markerEnd={`url(#${showDots ? markerBlue : markerGray})`} />
          {flow.servers.map((s, i) => {
            const on = i === liveIdx;
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
            <b>Live traffic</b>
            <div className="sd-muted">External users</div>
          </div>
        </div>

        <div className={`sd-node sd-node-lb is-${flow.middle.status}`} ref={lbRef}>
          <LoadBalancerIcon size={34} className="sd-node-icon" />
          <div>
            <b>{flow.middle.label}</b>
            {flow.middle.sub && <div className={showDots ? 'sd-accent' : 'sd-muted'}>{flow.middle.sub}</div>}
            {flow.kind === 'load_balancer' && (
              <div className="sd-node-status"><Dot tone={middleTone} />{MIDDLE_STATUS[flow.middle.status] ?? flow.middle.status}</div>
            )}
          </div>
        </div>

        <div className="sd-slots">
          {flow.servers.map((s, i) => (
            <ServerBox key={s.id} server={s} flow={flow} action={serverAction?.(s) ?? null}
                       boxRef={(el) => { boxEls.current[i] = el; }} />
          ))}
        </div>
      </div>
    </div>
  );
}
