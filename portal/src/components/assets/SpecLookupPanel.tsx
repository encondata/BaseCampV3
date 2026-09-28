/**
 * SpecLookupPanel — the Makes / Models "Spec lookup" view: a status strip
 * (queue, current model, month-to-date cost, Find missing specs) and the
 * suggestions Claude found, each with its source and quoted text. Approve /
 * Reject pending rows, Undo applied ones; bulk approve/reject ends in the
 * shared per-row summary. The PAGE owns `status` (its pending_count badges
 * the tab) and refetches on onChanged().
 */
import { useEffect, useState } from 'react';

import {
  ApiError, actOnSpecSuggestion, bulkSpecSuggestions, listSpecSuggestions, queueSpecLookup,
  type SpecBulkResult, type SpecLookupStatus, type SpecSuggestion,
} from '../../lib/api';
import { longDate } from '../../lib/format';
import DataTable from '../DataTable';
import BulkApplySummary, { type BulkSummaryRow } from '../bulk/BulkApplySummary';
import '../../styles/bulk.css';

type Filter = 'pending' | 'applied' | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending' }, { key: 'applied', label: 'Applied' }, { key: 'all', label: 'All' },
];
const FIELD_LABEL: Record<string, string> = {
  ru_size: 'RU size', weight: 'Weight', length: 'Length', width: 'Width', height: 'Height',
  mount_type: 'Mount type', rail_type: 'Rail type', knowledge: 'Knowledge',
};
const STATUS_LABEL: Record<SpecSuggestion['status'], string> = {
  pending: 'Pending', applied: 'Auto-applied', approved: 'Approved',
  rejected: 'Rejected', reverted: 'Undone',
};
const ERR: Record<string, string> = {
  field_changed: 'The field was changed since this was found — review the current value.',
  bad_state: 'Already decided.', not_configured: 'No Anthropic API key is configured.',
};

export const withUnit = (v: string | null, unit: string | null) =>
  v === null ? '—' : unit ? `${v} ${unit}` : v;
const domain = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const msgFor = (e: unknown) => (e instanceof ApiError ? (ERR[e.code] ?? `Request failed (${e.code}).`)
  : 'Network error — nothing was changed.');
const fieldLabel = (f: string | null) => (f === null ? '—' : (FIELD_LABEL[f] ?? f));
const QUOTE_MAX = 80;

type BulkAction = 'approve' | 'reject';
type SummaryRow = BulkSummaryRow & { model_id: string | null; outcome: string };

/** What the bulk call saw of each suggestion before the reload drops it
 *  from the Pending view. */
interface PreRow { model_id: string; current_value: string | null }

/**
 * One BulkApplySummary row per bulk result, in the order the server returned
 * them. Only an approve writes the catalog: an ok approve is 'updated' with
 * old → new; an ok reject is 'unchanged' with no diff; a failure is
 * 'skipped' and its `outcome` says why.
 */
function toSummaryRows(
  results: SpecBulkResult[], action: BulkAction, before: Map<string, PreRow>,
): SummaryRow[] {
  return results.map((r, i) => {
    const pre = before.get(r.id);
    const approved = r.ok && action === 'approve';
    return {
      row: i + 1,
      name: r.make || r.model
        ? `${`${r.make ?? ''} ${r.model ?? ''}`.trim()} — ${fieldLabel(r.field)}` : null,
      action: !r.ok ? 'skipped' : approved ? 'updated' : 'unchanged',
      diff: approved && r.field
        ? { [fieldLabel(r.field)]: { old: pre?.current_value ?? null, new: r.value } } : null,
      model_id: pre?.model_id ?? null,
      outcome: r.ok ? (action === 'approve' ? 'Approved' : 'Rejected')
        : r.error ? (ERR[r.error] ?? r.error) : 'Failed.',
    };
  });
}

export default function SpecLookupPanel({ canChange, status, onChanged }: {
  canChange: boolean;
  status: SpecLookupStatus | null;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [rows, setRows] = useState<SpecSuggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [summary, setSummary] = useState<{ action: BulkAction; rows: SummaryRow[] } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    listSpecSuggestions(filter)
      .then((r) => { if (live) { setRows(r); setError(''); } })
      .catch((e) => { if (live) setError(e instanceof ApiError ? msgFor(e) : 'Failed to load suggestions.'); });
    return () => { live = false; };
  }, [filter, reload]);

  // A selection only means anything for rows still pending in this view.
  useEffect(() => {
    setSelected((s) => {
      const pending = new Set((rows ?? []).filter((r) => r.status === 'pending').map((r) => r.id));
      const next = new Set([...s].filter((id) => pending.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [rows]);

  const refresh = () => { setReload((k) => k + 1); onChanged(); };

  const findMissing = async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const { queued } = await queueSpecLookup(undefined);
      setNote(`Queued ${queued} model${queued === 1 ? '' : 's'}.`);
      onChanged();
    } catch (e) {
      setError(msgFor(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'approve' | 'reject' | 'undo') => {
    setBusy(true); setError(''); setNote('');
    try {
      await actOnSpecSuggestion(id, action);
      refresh();
    } catch (e) {
      setError(msgFor(e));
    } finally {
      setBusy(false);
    }
  };

  const bulk = async (action: BulkAction) => {
    setBusy(true); setError(''); setNote('');
    try {
      const { results } = await bulkSpecSuggestions([...selected], action);
      // model ids and current values come from the rows as they were — after
      // the reload the decided suggestions drop out of the Pending view.
      const before = new Map((rows ?? []).map((s) => [s.id, { model_id: s.model_id, current_value: s.current_value }]));
      setSummary({ action, rows: toSummaryRows(results, action, before) });
      setSelected(new Set());
      refresh();
    } catch (e) {
      setError(msgFor(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const pendingIds = (rows ?? []).filter((r) => r.status === 'pending').map((r) => r.id);
  const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  const running = status?.running_model;

  const columns = [
    ...(canChange ? [{
      key: 'select', width: '36px', label: (
        <input type="checkbox" aria-label="Select all pending" checked={allSelected}
               disabled={busy || pendingIds.length === 0}
               onChange={(e) => setSelected(e.target.checked ? new Set(pendingIds) : new Set())} />
      ),
    }] : []),
    { key: 'model', label: 'Model' },
    { key: 'field', label: 'Field' },
    { key: 'current', label: 'Current' },
    { key: 'suggested', label: 'Suggested' },
    { key: 'source', label: 'Source' },
    { key: 'quote', label: 'Quote' },
    { key: 'status', label: 'Status' },
    { key: 'found', label: 'Found' },
    ...(canChange ? [{ key: 'actions', label: '', align: 'right' as const }] : []),
  ];

  const tableRows = (rows ?? []).map((s) => {
    const label = fieldLabel(s.field);
    const quote = s.quote.length > QUOTE_MAX ? `${s.quote.slice(0, QUOTE_MAX - 1)}…` : s.quote;
    return {
      key: s.id,
      cells: [
        ...(canChange ? [s.status === 'pending'
          ? <input key="sel" type="checkbox" aria-label={`Select ${s.make} ${s.model} ${label}`}
                   checked={selected.has(s.id)} disabled={busy}
                   onChange={(e) => toggle(s.id, e.target.checked)} />
          : null] : []),
        <div key="model" className="pn"><b>{s.make}</b><span>{s.model}</span></div>,
        label,
        <span key="cur" className="mono">{withUnit(s.current_value, s.unit)}</span>,
        s.field === 'knowledge'
          ? <span key="sug" className="cell-sub">{s.value}</span>
          : <span key="sug" className="mono">{withUnit(s.value, s.unit)}</span>,
        <a key="src" href={s.source_url} target="_blank" rel="noreferrer">{domain(s.source_url)}</a>,
        <span key="q" className="cell-sub" title={s.quote}>{quote}</span>,
        <span key="st" className="chip tag">{STATUS_LABEL[s.status]}</span>,
        <span key="found" className="mono">{longDate(s.created_at)}</span>,
        ...(canChange ? [
          <div key="act" className="rv-actions">
            {s.status === 'pending' && (
              <>
                <button className="mini-btn accent" type="button" disabled={busy}
                        onClick={() => void act(s.id, 'approve')}>Approve</button>
                <button className="mini-btn" type="button" disabled={busy}
                        onClick={() => void act(s.id, 'reject')}>Reject</button>
              </>
            )}
            {(s.status === 'applied' || s.status === 'approved') && (
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => void act(s.id, 'undo')}>Undo</button>
            )}
          </div>,
        ] : []),
      ],
    };
  });

  return (
    <div className="rv-panel">
      <div className="rv-row">
        <div className="rv-main">
          {status
            ? (
              <span className="rv-meta">
                {status.queued} queued · {running ? `looking up ${running.make} ${running.model}` : 'idle'}
                {' · '}this month {status.month.lookups} lookup{status.month.lookups === 1 ? '' : 's'},
                {' '}about ${status.month.est_cost_usd.toFixed(2)}
              </span>
            )
            : <span className="rv-meta">Loading status…</span>}
          {note && <span className="set-note">{note}</span>}
        </div>
        <div className="rv-actions">
          <button className="mini-btn accent" type="button"
                  disabled={!canChange || !status?.configured || busy}
                  onClick={() => void findMissing()}>Find missing specs</button>
        </div>
      </div>

      {status && !status.configured && (
        <div className="dir-empty">
          <b>No Anthropic API key is configured.</b>
          Set SS_ANTHROPIC_API_KEY in Developer › System Config › Environment.
        </div>
      )}

      <div className="segmented" role="tablist" aria-label="Suggestion filter">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" type="button" aria-selected={filter === f.key}
                  className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {error && <span className="pf-error">{error}</span>}

      {summary && (
        <section className="rv-section">
          <BulkApplySummary<SummaryRow>
            result={summary.action === 'approve'
              ? {
                updated: summary.rows.filter((r) => r.action === 'updated').length,
                skipped: summary.rows.filter((r) => r.action === 'skipped').length,
                rows: summary.rows,
              }
              : {
                unchanged: summary.rows.filter((r) => r.action === 'unchanged').length,
                skipped: summary.rows.filter((r) => r.action === 'skipped').length,
                rows: summary.rows,
              }}
            entityLabel="Suggestion"
            linkFor={(r) => (r.model_id ? `/assets/models?open=${r.model_id}` : null)}
            filename="spec-lookup-bulk-summary"
            openTo="/assets/models"
            openLabel="Open Makes / Models"
            extraColumn={{ label: 'Outcome', value: (r) => r.outcome }}
          />
          <div className="bulk-actions">
            <button className="mini-btn" type="button" onClick={() => setSummary(null)}>Done</button>
          </div>
        </section>
      )}

      {canChange && selected.size > 0 && (
        <div className="bulk-actions">
          <button className="mini-btn accent" type="button" disabled={busy}
                  onClick={() => void bulk('approve')}>Approve selected ({selected.size})</button>
          <button className="mini-btn" type="button" disabled={busy}
                  onClick={() => void bulk('reject')}>Reject selected ({selected.size})</button>
        </div>
      )}

      {rows === null && !error && <p className="page-hint">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <div className="dir-empty"><b>Nothing here</b>No suggestions in this view.</div>
      )}
      {rows !== null && rows.length > 0 && (
        <DataTable ariaLabel="Spec suggestions" columns={columns} rows={tableRows} />
      )}
    </div>
  );
}
