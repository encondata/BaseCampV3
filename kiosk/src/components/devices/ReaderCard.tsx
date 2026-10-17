/** Settings › Devices › RFID reader. On a laptop: the paired reader's pill
 *  (Reading / Standby / Offline / Not paired / Checking…), its details from
 *  `/edge/rfid/status` (every 5 s) and `/edge/rfid/device` (every 30 s),
 *  Check reader, and Open RFID dashboard on an RFID Station. A busy edge
 *  (mid-call with the reader) reads Checking…, never Offline. Off a laptop
 *  the card is a note and makes no edge calls. Rows the edge can't fill are
 *  hidden. */

import { ageText, fullDateTime } from '@portal/lib/format';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  getReaderDevice, getReaderStatus, runCheck,
  type CheckResult, type ReaderDevice, type ReaderStatus,
} from '../../lib/api';
import { useKioskSetup } from '../../lib/kioskSetup';
import { isLaptop } from '../../lib/platform';
import { antennasLabel, readerState, type ReaderState } from '../../pages/RfidStatus';
import DeviceCard, { type DevicePill } from './DeviceCard';

const STATUS_MS = 5000;
const DEVICE_MS = 30_000;

const PILLS: Record<ReaderState, DevicePill> = {
  loading: { label: 'Checking…', tone: 'slate' },
  reading: { label: 'Reading', tone: 'green' },
  stopped: { label: 'Standby', tone: 'slate' },
  unreachable: { label: 'Offline', tone: 'red' },
};
const NOT_PAIRED: DevicePill = { label: 'Not paired', tone: 'slate' };

function known<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined && v !== '';
}

/** "5 minutes ago", or "just now". */
function agoText(iso: string, nowMs: number): string {
  const age = ageText(iso, nowMs);
  return age === 'just now' ? age : `${age} ago`;
}

type CheckView = { kind: 'result'; result: CheckResult } | { kind: 'error' } | null;

export default function ReaderCard() {
  const laptop = isLaptop();
  const navigate = useNavigate();
  const [setup] = useKioskSetup();
  // The latest real (non-busy) status; a busy answer keeps it on screen.
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // From the latest status answer, busy or not: is a reader paired?
  const [paired, setPaired] = useState<boolean | null>(null);
  const [device, setDevice] = useState<ReaderDevice | null>(null);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckView>(null);
  const alive = useRef(true);

  useEffect(() => {
    if (!laptop) return undefined;
    alive.current = true;
    let statusTimer: number | undefined;
    let deviceTimer: number | undefined;
    // Each poll waits for the previous one to settle, so calls never overlap.
    const pollStatus = async () => {
      try {
        const s = await getReaderStatus();
        if (!alive.current) return;
        setFailed(false);
        setPaired(s.reader !== null);
        if (s.busy) {
          setBusy(true);
        } else {
          setBusy(false);
          setStatus(s);
        }
      } catch {
        if (!alive.current) return;
        setBusy(false);
        setFailed(true);
      }
      if (alive.current) statusTimer = window.setTimeout(() => { void pollStatus(); }, STATUS_MS);
    };
    const pollDevice = async () => {
      try {
        const d = await getReaderDevice();
        if (alive.current) setDevice(d);
      } catch {
        // Keep the last details on screen; the status poll reports Offline.
      }
      if (alive.current) deviceTimer = window.setTimeout(() => { void pollDevice(); }, DEVICE_MS);
    };
    void pollStatus();
    void pollDevice();
    return () => {
      alive.current = false;
      window.clearTimeout(statusTimer);
      window.clearTimeout(deviceTimer);
    };
  }, [laptop]);

  if (!laptop) {
    return (
      <DeviceCard title="RFID reader" pill={null}>
        <p className="page-hint">RFID readers connect to a laptop RFID Station.</p>
      </DeviceCard>
    );
  }

  const notPaired = paired === false || (paired === null && device?.reader === null);
  const pill = failed ? PILLS.unreachable
    : notPaired ? NOT_PAIRED
      : busy ? PILLS.loading
        : PILLS[readerState(status, false)];

  const runReaderCheck = async () => {
    setChecking(true);
    try {
      const result = await runCheck('reader');
      if (alive.current) setCheck({ kind: 'result', result });
    } catch {
      if (alive.current) setCheck({ kind: 'error' });
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const now = Date.now();
  const rows: { label: string; value: string; title?: string; mono?: boolean }[] = [];
  if (!notPaired) {
    const pairing = device?.reader ?? null;
    const live = status?.reader ?? null;
    const snap = device?.snapshot ?? null;

    const model = snap?.model || pairing?.model || live?.model;
    if (known(model)) {
      const make = snap?.make;
      const withMake = known(make) && !model.toLowerCase().startsWith(make.toLowerCase());
      rows.push({ label: 'Model', value: withMake ? `${make} ${model}` : model });
    }
    const serial = pairing?.serial || live?.serial || snap?.serial;
    if (known(serial)) rows.push({ label: 'Serial', value: serial, mono: true });
    const ip = live?.ip || pairing?.ip || snap?.ip;
    if (known(ip)) rows.push({ label: 'Address', value: ip, mono: true });
    if (known(snap?.firmware)) rows.push({ label: 'Firmware', value: snap.firmware, mono: true });

    const ports = status?.antennas ?? [];
    const connected = ports.length > 0 ? ports.length : snap?.antennas_connected;
    const total = snap?.antennas_total;
    if (known(connected) && known(total)) {
      rows.push({
        label: 'Antennas',
        value: `${connected} of ${total} connected${ports.length > 0 ? ` (${ports.join(', ')})` : ''}`,
      });
    } else if (ports.length > 0) {
      rows.push({ label: 'Antennas', value: antennasLabel(ports) });
    } else if (known(connected)) {
      rows.push({ label: 'Antennas', value: `${connected} connected` });
    }

    if (known(device?.last_read_at)) {
      const at = device.last_read_at;
      rows.push({ label: 'Last tag read', value: agoText(at, now), title: fullDateTime(at) });
    }
    if (known(snap?.tags_24h)) {
      rows.push({ label: 'Tags, last 24 h', value: snap.tags_24h.toLocaleString('en-US') });
    }
    if (known(snap?.uptime_seconds)) {
      const asOf = known(snap.taken_at) ? Date.parse(snap.taken_at) : now;
      const since = new Date((Number.isNaN(asOf) ? now : asOf) - snap.uptime_seconds * 1000).toISOString();
      const age = ageText(since, now);
      rows.push({
        label: 'Up for',
        value: age === 'just now' ? 'under a minute' : age,
        title: `Since ${fullDateTime(since)}`,
      });
    }
    if (known(pairing?.paired_at)) {
      const at = pairing.paired_at;
      rows.push({ label: 'Paired', value: agoText(at, now), title: fullDateTime(at) });
    }
  }

  const actions = notPaired ? undefined : (
    <>
      <button type="button" className="mini-btn" disabled={checking}
              onClick={() => void runReaderCheck()}>
        Check reader
      </button>
      {setup?.stationType === 'rfid' && (
        <button type="button" className="mini-btn" onClick={() => navigate('/rfid_status')}>
          Open RFID dashboard
        </button>
      )}
    </>
  );

  return (
    <DeviceCard title="RFID reader" pill={pill} actions={actions}>
      {notPaired && (
        <p className="page-hint">No reader is paired with this laptop. Pair one in Kiosk Setup.</p>
      )}
      {rows.length > 0 && (
        <dl className="local-kv device-kv">
          {rows.map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd className={r.mono ? 'mono' : undefined} title={r.title}>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {checking && <p className="device-check" role="status">Checking the reader…</p>}
      {!checking && check && (
        <p className={`device-check${check.kind === 'result' && check.result.ok ? ' is-ok' : ' is-fail'}`}
           role="status">
          {check.kind === 'error'
            ? 'Couldn’t run the reader check. Try again.'
            : `${check.result.ok ? '✓ Reader check passed' : '✗ Reader check failed'}${
              check.result.detail ? ` — ${check.result.detail}` : ''}`}
        </p>
      )}
    </DeviceCard>
  );
}
