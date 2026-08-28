/**
 * Dashboard "site network" map — compact variant of SitesMap
 * (components/sites/SitesMap.tsx). Dot markers instead of pin icons so
 * a hundred sites read as a network, and wheel zoom off so scrolling
 * the dashboard never gets captured by the map.
 */

import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { SiteItem } from '../../lib/api';

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [16, 16] });
  }, [map, points]);
  return null;
}

export default function DashSitesMap({ sites, onSelect }: {
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
    return <p className="dash-panel-empty">No sites have coordinates yet.</p>;
  }

  return (
    <MapContainer center={points[0]} zoom={2} className="dash-sites-map"
                  scrollWheelZoom={false} attributionControl={false}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <FitBounds points={points} />
      {located.map((s) => (
        <CircleMarker key={s.id} radius={5} weight={1.5}
                      center={[s.latitude as number, s.longitude as number]}
                      pathOptions={{
                        color: '#fbfcfd',
                        fillColor: s.status === 'active' ? '#ffa12e' : '#51606f',
                        fillOpacity: 0.9,
                      }}>
          <Popup>
            <b>{s.name}</b>
            <div>{s.type_label ?? '—'} · {s.status_label}</div>
            <button className="link-plain" onClick={() => onSelect(s.id)}>
              Open details
            </button>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
