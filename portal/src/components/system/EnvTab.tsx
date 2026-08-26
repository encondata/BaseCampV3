/** ENV tab: the repo .env, DB/Spaces hidden server-side, secrets
 *  masked. Save rewrites the file; Restart bounces every --reload
 *  process so changes take effect. Rendered as a standard directory
 *  list (toolbar + Columns picker + result count), matching Sites and
 *  Processes, with section-header rows sourced from the .env file's own
 *  standalone comments. */

import { useCallback, useEffect, useState } from 'react';

import {
  getEnvEntries, putEnvValues, restartProcesses, type EnvEntry,
} from '../../lib/api';
import { changedValues, describeEntry, filterEntries } from '../../lib/envConfig';
import { ColumnsButton, visibleColumnsFor, type ColumnDef } from '../../lib/listTools';
import '../../styles/directory.css';

const COLUMNS: ColumnDef[] = [
  { key: 'key', label: 'Key', width: 'minmax(200px, 260px)', default: true },
  { key: 'value', label: 'Value', width: 'minmax(240px, 1fr)', default: true },
  { key: 'description', label: 'Description', width: '1.4fr', default: true },
];
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

export default function EnvTab() {
  const [entries, setEntries] = useState<EnvEntry[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedKeys, setSavedKeys] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  // Visible-column set. Persistence is optional per spec; a plain
  // useState is enough here since (unlike Sites) there's no sort/filter
  // state to persist alongside it.
  const [visible, setVisible] = useState<Set<string>>(DEFAULT_VISIBLE);

  // mount: getEnvEntries
  const load = useCallback(async () => {
    try {
      const { entries: loaded } = await getEnvEntries();
      setEntries(loaded);
    } catch {
      setError('Could not load the environment configuration.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setEdit = useCallback((key: string, value: string) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
    setSavedKeys(null);
  }, []);

  // pending = changedValues(entries, edits); Save disabled when empty
  const pending = entries ? changedValues(entries, edits) : {};
  const pendingCount = Object.keys(pending).length;

  // on save: putEnvValues(pending) -> refetch entries, clear edits, show
  // "Saved N value(s). Changes take effect after a restart."
  const save = useCallback(async () => {
    if (pendingCount === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { changed } = await putEnvValues(pending);
      const { entries: reloaded } = await getEnvEntries();
      setEntries(reloaded);
      setEdits({});
      setSavedKeys(changed);
    } catch {
      setError('Could not save the environment configuration.');
    } finally {
      setBusy(false);
    }
  }, [pending, pendingCount]);

  // Restart: confirm dialog -> restartProcesses() -> banner; the page
  // itself may briefly lose the API.
  const doRestart = useCallback(async () => {
    if (!confirm('Restart the API and workers? Active requests may briefly fail.')) {
      return;
    }
    setRestartBusy(true);
    setError(null);
    try {
      await restartProcesses();
      setRestarting(true);
    } catch {
      setError('Could not restart processes.');
    } finally {
      setRestartBusy(false);
    }
  }, []);

  if (error && !entries) {
    return <div className="dir-empty" style={{ marginTop: 16 }}><b>{error}</b></div>;
  }

  if (!entries) {
    return <p className="page-hint">Loading…</p>;
  }

  const visibleEntries = filterEntries(entries, q);
  const shownCols = visibleColumnsFor(COLUMNS, visible, false);
  const grid = { gridTemplateColumns: shownCols.map((c) => c.width).join(' ') };

  const cellFor = (entry: EnvEntry, key: string) => {
    switch (key) {
      case 'key':
        return <span className="envtab-key">{entry.key}</span>;
      case 'value': {
        const { placeholder, chip } = describeEntry(entry);
        const value = edits[entry.key] ?? (entry.secret ? '' : (entry.value ?? ''));
        return (
          <span className="envtab-value-cell">
            <input
              type={entry.secret ? 'password' : 'text'}
              value={value}
              placeholder={placeholder}
              disabled={busy}
              aria-label={entry.key}
              onChange={(e) => setEdit(entry.key, e.target.value)}
            />
            {chip && (
              <span className={`envtab-chip envtab-chip-${chip === 'set' ? 'set' : 'unset'}`}>
                {chip}
              </span>
            )}
          </span>
        );
      }
      case 'description':
        return <span className="envtab-desc">{entry.description || '—'}</span>;
      default:
        return null;
    }
  };

  // Section-header rows: iterate the FILTERED list in file order and emit
  // a full-width header whenever the section changes to a new non-empty
  // value — so a header only appears when at least one entry under it
  // survives the search filter, and no header repeats for a section
  // that's already showing.
  let lastRenderedSection = '';
  const rows: { node: JSX.Element }[] = [];
  for (const entry of visibleEntries) {
    if (entry.section !== '' && entry.section !== lastRenderedSection) {
      lastRenderedSection = entry.section;
      rows.push({
        node: (
          <div key={`section-${entry.key}`} className="envtab-section-row">
            {entry.section}
          </div>
        ),
      });
    }
    const changed = entry.key in pending;
    rows.push({
      node: (
        <div key={entry.key} className={`list-row envtab-grid${changed ? ' changed' : ''}`} style={grid}>
          {shownCols.map((c) => (
            <span key={c.key} className="cell">{cellFor(entry, c.key)}</span>
          ))}
        </div>
      ),
    });
  }

  return (
    <div className="sysconf-tab-body sysconf-wide">
      {error && <p className="pf-error">{error}</p>}
      {restarting && (
        <p className="envtab-restart-banner">
          Processes are restarting — they reappear on the Processes page within ~15 s.
        </p>
      )}

      <div className="dir-toolbar">
        <div className="toolbar-right">
          <div className="dir-search" style={{ marginLeft: 0 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Filter variables…" aria-label="Filter environment variables"
                   value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <span className="result-count">{visibleEntries.length} of {entries.length} shown</span>
          <ColumnsButton columns={COLUMNS} visible={visible} onChange={setVisible} />
        </div>
      </div>

      <div className="dir-list envtab-list">
        <div className="list-head envtab-grid" style={grid}>
          {shownCols.map((c) => (
            <span key={c.key} className="col-head">{c.label}</span>
          ))}
        </div>
        {rows.map((r) => r.node)}
        {visibleEntries.length === 0 && (
          <p className="sysconf-hint" style={{ padding: 16 }}>
            No keys match &quot;{q}&quot;.
          </p>
        )}
      </div>

      <div className="sysconf-actionbar">
        <button type="button" className="btn-solid" disabled={busy || pendingCount === 0}
                onClick={() => void save()}>
          {busy ? 'Saving…' : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="mini-btn danger" disabled={restartBusy}
                onClick={() => void doRestart()}>
          {restartBusy ? 'Restarting…' : 'Restart processes'}
        </button>
        <span className="sysconf-actionbar-status">
          {savedKeys && (
            <span className="sysconf-saved">
              {`Saved ${savedKeys.length} value${savedKeys.length === 1 ? '' : 's'}. `}
              Changes take effect after a restart.
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
