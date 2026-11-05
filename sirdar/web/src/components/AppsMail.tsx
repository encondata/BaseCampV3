/** The optional apps, mail and kiosk signing digests: the Deploy flow's Extras
 *  step and an environment's Settings › Apps & mail share these controls
 *  (lib/appRules.ts holds the rules). */
import { Switch } from '@portal/components/Switch';

import { arrowNav } from '../lib/arrowNav';
import { OPTIONAL_APPS, switchApp, type AppsMailForm } from '../lib/appRules';

export function Toggle({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="sirdar-toggle-row">
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

export function Field({ id, label, value, onChange, type = 'text', hint, inputMode, errorId, disabled }: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string;
  inputMode?: 'numeric';
  /** The id of the error this field shares, when there is one: marks it invalid and describes it. */
  errorId?: string;
  disabled?: boolean;
}) {
  const described = [hint ? `${id}-hint` : '', errorId ?? ''].filter(Boolean).join(' ');
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} autoComplete={type === 'password' ? 'new-password' : 'off'}
             inputMode={inputMode} spellCheck={false} disabled={disabled} aria-invalid={errorId ? true : undefined}
             aria-describedby={described || undefined} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

export function Segmented<T extends string | boolean>({ id, caption, value, options, onPick, locked, disabled }: {
  id: string; caption: string; value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void;
  locked?: (v: T) => boolean; disabled?: boolean;
}) {
  return (
    <>
      <span className="field-label" id={id}>{caption}</span>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map(([v, label]) => {
          const off = disabled || (locked?.(v) ?? false);
          return (
            <button key={label} type="button" role="radio" aria-checked={value === v} aria-disabled={off || undefined}
                    className={value === v ? 'on' : ''} tabIndex={value === v ? 0 : -1} onKeyDown={arrowNav}
                    onClick={() => { if (!off) onPick(v); }}>{label}</button>
          );
        })}
      </div>
    </>
  );
}

type Change = (patch: Partial<AppsMailForm>) => void;

export function AppToggles({ form, onChange, error, errorId, disabled }: {
  form: Pick<AppsMailForm, 'apps' | 'mailMode'>; onChange: Change; error?: string; errorId: string; disabled?: boolean;
}) {
  return (
    <>
      <p className="page-hint">API and Portal always run.</p>
      <div className="sirdar-flow-grid">
        {OPTIONAL_APPS.map(([app, label]) => (
          <Toggle key={app} label={label} checked={form.apps[app]} disabled={disabled || (app === 'learn' && !form.apps.wiki)}
                  onChange={(v) => onChange(switchApp(form, app, v))} />
        ))}
      </div>
      {!form.apps.wiki && <p className="page-hint">The learning site needs the wiki, so it is off while the wiki is.</p>}
      {error && <p className="form-error" id={errorId} role="alert">{error}</p>}
    </>
  );
}

export function DigestsField({ id, value, onChange, error, disabled }: {
  id: string; value: string; onChange: (v: string) => void; error?: string; disabled?: boolean;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>Kiosk signing digests</label>
      <textarea id={id} rows={3} value={value} spellCheck={false} disabled={disabled}
                aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint`}
                onChange={(e) => onChange(e.target.value)} />
      <p className="page-hint" id={`${id}-hint`}>
        SHA-256 digests of the kiosk app's signing certificates (release and Play), one per line. Kiosk biometric
        sign-in enrolls only apps signed with these.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

export function MailFields({ idPrefix, form, onChange, error, disabled, showPassword }: {
  idPrefix: string; form: AppsMailForm; onChange: Change; error?: string; disabled?: boolean;
  /** The Deploy flow types the SMTP password here; Settings keeps it under Secrets. */
  showPassword: boolean;
}) {
  const mailpitOff = !form.apps.mailpit;
  const errId = error ? `${idPrefix}-mail-error` : undefined;
  return (
    <>
      <Segmented id={`${idPrefix}-mail-label`} caption="Mail" value={form.mailMode} disabled={disabled}
                 options={[['mailpit', 'Mailpit'], ['smtp', 'SMTP']] as const}
                 locked={(m) => m === 'mailpit' && mailpitOff} onPick={(m) => onChange({ mailMode: m })} />
      <p className="page-hint">
        {mailpitOff ? 'Mailpit is off, so mail needs SMTP: enter your SMTP server below.'
          : form.mailMode === 'mailpit' ? 'Mailpit catches every email on the server; nothing is sent. Good for testing.'
          : 'Mail goes out through your SMTP server.'}
      </p>
      {form.mailMode === 'smtp' && (
        <>
          <div className="sirdar-flow-grid" role="group" aria-label="SMTP server">
            <Field id={`${idPrefix}-smtp-host`} label="SMTP host" value={form.smtpHost} errorId={errId} disabled={disabled}
                   onChange={(v) => onChange({ smtpHost: v })} />
            <Field id={`${idPrefix}-smtp-port`} label="SMTP port" value={form.smtpPort} inputMode="numeric" errorId={errId}
                   disabled={disabled} onChange={(v) => onChange({ smtpPort: v })} />
            <Toggle label="STARTTLS" checked={form.smtpStarttls} disabled={disabled} onChange={(v) => onChange({ smtpStarttls: v })} />
          </div>
          <div className="sirdar-flow-grid">
            <Field id={`${idPrefix}-smtp-user`} label="User name" value={form.smtpUsername} errorId={errId} disabled={disabled}
                   onChange={(v) => onChange({ smtpUsername: v })} />
            {showPassword && (
              <Field id={`${idPrefix}-smtp-password`} label="SMTP password" type="password" value={form.smtpPassword}
                     errorId={errId} disabled={disabled} onChange={(v) => onChange({ smtpPassword: v })}
                     hint="Saved encrypted; never shown again." />
            )}
            <Field id={`${idPrefix}-smtp-from`} label="From address" value={form.smtpFrom} errorId={errId} disabled={disabled}
                   onChange={(v) => onChange({ smtpFrom: v })} />
          </div>
          {!showPassword && <p className="page-hint">The SMTP password is under Secrets once SMTP is saved.</p>}
        </>
      )}
      {error && <p className="form-error" id={`${idPrefix}-mail-error`} role="alert">{error}</p>}
    </>
  );
}
