/**
 * Read-only group chips for a client contact. Only global staff can list a
 * client's groups, so only they ever get names; everyone else renders nothing.
 */

import { useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { listClientGroups } from '../../lib/api';

/** id → name for a client's groups, or null while loading / when the caller
 *  cannot see them (not global staff, or not a client). */
export function useClientGroupNames(clientId: string | null): Map<string, string> | null {
  const { scope } = useAuth();
  const enabled = clientId !== null && scope?.global === true;
  const [names, setNames] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!enabled || clientId === null) { setNames(null); return undefined; }
    let alive = true;
    listClientGroups(clientId)
      .then((gs) => { if (alive) setNames(new Map(gs.map((g) => [g.id, g.name]))); })
      .catch(() => { if (alive) setNames(null); });
    return () => { alive = false; };
  }, [enabled, clientId]);
  return names;
}

export default function GroupChips({ ids, names }: {
  ids: string[] | undefined;
  names: Map<string, string> | null;
}) {
  if (!names || !ids || ids.length === 0) return null;
  return (
    <>
      {ids.map((id) => <span key={id} className="chip c-blue">{names.get(id) ?? 'Unknown group'}</span>)}
    </>
  );
}
