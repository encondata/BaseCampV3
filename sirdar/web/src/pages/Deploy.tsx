import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import HostKeyModal from '../components/HostKeyModal';
import SshTargetModal from '../components/SshTargetModal';
import { arrowNav } from '../lib/arrowNav';
import { NAME_HELP, nameProblem } from '../lib/envRules';
import {
  connectDeploy, deleteSshTarget, errorDetail, errorText, forgetKnownHost, getDeployTargets, getDoRegions, listKnownHosts,
  trustKnownHost, type ConnectResult, type DeployCheck, type DeployTarget, type DeployType, type DoRegions, type KnownHost,
} from '../lib/sirdarApi';

import EnvironmentsSection from './environments/EnvironmentsSection';
import SnapshotsSection from './snapshots/SnapshotsSection';

/** .env keys (names only) each target needs; the API never reports which are missing.
 *  Keep in sync with sirdar/api/src/sirdar_api/config.py and the Deploy spec. */
const ENV_KEYS: Record<string, string[]> = {
  digitalocean: ['SIRDAR_DEPLOY_DO_TOKEN'],
  ssh: ['SIRDAR_DEPLOY_SSH_HOST', 'SIRDAR_DEPLOY_SSH_USER',
        'SIRDAR_DEPLOY_SSH_PASSWORD or SIRDAR_DEPLOY_SSH_KEY_PATH'],
  aws: ['SIRDAR_DEPLOY_AWS_ACCESS_KEY_ID', 'SIRDAR_DEPLOY_AWS_SECRET_ACCESS_KEY'],
  gcp: ['SIRDAR_DEPLOY_GCP_PROJECT_ID', 'SIRDAR_DEPLOY_GCP_CREDENTIALS_FILE'],
};
const INITIALS: Record<string, string> = { aws: 'AWS', gcp: 'GC', digitalocean: 'DO', ssh: 'SSH', proxmox: 'PVE' };
const kindOf = (t: DeployTarget) => t.kind ?? t.id;
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
  const [result, setResult] = useState<(ConnectResult & { at: string; region?: string; sentName?: string }) | null>(null);
  const [error, setError] = useState('');
  const [hostsError, setHostsError] = useState('');
  const inFlight = useRef(false);
  const [unknown, setUnknown] = useState<KeyInfo | null>(null);
  const [mismatch, setMismatch] = useState<KeyInfo | null>(null);
  const [trusting, setTrusting] = useState(false);
  const [trustError, setTrustError] = useState('');
  const [doRegions, setDoRegions] = useState<DoRegions | null>(null);   // fetched once, reused
  const [regionsLoading, setRegionsLoading] = useState(false);
  const [regionsError, setRegionsError] = useState('');
  const [region, setRegion] = useState('');
  const [envName, setEnvName] = useState('');
  const [canAddSsh, setCanAddSsh] = useState(false);
  const [sshHint, setSshHint] = useState('');
  const [sshModal, setSshModal] = useState<{ mode: 'add' } | { mode: 'edit'; slug: string } | null>(null);

  const loadHosts = useCallback(() =>
    listKnownHosts().then((h) => { setHosts(h); setHostsError(''); })
      .catch((e) => setHostsError(errorText(e, "Couldn't load trusted hosts."))), []);

  const loadTargets = useCallback(() =>
    getDeployTargets().then((r) => {
      setTargets(r.targets); setTypes(r.types);
      setCanAddSsh(!!r.can_add_ssh); setSshHint(r.ssh_store_hint ?? '');
      setTarget((cur) => (cur && !r.targets.some((t) => t.id === cur) ? '' : cur));
      setLoadError('');
    }).catch((e) => setLoadError(errorText(e, "Couldn't load deployment targets."))), []);

  useEffect(() => { loadTargets(); loadHosts(); }, [loadTargets, loadHosts]);

  const selected = targets.find((t) => t.id === target);
  const doReady = !!selected && kindOf(selected) === 'digitalocean' && selected.available && selected.configured;

  const loadRegions = useCallback(() => {
    setRegionsLoading(true); setRegionsError('');
    getDoRegions()
      .then((r) => { setDoRegions(r); setRegion((cur) => cur || r.default || ''); })
      .catch((e) => {
        const d = errorDetail<{ reason?: string }>(e);
        setRegionsError(d?.reason || errorText(e, "Couldn't load DigitalOcean regions."));
      })
      .finally(() => setRegionsLoading(false));
  }, []);

  useEffect(() => {
    if (!doReady) { setRegion(''); return; }
    if (doRegions) setRegion((cur) => cur || doRegions.default || '');
    else loadRegions();
  }, [doReady, doRegions, loadRegions]);

  const isCustom = type === 'custom';
  const trimmedName = envName.trim();
  const nameError = isCustom ? nameProblem(envName) : '';
  const nameOk = !isCustom || (!!trimmedName && !nameError);
  // Proxmox is tested in Settings › Integrations; its environments are made with New environment.
  const proxmoxSelected = !!selected && kindOf(selected) === 'proxmox';
  const canRun = !!selected && selected.available && selected.configured && !!type && nameOk && canAdd && !running
    && !proxmoxSelected;

  const clearOutcome = () => { setResult(null); setMismatch(null); setError(''); };
  const pick = (set: (v: string) => void, v: string, current: string) => {
    if (v === current) return;
    set(v); clearOutcome();
  };

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(''); setResult(null); setMismatch(null);
    try {
      const sent = doReady && region ? region : undefined;
      const sentName = isCustom ? trimmedName : undefined;
      const r = sentName ? await connectDeploy(target, type, sent, sentName)
        : sent ? await connectDeploy(target, type, sent) : await connectDeploy(target, type);
      setResult({ ...r, region: sent, at: new Date().toISOString() });
    } catch (e) {
      const d = errorDetail<KeyInfo>(e);
      const code = (e as { code?: string }).code;
      if (code === 'host_key_unknown' && d) { setTrustError(''); setUnknown(d); }
      else if (code === 'host_key_mismatch' && d) setMismatch(d);
      else {
        const reason = code === 'connect_failed' && d && 'reason' in d ? String((d as { reason: unknown }).reason) : '';
        setError(reason || errorText(e, "Couldn't run the connection test."));
      }
    } finally { inFlight.current = false; setRunning(false); }
  };

  const trust = async () => {
    if (!unknown?.fingerprint) return;
    setTrusting(true); setTrustError('');
    try {
      if (target.startsWith('ssh:')) await trustKnownHost(unknown.host, unknown.port, unknown.fingerprint, target);
      else await trustKnownHost(unknown.host, unknown.port, unknown.fingerprint);
    } catch (e) {
      setTrusting(false);
      if ((e as { code?: string }).code === 'host_key_changed') {
        setUnknown(null);
        setError("The server's key changed while you were looking. Try again.");
        return;
      }
      setTrustError(errorText(e, "Couldn't trust this server."));
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

  const savedSelected = selected?.source === 'saved' ? selected : undefined;
  const removeSaved = async () => {
    if (!savedSelected) return;
    const msg = `Remove ${savedSelected.label}? Its saved password and key settings are deleted. Trusted host keys stay until you forget them.`;
    if (!window.confirm(msg)) return;
    try {
      await deleteSshTarget(savedSelected.id.slice('ssh:'.length));
      setTarget(''); clearOutcome();
      await loadTargets();
    } catch (e) { setError(errorText(e, "Couldn't remove that target.")); }
  };
  const savedSsh = (slug: string) => {
    setSshModal(null); clearOutcome(); setTarget(`ssh:${slug}`);
    loadTargets();
  };

  const firstEnabled = targets.find((t) => t.available)?.id;
  return (
    <div className="portal-page">
      <div className="eyebrow">Deployments</div>
      <div className="dir-head">
        <h1>Deploy</h1>
        <p>Create environments and deploy them to your targets, or test a target's connection.</p>
      </div>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      <EnvironmentsSection targets={targets} />
      <SnapshotsSection />

      <section className="sirdar-section">
        <h2>Target</h2>
        <div className="sirdar-cards">
          <div role="radiogroup" aria-label="Deployment target" className="sirdar-contents">
          {targets.map((t) => (
            <button key={t.id} type="button" role="radio" className={`sirdar-card sirdar-target${t.id === target ? ' on' : ''}`}
                    aria-checked={t.id === target} aria-disabled={!t.available}
                    tabIndex={t.id === target || (!target && t.id === firstEnabled) ? 0 : -1}
                    onKeyDown={arrowNav}
                    onClick={() => { if (t.available) pick(setTarget, t.id, target); }}>
              <span className="sirdar-target-top">
                <span className="sirdar-target-icon" aria-hidden="true">{INITIALS[kindOf(t)] ?? t.label.slice(0, 2)}</span>
                {statusChip(t)}
              </span>
              <b>{t.label}</b>
            </button>
          ))}
          </div>
          {canChange && canAddSsh && (
            <button type="button" className="sirdar-card sirdar-target sirdar-add-target"
                    onClick={() => setSshModal({ mode: 'add' })}>
              <b>+ Add SSH target</b>
            </button>
          )}
        </div>
        {canChange && !canAddSsh && sshHint && <p className="page-hint">{sshHint}</p>}
        {canChange && savedSelected && (
          <div className="sirdar-target-actions">
            <button type="button" className="mini-btn"
                    onClick={() => setSshModal({ mode: 'edit', slug: savedSelected.id.slice('ssh:'.length) })}>Edit</button>
            <button type="button" className="mini-btn" onClick={removeSaved}>Remove</button>
          </div>
        )}
        {selected?.source === 'installer' && <p className="page-hint">Edit this target in sirdar/.env.</p>}
        {proxmoxSelected && (
          <p className="page-hint sirdar-envnote">
            Test Proxmox in Settings › Integrations. Environments on it are made with New environment, which builds
            their VM on the first deploy.
          </p>
        )}
        {savedSelected && !savedSelected.configured && (
          <p className="page-hint sirdar-envnote">This target needs a password or a key file. Use Edit to add one.</p>
        )}
        {selected && selected.available && !selected.configured && selected.source !== 'saved' && (
          <p className="page-hint sirdar-envnote">
            Set {ENV_KEYS[kindOf(selected)]?.map((k, i) => (
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
                    onKeyDown={arrowNav} onClick={() => pick(setType, t.id, type)}>
              <span className="sirdar-type-label">
                <b>{t.label}</b>
                <span className="cell-sub">{t.description}</span>
              </span>
            </button>
          ))}
        </div>
        {isCustom && (
          <div className="pf-form sirdar-envname">
            <label className="field-label" htmlFor="env-name">Environment name</label>
            <input id="env-name" type="text" value={envName} maxLength={64} autoComplete="off"
                   spellCheck={false} aria-required="true" aria-invalid={!!nameError}
                   aria-describedby="env-name-help"
                   onChange={(e) => { setEnvName(e.target.value); clearOutcome(); }} />
            <p id="env-name-help" className="page-hint">{NAME_HELP}</p>
            {nameError && <p className="form-error" role="alert">{nameError}</p>}
          </div>
        )}
      </section>

      <section className="sirdar-section">
        <div className="sirdar-section-head">
          <h2>Connect</h2>
          <button type="button" className="btn-solid" disabled={!canRun} onClick={run}>
            {running ? 'Connecting…' : 'Test connection'}
          </button>
        </div>
        {doReady && (
          <div className="sirdar-region">
            <label className="field-label" htmlFor="do-region">Region</label>
            {regionsLoading && <p className="page-hint">Loading regions…</p>}
            {regionsError && (
              <p className="form-error" role="alert">{regionsError}{' '}
                <button type="button" className="mini-btn" onClick={loadRegions}>Retry</button></p>
            )}
            {doRegions && (
              <ComboBox inputId="do-region" ariaLabel="Region" portal value={region}
                        placeholder="Select a region…"
                        options={doRegions.regions.map((r) => ({ value: r.slug, label: `${r.name} (${r.slug})` }))}
                        onChange={(v) => { setRegion(v); clearOutcome(); }} />
            )}
          </div>
        )}
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
              {result.region && <>{result.region} · </>}
              {types.find((t) => t.id === result.type)?.label ?? result.type}
              {result.type === 'custom' && result.name && <>: {result.name}</>} ·{' '}
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
                  <Fragment key={k}>
                    <dt>{k.replaceAll('_', ' ')}</dt><dd className="mono">{String(v)}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </div>
        )}
      </section>

      <section className="sirdar-section">
        <h2>Trusted SSH hosts</h2>
        {hostsError && <p className="form-error" role="alert">{hostsError}</p>}
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

      {sshModal && (
        <SshTargetModal mode={sshModal.mode} slug={sshModal.mode === 'edit' ? sshModal.slug : undefined}
                        onSaved={savedSsh} onClose={() => setSshModal(null)} />
      )}
      {unknown && (
        <HostKeyModal host={unknown.host} port={unknown.port} keyType={unknown.key_type}
                      fingerprint={unknown.fingerprint ?? ''} canTrust={canChange}
                      busy={trusting} error={trustError} onTrust={trust}
                      onCancel={() => setUnknown(null)} />
      )}
    </div>
  );
}
