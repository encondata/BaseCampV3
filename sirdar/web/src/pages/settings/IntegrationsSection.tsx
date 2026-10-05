/** Settings › Integrations: the credentials Sirdar publishes environments
 *  with (Cloudflare DNS, Nginx Proxy Manager) and builds Proxmox VMs with.
 *  Secrets are write-only: a card shows only whether one is set. Test checks
 *  the saved settings; Remove forgets them (nothing changes in Cloudflare,
 *  NPM or Proxmox). */
import { Fragment, useCallback, useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import Breakable from '../../components/Breakable';
import CheckList from '../../components/CheckList';
import {
  INTEGRATION_LABEL, deployErrorText, getIntegrations, removeIntegration, testIntegration,
  type IntegrationCheck, type IntegrationKind, type Integrations,
} from '../../lib/sirdarApi';
import { when } from '../environments/labels';

import IntegrationModal from './IntegrationModal';
import ProxmoxModal from './ProxmoxModal';

const KINDS: IntegrationKind[] = ['cloudflare', 'npm', 'proxmox'];
const PURPOSE: Record<IntegrationKind, string> = {
  proxmox: 'The Proxmox host Sirdar builds a VM on for each Proxmox environment.',
  cloudflare: 'DNS records for every public service of an environment that publishes.',
  npm: 'Proxy hosts and certificates for every public service of an environment that publishes.',
};

function settingsOf(data: Integrations, kind: IntegrationKind): [string, string][] {
  const set = (on: boolean) => (on ? 'Set' : 'Not set');
  if (kind === 'proxmox') {
    const p = data.proxmox;
    const where = p.template_vmid === null ? '—'
      : `ubuntu template ${p.template_vmid} · ${p.storage} · ${p.bridge}${p.vlan_tag ? ` · VLAN ${p.vlan_tag}` : ''}`;
    return [['URL', p.url ?? '—'], ['Node and pool', p.node ? `${p.node} · ${p.pool}` : '—'], ['Builds from', where],
            ['Certificate', p.tls_fingerprint ? `${p.tls_fingerprint.slice(0, 23)}…` : '—'],
            ['API token', p.token_set ? `Set (${p.token_id})` : 'Not set']];
  }
  if (kind === 'cloudflare') {
    const c = data.cloudflare;
    return [['Zone', c.zone ?? '—'], ['Public IP', c.public_ip ?? '—'], ['API token', set(c.token_set)]];
  }
  const n = data.npm;
  return [['URL', n.url ?? '—'], ['Login email', n.identity ?? '—'],
          ["Let's Encrypt email", n.letsencrypt_email ?? '—'], ['Password', set(n.password_set)]];
}

export default function IntegrationsSection() {
  const { can } = useAuth();
  const mayChange = can('deploy', 'change');
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<IntegrationKind | null>(null);
  const [results, setResults] = useState<Partial<Record<IntegrationKind, IntegrationCheck>>>({});
  const [problems, setProblems] = useState<Partial<Record<IntegrationKind, string>>>({});
  const [busy, setBusy] = useState<IntegrationKind | null>(null);

  const load = useCallback(() => getIntegrations()
    .then((d) => { setData(d); setError(''); })
    .catch((e) => setError(deployErrorText(e, "Couldn't load the integrations."))), []);
  useEffect(() => { void load(); }, [load]);

  const forget = (kind: IntegrationKind) => {
    setResults((r) => ({ ...r, [kind]: undefined }));
    setProblems((p) => ({ ...p, [kind]: '' }));
  };

  const test = async (kind: IntegrationKind) => {
    forget(kind);
    setBusy(kind);
    try {
      const result = await testIntegration(kind);
      setResults((r) => ({ ...r, [kind]: result }));
    } catch (e) {
      const code = (e as { code?: string }).code;
      // The certificate prompt lives in the Edit modal.
      const review = code === 'tls_untrusted' || code === 'tls_mismatch' ? ' Open Edit to review the certificate.' : '';
      setProblems((p) => ({ ...p, [kind]: deployErrorText(e, "Couldn't test the connection.") + review }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kind: IntegrationKind) => {
    const label = INTEGRATION_LABEL[kind];
    if (!window.confirm(kind === 'proxmox'
      ? 'Remove the Proxmox credentials? Nothing changes in Proxmox itself.'
      : `Remove the ${label} credentials? Publishing stops until they are set again; `
        + `nothing changes in ${label} itself.`)) return;
    forget(kind);
    setBusy(kind);
    try {
      await removeIntegration(kind);
      await load();
    } catch (e) {
      setProblems((p) => ({ ...p, [kind]: deployErrorText(e, "Couldn't remove the credentials.") }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sirdar-section">
      <h2>Integrations</h2>
      <p className="page-hint">
        Environments with Publish on use Cloudflare and Nginx Proxy Manager for their DNS records and proxy hosts;
        Proxmox environments are built on Proxmox. Tokens and passwords are stored encrypted and never shown again.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && !data.secrets_key_configured && (
        <p className="page-hint">
          SIRDAR_SECRETS_KEY isn't set on the Sirdar host, so credentials can't be stored. Add it to sirdar/.env and
          restart Sirdar.
        </p>
      )}
      {data && (
        <div className="sirdar-cards sirdar-integration-cards">
          {KINDS.map((kind) => {
            const label = INTEGRATION_LABEL[kind];
            const item = data[kind];
            return (
              <div key={kind} className="sirdar-card" role="group" aria-label={label}>
                <div className="sirdar-card-head">
                  <h3>{label}</h3>
                  <span className={`chip ${item.configured ? 'c-green' : 'tag'}`}>
                    {item.configured ? 'Configured' : 'Not set up'}
                  </span>
                </div>
                <p className="page-hint">{PURPOSE[kind]}</p>
                <dl className="sirdar-kv">
                  {settingsOf(data, kind).map(([k, v]) => (
                    <Fragment key={k}><dt>{k}</dt><dd className="mono"><Breakable text={v} /></dd></Fragment>
                  ))}
                </dl>
                {item.updated_at && (
                  <p className="page-hint">
                    Updated {when(item.updated_at)}{item.updated_by_name ? ` by ${item.updated_by_name}` : ''}
                  </p>
                )}
                {mayChange && (
                  <div className="sirdar-actions">
                    {item.configured && (
                      <button type="button" className="mini-btn danger" aria-label={`Remove ${label}`}
                              disabled={busy === kind} onClick={() => void remove(kind)}>Remove</button>
                    )}
                    {item.configured && (
                      <button type="button" className="mini-btn" aria-label={`Test ${label}`}
                              disabled={busy === kind} onClick={() => void test(kind)}>
                        {busy === kind ? 'Testing…' : 'Test'}
                      </button>
                    )}
                    <button type="button" className="mini-btn"
                            aria-label={`${item.configured ? 'Edit' : 'Set up'} ${label}`}
                            disabled={!data.secrets_key_configured || busy === kind} onClick={() => setEditing(kind)}>
                      {item.configured ? 'Edit' : 'Set up'}
                    </button>
                  </div>
                )}
                {problems[kind] && <p className="form-error" role="alert">{problems[kind]}</p>}
                {results[kind] && <CheckList label={`${label} test`} checks={results[kind]!.checks} />}
              </div>
            );
          })}
        </div>
      )}
      {data && !mayChange && <p className="page-hint">You can view these settings but not change them.</p>}
      {editing && data && editing !== 'proxmox' && (
        <IntegrationModal kind={editing} current={data} onClose={() => setEditing(null)}
                          onSaved={(saved) => { setData(saved); forget(editing); setEditing(null); }} />
      )}
      {editing === 'proxmox' && data && (
        <ProxmoxModal current={data} onClose={() => setEditing(null)}
                      onSaved={(saved) => { setData(saved); forget('proxmox'); setEditing(null); }} />
      )}
    </section>
  );
}
