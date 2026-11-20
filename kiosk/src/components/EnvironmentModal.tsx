/** The laptop's environment chooser (Settings › This Kiosk › Change…):
 *  the environment password, then the list (the current one marked,
 *  Custom URL last), then a confirm that says what a switch clears. The
 *  edge checks every rule itself; this shows its answers. Unsent work
 *  comes back as `outbox_not_empty`, and the person waits for it or
 *  discards it (an admin must be signed in for that). After a switch the
 *  edge has already wiped itself and dropped the refresh cookie: this
 *  clears the browser the way Clear Setup does and reloads into sign-in.
 *  Same shell as Clear Setup: buttons in the footer, the destructive one
 *  last and never autofocused. */

import { useEffect, useState, type FormEvent } from 'react';

import {
  ApiError, getEdgeEnvironments, switchEnvironment, unlockEnvironment,
  type EdgeEnvironment, type EdgeEnvironmentEntry, type EnvironmentTarget,
} from '../lib/api';
import { clearForSwitch } from '../lib/factoryReset';
import { reloadToLogin } from './ClearSetupModal';

type Step = 'password' | 'list' | 'confirm' | 'custom';

const EDGE_UNREACHABLE = "Can't reach this laptop's edge service. Try again.";
const WRONG_PASSWORD = "That password isn't right.";

function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : 'network';
}

/** What a refused switch says. */
function switchErrorText(err: unknown): string {
  const code = codeOf(err);
  if (code === 'custom_needs_super_admin') {
    return 'Sign in as a developer, founder or super admin to use a custom URL.';
  }
  if (code === 'discard_needs_admin') return 'Sign in as an admin to discard unsent scans.';
  if (code === 'access_check_offline') return "Can't reach the server to check your access.";
  if (code === 'bad_url') return 'Enter an http or https address for both URLs.';
  if (code === 'unknown_environment') return 'That environment is no longer in the list. Pick another.';
  if (code === 'network') return EDGE_UNREACHABLE;
  return `Couldn't switch environment (${code}).`;
}

function pendingOf(err: ApiError): number {
  const pending = (err.detail as { pending?: unknown } | undefined)?.pending;
  return typeof pending === 'number' ? pending : 0;
}

function unsentText(n: number): string {
  return n === 1 ? "1 unsent scan hasn't been sent yet." : `${n} unsent scans haven't been sent yet.`;
}

export default function EnvironmentModal({ current, onClose, onDone = reloadToLogin }: {
  /** Where the laptop points now (GET /edge/environment). */
  current: EdgeEnvironment;
  onClose: () => void;
  /** Replaced in tests; the app reloads into the sign-in page. */
  onDone?: () => void;
}) {
  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [list, setList] = useState<EdgeEnvironmentEntry[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [chosen, setChosen] = useState<EdgeEnvironmentEntry | null>(null);
  const [customApi, setCustomApi] = useState(current.api_url);
  const [customPortal, setCustomPortal] = useState(current.portal_url);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadList = () => {
    setListFailed(false);
    return getEdgeEnvironments().then(
      (res) => setList(res.environments),
      () => setListFailed(true),
    );
  };

  // Asked while the password is typed: the edge may wait on a download.
  useEffect(() => {
    void loadList();
    // once per opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isCurrent = (env: EdgeEnvironmentEntry) =>
    current.kind === 'named' && current.id === env.id && current.domain === env.domain;

  const go = (next: Step) => {
    setStep(next);
    setPending(null);
    setError('');
  };

  const unlock = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    unlockEnvironment(password).then(
      () => { setBusy(false); go('list'); },
      (err: unknown) => {
        setBusy(false);
        setError(codeOf(err) === 'wrong_password' ? WRONG_PASSWORD : EDGE_UNREACHABLE);
      },
    );
  };

  const runSwitch = async (discard: boolean) => {
    const target: EnvironmentTarget | null = step === 'custom'
      ? { custom: { api_url: customApi.trim(), portal_url: customPortal.trim() } }
      : chosen && { id: chosen.id };
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      await switchEnvironment(discard ? { password, target, discard: true } : { password, target });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'outbox_not_empty') {
        setPending(pendingOf(err));
        return;
      }
      if (codeOf(err) === 'wrong_password') {
        setPassword('');
        go('password');
        setError(WRONG_PASSWORD);
        return;
      }
      if (codeOf(err) === 'unknown_environment') {
        go('list');
        void loadList();
      }
      setError(switchErrorText(err));
      return;
    }
    // The edge has switched and wiped: whatever this browser could not
    // clear, staying on the old server's screens would be worse.
    try { await clearForSwitch(); } catch { /* reload regardless */ }
    onDone();
  };

  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    if (pending === null) void runSwitch(false);
  };

  const targetName = step === 'custom' ? 'Custom' : chosen?.name ?? '';
  const customReady = customApi.trim() !== '' && customPortal.trim() !== '';
  const back = () => go('list');

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card env-card" role="dialog" aria-modal="true"
           aria-label="Change environment">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">This kiosk</div>
            <h3>Change environment</h3>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>

        <div className="modal-body">
          {step === 'password' && (
            <form id="env-password-form" className="pf-form env-form" onSubmit={unlock} noValidate>
              <div>
                <label htmlFor="env-password">Environment password</label>
                {/* "new-password": no "Save password?" offer on a shared station */}
                <input id="env-password" type="password" autoFocus autoComplete="new-password"
                       spellCheck={false} maxLength={64} value={password} readOnly={busy}
                       onChange={(e) => { setPassword(e.target.value); setError(''); }} />
              </div>
            </form>
          )}

          {step === 'list' && (
            <>
              {list === null && !listFailed && <p className="page-hint">Loading environments…</p>}
              {listFailed && <p className="page-hint">{EDGE_UNREACHABLE}</p>}
              <ul className="env-list">
                {(list ?? []).map((env) => {
                  const here = isCurrent(env);
                  return (
                    <li key={env.id}>
                      <button type="button" className="env-row" disabled={here}
                              aria-current={here ? 'true' : undefined}
                              onClick={() => { setChosen(env); go('confirm'); }}>
                        <span className="env-row-name">{env.name}</span>
                        {here && <span className="chip c-slate">Current</span>}
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button type="button" className="env-row"
                          aria-current={current.kind === 'custom' ? 'true' : undefined}
                          onClick={() => go('custom')}>
                    <span className="env-row-name">Custom URL…</span>
                    {current.kind === 'custom' && <span className="chip c-slate">Current</span>}
                  </button>
                </li>
              </ul>
            </>
          )}

          {step === 'custom' && (
            <form id="env-custom-form" className="pf-form env-form" onSubmit={submitCustom} noValidate>
              <div>
                <label htmlFor="env-api-url">API URL</label>
                <input id="env-api-url" className="mono" inputMode="url" autoFocus spellCheck={false}
                       autoCapitalize="off" value={customApi} readOnly={busy || pending !== null}
                       onChange={(e) => { setCustomApi(e.target.value); setError(''); }} />
              </div>
              <div>
                <label htmlFor="env-portal-url">Portal URL</label>
                <input id="env-portal-url" className="mono" inputMode="url" spellCheck={false}
                       autoCapitalize="off" value={customPortal} readOnly={busy || pending !== null}
                       onChange={(e) => { setCustomPortal(e.target.value); setError(''); }} />
              </div>
            </form>
          )}

          {(step === 'confirm' || step === 'custom') && (
            <p className="page-hint env-confirm">
              Switching to {targetName} signs this kiosk out and clears its setup and saved move data.
            </p>
          )}
          {pending !== null && (
            <div className="zp-notice error">
              <p className="page-hint"><b>{unsentText(pending)}</b></p>
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        <div className="modal-foot">
          {step === 'password' && (
            <>
              <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="submit" form="env-password-form" className="btn-solid" disabled={busy || !password}>
                Continue
              </button>
            </>
          )}
          {step === 'list' && (
            <button type="button" className="mini-btn" autoFocus onClick={onClose}>Cancel</button>
          )}
          {(step === 'confirm' || step === 'custom') && pending === null && (
            <>
              <button type="button" className="mini-btn" autoFocus={step === 'confirm'} disabled={busy}
                      onClick={back}>
                Cancel
              </button>
              <button type={step === 'custom' ? 'submit' : 'button'}
                      form={step === 'custom' ? 'env-custom-form' : undefined}
                      className="btn-solid btn-danger"
                      disabled={busy || (step === 'custom' && !customReady)}
                      onClick={step === 'custom' ? undefined : () => void runSwitch(false)}>
                {busy ? 'Switching…' : 'Switch'}
              </button>
            </>
          )}
          {(step === 'confirm' || step === 'custom') && pending !== null && (
            <>
              <button type="button" className="mini-btn" autoFocus disabled={busy} onClick={onClose}>
                Wait for them to send
              </button>
              <button type="button" className="btn-solid btn-danger" disabled={busy}
                      onClick={() => void runSwitch(true)}>
                {busy ? 'Switching…' : 'Discard and switch'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
