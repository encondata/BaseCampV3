/**
 * Trucks map — status-colored `CircleMarker` per truck with a reported
 * location, tooltip name/status/address/age, optional trail polylines,
 * and a fit-to-bounds child that re-frames whenever the set of mapped
 * points changes. Shared between the Trucks list's map panel (filtered
 * to the visible rows) and its fullscreen modal — both render this
 * component, just at different sizes via `className`.
 */

import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { TruckMapPoint } from '../../lib/api';
import { MAP_TILE_ATTRIBUTION, MAP_TILE_URL } from '../../lib/mapTiles';
import { updateAge } from '../../lib/trucks';

function FitBounds({ points, trails }: { points: TruckMapPoint[]; trails: boolean }) {
  const map = useMap();
  // Frame the latest positions — and, when trails are drawn, every trail
  // point too, so a single truck's route (the detail page) isn't reduced
  // to its last marker.
  const centers = points.flatMap((p) => [
    [p.last_update.lat as number, p.last_update.lng as number] as [number, number],
    ...(trails ? p.trail.map((t) => [t.lat, t.lng] as [number, number]) : []),
  ]);
  // Re-fit whenever the *set of ids* (or the trails toggle) changes — a
  // plain re-fetch that returns the same trucks at slightly nudged
  // coordinates shouldn't reset the user's pan/zoom.
  const key = `${trails ? 'T' : 'M'}:${points.map((p) => p.id).sort().join(',')}`;
  useEffect(() => {
    if (!centers.length) return undefined;
    // Defer one frame: the panel (and the fullscreen modal) mount the map
    // before layout has given it a size, and fitBounds on a 0×0 container
    // collapses to max zoom. invalidateSize re-measures first; maxZoom
    // keeps a single truck (or two close ones) from zooming to street level.
    const bounds = L.latLngBounds(centers);
    const raf = window.requestAnimationFrame(() => {
      map.invalidateSize?.();
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    });
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

export default function TrucksMap({ points, trails, onOpen, className }: {
  points: TruckMapPoint[];
  trails: boolean;
  onOpen: (id: string) => void;
  className?: string;
}) {
  const located = useMemo(
    () => points.filter((p) => p.last_update.lat !== null && p.last_update.lng !== null),
    [points],
  );
  const centers = useMemo(
    () => located.map((p) => [p.last_update.lat as number, p.last_update.lng as number] as [number, number]),
    [located],
  );

  if (located.length === 0) {
    return <div className="trucks-map-empty">No trucks are reporting a location.</div>;
  }

  return (
    <MapContainer center={centers[0]} zoom={4} className={className}>
      <TileLayer url={MAP_TILE_URL} attribution={MAP_TILE_ATTRIBUTION} />
      <FitBounds points={located} trails={trails} />
      {trails && located.filter((p) => p.trail.length > 1).map((p) => (
        <Polyline
          key={`trail-${p.id}`}
          positions={p.trail.map((t) => [t.lat, t.lng] as [number, number])}
          pathOptions={{ color: p.status_color, weight: 3, opacity: 0.7 }}
        />
      ))}
      {located.map((p) => (
        <CircleMarker
          key={p.id}
          center={[p.last_update.lat as number, p.last_update.lng as number]}
          radius={8}
          pathOptions={{ color: p.status_color, fillColor: p.status_color, fillOpacity: 0.9 }}
          eventHandlers={{ click: () => onOpen(p.id) }}
        >
          <Tooltip>
            {p.name} · {p.status_label} · {p.last_update.approximate_address
              || `${p.last_update.lat}, ${p.last_update.lng}`} · {updateAge(p.last_update.recorded_at)}
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
