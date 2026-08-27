/** Logging tab: local/remote modes, storage limits, and the remote
 *  transport (Grafana Loki push, or syslog RFC 5424 for a SIEM). */

import { useCallback, useEffect, useState } from 'react';

import {
  getLoggingConfig, putLoggingConfig, testLoggingConfig,
  type LoggingConfig,
} from '../../lib/api';
import {
  serverFieldErrors, unclaimedErrors, validateLoggingForm,
} from '../../lib/systemConfig';

const MODE_OPTIONS: { value: LoggingConfig['mode']; title: string; desc: string }[] = [
  { value: 'local', title: 'Local only',
    desc: 'Logs stay in Postgres.' },
  { value: 'local_remote', title: 'Local + remote',
    desc: 'Keep local copies and forward.' },
  { value: 'remote', title: 'Remote',
    desc: 'Forward, keep a small local buffer.' },
];

const LEVEL_OPTIONS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];

export default function LoggingTab() {
  const [cfg, setCfg] = useState<LoggingConfig | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await getLoggingConfig();
        if (!cancelled) setCfg(loaded);
      } catch {
        if (!cancelled) setLoadError('Could not load the logging configuration.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Immutable field setter: applies a partial update, clears that field's
  // error plus any form-level (_form) error, and clears the "Saved." tick
  // since the form is dirty again.
  const setField = useCallback(
    (path: string, value: unknown) => {
      setCfg((prev) => {
        if (!prev) return prev;
        const next: LoggingConfig = { ...prev };
        if (path.includes('.')) {
          const [group, key] = path.split('.') as [
            'loki' | 'syslog', string,
          ];
          next[group] = { ...(prev[group] as Record<string, unknown>), [key]: value } as never;
        } else {
          (next as unknown as Record<string, unknown>)[path] = value;
        }
        return next;
      });
      setErrors((prev) => {
        if (!(path in prev) && !('_form' in prev)) return prev;
        const next = { ...prev };
        delete next[path];
        delete next._form;
        return next;
      });
      setSaved(false);
    },
    [],
  );

  const save = useCallback(async () => {
    if (!cfg) return;
    const clientErrors = validateLoggingForm(cfg);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }
    setBusy(true);
    setSaved(false);
    try {
      const updated = await putLoggingConfig(cfg);
      setErrors({});
      setCfg(updated);
      setSaved(true);
    } catch (e) {
      // A recognized 422 carries per-field messages; anything else (an
      // unrecognized code, a 500, a network error) has none, so fall back to
      // a form-level message rather than silently clearing the errors.
      const fields = serverFieldErrors(e);
      if (Object.keys(fields).length > 0) {
        setErrors(fields);
      } else {
        setErrors({ _form: 'Could not save the logging configuration.' });
      }
    } finally {
      setBusy(false);
    }
  }, [cfg]);

  const test = useCallback(async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const result = await testLoggingConfig();
      if (result.forwarded) {
        setTestResult('Logged and forwarded.');
      } else if (result.error) {
        setTestResult(`Forwarding failed: ${result.error}`);
      } else {
        setTestResult('Logged locally.');
      }
    } catch {
      setTestResult('Could not send the test event.');
    } finally {
      setTestBusy(false);
    }
  }, []);

  if (loadError) {
    return <div className="dir-empty" style={{ marginTop: 16 }}><b>{loadError}</b></div>;
  }

  if (!cfg) {
    return <p className="page-hint">Loading…</p>;
  }

  const remote = cfg.mode !== 'local';

  // Field keys with an input on screen right now. Errors keyed to anything
  // else — a remote-only field while in local mode, or the form-level `_form`
  // — have no visible place to land, so we surface them above the action bar.
  const renderedKeys = new Set<string>([
    'local_max_rows_per_process', 'local_max_age_days', 'min_level',
    ...(cfg.mode === 'remote' ? ['remote_buffer_rows'] : []),
    ...(remote && cfg.transport === 'loki'
      ? ['loki.url', 'loki.username', 'loki.password', 'loki.tenant_id'] : []),
    ...(remote && cfg.transport === 'syslog'
      ? ['syslog.host', 'syslog.port', 'syslog.protocol'] : []),
  ]);
  const orphans = Object.values(unclaimedErrors(errors, renderedKeys));

  return (
    <div className="sysconf-tab-body">
      {orphans.length > 0 && (
        <p className="pf-error">
          {`Fix ${orphans.length} issue${orphans.length === 1 ? '' : 's'}: ${orphans.join(' ')}`}
        </p>
      )}

      <div className="init-panel sysconf-card">
        <div className="sysconf-card-head">
          <p className="eyebrow-sm">Mode</p>
          <p className="sysconf-card-desc">How log records are kept and shipped.</p>
        </div>
        <div className="imp-radio-group" role="radiogroup" aria-label="Logging mode">
          {MODE_OPTIONS.map((opt) => (
            <label key={opt.value} className="imp-radio">
              <input type="radio" name="logging-mode" value={opt.value}
                     checked={cfg.mode === opt.value} disabled={busy}
                     onChange={() => setField('mode', opt.value)} />
              <span className="imp-radio-body">
                <span className="imp-radio-title">{opt.title}</span>
                <span className="imp-radio-desc">{opt.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="init-panel sysconf-card">
        <div className="sysconf-card-head">
          <p className="eyebrow-sm">Storage limits</p>
          <p className="sysconf-card-desc">Caps on the local Postgres store.</p>
        </div>
        <div className="sysconf-row">
          <div className="sysconf-field">
            <label className="sysconf-label" htmlFor="sc-local-max-rows">Max rows per process</label>
            <input id="sc-local-max-rows" type="number"
                   value={cfg.local_max_rows_per_process} disabled={busy}
                   onChange={(e) => setField('local_max_rows_per_process', Number(e.target.value))} />
            {errors.local_max_rows_per_process && (
              <p className="pf-error">{errors.local_max_rows_per_process}</p>
            )}
          </div>
          <div className="sysconf-field">
            <label className="sysconf-label" htmlFor="sc-local-max-age">Max age (days)</label>
            <input id="sc-local-max-age" type="number"
                   value={cfg.local_max_age_days} disabled={busy}
                   onChange={(e) => setField('local_max_age_days', Number(e.target.value))} />
            {errors.local_max_age_days && (
              <p className="pf-error">{errors.local_max_age_days}</p>
            )}
          </div>
          {cfg.mode === 'remote' && (
            <div className="sysconf-field">
              <label className="sysconf-label" htmlFor="sc-remote-buffer-rows">Buffer rows</label>
              <input id="sc-remote-buffer-rows" type="number"
                     value={cfg.remote_buffer_rows} disabled={busy}
                     onChange={(e) => setField('remote_buffer_rows', Number(e.target.value))} />
              {errors.remote_buffer_rows && (
                <p className="pf-error">{errors.remote_buffer_rows}</p>
              )}
            </div>
          )}
          <div className="sysconf-field">
            <label className="sysconf-label" htmlFor="sc-min-level">Minimum level</label>
            <select id="sc-min-level" value={cfg.min_level} disabled={busy}
                    onChange={(e) => setField('min_level', e.target.value)}>
              {LEVEL_OPTIONS.map((lvl) => (
                <option key={lvl} value={lvl}>{lvl}</option>
              ))}
            </select>
            {errors.min_level && <p className="pf-error">{errors.min_level}</p>}
          </div>
        </div>
      </div>

      {remote && (
        <div className="init-panel sysconf-card">
          <div className="sysconf-card-head">
            <p className="eyebrow-sm">Remote transport</p>
            <p className="sysconf-card-desc">Where forwarded records go.</p>
          </div>
          <div className="imp-radio-group" role="radiogroup" aria-label="Remote transport">
            <label className="imp-radio">
              <input type="radio" name="logging-transport" value="loki"
                     checked={cfg.transport === 'loki'} disabled={busy}
                     onChange={() => setField('transport', 'loki')} />
              <span className="imp-radio-body">
                <span className="imp-radio-title">Grafana Loki</span>
              </span>
            </label>
            <label className="imp-radio">
              <input type="radio" name="logging-transport" value="syslog"
                     checked={cfg.transport === 'syslog'} disabled={busy}
                     onChange={() => setField('transport', 'syslog')} />
              <span className="imp-radio-body">
                <span className="imp-radio-title">Syslog (RFC 5424)</span>
              </span>
            </label>
          </div>

          {cfg.transport === 'loki' && (
            <div className="sysconf-row">
              <div className="sysconf-field">
                <label className="sysconf-label" htmlFor="sc-loki-url">URL</label>
                <input id="sc-loki-url" type="text" value={cfg.loki.url} disabled={busy}
                       placeholder="http://loki:3100"
                       onChange={(e) => setField('loki.url', e.target.value)} />
                {errors['loki.url'] && <p className="pf-error">{errors['loki.url']}</p>}
              </div>
              <div className="sysconf-field">
                <label className="sysconf-label" htmlFor="sc-loki-username">Username (optional)</label>
                <input id="sc-loki-username" type="text" value={cfg.loki.username} disabled={busy}
                       onChange={(e) => setField('loki.username', e.target.value)} />
                {errors['loki.username'] && <p className="pf-error">{errors['loki.username']}</p>}
              </div>
              <div className="sysconf-field">
                <label className="sysconf-label" htmlFor="sc-loki-password">Password</label>
                <input id="sc-loki-password" type="password" value={cfg.loki.password ?? ''} disabled={busy}
                       placeholder={cfg.loki.password_set ? '••••••••  (unchanged)' : ''}
                       onChange={(e) => setField('loki.password', e.target.value)} />
                {errors['loki.password'] && <p className="pf-error">{errors['loki.password']}</p>}
              </div>
              <div className="sysconf-field">
                <label className="sysconf-label" htmlFor="sc-loki-tenant">Tenant ID (optional)</label>
                <input id="sc-loki-tenant" type="text" value={cfg.loki.tenant_id} disabled={busy}
                       onChange={(e) => setField('loki.tenant_id', e.target.value)} />
                {errors['loki.tenant_id'] && <p className="pf-error">{errors['loki.tenant_id']}</p>}
              </div>
            </div>
          )}

          {cfg.transport === 'syslog' && (
            <div className="sysconf-row">
              <div className="sysconf-field">
                <label className="sysconf-label" htmlFor="sc-syslog-host">Host</label>
                <input id="sc-syslog-host" type="text" value={cfg.syslog.host} disabled={busy}
                       onChange={(e) => setField('syslog.host', e.target.value)} />
                {errors['syslog.host'] && <p className="pf-error">{errors['syslog.host']}</p>}
              </div>
              <div className="sysconf-field">
                <label className="sysconf-label" htmlFor="sc-syslog-port">Port</label>
                <input id="sc-syslog-port" type="number" value={cfg.syslog.port} disabled={busy}
                       onChange={(e) => setField('syslog.port', Number(e.target.value))} />
                {errors['syslog.port'] && <p className="pf-error">{errors['syslog.port']}</p>}
              </div>
              <div className="sysconf-field">
                <label className="sysconf-label" htmlFor="sc-syslog-protocol">Protocol</label>
                <select id="sc-syslog-protocol" value={cfg.syslog.protocol} disabled={busy}
                        onChange={(e) => setField('syslog.protocol', e.target.value)}>
                  <option value="udp">udp</option>
                  <option value="tcp">tcp</option>
                  <option value="tls">tls</option>
                </select>
                {errors['syslog.protocol'] && <p className="pf-error">{errors['syslog.protocol']}</p>}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="sysconf-actionbar">
        <button type="button" className="btn-solid" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="mini-btn" disabled={testBusy} onClick={() => void test()}>
          {testBusy ? 'Sending…' : 'Send test event'}
        </button>
        <span className="sysconf-actionbar-status">
          {saved && <span className="sysconf-saved">Saved.</span>}
          {testResult && <span className="sysconf-hint">{testResult}</span>}
        </span>
      </div>
    </div>
  );
}
