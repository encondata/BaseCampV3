/**
 * Pair: the edge points the reader's IoT Connector data endpoint at this
 * laptop and reads the config back to confirm it. A reader another kiosk
 * holds asks first (TakeoverModal); Cancel there goes back to Connect.
 * When the laptop's own address isn't known, or none is on the reader's
 * subnet, the step asks for the reader's and the laptop's IP (that goes
 * back through Connect). The
 * result is held by the wizard, so coming Back here doesn't pair again.
 */

import { useEffect, useRef, useState } from 'react';

import { ApiError, pairReader, type PairResult } from '../../lib/api';
import ManualAddressForm from './ManualAddressForm';
import TakeoverModal from './TakeoverModal';
import { LAPTOP_IP_CODES, pairErrorText } from './readerSetup';

interface Props {
  ip: string;
  laptopIp: string;
  result: PairResult | null;
  onResult: (result: PairResult) => void;
  onContinue: () => void;
  onBack: () => void;
  /** Takeover declined: back to Connect. */
  onCancel: () => void;
  /** Addresses typed in after `host_network_unknown` / `reader_not_on_subnet`. */
  onManual: (readerIp: string, laptopIp?: string) => void;
}

export default function PairStep({
  ip, laptopIp, result, onResult, onContinue, onBack, onCancel, onManual,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hostUnknown, setHostUnknown] = useState(false);
  const [takeover, setTakeover] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const pair = async (confirmTakeover: boolean) => {
    setBusy(true);
    setError('');
    setHostUnknown(false);
    setTakeover(null);
    try {
      const next = await pairReader({
        ip,
        ...(laptopIp ? { laptop_ip: laptopIp } : {}),
        ...(confirmTakeover ? { confirm_takeover: true } : {}),
      });
      if (alive.current) onResult(next);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.code === 'reader_paired_elsewhere') {
        const name = (err.detail as { name?: unknown } | undefined)?.name;
        setTakeover(typeof name === 'string' && name ? name : 'another kiosk');
      } else {
        setHostUnknown(err instanceof ApiError && LAPTOP_IP_CODES.includes(err.code));
        setError(pairErrorText(err, ip));
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current || result) return;
    started.current = true;
    void pair(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h2>Pair the reader</h2>
      {busy && <p className="page-hint">Pairing the reader at {ip} with this laptop…</p>}
      {result && !busy && (
        <div className="setup-summary">
          <p role="status">
            {`Paired with ${result.reader.model} ${result.reader.serial} at ${result.reader.ip}`}
          </p>
          <p className="page-hint">Tag data endpoint: <span className="mono">{result.endpoint_url}</span></p>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {hostUnknown && <ManualAddressForm initialReaderIp={ip} withLaptopIp onSubmit={onManual} />}
      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack} disabled={busy}>Back</button>
        {error && !busy && (
          <button type="button" className="mini-btn" onClick={() => void pair(false)}>Try again</button>
        )}
        {result && !busy && (
          <button type="button" className="btn-solid" onClick={onContinue}>Continue</button>
        )}
      </div>
      {takeover && (
        <TakeoverModal otherKiosk={takeover}
                       onConfirm={() => void pair(true)}
                       onCancel={() => { setTakeover(null); onCancel(); }} />
      )}
    </>
  );
}
