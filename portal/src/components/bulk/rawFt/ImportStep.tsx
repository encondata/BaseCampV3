/**
 * ImportStep — step 4 of Convert Raw F-T (super admins who can change
 * moves): pick the move whose From-To import should open with the converted
 * file. The Open the import button lives in the page's footer.
 * Spec: docs/superpowers/specs/2026-10-06-raw-ft-import-handoff-design.md
 */
import { useEffect, useMemo, useState } from 'react';

import { listInitiatives, type InitiativeItem } from '../../../lib/api';
import { sortNatural } from '../../../lib/naturalSort';
import ComboBox from '../../ComboBox';

export default function ImportStep({ moveId, onMove }: {
  moveId: string;
  onMove: (id: string) => void;
}) {
  const [moves, setMoves] = useState<InitiativeItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    listInitiatives()
      .then((all) => { if (live) setMoves(all.filter((i) => i.initiative_type === 'move' && i.archived_at == null)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const options = useMemo(() => sortNatural(moves ?? [], (m) => m.name).map((m) => ({
    value: m.id,
    label: m.name,
    sub: `${m.status_label} · ${m.origin_site_name ?? '—'} → ${m.destination_site_name ?? '—'}`,
  })), [moves]);

  return (
    <div className="bulk-import ftc-pane">
      <div className="pf-form">
        <div>
          <label htmlFor="ftc-move">Move</label>
          <ComboBox inputId="ftc-move" ariaLabel="Move" value={moveId} onChange={onMove}
                    placeholder="Pick a move…" options={options} disabled={moves === null} />
        </div>
      </div>
      {failed ? <p className="pf-error">Couldn't load moves. Go back and try again.</p>
        : moves === null ? <p className="page-hint">Loading moves…</p>
        : moves.length === 0 ? <p className="page-hint">There are no moves to import into.</p>
        : null}
    </div>
  );
}
