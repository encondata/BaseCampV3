/**
 * Printers › Factory reset — `^JUF` wipes every setting on the Zebra
 * (darkness, speed, media, offsets), the printer reboots, and the
 * operator is handed straight into the full setup wizard so the printer
 * never sits in the half-configured state a bare reset leaves behind.
 *
 * The reboot is the awkward part: the printer drops off USB for a few
 * seconds, so the restart step re-opens the handle (`ensureOpen`) before
 * every `~HI` attempt and treats a thrown transfer error as "not back
 * yet". Everything goes through the hook rather than the raw transport,
 * so each command lands in the page's command log.
 *
 * The reset itself is browser-to-printer (WebUSB) and never touches the
 * API, but the fact that it happened does: when the run ends — whether
 * it completed or failed — the modal posts it to /kiosk/printer-events,
 * which writes one audit row an admin can review in the portal. That
 * report is strictly best-effort: it is fired and never awaited, a
 * failure only shows a line in the modal, and nothing about it can stop
 * the hand-off into the setup wizard.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { CALIBRATE, FACTORY_DEFAULTS, SAVE_SETTINGS, configurationQuery } from '@portal/labels/zebraCommands';
import { parseConfiguration, type HostIdentification, type PrinterConfiguration } from '@portal/labels/zebraUsb';

import { postPrinterEvent } from '../../lib/api';
import { getIdentity } from '../../lib/identity';
import type { ZebraPrinter } from '../../lib/useZebraPrinter';

type StepId = 'defaults' | 'restart' | 'calibrate' | 'save' | 'config';
type StepState = 'pending' | 'running' | 'done' | 'failed';

const STEP_LABEL: Record<StepId, string> = {
  defaults: 'Sending factory defaults',
  restart: 'Waiting for the printer to restart',
  calibrate: 'Calibrating media',
  save: 'Saving settings',
  config: 'Reading configuration',
};

const PHASES = [{ id: 'confirm', label: 'Confirm' }, { id: 'reset', label: 'Reset' }, { id: 'setup', label: 'Setup' }];

/** The printer is off the bus while it reboots; ~45 s of 2 s attempts is
 *  comfortably longer than any Zebra desktop model takes to come back. */
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 45000;
const POLL_ATTEMPTS = Math.floor(POLL_TIMEOUT_MS / POLL_INTERVAL_MS);

const RESTART_FAILED = 'The printer did not come back. Power-cycle it, reconnect, and try again.';
const RECONNECT_NEEDED = 'Reconnect the printer to finish setup.';

/** The hook gave up on the device handle (unplug, or an open() the
 *  browser will never satisfy again) — retrying in here cannot help. */
const handleGone = (err: unknown) => err instanceof Error && err.message === 'Printer not connected';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ResetPrinter = Pick<ZebraPrinter, 'send' | 'query' | 'identify' | 'waitForIdle' | 'ensureOpen' | 'productName'>;

interface Props {
  printer: ResetPrinter;
  identity: HostIdentification | null;
  /** Success: the printer's freshly read post-reset configuration (null
   *  when `^HH` came back unreadable), for seeding the setup wizard. */
  onDone: (config: PrinterConfiguration | null) => void;
  onClose: () => void;
}

export default function FactoryResetModal({ printer, identity, onDone, onClose }: Props) {
  const [phase, setPhase] = useState<'confirm' | 'reset'>('confirm');
  const [calibrate, setCalibrate] = useState(true);
  const [plan, setPlan] = useState<StepId[]>([]);
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [error, setError] = useState('');
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [reported, setReported] = useState<'ok' | 'failed' | null>(null);
  const running = phase === 'reset' && failedAt === null;

  const printerRef = useRef(printer);
  printerRef.current = printer;
  const configRef = useRef<PrinterConfiguration | null>(null);
  // Set on mount as well as cleared on unmount: StrictMode's dev-mode
  // mount/unmount/remount would otherwise leave this false for good and
  // the run would abandon itself after its first step.
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !running) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  const name = useMemo(() => printer.productName || identity?.model || 'the connected Zebra printer', [printer.productName, identity]);

  /** Poll `~HI` until the rebooted printer answers. A transfer error (or
   *  a handle the browser has merely closed) means "not back yet"; only
   *  a dropped connection is fatal. */
  const waitForRestart = async () => {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await sleep(POLL_INTERVAL_MS);
      if (!aliveRef.current) return;
      try {
        await printerRef.current.ensureOpen();
      } catch (err) {
        if (handleGone(err)) throw new Error(RECONNECT_NEEDED);
        continue; // still rebooting — the handle isn't openable yet
      }
      try {
        if (await printerRef.current.identify()) return;
      } catch (err) {
        if (handleGone(err)) throw new Error(RECONNECT_NEEDED);
        // a WebUSB transfer error while the printer boots: try again
      }
    }
    throw new Error(RESTART_FAILED);
  };

  /** Tell the portal what happened, success or failure — a failed reset
   *  is exactly the run an admin wants to find later. Never awaited by
   *  the caller and never throws (see `postPrinterEvent`). */
  const report = async (
    outcome: 'completed' | 'failed',
    failure?: { failed_step: StepId; error: string },
  ) => {
    let recorded = false;
    try {
      recorded = await postPrinterEvent({
        serial: getIdentity().serial,
        event: 'factory_reset',
        outcome,
        printer_model: identity?.model ?? null,
        printer_firmware: identity?.firmware ?? null,
        calibrated: calibrate,
        failed_step: failure?.failed_step ?? null,
        error: failure?.error ?? null,
      });
    } catch {
      recorded = false;   // belt and braces: postPrinterEvent already swallows
    }
    if (aliveRef.current) setReported(recorded ? 'ok' : 'failed');
  };

  const runStep = async (id: StepId) => {
    const p = printerRef.current;
    if (id === 'defaults') await p.send(FACTORY_DEFAULTS);
    else if (id === 'restart') await waitForRestart();
    else if (id === 'calibrate') { await p.send(CALIBRATE); await p.waitForIdle(1); }
    else if (id === 'save') await p.send(SAVE_SETTINGS);
    else configRef.current = parseConfiguration(await p.query(configurationQuery()));
  };

  const run = async (steps: StepId[], from: number) => {
    setPhase('reset');
    setError('');
    setFailedAt(null);
    setRetryable(true);
    setReported(null);
    for (let i = from; i < steps.length; i++) {
      const id = steps[i];
      setStates((s) => ({ ...s, [id]: 'running' }));
      try {
        await runStep(id);
      } catch (err) {
        if (!aliveRef.current) return;
        const message = err instanceof Error && err.message ? err.message : 'The printer refused the command.';
        setStates((s) => ({ ...s, [id]: 'failed' }));
        setError(message);
        setFailedAt(i);
        setRetryable(message !== RECONNECT_NEEDED);
        void report('failed', { failed_step: id, error: message });
        return;
      }
      if (!aliveRef.current) return;
      setStates((s) => ({ ...s, [id]: 'done' }));
    }
    void report('completed');
    onDone(configRef.current);
  };

  const start = () => {
    const steps: StepId[] = ['defaults', 'restart', ...(calibrate ? ['calibrate' as const] : []), 'save', 'config'];
    setPlan(steps);
    setStates(Object.fromEntries(steps.map((s) => [s, 'pending' as StepState])));
    void run(steps, 0);
  };

  const phaseIndex = phase === 'confirm' ? 0 : 1;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-reset-card" role="dialog" aria-label="Factory reset">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printer</div>
            <h3>Factory reset</h3>
            <p className="page-hint">This clears every setting on the printer — darkness, speed, media, offsets — and starts setup from scratch.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={running}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="rgm-steps">
          {PHASES.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && <span className="rgm-step-sep" />}
              <span className={`rgm-step ${i === phaseIndex ? 'on' : ''} ${i < phaseIndex ? 'done' : ''}`}>
                <span className="rgm-step-num">{i + 1}</span><span className="rgm-step-label">{s.label}</span>
              </span>
            </Fragment>
          ))}
        </div>
        <div className="modal-body">
          {phase === 'confirm' ? (
            <div className="zp-col">
              <div className="modal-section">Printer</div>
              <div className="zp-config-item">
                <span className="cell-top">{name}</span>
                <span className="cell-sub">
                  {identity ? `${identity.model} · firmware ${identity.firmware} · ${identity.dpi} DPI` : 'Model and firmware unknown — the printer has not been identified.'}
                </span>
              </div>
              <div className="zp-notice error" role="alert">
                <p className="page-hint"><b>This cannot be undone.</b> The printer loses all of its configuration, its saved offsets, and any stored settings, and it restarts before setup can continue.</p>
              </div>
              <label className="zp-check" htmlFor="zfr-cal">
                <input id="zfr-cal" type="checkbox" checked={calibrate} onChange={(e) => setCalibrate(e.target.checked)} />
                <span>Calibrate the media after the reset (feeds a label or two)</span>
              </label>
              <p className="page-hint">Factory defaults wipe the media calibration, so leave this on unless the printer is loaded with something unusual.</p>
            </div>
          ) : (
            <div className="zp-col">
              <div className="modal-section">Resetting</div>
              <ul className="zp-reset-steps">
                {plan.map((id) => {
                  const state = states[id] ?? 'pending';
                  return (
                    <li key={id} className={`zp-reset-step is-${state}`} data-step={id} data-state={state}>
                      <span className="cell-top">{STEP_LABEL[id]}</span>
                      <span className={`chip ${state === 'done' ? 'c-green' : state === 'failed' ? 'c-red' : state === 'running' ? 'c-amber' : ''}`}>
                        {state === 'done' ? 'Done' : state === 'failed' ? 'Failed' : state === 'running' ? 'Working…' : 'Waiting'}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {error && <div className="zp-notice error" role="alert"><p className="page-hint">{error}</p></div>}
              {reported === 'ok' && <p className="page-hint">Recorded in the portal.</p>}
              {reported === 'failed' && (
                <p className="form-error">Couldn&apos;t record this reset in the portal — tell an admin.</p>
              )}
              {running && <p className="page-hint">Leave the printer powered on. This takes up to a minute.</p>}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {phase === 'confirm' ? (
            <>
              {/* the destructive button is last and never autofocused, so a
                  stray Enter on the open modal cannot wipe a printer */}
              <button type="button" className="mini-btn" autoFocus onClick={onClose}>Cancel</button>
              <button type="button" className="btn-solid btn-danger" onClick={start}>Factory reset</button>
            </>
          ) : (
            <>
              <button type="button" className="mini-btn" disabled={running} onClick={onClose}>Close</button>
              {failedAt !== null && retryable && (
                <button type="button" className="btn-solid" onClick={() => void run(plan, failedAt)}>Try again</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
