/** One deployment: its steps with live logs (polled while it runs), Cancel,
 *  Retry from step and, after a failed Update, Roll back. Logs render as text
 *  only (already redacted server-side). */
import { useEffect, useRef, useState, type UIEvent } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';
import { ApiError } from '@portal/lib/api';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  cancelDeployment, deployErrorText, errorText, getDeployment, retryDeployment, rollbackDeployment, startDeployment,
  type Deployment, type Environment,
} from '../../lib/sirdarApi';

import {
  CHANGE_MODES, DEPLOYMENT_STATUS, RETRY_MODES, RETRYABLE, STEP_STATUS, StatusChip, baseName, deploymentLabel,
  dumpTakenAt, duration, onBluegreen, onDo, retryNeedsName, shortSha, stoppedStep, when,
} from './labels';

export const POLL_MS = 2000;
/** After a failed poll the wait doubles (4 s, 8 s, …) up to this, until one succeeds. */
export const MAX_BACKOFF_MS = 30000;
/** The log follows new output only when the reader is within this many px of its bottom. */
const STICK_PX = 40;

/** A retry or a rollback, kept whole so a host-key prompt replays exactly it. */
type Attempt = { kind: 'retry'; fromStep: number; confirm: string; gated: boolean; phrase: string | null }
  | { kind: 'rollback'; confirm: string }
  | { kind: 'vm_restore'; confirm: string; snapshot: string };

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
  const [phrase, setPhrase] = useState('');
  const [rollbackConfirm, setRollbackConfirm] = useState('');
  const [vmConfirm, setVmConfirm] = useState('');
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

  // Reset, Restore backup and Roll back replace data, and production's Activate moves its traffic: the typed name.
  const gated = !!dep && retryNeedsName(dep.mode, env);
  // A production Delete on DigitalOcean also needs "delete production <name>" again.
  const phraseWanted = `delete production ${env.name}`;
  const phraseNeeded = !!dep && dep.cloud && dep.mode === 'teardown' && env.type === 'production';
  const allowed = !dep || !RETRY_MODES.includes(dep.mode) ? false
    : CHANGE_MODES.includes(dep.mode) ? can('deploy', 'add') && can('deploy', 'change') : can('deploy', 'add');
  const mayRetry = !!dep && RETRYABLE.includes(dep.status) && allowed && stopped !== null;
  // Production retries the API would refuse: an Activate once retiring (production_retiring), and a Delete
  // unless it is retiring with no live slot (production_not_retiring, production_slot_active).
  const retryRefusal = !dep || env.type !== 'production' ? null
    : dep.mode === 'activate' && dep.slot && env.retiring
      ? 'This production environment is retiring: it can only be deactivated.'
    : phraseNeeded && !env.retiring ? 'Mark this production environment retiring first (Settings).'
    : phraseNeeded && env.active_slot !== null
      ? "Deactivate it first (Overview › DigitalOcean): a live slot can't be deleted."
    : null;
  // Roll back isn't offered on DigitalOcean or LAN Blue/Green: activate the other slot instead.
  const mayRollBack = !!dep && dep.rollback_available && can('deploy', 'add') && can('deploy', 'change') && !onDo(env)
    && !onBluegreen(env);
  // A failed deployment whose step 0 took a VM snapshot: put the whole VM back.
  const mayRestoreVm = !!dep && !!dep.vm_snapshot && dep.mode !== 'vm_restore' && RETRYABLE.includes(dep.status)
    && can('deploy', 'add') && can('deploy', 'change');
  // A restoring deployment (Reset with a snapshot, seeded first deploy) already wrote the
  // snapshot's keys into the host .env: retry it rather than follow it with a plain Update.
  const restoring = !!dep && dep.steps.some((s) => s.key === 'restore');

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: Attempt) => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    setActionError('');
    try {
      if (attempt.kind === 'rollback') onRetried(await rollbackDeployment(id, attempt.confirm));
      else if (attempt.kind === 'vm_restore') {
        onRetried(await startDeployment(env.name, {
          mode: 'vm_restore', vm_snapshot: attempt.snapshot, confirm_name: attempt.confirm }));
      } else {
        onRetried(await retryDeployment(id, {
          from_step: attempt.fromStep,
          ...(attempt.gated ? { confirm_name: attempt.confirm } : {}),
          ...(attempt.phrase ? { confirm_production: attempt.phrase } : {}),
        }));
      }
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) {
        setActionError(deployErrorText(e, attempt.kind === 'rollback' ? "Couldn't roll back the deployment."
          : attempt.kind === 'vm_restore' ? "Couldn't restore the VM snapshot." : "Couldn't retry the deployment."));
      }
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };
  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and continue',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setActionError,
  });

  const retry = () => {
    if (!dep || stopped === null) return;
    if (gated && confirm !== env.name) { setActionError(`Type ${env.name} to confirm.`); return; }
    if (phraseNeeded && phrase !== phraseWanted) { setActionError(`Type ${phraseWanted} to confirm.`); return; }
    void run({ kind: 'retry', fromStep: fromStep === '' ? stopped : Number(fromStep), confirm, gated,
               phrase: phraseNeeded ? phrase : null });
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
        <h2>{deploymentLabel(dep)} · <span className="mono">{shortSha(dep.sha)}</span></h2>
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
        {dep.snapshot && (
          <><dt>{dep.mode === 'snapshot' ? 'Snapshot' : 'Restores snapshot'}</dt><dd>{dep.snapshot.name}</dd></>
        )}
        {dep.restore_dump && <><dt>Restores backup</dt><dd className="mono">{dep.restore_dump}</dd></>}
        {dep.vm_snapshot && (
          <><dt>{dep.mode === 'vm_restore' ? 'Restores VM snapshot' : 'VM snapshot'}</dt>
            <dd className="mono">{dep.vm_snapshot}</dd></>
        )}
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

      {mayRetry && isLatest === true && retryRefusal && <p className="form-error">{retryRefusal}</p>}
      {mayRetry && isLatest === true && !retryRefusal && (
        <div className="sirdar-retry pf-form">
          <div>
            <label className="field-label" htmlFor="retry-step">Retry from step</label>
            <ComboBox inputId="retry-step" ariaLabel="Retry from step" portal value={fromStep || String(stopped)}
                      options={retryOptions} onChange={setFromStep} />
          </div>
          {gated && (
            <div>
              <label className="field-label" htmlFor="retry-confirm">Type {env.name} to confirm</label>
              <input id="retry-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          {phraseNeeded && (
            <div>
              <label className="field-label" htmlFor="retry-phrase">Type {phraseWanted} to confirm</label>
              <input id="retry-phrase" type="text" value={phrase} maxLength={100} autoComplete="off"
                     spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
            </div>
          )}
          <button type="button" className="btn-solid"
                  disabled={retrying || hostKey.open || (gated && confirm !== env.name)
                    || (phraseNeeded && phrase !== phraseWanted)}
                  onClick={retry}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      {mayRetry && isLatest === true && restoring && (
        <p className="page-hint">Retry this deployment — a new Update would put the old sign-in keys back.</p>
      )}
      {mayRetry && isLatest === false && <p className="page-hint">Only the most recent deployment can be retried.</p>}
      {mayRollBack && isLatest === true && (
        <div className="sirdar-rollback">
          <h3 className="sirdar-sub">Roll back</h3>
          <p className="page-hint">
            Deploys the previous commit <span className="mono">{shortSha(dep.previous_sha)}</span> again and restores
            this deployment's pre-deploy dump. Uploaded files are not rolled back.
          </p>
          {dep.dump_path && (
            <p className="page-hint">
              Restores the backup <span className="mono">{baseName(dep.dump_path)}</span>
              {dumpTakenAt(dep.dump_path) ? <>, taken <span className="mono">{when(dumpTakenAt(dep.dump_path))}</span></> : null}.
            </p>
          )}
          <div className="sirdar-retry pf-form">
            <div>
              <label className="field-label" htmlFor="rollback-confirm">Type {env.name} to confirm</label>
              <input id="rollback-confirm" type="text" value={rollbackConfirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setRollbackConfirm(e.target.value)} />
            </div>
            <button type="button" className="btn-ghost"
                    disabled={retrying || hostKey.open || rollbackConfirm !== env.name}
                    onClick={() => void run({ kind: 'rollback', confirm: rollbackConfirm })}>
              {retrying ? 'Starting…' : 'Roll back'}
            </button>
          </div>
        </div>
      )}
      {mayRestoreVm && isLatest === true && (
        <div className="sirdar-rollback">
          <h3 className="sirdar-sub">Restore VM snapshot</h3>
          <p className="page-hint">
            Puts the whole VM back to {dep.vm_snapshot}, taken before this deployment changed anything: database,
            files and backups. The running commit goes back to{' '}
            <span className="mono">{shortSha(dep.previous_sha)}</span>.
          </p>
          <div className="sirdar-retry pf-form">
            <div>
              <label className="field-label" htmlFor="vmrestore-confirm">Type {env.name} to restore the VM snapshot</label>
              <input id="vmrestore-confirm" type="text" value={vmConfirm} maxLength={64} autoComplete="off"
                     spellCheck={false} onChange={(e) => setVmConfirm(e.target.value)} />
            </div>
            <button type="button" className="btn-ghost"
                    disabled={retrying || hostKey.open || vmConfirm !== env.name}
                    onClick={() => void run({ kind: 'vm_restore', confirm: vmConfirm, snapshot: dep.vm_snapshot! })}>
              {retrying ? 'Starting…' : 'Restore VM snapshot'}
            </button>
          </div>
        </div>
      )}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}
      {hostKey.modal}
    </section>
  );
}
