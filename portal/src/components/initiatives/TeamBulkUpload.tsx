/**
 * TeamBulkUpload — the upload → preview → apply pane of "Assign people to
 * a job". Preview parses the file once; its cells and spreadsheet row
 * numbers become the base every later JSON re-preview and the commit post.
 * Unknown or ambiguous values are matched per line (overrides), lines can
 * be skipped, updates are applied only where Update is checked, and Apply
 * shows the server's per-row summary.
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, commitTeamBulk, listInitiativeWorkTypes, listSites, listWorkerOptions,
  previewTeamBulk, previewTeamBulkFile,
  type TeamBulkAction, type TeamBulkCommitResult, type TeamBulkOverrides, type TeamBulkPreview,
  type TeamBulkRow,
} from '../../lib/api';
import { TEAM_BULK_ERRORS } from '../../lib/teamBulk';
import BulkApplySummary from '../bulk/BulkApplySummary';
import type { ComboOption } from '../ComboBox';
import DataTable from '../DataTable';
import TeamBulkRowDetails, {
  type TeamField, type TeamFieldFailed, type TeamFieldOptions,
} from './TeamBulkRowDetails';

const STATUS: Record<TeamBulkAction, [string, string]> = {
  add: ['Add', 'c-green'],
  update: ['Update', 'c-amber'],
  unchanged: ['No change', 'tag'],
  attention: ['Needs a match', 'c-violet'],
  error: ['Error', 'c-red'],
  skipped: ['Skipped', 'c-slate'],
};

const LOADERS: Record<TeamField, () => Promise<ComboOption[]>> = {
  worker: async () => (await listWorkerOptions())
    .map((w) => ({ value: w.person_id, label: w.display_name })),
  site: async () => (await listSites()).filter((s) => !s.archived_at)
    .map((s) => ({ value: s.id, label: s.name })),
  role: async () => (await listInitiativeWorkTypes()).filter((w) => w.is_active)
    .map((w) => ({ value: w.key, label: w.label })),
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

/** Uploaded cell, then "→ matched" when the match reads differently. */
function matched(cell: string | undefined, name: string | null) {
  const text = cell?.trim() || '—';
  return name && name !== cell ? <>{text} → <b>{name}</b></> : text;
}

interface Base { cells: Record<string, string>[]; rows: number[] }

export default function TeamBulkUpload({ jobId }: { jobId: string }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [preview, setPreview] = useState<TeamBulkPreview | null>(null);
  const [overrides, setOverrides] = useState<TeamBulkOverrides>({});
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<TeamBulkCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [options, setOptions] = useState<TeamFieldOptions>({});
  const [failed, setFailed] = useState<TeamFieldFailed>({});
  const loading = useRef(new Set<TeamField>());
  const seq = useRef(0);

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (TEAM_BULK_ERRORS[err.code] ?? 'That did not work — try again.')
      : 'Network error.';

  // The full worker / site / role lists back the dropdowns of UNKNOWN
  // values only — fetched once per field, the first time one shows up. A
  // failed load clears the field's flag, so reopening its dropdown retries
  // (candidates still work meanwhile; the full list is a convenience).
  const loadField = (field: TeamField) => {
    if (loading.current.has(field)) return;
    loading.current.add(field);
    setFailed((prev) => ({ ...prev, [field]: false }));
    LOADERS[field]()
      .then((list) => setOptions((prev) => ({ ...prev, [field]: list })))
      .catch(() => {
        loading.current.delete(field);
        setFailed((prev) => ({ ...prev, [field]: true }));
      });
  };

  useEffect(() => {
    for (const r of preview?.rows ?? []) {
      for (const issue of r.issues) {
        if (issue.kind === 'unknown') loadField(issue.field);
      }
    }
  }, [preview]);   // loadField only touches a ref and state setters

  const accept = (next: TeamBulkPreview) => {
    setPreview(next);
    const updates = new Set(next.rows.filter((r) => r.action === 'update').map((r) => r.row));
    setApproved((prev) => new Set([...prev].filter((n) => updates.has(n))));
  };

  const runPreview = async () => {
    if (!file) return;
    const mine = ++seq.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const next = await previewTeamBulkFile(jobId, file, file.name);
      if (mine !== seq.current) return;
      setBase({ cells: next.rows.map((r) => r.cells), rows: next.rows.map((r) => r.row) });
      setOverrides({});
      setSkip(new Set());
      setApproved(new Set());          // every update starts unapproved
      setPreview(next);
    } catch (err) {
      if (mine !== seq.current) return;
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  /** JSON re-preview with the accumulated picks and skips; a newer request wins. */
  const rerun = async (nextOverrides: TeamBulkOverrides, nextSkip: Set<number>) => {
    if (!base) return;
    setOverrides(nextOverrides);
    setSkip(nextSkip);
    const mine = ++seq.current;
    setPending((p) => p + 1);
    setError('');
    try {
      const next = await previewTeamBulk(jobId, {
        rows: base.cells, row_numbers: base.rows, overrides: nextOverrides, skip: sorted(nextSkip),
      });
      if (mine === seq.current) accept(next);
    } catch (err) {
      if (mine === seq.current) {
        setPreview(null);
        setError(mapError(err));
      }
    } finally {
      setPending((p) => p - 1);
    }
  };

  const pick = (n: number, field: TeamField, id: string) =>
    void rerun({ ...overrides, [n]: { ...overrides[n], [field]: id } }, skip);
  const clearPicks = (n: number) => {
    const next = { ...overrides };
    delete next[n];
    void rerun(next, skip);
  };
  const toggleSkip = (n: number) => {
    const next = new Set(skip);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    void rerun(overrides, next);
  };
  const toggleApprove = (n: number) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const rows = preview?.rows ?? [];
  const count = (a: TeamBulkAction) => rows.filter((r) => r.action === a).length;
  const updates = rows.filter((r) => r.action === 'update');
  const adds = count('add');
  const updating = updates.filter((r) => approved.has(r.row)).length;
  const skipping = updates.length - updating + count('skipped');
  const attention = count('attention');
  const canApply = !!preview && preview.can_commit && pending === 0 && (adds > 0 || updating > 0);

  const runApply = async () => {
    if (!preview || !base || !file) return;
    setBusy(true);
    setError('');
    try {
      const applied = await commitTeamBulk(jobId, {
        rows: base.cells, row_numbers: base.rows, overrides, skip: sorted(skip),
        approved_updates: sorted(approved), source: file.name,
      });
      setPreview(null);
      setBase(null);
      setFile(null);
      setOverrides({});
      setSkip(new Set());
      setApproved(new Set());
      if (fileRef.current) fileRef.current.value = '';
      setResult(applied);
    } catch (err) {
      setError(mapError(err));
      setPreview(null);   // stale after a failed commit — force a fresh preview
    } finally {
      setBusy(false);
    }
  };

  const status = (r: TeamBulkRow) => {
    const [label, tone] = r.action === 'update' && !approved.has(r.row)
      ? ['Skip', 'c-slate'] : STATUS[r.action];
    return <span className={`chip ${tone}`}>{label}</span>;
  };

  const inputId = `team-${jobId}-bulk-file`;

  return (
    <div className="bulk-import team-bulk">
      <div className="bulk-file-row">
        <label htmlFor={inputId}>Upload a file (.csv or .xlsx)</label>
        <input
          id={inputId}
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy || pending > 0}
          onChange={(e) => {
            seq.current += 1;          // an in-flight preview of the old file is now stale
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setBase(null);
            setOverrides({});
            setSkip(new Set());
            setApproved(new Set());
            setResult(null);
            setError('');
          }}
        />
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button" disabled={busy || !file}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button" disabled={busy || !canApply}
                onClick={() => void runApply()}>
          {`Add ${adds} and update ${updating}`}
        </button>
        {updates.length > 0 && (
          <>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set(updates.map((r) => r.row)))}>
              Update all
            </button>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set())}>
              Skip all
            </button>
          </>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {result && (
        <BulkApplySummary
          result={result}
          entityLabel="Worker"
          linkFor={() => `/initiatives/${jobId}`}
          filename="team-bulk-summary"
          openTo={`/initiatives/${jobId}`}
          openLabel="Open the job"
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${adds} to add · ${updating} to update · ${skipping} to skip · ${count('unchanged')} unchanged · `
              + `${attention} ${attention === 1 ? 'needs' : 'need'} a match · ${plural(count('error'), 'error')}`}
          </p>
          <DataTable
            ariaLabel="Team preview"
            className="bulk-preview"
            columns={[
              { key: 'row', label: 'Row', width: '64px', mono: true },
              { key: 'worker', label: 'Worker' },
              { key: 'site', label: 'Site' },
              { key: 'role', label: 'Role' },
              { key: 'status', label: 'Status', width: '130px' },
              { key: 'details', label: 'Details', width: '34%' },
            ]}
            rows={rows.map((r) => ({
              key: String(r.row),
              cells: [
                r.row,
                matched(r.cells.worker ?? r.worker ?? '', r.person_name),
                matched(r.cells.site, r.site_name),
                matched(r.cells.role, r.role_label),
                status(r),
                <TeamBulkRowDetails
                  key="details"
                  row={r}
                  options={options}
                  failed={failed}
                  picked={overrides[r.row] ?? {}}
                  skipped={skip.has(r.row)}
                  approved={approved.has(r.row)}
                  disabled={busy}
                  onPick={(field, id) => pick(r.row, field, id)}
                  onOpenField={loadField}
                  onClearPicks={() => clearPicks(r.row)}
                  onToggleSkip={() => toggleSkip(r.row)}
                  onToggleApprove={() => toggleApprove(r.row)}
                />,
              ],
            }))}
          />
        </>
      )}
    </div>
  );
}
