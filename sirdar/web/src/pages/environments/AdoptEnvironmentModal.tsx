/** Adopt an environment (Basics › Result): reads a hand-built environment's
 *  .env and git checkout over SSH and changes nothing. New environments are
 *  made by the Deploy flow above the Environments list. */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { arrowNav } from '../../lib/arrowNav';
import { NAME_HELP, nameProblem, refProblem } from '../../lib/envRules';
import {
  adoptEnvironment, deployErrorText, getDeployTargets,
  type AdoptEnvironmentBody, type AdoptedEnvironment, type DeployTarget, type EnvType, type Environment,
} from '../../lib/sirdarApi';

import { TYPE_LABEL, sshTargets } from './labels';

type Step = 'basics' | 'result';
type Field = 'name' | 'target' | 'ref' | 'form';
type Errors = Partial<Record<Field, string>>;

const TYPES: EnvType[] = ['dev', 'beta', 'custom'];
const STEPS: [Step, string][] = [['basics', 'Basics'], ['result', 'Result']];
/** API error code → the field it belongs to. */
const CODE_FIELD: Record<string, Field> = {
  name_invalid: 'name', name_reserved: 'name', environment_exists: 'name',
  target_invalid: 'target', target_not_configured: 'target', adopt_not_allowed: 'target',
  ref_invalid: 'ref', ref_not_found: 'ref', ref_lookup_failed: 'ref',
};
const only = (e: Errors): Errors => Object.fromEntries(Object.entries(e).filter(([, v]) => v)) as Errors;

export default function AdoptEnvironmentModal({ onAdopted, onClose }: {
  onAdopted: (env: Environment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [targets, setTargets] = useState<DeployTarget[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [step, setStep] = useState<Step>('basics');
  const [name, setName] = useState('');
  const [type, setType] = useState<EnvType>('dev');
  const [target, setTarget] = useState('');
  const [ref, setRef] = useState('main');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AdoptedEnvironment | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const nameRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust<AdoptEnvironmentBody>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and adopt',
    onTrusted: (body) => { void run(body); }, onProblem: (message) => setErrors({ form: message }),
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;
  // The form is inert while the host-key modal is open. A layout effect, so inert is
  // lifted before HostKeyModal's passive cleanup hands focus back to its opener.
  // (@types/react 18 has no `inert` prop, hence the attribute.)
  const scrimRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scrimRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let live = true;
    // Adopt reads a hand-built environment over SSH: VM and DigitalOcean environments are only ones Sirdar builds.
    getDeployTargets().then((t) => {
      if (!live) return;
      const ssh = sshTargets(t.targets);
      setTargets(ssh);
      setTarget((cur) => cur || ssh[0]?.id || '');
    }).catch((e) => { if (live) setLoadError(deployErrorText(e, "Couldn't load the targets.")); });
    return () => { live = false; };
  }, []);
  const loaded = targets !== null;
  useEffect(() => { if (loaded) nameRef.current?.focus(); }, [loaded]);
  // After a failed adopt, focus goes back to the Name once nothing else holds it:
  // not while the host-key prompt is open (its cleanup refocuses its opener first,
  // and this effect runs after that cleanup), and not while a replay is running.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || hostKey.open || busy) return;
    refocus.current = false;
    nameRef.current?.focus();
  });

  const trimmed = name.trim();
  const basicsErrors = (): Errors => only({
    name: trimmed ? nameProblem(trimmed) : 'Enter a name.',
    target: target ? '' : 'Choose a target.',
    ref: refProblem(ref),
  });

  // Replays exactly the body that hit the host-key prompt.
  const run = async (body: AdoptEnvironmentBody) => {
    if (busyRef.current) return;
    busyRef.current = true;
    refocus.current = false;
    setBusy(true);
    setErrors({});
    try {
      setResult(await adoptEnvironment(body));
      setStep('result');
    } catch (err) {
      refocus.current = true;
      if (!hostKey.handle(err, body.target, body)) {
        const field = CODE_FIELD[(err as { code?: string }).code ?? ''] ?? 'form';
        setErrors({ [field]: deployErrorText(err, "Couldn't adopt the environment.") });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = () => {
    if (busyRef.current) return;
    const e = basicsErrors();
    setErrors(e);
    if (Object.keys(e).length) return;
    void run({ name: trimmed, type, target, git_ref: ref.trim() });
  };

  const at = STEPS.findIndex(([s]) => s === step);

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-adopt-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-adopt-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Deploy</div>
              <h3 id="sirdar-adopt-title">Adopt an environment</h3>
              <p className="page-hint">
                Adopt an environment set up by hand. Sirdar reads its .env and git checkout over SSH and changes nothing.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="rgm-steps">
            {STEPS.map(([s, label], i) => (
              <Fragment key={s}>
                {i > 0 && <span className="rgm-step-sep" />}
                <span className={`rgm-step${i === at ? ' on' : ''}${i < at ? ' done' : ''}`}>
                  <span className="rgm-step-num">{i + 1}</span>
                  <span className="rgm-step-label">{label}</span>
                </span>
              </Fragment>
            ))}
          </div>

          <div className="modal-body pf-form">
            {loadError && <p className="form-error" role="alert">{loadError}</p>}
            {!loaded && !loadError && <p className="page-hint">Loading…</p>}

            {loaded && step === 'basics' && (
              <div className="sirdar-env-grid">
                <div>
                  <label className="field-label" htmlFor="env-adopt-name">Name</label>
                  <input id="env-adopt-name" ref={nameRef} type="text" value={name} maxLength={64} autoComplete="off"
                         spellCheck={false} aria-invalid={!!errors.name} aria-describedby="env-adopt-name-help"
                         onChange={(e) => setName(e.target.value)} />
                  <p id="env-adopt-name-help" className="page-hint">{NAME_HELP}</p>
                  {errors.name && <p className="form-error" role="alert">{errors.name}</p>}
                </div>
                <div>
                  <span className="field-label" id="env-adopt-type-label">Type</span>
                  <div className="segmented" role="radiogroup" aria-labelledby="env-adopt-type-label">
                    {TYPES.map((t) => (
                      <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? 'on' : ''}
                              tabIndex={type === t ? 0 : -1} onKeyDown={arrowNav}
                              onClick={() => { setType(t); setErrors({}); }}>{TYPE_LABEL[t]}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="field-label" htmlFor="env-adopt-target">Target</label>
                  <ComboBox inputId="env-adopt-target" ariaLabel="Target" portal value={target}
                            placeholder="Choose a target…"
                            options={targets.map((t) => ({ value: t.id, label: t.label }))}
                            onChange={setTarget} />
                  {targets.length === 0 && (
                    <p className="page-hint">No SSH target is ready. Add an SSH target under Target on the Deploy page.</p>
                  )}
                  {errors.target && <p className="form-error" role="alert">{errors.target}</p>}
                </div>
                <div>
                  <label className="field-label" htmlFor="env-adopt-ref">Git ref</label>
                  <input id="env-adopt-ref" type="text" value={ref} maxLength={200} autoComplete="off" spellCheck={false}
                         aria-invalid={!!errors.ref} onChange={(e) => setRef(e.target.value)} />
                  <p className="page-hint">The branch, tag or commit deploys use unless you pick another.</p>
                  {errors.ref && <p className="form-error" role="alert">{errors.ref}</p>}
                </div>
              </div>
            )}

            {step === 'result' && result && (
              <>
                <p>Adopted <b>{result.name}</b>. Nothing on the target was changed.</p>
                <dl className="sirdar-kv">
                  <dt>Running commit</dt><dd className="mono">{result.current_sha ?? '—'}</dd>
                  <dt>Image tag</dt><dd className="mono">{result.image_tag ?? '—'}</dd>
                  <dt>Base domain</dt><dd className="mono">{result.base_domain}</dd>
                  <dt>Folder</dt><dd className="mono">{result.env_dir}</dd>
                </dl>
                <h4 className="sirdar-sub">Imported secrets</h4>
                <div className="sirdar-chips">
                  {result.imported_secrets.map((k) => <span key={k} className="chip tag mono">{k}</span>)}
                </div>
                <h4 className="sirdar-sub">Ignored keys</h4>
                {result.ignored_keys.length ? (
                  <>
                    <div className="sirdar-chips">
                      {result.ignored_keys.map((k) => <span key={k} className="chip tag mono">{k}</span>)}
                    </div>
                    <p className="page-hint">Sirdar doesn't use these. The next deploy writes the .env without them.</p>
                  </>
                ) : <p className="page-hint">None. Sirdar knows every key in that .env.</p>}
              </>
            )}

            {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
          </div>

          <div className="modal-foot">
            {step === 'result' ? (
              <button type="button" className="btn-solid" onClick={() => { if (result) onAdopted(result); }}>Open environment</button>
            ) : (
              <>
                <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
                <button type="button" className="btn-solid" disabled={!loaded || busy} onClick={submit}>
                  {busy ? 'Adopting…' : 'Adopt'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
