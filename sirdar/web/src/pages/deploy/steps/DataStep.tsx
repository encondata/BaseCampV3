/** Step 6: seed from a snapshot, or start empty with a first super admin. */
import ComboBox from '@portal/components/ComboBox';

import { arrowNav } from '../../../lib/arrowNav';
import { snapshotLabel } from '../../environments/labels';
import type { FlowState } from '../flowState';

import type { StepProps } from './EnvironmentStep';

const hours = (minutes: number) => (minutes % 60 === 0
  ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minutes`);

type AdminKey = 'adminFirst' | 'adminLast' | 'adminEmail' | 'adminPassword' | 'adminConfirm';

export default function DataStep({ state, set, errors, ctx }: StepProps) {
  const fa = ctx.defaults.first_admin;
  const none = ctx.snapshots.length === 0;
  const production = state.type === 'production';
  const input = (id: string, label: string, key: AdminKey, type = 'text', errorId?: string) => (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <input id={id} type={type} value={state[key]} autoComplete={type === 'password' ? 'new-password' : 'off'}
             spellCheck={false} aria-invalid={errorId ? true : undefined} aria-describedby={errorId}
             onChange={(e) => set({ [key]: e.target.value } as Partial<FlowState>)} />
    </div>
  );
  const nameErr = errors.adminName ? 'flow-admin-name-error' : undefined;
  const emailErr = errors.adminEmail ? 'flow-admin-email-error' : undefined;
  const pwErr = errors.adminPassword ? 'flow-admin-password-error' : undefined;
  const dataError = errors.data && <p className="form-error sirdar-span2" role="alert">{errors.data}</p>;
  return (
    <div className="sirdar-flow-grid">
      <div className="sirdar-span2">
        <span className="field-label" id="flow-data-label">Data</span>
        <div className="segmented" role="radiogroup" aria-labelledby="flow-data-label">
          {([['empty', 'Start empty'], ['snapshot', 'From a snapshot']] as const).map(([m, label]) => {
            const locked = m === 'snapshot' && none;
            return (
              <button key={m} type="button" role="radio" aria-checked={state.dataMode === m} aria-disabled={locked || undefined}
                      className={state.dataMode === m ? 'on' : ''} tabIndex={state.dataMode === m ? 0 : -1} onKeyDown={arrowNav}
                      onClick={() => { if (!locked) set({ dataMode: m }); }}>{label}</button>
            );
          })}
        </div>
        {none && <p className="page-hint">No snapshot yet. Upload one or take one in Snapshots below.</p>}
      </div>
      {state.dataMode === 'snapshot' ? (
        <div className="sirdar-span2">
          <label className="field-label" htmlFor="flow-snapshot">Snapshot</label>
          <ComboBox inputId="flow-snapshot" ariaLabel="Snapshot" portal value={state.snapshotId} placeholder="Choose a snapshot…"
                    options={ctx.snapshots.map((s) => ({ value: s.id, label: snapshotLabel(s) }))}
                    onChange={(v) => set({ snapshotId: v })} />
          <p className="page-hint">The first deploy restores its database and files. Its users sign in with their own passwords and 2FA.</p>
          {errors.data && <p className="form-error" role="alert">{errors.data}</p>}
        </div>
      ) : (
        <>
          <p className="page-hint sirdar-span2">The first deploy creates this person as the environment's first super admin.</p>
          {production && (
            <p className="page-hint sirdar-span2">
              On production the first admin's email goes out through SMTP (Extras › Mail), so it never sits in Mailpit on the server.
            </p>
          )}
          {dataError}
          {input('flow-admin-first', 'First name', 'adminFirst', 'text', nameErr)}
          {input('flow-admin-last', 'Last name', 'adminLast', 'text', nameErr)}
          {errors.adminName && <p className="form-error sirdar-span2" id="flow-admin-name-error" role="alert">{errors.adminName}</p>}
          <div className="sirdar-span2">
            {input('flow-admin-email', 'Email', 'adminEmail', 'text', emailErr)}
            {errors.adminEmail && <p className="form-error" id="flow-admin-email-error" role="alert">{errors.adminEmail}</p>}
          </div>
          <div className="sirdar-span2">
            <span className="field-label" id="flow-admin-pw-label">Their password</span>
            <div className="segmented" role="radiogroup" aria-labelledby="flow-admin-pw-label">
              {([['typed', 'Type a password'], ['invite', 'Generate & invite']] as const).map(([m, label]) => (
                <button key={m} type="button" role="radio" aria-checked={state.adminPasswordMode === m}
                        className={state.adminPasswordMode === m ? 'on' : ''} tabIndex={state.adminPasswordMode === m ? 0 : -1}
                        onKeyDown={arrowNav} onClick={() => set({ adminPasswordMode: m })}>{label}</button>
              ))}
            </div>
          </div>
          {state.adminPasswordMode === 'typed' ? (
            <>
              {input('flow-admin-password', 'Password', 'adminPassword', 'password', pwErr)}
              {input('flow-admin-confirm', 'Type it again', 'adminConfirm', 'password', pwErr)}
              <p className="page-hint sirdar-span2">
                At least {fa.password_min_length} characters (ServerSherpa's password policy). They get an email with a link to
                change it, valid {hours(fa.link_minutes)}. The password is never emailed.
              </p>
            </>
          ) : (
            <p className="page-hint sirdar-span2">
              Sirdar sends {state.adminEmail.trim() || 'them'} a link to set their password, valid {hours(fa.link_minutes)}.
              No password is ever emailed.
            </p>
          )}
          {errors.adminPassword && <p className="form-error sirdar-span2" id="flow-admin-password-error" role="alert">{errors.adminPassword}</p>}
        </>
      )}
    </div>
  );
}
