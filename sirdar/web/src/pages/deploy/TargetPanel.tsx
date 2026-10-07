import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import DataTable from '@portal/components/DataTable';

import HostKeyModal from '../../components/HostKeyModal';
import SshTargetModal from '../../components/SshTargetModal';
import { arrowNav } from '../../lib/arrowNav';
import { nameProblem } from '../../lib/envRules';
import {
  connectDeploy, deleteSshTarget, errorDetail, errorText, forgetKnownHost, getDeployTargets, getDoAccounts, getDoRegions,
  listKnownHosts, trustKnownHost, type ConnectResult, type DeployCheck, type DeployTarget, type DoAccount,
  type DoAccountKey, type DoRegions, type KnownHost,
} from '../../lib/sirdarApi';

/** .env keys (names only) each target needs; the API never reports which are missing.
 *  Keep in sync with sirdar/api/src/sirdar_api/config.py and the Deploy spec. DigitalOcean's
 *  accounts can instead be set up in Settings › Integrations (a saved token wins over the .env one). */
const ENV_KEYS: Record<string, string[]> = {
  digitalocean: ['SIRDAR_DEPLOY_DO_TOKEN'],
  ssh: ['SIRDAR_DEPLOY_SSH_HOST', 'SIRDAR_DEPLOY_SSH_USER',
        'SIRDAR_DEPLOY_SSH_PASSWORD or SIRDAR_DEPLOY_SSH_KEY_PATH'],
  aws: ['SIRDAR_DEPLOY_AWS_ACCESS_KEY_ID', 'SIRDAR_DEPLOY_AWS_SECRET_ACCESS_KEY'],
  gcp: ['SIRDAR_DEPLOY_GCP_PROJECT_ID', 'SIRDAR_DEPLOY_GCP_CREDENTIALS_FILE'],
};
const INITIALS: Record<string, string> = { aws: 'AWS', gcp: 'GC', digitalocean: 'DO', ssh: 'SSH', proxmox: 'PVE', esxi: 'ESXi' };
const kindOf = (t: DeployTarget) => t.kind ?? t.id;
const CHECK_CHIP: Record<DeployCheck['status'], { cls: string; text: string }> = {
  pass: { cls: 'c-green', text: 'Pass' }, warn: { cls: 'c-amber', text: 'Warning' }, fail: { cls: 'c-red', text: 'Fail' },
};

/** The results header's name for each type the flow tests with. */
const CONNECT_LABEL: Record<string, string> = { blue: 'Production', dev: 'Development', beta: 'UAT', custom: 'Custom' };

interface KeyInfo { host: string; port: number; key_type: string; fingerprint?: string; expected?: string; actual?: string }

function statusChip(t: DeployTarget) {
  if (!t.available) return <span className="chip tag">Coming soon</span>;
  return t.configured
    ? <span className="chip c-green">Ready</span>
    : <span className="chip c-amber">Not configured</span>;
}

export type ConnectType = 'blue' | 'dev' | 'beta' | 'custom';

/** The Deploy flow's Target step: the target cards (+ Add SSH target), the chosen target's notes, and,
 *  collapsed, the connection test and the trusted SSH hosts. The selection and the type are the flow's. */
export default function TargetPanel({ target, onTarget, connectType, connectName, choosable, onTargetsChanged, doAccount }: {
  target: string; onTarget: (id: string) => void;
  connectType: ConnectType; connectName?: string;
  /** The targets the flow allows now; the others show disabled with their chip. */
  choosable?: (id: string) => boolean;
  /** After an SSH target is added, edited or removed. */
  onTargetsChanged?: () => void;
  /** The flow's DigitalOcean account: the test reads it, and the panel shows no account picker. */
  doAccount?: DoAccountKey;
}) {
  const { can } = useAuth();
  const canAdd = can('deploy', 'add');
  const canChange = can('deploy', 'change');
  const [targets, setTargets] = useState<DeployTarget[]>([]);
  const [hosts, setHosts] = useState<KnownHost[]>([]);
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
  const [doAccounts, setDoAccounts] = useState<DoAccount[]>([]);
  const [account, setAccount] = useState<DoAccountKey>(doAccount ?? 'production');
  const [regionsBy, setRegionsBy] = useState<Partial<Record<DoAccountKey, DoRegions>>>({});   // each fetched once, reused
  // The chosen account, for region responses that arrive after it changed.
  const accountRef = useRef<DoAccountKey>(doAccount ?? 'production');
  accountRef.current = account;
  const doAccountRef = useRef(doAccount);
  doAccountRef.current = doAccount;
  // The current selection, for a target list that arrives without it.
  const targetRef = useRef(target);
  targetRef.current = target;
  const onTargetRef = useRef(onTarget);
  onTargetRef.current = onTarget;
  const [regionsLoading, setRegionsLoading] = useState(false);
  const [regionsError, setRegionsError] = useState('');
  const [region, setRegion] = useState('');
  const [canAddSsh, setCanAddSsh] = useState(false);
  const [sshHint, setSshHint] = useState('');
  const [sshModal, setSshModal] = useState<{ mode: 'add' } | { mode: 'edit'; slug: string } | null>(null);

  const loadHosts = useCallback(() =>
    listKnownHosts().then((h) => { setHosts(h); setHostsError(''); })
      .catch((e) => setHostsError(errorText(e, "Couldn't load trusted hosts."))), []);

  const loadTargets = useCallback(() =>
    getDeployTargets().then((r) => {
      setTargets(r.targets);
      setCanAddSsh(!!r.can_add_ssh); setSshHint(r.ssh_store_hint ?? '');
      const cur = targetRef.current;
      if (cur && !r.targets.some((t) => t.id === cur)) onTargetRef.current('');
      setLoadError('');
    }).catch((e) => setLoadError(errorText(e, "Couldn't load deployment targets."))), []);

  useEffect(() => { loadTargets(); loadHosts(); }, [loadTargets, loadHosts]);

  // The accounts the DigitalOcean test can read; the first configured one (Production first) is chosen,
  // unless the flow chose the account.
  useEffect(() => {
    let live = true;
    getDoAccounts()
      .then((r) => {
        if (!live) return;
        const sorted = [...r.accounts].sort((a, b) => Number(b.key === 'production') - Number(a.key === 'production'));
        setDoAccounts(sorted);
        if (doAccountRef.current) return;
        const first = sorted.find((a) => a.configured);
        if (first && first.key !== accountRef.current) {
          accountRef.current = first.key;
          setAccount(first.key); setRegion(''); setRegionsLoading(false); setRegionsError('');
        }
      })
      .catch(() => { if (live) setDoAccounts([]); });
    return () => { live = false; };
  }, []);

  const clearOutcome = () => { setResult(null); setMismatch(null); setError(''); };

  // The flow's account wins.
  useEffect(() => {
    if (doAccount && doAccount !== accountRef.current) {
      accountRef.current = doAccount;
      setAccount(doAccount); setRegion(''); setRegionsLoading(false); setRegionsError(''); clearOutcome();
    }
  }, [doAccount]);

  // A result belongs to the target and type it was run with.
  useEffect(() => { clearOutcome(); }, [target, connectType, connectName]);

  const selected = targets.find((t) => t.id === target);
  const doReady = !!selected && kindOf(selected) === 'digitalocean' && selected.available && selected.configured;

  const loadRegions = useCallback(() => {
    setRegionsLoading(true); setRegionsError('');
    const key = account;
    getDoRegions(key)
      .then((r) => setRegionsBy((by) => ({ ...by, [key]: r })))
      .catch((e) => {
        if (accountRef.current !== key) return;   // another account is chosen now
        const d = errorDetail<{ reason?: string }>(e);
        setRegionsError(d?.reason || errorText(e, "Couldn't load DigitalOcean regions."));
      })
      .finally(() => { if (accountRef.current === key) setRegionsLoading(false); });
  }, [account]);

  const doRegions = regionsBy[account];
  useEffect(() => {
    if (!doReady) { setRegion(''); return; }
    if (doRegions) setRegion((cur) => cur || doRegions.default || '');
    else loadRegions();
  }, [doReady, doRegions, loadRegions]);

  const isCustom = connectType === 'custom';
  const trimmedName = (connectName ?? '').trim();
  const nameOk = !isCustom || (!!trimmedName && !nameProblem(trimmedName));
  // VM hosts are tested in Settings › Integrations; Sirdar builds the environment's VMs there.
  const vmHostSelected = !!selected && (kindOf(selected) === 'proxmox' || kindOf(selected) === 'esxi');
  const canRun = !!selected && selected.available && selected.configured && nameOk && canAdd && !running
    && !vmHostSelected;

  const choosableTarget = (t: DeployTarget) => t.available && (choosable?.(t.id) ?? true);
  const pick = (id: string) => {
    if (id === target) return;
    onTarget(id); clearOutcome();
  };

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(''); setResult(null); setMismatch(null);
    try {
      const sent = doReady && region ? region : undefined;
      const sentName = isCustom ? trimmedName : undefined;
      const r = doReady ? await connectDeploy(target, connectType, sent, sentName, account)
        : sentName ? await connectDeploy(target, connectType, sent, sentName)
        : sent ? await connectDeploy(target, connectType, sent) : await connectDeploy(target, connectType);
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
      onTarget(''); clearOutcome();
      await loadTargets();
      onTargetsChanged?.();
    } catch (e) { setError(errorText(e, "Couldn't remove that target.")); }
  };
  const savedSsh = (slug: string) => {
    setSshModal(null); clearOutcome(); onTarget(`ssh:${slug}`);
    loadTargets().then(() => onTargetsChanged?.());
  };

  const firstEnabled = targets.find(choosableTarget)?.id;
  return (
    <div>
      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      <div className="sirdar-cards">
        <div role="radiogroup" aria-label="Deployment target" className="sirdar-contents">
        {targets.map((t) => {
          const ok = choosableTarget(t);
          return (
            <button key={t.id} type="button" role="radio" className={`sirdar-card sirdar-target${t.id === target ? ' on' : ''}`}
                    aria-checked={t.id === target} aria-disabled={!ok}
                    tabIndex={t.id === target || (!target && t.id === firstEnabled) ? 0 : -1}
                    onKeyDown={arrowNav}
                    onClick={() => { if (ok) pick(t.id); }}>
              <span className="sirdar-target-top">
                <span className="sirdar-target-icon" aria-hidden="true">{INITIALS[kindOf(t)] ?? t.label.slice(0, 2)}</span>
                {statusChip(t)}
              </span>
              <b>{t.label}</b>
            </button>
          );
        })}
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
      {vmHostSelected && selected && (
        <p className="page-hint sirdar-envnote">
          Sirdar builds this environment's VMs on {selected.label}. Test the host in Settings › Integrations.
        </p>
      )}
      {savedSelected && !savedSelected.configured && (
        <p className="page-hint sirdar-envnote">This target needs a password or a key file. Use Edit to add one.</p>
      )}
      {selected && selected.available && !selected.configured && selected.source !== 'saved' && (
        <p className="page-hint sirdar-envnote">
          {kindOf(selected) === 'digitalocean' && 'Set up a DigitalOcean account in Settings › Integrations, or '}
          {kindOf(selected) === 'digitalocean' ? 'set' : 'Set'} {ENV_KEYS[kindOf(selected)]?.map((k, i) => (
            <span key={k}>{i > 0 && ', '}<code>{k}</code></span>
          ))} in the .env file, then re-run the installer.
        </p>
      )}

      <details className="sirdar-flow-details">
        <summary>Connection test and trusted SSH hosts</summary>
        <section className="sirdar-section">
          <div className="sirdar-section-head">
            <h3>Connect</h3>
            <button type="button" className="btn-solid" disabled={!canRun} onClick={run}>
              {running ? 'Connecting…' : 'Test connection'}
            </button>
          </div>
          {doReady && !doAccount && doAccounts.length > 0 && (
            <div className="sirdar-region">
              <span className="field-label" id="do-account-label">Account</span>
              <div className="segmented" role="radiogroup" aria-labelledby="do-account-label">
                {doAccounts.map((a) => (
                  <button key={a.key} type="button" role="radio" aria-checked={account === a.key}
                          className={account === a.key ? 'on' : ''} tabIndex={account === a.key ? 0 : -1}
                          disabled={!a.configured} onKeyDown={arrowNav}
                          onClick={() => {
                            if (a.key === account) return;
                            accountRef.current = a.key;
                            setAccount(a.key); setRegion(''); setRegionsLoading(false); setRegionsError(''); clearOutcome();
                          }}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          )}
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
                {CONNECT_LABEL[result.type] ?? result.type}
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
          <h3>Trusted SSH hosts</h3>
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
      </details>

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
