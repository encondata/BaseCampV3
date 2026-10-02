/**
 * Select reader: on entering, the edge scans this laptop's subnets for FX
 * readers; the step polls the scan every second while it runs, with a
 * progress bar, and lists readers as they turn up. A reader another kiosk
 * holds says so on its card. "Scan again" restarts the scan; "Enter IP
 * manually" takes a reader's address directly. When the laptop's own
 * address isn't known the scan can't run, so the step explains and asks
 * for both the reader's and the laptop's IP instead.
 */

import { useEffect, useState } from 'react';

import { getReaderScan, startReaderScan, type ReaderScan } from '../../lib/api';
import ManualAddressForm from './ManualAddressForm';
import { scanErrorText } from './readerSetup';

export const SCAN_POLL_MS = 1000;

interface Props {
  selectedIp: string;
  onPick: (readerIp: string, laptopIp?: string) => void;
  onBack: () => void;
}

export default function ReaderStep({ selectedIp, onPick, onBack }: Props) {
  const [scan, setScan] = useState<ReaderScan | null>(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState(0);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setScan(null);
    setError('');
    const poll = async () => {
      try {
        const next = await getReaderScan();
        if (cancelled) return;
        setScan(next);
        if (next.state === 'running') timer = setTimeout(() => void poll(), SCAN_POLL_MS);
      } catch (err) {
        if (!cancelled) setError(scanErrorText(err));
      }
    };
    startReaderScan().then(
      () => { if (!cancelled) void poll(); },
      (err) => { if (!cancelled) setError(scanErrorText(err)); },
    );
    return () => { cancelled = true; clearTimeout(timer); };
  }, [run]);

  const hostUnknown = scan !== null && !scan.host.fresh;
  const running = scan?.state === 'running';
  const readers = scan?.readers ?? [];

  return (
    <>
      <h2>Select a reader</h2>

      {error && <p className="form-error" role="alert">{error}</p>}
      {!error && scan === null && <p className="page-hint">Starting the scan…</p>}

      {hostUnknown && (
        <>
          <p className="page-hint">
            This laptop&apos;s network address isn&apos;t known yet, so this network can&apos;t
            be scanned. Re-run the installer (or wait a minute), or enter the reader&apos;s and
            this laptop&apos;s IP below.
          </p>
          <ManualAddressForm initialReaderIp={selectedIp} withLaptopIp onSubmit={onPick} />
        </>
      )}

      {running && scan && (
        <>
          <div className="rgm-progress-track" role="progressbar" aria-label="Scan progress"
               aria-valuemin={0} aria-valuemax={scan.total} aria-valuenow={scan.probed}>
            <div className="rgm-progress-fill"
                 style={{ width: `${scan.total ? Math.round((scan.probed / scan.total) * 100) : 0}%` }} />
          </div>
          <p className="page-hint">
            Scanning this network… {scan.probed} of {scan.total} addresses checked
          </p>
        </>
      )}

      {!hostUnknown && scan?.state === 'failed' && (
        <p className="form-error" role="alert">
          The scan couldn&apos;t finish. Scan again, or enter the reader&apos;s IP.
        </p>
      )}

      {readers.length > 0 && (
        <div className="setup-cards" role="listbox" aria-label="Readers">
          {readers.map((r) => (
            <button key={r.ip} type="button" role="option" aria-selected={selectedIp === r.ip}
                    className="setup-card" onClick={() => onPick(r.ip)}>
              <div className="setup-card-role">{r.model}</div>
              <div className="setup-card-title">{r.ip}</div>
              <div className="setup-card-meta">Serial {r.serial}</div>
              {r.paired_with && (
                <div className="setup-card-meta">{`Already paired with ${r.paired_with}`}</div>
              )}
            </button>
          ))}
        </div>
      )}

      {scan?.state === 'done' && readers.length === 0 && (
        <p className="page-hint">
          No FX readers found on this network. Check the reader is powered on and on the same
          network, then scan again — or enter its IP.
        </p>
      )}

      {manual && !hostUnknown && (
        <ManualAddressForm initialReaderIp={selectedIp} withLaptopIp={false} onSubmit={onPick} />
      )}

      <div className="pf-form-actions">
        <button type="button" className="mini-btn" onClick={onBack}>Back</button>
        <button type="button" className="mini-btn" onClick={() => setRun((n) => n + 1)}>
          Scan again
        </button>
        {!manual && !hostUnknown && (
          <button type="button" className="mini-btn" onClick={() => setManual(true)}>
            Enter IP manually
          </button>
        )}
      </div>
    </>
  );
}
