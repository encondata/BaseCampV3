/** One DigitalOcean account (Production or Development): its label, default
 *  region, API token and the renewal token droplets renew their certificate
 *  with. Tokens are write-only: kept unless replaced, never shown. The API
 *  token is required only while nothing configures the account (an account
 *  can run on SIRDAR_DEPLOY_DO_TOKEN from the server environment); the
 *  renewal token can be cleared on its own. Test tries the form's values
 *  without saving. */
import { useEffect, useRef, useState } from 'react';

import ComboBox from '@portal/components/ComboBox';

import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import {
  deployErrorText, getDoRegions, saveDoAccount, testDoAccount,
  type DoAccount, type DoAccountBody, type IntegrationCheck,
} from '../../lib/sirdarApi';

const REGION_RE = /^[a-z]{3}[0-9]$/;
const TOKEN_RE = /^[!-~]{1,200}$/;
const DO_TOKEN_RE = /^dop_v1_[0-9a-fA-F]{64}$/;
const tokenOk = (t: string) => TOKEN_RE.test(t) && (!t.startsWith('dop_v1_') || DO_TOKEN_RE.test(t));
type Errors = Partial<Record<'label' | 'region' | 'token' | 'renewal' | 'form', string>>;

export default function DoAccountModal({ account, onSaved, onClose }: {
  account: DoAccount; onSaved: (accounts: DoAccount[]) => void; onClose: () => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [region, setRegion] = useState(account.region ?? '');
  const [regions, setRegions] = useState<{ value: string; label: string }[]>([]);
  const [tokenAction, setTokenAction] = useState<SecretAction>(account.token_set ? 'keep' : 'set');
  const [token, setToken] = useState('');
  const [renewAction, setRenewAction] = useState<SecretAction>(account.renewal_token_set ? 'keep' : 'set');
  const [renewal, setRenewal] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // A configured account can list its regions; before that the slug is typed.
  useEffect(() => {
    if (!account.configured) return undefined;
    let live = true;
    getDoRegions(account.key)
      .then((r) => { if (live) setRegions(r.regions.map((x) => ({ value: x.slug, label: `${x.name} (${x.slug})` }))); })
      .catch(() => { if (live) setRegions([]); });
    return () => { live = false; };
  }, [account.configured, account.key]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cardRef.current?.querySelector<HTMLElement>('.modal-body input')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const check = (): Errors => {
    const e: Errors = {};
    if (!label.trim() || label.trim().length > 40) e.label = 'Use a label of 1 to 40 characters.';
    if (region && !REGION_RE.test(region)) e.region = "That isn't a DigitalOcean region slug, like nyc3.";
    // Required only when nothing configures the account; otherwise checked once typed.
    if (tokenAction === 'set' && (token || !account.configured) && !tokenOk(token)) {
      e.token = token ? "That doesn't look like a DigitalOcean API token." : 'Enter the API token.';
    }
    if (renewAction === 'set' && renewal && !tokenOk(renewal)) e.renewal = "That doesn't look like a DigitalOcean token.";
    return e;
  };

  const body = (): DoAccountBody => ({
    label: label.trim(), region: region || null,
    ...(tokenAction === 'set' && token ? { token } : {}),
    ...(renewAction === 'set' && renewal ? { renewal_token: renewal } : {}),
    ...(renewAction === 'clear' ? { clear_renewal_token: true } : {}),
  });

  const run = async (what: 'test' | 'save') => {
    if (busyRef.current) return;
    const e = check();
    setErrors(e);
    if (Object.keys(e).length) return;
    busyRef.current = what;
    setBusy(what);
    setResult(null);
    try {
      if (what === 'test') setResult(await testDoAccount(account.key, body()));
      else onSaved((await saveDoAccount(account.key, body())).accounts);
    } catch (err) {
      setErrors({ form: deployErrorText(err, what === 'test' ? "Couldn't test this account." : "Couldn't save this account.") });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  };

  const name = `DigitalOcean · ${account.label}`;
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-doacct-card" role="dialog"
           aria-modal="true" aria-labelledby="sirdar-doacct-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-doacct-title">{name}</h3>
            <p className="page-hint">
              Sirdar builds environments in this account with its API token. Droplets get only the renewal token: make it
              in the control panel under API › Generate New Token › Custom Scopes, with certificate (create, read, delete)
              and load_balancer (read, update).
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-doacct-form">
          <div>
            <label className="field-label" htmlFor="doacct-label">Label</label>
            <input id="doacct-label" value={label} maxLength={40} aria-invalid={!!errors.label}
                   onChange={(e) => setLabel(e.target.value)} />
            {errors.label && <p className="form-error" role="alert">{errors.label}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="doacct-region">Region</label>
            {regions.length ? (
              <ComboBox inputId="doacct-region" ariaLabel="Region" portal value={region} options={regions}
                        onChange={setRegion} placeholder="Choose a region…" />
            ) : (
              <input id="doacct-region" value={region} placeholder="nyc3" aria-invalid={!!errors.region}
                     onChange={(e) => setRegion(e.target.value.trim().toLowerCase())} />
            )}
            <p className="page-hint">New environments in this account are built here.</p>
            {errors.region && <p className="form-error" role="alert">{errors.region}</p>}
          </div>
          <div className="sirdar-span2">
            <SecretField id="doacct-token" label="API token" isSet={account.token_set} adding={!account.token_set}
                         action={tokenAction} value={token} error={errors.token} clearable={false}
                         onAction={(a) => { setTokenAction(a); setToken(''); }} onValue={setToken} />
            {account.source === 'environment' && (
              <p className="page-hint">
                This account uses the token from the server environment. Leave this empty to keep using it.
              </p>
            )}
          </div>
          <div className="sirdar-span2">
            <SecretField id="doacct-renewal" label="Renewal token" isSet={account.renewal_token_set}
                         adding={!account.renewal_token_set} action={renewAction} value={renewal}
                         error={errors.renewal}
                         onAction={(a) => { setRenewAction(a); setRenewal(''); }} onValue={setRenewal} />
          </div>
          {result && <div className="sirdar-span2"><CheckList label={`${name} test`} checks={result.checks} /></div>}
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
