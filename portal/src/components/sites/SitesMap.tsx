/** Leaflet map of sites that have coordinates. Tile source is the shared
 *  English-labeled basemap (lib/mapTiles.ts) — no API key, no account.
 *  Full-map pins are tinted by each site's status color; clicking one
 *  hands the site id to the caller (the Sites page shows the row detail
 *  below the map). */

import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { SiteItem } from '../../lib/api';
import { MAP_TILE_ATTRIBUTION, MAP_TILE_URL } from '../../lib/mapTiles';

// Leaflet's default marker icons resolve to broken paths under a bundler;
// point them at the packaged assets explicitly.
const icon = L.icon({
  iconUrl: new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href,
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  shadowUrl: new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href,
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [map, points]);
  return null;
}

// street-level: the locator answers "which block", the modal lets you wander
const MINI_ZOOM = 16;

/** Small single-site locator for the row expansion: surrounding streets,
 *  marker centered, interactions off — clicking it opens the interactive
 *  modal at the same zoom. Rendered only when the site has coordinates. */
export function SiteMiniMap({ site, onOpen }: {
  site: SiteItem;
  onOpen: () => void;
}) {
  if (site.latitude === null || site.longitude === null) return null;
  const point: [number, number] = [site.latitude, site.longitude];
  return (
    <button type="button" className="site-mini-map-wrap" onClick={onOpen}
            aria-label={`Open map for ${site.name}`}>
      <MapContainer center={point} zoom={MINI_ZOOM} className="site-mini-map"
                    zoomControl={false} dragging={false} scrollWheelZoom={false}
                    doubleClickZoom={false} touchZoom={false} keyboard={false}
                    attributionControl={false}>
        <TileLayer url={MAP_TILE_URL} />
        <Marker position={point} icon={icon} interactive={false} />
      </MapContainer>
      <span className="site-mini-map-hint">Click to explore</span>
    </button>
  );
}

/** Full-size interactive map in a modal — opens at the locator's zoom. */
export function SiteMapModal({ site, onClose }: {
  site: SiteItem;
  onClose: () => void;
}) {
  if (site.latitude === null || site.longitude === null) return null;
  const point: [number, number] = [site.latitude, site.longitude];
  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card site-map-modal-card">
        <div className="modal-head">
          <h3>{site.name} — map</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body site-map-modal-body">
          <MapContainer center={point} zoom={MINI_ZOOM} className="site-map-modal-map">
            <TileLayer attribution={MAP_TILE_ATTRIBUTION} url={MAP_TILE_URL} />
            <Marker position={point} icon={icon}>
              <Popup>
                <b>{site.name}</b>
                <div>{[site.address_line1, site.city, site.region]
                  .filter(Boolean).join(', ') || 'No address on file'}</div>
              </Popup>
            </Marker>
          </MapContainer>
        </div>
      </div>
    </div>
  );
}

/* Status-tinted teardrop pin as a divIcon — one cached icon per color.
   status_color is a vocabulary hex straight off the list payload. */
const pinCache = new Map<string, L.DivIcon>();
function statusPin(color: string): L.DivIcon {
  let pin = pinCache.get(color);
  if (!pin) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36">`
      + `<path d="M13 1C6.4 1 1 6.4 1 13c0 9 12 22 12 22s12-13 12-22C25 6.4 19.6 1 13 1z"`
      + ` fill="${color}" stroke="#ffffff" stroke-width="1.6"/>`
      + `<circle cx="13" cy="13" r="4.5" fill="#ffffff" fill-opacity="0.9"/></svg>`;
    pin = L.divIcon({
      className: 'site-status-pin', html: svg,
      iconSize: [26, 36], iconAnchor: [13, 35], tooltipAnchor: [0, -30],
    });
    pinCache.set(color, pin);
  }
  return pin;
}

export default function SitesMap({ sites, onSelect }: {
  sites: SiteItem[];
  onSelect: (id: string) => void;
}) {
  const located = useMemo(
    () => sites.filter((s) => s.latitude !== null && s.longitude !== null),
    [sites],
  );
  const points = useMemo(
    () => located.map((s) => [s.latitude as number, s.longitude as number] as [number, number]),
    [located],
  );

  if (!located.length) {
    return <p className="set-note">No sites have coordinates yet.</p>;
  }

  return (
    <MapContainer center={points[0]} zoom={4} className="sites-map">
      <TileLayer attribution={MAP_TILE_ATTRIBUTION} url={MAP_TILE_URL} />
      <FitBounds points={points} />
      {located.map((s) => (
        <Marker key={s.id} icon={statusPin(s.status_color)}
                position={[s.latitude as number, s.longitude as number]}
                eventHandlers={{ click: () => onSelect(s.id) }}>
          <Tooltip direction="top">
            <b>{s.name}</b> · {s.status_label}
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
