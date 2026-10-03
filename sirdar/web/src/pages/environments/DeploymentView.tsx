/** One deployment: its steps with live logs (polled while it runs), Cancel,
 *  and Retry from step. Logs render as text only (already redacted server-side). */
import { useEffect, useRef, useState, type UIEvent } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import { ApiError } from '@portal/lib/api';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  cancelDeployment, deployErrorText, errorText, getDeployment, retryDeployment,
  type Deployment, type Environment,
} from '../../lib/sirdarApi';

import {
  DEPLOYMENT_STATUS, MODE_LABEL, RETRYABLE, STEP_STATUS, StatusChip, duration, shortSha, stoppedStep, when,
} from './labels';

export const POLL_MS = 2000;
/** After a failed poll the wait doubles (4 s, 8 s, …) up to this, until one succeeds. */
export const MAX_BACKOFF_MS = 30000;
/** The log follows new output only when the reader is within this many px of its bottom. */
const STICK_PX = 40;

type RetryAttempt = { fromStep: number; confirm: string; reset: boolean };

export default function DeploymentView({ id, env, isLatest, onFinished, onRetried, onClose }: {
  /** null while the history hasn't loaded: Retry stays hidden until it's known. */
  id: string; env: Environment; isLatest: boolean | null;
  onFinished: () => void; onRetried: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [dep, setDep] = useState<Deployment | null>(null);
  const [loadError, setLoadError] = useState('');
  /** null = follow the running / stopped step; -1 = none open. */
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [fromStep, setFromStep] = useState('');
  const [confirm, setConfirm] = useState('');
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const logRef = useRef<HTMLPreElement>(null);

  // One request at a time: the next poll is scheduled only after the last one settles.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawRunning = false;
    let loaded = false;
    let failures = 0;
    const tick = async () => {
      try {
        const d = await getDeployment(id);
        if (!live) return;
        failures = 0;
        loaded = true;
        setDep(d);
        setLoadError('');
        if (d.status === 'running') { sawRunning = true; timer = setTimeout(tick, POLL_MS); }
        else if (sawRunning) finished.current();
      } catch (e) {
        if (!live) return;
        setLoadError(errorText(e, "Couldn't load this deployment."));
        failures += 1;
        // Keep trying while it runs, or until the first load lands (a fresh deployment
        // can blip); any 4xx (gone, forbidden, signed out) is final.
        const final = e instanceof ApiError && e.status >= 400 && e.status < 500;
        if (!final && (sawRunning || !loaded)) timer = setTimeout(tick, Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
      }
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [id]);

  const running = dep?.status === 'running';
  useEffect(() => { if (!running) setCancelling(false); }, [running]);
  const stopped = dep ? stoppedStep(dep.steps) : null;
  const followed = dep?.steps.find((s) => s.status === 'running')?.number ?? stopped;
  const shown = dep?.steps.find((s) => s.number === (openStep ?? followed)) ?? null;
  const log = shown?.log_tail ?? '';
  // Stick to the bottom only if the reader was already there; a newly opened step starts stuck.
  const stick = useRef(true);
  const stuckStep = useRef<number | null>(null);
  useEffect(() => {
    const el = logRef.current;
    // A closed step forgets it was followed, so reopening it starts stuck to the bottom.
    if (!el) { stuckStep.current = null; return; }
    if (stuckStep.current !== shown?.number) { stuckStep.current = shown?.number ?? null; stick.current = true; }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [log, shown?.number]);
  const onLogScroll = (e: UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };

  const isReset = dep?.mode === 'reset';
  const allowed = dep?.mode === 'update' ? can('deploy', 'add')
    : dep?.mode === 'reset' ? can('deploy', 'add') && can('deploy', 'change') : false;
  const mayRetry = !!dep && RETRYABLE.includes(dep.status) && allowed && stopped !== null;

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: RetryAttempt) => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setActionError('');
    try {
      onRetried(await retryDeployment(id, attempt.reset
        ? { from_step: attempt.fromStep, confirm_name: attempt.confirm }
        : { from_step: attempt.fromStep }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) setActionError(deployErrorText(e, "Couldn't retry the deployment."));
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };
  const hostKey = useHostKeyTrust<RetryAttempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and retry',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setActionError,
  });

  const retry = () => {
    if (!dep || stopped === null) return;
    if (isReset && confirm !== env.name) { setActionError(`Type ${env.name} to confirm.`); return; }
    void run({ fromStep: Number(fromStep || stopped), confirm, reset: isReset });
  };

  const cancel = async () => {
    if (!window.confirm('Cancel this deployment? The running step stops; finished steps stay as they are.')) return;
    setCancelling(true);
    setActionError('');
    // An orphaned run answers "cancelled" at once; the poll still runs until the
    // fetched deployment is no longer running, and that clears `cancelling`.
    try { await cancelDeployment(id); }
    catch (e) { setCancelling(false); setActionError(errorText(e, "Couldn't cancel the deployment.")); }
  };

  if (!dep) {
    return (
      <section className="sirdar-section sirdar-card sirdar-deployment" aria-label="Deployment">
        <div className="sirdar-section-head">
          {loadError ? <p className="form-error" role="alert">{loadError}</p> : <p className="page-hint">Loading…</p>}
          <button type="button" className="mini-btn" onClick={onClose}>Close</button>
        </div>
      </section>
    );
  }
  const retryOptions = dep.steps.filter((s) => stopped !== null && s.number <= stopped)
    .map((s) => ({ value: String(s.number), label: `${s.number}. ${s.name}` }));

  return (
    <section className="sirdar-section sirdar-card sirdar-deployment" aria-label="Deployment">
      <div className="sirdar-section-head">
        <h2>{MODE_LABEL[dep.mode] ?? dep.mode} · <span className="mono">{shortSha(dep.sha)}</span></h2>
        <div className="sirdar-target-actions">
          {running && can('deploy', 'change') && (
            <button type="button" className="btn-ghost" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? 'Canceling…' : 'Cancel deployment'}
            </button>
          )}
          <button type="button" className="mini-btn" onClick={onClose}>Close</button>
        </div>
      </div>
      <dl className="sirdar-kv">
        <dt>Status</dt><dd><StatusChip map={DEPLOYMENT_STATUS} status={dep.status} /></dd>
        <dt>Ref</dt><dd className="mono">{dep.git_ref} → {dep.sha}</dd>
        <dt>Started</dt><dd className="mono">{when(dep.started_at)}{dep.actor_name ? ` · ${dep.actor_name}` : ''}</dd>
        <dt>Finished</dt><dd className="mono">{when(dep.finished_at)}</dd>
        {dep.retry_of && <><dt>Retry</dt><dd>From step {dep.start_step}</dd></>}
        {dep.dump_path && <><dt>Pre-deploy dump</dt><dd className="mono">{dep.dump_path}</dd></>}
      </dl>
      {dep.error && <p className="form-error">{dep.error}</p>}
      {loadError && <p className="form-error" role="alert">{loadError}</p>}

      <ol className="sirdar-steps">
        {dep.steps.map((s) => {
          const open = shown?.number === s.number;
          return (
            <li key={s.number}>
              <button type="button" className="sirdar-step-btn" aria-expanded={open}
                      onClick={() => setOpenStep(open ? -1 : s.number)}>
                <span className="mono">{s.number}</span>
                <b>{s.name}</b>
                <StatusChip map={STEP_STATUS} status={s.status} />
                <span className="mono">{duration(s.started_at, s.finished_at)}</span>
              </button>
              {open && (
                <>
                  <pre className="sirdar-log" ref={logRef} onScroll={onLogScroll} aria-label={`Step ${s.number} log`}>{s.log_tail || 'No output yet.'}</pre>
                  {s.log_size > s.log_tail.length && (
                    <p className="page-hint">
                      Showing the last {s.log_tail.length.toLocaleString()} of {s.log_size.toLocaleString()} characters.
                    </p>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>

      {mayRetry && isLatest === true && (
        <div className="sirdar-retry pf-form">
          <div>
            <label className="field-label" htmlFor="retry-step">Retry from step</label>
            <ComboBox inputId="retry-step" ariaLabel="Retry from step" portal value={fromStep || String(stopped)}
                      options={retryOptions} onChange={setFromStep} />
          </div>
          {isReset && (
            <div>
              <label className="field-label" htmlFor="retry-confirm">Type {env.name} to confirm</label>
              <input id="retry-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          <button type="button" className="btn-solid" disabled={retrying || hostKey.open || (isReset && confirm !== env.name)}
                  onClick={retry}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {mayRetry && isLatest === false && <p className="page-hint">Only the most recent deployment can be retried.</p>}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {hostKey.modal}
    </section>
  );
}
