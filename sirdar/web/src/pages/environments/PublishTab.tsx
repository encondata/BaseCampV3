/** Publish tab: whether deploys publish this environment (a DNS record and a
 *  proxy host per public name, then a smoke test), what publishing would do
 *  now for each name (read live from Cloudflare and Nginx Proxy Manager),
 *  Claim for hand-made records and hosts, and Publish now (steps 12–14 alone).
 *  DigitalOcean: DNS only (records at the load balancer, no proxy hosts), and
 *  the switch can't change (the API's do_field_locked). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import { arrowNav } from '../../lib/arrowNav';
import {
  claimPublish, deployErrorText, getPublishPlan, startDeployment, updateEnvironment,
  type Deployment, type Environment, type PublishEntry, type PublishPlan,
} from '../../lib/sirdarApi';

import { CERT_STATE, PUBLISH_STATE, StatusChip, deploymentRunning, onDo } from './labels';

const SWITCH: [boolean, string][] = [[true, 'On'], [false, 'Off']];

function Entry({ entry }: { entry: PublishEntry }) {
  return (
    <div>
      <StatusChip map={PUBLISH_STATE} status={entry.state} />
      {entry.origin === 'claimed' && <span className="cell-sub"> claimed</span>}
      {entry.detail && <div className="cell-sub">{entry.detail}</div>}
    </div>
  );
}

export default function PublishTab({ env, onStarted, onChanged }: {
  env: Environment; onStarted: (dep: Deployment) => void; onChanged: (env: Environment) => void;
}) {
  const { can } = useAuth();
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'' | 'switch' | 'claim' | 'publish'>('');
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  // Only the newest request's answer lands; Refresh waits for it.
  const load = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    return getPublishPlan(env.name)
      .then((p) => { if (n === seq.current) { setPlan(p); setError(''); } })
      .catch((e) => { if (n === seq.current) setError(deployErrorText(e, "Couldn't read what publishing would do.")); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, [env.name]);
  // A publish job keeps the environment's status, so "running" also reads its
  // latest deployment. A deployment that ends may have published: read again.
  const running = deploymentRunning(env);
  useEffect(() => { void load(); }, [load, env.status, running]);
  useEffect(() => () => { seq.current += 1; }, []);

  const mayChange = can('deploy', 'change');
  const mayDeploy = can('deploy', 'add');
  const cloud = onDo(env);
  // DigitalOcean never uses Nginx Proxy Manager: Cloudflare alone publishes it.
  const configured = !!plan && plan.cloudflare.configured && (cloud || plan.npm.configured);
  const claimable = !!plan && plan.services.some((s) => s.dns.state === 'claimable' || s.proxy.state === 'claimable');
  const switchLocked = cloud || !mayChange || running || busy !== '';

  const act = async (what: 'switch' | 'claim' | 'publish', work: () => Promise<void>, fallback: string) => {
    setBusy(what);
    setNotice('');
    setError('');
    try {
      await work();
    } catch (e) {
      setError(deployErrorText(e, fallback));
    } finally {
      setBusy('');
    }
  };
  const setPublish = (on: boolean) => {
    if (switchLocked || on === env.publish) return;
    void act('switch', async () => { onChanged(await updateEnvironment(env.name, { publish: on })); },
      "Couldn't change the Publish setting.");
  };
  const claim = () => act('claim', async () => {
    const result = await claimPublish(env.name);
    setPlan(result);
    setNotice(`Claimed ${result.claimed.length}: ${result.claimed.join(', ')}. Sirdar keeps them up to date and `
      + 'never deletes them.');
  }, "Couldn't claim them.");
  const publishNow = () => act('publish', async () => {
    onStarted(await startDeployment(env.name, { mode: 'publish' }));
  }, "Couldn't start publishing.");

  const why = !env.publish ? 'Turn Publish on first.' : !env.current_sha ? 'Deploy the environment first.'
    : !configured ? 'Set up both integrations first.' : running ? 'A deployment is running.' : undefined;

  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Publish</h2>
        <button type="button" className="mini-btn" disabled={loading} onClick={() => void load()}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div className="sirdar-publish-switch">
        <span className="field-label" id="publish-switch-label">{cloud ? 'Publish DNS' : 'Publish DNS and proxy'}</span>
        <div className="segmented" role="radiogroup" aria-labelledby="publish-switch-label"
             title={!cloud && mayChange && running ? 'A deployment is running.' : undefined}>
          {SWITCH.map(([value, label]) => (
            <button key={label} type="button" role="radio" aria-checked={env.publish === value}
                    aria-disabled={switchLocked} className={env.publish === value ? 'on' : ''}
                    tabIndex={env.publish === value ? 0 : -1} onKeyDown={arrowNav}
                    onClick={() => setPublish(value)}>{label}</button>
          ))}
        </div>
        <p className="page-hint">
          {cloud
            ? 'DigitalOcean environments publish their DNS during each deploy.'
            : env.publish
            ? 'Each deploy ends by bringing the DNS records and proxy hosts below up to date, then checks every public URL.'
            : 'Deploys leave DNS and the proxy as they are.'}
        </p>
        {!cloud && mayChange && running && <p className="page-hint">Publish can't change while a deployment is running.</p>}
      </div>
      {plan && !configured && (
        <p className="page-hint">
          Set up {cloud ? 'Cloudflare' : 'Cloudflare and Nginx Proxy Manager'} in <Link to="/settings">Settings › Integrations</Link> to publish.
        </p>
      )}
      {plan?.cloudflare.error && <p className="form-error" role="alert">Cloudflare: {plan.cloudflare.error}</p>}
      {plan?.npm.error && <p className="form-error" role="alert">Nginx Proxy Manager: {plan.npm.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Public names"
        columns={[
          { key: 'service', label: 'Service' }, { key: 'host', label: 'Public name', mono: true },
          { key: 'fwd', label: 'Forwards to', mono: true }, { key: 'dns', label: 'DNS record' },
          ...(cloud ? [] : [{ key: 'proxy', label: 'Proxy host' }, { key: 'cert', label: 'Certificate' }]),
        ]}
        rows={(plan?.services ?? []).map((s) => ({
          key: s.service,
          cells: [
            <b className="cell-top">{s.service}</b>, s.hostname, s.forward,
            <Entry entry={s.dns} />,
            ...(cloud ? [] : [
              <Entry entry={s.proxy} />,
              <div>
                <StatusChip map={CERT_STATE} status={s.certificate.state} />
                {s.certificate.detail && <div className="cell-sub">{s.certificate.detail}</div>}
              </div>,
            ]),
          ],
        }))}
        emptyText={plan !== null ? 'This environment has no public services.'
          : loading ? 'Loading…' : "Couldn't load the publish plan."}
      />
      {plan && plan.stale.length > 0 && (
        <p className="page-hint">
          The next publish also removes what Sirdar made under names this environment no longer uses, and lets go of
          what was claimed there: {plan.stale.map((r) => r.name).join(', ')}.
        </p>
      )}
      {claimable && (
        <p className="page-hint">
          "Not Sirdar's" entries were made by hand. Claim them to let Sirdar keep them up to date; it never deletes what
          it claimed, even when the environment is deleted.
        </p>
      )}
      {notice && <p className="page-hint" role="status">{notice}</p>}
      {(mayChange || mayDeploy) && (
        <div className="sirdar-actions">
          {mayChange && (
            <button type="button" className="btn-ghost" disabled={!claimable || running || busy !== ''}
                    onClick={() => void claim()}>
              {busy === 'claim' ? 'Claiming…' : 'Claim existing'}
            </button>
          )}
          {mayDeploy && (
            <button type="button" className="btn-solid" disabled={!!why || busy !== ''} title={why}
                    onClick={() => void publishNow()}>
              {busy === 'publish' ? 'Starting…' : 'Publish now'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
