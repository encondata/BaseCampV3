/**
 * The RFID Reader Dashboard (/rfid_status) — where Kiosk Setup's Start
 * Reader lands on a laptop RFID station. Six status tiles, the live tag
 * reads table (empty until a tag source is connected), the edge's event
 * log, and one big START / STOP pair. Reader status and events refresh 5 s
 * after the previous refresh settles (never overlapping); the clock ticks
 * every second. Web mode, or a laptop with no paired
 * reader, goes home.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { codeOf, readerErrorText } from '../components/setup/readerSetup';
import {
  getReaderStatus, getRfidEvents, startReader, stopReader,
  type ReaderStatus, type RfidEvent,
} from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { isLaptop } from '../lib/platform';
import { useSyncStatus } from '../lib/sync';

const POLL_MS = 5000;
const CLOCK_MS = 1000;

type ReaderState = 'loading' | 'reading' | 'stopped' | 'unreachable';

const STATE_TEXT: Record<ReaderState, string> = {
  loading: 'Checking…', reading: 'Reading', stopped: 'Stopped', unreachable: 'Unreachable',
};
const STATE_CHIP: Record<ReaderState, string> = {
  loading: 'c-slate', reading: 'c-green', stopped: 'c-slate', unreachable: 'c-red',
};

/** "Antennas 1 – 4" for a contiguous run, "Antennas 1, 3" otherwise. */
export function antennasLabel(antennas: string[]): string {
  if (antennas.length === 0) return 'No antennas connected';
  if (antennas.length === 1) return `Antenna ${antennas[0]}`;
  const nums = antennas.map(Number);
  const contiguous = nums.every((n, i) => Number.isInteger(n) && (i === 0 || n === nums[i - 1] + 1));
  return contiguous
    ? `Antennas ${antennas[0]} – ${antennas[antennas.length - 1]}`
    : `Antennas ${antennas.join(', ')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 24-hour HH:MM:SS, built by hand so no locale turns midnight into 24. */
function clockText(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dateText(d: Date): string {
  const day = d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value;
  return zone ? `${day} · ${zone}` : day;
}

function readerState(status: ReaderStatus | null, failed: boolean): ReaderState {
  if (failed) return 'unreachable';
  if (!status) return 'loading';
  if (status.reachable === false) return 'unreachable';
  return status.reading ? 'reading' : 'stopped';
}

// ── icons (inline, currentColor) ────────────────────────────────────
const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ICON = {
  tag: svg(<><path d="M3 12V4h8l10 10-8 8L3 12z" /><circle cx="7.5" cy="8.5" r="1.5" /></>),
  barcode: svg(<path d="M4 5v14M7 5v14M11 5v14M14 5v14M17 5v14M20 5v14" />),
  clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  sliders: svg(<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4" />),
  document: svg(<><path d="M6 3h8l4 4v14H6V3z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>),
  broadcast: svg(<><circle cx="12" cy="12" r="2" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" /></>),
  gear: svg(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>),
  wifi: svg(<><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19.5" r=".8" /></>),
  play: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5-13-7.5z" fill="currentColor" /></svg>
  ),
  square: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" /></svg>
  ),
};

function eventIcon(ev: RfidEvent): ReactNode {
  switch (ev.kind) {
    case 'portal_check_in':
      return /fail/i.test(ev.title)
        ? <span className="rfid-dash-dot is-red" />
        : <span className="rfid-dash-dot is-green" />;
    case 'reader_stopped': return <span className="rfid-dash-dot is-red" />;
    case 'reader_started': return ICON.gear;
    case 'scan_type_selected': return ICON.document;
    case 'move_loaded': return ICON.sliders;
    case 'reader_connected':
    case 'reader_paired': return ICON.wifi;
    default: return <span className="rfid-dash-dot" />;
  }
}

function Tile({ icon, label, value, sub, children }: {
  icon: ReactNode; label: string; value: ReactNode; sub: string; children?: ReactNode;
}) {
  return (
    <div className="rfid-dash-tile">
      <div className="rfid-dash-tile-head">
        <span className="rfid-dash-tile-icon">{icon}</span>
        <span className="rfid-dash-tile-label">{label}</span>
      </div>
      <div className="rfid-dash-tile-value">{value}</div>
      {children}
      <div className="rfid-dash-tile-sub">{sub}</div>
    </div>
  );
}

export default function RfidStatus() {
  const laptop = isLaptop();
  const [setup] = useKioskSetup();
  const sync = useSyncStatus();
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [events, setEvents] = useState<RfidEvent[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [actionError, setActionError] = useState<{ action: 'start' | 'stop'; err: unknown } | null>(null);
  const alive = useRef(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    // Only the newest request may write: a slow older answer is dropped.
    const id = ++seq.current;
    const latest = () => alive.current && id === seq.current;
    await Promise.all([
      getReaderStatus().then(
        (s) => {
          // Busy: the edge is mid-call; keep what's on screen.
          if (latest() && !s.busy) { setStatus(s); setStatusFailed(false); }
        },
        () => { if (latest()) setStatusFailed(true); },
      ),
      // A failed events fetch keeps the last list on screen.
      getRfidEvents().then(
        (r) => { if (latest()) setEvents(r.events); },
        () => {},
      ),
    ]);
  }, []);

  useEffect(() => {
    if (!laptop) return undefined;
    alive.current = true;
    let timer: number | undefined;
    const tick = async () => {
      await refresh();
      if (alive.current) timer = window.setTimeout(() => { void tick(); }, POLL_MS);
    };
    void tick();
    const clock = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => {
      alive.current = false;
      window.clearTimeout(timer);
      window.clearInterval(clock);
    };
  }, [laptop, refresh]);

  if (!laptop) return <Navigate to="/" replace />;
  if (status && status.reader === null) return <Navigate to="/" replace />;

  const state = readerState(status, statusFailed);
  const reader = status?.reader ?? null;
  const unreachable = state === 'unreachable';
  const reading = state === 'reading';

  const runAction = async (action: 'start' | 'stop') => {
    setBusy(action);
    setActionError(null);
    try {
      await (action === 'start' ? startReader() : stopReader());
    } catch (err) {
      if (alive.current) setActionError({ action, err });
    }
    await refresh();
    if (alive.current) setBusy(null);
  };

  const startSub = busy === 'start' ? 'Starting…'
    : unreachable ? 'Reader unreachable'
      : reading ? 'Already reading' : 'Start RFID reader';
  const stopSub = busy === 'stop' ? 'Stopping…'
    : unreachable ? 'Reader unreachable'
      : state === 'stopped' ? 'Already stopped' : 'Stop RFID reader';
  const startDisabled = busy !== null || state === 'loading' || unreachable || reading;
  const stopDisabled = busy !== null || state === 'loading' || unreachable || !reading;

  const assets = sync.assets;
  const antennas = status?.antennas ?? [];
  const readerSub = reader
    ? `${reader.model} · ${antennasLabel(antennas)}`
    : antennasLabel(antennas);

  const pill = (testId?: string) => (
    <span className={`chip ${STATE_CHIP[state]}`} data-testid={testId}>
      <span className="dot" />{STATE_TEXT[state]}
    </span>
  );

  return (
    <div className="portal-page rfid-dash">
      <div className="rfid-dash-head">
        <div>
          <h1 className="page-title">RFID Reader Dashboard</h1>
          <p className="page-hint">Live asset reads and reader activity.</p>
        </div>
        <div className="rfid-dash-pill">{pill('rfid-dash-pill')}</div>
      </div>

      <div className="rfid-dash-tiles">
        <Tile icon={ICON.tag} label="Tags read today" value="—" sub="Waiting for tag data" />
        <Tile icon={ICON.barcode} label="Move progress"
              value={`— / ${assets === undefined ? '—' : assets}`} sub="Waiting for tag data">
          <div className="rfid-dash-bar" role="progressbar" aria-label="Move progress"
               aria-valuemin={0} aria-valuemax={assets ?? 0} aria-valuenow={0}>
            <span style={{ width: '0%' }} />
          </div>
        </Tile>
        <Tile icon={ICON.clock} label="Local time"
              value={<span className="mono">{clockText(now)}</span>} sub={dateText(now)} />
        <Tile icon={ICON.sliders} label="Active move" value={setup?.initiativeName ?? '—'}
              sub={setup ? `${setup.siteName} (${setup.siteRole})` : 'Finish Kiosk Setup first'} />
        <Tile icon={ICON.document} label="Scan type" value={setup?.scanLabel ?? '—'}
              sub="Station: RFID · Laptop" />
        <Tile icon={ICON.broadcast} label="Reader status"
              value={<span className={`rfid-dash-state is-${state}`}><span className="rfid-dash-dot" />{STATE_TEXT[state]}</span>}
              sub={readerSub} />
      </div>

      <div className="rfid-dash-panels">
        <section className="rfid-dash-panel rfid-dash-reads" aria-labelledby="rfid-dash-reads-title">
          <h2 id="rfid-dash-reads-title" className="rfid-dash-panel-title">Live Tag Reads</h2>
          <p className="rfid-dash-panel-sub">Newest first.</p>
          <div className="local-table-wrap">
            <table className="local-table rfid-dash-table">
              <thead>
                <tr>
                  <th>Tag ID</th>
                  <th>Serial Number</th>
                  <th>Computer Name</th>
                  <th>Make / Model</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={4} className="rfid-dash-empty">
                    No tag reads yet — live reads arrive when tag data is connected.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="rfid-dash-foot">Live view only · Older rows leave this screen.</p>
        </section>

        <section className="rfid-dash-panel rfid-dash-events" aria-labelledby="rfid-dash-events-title">
          <h2 id="rfid-dash-events-title" className="rfid-dash-panel-title">System Events</h2>
          <p className="rfid-dash-panel-sub">Live activity.</p>
          {events !== null && events.length === 0 && (
            <p className="rfid-dash-empty">No activity yet.</p>
          )}
          {events !== null && events.length > 0 && (
            <ul className="rfid-dash-event-list">
              {events.map((ev) => (
                <li key={ev.id} className="rfid-dash-event">
                  <span className="rfid-dash-event-icon">{eventIcon(ev)}</span>
                  <span className="rfid-dash-event-time mono">{clockText(new Date(ev.at))}</span>
                  <span className="rfid-dash-event-body">
                    <b data-testid="rfid-event-title">{ev.title}</b>
                    {ev.detail && <span className="rfid-dash-event-detail">{ev.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="rfid-dash-actions">
        <button type="button" className="rfid-dash-btn is-start" aria-label="Start RFID reader"
                disabled={startDisabled} onClick={() => void runAction('start')}>
          <span className="rfid-dash-btn-icon">{ICON.play}</span>
          <span className="rfid-dash-btn-text">
            <span className="rfid-dash-btn-title">START</span>
            <span className="rfid-dash-btn-sub">{startSub}</span>
          </span>
        </button>
        <button type="button" className="rfid-dash-btn is-stop" aria-label="Stop RFID reader"
                disabled={stopDisabled} onClick={() => void runAction('stop')}>
          <span className="rfid-dash-btn-icon">{ICON.square}</span>
          <span className="rfid-dash-btn-text">
            <span className="rfid-dash-btn-title">STOP</span>
            <span className="rfid-dash-btn-sub">{stopSub}</span>
          </span>
        </button>
      </div>
      {actionError && (
        <p className="form-error" role="alert">
          {readerErrorText(actionError.err, reader?.ip ?? '')
            ?? `Couldn't ${actionError.action} the reader (${codeOf(actionError.err)}).`}
        </p>
      )}
    </div>
  );
}
