/**
 * Connect: the edge signs in to the reader and reads its version and
 * status. On success the step shows what it found and offers "Pair this
 * reader"; a failure says why, with Try again. The result is held by the
 * wizard, so coming Back from Pair doesn't sign in again.
 */

import { useEffect, useRef, useState } from 'react';

import { connectReader, type ReaderInfo } from '../../lib/api';
import { connectErrorText, pairedWithName, statusSummary } from './readerSetup';

interface Props {
  ip: string;
  info: ReaderInfo | null;
  onInfo: (info: ReaderInfo) => void;
  onPair: () => void;
  onBack: () => void;
}

export default function ConnectStep({ ip, info, onInfo, onPair, onBack }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set on mount as well as cleared on unmount, so StrictMode's dev-mode
  // remount doesn't leave the step deaf to its own answer.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await connectReader(ip);
      if (alive.current) onInfo(next);
    } catch (err) {
      if (alive.current) setError(connectErrorText(err, ip));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current || info) return;
    started.current = true;
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h2>Connect to the reader</h2>
      {busy && <p className="page-hint">Connecting to {ip}…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {info && !busy && (
        <div className="setup-summary">
          <dl className="kv">
            <dt>Address</dt><dd className="mono">{info.ip}</dd>
            <dt>Model</dt><dd>{info.model}</dd>
            <dt>Serial</dt><dd className="mono">{info.serial}</dd>
            <dt>Reader application</dt><dd>{info.versions.readerApplication ?? '—'}</dd>
            <dt>Radio firmware</dt><dd>{info.versions.radioFirmware ?? '—'}</dd>
            <dt>IoT Connector</dt><dd>{info.versions.cloudAgentApplication ?? '—'}</dd>
            <dt>Status</dt><dd>{statusSummary(info.status)}</dd>
          </dl>
          {info.paired_with && (
            <p className="page-hint">
              Already paired with <b>{pairedWithName(info.paired_with)}</b>. Pairing moves it to this kiosk.
            </p>
          )}
        </div>
      )}
      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack} disabled={busy}>Back</button>
        {error && !busy && (
          <button type="button" className="mini-btn" onClick={() => void connect()}>Try again</button>
        )}
        {info && !busy && (
          <button type="button" className="btn-solid" onClick={onPair}>Pair this reader</button>
        )}
      </div>
    </>
  );
}
