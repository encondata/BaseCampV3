/** Step 4: optional apps, hosting options and integrations. */
import { Switch } from '@portal/components/Switch';

import { arrowNav } from '../../../lib/arrowNav';
import { OPTIONAL_APPS, targetKind } from '../flowState';

import type { StepProps } from './EnvironmentStep';

function Toggle({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="sirdar-toggle-row">
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

function Field({ id, label, value, onChange, type = 'text', hint, inputMode, errorId }: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string;
  inputMode?: 'numeric';
  /** The id of the error this field shares, when there is one: marks it invalid and describes it. */
  errorId?: string;
}) {
  const described = [hint ? `${id}-hint` : '', errorId ?? ''].filter(Boolean).join(' ');
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} autoComplete={type === 'password' ? 'new-password' : 'off'}
             inputMode={inputMode} spellCheck={false} aria-invalid={errorId ? true : undefined}
             aria-describedby={described || undefined} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="page-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

function Segmented<T extends string | boolean>({ id, caption, value, options, onPick, locked }: {
  id: string; caption: string; value: T; options: readonly (readonly [T, string])[]; onPick: (v: T) => void;
  locked?: (v: T) => boolean;
}) {
  return (
    <>
      <span className="field-label" id={id}>{caption}</span>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map(([v, label]) => {
          const off = locked?.(v) ?? false;
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

export default function ExtrasStep({ state, set, errors, ctx }: StepProps) {
  const onDoTarget = targetKind(state.target) === 'digitalocean';
  const production = state.type === 'production';
  const bg = state.servers === 'bluegreen';
  const canPublish = !!(ctx.integrations?.cloudflare.configured && ctx.integrations?.npm.configured);
  const mailpitOff = !state.apps.mailpit;
  const setApp = (app: (typeof OPTIONAL_APPS)[number][0], v: boolean) => {
    const apps = { ...state.apps, [app]: v };
    // Without Mailpit, mail can only go out through SMTP.
    set(app === 'mailpit' && !v && state.mailMode === 'mailpit' ? { apps, mailMode: 'smtp' } : { apps });
  };
  const mailErr = errors.mail ? 'flow-mail-error' : undefined;
  return (
    <>
      <h3 className="sirdar-sub">Apps</h3>
      <p className="page-hint">API and Portal always run.</p>
      <div className="sirdar-flow-grid">
        {OPTIONAL_APPS.map(([app, label]) => (
          <Toggle key={app} label={label} checked={state.apps[app]} onChange={(v) => setApp(app, v)} />
        ))}
      </div>
      {errors.apps && <p className="form-error" id="flow-apps-error" role="alert">{errors.apps}</p>}

      <h3 className="sirdar-sub">Hosting</h3>
      {onDoTarget && (
        <div className="sirdar-flow-grid">
          <Toggle label="Standby node" checked={state.dbStandby} onChange={(v) => set({ dbStandby: v })} />
          {!production && (
            <div>
              <Segmented id="flow-cert-label" caption="Certificate" value={state.acmeStaging}
                         options={[[false, "Let's Encrypt"], [true, "Let's Encrypt staging"]] as const}
                         onPick={(v) => set({ acmeStaging: v })} />
              <p className="page-hint">Staging certificates aren't trusted by browsers: for test environments.</p>
            </div>
          )}
        </div>
      )}
      {bg && !production && (
        <>
          <Toggle label="Activate automatically" checked={state.autoActivate} onChange={(v) => set({ autoActivate: v })} />
          <p className="page-hint">On: a deploy whose smoke test passes takes traffic by itself.</p>
        </>
      )}
      {!onDoTarget && !(bg && !production) && <p className="page-hint">Nothing to set for this target.</p>}
      {errors.hosting && <p className="form-error" id="flow-hosting-error" role="alert">{errors.hosting}</p>}

      <h3 className="sirdar-sub">Integrations</h3>
      {onDoTarget ? (
        <p className="page-hint">DigitalOcean environments always publish their DNS records.</p>
      ) : (
        <>
          <Toggle label="Publish DNS" checked={state.publish && canPublish} disabled={!canPublish}
                  onChange={(v) => set({ publish: v })} />
          <p className="page-hint">
            {canPublish
              ? bg ? 'On: each deploy keeps a Cloudflare record for every public name. Sirdar manages the proxy hosts either way.'
                : 'On: each deploy keeps a Cloudflare record and a proxy host for every public name.'
              : 'Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish.'}
          </p>
          {errors.publish && <p className="form-error" id="flow-publish-error" role="alert">{errors.publish}</p>}
        </>
      )}
      <Segmented id="flow-mail-label" caption="Mail" value={state.mailMode}
                 options={[['mailpit', 'Mailpit'], ['smtp', 'SMTP']] as const}
                 locked={(m) => m === 'mailpit' && mailpitOff} onPick={(m) => set({ mailMode: m })} />
      <p className="page-hint">
        {mailpitOff ? 'Mailpit is off, so mail needs SMTP: enter your SMTP server below.'
          : state.mailMode === 'mailpit' ? 'Mailpit catches every email on the server; nothing is sent. Good for testing.'
          : 'Mail goes out through your SMTP server.'}
      </p>
      {state.mailMode === 'smtp' && (
        <>
          <div className="sirdar-flow-grid" role="group" aria-label="SMTP server">
            <Field id="flow-smtp-host" label="SMTP host" value={state.smtpHost} errorId={mailErr} onChange={(v) => set({ smtpHost: v })} />
            <Field id="flow-smtp-port" label="SMTP port" value={state.smtpPort} inputMode="numeric" errorId={mailErr}
                   onChange={(v) => set({ smtpPort: v })} />
            <Toggle label="STARTTLS" checked={state.smtpStarttls} onChange={(v) => set({ smtpStarttls: v })} />
          </div>
          <div className="sirdar-flow-grid">
            <Field id="flow-smtp-user" label="User name" value={state.smtpUsername} errorId={mailErr} onChange={(v) => set({ smtpUsername: v })} />
            <Field id="flow-smtp-password" label="SMTP password" type="password" value={state.smtpPassword} errorId={mailErr}
                   onChange={(v) => set({ smtpPassword: v })} hint="Saved encrypted; never shown again." />
            <Field id="flow-smtp-from" label="From address" value={state.smtpFrom} errorId={mailErr} onChange={(v) => set({ smtpFrom: v })} />
          </div>
        </>
      )}
      {errors.mail && <p className="form-error" id="flow-mail-error" role="alert">{errors.mail}</p>}
      <Field id="flow-ai-key" label="Anthropic API key" type="password" value={state.aiKey}
             errorId={errors.aiKey ? 'flow-ai-key-error' : undefined} onChange={(v) => set({ aiKey: v })}
             hint="For the Makes / Models spec lookup. Optional. Saved encrypted; never shown again." />
      {errors.aiKey && <p className="form-error" id="flow-ai-key-error" role="alert">{errors.aiKey}</p>}
    </>
  );
}
