/**
 * Step 9 of the RFID path: Confirm & verify. Summarizes the setup, runs the
 * reader, portal and setup checks one after another, and only then offers
 * Start Reader. Any failure leaves Back and Run again.
 */

import { useEffect, useRef, useState } from 'react';

import { ApiError, runCheck, startReader, type CheckName, type CheckResult } from '../../lib/api';
import CheckList from './CheckList';
import { codeOf, readerErrorText } from './readerSetup';

interface Props {
  setup: { initiativeName: string; siteName: string; siteRole: 'source' | 'destination'; scanLabel: string };
  reader: { ip: string; serial: string; model: string; endpoint_url: string | null } | null;
  onBack: () => void;
  onStarted: () => void;
  onPairAgain: () => void;
}

const ITEMS: { name: CheckName; label: string }[] = [
  { name: 'reader', label: 'Reader online' },
  { name: 'portal', label: 'Portal reachable' },
  { name: 'setup', label: "Portal has this kiosk's setup" },
];

export default function ConfirmStep({ setup, reader, onBack, onStarted, onPairAgain }: Props) {
  const [results, setResults] = useState<Partial<Record<CheckName, CheckResult>>>({});
  const [running, setRunning] = useState<CheckName | null>(null);
  const [finished, setFinished] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const runId = useRef(0);

  const run = async () => {
    const id = ++runId.current;
    setResults({});
    setFinished(false);
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
      setResults((prev) => ({ ...prev, [name]: result }));
    }
    setRunning(null);
    setFinished(true);
  };

  // Bumped on unmount too, so StrictMode's remount starts a fresh run.
  useEffect(() => {
    void run();
    return () => { runId.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allOk = finished && ITEMS.every(({ name }) => results[name]?.state === 'ok');

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await startReader();
      onStarted();
    } catch (err) {
      setStartError(err);
      setStarting(false);
    }
  };

  const needsPair = startError !== null && codeOf(startError) === 'reader_required';

  return (
    <>
      <h2>Confirm &amp; verify</h2>
      <div className="setup-summary">
        <dl className="kv">
          <dt>Move</dt><dd>{setup.initiativeName}</dd>
          <dt>Site</dt><dd>{setup.siteName} ({setup.siteRole})</dd>
          <dt>Scan type</dt><dd>{setup.scanLabel}</dd>
          <dt>Reader</dt>
          <dd>{reader ? `${reader.model} ${reader.serial} at ${reader.ip}` : '—'}</dd>
          <dt>Endpoint</dt><dd className="mono">{reader?.endpoint_url ?? '—'}</dd>
        </dl>
      </div>
      <CheckList items={ITEMS} results={results} running={running} />
      {startError !== null && (needsPair ? (
        <div className="form-error" role="alert">
          <p>Pair a reader first</p>
          <button type="button" className="mini-btn" onClick={onPairAgain}>
            Back to the reader step
          </button>
        </div>
      ) : (
        <p className="form-error" role="alert">
          {readerErrorText(startError, reader?.ip ?? '')
            ?? `Couldn't start the reader (${codeOf(startError)}).`}
        </p>
      ))}
      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack} disabled={starting}>Back</button>
        {finished && !allOk && (
          <button type="button" className="mini-btn" onClick={() => void run()}>Run again</button>
        )}
        <button type="button" className="btn-solid" disabled={!allOk || starting}
                onClick={() => void start()}>
          {starting ? 'Starting…' : 'Start Reader'}
        </button>
      </div>
    </>
  );
}
