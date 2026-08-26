/** ENV tab: the repo .env, DB/Spaces hidden server-side, secrets
 *  masked. Save rewrites the file; Restart bounces every --reload
 *  process so changes take effect. */

import { useCallback, useEffect, useState } from 'react';

import {
  getEnvEntries, putEnvValues, restartProcesses, type EnvEntry,
} from '../../lib/api';
import { changedValues, describeEntry, filterEntries } from '../../lib/envConfig';

export default function EnvTab() {
  const [entries, setEntries] = useState<EnvEntry[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedKeys, setSavedKeys] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);

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

  const visible = filterEntries(entries, q);

  return (
    <div className="sysconf-tab-body">
      {error && <p className="pf-error">{error}</p>}
      {restarting && (
        <p className="envtab-restart-banner">
          Processes are restarting — they reappear on the Processes page within ~15 s.
        </p>
      )}

      <input
        type="text"
        className="envtab-search"
        placeholder="Search keys…"
        aria-label="Search environment keys"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="init-panel sysconf-card">
        <div className="sysconf-card-head">
          <p className="eyebrow-sm">Environment variables</p>
          <p className="sysconf-card-desc">
            The repo .env file. Database and object-storage keys are hidden
            server-side; secrets are masked and only overwritten when you
            type a new value.
          </p>
        </div>
        <div className="envtab-rows">
          {visible.map((entry) => {
            const { placeholder, chip } = describeEntry(entry);
            const changed = entry.key in pending;
            const value = edits[entry.key] ?? (entry.secret ? '' : (entry.value ?? ''));
            return (
              <div key={entry.key} className={`envtab-row${changed ? ' changed' : ''}`}>
                <span className="envtab-key">{entry.key}</span>
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
              </div>
            );
          })}
          {visible.length === 0 && (
            <p className="sysconf-hint">No keys match &quot;{q}&quot;.</p>
          )}
        </div>
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
