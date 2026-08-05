/**
 * Deep-link landing polish: a page opened via ?open=<id> (audit Record
 * links) pre-fills its search box with the record's name once rows load,
 * so the expanded row filters to the top instead of hiding below the
 * fold. One-shot — clearing the search afterwards restores the full list
 * and never re-fires.
 */

import { useEffect, useRef } from 'react';

import { initialOpenId } from './auditFormat';

export function useDeepLinkFilter<T>(
  rows: T[] | null,
  idOf: (row: T) => string,
  nameOf: (row: T) => string,
  setQuery: (q: string) => void,
): void {
  const pending = useRef<string | null>(initialOpenId());
  useEffect(() => {
    if (!pending.current || !rows) return;
    const target = rows.find((r) => idOf(r) === pending.current);
    if (target) setQuery(nameOf(target));
    pending.current = null;   // one-shot, even if the id never matches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}
