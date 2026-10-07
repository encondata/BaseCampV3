/** The Deploy page's step-by-step flow (spec 2026-10-07 §1): Environment,
 *  Servers, Target, Extras, Traffic, Data, Review & Deploy. A page section
 *  with the report-generate header; Deploy creates the environment, starts
 *  its first deployment and opens it. A start that fails after the create is
 *  retried on its own: the environment is never created twice, and the flow
 *  is locked on Review from then on (its choices are no longer used). */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { ApiError } from '@portal/lib/api';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  createEnvironment, deployErrorText, getDoAccounts, getEnvironmentDefaults, getIntegrations, listSnapshots, startDeployment,
  type DeployTarget,
} from '../../lib/sirdarApi';

import {
  CODE_FIELD, FLOW_STEPS, STEP_HINT, buildBody, initialState, nextStep, prevStep, stepErrors, stepOfCode, withRules,
  type Errors, type FlowContext, type FlowState, type FlowStep,
} from './flowState';
import DataStep from './steps/DataStep';
import EnvironmentStep from './steps/EnvironmentStep';
import ExtrasStep from './steps/ExtrasStep';
import ReviewStep from './steps/ReviewStep';
import ServersStep from './steps/ServersStep';
import TargetStep from './steps/TargetStep';
import TrafficStep from './steps/TrafficStep';

export default function DeployFlow({ targets, reloadTargets }: { targets: DeployTarget[]; reloadTargets: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [base, setBase] = useState<Omit<FlowContext, 'targets'> | null>(null);
  const [loadError, setLoadError] = useState('');
  const [state, setState] = useState<FlowState | null>(null);
  const [step, setStep] = useState<FlowStep>('environment');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  /** The environment this flow already created, so Deploy only retries its start. */
  const [created, setCreated] = useState<string | null>(null);
  /** Names whose create got no clear answer (lost response, 5xx): they may exist already. */
  const unsure = useRef(new Set<string>());
  const [maybeCreated, setMaybeCreated] = useState('');
  const [announce, setAnnounce] = useState('');
  const busyRef = useRef(false);
  const focusName = useRef(false);
  const focusTitle = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  /** Show a step: its title takes focus and the live region names it. */
  const go = (to: FlowStep) => {
    const i = FLOW_STEPS.findIndex(([s]) => s === to);
    focusTitle.current = true;
    setAnnounce(`Step ${i + 1} of ${FLOW_STEPS.length}: ${FLOW_STEPS[i][1]}`);
    setStep(to);
  };

  useEffect(() => {
    let live = true;
    const snaps = listSnapshots().then((r) => r.snapshots.filter((s) => s.status === 'ready')).catch(() => []);
    Promise.all([getEnvironmentDefaults(), getIntegrations().catch(() => null),
                 getDoAccounts().then((r) => r.accounts).catch(() => []), snaps])
      .then(([defaults, integrations, accounts, snapshots]) => {
        if (live) setBase({ defaults: defaults as FlowContext['defaults'], integrations, accounts, snapshots });
      })
      .catch((e) => { if (live) setLoadError(deployErrorText(e, "Couldn't load the defaults.")); });
    return () => { live = false; };
  }, []);
  const ctx = useMemo<FlowContext | null>(() => (base ? { ...base, targets } : null), [base, targets]);
  useEffect(() => { if (ctx && !state) setState(initialState(ctx)); }, [ctx, state]);
  // A reloaded target list can drop the chosen target: the rules clear it.
  useEffect(() => { if (ctx) setState((s) => (s ? withRules(s, ctx) : s)); }, [ctx]);

  const set = useCallback((patch: Partial<FlowState>) => {
    setState((s) => (s && ctx ? withRules({ ...s, ...patch }, ctx) : s));
    setErrors({});
  }, [ctx]);

  async function start(name: string) {
    const dep = await startDeployment(name, { mode: 'update' });
    navigate(`/deploy/environments/${encodeURIComponent(name)}?deployment=${encodeURIComponent(dep.id)}`);
  }

  async function deploy(alreadyCreated?: string) {
    if (!state || !ctx || busyRef.current) return;
    busyRef.current = true; setBusy(true); setProblem('');
    let name = alreadyCreated ?? created;
    try {
      if (!name) {
        const body = buildBody(state, ctx);
        try {
          name = (await createEnvironment(body)).name;
          setCreated(name);
        } catch (err) {
          const code = (err as { code?: string }).code ?? '';
          if (!(err instanceof ApiError) || err.status >= 500) unsure.current.add(body.name);
          setMaybeCreated(code === 'environment_exists' && unsure.current.has(body.name) ? body.name : '');
          const field = CODE_FIELD[code] ?? 'form';
          const to = stepOfCode(code);
          const text = deployErrorText(err, "Couldn't create the environment.");
          if (code === 'snapshot_not_found' || code === 'snapshot_not_ready') {
            const gone = state.snapshotId;
            setBase((b) => (b ? { ...b, snapshots: b.snapshots.filter((s) => s.id !== gone) } : b));
            setState((s) => (s ? { ...s, snapshotId: '', dataMode: 'empty' } : s));
          }
          setErrors({ [field]: text });
          if (field === 'form') setProblem(text);
          if (to === 'environment') { focusName.current = true; setStep(to); } else if (to !== step) go(to);
          return;
        }
      }
      try {
        await start(name);
      } catch (err) {
        if (!hostKey.handle(err, state.target, name)) setProblem(deployErrorText(err, "Couldn't start the deployment."));
      }
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  const hostKey = useHostKeyTrust<string>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and deploy',
    onTrusted: (name) => { void deploy(name); }, onProblem: (m) => setProblem(m),
  });
  useLayoutEffect(() => { sectionRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  // After the steps' own effects (an Environment step focuses its name on mount).
  useEffect(() => {
    if (focusName.current && step === 'environment') {
      focusName.current = false;
      document.getElementById('flow-name')?.focus();
    } else if (focusTitle.current) {
      focusTitle.current = false;
      titleRef.current?.focus();
    }
  });

  if (!can('deploy', 'add')) return null;
  if (loadError) return <p className="form-error" role="alert">{loadError}</p>;
  if (!ctx || !state) return <section className="sirdar-flow"><p className="page-hint">Loading…</p></section>;

  // Once created, only Review is left: Deploy retries the start, and the choices can't change.
  const locked = created !== null;
  const shown: FlowStep = locked ? 'review' : step;
  const at = FLOW_STEPS.findIndex(([s]) => s === shown);
  const label = FLOW_STEPS[at][1];
  const props = { state, set, errors, ctx };
  const next = () => {
    const e = stepErrors(step, state, ctx);
    setErrors(e);
    if (!Object.keys(e).length) go(nextStep(step));
  };
  const back = () => { setErrors({}); go(prevStep(step)); };
  const startOver = () => {
    if (!window.confirm('Start over? Every choice in this flow is cleared.')) return;
    setState(initialState(ctx)); setErrors({}); setProblem(''); setCreated(null); setMaybeCreated('');
    unsure.current.clear();
    go('environment');
  };

  return (
    <>
      <section ref={sectionRef} className="sirdar-flow" aria-labelledby="sirdar-flow-title">
        <div className="sirdar-flow-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Deploy</div>
            <h2 id="sirdar-flow-title" ref={titleRef} tabIndex={-1}>{label}</h2>
            <p className="page-hint">{STEP_HINT[shown]}</p>
          </div>
          <p className="sr-only" aria-live="polite">{announce}</p>
          {!locked && <div className="rgm-steps">
            {FLOW_STEPS.map(([s, text], i) => (
              <Fragment key={s}>
                {i > 0 && <span className="rgm-step-sep" />}
                <span className={`rgm-step${i === at ? ' on' : ''}${i < at ? ' done' : ''}`}>
                  <span className="rgm-step-num">{i + 1}</span>
                  <span className="rgm-step-label">{text}</span>
                </span>
              </Fragment>
            ))}
          </div>}
        </div>
        <div className="sirdar-flow-body pf-form">
          {shown === 'environment' && <EnvironmentStep {...props} />}
          {shown === 'environment' && maybeCreated && maybeCreated === state.name.trim() && (
            <p className="page-hint" role="note">
              It may have been created already:{' '}
              <Link to={`/deploy/environments/${encodeURIComponent(maybeCreated)}`}>open it</Link>
            </p>
          )}
          {shown === 'servers' && <ServersStep {...props} />}
          {shown === 'target' && <TargetStep {...props} onTargetsChanged={reloadTargets} />}
          {shown === 'extras' && <ExtrasStep {...props} />}
          {shown === 'traffic' && <TrafficStep {...props} />}
          {shown === 'data' && <DataStep {...props} />}
          {shown === 'review' && <ReviewStep {...props} busy={busy} problem={problem} created={created} />}
          {errors.form && shown !== 'review' && <p className="form-error" role="alert">{errors.form}</p>}
        </div>
        <div className="sirdar-flow-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={startOver}>Start over</button>
          {!locked && step !== 'environment' && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={back}>Back</button>
          )}
          {shown === 'review'
            ? <button type="button" className="btn-solid" disabled={busy} onClick={() => { void deploy(); }}>
                {busy ? 'Deploying…' : 'Deploy'}
              </button>
            : <button type="button" className="btn-solid" onClick={next}>Next</button>}
        </div>
      </section>
      {hostKey.modal}
    </>
  );
}
