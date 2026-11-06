/**
 * AssignBulkUpload — the upload and review pane of /bulk/assign-workers.
 * The dropzone is always shown and stays disabled until the page's
 * initiative, site and partner are all picked. Choosing a file previews it
 * at once (no Preview button); its cells and sheet row numbers become the
 * base that every later JSON re-preview and the commit post, so a picker
 * change or a row decision re-previews without re-reading the file, and a
 * newer request always wins. The rows split into two collapsible tables,
 * Matched and No match found (by the automatic match, so a row never jumps
 * between them), each with the siblings' Row / Name / Matched by / Action /
 * Details columns. Import commits all-or-nothing and shows the server's
 * per-row summary.
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, commitAssignBulk, previewAssignBulk, previewAssignBulkFile,
  type AssignCommitResult, type AssignDecision, type AssignDecisions, type AssignPosted,
  type AssignPreview, type AssignRow,
} from '../../lib/api';
import { ASSIGN_BULK_ERRORS } from '../../lib/assignBulk';
import BulkApplySummary from '../bulk/BulkApplySummary';
import CollapsePanel from '../CollapsePanel';
import DataTable from '../DataTable';
import FileDropzone from '../FileDropzone';
import AssignBulkRowDetails, { CHANGE_KINDS } from './AssignBulkRowDetails';

interface Base { cells: Record<string, string>[]; rows: number[] }

/** How a row was matched, as the Matched by column shows it; the wire keys stay. */
const MATCHED_BY: Record<NonNullable<AssignRow['matched_by']>, string> = {
  name: 'Name', email: 'Email', phone: 'Phone', pick: 'Picked',
};

/** Decisions minus every Update/Ignore answer: a new initiative, site or
 *  partner raises new flags, and an old answer must not settle them. */
function withoutChanges(d: AssignDecisions): AssignDecisions {
  const out: AssignDecisions = {};
  for (const [n, { change: _change, ...rest }] of Object.entries(d)) {
    if (Object.keys(rest).length > 0) out[n] = rest;
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** An undecided contact / partner / assignment flag — the row reads "Discrepancy". */
const discrepancy = (r: AssignRow) =>
  r.flags.some((f) => !f.decided && CHANGE_KINDS.includes(f.kind));
const needsMatch = (r: AssignRow) =>
  r.flags.some((f) => !f.decided && f.kind === 'needs_match');

/** An attention row's state, by precedence: Needs a match > Discrepancy >
 *  Needs a decision (a name, status, contact or role answer is pending). */
function attention(r: AssignRow): 'match' | 'discrepancy' | 'decision' {
  return needsMatch(r) ? 'match' : discrepancy(r) ? 'discrepancy' : 'decision';
}
const ATTENTION_LABEL = { match: 'Needs a match', discrepancy: 'Discrepancy', decision: 'Needs a decision' };

function actionLabel(r: AssignRow): string {
  const base = r.action === 'assign' ? 'Assign'
    : r.action === 'create' ? 'Create'
      : r.action === 'already_assigned' ? 'Already assigned'
        : r.action === 'error' ? 'Error'
          : ATTENTION_LABEL[attention(r)];
  return r.becomes_worker ? `${base} (becomes a worker)` : base;
}

function rowClass(r: AssignRow): string {
  if (r.action === 'assign' || r.action === 'create') return 'bulk-row-create';
  if (r.action === 'already_assigned') return 'bulk-row-unchanged';
  if (r.action === 'attention' && attention(r) !== 'match') return 'bulk-row-update';
  return 'bulk-row-error';
}

/** Sheet name, then "→ name on file" when the match reads differently. */
function nameCell(r: AssignRow) {
  return r.person_name && r.person_name !== r.name
    ? <>{r.name} → <b>{r.person_name}</b></>
    : r.name;
}

interface Props { jobId: string | null; siteId: string | null; partnerId: string | null }

export default function AssignBulkUpload({ jobId, siteId, partnerId }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [preview, setPreview] = useState<AssignPreview | null>(null);
  const [decisions, setDecisions] = useState<AssignDecisions>({});
  const [result, setResult] = useState<AssignCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const ready = !!(jobId && siteId && partnerId);

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (ASSIGN_BULK_ERRORS[err.code] ?? 'That did not work — try again.')
      : 'Network error.';

  const posted = (b: Base, d: AssignDecisions): AssignPosted => ({
    rows: b.cells, row_numbers: b.rows, partner_id: partnerId as string,
    site_id: siteId as string, decisions: d,
  });

  const previewFile = async (f: File) => {
    if (!jobId || !siteId || !partnerId) return;
    const mine = ++seq.current;
    setBusy(true);
    setError('');
    try {
      const next = await previewAssignBulkFile(jobId, f, partnerId, siteId);
      if (mine !== seq.current) return;
      setBase({ cells: next.rows.map((r) => r.cells), rows: next.rows.map((r) => r.row) });
      setDecisions({});
      setPreview(next);
    } catch (err) {
      if (mine !== seq.current) return;
      setPreview(null);
      setError(mapError(err));
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  /** JSON re-preview with the current decisions; a newer request wins.
   *  `keepError` leaves a failed import's message up while it refreshes. */
  const rerun = async (nextDecisions: AssignDecisions, keepError = false) => {
    if (!base || !jobId || !siteId || !partnerId) return;
    setDecisions(nextDecisions);
    const mine = ++seq.current;
    setPending((p) => p + 1);
    if (!keepError) setError('');
    try {
      const next = await previewAssignBulk(jobId, posted(base, nextDecisions));
      if (mine === seq.current) setPreview(next);
    } catch (err) {
      // the last good preview stays up, so a new decision can retry
      if (mine === seq.current) setError(mapError(err));
    } finally {
      setPending((p) => p - 1);
    }
  };

  // A new file previews it; a picker change with a file already parsed
  // re-previews by JSON with the same cells and decisions, less any
  // Update/Ignore (they answered the old pickers' flags). A cleared
  // picker hides the (now meaningless) preview until all three are set.
  useEffect(() => {
    if (!file) return;
    if (!ready) {
      seq.current += 1;
      setPreview(null);
      setBusy(false);
      return;
    }
    if (base) void rerun(withoutChanges(decisions));
    else void previewFile(file);
  }, [file, jobId, siteId, partnerId]);   // base/decisions are read as of this render on purpose

  const onFile = (f: File | null) => {
    seq.current += 1;                    // an in-flight preview of the old file is now stale
    setFile(f);
    setBase(null);
    setPreview(null);
    setDecisions({});
    setResult(null);
    setError('');
    setBusy(false);
  };

  const decide = (n: number, next: AssignDecision) => {
    const all = { ...decisions };
    if (Object.keys(next).length === 0) delete all[String(n)];
    else all[String(n)] = next;
    void rerun(all);
  };
  /** A new pick answers the old match's flags afresh; only the role carries over. */
  const pickPerson = (n: number, id: string) => {
    const role = decisions[String(n)]?.role;
    decide(n, role ? { person: id, role } : { person: id });
  };

  const rows = preview?.rows ?? [];
  const counts = preview?.counts ?? { assign: 0, create: 0, already_assigned: 0, attention: 0, error: 0 };
  const toAssign = counts.assign + counts.create;
  const canImport = !!preview && preview.can_commit && ready && pending === 0 && !busy;

  const runImport = async () => {
    if (!preview || !base || !file || !jobId || !siteId || !partnerId) return;
    setBusy(true);
    setError('');
    try {
      const applied = await commitAssignBulk(jobId, { ...posted(base, decisions), source: file.name });
      seq.current += 1;
      setPreview(null);
      setBase(null);
      setFile(null);
      setDecisions({});
      if (fileRef.current) fileRef.current.value = '';
      setResult(applied);
    } catch (err) {
      // The file, cells and decisions stay; the preview is stale, so it is
      // re-run by JSON to show the server's current view of every row.
      setError(mapError(err));
      setPreview(null);
      void rerun(decisions, true);
    } finally {
      setBusy(false);
    }
  };

  const table = (which: AssignRow['table'], label: string) => {
    const list = rows.filter((r) => r.table === which);
    return (
      <CollapsePanel title={label} defaultOpen badge={<span className="badge-count">{list.length}</span>}>
        <DataTable
          ariaLabel={label}
          className="bulk-preview"
          emptyText="No rows."
          columns={[
            { key: 'row', label: 'Row', width: '64px', mono: true },
            { key: 'name', label: 'Name' },
            { key: 'matched_by', label: 'Matched by' },
            { key: 'action', label: 'Action' },
            { key: 'details', label: 'Details' },
          ]}
          rows={list.map((r) => ({
            key: String(r.row),
            className: rowClass(r),
            cells: [
              r.row,
              nameCell(r),
              r.matched_by
                ? <>{MATCHED_BY[r.matched_by]}{r.matched_value && <span className="bulk-sub mono">{r.matched_value}</span>}</>
                : '—',
              actionLabel(r),
              <AssignBulkRowDetails
                key="details"
                row={r}
                people={preview?.people ?? []}
                roles={preview?.roles ?? []}
                decision={decisions[String(r.row)] ?? {}}
                disabled={busy}
                onChange={(next) => decide(r.row, next)}
                onPickPerson={(id) => pickPerson(r.row, id)}
              />,
            ],
          }))}
        />
      </CollapsePanel>
    );
  };

  const discrepancies = rows.filter(discrepancy).length;
  const unmatched = rows.filter(needsMatch).length;

  return (
    <div className="bulk-import">
      <FileDropzone
        file={file}
        onFile={onFile}
        busy={!ready || busy || pending > 0}
        inputRef={fileRef}
        accept=".xlsx"
        hint="Excel spreadsheet — .xlsx"
      />

      {error && <p className="pf-error">{error}</p>}

      {result && jobId && (
        <BulkApplySummary
          result={result}
          entityLabel="Worker"
          linkFor={(r) => (r.person_id ? `/people/workers/${r.person_id}` : null)}
          filename="assign-workers-summary"
          openTo={`/initiatives/${jobId}`}
          openLabel="Open the initiative"
        />
      )}

      {preview && (
        <>
          <div className="bulk-actions">
            <button className="btn-solid" type="button" disabled={!canImport}
                    onClick={() => void runImport()}>
              {busy ? 'Working…' : `Assign ${plural(toAssign, 'worker', 'workers')} (${counts.create} new)`}
            </button>
          </div>
          <p className="set-note">
            {`${rows.filter((r) => r.table === 'matched').length} matched · ${plural(discrepancies, 'discrepancy', 'discrepancies')} · `
              + `${counts.create} to create · ${plural(unmatched, 'needs a match', 'need a match')} · `
              + `${counts.already_assigned} already assigned · ${plural(counts.error, 'error', 'errors')}`}
          </p>
          {table('matched', 'Matched')}
          {table('unmatched', 'No match found')}
        </>
      )}
    </div>
  );
}
