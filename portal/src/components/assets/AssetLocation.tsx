/**
 * An asset's Location as shown everywhere: the container it is in and,
 * when that container is on a truck, the truck — each a link. Without a
 * container it is the plain location text (or '—'). The text always equals
 * placementText(), which every Location column sorts, filters and exports by.
 * Each link also shows a hover map of the container's position (container
 * and truck links both preview the container: the truck's last GPS report,
 * else the container's site pin). Every asset list and asset page shows
 * Location through this component, so they all get the map (SS-531).
 */
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { placementText } from '../../lib/assets';
import { titleFor } from '../../lib/listTools';
import LocationMapPreview from './LocationMapPreview';

export interface AssetLocationAsset {
  location_detail?: string | null;
  container_id?: string | null; container_name?: string | null;
  truck_id?: string | null; truck_name?: string | null;
}

// List rows expand on click — following a link must not also toggle the row.
const stop = (e: MouseEvent) => e.stopPropagation();

export default function AssetLocation({ asset, className }: {
  asset: AssetLocationAsset; className?: string;
}) {
  const { container_id, container_name, truck_id, truck_name } = asset;
  const text = placementText(asset) || '—';
  if (!container_id || !container_name) {
    return <span className={className} title={titleFor(text)}>{text}</span>;
  }
  const preview = (node: ReactNode) =>
    <LocationMapPreview containerId={container_id}>{node}</LocationMapPreview>;
  return (
    <span className={className} title={text}>
      {preview(<Link to={`/logistics/containers?open=${container_id}`} className="asset-loc-link" onClick={stop}>{container_name}</Link>)}
      {truck_id && truck_name && (
        <>
          {' · on '}
          {preview(<Link to={`/logistics/trucks/${truck_id}`} className="asset-loc-link" onClick={stop}>{truck_name}</Link>)}
        </>
      )}
    </span>
  );
}
