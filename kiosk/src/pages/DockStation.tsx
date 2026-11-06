/**
 * The Dock screen (/dock) — where a Dock laptop's Home tile and Kiosk Setup
 * land, and what someone on the dock watches while tuning: the reader's
 * state (Reading, Paused or Stopped) with Start, Pause and Stop; the pass
 * still open, filling in live with the time left before it is decided; the
 * newest closed passes with their outcome, each opening its full detail;
 * and the dry-run switch and the crate Window, both saved on the laptop's
 * edge. It fills the screen like the RFID Reader dashboard, whose panels,
 * state and buttons it reuses, in the kiosk's light or dark theme; both
 * panels show only the rows that fit. The overview refreshes 1 s after the
 * previous refresh settles (never overlapping); while refreshes fail, a red
 * line says the station can't be reached and the last overview stays under
 * it. The reader is checked 5 s after the previous check settles and right
 * after each button's call. Web mode, or a setup that isn't a Dock, goes
 * home; a new laptop browser with no setup yet shows nothing until the
 * laptop's has loaded (KioskShell looks for it), then decides.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';

import DockPassModal, { passOutcome } from '../components/DockPassModal';
import { codeOf, readerErrorText } from '../components/setup/readerSetup';
import { Switch } from '../components/Switch';
import {
  controlDock, getDock, getReaderStatus, saveDockSettings,
  type DockControl, type DockOverview, type DockPassRow, type DockSettings, type DockTag,
  type DockTagKind, type ReaderStatus,
} from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { useLaptopSetupSettled } from '../lib/laptopSetup';
import { isLaptop } from '../lib/platform';
import { readerState, type ReaderState } from '../lib/readerState';
import { useFitRows } from '../lib/useFitRows';
import { clockText, displayEpc, ICON } from './RfidStatus';

const POLL_MS = 1000;
const READER_POLL_MS = 5000;
const WINDOW_MIN = 1;
const WINDOW_MAX = 60;

const BUSY_TEXT: Record<DockControl, string> = {
  start: 'Starting…', pause: 'Pausing…', stop: 'Stopping…',
};

/** The reader's state as the strip shows it: a running call first, then
 *  the reader's own state, where a stopped reader reads Paused when Pause
 *  was the last button. */
function readerText(state: ReaderState, control: DockControl | null, busy: DockControl | null): {
  text: string; tone: 'reading' | 'paused' | 'stopped' | 'unreachable' | 'loading';
} {
  if (busy) return { text: BUSY_TEXT[busy], tone: 'loading' };
  switch (state) {
    case 'loading': return { text: 'Checking…', tone: 'loading' };
    case 'unreachable': return { text: 'Unreachable', tone: 'unreachable' };
    case 'reading': return { text: 'Reading', tone: 'reading' };
    default:
      return control === 'pause' ? { text: 'Paused', tone: 'paused' } : { text: 'Stopped', tone: 'stopped' };
  }
}

/** A tag's kind as a chip: its word and color. */
function kindChip(kind: DockTagKind): { label: string; tone: string } {
  switch (kind) {
    case 'container': return { label: 'Crate', tone: 'c-blue' };
    case 'asset': return { label: 'Asset', tone: 'c-green' };
    case 'person': return { label: 'Person', tone: 'c-slate' };
    case 'off_move': return { label: 'Off-move', tone: 'c-red' };
    default: return { label: 'Unknown', tone: 'tag' };
  }
}

/** The open pass's tags as listed: crates first (the pass's destination is
 *  never the row cut off), then everything else newest first (so a tag just
 *  read isn't either). */
function listedTags(tags: DockTag[]): DockTag[] {
  return [...tags.filter((t) => t.kind === 'container'),
    ...tags.filter((t) => t.kind !== 'container').reverse()];
}

/** A whole number of seconds in range, or null. */
function parseWindow(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= WINDOW_MIN && n <= WINDOW_MAX ? n : null;
}

function countdownText(secondsLeft: number): string {
  const s = Math.ceil(secondsLeft);
  return s > 0 ? `Closes in ${s} s` : 'Closing…';
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** No crate (or several), or the portal turned the pass away. */
const standsOut = (p: DockPassRow) => p.status === 'flagged' || p.status === 'refused';

export default function DockStation() {
  const [setup] = useKioskSetup();
  const setupSettled = useLaptopSetupSettled();
  const laptop = isLaptop();
  const dock = laptop && setup?.stationType === 'dock';
  const [overview, setOverview] = useState<DockOverview | null>(null);
  const [settings, setSettings] = useState<DockSettings | null>(null);
  /** The Window as typed; null shows the saved value. */
  const [windowDraft, setWindowDraft] = useState<string | null>(null);
  const [windowInvalid, setWindowInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  /** The last refresh failed; cleared by the next one that works. */
  const [unreachable, setUnreachable] = useState(false);
  const [status, setStatus] = useState<ReaderStatus | null>(null);
  /** The last reader check failed; cleared by the next one that works. */
  const [statusFailed, setStatusFailed] = useState(false);
  /** The last Dock button: pressed here, or as the overview has it. */
  const [control, setControl] = useState<DockControl | null>(null);
  /** The button whose call is running (the newest press). */
  const [busy, setBusy] = useState<DockControl | null>(null);
  /** The newest press's failure, shown until the next press. */
  const [controlError, setControlError] = useState<{ action: DockControl; err: unknown } | null>(null);
  const mounted = useRef(true);
  // Bumped when a settings save starts and again when it settles: a refresh
  // that began before either keeps its passes but not its settings, which
  // may predate the save.
  const settingsGen = useRef(0);
  // The same for a button press and the overview's control.
  const controlGen = useRef(0);
  // Only the newest reader check writes, and only the newest press clears
  // the running state or shows its error.
  const checkSeq = useRef(0);
  const pressSeq = useRef(0);
  // A Stop call is running: another Stop press does nothing.
  const stopping = useRef(false);
  const tagsBox = useRef<HTMLUListElement>(null);
  const passesBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Asks the edge for the reader's state while `live()`. A busy answer
   *  (the edge was mid-call and didn't ask the reader) keeps what's shown,
   *  as on the RFID dashboard. */
  const checkReader = useCallback(async (live: () => boolean) => {
    const id = ++checkSeq.current;
    const latest = () => live() && id === checkSeq.current;
    try {
      const s = await getReaderStatus();
      if (latest() && !s.busy) {
        setStatus(s);
        setStatusFailed(false);
      }
    } catch {
      if (latest()) setStatusFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!dock) return undefined;
    // This run's own flag, not a shared ref: a run that was cleaned up (a
    // StrictMode double mount, an unmount) never writes or schedules again.
    let live = true;
    let timer: number | undefined;
    const tick = async () => {
      const gen = settingsGen.current;
      const pressGen = controlGen.current;
      try {
        const o = await getDock();
        if (!live) return;
        setOverview(o);
        setUnreachable(false);
        if (gen === settingsGen.current) setSettings(o.settings);
        if (pressGen === controlGen.current) setControl(o.control);
      } catch {
        // The last overview stays on screen, under a line saying it's stale.
        if (!live) return;
        setUnreachable(true);
      }
      timer = window.setTimeout(() => { void tick(); }, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [dock]);

  useEffect(() => {
    if (!dock) return undefined;
    // Its own flag, as the overview's loop: one loop under StrictMode.
    let live = true;
    let timer: number | undefined;
    const tick = async () => {
      await checkReader(() => live);
      if (live) timer = window.setTimeout(() => { void tick(); }, READER_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [dock, checkReader]);

  useFitRows(tagsBox, [overview]);
  useFitRows(passesBox, [overview]);

  const closeDetail = useCallback(() => setDetailId(null), []);

  if (laptop && setup === null && !setupSettled) return null;   // the laptop's may be on its way
  if (!dock) return <Navigate to="/" replace />;

  /** Saves one setting; true when the edge took it. */
  const save = async (next: Partial<DockSettings>): Promise<boolean> => {
    settingsGen.current += 1;
    setSaving(true);
    setSaveFailed(false);
    let ok = false;
    try {
      const saved = await saveDockSettings(next);
      if (mounted.current) setSettings(saved);
      ok = true;
    } catch {
      if (mounted.current) setSaveFailed(true);
    }
    settingsGen.current += 1;
    if (mounted.current) setSaving(false);
    return ok;
  };

  const windowChanged = settings !== null && windowDraft !== null
    && windowDraft.trim() !== String(settings.quiet_gap_s);

  const saveWindow = async () => {
    if (windowDraft === null || !windowChanged || saving) return;
    const n = parseWindow(windowDraft);
    if (n === null) {
      setWindowInvalid(true);
      return;
    }
    if (await save({ quiet_gap_s: n }) && mounted.current) setWindowDraft(null);
  };

  /** Presses a reader button, then checks the reader before the state goes
   *  back to the reader's own. Stop runs even while another call does (a
   *  stuck reader needs it), but never twice at once. */
  const press = async (action: DockControl) => {
    if (action === 'stop' && stopping.current) return;
    if (action === 'stop') stopping.current = true;
    const id = ++pressSeq.current;
    const newest = () => mounted.current && id === pressSeq.current;
    controlGen.current += 1;
    setControl(action);
    setBusy(action);
    setControlError(null);
    try {
      await controlDock(action);
    } catch (err) {
      if (newest()) setControlError({ action, err });
    }
    controlGen.current += 1;
    await checkReader(() => mounted.current);
    if (action === 'stop') stopping.current = false;
    if (newest()) setBusy(null);
  };

  const state = readerState(status, statusFailed);
  const shown = readerText(state, control, busy);
  const startDisabled = busy !== null || state === 'loading' || state === 'unreachable'
    || state === 'reading';
  const pauseDisabled = busy !== null || state !== 'reading';

  const open = overview?.open ?? null;
  const passes = overview?.passes ?? null;

  return (
    <div className="portal-page rfid-dash dock-dash">
      <h1 className="sr-only">Dock</h1>

      <div className="dock-dash-controls">
        {/* Outside the settings below, so Stop works before they load. */}
        <div className="dock-dash-reader" role="group" aria-label="Reader">
          <span className={`rfid-dash-state is-${shown.tone}`}>
            <span className="rfid-dash-dot" />{shown.text}
          </span>
          <button type="button" className="rfid-dash-btn is-start" disabled={startDisabled}
                  onClick={() => void press('start')}>
            <span className="rfid-dash-btn-icon">{ICON.play}</span>
            <span className="rfid-dash-btn-title">Start</span>
          </button>
          <button type="button" className="rfid-dash-btn is-pause" disabled={pauseDisabled}
                  onClick={() => void press('pause')}>
            <span className="rfid-dash-btn-icon">{ICON.pause}</span>
            <span className="rfid-dash-btn-title">Pause</span>
          </button>
          {/* Never disabled: a reader can get stuck. */}
          <button type="button" className="rfid-dash-btn is-stop" onClick={() => void press('stop')}>
            <span className="rfid-dash-btn-icon">{ICON.square}</span>
            <span className="rfid-dash-btn-title">Stop</span>
          </button>
        </div>
        {/* Disabled until the edge's settings arrive: before that a change
            would be made against defaults. */}
        <fieldset className="dock-dash-settings" disabled={settings === null}>
          <legend className="sr-only">Dock settings</legend>
          <div className="dock-dash-control">
            <div>
              <span className="settings-row-label">Dry run</span>
              <p className="settings-row-hint">Passes are shown here and nothing is sent to the portal.</p>
            </div>
            <Switch on={settings?.dry_run ?? true} aria-label="Dry run"
                    onChange={(on) => { if (!saving) void save({ dry_run: on }); }} />
          </div>
          <div className="dock-dash-control">
            <div>
              <label htmlFor="dock-window" className="settings-row-label">Window</label>
              <p id="dock-window-hint"
                 className={windowInvalid ? 'settings-row-hint form-error' : 'settings-row-hint'}>
                {windowInvalid ? '1–60 seconds' : 'Seconds before and after the crate tag'}
              </p>
            </div>
            <span className="alarm-seconds">
              <input
                id="dock-window"
                type="number"
                inputMode="numeric"
                min={WINDOW_MIN}
                max={WINDOW_MAX}
                step={1}
                aria-describedby="dock-window-hint"
                aria-invalid={windowInvalid || undefined}
                value={windowDraft ?? (settings ? String(settings.quiet_gap_s) : '')}
                onChange={(e) => { setWindowDraft(e.target.value); setWindowInvalid(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveWindow(); }}
              />
              <span className="alarm-seconds-unit">s</span>
              <button type="button" className="mini-btn" disabled={!windowChanged || saving}
                      onClick={() => void saveWindow()}>
                Save
              </button>
            </span>
          </div>
        </fieldset>
        {saveFailed && <p className="form-error" role="alert">Couldn&apos;t save. Try again.</p>}
        {controlError && (
          <p className="form-error" role="alert">
            {readerErrorText(controlError.err, status?.reader?.ip ?? '')
              ?? `Couldn't ${controlError.action} the reader (${codeOf(controlError.err)}).`}
          </p>
        )}
      </div>

      {settings?.dry_run && (
        <p className="dock-dash-banner" role="status">Dry run · nothing is sent to the portal.</p>
      )}
      {/* The RFID dashboard's Unreachable look: red, with its dot. */}
      {unreachable && (
        <p className="rfid-dash-state is-unreachable dock-dash-unreachable" role="alert">
          <span className="rfid-dash-dot" />Can&apos;t reach the station. Retrying…
        </p>
      )}

      <div className="rfid-dash-panels dock-dash-panels">
        <section className="rfid-dash-panel" aria-labelledby="dock-open-title">
          <h2 id="dock-open-title" className="rfid-dash-panel-title">Open pass</h2>
          {overview === null && <p className="rfid-dash-empty">Checking…</p>}
          {overview !== null && open === null && (
            <p className="rfid-dash-empty">Waiting for tags…</p>
          )}
          {open && (
            <>
              <p className="dock-dash-countdown">{countdownText(open.seconds_left)}</p>
              <p className="rfid-dash-panel-sub">
                {count(open.crate_count, 'crate')} · {count(open.asset_count, 'asset')}
              </p>
              <ul className="dock-dash-tags" ref={tagsBox}>
                {listedTags(open.tags).map((t) => {
                  const chip = kindChip(t.kind);
                  return (
                    <li key={t.epc} data-fit-row className="dock-dash-tag">
                      <span className={`chip ${chip.tone}`}>{chip.label}</span>
                      <span className={t.label ? 'dock-dash-tag-label' : 'dock-dash-tag-label is-unknown'}>
                        {t.label ?? 'Unknown tag'}
                      </span>
                      <span className="dock-dash-tag-epc" title={t.epc}>{displayEpc(t.epc)}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section className="rfid-dash-panel" aria-labelledby="dock-recent-title">
          <h2 id="dock-recent-title" className="rfid-dash-panel-title">Recent passes</h2>
          <p className="rfid-dash-panel-sub">Newest first.</p>
          <div className="local-table-wrap" ref={passesBox}>
            <table className="local-table dock-dash-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Crate</th>
                  <th>Assets</th>
                  <th>Outcome</th>
                  <th>Moved</th>
                  <th aria-label="Details" />
                </tr>
              </thead>
              <tbody>
                {passes === null && (
                  <tr>
                    <td colSpan={6} className="rfid-dash-empty">Checking…</td>
                  </tr>
                )}
                {passes !== null && passes.length === 0 && (
                  <tr>
                    <td colSpan={6} className="rfid-dash-empty">No passes yet.</td>
                  </tr>
                )}
                {passes?.map((p) => (
                  <tr key={p.id} data-fit-row className={standsOut(p) ? 'is-flagged' : undefined}>
                    <td className="mono">{clockText(new Date(p.opened_at))}</td>
                    <td>{p.container_name ?? '—'}</td>
                    <td className="mono">{p.asset_count}</td>
                    <td className="dock-dash-outcome">{passOutcome(p)}</td>
                    {/* Only a sent pass has moved anything. */}
                    <td className="mono">{p.status === 'packed' ? p.moved_count : '—'}</td>
                    <td className="dock-dash-action">
                      <button type="button" className="mini-btn" onClick={() => setDetailId(p.id)}>
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {detailId !== null && <DockPassModal key={detailId} passId={detailId} onClose={closeDetail} />}
    </div>
  );
}
