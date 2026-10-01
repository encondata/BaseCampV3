import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import HostKeyModal from '../components/HostKeyModal';
import {
  connectDeploy, errorDetail, errorText, forgetKnownHost, getDeployTargets, listKnownHosts,
  trustKnownHost, type ConnectResult, type DeployCheck, type DeployTarget, type DeployType, type KnownHost,
} from '../lib/sirdarApi';

/** .env keys (names only) each target needs; the API never reports which are missing. */
const ENV_KEYS: Record<string, string[]> = {
  digitalocean: ['SIRDAR_DEPLOY_DO_TOKEN'],
  ssh: ['SIRDAR_DEPLOY_SSH_HOST', 'SIRDAR_DEPLOY_SSH_USER',
        'SIRDAR_DEPLOY_SSH_PASSWORD or SIRDAR_DEPLOY_SSH_KEY_PATH'],
  aws: ['SIRDAR_DEPLOY_AWS_ACCESS_KEY_ID', 'SIRDAR_DEPLOY_AWS_SECRET_ACCESS_KEY'],
  gcp: ['SIRDAR_DEPLOY_GCP_PROJECT_ID', 'SIRDAR_DEPLOY_GCP_CREDENTIALS_FILE'],
};
const INITIALS: Record<string, string> = { aws: 'AWS', gcp: 'GC', digitalocean: 'DO', ssh: 'SSH' };
const CHECK_CHIP: Record<DeployCheck['status'], { cls: string; text: string }> = {
  pass: { cls: 'c-green', text: 'Pass' }, warn: { cls: 'c-amber', text: 'Warning' }, fail: { cls: 'c-red', text: 'Fail' },
};

interface KeyInfo { host: string; port: number; key_type: string; fingerprint?: string; expected?: string; actual?: string }

function statusChip(t: DeployTarget) {
  if (!t.available) return <span className="chip tag">Coming soon</span>;
  return t.configured
    ? <span className="chip c-green">Ready</span>
    : <span className="chip c-amber">Not configured</span>;
}

/** Roving-tabindex arrow-key movement inside a radiogroup. */
function arrowNav(e: KeyboardEvent<HTMLElement>) {
  const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!dir) return;
  const group = e.currentTarget.closest('[role="radiogroup"]');
  const items = Array.from(group?.querySelectorAll<HTMLElement>('[role="radio"]:not([aria-disabled="true"])') ?? []);
  const next = items[(items.indexOf(e.currentTarget) + dir + items.length) % items.length];
  if (next) { e.preventDefault(); next.focus(); next.click(); }
}

export default function Deploy() {
  const { can } = useAuth();
  const canAdd = can('deploy', 'add');
  const canChange = can('deploy', 'change');
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [types, setTypes] = useState<DeployType[]>([]);
  const [hosts, setHosts] = useState<KnownHost[]>([]);
  const [target, setTarget] = useState('');
  const [type, setType] = useState('');
  const [loadError, setLoadError] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<(ConnectResult & { at: string }) | null>(null);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState<KeyInfo | null>(null);
  const [mismatch, setMismatch] = useState<KeyInfo | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState('');

  const loadHosts = useCallback(() =>
    listKnownHosts().then(setHosts).catch((e) => setError(errorText(e, "Couldn't load trusted hosts."))), []);

  useEffect(() => {
    getDeployTargets().then((r) => { setTargets(r.targets); setTypes(r.types); })
      .catch((e) => setLoadError(errorText(e, "Couldn't load deployment targets.")));
    loadHosts();
  }, [loadHosts]);

  const selected = targets.find((t) => t.id === target);
  const canRun = !!selected && selected.available && selected.configured && !!type && canAdd && !running;

  const run = async () => {
    setRunning(true);
    setError(''); setResult(null); setMismatch(null);
    try {
      const r = await connectDeploy(target, type);
      setResult({ ...r, at: new Date().toISOString() });
    } catch (e) {
      const d = errorDetail<KeyInfo>(e);
      const code = (e as { code?: string }).code;
      if (code === 'host_key_unknown' && d) { setTrustError(''); setUnknown(d); }
      else if (code === 'host_key_mismatch' && d) setMismatch(d);
      else {
        const reason = code === 'connect_failed' && d && 'reason' in d ? String((d as { reason: unknown }).reason) : '';
        setError(reason || errorText(e, "Couldn't run the connection test."));
      }
    } finally { setRunning(false); }
  };

  const trust = async () => {
    if (!unknown?.fingerprint) return;
    setTrusting(true); setTrustError('');
    try {
      await trustKnownHost(unknown.host, unknown.port, unknown.fingerprint);
    } catch (e) {
      setTrustError(errorText(e, "Couldn't trust this server."));
      setTrusting(false);
      return;
    }
    setTrusting(false);
    setUnknown(null);
    loadHosts();
    run();
  };

  const forget = async (host: string, port: number, afterMismatch: boolean) => {
    const msg = `Forget the trusted key for ${host}:${port}? The next connection will ask you to trust it again.`;
    if (!window.confirm(msg)) return;
    try {
      await forgetKnownHost(host, port);
      if (afterMismatch) setMismatch(null);
      loadHosts();
    } catch (e) { setError(errorText(e, "Couldn't forget that host.")); }
  };

  const firstEnabled = targets.find((t) => t.available)?.id;
  return (
    <div className="portal-page">
      <div className="eyebrow">Deployments</div>
      <div className="dir-head">
        <h1>Deploy</h1>
        <p>Pick where and what kind of environment to deploy. This step tests the connection;
           deploying the apps comes next.</p>
      </div>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}

      <section className="sirdar-section">
        <h2>Target</h2>
        <div className="sirdar-cards" role="radiogroup" aria-label="Deployment target">
          {targets.map((t) => (
            <button key={t.id} type="button" role="radio" className={`sirdar-card sirdar-target${t.id === target ? ' on' : ''}`}
                    aria-checked={t.id === target} aria-disabled={!t.available}
                    tabIndex={t.id === target || (!target && t.id === firstEnabled) ? 0 : -1}
                    onKeyDown={arrowNav}
                    onClick={() => { if (t.available) setTarget(t.id); }}>
              <span className="sirdar-target-top">
                <span className="sirdar-target-icon" aria-hidden="true">{INITIALS[t.id] ?? t.label.slice(0, 2)}</span>
                {statusChip(t)}
              </span>
              <b>{t.label}</b>
              <span className="cell-sub">{t.summary ?? (t.available ? 'Not set up yet' : 'Not built yet')}</span>
            </button>
          ))}
        </div>
        {selected && selected.available && !selected.configured && (
          <p className="page-hint sirdar-envnote">
            Set {ENV_KEYS[selected.id]?.map((k, i) => (
              <span key={k}>{i > 0 && ', '}<code>{k}</code></span>
            ))} in the .env file, then re-run the installer.
          </p>
        )}
      </section>

      <section className="sirdar-section">
        <h2>Deployment type</h2>
        <div className="segmented sirdar-types" role="radiogroup" aria-label="Deployment type">
          {types.map((t) => (
            <button key={t.id} type="button" role="radio" className={t.id === type ? 'on' : ''}
                    aria-checked={t.id === type} tabIndex={t.id === type || (!type && t === types[0]) ? 0 : -1}
                    onKeyDown={arrowNav} onClick={() => setType(t.id)}>
              <span className="sirdar-type-label">
                <b>{t.label}</b>
                <span className="cell-sub">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="sirdar-section">
        <div className="sirdar-section-head">
          <h2>Connect</h2>
          <button type="button" className="btn-solid" disabled={!canRun} onClick={run}>
            {running ? 'Connecting…' : 'Test connection'}
          </button>
        </div>
        {!canAdd && (
          <p className="page-hint">You can view deployments but not run tests. Ask a super admin for access.</p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {mismatch && (
          <div className="sirdar-card sirdar-mismatch" role="alert">
            <p><b>This server's key doesn't match the one Sirdar trusted. Connection refused.</b></p>
            <dl className="sirdar-kv">
              <dt>Server</dt><dd className="mono">{mismatch.host}:{mismatch.port}</dd>
              <dt>Trusted key</dt><dd className="mono">{mismatch.expected}</dd>
              <dt>Key it presented</dt><dd className="mono">{mismatch.actual}</dd>
            </dl>
            {canChange && (
              <div className="sirdar-actions">
                <button type="button" className="btn-ghost"
                        onClick={() => forget(mismatch.host, mismatch.port, true)}>Forget the old key</button>
              </div>
            )}
          </div>
        )}
        {result && (
          <div className="sirdar-card sirdar-result">
            <p className="page-hint">
              {targets.find((t) => t.id === result.target)?.label ?? result.target} ·{' '}
              {types.find((t) => t.id === result.type)?.label ?? result.type} ·{' '}
              <span className="mono">{new Date(result.at).toLocaleString()}</span>
            </p>
            <ul className="sirdar-checks">
              {result.checks.map((c) => (
                <li key={c.label}>
                  <span className={`chip ${CHECK_CHIP[c.status].cls}`}>{CHECK_CHIP[c.status].text}</span>
                  <b>{c.label}</b>
                  <span className="cell-sub">{c.value}</span>
                </li>
              ))}
            </ul>
            {Object.keys(result.facts).length > 0 && (
              <dl className="sirdar-kv">
                {Object.entries(result.facts).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k.replaceAll('_', ' ')}</dt><dd className="mono">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </section>

      <section className="sirdar-section">
        <h2>Trusted SSH hosts</h2>
        <DataTable
          ariaLabel="Trusted SSH hosts"
          columns={[
            { key: 'host', label: 'Host', mono: true }, { key: 'type', label: 'Key type', mono: true },
            { key: 'fp', label: 'Fingerprint', mono: true }, { key: 'by', label: 'Trusted by' },
            { key: 'act', label: '', align: 'right' },
          ]}
          rows={hosts.map((h) => ({
            key: `${h.host}:${h.port}`,
            cells: [
              `${h.host}:${h.port}`, h.key_type, h.fingerprint,
              `${h.trusted_by_name ?? '—'} · ${new Date(h.trusted_at).toLocaleString()}`,
              canChange
                ? <button type="button" className="mini-btn" aria-label={`Forget ${h.host}:${h.port}`}
                          onClick={() => forget(h.host, h.port, false)}>Forget</button>
                : '',
            ],
          }))}
          emptyText="No hosts trusted yet."
        />
      </section>

      {unknown && (
        <HostKeyModal host={unknown.host} port={unknown.port} keyType={unknown.key_type}
                      fingerprint={unknown.fingerprint ?? ''} canTrust={canChange}
                      busy={trusting} error={trustError} onTrust={trust}
                      onCancel={() => setUnknown(null)} />
      )}
    </div>
  );
}
