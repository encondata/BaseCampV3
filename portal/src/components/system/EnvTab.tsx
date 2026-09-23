/** ENV tab: the repo .env, DB/Spaces hidden server-side, secrets
 *  masked. Save rewrites the file; Restart bounces every --reload
 *  process so changes take effect. Rendered as a standard directory
 *  list (toolbar + Columns picker + result count), matching Sites and
 *  Processes, with section-header rows sourced from the .env file's own
 *  standalone comments. */

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  getEnvEntries, putEnvConfig, restartProcesses, type EnvEntry,
} from '../../lib/api';
import {
  changedDescriptions, changedValues, describeEntry, filterEntries,
} from '../../lib/envConfig';
import { GodEditToggle } from '../../lib/godEdit';
import {
  ColHead, ColumnsButton, listGridStyle, listScale, visibleColumnsFor, type ColumnDef,
} from '../../lib/listTools';
import '../../styles/directory.css';

// The widths below are the `.envtab-grid` CSS template this list used to
// carry (system.css, now deleted): the two flexible tracks keep their fr
// share and their old minmax minimum as an explicit `min`, and `key` —
// minmax(200px, 240px) before — becomes the fixed 240px it always resolved
// to, since the card now scrolls sideways rather than squeezing its tracks.
// Fit: default columns ≤ LIST_FIT.page (1172px — .sysconf-tab-body.sysconf-wide
// sits directly in .portal-page with no padding or border of its own, at a
// 1512px window with the nav expanded).
const COLUMNS: ColumnDef[] = [
  { key: 'key', label: 'Key', width: '240px', default: true },
  { key: 'value', label: 'Value', width: '1.4fr', default: true, min: 240 },
  { key: 'status', label: 'Status', width: '90px', default: true },
  { key: 'description', label: 'Description', width: '1.6fr', default: true, min: 220 },
];
const DEFAULT_VISIBLE = new Set<string>(COLUMNS.filter((c) => c.default).map((c) => c.key));

export default function EnvTab() {
  const { preferences } = useAuth();
  const listGridScale = listScale(preferences?.list_size);
  const [entries, setEntries] = useState<EnvEntry[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [descEdits, setDescEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedKeys, setSavedKeys] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  // The list is read-only until "Edit table" is toggled on (matches the
  // other directory lists). Leaving edit mode discards unsaved edits.
  const [editing, setEditing] = useState(false);
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

  const setDescEdit = useCallback((key: string, value: string) => {
    setDescEdits((prev) => ({ ...prev, [key]: value }));
    setSavedKeys(null);
  }, []);

  const toggleEditing = useCallback(() => {
    setEditing((on) => {
      if (on) {                     // leaving edit mode: discard pending
        setEdits({});
        setDescEdits({});
        setSavedKeys(null);
      }
      return !on;
    });
  }, []);

  // pending = changedValues(entries, edits) + changedDescriptions(entries,
  // descEdits); Save disabled when both are empty
  const pendingValues = entries ? changedValues(entries, edits) : {};
  const pendingDescriptions = entries ? changedDescriptions(entries, descEdits) : {};
  const pendingCount = Object.keys(pendingValues).length + Object.keys(pendingDescriptions).length;

  // on save: putEnvConfig({ values, descriptions }) -> refetch entries,
  // clear edits, show "Saved N value(s). Changes take effect after a
  // restart."
  const save = useCallback(async () => {
    if (pendingCount === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { changed } = await putEnvConfig({
        values: pendingValues, descriptions: pendingDescriptions,
      });
      const { entries: reloaded } = await getEnvEntries();
      setEntries(reloaded);
      setEdits({});
      setDescEdits({});
      setSavedKeys(changed);
    } catch {
      setError('Could not save the environment configuration.');
    } finally {
      setBusy(false);
    }
  }, [pendingValues, pendingDescriptions, pendingCount]);

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
  const grid = listGridStyle(shownCols, [], undefined, listGridScale);
  const rowStyle = {
    gridTemplateColumns: grid.gridTemplateColumns,
    minWidth: editing ? undefined : grid.minWidth,
  };

  const cellFor = (entry: EnvEntry, key: string) => {
    switch (key) {
      case 'key':
        return <span className="mono envtab-key">{entry.key}</span>;
      case 'value': {
        if (!editing) {
          const shown = entry.secret
            ? (entry.set ? '••••••••' : '—')
            : (entry.value || '—');
          const muted = entry.secret || !entry.value;
          return (
            <span className={`cell-top cell-nowrap${muted ? ' envtab-muted' : ''}`}
                  title={entry.secret ? undefined : (entry.value || '')}>
              {shown}
            </span>
          );
        }
        const { placeholder } = describeEntry(entry);
        const value = edits[entry.key] ?? (entry.secret ? '' : (entry.value ?? ''));
        return (
          <input
            type={entry.secret ? 'password' : 'text'}
            value={value}
            placeholder={placeholder}
            disabled={busy}
            aria-label={entry.key}
            autoComplete={entry.secret ? 'new-password' : 'off'}
            onChange={(e) => setEdit(entry.key, e.target.value)}
          />
        );
      }
      case 'status': {
        const { chip } = describeEntry(entry);
        return chip ? (
          <span className={`chip ${chip === 'set' ? 'c-green' : 'c-slate'}`}>
            {chip}
          </span>
        ) : null;
      }
      case 'description': {
        if (!editing) {
          return (
            <span className={`cell-top cell-nowrap${entry.description ? '' : ' envtab-muted'}`}
                  title={entry.description}>
              {entry.description || '—'}
            </span>
          );
        }
        const desc = descEdits[entry.key] ?? entry.description;
        return (
          <input
            type="text"
            value={desc}
            placeholder="—"
            disabled={busy}
            aria-label={`${entry.key} description`}
            autoComplete="off"
            onChange={(e) => setDescEdit(entry.key, e.target.value)}
          />
        );
      }
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
          <div key={`section-${entry.key}`} className="mini-list-head envtab-section-row"
               style={rowStyle}>
            <b className="envtab-section-label">{entry.section}</b>
          </div>
        ),
      });
    }
    const changed = editing
      && (entry.key in pendingValues || entry.key in pendingDescriptions);
    rows.push({
      node: (
        <div key={entry.key} className={`list-row mini-row${changed ? ' changed' : ''}`}
             style={rowStyle}>
          {shownCols.map((c) => (
            <span key={c.key} className={`cell${c.key === 'status' ? ' envtab-col-center' : ''}`}>
              {cellFor(entry, c.key)}
            </span>
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
          <GodEditToggle editing={editing} onToggle={toggleEditing} visible />
        </div>
      </div>

      <div className={`dir-list envtab-list list-scroll${editing ? ' editing' : ''}`}>
        <div className="list-head" style={rowStyle}>
          {shownCols.map((c) => <ColHead key={c.key} col={c} />)}
        </div>
        {rows.map((r) => r.node)}
        {visibleEntries.length === 0 && (
          <p className="sysconf-hint" style={{ padding: 16 }}>
            No keys match &quot;{q}&quot;.
          </p>
        )}
      </div>

      <div className="sysconf-actionbar">
        {editing && (
          <button type="button" className="btn-solid" disabled={busy || pendingCount === 0}
                  onClick={() => void save()}>
            {busy ? 'Saving…' : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`}
          </button>
        )}
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
