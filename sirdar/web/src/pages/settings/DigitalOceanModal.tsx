/** Set up or replace the DigitalOcean API token the Deploy page and the
 *  dashboard read with. The token is write-only: kept unless replaced, never
 *  shown. Without a stored token Sirdar uses SIRDAR_DEPLOY_DO_TOKEN from the
 *  server environment, when it is set. Test tries the token in the form
 *  without saving it (or, with none entered, the token Sirdar uses). */
import { useEffect, useRef, useState } from 'react';

import { ApiError } from '@portal/lib/api';

import CheckList from '../../components/CheckList';
import SecretField, { type SecretAction } from '../../components/SecretField';
import {
  deployErrorText, errorText, saveIntegration, testIntegration,
  type DigitalOceanBody, type IntegrationCheck, type Integrations,
} from '../../lib/sirdarApi';

/** The API's shape rule: dop_v1_ and 64 hex digits, or any other printable
 *  token without spaces, up to 200 characters. */
const DO_TOKEN_RE = /^dop_v1_[0-9a-fA-F]{64}$/;
const PRINTABLE_RE = /^[!-~]{1,200}$/;
const TOKEN_FIELD_CODES = new Set(['do_token_invalid', 'secret_required']);

function tokenProblem(token: string): string {
  if (!token) return 'Enter the API token.';
  if (!PRINTABLE_RE.test(token) || (token.startsWith('dop_v1_') && !DO_TOKEN_RE.test(token))) {
    // The same copy the API's do_token_invalid gets.
    return errorText(new ApiError(422, 'do_token_invalid', { code: 'do_token_invalid' }),
      "That doesn't look like a DigitalOcean API token.");
  }
  return '';
}

export default function DigitalOceanModal({ current, onSaved, onClose }: {
  current: Integrations; onSaved: (saved: Integrations) => void; onClose: () => void;
}) {
  const d = current.digitalocean;
  const [action, setAction] = useState<SecretAction>(d.token_set ? 'keep' : 'set');
  const [secret, setSecret] = useState('');
  const [errors, setErrors] = useState<{ secret?: string; form?: string }>({});
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Bumped by every edit: a Test result (or one still out) for an older token is dropped.
  const edits = useRef(0);
  const edited = <T,>(set: (v: T) => void) => (v: T) => { edits.current += 1; setResult(null); set(v); };
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = cardRef.current?.querySelector<HTMLElement>('.modal-body input, .modal-body button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const body = (): DigitalOceanBody => (action === 'set' ? { token: secret } : {});

  const run = async (what: 'test' | 'save') => {
    if (busyRef.current) return;
    const problem = action === 'set' ? tokenProblem(secret) : '';
    setErrors(problem ? { secret: problem } : {});
    if (problem) return;
    busyRef.current = what;
    setBusy(what);
    setResult(null);
    const at = edits.current;
    try {
      if (what === 'test') {
        const checked = await testIntegration('digitalocean', body());
        if (at === edits.current) setResult(checked);
      } else {
        onSaved(await saveIntegration('digitalocean', body()));
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      const text = deployErrorText(err,
        what === 'test' ? "Couldn't test this token." : "Couldn't save this token.");
      setErrors(TOKEN_FIELD_CODES.has(code) ? { secret: text } : { form: text });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-do-card" role="dialog"
           aria-modal="true" aria-labelledby="sirdar-do-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Integrations</div>
            <h3 id="sirdar-do-title">DigitalOcean</h3>
            <p className="page-hint">
              The Deploy page tests and lists regions with this token, and the dashboard reads droplets, databases and
              load balancers with it. A read-only personal access token is enough.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={!!busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-do-form">
          {d.source === 'environment' && (
            <p className="page-hint">
              Sirdar uses the token from the server environment (<code>SIRDAR_DEPLOY_DO_TOKEN</code>) until you save
              one here.
            </p>
          )}
          <SecretField id="do-token" label="API token" isSet={d.token_set} adding={!d.token_set}
                       action={action} value={secret} error={errors.secret} clearable={false}
                       onAction={edited((a: SecretAction) => { setAction(a); setSecret(''); })}
                       onValue={edited(setSecret)} />
          {result && <CheckList label="DigitalOcean test" checks={result.checks} />}
          {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
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
