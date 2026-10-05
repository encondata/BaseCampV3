/** Set up or change the VMware ESXi integration: the standalone ESXi host
 *  Sirdar builds ESXi environments' VMs on (URL, user, datastore, port group,
 *  resource pool, seed VM, DNS servers) and the user's password, write-only.
 *  The host's TLS certificate is pinned trust-on-first-use, as for Proxmox:
 *  Test or Save first answers with the certificate, the user compares its
 *  fingerprint with the host's own and trusts it, and the same request goes
 *  again with that fingerprint. */
import { type RefObject, useEffect, useRef, useState } from 'react';

import CertificatePrompt, { pendingCertificate, type PendingCertificate } from '../../components/CertificatePrompt';
import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import {
  deployErrorText, saveIntegration, testIntegration,
  type EsxiBody, type IntegrationCheck, type Integrations,
} from '../../lib/sirdarApi';

type Field = 'url' | 'user' | 'datastore' | 'network' | 'pool' | 'seed' | 'dns' | 'secret' | 'form';
type Errors = Partial<Record<Field, string>>;
type What = 'test' | 'save';
const CODE_FIELD: Record<string, Field> = {
  esxi_url_invalid: 'url', esxi_user_invalid: 'user', datastore_invalid: 'datastore', network_invalid: 'network',
  resource_pool_invalid: 'pool', source_vm_invalid: 'seed', dns_servers_invalid: 'dns', password_invalid: 'secret',
  secret_required: 'secret',
};
const URL_RE = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?\/?$/;
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
// The API's rule: no brackets, slashes or colons; no leading/trailing space.
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._()-]{0,78}[A-Za-z0-9._()-])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const QUESTION = 'Is this the certificate the ESXi host shows? Compare it with Host Client › Manage › Security & users › '
  + 'Certificates, or run openssl x509 -in /etc/vmware/ssl/rui.crt -noout -fingerprint -sha256 in the ESXi Shell.';

const dnsList = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);

function TextField({ id, label, value, error, hint, inputRef, onChange }: {
  id: string; label: string; value: string; error?: string; hint?: string;
  inputRef?: RefObject<HTMLInputElement>; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} ref={inputRef} type="text" value={value} autoComplete="off" spellCheck={false}
             aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint">{hint}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function EsxiModal({ current, onSaved, onClose }: {
  current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void;
}) {
  const ex = current.esxi;
  const storedUrl = ex.url ?? '';
  const storedUser = ex.user ?? '';
  const [url, setUrl] = useState(storedUrl);
  const [user, setUser] = useState(ex.user ?? 'sirdar');
  const [datastore, setDatastore] = useState(ex.datastore ?? 'datastore1');
  const [network, setNetwork] = useState(ex.network ?? 'VM Network');
  const [pool, setPool] = useState(ex.resource_pool ?? '');
  const [seed, setSeed] = useState(ex.source_vm ?? 'sirdar-ubuntu-2404-seed');
  const [dns, setDns] = useState(ex.dns_servers.join(', '));
  /** The certificate the next request trusts; null: let the server show it first. */
  const [fingerprint, setFingerprint] = useState<string | null>(ex.tls_fingerprint);
  const [pending, setPending] = useState<PendingCertificate<What> | null>(null);
  const [action, setAction] = useState<SecretAction>(ex.password_set ? 'keep' : 'set');
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'' | What>('');
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Bumped by every edit: an answer for values edited since is dropped. */
  const version = useRef(0);
  const firstRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const edited = () => { version.current += 1; setResult(null); setPending(null); };
  const edit = (set: (v: string) => void) => (v: string) => { set(v); edited(); };
  const editUrl = (v: string) => {
    setUrl(v);
    // The stored pin belongs to the stored host only.
    setFingerprint(v.trim().replace(/\/$/, '') === storedUrl ? ex.tls_fingerprint : null);
    edited();
  };
  const otherLogin = url.trim().replace(/\/$/, '') !== storedUrl || user.trim() !== storedUser;

  const body = (trusted: string | null): EsxiBody => ({
    url: url.trim(), user: user.trim(), datastore: datastore.trim(), network: network.trim(),
    resource_pool: pool.trim() || null, source_vm: seed.trim(), dns_servers: dnsList(dns),
    tls_fingerprint: trusted, ...(action === 'set' ? { password: secret } : {}),
  });

  const validate = (): Errors => {
    const e: Errors = {};
    if (!URL_RE.test(url.trim())) e.url = 'Start with https://, then the host and port only.';
    if (!USER_RE.test(user.trim())) e.user = 'Enter the ESXi user, like sirdar.';
    if (!NAME_RE.test(datastore.trim())) e.datastore = 'Enter the datastore for VM disks, like datastore1.';
    if (!NAME_RE.test(network.trim())) e.network = 'Enter the port group, like VM Network.';
    if (pool.trim() && !NAME_RE.test(pool.trim())) e.pool = "Enter a resource pool's name, or leave it empty.";
    if (!NAME_RE.test(seed.trim())) e.seed = 'Enter the seed VM, like sirdar-ubuntu-2404-seed.';
    const servers = dnsList(dns);
    if (servers.length > 3 || servers.some((s) => !IPV4_RE.test(s))) {
      e.dns = 'Use up to 3 IPv4 addresses, separated by commas.';
    }
    if (action === 'set' && !secret) e.secret = 'Enter the ESXi password.';
    if (action === 'keep' && otherLogin && ex.password_set) {
      e.secret = 'Enter the password again for a different host or user.';
    }
    return e;
  };

  const run = async (what: What, trusted: string | null = fingerprint) => {
    if (busyRef.current) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    busyRef.current = what;
    setBusy(what);
    setResult(null);
    setPending(null);
    const asked = version.current;
    try {
      if (what === 'test') {
        const checked = await testIntegration('esxi', body(trusted));
        if (asked === version.current) setResult(checked);
      } else {
        onSaved(await saveIntegration('esxi', body(trusted)));
      }
    } catch (err) {
      if (asked !== version.current) return;
      const prompt = pendingCertificate(err, what);
      if (prompt) setPending(prompt);
      else setErrors({ [CODE_FIELD[(err as { code?: string }).code ?? ''] ?? 'form']: deployErrorText(err,
        what === 'test' ? "Couldn't test these settings." : "Couldn't save these settings.") });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  };

  const trust = (value: string, what: What) => {
    setFingerprint(value);
    void run(what, value);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-esxi-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-esxi-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-esxi-title">VMware ESXi</h3>
            <p className="page-hint">
              Sirdar builds each ESXi environment's VM on this standalone host: it copies the seed VM's disk to the
              datastore below and connects the VM to the port group. The host needs a paid license; the user needs
              the Administrator role (see the README).
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-esxi-form">
          <div className="sirdar-span2">
            <TextField id="esxi-url" label="URL" value={url} error={errors.url} inputRef={firstRef}
                       hint="Where Sirdar reaches the host's API, like https://10.10.48.10." onChange={editUrl} />
          </div>
          <TextField id="esxi-user" label="User" value={user} error={errors.user}
                     onChange={(v) => { setUser(v); edited(); }} />
          <TextField id="esxi-datastore" label="Datastore" value={datastore} error={errors.datastore}
                     onChange={edit(setDatastore)} />
          <TextField id="esxi-network" label="Port group" value={network} error={errors.network}
                     onChange={edit(setNetwork)} />
          <TextField id="esxi-pool" label="Resource pool" value={pool} error={errors.pool}
                     hint="Empty: the host's root pool." onChange={edit(setPool)} />
          <TextField id="esxi-seed" label="Seed VM" value={seed} error={errors.seed}
                     hint="Ubuntu 24.04 cloud image, powered off, never started." onChange={edit(setSeed)} />
          <TextField id="esxi-dns" label="DNS servers" value={dns} error={errors.dns}
                     hint="Up to 3, comma-separated. Empty: each VM's gateway." onChange={edit(setDns)} />
          <div className="sirdar-span2">
            <span className="field-label">Certificate</span>
            {fingerprint ? (
              <div className="sirdar-secret-row">
                <span className="mono sirdar-fingerprint">{fingerprint}</span>
                <button type="button" className="mini-btn" disabled={!!busy}
                        onClick={() => { setFingerprint(null); edited(); }}>Check again</button>
              </div>
            ) : (
              <p className="page-hint">Not trusted yet. Test or Save shows the host's certificate first.</p>
            )}
          </div>
          {pending && <CertificatePrompt pending={pending} question={QUESTION} busy={!!busy} onTrust={trust} />}
          <div className="sirdar-span2">
            <SecretField id="esxi-password" label="Password" isSet={ex.password_set} adding={!ex.password_set}
                         action={action} value={secret} error={errors.secret} clearable={false}
                         onAction={(a) => { setAction(a); setSecret(''); edited(); }}
                         onValue={(v) => { setSecret(v); edited(); }} />
          </div>
          {result && (
            <div className="sirdar-span2">
              <CheckList label="VMware ESXi test" checks={result.checks} />
            </div>
          )}
          {errors.form && <p className="form-error sirdar-span2" role="alert">{errors.form}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => void run('test')}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button type="button" className="btn-solid" disabled={!!busy} onClick={() => void run('save')}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
