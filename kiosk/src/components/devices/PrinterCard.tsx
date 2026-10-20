/** Settings › Devices › Label printer: the Zebra printer this browser holds
 *  over WebUSB (`useZebraPrinter`). On opening it connects to the first
 *  printer the browser already allows, reads `~HI` and `~HS`, and re-reads
 *  `~HS` every 10 s (a failed read keeps the last answer and never throws).
 *  The pill is Ready, the first problem (amber), or Not connected; every
 *  problem also shows as a chip. Print test label, Refresh, Disconnect and
 *  Printer tools (only where Label Printing is reachable) when connected;
 *  Connect printer otherwise. Other allowed printers are listed to switch
 *  to. The hook releases the printer when the card unmounts, so the
 *  Printer tools page can claim it. Rows the printer doesn't report are
 *  hidden. */

import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { HostIdentification, HostStatus, UsbDeviceLike } from '@portal/labels/zebraUsb';

import { useDevMode } from '../../lib/devMode';
import { FEATURES, featureAvailable } from '../../lib/features';
import { getIdentity } from '../../lib/identity';
import { LABEL_SECTIONS } from '../../lib/labelSections';
import { useKioskSetupState } from '../../lib/setupState';
import { useZebraPrinter } from '../../lib/useZebraPrinter';
import { healthChips } from '../printers/PrinterHealth';
import DeviceCard, { type DevicePill } from './DeviceCard';

const STATUS_MS = 10_000;
const LABELS = FEATURES.find((f) => f.id === 'labels')!;
const PRINTER_TOOLS = LABEL_SECTIONS.find((s) => s.id === 'printers')!;

const READY: DevicePill = { label: 'Ready', tone: 'green' };
const NOT_CONNECTED: DevicePill = { label: 'Not connected', tone: 'slate' };
const CHECKING: DevicePill = { label: 'Checking…', tone: 'slate' };

/** In order: the first problem the printer reports names the pill. */
const PROBLEMS: [keyof HostStatus, string][] = [
  ['paperOut', 'Paper out'],
  ['ribbonOut', 'Ribbon out'],
  ['headOpen', 'Head open'],
  ['paused', 'Paused'],
  ['overTemp', 'Too hot'],
  ['underTemp', 'Too cold'],
];

function statusPill(status: HostStatus): DevicePill {
  const problem = PROBLEMS.find(([key]) => status[key] === true);
  return problem ? { label: problem[1], tone: 'amber' } : READY;
}

/** A field's text with ZPL's command prefixes (^ and ~) and control
 *  characters taken out, so a kiosk name can't end or alter the format. */
function zplText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\^~]/g, '-').replace(/[\x00-\x1f\x7f]/g, ' ');
}

/** A small test label: a border and three lines ("ServerSherpa test
 *  label", the kiosk name, the date and time). Laid out for a 2×1 in label
 *  at 203 dpi (406×203 dots) and scaled by dpi/203, so it fits any common
 *  label size. Long lines are clipped to one line by `^FB`. */
export function testLabelZpl(kioskName: string, when: Date, dpi: number): string {
  const d = (n: number) => Math.round((n * (dpi > 0 ? dpi : 203)) / 203);
  const width = d(406);
  const height = d(203);
  const margin = d(10);
  const pad = d(24);
  const textWidth = width - 2 * pad;
  const line = (y: number, size: number, text: string) =>
    `^FO${pad},${d(y)}^A0N,${d(size)},${d(size)}^FB${textWidth},1,0,L,0^FD${zplText(text)}^FS`;
  const stamp = when.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return [
    '^XA',
    '^CI28',
    `^PW${width}`,
    `^LL${height}`,
    '^LH0,0',
    `^FO${margin},${margin}^GB${width - 2 * margin},${height - 2 * margin},${d(3)}^FS`,
    line(30, 26, 'ServerSherpa test label'),
    line(74, 36, kioskName),
    line(134, 24, stamp),
    '^XZ',
  ].join('');
}

type Message = { ok: boolean; text: string } | null;

export default function PrinterCard() {
  const printer = useZebraPrinter();
  // The hook returns a new object every render; effects read the latest.
  const printerRef = useRef(printer);
  printerRef.current = printer;
  const { supported, connected } = printer;

  const [setupState] = useKioskSetupState();
  const [devMode] = useDevMode();
  // The station type hides nothing in Settings (Jimmy): only setup progress
  // and developer mode decide whether Label Printing opens.
  const labelsReachable = featureAvailable(LABELS, setupState, devMode);

  const [identity, setIdentity] = useState<HostIdentification | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [known, setKnown] = useState<UsbDeviceLike[]>([]);
  const [printing, setPrinting] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Every printer call goes through one chain, so no two overlap: a `~HI`
  // sent while a `~HS` is still out can read the `~HS` answer as its own.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useRef(<T,>(call: () => Promise<T>): Promise<T> => {
    const next = chain.current.then(call);
    chain.current = next.catch(() => undefined);
    return next;
  }).current;

  // On opening: connect to the first printer the browser already allows.
  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const list = await printerRef.current.knownDevices();
        if (cancelled) return;
        setKnown(list);
        if (!printerRef.current.connected && list.length > 0) await printerRef.current.connectTo(list[0]);
      } catch {
        // No allowed printers to offer; Connect printer still works.
      }
    })();
    return () => { cancelled = true; };
  }, [supported]);

  // While connected: `~HI` once, then `~HS` now and every 10 s. Each read
  // waits for the previous one; a failed read keeps the last answer.
  useEffect(() => {
    if (!connected) {
      setIdentity(null);
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    const pollStatus = async () => {
      if (cancelled) return;
      try {
        const s = await serial(() => printerRef.current.status());
        if (!cancelled && s) setStatus(s);
      } catch {
        // Keep the last status; the hook drops a lost connection itself.
      }
      if (!cancelled) timer = window.setTimeout(() => { void pollStatus(); }, STATUS_MS);
    };
    void (async () => {
      try {
        const id = await serial(() => printerRef.current.identify());
        if (!cancelled) setIdentity(id);
      } catch {
        // Identity rows stay hidden.
      }
      // A newly picked printer is now one of the allowed ones.
      try {
        const list = await printerRef.current.knownDevices();
        if (!cancelled) setKnown(list);
      } catch { /* keep the list */ }
      await pollStatus();
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connected, serial]);

  // Connect failures and unplugs from the hook show on the card.
  useEffect(() => {
    const n = printer.notice;
    if (!n) return;
    if (n.type === 'error' || n.type === 'warning') setMessage({ ok: false, text: n.message });
    printer.clearNotice();
  }, [printer.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    try {
      const id = await serial(() => printerRef.current.identify());
      if (alive.current) setIdentity(id);
      const s = await serial(() => printerRef.current.status());
      if (alive.current && s) setStatus(s);
    } catch (err) {
      if (alive.current) {
        setMessage({ ok: false, text: `Couldn’t read the printer: ${err instanceof Error ? err.message : 'no answer'}` });
      }
    }
  };

  const printTest = async () => {
    setPrinting(true);
    setMessage(null);
    try {
      const zpl = testLabelZpl(getIdentity().name, new Date(), identity?.dpi ?? 203);
      await serial(() => printerRef.current.send(zpl));
      if (alive.current) setMessage({ ok: true, text: 'Test label sent.' });
    } catch (err) {
      if (alive.current) {
        setMessage({ ok: false, text: `Couldn’t print the test label: ${err instanceof Error ? err.message : 'no answer'}` });
      }
    } finally {
      if (alive.current) setPrinting(false);
    }
  };

  const switchTo = (d: UsbDeviceLike) => {
    setMessage(null);
    void printer.connectTo(d);
  };

  if (!supported) {
    return (
      <DeviceCard
        title="Label printer"
        pill={NOT_CONNECTED}
        actions={<button type="button" className="mini-btn" disabled>Connect printer</button>}
      >
        <p className="page-hint">Use Chrome or Edge to connect a Zebra printer.</p>
      </DeviceCard>
    );
  }

  const pill = !connected ? NOT_CONNECTED : status ? statusPill(status) : CHECKING;

  const rows: { label: string; value: string; mono?: boolean }[] = [];
  if (connected) {
    const model = identity?.model || printer.productName;
    if (model) rows.push({ label: 'Model', value: model });
    if (identity?.firmware) rows.push({ label: 'Firmware', value: identity.firmware, mono: true });
    if (identity?.dpi) rows.push({ label: 'Resolution', value: `${identity.dpi} dpi` });
    rows.push({ label: 'Connection', value: 'USB' });
    if (status) rows.push({ label: 'Labels queued', value: String(status.formatsQueued) });
  }
  // Problems only: Ready is the pill, and the queue is its own row.
  const chips = connected
    ? healthChips(status).filter((c) => c.label !== 'Ready' && !c.label.endsWith('queued'))
    : [];
  const others = known.filter((d) => d !== printer.device);

  const actions = connected ? (
    <>
      <button type="button" className="mini-btn" disabled={printing} onClick={() => void printTest()}>
        Print test label
      </button>
      <button type="button" className="mini-btn" onClick={() => void refresh()}>Refresh</button>
      <button type="button" className="mini-btn" onClick={() => { setMessage(null); void printer.disconnect(); }}>
        Disconnect
      </button>
      {labelsReachable && <Link className="mini-btn" to={PRINTER_TOOLS.path}>Printer tools</Link>}
    </>
  ) : (
    <button type="button" className="mini-btn" onClick={() => { setMessage(null); void printer.connect(); }}>
      Connect printer
    </button>
  );

  return (
    <DeviceCard title="Label printer" pill={pill} actions={actions}>
      {connected ? (
        <dl className="local-kv">
          {rows.map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="page-hint">Connect a Zebra printer over USB. Make sure it&apos;s turned on first.</p>
      )}
      {chips.length > 0 && (
        <div className="device-chips">
          {chips.map((c) => (
            <span key={c.label} className={`chip ${c.tone}`}><span className="dot" />{c.label}</span>
          ))}
        </div>
      )}
      {message && (
        <p className={`device-check ${message.ok ? 'is-ok' : 'is-fail'}`} role="status">{message.text}</p>
      )}
      {others.length > 0 && (
        <p className="device-note">
          {connected ? 'Other printers' : 'Printers'} this browser can use:{' '}
          {others.map((d, i) => (
            <button key={i} type="button" className="mini-btn" onClick={() => switchTo(d)}>
              {d.productName || 'Zebra printer'}
            </button>
          ))}
          {' '}— tap to switch.
        </p>
      )}
    </DeviceCard>
  );
}
