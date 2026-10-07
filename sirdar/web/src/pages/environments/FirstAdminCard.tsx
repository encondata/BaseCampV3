/** The Settings tab's First admin card: the super admin step 11 of the first
 *  deploy creates, shown until it has. When the environment refused the typed
 *  password (or the email), Change sets a new one, or an invite instead,
 *  and the deploy is retried from step 11. */
import { useEffect, useRef, useState, type Ref } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { arrowNav } from '../../lib/arrowNav';
import { deployErrorText, setFirstAdmin, type Environment, type NewFirstAdmin } from '../../lib/sirdarApi';

type Mode = NewFirstAdmin['password_mode'];
type Field = 'first' | 'last' | 'email' | 'password' | 'confirm' | 'form';
type Errors = Partial<Record<Field, string>>;

const MODES: [Mode, string][] = [['typed', 'Typed'], ['invite', 'Invite']];
const MODE_LABEL: Record<Mode, string> = { typed: 'Typed', invite: 'Invite' };
const NAME_HELP = 'Enter a first and last name (up to 100 characters each).';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** API error code → field. first_admin_done, deploy_in_progress and the rest show under the form. */
const CODE_FIELD: Record<string, Field> = {
  first_admin_name_invalid: 'first', first_admin_email_invalid: 'email',
  first_admin_password_too_short: 'password', first_admin_password_invalid: 'password',
  first_admin_password_not_allowed: 'password',
};
const only = (e: Errors): Errors => Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Errors;

export default function FirstAdminCard({ env, disabled, minLength, onSaved }: {
  env: Environment; disabled: boolean;
  /** ServerSherpa's password minimum (the environment defaults); unknown until they load. */
  minLength?: number;
  onSaved: (env: Environment) => void;
}) {
  const { can } = useAuth();
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState('');
  const fa = env.first_admin;
  if (!fa) return null;

  return (
    <div className="sirdar-card sirdar-firstadmin" role="group" aria-label="First admin">
      <div className="sirdar-card-head">
        <h3>First admin</h3>
        <span className="chip c-amber">Not created yet</span>
      </div>
      <p className="page-hint">
        Step 11 of the first deploy creates this super admin. If the environment refused the password or the email,
        change it here, then retry the deployment from step 11.
      </p>
      <dl className="sirdar-kv">
        <dt>Name</dt><dd>{`${fa.first_name} ${fa.last_name}`}</dd>
        <dt>Email</dt><dd className="mono">{fa.email}</dd>
        <dt>Password</dt><dd>{MODE_LABEL[fa.password_mode]}</dd>
      </dl>
      {notice && <p className="page-hint" role="status">{notice}</p>}
      {can('deploy', 'change') && (
        <div className="sirdar-actions">
          <button type="button" className="mini-btn" disabled={disabled}
                  title={disabled ? 'A deployment is running.' : undefined}
                  onClick={() => { setNotice(''); setChanging(true); }}>Change…</button>
        </div>
      )}
      {changing && (
        <FirstAdminModal env={env} minLength={minLength} onClose={() => setChanging(false)}
                         onSaved={(saved) => {
                           setChanging(false);
                           setNotice('Saved. Retry the deployment from step 11 to create the first admin.');
                           onSaved(saved);
                         }} />
      )}
    </div>
  );
}

function FirstAdminModal({ env, minLength, onSaved, onClose }: {
  env: Environment; minLength?: number; onSaved: (env: Environment) => void; onClose: () => void;
}) {
  const fa = env.first_admin!;
  const [first, setFirst] = useState(fa.first_name);
  const [last, setLast] = useState(fa.last_name);
  const [email, setEmail] = useState(fa.email);
  const [mode, setMode] = useState<Mode>(fa.password_mode);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
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

  const name = (v: string) => (v.trim() && v.trim().length <= 100 ? '' : NAME_HELP);
  const check = (): Errors => only({
    first: name(first),
    last: name(last),
    email: EMAIL_RE.test(email.trim()) ? '' : 'Enter a valid email address for the first admin.',
    password: mode !== 'typed' ? ''
      : !password.trim() ? 'Enter a password.'
      : minLength && password.length < minLength ? `Use at least ${minLength} characters.` : '',
    confirm: mode === 'typed' && password && confirm !== password ? "The passwords don't match." : '',
  });

  const save = async () => {
    if (busyRef.current) return;
    const e = check();
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: NewFirstAdmin = {
      first_name: first.trim(), last_name: last.trim(), email: email.trim(), password_mode: mode,
      ...(mode === 'typed' ? { password } : {}),
    };
    busyRef.current = true;
    setBusy(true);
    try {
      onSaved(await setFirstAdmin(env.name, body));
    } catch (err) {
      const field = CODE_FIELD[(err as { code?: string }).code ?? ''] ?? 'form';
      setErrors({ [field]: deployErrorText(err, "Couldn't change the first admin.") });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const field = (id: string, label: string, key: Field, value: string, set: (v: string) => void,
                 opts: { type?: string; ref?: Ref<HTMLInputElement>; autoComplete?: string; span?: boolean } = {}) => (
    <div className={opts.span ? 'sirdar-span2' : undefined}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} ref={opts.ref} type={opts.type ?? 'text'} value={value} autoComplete={opts.autoComplete ?? 'off'}
             spellCheck={false} disabled={busy} aria-invalid={!!errors[key]}
             aria-describedby={errors[key] ? `${id}-error` : undefined}
             onChange={(e) => { set(e.target.value); }} />
      {errors[key] && <p id={`${id}-error`} className="form-error" role="alert">{errors[key]}</p>}
    </div>
  );

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-firstadmin-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-firstadmin-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Settings</div>
            <h3 id="sirdar-firstadmin-title">Change the first admin</h3>
            <p className="page-hint">
              The super admin step 11 creates in {env.name}. Set a new password, or send an invite with a set-password
              link instead. Then retry the deployment from step 11.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form">
          <div className="sirdar-env-grid">
            {field('fa-first', 'First name', 'first', first, setFirst, { ref: firstRef })}
            {field('fa-last', 'Last name', 'last', last, setLast)}
            {field('fa-email', 'Email', 'email', email, setEmail, { type: 'email', span: true })}
            <div className="sirdar-span2">
              <span className="field-label" id="fa-mode-label">First sign-in</span>
              <div className="segmented" role="radiogroup" aria-labelledby="fa-mode-label">
                {MODES.map(([m, label]) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''}
                          tabIndex={mode === m ? 0 : -1} disabled={busy} onKeyDown={arrowNav}
                          onClick={() => { setMode(m); setErrors({}); }}>{label}</button>
                ))}
              </div>
              <p className="page-hint">
                {mode === 'typed'
                  ? `They sign in with this password${minLength ? ` (at least ${minLength} characters)` : ''}.`
                  : 'Step 11 emails them a link to set their own password.'}
              </p>
            </div>
            {mode === 'typed' && (
              <>
                {field('fa-password', 'Password', 'password', password, setPassword,
                       { type: 'password', autoComplete: 'new-password' })}
                {field('fa-confirm', 'Confirm password', 'confirm', confirm, setConfirm,
                       { type: 'password', autoComplete: 'new-password' })}
              </>
            )}
          </div>
          {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
