import { useRef, useState } from 'react';

import type { DocumentSettings } from '../../lib/learning';

/**
 * What the user just chose for a document setting, shown until its save
 * lands. Each key carries a sequence number: a save clears its key only when
 * no later save for that key is still outstanding, so a slow earlier response
 * (or failure) never snaps the control back over a newer choice. A failure
 * with nothing newer behind it removes the key, which restores the saved
 * value.
 */
export function usePendingSettings(onSave: (patch: Partial<DocumentSettings>) => Promise<boolean>) {
  const [pending, setPending] = useState<Partial<DocumentSettings>>({});
  const seq = useRef<Record<string, number>>({});

  const apply = async (patch: Partial<DocumentSettings>): Promise<boolean> => {
    const keys = Object.keys(patch) as (keyof DocumentSettings)[];
    const mine: Record<string, number> = {};
    keys.forEach((k) => { seq.current[k] = (seq.current[k] ?? 0) + 1; mine[k] = seq.current[k]; });
    setPending((p) => ({ ...p, ...patch }));
    const ok = await onSave(patch);
    setPending((p) => {
      const next = { ...p };
      keys.forEach((k) => { if (seq.current[k] === mine[k]) delete next[k]; });
      return next;
    });
    return ok;
  };

  return { pending, apply };
}
