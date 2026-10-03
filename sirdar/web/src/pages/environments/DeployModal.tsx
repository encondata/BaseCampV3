/** Deploy an environment: a git ref and Update (default) or Reset data
 *  (needs deploy:change and the typed environment name). Opened from the
 *  environment page and from the Dashboard. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { arrowNav } from '../../lib/arrowNav';
import { refProblem } from '../../lib/envRules';
import {
  deployErrorText, startDeployment, type DeployMode, type Deployment, type Environment,
} from '../../lib/sirdarApi';

type Field = 'ref' | 'confirm' | 'form';
type Attempt = { mode: DeployMode; ref: string; confirm: string };
const MODES: [DeployMode, string, string][] = [
  ['update', 'Update', 'Keeps the data. Once the environment has been deployed, a database dump is taken first.'],
  ['reset', 'Reset data', "Deletes this environment's database and files, then starts it empty. This can't be undone."],
];
const CODE_FIELD: Record<string, Field> = { ref_invalid: 'ref', ref_not_found: 'ref', confirm_name_mismatch: 'confirm' };

export default function DeployModal({ env, onStarted, onClose }: {
  env: Environment; onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const canAdd = can('deploy', 'add');
  const canChange = can('deploy', 'change');
  const [ref, setRef] = useState(env.git_ref);
  const [mode, setMode] = useState<DeployMode>('update');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const refInput = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: canChange, trustLabel: 'Trust and deploy',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: (message) => setErrors({ form: message }),
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;
  // The form is inert while the host-key modal is open (a layout effect, so inert is
  // lifted before HostKeyModal's cleanup hands focus back). @types/react 18 has no `inert` prop.
  const scrimRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scrimRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  // After a failed start, focus goes back to the Git ref once nothing else holds it:
  // not while the host-key prompt is open (its cleanup refocuses its opener first,
  // and this effect runs after that cleanup), and not while a replay is starting.
  const refocus = useRef(false);
  useEffect(() => {
    if (refocus.current && !hostKey.open && !busy) { refocus.current = false; refInput.current?.focus(); }
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    refInput.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const reset = mode === 'reset';
  const ready = canAdd && !busy && (!reset || (canChange && confirm === env.name));

  // Replays exactly the attempt that hit the host-key prompt, whatever the form says now.
  const run = async (attempt: Attempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    refocus.current = false;
    setBusy(true);
    setErrors({});
    try {
      onStarted(await startDeployment(env.name, attempt.mode === 'reset'
        ? { mode: attempt.mode, git_ref: attempt.ref, confirm_name: attempt.confirm }
        : { mode: attempt.mode, git_ref: attempt.ref }));
    } catch (err) {
      refocus.current = true;
      if (!hostKey.handle(err, env.target, attempt)) {
        const code = (err as { code?: string }).code ?? '';
        setErrors({ [CODE_FIELD[code] ?? 'form']: deployErrorText(err, "Couldn't start the deployment.") });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = () => {
    if (busyRef.current) return;
    const problem = refProblem(ref);
    if (problem) { setErrors({ ref: problem }); return; }
    if (reset && confirm !== env.name) { setErrors({ confirm: `Type ${env.name} to confirm.` }); return; }
    void run({ mode, ref: ref.trim(), confirm });
  };

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-deploy-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Deploy</div>
              <h3 id="sirdar-deploy-title">Deploy {env.name}</h3>
              <p className="page-hint">
                Runs in {env.env_dir} on the target. You can follow each step's log while it runs.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-deploy-form">
            <div>
              <label className="field-label" htmlFor="deploy-ref">Git ref</label>
              <input id="deploy-ref" ref={refInput} type="text" value={ref} maxLength={200} autoComplete="off"
                     spellCheck={false} aria-invalid={!!errors.ref} onChange={(e) => setRef(e.target.value)} />
              <p className="page-hint">A branch, tag or full commit SHA. The target resolves it to a commit before anything runs.</p>
              {errors.ref && <p className="form-error" role="alert">{errors.ref}</p>}
            </div>
            <div>
              <span className="field-label" id="deploy-mode-label">Mode</span>
              <div className="segmented" role="radiogroup" aria-labelledby="deploy-mode-label">
                {MODES.map(([m, label]) => {
                  const locked = m === 'reset' && !canChange;
                  return (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} aria-disabled={locked}
                            className={mode === m ? 'on' : ''} tabIndex={mode === m ? 0 : -1} onKeyDown={arrowNav}
                            onClick={() => { if (!locked) { setMode(m); setErrors({}); } }}>{label}</button>
                  );
                })}
              </div>
              <p className="page-hint">{MODES.find(([m]) => m === mode)?.[2]}</p>
              {!canChange && <p className="page-hint">Reset data needs permission to change deployments.</p>}
            </div>
            {reset && (
              <div>
                <label className="field-label" htmlFor="deploy-confirm">Type {env.name} to confirm</label>
                <input id="deploy-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                       spellCheck={false} aria-invalid={!!errors.confirm} onChange={(e) => setConfirm(e.target.value)} />
                {errors.confirm && <p className="form-error" role="alert">{errors.confirm}</p>}
              </div>
            )}
            {!canAdd && <p className="page-hint">You can view deployments but not start them.</p>}
            {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid" disabled={!ready} onClick={submit}>
              {busy ? 'Starting…' : reset ? 'Reset and deploy' : 'Deploy'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
