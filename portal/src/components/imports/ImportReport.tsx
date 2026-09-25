/** A finished move-assets import's report — the summary chips, the missing
 *  make/models card, the per-row list, and its pagination. Shared by the
 *  move import page and the Create-a-move-in-steps assets step; `readOnly`
 *  drops every fix action, and `readyLabel` says what a fixed group needs
 *  next (reprocess on the import page, check again in the wizard). */
import { useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import type { ImportJobOut, ImportRowDetail } from '../../lib/api';
import {
  ColHead, listGridStyle, listScale, titleFor, type ColumnDef,
} from '../../lib/listTools';
import {
  countDetails, missingMakeModels, reviewMakeModel, suggestSplit,
} from '../../lib/moveAssetImport';

export const PAGE_SIZE = 500;

/** The row/group a Fix action opens in FixMakeModelDialog. */
export interface FixTarget { text: string; make: string; model: string }

// No column registry pre-migration (hand-written header spans) — this
// local REPORT_COLUMNS mirrors them in order (recipe R1), carrying the
// widths the `.imp-report-grid` CSS template used to hold
// (initiatives.css, now deleted in favor of the inline template).
// Fit: default columns ≤ LIST_FIT.initPanel (1134px — the report card is
// an .init-panel, initiatives.css: 18px padding plus a 1px border each
// side off the measured 1174px page width, at a 1512px window with the
// nav expanded).
const REPORT_COLUMNS: ColumnDef[] = [
  { key: 'row', label: 'Row', width: '70px', default: true },
  { key: 'serial', label: 'Serial', width: '160px', default: true },
  { key: 'status', label: 'Status', width: '130px', default: true },
  { key: 'message', label: 'Message', width: '1fr', default: true, min: 220 },
];
// `message` keeps its wrapping cell-top rather than the single-line
// cell-line/title treatment: it is prose of unbounded length and it hosts
// the inline "Fix…" button, which a block-level truncating span would push
// onto its own line. The 220px floor is what keeps it readable instead.

/** row-status -> chip class, shared by the summary chips and the details
 *  list (matches the c-* chip idiom used across the portal). */
export const STATUS_CHIP: Record<string, string> = {
  created: 'c-green', updated: 'c-amber', review: 'c-slate', error: 'c-red',
};

/** summary-chip labels differ by phase — the validate report previews what
 *  WILL happen, the commit report says what DID happen. */
export const PHASE_LABELS: Record<'validate' | 'commit',
  { created: string; updated: string; review: string; error: string }> = {
  validate: { created: 'will create', updated: 'will update',
              review: 'needs review', error: 'errors' },
  commit: { created: 'created', updated: 'updated',
            review: 'review skipped', error: 'errors' },
};

const NO_DETAILS: ImportRowDetail[] = [];

interface Props {
  job: ImportJobOut;
  fixedTexts: Set<string>;
  onFix: (target: FixTarget) => void;
  canAddModels: boolean;
  canChangeModels: boolean;
  readOnly?: boolean;
  readyLabel?: string;
  /** Hide Prev/Next when every row fits on one page — the wizard's own
   *  footer Next sits just below, and two Next buttons would compete. */
  pagingOnlyWhenNeeded?: boolean;
}

export default function ImportReport({
  job, fixedTexts, onFix, canAddModels, canChangeModels, readOnly = false,
  readyLabel = 'Ready — reprocess to apply', pagingOnlyWhenNeeded = false,
}: Props) {
  const { preferences } = useAuth();
  const reportGrid = listGridStyle(REPORT_COLUMNS, [], undefined, listScale(preferences?.list_size));
  const reportRowStyle = {
    gridTemplateColumns: reportGrid.gridTemplateColumns, minWidth: reportGrid.minWidth,
  };
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [job.id, job.phase]);

  const details = job.results?.details ?? NO_DETAILS;
  const missing = useMemo(() => missingMakeModels(details), [details]);
  const counts = countDetails(details);
  const labels = PHASE_LABELS[job.phase];
  const total = details.length;
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  const pageRows = details.slice(start, end);
  const collisions = job.results?.summary.collisions_flagged ?? 0;

  return (
    <>
      <div className="chips imp-report-chips">
        <span className="chip c-green">
          <span className="dot" />{counts.created} {labels.created}
        </span>
        <span className="chip c-amber">
          <span className="dot" />{counts.updated} {labels.updated}
        </span>
        <span className="chip c-slate">
          <span className="dot" />{counts.review} {labels.review}
        </span>
        <span className="chip c-red">
          <span className="dot" />{counts.error} {labels.error}
        </span>
        {collisions > 0 && (
          <span className="chip c-amber">
            <span className="dot" />{collisions} collisions flagged
          </span>
        )}
      </div>

      {!readOnly && missing.length > 0 && (
        <div className="init-panel imp-missing-card">
          <p className="eyebrow-sm">
            {missing.length} missing make/model{missing.length === 1 ? '' : 's'}
          </p>
          {!canAddModels && !canChangeModels && (
            <p className="page-hint">Ask an admin to add these models.</p>
          )}
          <div className="mini-list imp-missing-list">
            {missing.map((g) => {
              const fixed = fixedTexts.has(g.text.toLowerCase());
              return (
                <div key={g.text} className="mini-row flex imp-missing-row">
                  <span className="mono">{g.text}</span>
                  <span className="mono">{g.rows.length} rows</span>
                  {fixed ? (
                    <span className="chip c-green">
                      <span className="dot" />{readyLabel}
                    </span>
                  ) : (
                    <span className="imp-missing-actions">
                      {canAddModels && (
                        <button type="button" className="mini-btn"
                                onClick={() => onFix(
                                  { text: g.text, make: g.make, model: g.model })}>
                          Create model…
                        </button>
                      )}
                      {canChangeModels && (
                        <button type="button" className="mini-btn"
                                onClick={() => onFix(
                                  { text: g.text, make: g.make, model: g.model })}>
                          Map to existing…
                        </button>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="dir-list imp-report-list list-scroll">
        <div className="list-head" style={reportRowStyle}>
          {REPORT_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
        </div>
        {pageRows.map((d) => (
          <div key={d.row} className="dir-row"
               style={{ minWidth: reportRowStyle.minWidth }}>
            <div className="row-main" style={reportRowStyle}>
              <div className="cell">
                <span className="cell-top cell-line" title={titleFor(String(d.row))}>
                  {d.row}
                </span>
              </div>
              <div className="cell">
                <span className="cell-top cell-line"
                      title={titleFor(d.serial_number || '—')}>
                  {d.serial_number || '—'}
                </span>
              </div>
              <div className="cell">
                <span className={`chip ${STATUS_CHIP[d.status] ?? 'c-slate'}`}>
                  <span className="dot" />{d.status}
                </span>
              </div>
              <div className="cell">
                <span className="cell-top">{d.message}</span>
                {!readOnly && (() => {
                  const text = reviewMakeModel(d);
                  if (!text || fixedTexts.has(text.toLowerCase())) return null;
                  if (!canAddModels && !canChangeModels) return null;
                  const split = d.suggested_make && d.suggested_model
                    ? { make: d.suggested_make, model: d.suggested_model }
                    : suggestSplit(text);
                  return (
                    <button type="button" className="mini-btn"
                            style={{ marginLeft: 8 }}
                            onClick={() => onFix({ text, ...split })}>
                      Fix…
                    </button>
                  );
                })()}
              </div>
            </div>
          </div>
        ))}
      </div>

      {(!pagingOnlyWhenNeeded || total > PAGE_SIZE) && (
        <div className="imp-pagination">
          <button className="mini-btn" type="button" aria-label="Previous page"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <button className="mini-btn" type="button" aria-label="Next page"
                  disabled={end >= total}
                  onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
          <span className="page-hint">
            showing {total === 0 ? 0 : start + 1}–{end} of {total}
          </span>
        </div>
      )}
    </>
  );
}
