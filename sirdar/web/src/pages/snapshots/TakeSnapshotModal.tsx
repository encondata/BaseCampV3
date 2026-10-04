/** Take a snapshot of a deployed environment: a job on its target dumps the
 *  database and every object, packs them with the environment's keys and
 *  fetches the bundle to Sirdar. The environment keeps running. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ComboBox from '@portal/components/ComboBox';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { deployErrorText, takeSnapshot, type Deployment, type Environment, type Snapshot } from '../../lib/sirdarApi';

import { SNAPSHOT_NAME_HELP, snapshotNameProblem } from './UploadSnapshotModal';

type Attempt = { env: string; target: string; name: string; notes: string };

/** "uat-2026-10-04" (the local date). */
export function defaultSnapshotName(env: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${env}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function TakeSnapshotModal({ envs, initialEnv, onStarted, onClose }: {
  /** Environments that can be snapshotted (deployed ones). */
  envs: Environment[]; initialEnv?: string;
  onStarted: (result: { snapshot: Snapshot; deployment: Deployment }) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  // An initial environment that isn't in the list (not deployed, or gone) falls back to the first.
  const first = (initialEnv && envs.some((e) => e.name === initialEnv) ? initialEnv : envs[0]?.name) ?? '';
  const [env, setEnv] = useState(first);
  const [name, setName] = useState(first ? defaultSnapshotName(first) : '');
  const [nameTouched, setNameTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and take snapshot',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setError,
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;
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

  const pickEnv = (v: string) => {
    setEnv(v);
    setError('');
    if (!nameTouched) setName(v ? defaultSnapshotName(v) : '');
  };

  const nameError = snapshotNameProblem(name);
  const chosen = envs.find((e) => e.name === env);
  const ready = !!chosen && !!name.trim() && !nameError && !busy;

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: Attempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await takeSnapshot(attempt.env, attempt.name, attempt.notes));
    } catch (e) {
      if (!hostKey.handle(e, attempt.target, attempt)) setError(deployErrorText(e, "Couldn't start the snapshot."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = () => {
    if (!chosen || !name.trim()) return;
    void run({ env: chosen.name, target: chosen.target, name: name.trim(), notes: notes.trim() });
  };

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-snapmodal-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-take-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Snapshots</div>
              <h3 id="sirdar-take-title">Take snapshot</h3>
              <p className="page-hint">
                Copies an environment's database, files and sign-in keys into a snapshot on Sirdar. The environment
                keeps running; you can follow the job's log.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-snap-form">
            <div>
              <label className="field-label" htmlFor="take-env">Environment</label>
              <ComboBox inputId="take-env" ariaLabel="Environment" portal value={env}
                        placeholder="Choose an environment…" disabled={busy}
                        options={envs.map((e) => ({ value: e.name, label: `${e.name} · ${e.base_domain}` }))}
                        onChange={pickEnv} />
              {envs.length === 0 && <p className="page-hint">No environment has been deployed yet.</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="take-name">Name</label>
              <input id="take-name" type="text" value={name} maxLength={64} autoComplete="off" spellCheck={false}
                     aria-invalid={!!nameError} aria-describedby="take-name-help" disabled={busy}
                     onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
              <p id="take-name-help" className="page-hint">{SNAPSHOT_NAME_HELP}</p>
              {nameError && <p className="form-error" role="alert">{nameError}</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="take-notes">Notes</label>
              <textarea id="take-notes" rows={3} value={notes} maxLength={2000} disabled={busy}
                        onChange={(e) => setNotes(e.target.value)} />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid" disabled={!ready} onClick={submit}>
              {busy ? 'Starting…' : 'Take snapshot'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
