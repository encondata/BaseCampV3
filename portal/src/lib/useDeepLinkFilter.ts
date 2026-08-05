/**
 * useRecordFocus — the one way a list page lands on a specific record.
 *
 * Two arrival paths funnel through it:
 *  - ?open=<id> in the URL (audit Record links, shareable)
 *  - location.state.openRow (topbar global search / command palette)
 *
 * Both expand the row AND pre-fill the page's search box with the
 * record's name, so the target filters to the top instead of hiding
 * below the fold. One-shot per arrival — clearing the search afterwards
 * restores the full list and never re-fires.
 */

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { initialOpenId } from './auditFormat';

export function useRecordFocus<T>(
  rows: T[] | null,
  idOf: (row: T) => string,
  nameOf: (row: T) => string,
  setOpenId: (id: string | null) => void,
  setQuery: (q: string) => void,
): void {
  const location = useLocation();
  const navigate = useNavigate();
  // seeded with the URL param so a fresh mount needs no extra effect pass
  const pending = useRef<string | null>(initialOpenId());

  useEffect(() => {
    const state = location.state as { openRow?: string } | null;
    if (!state?.openRow) return;
    setOpenId(state.openRow);
    pending.current = state.openRow;
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, location.pathname, navigate]);

  // fill the search box once the target row is findable; location.state is
  // a dep so an arrival on an already-mounted page (rows long loaded)
  // still triggers a pass
  useEffect(() => {
    if (!pending.current || !rows) return;
    const target = rows.find((r) => idOf(r) === pending.current);
    if (target) setQuery(nameOf(target));
    pending.current = null;   // one-shot, even if the id never matches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, location.state]);
}
