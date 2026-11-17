/**
 * LocationMapPreview — wraps an asset's location (a crate link) and,
 * after a 300 ms hover or on keyboard focus, shows a small map of where
 * that container is now: its truck's last GPS report, or the pin of the
 * site it sits at, with a line saying which.
 *
 *   <LocationMapPreview containerId={c.id}>{link}</LocationMapPreview>
 *
 * Mechanics are PhotoPreview's (components/PhotoPreview.tsx), and its
 * `previewPosition` / `PREVIEW_DELAY_MS` are reused rather than copied:
 *  - the wrapper is `display: contents`, so the link's layout is
 *    unchanged; the card anchors off the link's own rect (the wrapper's
 *    first element child).
 *  - portaled into `.closest('.portal-shell') ?? document.body`, so the
 *    theme tokens (and dark mode) still apply.
 *  - closes on mouse leave, blur, any scroll (capture), Escape and
 *    unmount; `pointer-events: none`, and no handler here stops or
 *    consumes an event, so clicks on the link work as before.
 *  - focus and blur bubble in React, so focusing the wrapped link opens
 *    the card the same way a hover does.
 *
 * The position is fetched only once the delay has elapsed (a pointer
 * passing over a list never fetches) and goes through the per-container
 * cache in lib/containerPosition.ts.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CircleMarker, MapContainer, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import type { ContainerPosition } from '../../lib/api';
import { loadContainerPosition, positionLines } from '../../lib/containerPosition';
import { MAP_TILE_ATTRIBUTION, MAP_TILE_URL } from '../../lib/mapTiles';
import { PREVIEW_DELAY_MS, previewPosition } from '../PhotoPreview';

import '../../styles/location-map-preview.css';

/** Card box before it has been measured: the 280 px map + 8 px padding
 *  and 1 px border either side, with the title and detail lines. Only
 *  decides which side to open on for the first paint; the measured size
 *  replaces it as soon as the card is laid out. */
const EST_W = 296;
const EST_H = 230;

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; position: ContainerPosition };

export default function LocationMapPreview({ containerId, children }: {
  containerId: string;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  /** Bumped on every open and close, so an answer that arrives after the
   *  card closed (or reopened for another container) is dropped. */
  const requestRef = useRef(0);
  const [open, setOpen] = useState<{ host: HTMLElement } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const anchorRect = (): DOMRect | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    return ((wrap.firstElementChild as HTMLElement | null) ?? wrap).getBoundingClientRect();
  };

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const close = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    requestRef.current += 1;
    setOpen(null);
    setPos(null);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    requestRef.current += 1;
  }, []);

  const show = () => {
    timerRef.current = null;
    const wrap = wrapRef.current;
    const rect = anchorRect();
    if (!wrap || !rect) return;
    const host = (wrap.closest('.portal-shell') as HTMLElement | null) ?? document.body;
    const request = ++requestRef.current;
    setLoad({ state: 'loading' });
    setPos(previewPosition(rect, window.innerWidth, window.innerHeight, EST_W, EST_H));
    setOpen({ host });
    loadContainerPosition(containerId).then(
      (position) => {
        if (requestRef.current === request) setLoad({ state: 'ready', position });
      },
      () => {
        if (requestRef.current === request) setLoad({ state: 'error' });
      },
    );
  };

  const onEnter = () => {
    clearTimer();
    timerRef.current = window.setTimeout(show, PREVIEW_DELAY_MS);
  };

  // A different container behind the same wrapper closes the card.
  useEffect(() => { close(); }, [containerId, close]);

  // Once the card is laid out (and again whenever its contents change
  // from the loading line to the map), replace the estimate with its
  // measured size before the browser paints.
  useLayoutEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    const rect = anchorRect();
    if (!card || !rect) return;
    const { width, height } = card.getBoundingClientRect();
    if (!width || !height) return;
    const next = previewPosition(rect, window.innerWidth, window.innerHeight, width, height);
    setPos((cur) => (cur && cur.left === next.left && cur.top === next.top ? cur : next));
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, close]);

  return (
    <span ref={wrapRef} className="lmp-wrap"
          onMouseEnter={onEnter} onMouseLeave={close}
          onFocus={onEnter} onBlur={close}>
      {children}
      {open && pos && createPortal(
        <div ref={cardRef} className="lmp-card" role="tooltip"
             style={{ left: pos.left, top: pos.top }}>
          <CardBody load={load} />
        </div>,
        open.host,
      )}
    </span>
  );
}

function CardBody({ load }: { load: Load }) {
  if (load.state === 'loading') return <span className="lmp-note">Loading position…</span>;
  if (load.state === 'error') return <span className="lmp-note">Couldn't load the position</span>;
  const p = load.position;
  const { title, detail, note } = positionLines(p);
  const center: [number, number] | null =
    p.lat !== null && p.lng !== null ? [p.lat, p.lng] : null;
  return (
    <>
      {title && <span className="lmp-title">{title}</span>}
      {center && (
        <MapContainer key={center.join(',')} className="lmp-map" center={center} zoom={12}
                      zoomControl={false} dragging={false} scrollWheelZoom={false}
                      doubleClickZoom={false} touchZoom={false} boxZoom={false}
                      keyboard={false}>
          <TileLayer url={MAP_TILE_URL} attribution={MAP_TILE_ATTRIBUTION} />
          <CircleMarker center={center} radius={7}
                        pathOptions={{
                          className: p.kind === 'site' ? 'lmp-pin-site' : 'lmp-pin-truck',
                        }} />
        </MapContainer>
      )}
      {detail && <span className="lmp-detail">{detail}</span>}
      {note && <span className="lmp-note">{note}</span>}
    </>
  );
}
