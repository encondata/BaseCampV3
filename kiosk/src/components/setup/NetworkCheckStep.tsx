/**
 * Step 5 of the RFID path: Network check. Runs the reader, router, portal
 * and registration checks one after another, shows each as it lands, and
 * moves on by itself 1.5 s after all four pass. Any failure leaves Back
 * and Run again; the rest of the checks still run.
 */

import { useEffect, useRef, useState } from 'react';

import { ApiError, runCheck, type CheckName, type CheckResult } from '../../lib/api';
import CheckList from './CheckList';

interface Props {
  onContinue: () => void;
  onBack: () => void;
}

const ITEMS: { name: CheckName; label: string }[] = [
  { name: 'reader', label: 'Reader online and ready' },
  { name: 'router', label: 'Local network to the router' },
  { name: 'portal', label: 'Portal responds' },
  { name: 'registration', label: 'Kiosk registered' },
];

const ADVANCE_MS = 1500;

function shown(value: string | boolean | null | undefined): string {
  return typeof value === 'string' && value ? value : '—';
}

export default function NetworkCheckStep({ onContinue, onBack }: Props) {
  const [results, setResults] = useState<Partial<Record<CheckName, CheckResult>>>({});
  const [running, setRunning] = useState<CheckName | null>(null);
  const [finished, setFinished] = useState(false);
  const runId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;

  const clearTimer = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };

  const run = async () => {
    const id = ++runId.current;
    clearTimer();
    setResults({});
    setFinished(false);
    let allOk = true;
    for (const { name } of ITEMS) {
      if (id !== runId.current) return;
      setRunning(name);
      let result: CheckResult;
      try {
        result = await runCheck(name);
      } catch (err) {
        result = {
          name, ok: false, state: 'fail',
          detail: err instanceof ApiError ? err.code : 'unknown_error',
        };
      }
      if (id !== runId.current) return;
      if (result.state !== 'ok') allOk = false;
      setResults((prev) => ({ ...prev, [name]: result }));
    }
    setRunning(null);
    setFinished(true);
    if (allOk) timer.current = setTimeout(() => onContinueRef.current(), ADVANCE_MS);
  };

  // Set on mount as well as bumped on unmount, so StrictMode's dev-mode
  // remount starts a fresh run and the first one is ignored.
  useEffect(() => {
    void run();
    return () => { runId.current += 1; clearTimer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allOk = finished && ITEMS.every(({ name }) => results[name]?.state === 'ok');

  return (
    <>
      <h2>Network check</h2>
      <CheckList items={ITEMS} results={results} running={running} />
      <dl className="kv check-info">
        <dt>Reader endpoint IP</dt><dd className="mono">{shown(results.reader?.info?.endpoint_ip)}</dd>
        <dt>Laptop LAN IP</dt><dd className="mono">{shown(results.router?.info?.lan_ip)}</dd>
        <dt>WAN IP</dt><dd className="mono">{shown(results.registration?.info?.wan_ip)}</dd>
      </dl>
      {allOk && <p className="page-hint" role="status">All checks passed</p>}
      {finished && !allOk && (
        <div className="pf-form-actions">
          <button type="button" className="mini-btn" onClick={onBack}>Back</button>
          <button type="button" className="btn-solid" onClick={() => void run()}>Run again</button>
        </div>
      )}
    </>
  );
}
