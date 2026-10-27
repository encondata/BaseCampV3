/**
 * The initiative's compliance grid: workers down the side, the documents
 * they need across the top, one cell per pair — valid, expires during the
 * initiative, missing or not required. Reloads when `version` changes (the
 * tab bumps it after anything that could change who has signed what).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getInitiativeGrid, type ComplianceGrid as Grid, type GridState } from '../../lib/learning';
import type { ColumnDef } from '../../lib/listTools';
import LearningList, { type LearningColumn } from './LearningList';

const STATES: { state: GridState; label: string; cls: string }[] = [
  { state: 'valid', label: 'Valid', cls: 'c-green' },
  { state: 'expires_during', label: 'Expires during the initiative', cls: 'c-amber' },
  { state: 'missing', label: 'Missing', cls: 'c-red' },
  { state: 'not_required', label: 'Not required', cls: 'c-slate' },
];
const CLS = Object.fromEntries(STATES.map((s) => [s.state, s.cls])) as Record<GridState, string>;

type GridRow = Grid['rows'][number];

const WORKER: ColumnDef = { key: 'worker', label: 'Worker', width: '1.4fr', default: true, min: 150 };

export default function ComplianceGrid({ initiativeId, version }: { initiativeId: string; version: number }) {
  const [grid, setGrid] = useState<Grid | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    setFailed(false);
    getInitiativeGrid(initiativeId)
      .then((g) => { if (alive) setGrid(g); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [initiativeId]);
  useEffect(() => load(), [load, version]);

  const columns: LearningColumn<GridRow>[] = useMemo(() => [
    { def: WORKER, cell: (r: GridRow) => <span className="cell-top cell-line" title={r.name}>{r.name}</span> },
    ...(grid?.documents ?? []).map((d): LearningColumn<GridRow> => ({
      def: { key: d.id, label: d.title, width: '1fr', default: true, min: 112 },
      cell: (r) => {
        const cell = r.cells[d.id];
        return cell
          ? <span className={`chip ${CLS[cell.state]}`}>{cell.label}</span>
          : <span className="cell-sub">—</span>;
      },
    })),
  ], [grid]);

  return (
    <section className="lrn-card lrn-compliance" aria-label="Compliance grid">
      <div className="lrn-section-head">
        <p className="lrn-kicker">Compliance grid</p>
        <ul className="lrn-legend" aria-label="Legend">
          {STATES.map((s) => (
            <li key={s.state}><span className={`chip ${s.cls}`}>{s.label}</span></li>
          ))}
        </ul>
      </div>
      {failed && (
        <p className="pf-error" role="alert">
          Couldn’t load the compliance grid.{' '}
          <button type="button" className="mini-btn" onClick={() => load()}>Try again</button>
        </p>
      )}
      {grid === null && !failed && <p className="page-hint">Loading…</p>}
      {grid !== null && (
        <LearningList columns={columns} rows={grid.rows} rowKey={(r) => r.person_id}
                      ariaLabel="Compliance by worker and document"
                      empty={<><b>Nothing to show yet</b>Workers and the documents they need appear here once training is assigned.</>} />
      )}
    </section>
  );
}
