/** Set up or change the Proxmox integration: where Sirdar builds Proxmox
 *  environments' VMs (URL, node, pool, storage, bridge, VLAN tag, template)
 *  and the API token, write-only. The server's TLS certificate is pinned
 *  trust-on-first-use: Test or Save first answers with the certificate, the
 *  user compares its fingerprint with Proxmox's own and trusts it, and the
 *  same request goes again with that fingerprint. */
import { type RefObject, useEffect, useRef, useState } from 'react';

import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import {
  deployErrorText, errorDetail, saveIntegration, testIntegration,
  type IntegrationCheck, type Integrations, type ProxmoxBody, type TlsCertificate,
} from '../../lib/sirdarApi';
import { when } from '../environments/labels';

type Field = 'url' | 'node' | 'pool' | 'storage' | 'bridge' | 'vlan' | 'template' | 'secret' | 'form';
type Errors = Partial<Record<Field, string>>;
type What = 'test' | 'save';
/** A certificate waiting for the user: a new one (tls_untrusted) or a changed one (tls_mismatch). */
type Pending = { kind: 'untrusted'; what: What; cert: TlsCertificate }
  | { kind: 'changed'; what: What; expected: string; actual: string };
/** API error code → the field it belongs to. */
const CODE_FIELD: Record<string, Field> = {
  proxmox_url_invalid: 'url', node_invalid: 'node', pool_invalid: 'pool', storage_invalid: 'storage',
  bridge_invalid: 'bridge', vlan_tag_invalid: 'vlan', template_vmid_invalid: 'template',
  proxmox_token_invalid: 'secret', secret_required: 'secret',
};
const URL_RE = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?\/?$/;
const TOKEN_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]+=[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function TextField({ id, label, value, error, hint, inputRef, inputMode, onChange }: {
  id: string; label: string; value: string; error?: string; hint?: string;
  inputRef?: RefObject<HTMLInputElement>; inputMode?: 'numeric'; onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} ref={inputRef} type="text" value={value} autoComplete="off" spellCheck={false}
             inputMode={inputMode} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint">{hint}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export default function ProxmoxModal({ current, onSaved, onClose }: {
  current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void;
}) {
  const px = current.proxmox;
  const storedUrl = px.url ?? '';
  const [url, setUrl] = useState(storedUrl);
  const [node, setNode] = useState(px.node ?? 'pve');
  const [pool, setPool] = useState(px.pool ?? 'sirdar');
  const [storage, setStorage] = useState(px.storage ?? 'local-lvm');
  const [bridge, setBridge] = useState(px.bridge ?? 'vmbr0');
  const [vlan, setVlan] = useState(px.vlan_tag === null ? '' : String(px.vlan_tag));
  const [template, setTemplate] = useState(px.template_vmid === null ? '9000' : String(px.template_vmid));
  /** The certificate the next request trusts; null: let the server show it first. */
  const [fingerprint, setFingerprint] = useState<string | null>(px.tls_fingerprint);
  const [pending, setPending] = useState<Pending | null>(null);
  const [action, setAction] = useState<SecretAction>(px.token_set ? 'keep' : 'set');
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
    // The stored pin belongs to the stored server only.
    setFingerprint(v.trim().replace(/\/$/, '') === storedUrl ? px.tls_fingerprint : null);
    edited();
  };
  const otherServer = url.trim().replace(/\/$/, '') !== storedUrl;

  const body = (trusted: string | null): ProxmoxBody => ({
    url: url.trim(), node: node.trim(), pool: pool.trim(), storage: storage.trim(), bridge: bridge.trim(),
    vlan_tag: vlan.trim() ? Number(vlan.trim()) : null, template_vmid: Number(template.trim()),
    tls_fingerprint: trusted, ...(action === 'set' ? { token: secret.trim() } : {}),
  });

  const validate = (): Errors => {
    const e: Errors = {};
    if (!URL_RE.test(url.trim())) e.url = 'Start with https://, then the host and port only.';
    if (!NAME_RE.test(node.trim())) e.node = 'Enter the node name, like pve.';
    if (!NAME_RE.test(pool.trim())) e.pool = 'Enter the pool Sirdar works in.';
    if (!NAME_RE.test(storage.trim())) e.storage = 'Enter the storage for VM disks, like local-lvm.';
    if (!NAME_RE.test(bridge.trim())) e.bridge = 'Enter the network bridge, like vmbr0.';
    const tag = vlan.trim();
    if (tag && (!/^\d+$/.test(tag) || Number(tag) < 1 || Number(tag) > 4094)) {
      e.vlan = 'Use a VLAN tag from 1 to 4094, or leave it empty.';
    }
    if (!/^\d+$/.test(template.trim()) || Number(template.trim()) < 100) {
      e.template = "Use the template's VM id, a number from 100 up.";
    }
    if (action === 'set' && !TOKEN_RE.test(secret.trim())) e.secret = 'Paste the whole token: user@realm!tokenid=secret.';
    if (action === 'keep' && otherServer && px.token_set) e.secret = 'Enter the API token again for a different server.';
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
        const checked = await testIntegration('proxmox', body(trusted));
        if (asked === version.current) setResult(checked);
      } else {
        onSaved(await saveIntegration('proxmox', body(trusted)));
      }
    } catch (err) {
      if (asked !== version.current) return;
      const code = (err as { code?: string }).code ?? '';
      const d = errorDetail<Record<string, unknown>>(err);
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      if (code === 'tls_untrusted' && d && typeof d.fingerprint === 'string') {
        const names = Array.isArray(d.names) ? d.names.map(String) : [];
        setPending({ kind: 'untrusted', what, cert: {
          fingerprint: d.fingerprint, subject: str(d.subject), issuer: str(d.issuer), not_after: str(d.not_after), names,
        } });
      } else if (code === 'tls_mismatch' && d && typeof d.expected === 'string' && typeof d.actual === 'string') {
        setPending({ kind: 'changed', what, expected: d.expected, actual: d.actual });
      } else {
        setErrors({ [CODE_FIELD[code] ?? 'form']: deployErrorText(err,
          what === 'test' ? "Couldn't test these settings." : "Couldn't save these settings.") });
      }
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
      <div className="modal-card reports-modal-card rgm-card sirdar-proxmox-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-proxmox-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-proxmox-title">Proxmox</h3>
            <p className="page-hint">
              Sirdar builds each Proxmox environment's VM here: a full clone of the template, in the pool, on the
              storage and bridge below. The token needs the privileges the README lists on that pool, storage and
              bridge.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-proxmox-form">
          <div className="sirdar-span2">
            <TextField id="px-url" label="URL" value={url} error={errors.url} inputRef={firstRef}
                       hint="Where Sirdar reaches the Proxmox API, like https://10.10.48.5:8006." onChange={editUrl} />
          </div>
          <TextField id="px-node" label="Node" value={node} error={errors.node} onChange={edit(setNode)} />
          <TextField id="px-pool" label="Pool" value={pool} error={errors.pool}
                     hint="Sirdar sees and changes only VMs in it." onChange={edit(setPool)} />
          <TextField id="px-storage" label="Storage" value={storage} error={errors.storage}
                     onChange={edit(setStorage)} />
          <TextField id="px-bridge" label="Bridge" value={bridge} error={errors.bridge} onChange={edit(setBridge)} />
          <TextField id="px-vlan" label="VLAN tag" value={vlan} error={errors.vlan} inputMode="numeric"
                     hint="Empty: untagged." onChange={edit(setVlan)} />
          <TextField id="px-template" label="Template VM id" value={template} error={errors.template}
                     inputMode="numeric" hint="Ubuntu 24.04 cloud-init with qemu-guest-agent."
                     onChange={edit(setTemplate)} />
          <div className="sirdar-span2">
            <span className="field-label">Certificate</span>
            {fingerprint ? (
              <div className="sirdar-secret-row">
                <span className="mono sirdar-fingerprint">{fingerprint}</span>
                <button type="button" className="mini-btn" disabled={!!busy}
                        onClick={() => { setFingerprint(null); edited(); }}>Check again</button>
              </div>
            ) : (
              <p className="page-hint">Not trusted yet. Test or Save shows the server's certificate first.</p>
            )}
          </div>
          {pending && (
            <div className="sirdar-span2 sirdar-cert-prompt" role="group" aria-label="Server certificate">
              {pending.kind === 'untrusted' ? (
                <>
                  <p>Is this the certificate Proxmox shows under the node's System › Certificates?</p>
                  <dl className="sirdar-kv">
                    <dt>SHA-256 fingerprint</dt><dd className="mono sirdar-fingerprint">{pending.cert.fingerprint}</dd>
                    <dt>Subject</dt><dd>{pending.cert.subject}</dd>
                    <dt>Issued by</dt><dd>{pending.cert.issuer}</dd>
                    <dt>Expires</dt><dd className="mono">{pending.cert.not_after ? when(pending.cert.not_after) : '—'}</dd>
                    <dt>Names</dt><dd className="mono">{pending.cert.names.join(', ')}</dd>
                  </dl>
                  <button type="button" className="btn-solid" disabled={!!busy}
                          onClick={() => trust(pending.cert.fingerprint, pending.what)}>Trust this certificate</button>
                </>
              ) : (
                <>
                  <p className="form-error">
                    The server's certificate changed. Trust the new one only if it was renewed on purpose.
                  </p>
                  <dl className="sirdar-kv">
                    <dt>Trusted</dt><dd className="mono sirdar-fingerprint">{pending.expected}</dd>
                    <dt>Now</dt><dd className="mono sirdar-fingerprint">{pending.actual}</dd>
                  </dl>
                  <button type="button" className="btn-ghost" disabled={!!busy}
                          onClick={() => trust(pending.actual, pending.what)}>Trust the new certificate</button>
                </>
              )}
            </div>
          )}
          <div className="sirdar-span2">
            <SecretField id="px-token" label="API token" isSet={px.token_set} adding={!px.token_set}
                         action={action} value={secret} error={errors.secret} clearable={false}
                         onAction={(a) => { setAction(a); setSecret(''); edited(); }}
                         onValue={(v) => { setSecret(v); edited(); }} />
            {px.token_id && action === 'keep' && <p className="page-hint mono">{px.token_id}</p>}
          </div>
          {result && (
            <div className="sirdar-span2">
              <CheckList label="Proxmox test" checks={result.checks} />
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
