/** Set up or change one integration Sirdar publishes with: Cloudflare (zone,
 *  public IP, API token) or Nginx Proxy Manager (URL, login, Let's Encrypt
 *  email, password). The secret is write-only: kept unless replaced, never
 *  shown. Test tries the values in the form without saving them. */
import { type RefObject, useEffect, useRef, useState } from 'react';

import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import { ipv4Problem } from '../../lib/envRules';
import {
  INTEGRATION_LABEL, deployErrorText, saveIntegration, testIntegration,
  type CloudflareBody, type IntegrationCheck, type PublishKind, type Integrations, type NpmBody,
} from '../../lib/sirdarApi';

type Field = 'zone' | 'ip' | 'url' | 'identity' | 'email' | 'secret' | 'form';
type Errors = Partial<Record<Field, string>>;
/** API error code → the field it belongs to. */
const CODE_FIELD: Record<string, Field> = {
  zone_invalid: 'zone', public_ip_invalid: 'ip', token_invalid: 'secret', secret_required: 'secret',
  npm_url_invalid: 'url', identity_invalid: 'identity', letsencrypt_email_invalid: 'email', password_invalid: 'secret',
};
const URL_RE = /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?\/?$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const DESCRIPTION: Record<PublishKind, string> = {
  cloudflare: 'Sirdar keeps an A record for each public service in this zone, pointing at the public IP. '
    + 'The API token needs DNS edit on the zone.',
  npm: "Sirdar keeps a proxy host and a Let's Encrypt certificate for each public service through the "
    + 'Nginx Proxy Manager API.',
};
const SECRET_LABEL: Record<PublishKind, string> = { cloudflare: 'API token', npm: 'Password' };
const SECRET_MISSING: Record<PublishKind, string> = { cloudflare: 'Enter the API token.', npm: 'Enter the password.' };

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

export default function IntegrationModal({ kind, current, onSaved, onClose }: {
  kind: PublishKind; current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void;
}) {
  const cf = current.cloudflare;
  const npm = current.npm;
  const secretSet = kind === 'cloudflare' ? cf.token_set : npm.password_set;
  const [zone, setZone] = useState(cf.zone ?? 'serversherpa.com');
  const [ip, setIp] = useState(cf.public_ip ?? '');
  const [url, setUrl] = useState(npm.url ?? '');
  const [identity, setIdentity] = useState(npm.identity ?? '');
  // Blank means "the login email"; show it only when it differs.
  const [email, setEmail] = useState(
    npm.letsencrypt_email && npm.letsencrypt_email !== npm.identity ? npm.letsencrypt_email : '');
  const [action, setAction] = useState<SecretAction>(secretSet ? 'keep' : 'set');
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Bumped by every edit: a Test result (or one still out) for older values is dropped.
  const edits = useRef(0);
  const edited = <T,>(set: (v: T) => void) => (v: T) => { edits.current += 1; setResult(null); set(v); };
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

  const body = (): CloudflareBody | NpmBody => (kind === 'cloudflare'
    ? { zone: zone.trim(), public_ip: ip.trim(), ...(action === 'set' ? { token: secret } : {}) }
    : { url: url.trim(), identity: identity.trim(), letsencrypt_email: email.trim(),
        ...(action === 'set' ? { password: secret } : {}) });

  const validate = (): Errors => {
    const e: Errors = {};
    if (kind === 'cloudflare') {
      if (!zone.trim()) e.zone = 'Enter the zone, like serversherpa.com.';
      const problem = ipv4Problem(ip, 'public IP');
      if (problem) e.ip = problem;
    } else {
      if (!URL_RE.test(url.trim())) e.url = 'Start with http:// or https://, then the host and port only.';
      if (!EMAIL_RE.test(identity.trim())) e.identity = 'Enter an email address.';
      if (email.trim() && !EMAIL_RE.test(email.trim())) e.email = 'Enter an email address, or leave it blank.';
    }
    if (action === 'set' && !secret) e.secret = SECRET_MISSING[kind];
    return e;
  };

  const run = async (what: 'test' | 'save') => {
    if (busyRef.current) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;
    busyRef.current = what;
    setBusy(what);
    setResult(null);
    const at = edits.current;
    try {
      if (what === 'test') {
        const checked = await testIntegration(kind, body());
        if (at === edits.current) setResult(checked);
      }
      else onSaved(await saveIntegration(kind, body()));
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      setErrors({ [CODE_FIELD[code] ?? 'form']: deployErrorText(err,
        what === 'test' ? "Couldn't test these settings." : "Couldn't save these settings.") });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  };

  const label = INTEGRATION_LABEL[kind];
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-integration-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-integration-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-integration-title">{label}</h3>
            <p className="page-hint">{DESCRIPTION[kind]}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-integration-form">
          {kind === 'cloudflare' ? (
            <>
              <TextField id="int-zone" label="Zone" value={zone} error={errors.zone} inputRef={firstRef}
                         onChange={edited(setZone)} />
              <TextField id="int-ip" label="Public IP" value={ip} error={errors.ip}
                         hint="The WAN address every A record points at." onChange={edited(setIp)} />
            </>
          ) : (
            <>
              <TextField id="int-url" label="URL" value={url} error={errors.url} inputRef={firstRef}
                         hint="Where Sirdar reaches Nginx Proxy Manager, like http://10.10.48.6:81." onChange={edited(setUrl)} />
              <TextField id="int-identity" label="Login email" value={identity} error={errors.identity}
                         onChange={edited(setIdentity)} />
              <TextField id="int-email" label="Let's Encrypt email" value={email} error={errors.email}
                         hint="Older Nginx Proxy Manager versions use this; 2.13 and later use the NPM login's own email."
                         onChange={edited(setEmail)} />
            </>
          )}
          <div className="sirdar-span2">
            <SecretField id="int-secret" label={SECRET_LABEL[kind]} isSet={secretSet} adding={!secretSet}
                         action={action} value={secret} error={errors.secret} clearable={false}
                         onAction={edited((a: SecretAction) => { setAction(a); setSecret(''); })} onValue={edited(setSecret)} />
          </div>
          {result && (
            <div className="sirdar-span2">
              <CheckList label={`${label} test`} checks={result.checks} />
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
