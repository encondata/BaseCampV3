/**
 * "In transit" panel map — planned routes of active move initiatives:
 * origin/destination dots joined by a dashed lane, drawn from the sites
 * list's coordinates. Live truck tracking isn't built yet, so the panel
 * wears a COMING SOON chip; the routes are real, the trucks aren't.
 */

import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { InitiativeItem, SiteItem } from '../../lib/api';
import { MAP_TILE_URL } from '../../lib/mapTiles';

interface Route {
  id: string;
  name: string;
  from: [number, number];
  to: [number, number];
  originName: string;
  destinationName: string;
}

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [28, 28] });
  }, [map, points]);
  return null;
}

export function transitRoutes(moves: InitiativeItem[], sites: SiteItem[]): Route[] {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const routes: Route[] = [];
  for (const m of moves) {
    const o = m.origin_site_id ? byId.get(m.origin_site_id) : undefined;
    const d = m.destination_site_id ? byId.get(m.destination_site_id) : undefined;
    if (!o || !d) continue;
    if (o.latitude === null || o.longitude === null) continue;
    if (d.latitude === null || d.longitude === null) continue;
    routes.push({
      id: m.id,
      name: m.name,
      from: [o.latitude, o.longitude],
      to: [d.latitude, d.longitude],
      originName: o.name,
      destinationName: d.name,
    });
  }
  return routes;
}

export default function TransitMap({ moves, sites }: {
  moves: InitiativeItem[];
  sites: SiteItem[];
}) {
  const routes = useMemo(() => transitRoutes(moves, sites), [moves, sites]);
  const points = useMemo(
    () => routes.flatMap((r) => [r.from, r.to]),
    [routes],
  );

  return (
    <div className="dash-transit">
      {routes.length === 0 ? (
        <div className="dash-transit-empty">
          No mapped routes — active moves need origin and destination
          sites with coordinates.
        </div>
      ) : (
        <MapContainer center={points[0]} zoom={4} className="dash-sites-map"
                      scrollWheelZoom={false} attributionControl={false}>
          <TileLayer url={MAP_TILE_URL} />
          <FitBounds points={points} />
          {routes.map((r) => (
            <Polyline key={`lane-${r.id}`} positions={[r.from, r.to]}
                      pathOptions={{ color: '#ffa12e', weight: 2, dashArray: '6 7', opacity: 0.85 }} />
          ))}
          {routes.map((r) => (
            <CircleMarker key={`o-${r.id}`} center={r.from} radius={5} weight={1.5}
                          pathOptions={{ color: '#fbfcfd', fillColor: '#51606f', fillOpacity: 0.95 }}>
              <Popup><b>{r.originName}</b><div>Origin — {r.name}</div></Popup>
            </CircleMarker>
          ))}
          {routes.map((r) => (
            <CircleMarker key={`d-${r.id}`} center={r.to} radius={5} weight={1.5}
                          pathOptions={{ color: '#fbfcfd', fillColor: '#ffa12e', fillOpacity: 0.95 }}>
              <Popup><b>{r.destinationName}</b><div>Destination — {r.name}</div></Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      )}
      <span className="dash-transit-badge">Live truck tracking · coming soon</span>
    </div>
  );
}
