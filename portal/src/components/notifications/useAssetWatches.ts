/**
 * useAssetWatches — the person's own asset watches, for the row menus of the Assets list and an
 * initiative's asset list: "Watch…" reads "Watching…" while they have a watch on that asset in
 * that place. The list is read once (GET /auth/me/asset-watches: only the watches whose asset, and
 * initiative, they can open now), and again on `reload`, which a list calls after the Watch modal
 * has saved or stopped a watch. Until the list lands, and if it never does, they watch nothing as
 * far as the menu knows; setting a watch they already have is answered `already_watching`, which
 * the modal takes as the watch that is there. A read that fails leaves the list as it was.
 *
 * `watchFor` finds the watch on an asset in one place: on its own (no initiative: `null` and
 * `undefined` alike), or on one initiative. Only the newest read counts, an older answer arriving
 * late is stale.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { listMyAssetWatches, type AssetWatch } from '../../lib/api';

export interface AssetWatches {
  /** The person's asset watches, newest first, as the API lists them. */
  watches: AssetWatch[];
  /** The person's watch on this asset on its own, or on this initiative, if they have one. */
  watchFor: (assetId: string, initiativeId?: string | null) => AssetWatch | undefined;
  /** Reads the list again. */
  reload: () => void;
}

export function useAssetWatches(): AssetWatches {
  const [watches, setWatches] = useState<AssetWatch[]>([]);
  // Only the newest read counts.
  const newest = useRef(0);

  const reload = useCallback(() => {
    const call = ++newest.current;
    listMyAssetWatches()
      .then((rows) => { if (call === newest.current) setWatches(rows); })
      .catch(() => { /* the list is as it was: no watches until one is read */ });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const watchFor = useCallback(
    (assetId: string, initiativeId: string | null = null) => watches.find(
      (w) => w.asset_id === assetId && w.initiative_id === initiativeId),
    [watches]);

  return { watches, watchFor, reload };
}
