/**
 * The Dock screen (/dock) — where a Dock laptop's Home tile and Kiosk Setup
 * land, laid out like the Truck Packing kiosk. Along the top, the crate
 * card and the count of assets inside its window. The card shows Scanning…
 * until a crate tag is read, then the newest crate with the time left
 * before its burst is decided (red when that crate will be flagged More
 * than one crate), and for 6 s after each newly decided pass its result;
 * with the reader not reading it shows Paused, Stopped or the reader's
 * state. In the middle, the open burst's assets newest first, each with
 * whether it is inside a crate's window, beside the newest closed passes,
 * each opening its full detail. Along the bottom, the dry-run switch and the
 * crate Window, both saved on the laptop's edge, then the big Start / Pause /
 * Stop. It fills the main column in the kiosk's light or dark theme; both
 * lists scroll inside their cards. The overview refreshes 1 s after the
 * previous refresh settles (never overlapping); while refreshes fail, a red
 * line says the station can't be reached and the last overview stays under
 * it. The reader is checked 5 s after the previous check settles and right
 * after each button's call. Web mode, or a setup that isn't a Dock, goes
 * home; a new laptop browser with no setup yet shows nothing until the
 * laptop's has loaded (KioskShell looks for it), then decides.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import DockPassModal, { passOutcome } from '../components/DockPassModal';
import { codeOf, readerErrorText } from '../components/setup/readerSetup';
import { Switch } from '../components/Switch';
import {
  controlDock, getDock, getReaderStatus, saveDockSettings,
  type DockControl, type DockCrate, type DockOpenTag, type DockOverview, type DockPassRow,
  type DockSettings, type ReaderStatus,
} from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { useLaptopSetupSettled } from '../lib/laptopSetup';
import { isLaptop } from '../lib/platform';
import { readerState, type ReaderState } from '../lib/readerState';
import { clockText, displayEpc, ICON } from './RfidStatus';

const POLL_MS = 1000;
const READER_POLL_MS = 5000;
/** How long a newly decided pass's result holds the crate card. */
const RESULT_MS = 6000;
const WINDOW_MIN = 1;
const WINDOW_MAX = 60;

const BUSY_TEXT: Record<DockControl, string> = {
  start: 'Starting…', pause: 'Pausing…', stop: 'Stopping…',
};

type ReaderTone = 'reading' | 'paused' | 'stopped' | 'unreachable' | 'loading';

/** The reader's state as the crate card shows it: a running call first,
 *  then the reader's own state, where a stopped reader reads Paused when
 *  Pause was the last button. */
function readerText(state: ReaderState, control: DockControl | null, busy: DockControl | null): {
  text: string; tone: ReaderTone;
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

/** A whole number of seconds in range, or null. */
function parseWindow(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= WINDOW_MIN && n <= WINDOW_MAX ? n : null;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
function andList(names: string[]): string {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A crate as the screen names it: its container's name, or its trimmed tag
 *  for an unnamed one. */
const crateText = (c: DockCrate) => c.label ?? displayEpc(c.epc);

/** The flagged crates read together, by name, each once: the run of flagged
 *  crates that ends at the newest, or every flagged crate when that run
 *  names fewer than two (an unflagged crate was read between them, or the
 *  newest isn't flagged). */
function flaggedWith(crates: DockCrate[]): string[] {
  const run: string[] = [];
  for (let i = crates.length - 1; i >= 0 && crates[i].conflict; i -= 1) run.unshift(crateText(crates[i]));
  const names = [...new Set(run)];
  return names.length > 1 ? names : [...new Set(crates.filter((c) => c.conflict).map(crateText))];
}

/** Whether an added asset's crate will be flagged More than one crate, so
 *  nothing in it packs: its crate by label, or for an unnamed crate when
 *  every unnamed crate is flagged. */
function inFlaggedCrate(tag: DockOpenTag, crates: DockCrate[]): boolean {
  if (!tag.in_window) return false;
  if (tag.crate_label !== null) return crates.some((c) => c.conflict && c.label === tag.crate_label);
  const unnamed = crates.filter((c) => c.label === null);
  return unnamed.length > 0 && unnamed.every((c) => c.conflict);
}

/** A newly decided pass that the last answer didn't list, to show on the
 *  crate card: the newest that isn't a No crate read leftover (a burst's
 *  crate is written before a straggler's leftover, so the leftover can be on
 *  top though the crate packed), or the leftover when that's all there is. */
function newlyDecided(passes: DockPassRow[], before: DockPassRow[]): DockPassRow | null {
  const fresh = passes.filter((p) => !before.some((b) => b.id === p.id));
  return fresh.find((p) => !(p.status === 'flagged' && p.flag === 'no_crate')) ?? fresh[0] ?? null;
}

/** No crate (or several), or the portal turned the pass away. */
const standsOut = (p: DockPassRow) => p.status === 'flagged' || p.status === 'refused';

/** An asset's status in the open burst, from the edge's window test; inside
 *  a crate that will be flagged, it won't pack. */
function assetChip(tag: DockOpenTag, dryRun: boolean, flagged: boolean): { label: string; tone: string } {
  if (tag.in_window === null) return { label: 'Waiting for crate', tone: 'c-slate' };
  if (flagged) return { label: 'More than one crate', tone: 'c-red' };
  if (tag.in_window) return { label: dryRun ? 'Would add' : 'Adding', tone: 'c-green' };
  return { label: 'Outside window', tone: 'c-red' };
}

/** The crate an added asset is going into, named only when the burst has
 *  more than one: the edge's crate label, or for an unnamed crate its
 *  trimmed tag while only one crate is unnamed (two leave it unknown). */
function rowCrate(tag: DockOpenTag, crates: DockCrate[]): string | null {
  if (!tag.in_window || crates.length < 2) return null;
  if (tag.crate_label !== null) return tag.crate_label;
  const unnamed = crates.filter((c) => c.label === null);
  return unnamed.length === 1 ? displayEpc(unnamed[0].epc) : null;
}

/** The open burst's assets, newest first read first (later tags first on a
 *  tie). */
function listedAssets(tags: DockOpenTag[]): DockOpenTag[] {
  return tags.filter((t) => t.kind === 'asset').reverse()
    .sort((a, b) => Date.parse(b.first_read_at) - Date.parse(a.first_read_at));
}

type CardLook = 'scanning' | 'found' | 'done' | 'would' | 'flag' | 'idle';

interface CrateCard {
  look: CardLook;
  name: ReactNode;
  meta: string;
  /** The reader's state, while the card shows it. */
  reader?: ReaderTone;
  /** The open burst's countdown to its decision. */
  bar?: { seconds: number; pct: number };
}

/** A decided pass on the crate card: green when packed (or on its way),
 *  amber for a dry run, red when flagged or refused, neutral for nothing to
 *  pack. `flagged` names the crates of a More than one crate pass. */
function resultCard(p: DockPassRow, flagged: string[]): CrateCard {
  const crate = p.container_name ?? '—';
  const devices = count(p.asset_count, 'device');
  switch (p.status) {
    case 'packed':
      return { look: 'done', name: crate, meta: p.refused_count > 0 ? passOutcome(p) : `Packed ${devices}` };
    case 'waiting': return { look: 'done', name: crate, meta: passOutcome(p) };
    case 'would_pack':
      return { look: 'would', name: crate, meta: `Would pack ${devices} · dry run, nothing sent` };
    case 'refused': return { look: 'flag', name: crate, meta: passOutcome(p) };
    case 'flagged':
      if (p.flag === 'many_crates') {
        return {
          look: 'flag', name: 'More than one crate',
          meta: flagged.length > 1
            ? `${andList(flagged)} were read together. Nothing was packed.` : 'Nothing was packed.',
        };
      }
      return { look: 'flag', name: 'No crate read', meta: `${devices} read with no crate tag. Nothing was packed.` };
    default:
      return { look: 'idle', name: p.container_name ?? 'Nothing to pack', meta: p.container_name ? 'Nothing to pack' : '' };
  }
}

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
  /** A pass decided while watching, holding the crate card for RESULT_MS:
   *  its row as first seen, and the crates its burst read together. */
  const [result, setResult] = useState<{ pass: DockPassRow; flagged: string[] } | null>(null);
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
  // The last overview that landed: a pass at the top of the next one that
  // it didn't list was decided while watching.
  const lastOverview = useRef<DockOverview | null>(null);
  const resultTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(resultTimer.current);
    };
  }, []);

  const showResult = useCallback((pass: DockPassRow | null, flagged: string[] = []) => {
    window.clearTimeout(resultTimer.current);
    setResult(pass && { pass, flagged });
    if (pass) resultTimer.current = window.setTimeout(() => setResult(null), RESULT_MS);
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
        // A newly read crate takes the card from a result. Otherwise passes
        // the last answer didn't list were just decided; the first answer
        // only says which passes were already there.
        const before = lastOverview.current;
        lastOverview.current = o;
        const decided = before ? newlyDecided(o.passes, before.passes) : null;
        if (o.open && o.open.crates.length > 0) showResult(null);
        else if (before && decided) {
          showResult(decided, before.open ? flaggedWith(before.open.crates) : []);
        }
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
  }, [dock, showResult]);

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
  const dryRun = settings?.dry_run ?? true;
  const rows = open ? listedAssets(open.tags) : [];
  const newest = open && open.crates.length > 0 ? open.crates[open.crates.length - 1] : null;
  // The result follows its pass as the list has it now (sent, refused).
  const decided = result ? (passes?.find((p) => p.id === result.pass.id) ?? result.pass) : null;

  let card: CrateCard;
  if (decided && result) {
    card = resultCard(decided, result.flagged);
  } else if (open && newest) {
    const flagged = newest.conflict ? flaggedWith(open.crates) : [];
    const found = `Tag ${displayEpc(newest.epc)} · read at ${clockText(new Date(newest.first_read_at))}`;
    card = newest.conflict
      ? {
        look: 'flag', name: 'More than one crate',
        meta: flagged.length > 1 ? `${andList(flagged)} were read together` : found,
      }
      : { look: 'found', name: crateText(newest), meta: found };
    const span = 2 * open.window_s;
    card.bar = {
      seconds: Math.ceil(open.seconds_left),
      pct: span > 0 ? Math.max(0, Math.min(100, Math.round((open.seconds_left * 100) / span))) : 0,
    };
  } else if (state === 'reading' && !busy) {
    card = {
      look: 'scanning', reader: 'reading',
      name: <><span className="dock-pulse" aria-hidden="true" /><span className="dock-dots">Scanning</span></>,
      meta: rows.length > 0 ? `${count(rows.length, 'device')} read · waiting for a crate tag` : 'Waiting for a crate tag',
    };
  } else {
    card = {
      look: 'idle', reader: shown.tone, name: shown.text,
      meta: shown.tone === 'paused' || shown.tone === 'stopped' ? 'Press Start to read again' : '',
    };
  }

  // The count: a green or amber result's assets, else those inside the
  // newest crate's window, muted while that crate will be flagged.
  let added = 0;
  let addedSub: string;
  let nothingPacks = false;
  if (decided && card.look !== 'flag' && decided.container_name) {
    added = decided.asset_count;
    addedSub = decided.status === 'would_pack'
      ? `would go into ${decided.container_name}` : `in ${decided.container_name}`;
  } else if (open && newest) {
    added = open.added_count;
    nothingPacks = newest.conflict;
    if (nothingPacks) addedSub = 'More than one crate · nothing will be packed';
    else addedSub = dryRun ? `would go into ${crateText(newest)}` : `in ${crateText(newest)}`;
  } else {
    addedSub = open ? 'waiting for a crate tag' : 'no crate yet';
  }

  return (
    <div className="portal-page dock-dash">
      <h1 className="sr-only">Dock</h1>

      {/* The RFID dashboard's Unreachable look: red, with its dot. */}
      {unreachable && (
        <p className="rfid-dash-state is-unreachable dock-unreachable" role="alert">
          <span className="rfid-dash-dot" />Can&apos;t reach the station. Retrying…
        </p>
      )}

      <div className="dock-top">
        <section className={`dock-card dock-crate is-${card.look}`} aria-labelledby="dock-crate-label">
          <div className="dock-card-label">
            {ICON.crate}<span id="dock-crate-label">Crate</span>
            {settings?.dry_run && <span className="chip c-amber dock-label-chip">Dry run</span>}
          </div>
          <div className="dock-crate-row">
            <div className="dock-crate-main">
              <div className={card.reader ? `dock-crate-name is-${card.reader}` : 'dock-crate-name'}>
                {card.name}
              </div>
              <div className="dock-crate-meta">{card.meta}</div>
            </div>
            {card.bar && (
              <div className="dock-window">
                <div className="dock-window-label">
                  <span>Finishing in</span><span>{card.bar.seconds} s</span>
                </div>
                <div className="dock-window-bar" aria-hidden="true">
                  <span style={{ width: `${card.bar.pct}%` }} />
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="dock-card dock-stat" aria-labelledby="dock-stat-label">
          <div className="dock-card-label">{ICON.server}<span id="dock-stat-label">Assets added to crate</span></div>
          {/* Keyed on the count: a new count is a new element, which replays the bump. */}
          <div key={added} className={`dock-stat-value ${
            added === 0 ? 'is-zero' : nothingPacks ? 'is-muted' : 'is-bump'}`}>
            {added}
          </div>
          <div className="dock-stat-sub">{addedSub}</div>
        </section>
      </div>

      <div className="dock-work">
        <section className="dock-panel" aria-labelledby="dock-list-title">
          <div className="dock-panel-head">
            <div>
              <h2 id="dock-list-title" className="dock-panel-title">In this crate</h2>
              <p className="dock-panel-sub">Devices read at the curtain, newest first.</p>
            </div>
            <span className="chip tag">{count(rows.length, 'device')}</span>
          </div>
          <div className="dock-list-wrap">
            {overview === null && <p className="dock-empty">Checking…</p>}
            {overview !== null && rows.length === 0 && (
              <div className="dock-empty">
                {ICON.rfid}
                {state === 'reading' || state === 'loading'
                  ? 'Devices appear here as they pass the curtain.' : 'The reader is not reading.'}
              </div>
            )}
            {rows.length > 0 && open && (
              <table className="dock-list dock-crate-list">
                <thead>
                  <tr><th>Device</th><th>Serial</th><th>Tag</th><th>Read</th><th className="r">Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((t, i) => {
                    const chip = assetChip(t, dryRun, inFlaggedCrate(t, open.crates));
                    const into = rowCrate(t, open.crates);
                    return (
                      // The newest row flashes once as it arrives.
                      <tr key={t.epc} className={i === 0 ? 'is-new' : undefined}>
                        <td className="name">{t.label ?? '—'}</td>
                        <td className="mono">{t.serial ?? '—'}</td>
                        <td className="mono" title={t.epc}>{displayEpc(t.epc)}</td>
                        <td className="num">{clockText(new Date(t.first_read_at))}</td>
                        <td className="r">
                          <span className={`chip ${chip.tone}`}>{chip.label}</span>
                          {into && <span className="dock-row-crate">{into}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="dock-panel" aria-labelledby="dock-recent-title">
          <div className="dock-panel-head">
            <div>
              <h2 id="dock-recent-title" className="dock-panel-title">Recent passes</h2>
              <p className="dock-panel-sub">Newest first.</p>
            </div>
            <span className="chip tag">{count(passes?.length ?? 0, 'pass', 'passes')}</span>
          </div>
          <div className="dock-list-wrap">
            {passes === null && <p className="dock-empty">Checking…</p>}
            {passes !== null && passes.length === 0 && (
              <div className="dock-empty">{ICON.crate}No passes yet.</div>
            )}
            {passes !== null && passes.length > 0 && (
              <table className="dock-list dock-recent-list">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Crate</th>
                    <th className="r">Assets</th>
                    <th>Outcome</th>
                    <th aria-label="Details" />
                  </tr>
                </thead>
                <tbody>
                  {passes.map((p) => (
                    <tr key={p.id} className={standsOut(p) ? 'is-flagged' : undefined}>
                      <td className="num">{clockText(new Date(p.opened_at))}</td>
                      <td className="name">{p.container_name ?? '—'}</td>
                      <td className="num r">{p.asset_count}</td>
                      <td className={p.status === 'would_pack' ? 'dock-outcome is-would' : 'dock-outcome'}>
                        {passOutcome(p)}
                      </td>
                      <td className="r">
                        <button type="button" className="mini-btn" onClick={() => setDetailId(p.id)}>
                          Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      {(saveFailed || controlError) && (
        <div className="dock-alerts">
          {saveFailed && <p className="form-error" role="alert">Couldn&apos;t save. Try again.</p>}
          {controlError && (
            <p className="form-error" role="alert">
              {/* No reader status yet (a stuck reader answers busy) leaves no IP to name. */}
              {readerErrorText(controlError.err, status?.reader?.ip || 'the reader')
                ?? `Couldn't ${controlError.action} the reader (${codeOf(controlError.err)}).`}
            </p>
          )}
        </div>
      )}

      <div className="dock-bottom">
        {/* Disabled until the edge's settings arrive: before that a change
            would be made against defaults. */}
        <fieldset className="dock-settings" disabled={settings === null}>
          <legend className="sr-only">Dock settings</legend>
          <div className="dock-set-row">
            <div className="dock-set-text">
              <span className="dock-set-title">Dry run</span>
              <span className="dock-set-hint">Nothing is sent to the portal.</span>
            </div>
            <Switch on={settings?.dry_run ?? true} aria-label="Dry run"
                    onChange={(on) => { if (!saving) void save({ dry_run: on }); }} />
          </div>
          <div className="dock-set-row">
            <div className="dock-set-text">
              <label htmlFor="dock-window" className="dock-set-title">Window</label>
              <span id="dock-window-hint" className={windowInvalid ? 'dock-set-hint form-error' : 'dock-set-hint'}>
                {windowInvalid ? '1–60 seconds' : 'Seconds before and after the crate tag'}
              </span>
            </div>
            <span className="dock-win">
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
              <button type="button" className="mini-btn" disabled={!windowChanged || saving}
                      onClick={() => void saveWindow()}>
                Save
              </button>
            </span>
          </div>
        </fieldset>

        {/* Outside the settings above, so Stop works before they load. */}
        <div className="dock-reader" role="group" aria-label="Reader">
          <button type="button" className="rfid-dash-btn is-start" aria-label="Start"
                  aria-describedby="dock-start-sub" disabled={startDisabled} onClick={() => void press('start')}>
            <span className="rfid-dash-btn-icon">{ICON.play}</span>
            <span className="rfid-dash-btn-text">
              <span className="rfid-dash-btn-title">Start</span>
              <span id="dock-start-sub" className="rfid-dash-btn-sub">
                {state === 'reading' ? 'Reading' : 'Start reading tags'}
              </span>
            </span>
          </button>
          <button type="button" className="rfid-dash-btn is-pause" aria-label="Pause"
                  aria-describedby="dock-pause-sub" disabled={pauseDisabled} onClick={() => void press('pause')}>
            <span className="rfid-dash-btn-icon">{ICON.pause}</span>
            <span className="rfid-dash-btn-text">
              <span className="rfid-dash-btn-title">Pause</span>
              <span id="dock-pause-sub" className="rfid-dash-btn-sub">Stop reading, keep this crate</span>
            </span>
          </button>
          {/* Never disabled: a reader can get stuck. */}
          <button type="button" className="rfid-dash-btn is-stop" aria-label="Stop"
                  aria-describedby="dock-stop-sub" onClick={() => void press('stop')}>
            <span className="rfid-dash-btn-icon">{ICON.square}</span>
            <span className="rfid-dash-btn-text">
              <span className="rfid-dash-btn-title">Stop</span>
              <span id="dock-stop-sub" className="rfid-dash-btn-sub">Stop reading, finish this crate now</span>
            </span>
          </button>
        </div>
      </div>

      {detailId !== null && <DockPassModal key={detailId} passId={detailId} onClose={closeDetail} />}
    </div>
  );
}
