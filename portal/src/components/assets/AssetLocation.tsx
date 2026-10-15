/**
 * An asset's Location as shown everywhere: the container it is in and,
 * when that container is on a truck, the truck — each a link. Without a
 * container it is the plain location text (or '—'). The text always equals
 * placementText(), which every Location column sorts, filters and exports by.
 */
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';

import { placementText } from '../../lib/assets';
import { titleFor } from '../../lib/listTools';

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
  return (
    <span className={className} title={text}>
      <Link to={`/logistics/containers?open=${container_id}`} onClick={stop}>{container_name}</Link>
      {truck_id && truck_name && (
        <>
          {' · on '}
          <Link to={`/logistics/trucks/${truck_id}`} onClick={stop}>{truck_name}</Link>
        </>
      )}
    </span>
  );
}
