/**
 * Printing Station — a laptop Label Station's working screen, and a web
 * kiosk's: scan an asset and its label prints.
 *
 * The scan box works like Scanning's: it always has focus (a barcode
 * scanner is a keyboard), takes focus back when it drifts, and Enter
 * submits. The value is matched by asset ID or serial against the move
 * downloaded to this device; the label is the one already generated for
 * it, sent to the saved printer by the print queue (`printQueue.ts`), one
 * label at a time. Where the label comes from and where its Labeled scan
 * goes is the label backend's (`labelBackend.ts`): the laptop's edge, or
 * on a web kiosk the browser build's store and the scan outbox.
 *
 * The big card is the latest scan: the asset, then "Printed", "Take the
 * label" (peel mode) or what went wrong, with Reprint or Retry. Below it,
 * this session's prints, newest first. The whole screen flashes and the
 * scan sound plays when a label prints or a scan fails, like Scanning.
 *
 * The header's status is read on open, after a sync, every
 * STATUS_REFRESH_MS, and when a scan hits a template too new to print:
 * - Laptop: a template designed in a newer label builder than this
 *   laptop's edge prints fails each of its scans with "This laptop needs
 *   an update to print this template.", and the header says how many
 *   templates need it (`unsupported` from GET /edge/labels/status).
 * - Web kiosk: the header says how many labels are ready and how many
 *   couldn't be made, and why (the build meta's counts per outcome); it is
 *   read again whenever the browser build finishes. When the move's label
 *   data isn't on the kiosk (`blocked`) or the last build failed
 *   (`error`), it says so and links to Kiosk Setup to sync again. The
 *   kiosk's outbox sender runs while this screen is open (as on
 *   Scanning), so a printed label's Labeled scan reaches the portal and
 *   its row can read "Printed + Recorded"; one the outbox gave up on reads
 *   "Printed · scan not recorded", and a note counts them with a Retry
 *   (Scanning's Retry failed). Failed scans are also sent again when the
 *   screen opens and when the browser comes back online. With no printer
 *   saved, arriving here opens Printer Setup once; coming back from it
 *   without saving shows a note that links there instead.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { naturalCompare } from '@portal/lib/naturalSort';

import { hslCss, useAppearance } from '../lib/appearance';
import { flash } from '../lib/flash';
import { useKioskSetup } from '../lib/kioskSetup';
import { labelBackend } from '../lib/labelBackend';
import {
  LABEL_SECTIONS, type PrinterSetupRouteState, type StationRouteState,
} from '../lib/labelSections';
import { getAll } from '../lib/localDb';
import { retryFailed, startSender, stopSender } from '../lib/outbox';
import {
  createPrintQueue, needsUpdateText, type PrintAsset, type PrintQueue, type QueueEntry,
} from '../lib/printQueue';
import { buildScanIndex, matchAssetOrSerial, type ScanIndex } from '../lib/scanMatch';
import { playScanSound } from '../lib/sound';
import { switchedText } from '../lib/stationPrinter';
import { useStationPrinter } from '../lib/useStationPrinter';
import { useSyncStatus } from '../lib/sync';
import { useWebLabelSettings } from '../lib/webLabelSettings';
import {
  readWebLabelProblems, readWebLabelStatus, subscribeWebLabelStatus, type WebLabelBlocked,
  type WebLabelStatus,
} from '../lib/webLabels/labelBuild';

type LoadStatus = 'loading' | 'ready' | 'error';

/** How often the header's label status is read again. */
export const STATUS_REFRESH_MS = 30_000;

const STATION_PATH = LABEL_SECTIONS.find((s) => s.id === 'station')!.path;
const PRINTER_SETUP_PATH = LABEL_SECTIONS.find((s) => s.id === 'printers')!.path;
/** Printer Setup, opened from here: its Finish and Back come back here. */
const TO_PRINTER_SETUP: PrinterSetupRouteState = { returnTo: STATION_PATH };

/** Focus belongs to these when the person deliberately moved it there;
 *  the card's own buttons hand it back once they've been clicked. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

const STATE_TEXT: Record<QueueEntry['state'], string> = {
  queued: 'Waiting to print',
  printing: 'Printing',
  printed: 'Printed',
  failed: 'Failed',
};

/** How often the list asks which printed scans the portal has accepted (a
 *  row then reads "Printed + Recorded"): the laptop's edge, or on the web
 *  this kiosk's own outbox. Not part of printing a label. */
export const RECORDED_POLL_MS = 5000;
/** A red (failed) row leaves the list this long after it fails; the big
 *  card keeps showing the latest scan, Retry and all (Jimmy, 2026-10-20). */
export const FAILED_ROW_MS = 5000;
const MAX_RECORDED_ASK = 100;  // the edge's limit per request

/** A row's (or the card's) status: the failure message, or the state, with
 *  "+ Recorded" once the portal has accepted the printed scan, or (web)
 *  "· scan not recorded" once the outbox gave up on it. */
function statusText(e: QueueEntry, recorded: ReadonlySet<string>, notRecorded: ReadonlySet<string>): string {
  if (e.state === 'failed') return e.message ?? STATE_TEXT.failed;
  if (e.state === 'printed' && e.clientScanId && recorded.has(e.clientScanId)) {
    return 'Printed + Recorded';
  }
  if (e.state === 'printed' && e.clientScanId && notRecorded.has(e.clientScanId)) {
    return 'Printed · scan not recorded';
  }
  return STATE_TEXT[e.state];
}

/** "The scan for 1 printed label wasn't recorded." */
function notRecordedNotice(n: number): string {
  return n === 1
    ? "The scan for 1 printed label wasn't recorded."
    : `The scans for ${n} printed labels weren't recorded.`;
}

function sameIds(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((id) => a.has(id));
}

function printTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** "1 template needs a laptop update." */
function updateNotice(n: number): string {
  return `${n} ${n === 1 ? 'template needs' : 'templates need'} a laptop update.`;
}

/** The web header: what the browser build stored, why the labels that
 *  couldn't be made weren't (count per outcome), and why none could be
 *  made (`blocked`) or the last build failed (`error`). */
interface WebLabelCounts {
  ready: number;
  errors: number;
  problems: Record<string, number>;
  blocked?: WebLabelBlocked;
  error?: string;
}

/** The three outcomes in a fixed order; anything else after them. */
const REASON_ORDER = ['no_template_at_dpi', 'template_failed', 'template_unsupported'];

function reasonRank(why: string): number {
  const at = REASON_ORDER.indexOf(why);
  return at < 0 ? REASON_ORDER.length : at;
}

/** Why a count of labels couldn't be made, as a sentence after the count. */
const REASON_TEXT: Record<string, string> = {
  no_template_at_dpi: "this move has no active label template at this printer's DPI. "
    + 'Someone with label access needs to activate one on Labels › Templates.',
  template_failed: "the move's label template couldn't be built.",
  template_unsupported: "the move's label template is newer than this kiosk can print. "
    + 'This kiosk needs an update.',
};

/** "2 couldn't be made: this move has no active label template at …" */
function reasonLine(why: string, n: number): string {
  const text = Object.hasOwn(REASON_TEXT, why) ? REASON_TEXT[why] : `${why}.`;
  return `${n} couldn't be made: ${text}`;
}

/** What's missing when the set-up move's labels can't be built yet. */
const BLOCKED_TEXT: Record<WebLabelBlocked, string> = {
  not_downloaded: "This kiosk doesn't have this move's label data yet.",
  templates_missing: "This kiosk doesn't have this move's label templates yet.",
};

/** "118 labels ready · 3 couldn't be made" */
function webLabelSummary(c: WebLabelCounts): string {
  const ready = `${c.ready} ${c.ready === 1 ? 'label' : 'labels'} ready`;
  return c.errors > 0 ? `${ready} · ${c.errors} couldn't be made` : ready;
}

/** "A12 · RU 22", or a dash when the move has neither. */
function placement(label: Record<string, string> | undefined, side: 'source' | 'destination'): string {
  const rack = label?.[`${side}_raw`]?.trim() ?? '';
  const ru = label?.[`${side}_ru`]?.trim() ?? '';
  const parts = [rack, ru ? `RU ${ru}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

export default function PrintingStation() {
  // The edge on a laptop, this kiosk's own store on the web; the platform
  // never changes while the page is up.
  const backend = labelBackend();
  const web = backend.kind === 'web';
  const navigate = useNavigate();
  const location = useLocation();
  const webSettings = useWebLabelSettings();
  const [setup] = useKioskSetup();
  const { phase } = useSyncStatus();
  const [appearance] = useAppearance();
  const station = useStationPrinter();
  /** The printer switch whose notice was dismissed. */
  const [dismissedSwitch, setDismissedSwitch] = useState<typeof station.switched>(null);
  const [value, setValue] = useState('');
  const [index, setIndex] = useState<ScanIndex | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  // client_scan_ids the portal has accepted: those rows read "Printed + Recorded"
  const [recorded, setRecorded] = useState<ReadonlySet<string>>(() => new Set());
  // Web: client_scan_ids the outbox gave up on ("Printed · scan not recorded")
  const [notRecorded, setNotRecorded] = useState<ReadonlySet<string>>(() => new Set());
  // bumped after a Retry, so the list looks again at once
  const [recheck, setRecheck] = useState(0);
  // failed rows whose FAILED_ROW_MS is up: hidden from the list
  const [expired, setExpired] = useState<ReadonlySet<string>>(() => new Set());
  const failTimers = useRef(new Map<string, number>());
  // Templates too new for this laptop's edge (its label status).
  const [unsupported, setUnsupported] = useState(0);
  // The web kiosk's stored labels (its build status), once read.
  const [labelCounts, setLabelCounts] = useState<WebLabelCounts | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const statusId = useRef(0);
  const firstLoad = useRef(true);

  // Laptop: an older edge (no count) means none; no answer keeps what it
  // last said. Web: the counts, and the reasons only when some couldn't be
  // made (the build meta, one IndexedDB read).
  const refreshStatus = () => {
    const mine = ++statusId.current;
    backend.getStatus()
      .then(async (s) => {
        if (mine !== statusId.current) return;
        if (!web) {
          setUnsupported(typeof s.unsupported === 'number' && s.unsupported > 0 ? s.unsupported : 0);
          return;
        }
        const problems = s.errors > 0 ? await readWebLabelProblems() : {};
        if (mine !== statusId.current) return;
        // the web backend's status is the browser build's
        const { blocked, error } = s as WebLabelStatus;
        setLabelCounts({ ready: s.ready, errors: s.errors, problems, blocked, error });
      })
      .catch(() => {});
  };
  const refreshStatusRef = useRef(refreshStatus);
  refreshStatusRef.current = refreshStatus;

  // The queue reads the printer, settings and appearance at print time,
  // so it is made once and handed refs.
  const printerRef = useRef(station.printer);
  printerRef.current = station.printer;
  const settingsRef = useRef(station.settings);
  settingsRef.current = station.settings;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const queueRef = useRef<PrintQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = createPrintQueue({
      printer: () => printerRef.current,
      settings: () => settingsRef.current,
      getLabel: (assetId) => backend.getLabel(assetId),
      recordPrinted: (job) => backend.recordPrinted(job),  // resolves to the scan's client_scan_id
      deviceWord: backend.deviceWord,
      onChange: (s) => setEntries(s.entries),
      onSettled: (entry) => {
        const good = entry.state === 'printed';
        const a = appearanceRef.current;
        flash(hslCss(good ? a.good_scan : a.not_found_scan), a.flash_ms);
        playScanSound(good ? 'good' : 'not_found');
        if (entry.message === needsUpdateText(backend.deviceWord)) refreshStatusRef.current();
      },
    });
  }
  const queue = queueRef.current;

  // The roster, read and indexed once; again when a sync finishes.
  useEffect(() => {
    const load = () => {
      const myLoad = ++loadId.current;
      getAll<PrintAsset>('assets')
        .then((assets) => {
          if (myLoad !== loadId.current) return;
          setIndex(buildScanIndex(assets));
          setLoadStatus('ready');
        })
        .catch(() => {
          if (myLoad !== loadId.current) return;
          setLoadStatus('error');
        });
    };
    if (firstLoad.current) {
      firstLoad.current = false;
      load();
      refreshStatus();
      return;
    }
    if (phase === 'done' || phase === 'idle') {
      load();
      refreshStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    const timer = window.setInterval(() => refreshStatusRef.current(), STATUS_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      statusId.current += 1;  // an answer after leaving changes nothing
    };
  }, []);

  // Web: a build finishes after the sync that started it, so the header
  // reads again whenever the build's status changes, not just after a
  // sync. Not while it runs: the yellow takeover covers the page then,
  // and the idle status at its end is read.
  useEffect(() => {
    if (!web) return undefined;
    return subscribeWebLabelStatus(() => {
      if (readWebLabelStatus().state !== 'running') refreshStatusRef.current();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Web: the Labeled scans go out through the outbox, whose sender only
  // runs while a screen that scans is open (Scanning starts it the same
  // way). The queue stays in IndexedDB when the page closes, and resumes
  // on the next visit to either screen. A scan the outbox gave up on (its
  // backoff spent offline) would otherwise wait for Scanning's Retry
  // failed: it is sent again when this screen opens and whenever the
  // browser says it is back online.
  useEffect(() => {
    if (!web) return undefined;
    const retry = () => { retryFailed().catch(() => {}); };
    startSender().then(retry, () => {});
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('online', retry);
      stopSender();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Web, no printer saved: arriving here opens Printer Setup once (it
  // comes back here when its printer step finishes). Coming back from it
  // without a printer (`fromPrinterSetup`) stays, with the note below. The
  // redirect replaces this entry, so the browser's Back never bounces
  // between the two.
  useEffect(() => {
    if (!web || webSettings !== null) return;
    if ((location.state as StationRouteState | null)?.fromPrinterSetup) return;
    navigate(PRINTER_SETUP_PATH, { replace: true, state: TO_PRINTER_SETUP });
    // only on arrival: a printer saved or forgotten later changes nothing here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ask the backend (the laptop's edge, or this kiosk's outbox) about
  // printed scans not yet known to be recorded: now (whenever that set
  // changes, or after a Retry) and every RECORDED_POLL_MS until they are.
  // The web also says which of them the outbox gave up on.
  const waitingKey = entries
    .filter((e) => e.state === 'printed' && e.clientScanId && !recorded.has(e.clientScanId))
    .map((e) => e.clientScanId as string)
    .slice(0, MAX_RECORDED_ASK)
    .join(',');
  useEffect(() => {
    if (!waitingKey) return undefined;
    let alive = true;
    const ids = waitingKey.split(',');
    const check = () => {
      backend.recordedIds(ids).then((got) => {
        if (alive && got.length > 0) setRecorded((prev) => new Set([...prev, ...got]));
      }, () => {});  // offline or busy: ask again next time
      backend.failedIds?.(ids).then((got) => {
        if (alive) setNotRecorded((prev) => (sameIds(prev, got) ? prev : new Set(got)));
      }, () => {});
    };
    check();
    const timer = window.setInterval(check, RECORDED_POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, recheck]);

  // Web: printed labels whose Labeled scan the outbox gave up on.
  const notRecordedCount = entries.filter((e) => e.state === 'printed' && e.clientScanId
    && notRecorded.has(e.clientScanId) && !recorded.has(e.clientScanId)).length;

  // Each failed row gets FAILED_ROW_MS from when it failed; one that is
  // retried (no longer failed) comes back and starts over if it fails again.
  useEffect(() => {
    const timers = failTimers.current;
    const failed = new Set(entries.filter((e) => e.state === 'failed').map((e) => e.id));
    for (const id of failed) {
      if (timers.has(id) || expired.has(id)) continue;
      timers.set(id, window.setTimeout(() => {
        timers.delete(id);
        setExpired((prev) => new Set(prev).add(id));
      }, FAILED_ROW_MS));
    }
    for (const [id, timer] of timers) {
      if (!failed.has(id)) { window.clearTimeout(timer); timers.delete(id); }
    }
    if ([...expired].some((id) => !failed.has(id))) {
      setExpired((prev) => new Set([...prev].filter((id) => failed.has(id))));
    }
  }, [entries, expired]);
  useEffect(() => () => {
    for (const timer of failTimers.current.values()) window.clearTimeout(timer);
  }, []);
  const listed = entries.filter((e) => !(e.state === 'failed' && expired.has(e.id)));

  const empty = loadStatus === 'ready' && (index?.size ?? 0) === 0;
  const disabled = loadStatus !== 'ready' || empty || !setup || station.state !== 'ready';

  const focusInput = () => {
    const el = inputRef.current;
    if (el && !el.disabled) el.focus();
  };

  useEffect(() => {
    if (!disabled) focusInput();
  }, [disabled]);

  useEffect(() => {
    if (disabled) return undefined;
    const reclaim = () => {
      const el = inputRef.current;
      if (!el || el.disabled || document.activeElement === el) return;
      const active = document.activeElement;
      if (active && active !== document.body && KEEPS_FOCUS.has(active.tagName)) return;
      el.focus();
    };
    const onFocusOut = () => { window.setTimeout(reclaim, 0); };
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', reclaim);
    return () => {
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', reclaim);
    };
  }, [disabled]);

  const submitScan = () => {
    const raw = value.trim();
    setValue('');
    focusInput();
    if (!raw || !index) return;
    const match = matchAssetOrSerial(index, raw);
    queue.enqueue({ asset: (match?.asset as PrintAsset | undefined) ?? null, scannedValue: raw });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitScan();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitScan();
  };

  /** Reprint / Retry: do it, then the scan box gets focus back. */
  const act = (fn: () => void) => {
    fn();
    focusInput();
  };

  /** The scans-not-recorded note's Retry: back on the outbox's queue, and
   *  the list looks again at once. */
  const retryScans = () => act(() => {
    retryFailed().then(() => setRecheck((n) => n + 1), () => {});
  });

  const subtitle = useMemo(
    () => (setup ? `${setup.initiativeName} · ${setup.siteName}` : ''),
    [setup],
  );

  const current = entries[0] ?? null;

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Label Printing</div>
      <h1 className="page-title">Printing Station</h1>
      {setup
        ? <p className="page-hint">{subtitle}</p>
        : <p className="page-hint">Finish Kiosk Setup first.</p>}

      {unsupported > 0 && (
        <div className="station-printer-note" role="status">
          <p>{updateNotice(unsupported)}</p>
        </div>
      )}
      {web && webSettings && labelCounts && !(labelCounts.blocked && (loadStatus !== 'ready' || empty)) && (
        // With no roster at all, the empty-move note below already says to
        // sync (and a roster still loading may turn out to be none).
        <div className="station-printer-note station-label-count" role="status">
          {labelCounts.blocked ? (
            <p>
              {BLOCKED_TEXT[labelCounts.blocked]} Sync again from <Link to="/setup">Kiosk Setup</Link>.
            </p>
          ) : (
            <>
              <p>{webLabelSummary(labelCounts)}</p>
              {labelCounts.errors > 0 && Object.keys(labelCounts.problems).length > 0 && (
                <ul className="station-label-reasons">
                  {Object.entries(labelCounts.problems)
                    .sort(([a], [b]) => reasonRank(a) - reasonRank(b) || naturalCompare(a, b))
                    .map(([why, n]) => <li key={why}>{reasonLine(why, n)}</li>)}
                </ul>
              )}
              {labelCounts.error && (
                <p>
                  Labels couldn&apos;t be made ({labelCounts.error}). Sync again
                  from <Link to="/setup">Kiosk Setup</Link>.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {web && notRecordedCount > 0 && (
        <div className="station-printer-note" role="status">
          <p>{notRecordedNotice(notRecordedCount)}</p>
          <button type="button" className="mini-btn" onClick={retryScans}>Retry</button>
        </div>
      )}

      {station.switched && station.switched !== dismissedSwitch && (
        <div className="station-printer-note" role="status">
          <p>{switchedText(station.switched)}</p>
          <button type="button" className="mini-btn" onClick={() => setDismissedSwitch(station.switched)}>Dismiss</button>
        </div>
      )}
      {station.switchError && (
        <div className="station-printer-note" role="alert">
          <p>
            {`Couldn't switch to the connected printer: ${station.switchError}. Set it up in `}
            <Link to={PRINTER_SETUP_PATH} state={TO_PRINTER_SETUP}>Printer Setup</Link>.
          </p>
        </div>
      )}
      {station.state === 'loading' && <p className="page-hint">Connecting to the label printer…</p>}
      {station.state === 'needs_usb' && (
        <div className="station-printer-note" role="status">
          <p>The label printer isn&apos;t connected. Connect it to start printing.</p>
          <button type="button" className="mini-btn" onClick={() => { void station.connectUsb(); }}>
            Connect printer
          </button>
        </div>
      )}
      {station.state === 'no_settings' && (
        <div className="station-printer-note" role="status">
          {web ? (
            // A web kiosk's printer is saved in Printer Setup, not Kiosk Setup.
            <p>
              No label printer is saved for this kiosk. Set one up in
              {' '}<Link to={PRINTER_SETUP_PATH} state={TO_PRINTER_SETUP}>Printer Setup</Link>.
            </p>
          ) : (
            <p>
              No label printer is saved for this station. Set one up in
              {' '}<Link to="/setup">Kiosk Setup</Link>.
            </p>
          )}
        </div>
      )}
      {loadStatus === 'error' && (
        <p className="form-error" role="alert">Couldn&apos;t read this kiosk&apos;s local data.</p>
      )}
      {empty && (
        <p className="page-hint">No move data on this kiosk. Sync it from Kiosk Setup.</p>
      )}

      <form onSubmit={onSubmit}>
        <input
          id="station-scan-input"
          ref={inputRef}
          className="scan-input"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
          autoFocus
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          placeholder="Scan or type an asset ID or serial"
          aria-label="Scan value"
          disabled={disabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </form>

      {current && (
        <section className={`station-result is-${current.state}`} aria-live="polite">
          {current.asset ? (
            <dl className="station-asset" data-testid="station-asset">
              <div className="station-asset-name">{current.asset.name || current.asset.asset_id}</div>
              <div><dt>Asset ID</dt><dd className="mono">{current.asset.asset_id}</dd></div>
              <div><dt>Make / Model</dt><dd>{current.asset.make_model || '—'}</dd></div>
              <div><dt>Serial</dt><dd className="mono">{current.asset.serial_number || '—'}</dd></div>
              <div><dt>Source</dt><dd>{placement(current.asset.label, 'source')}</dd></div>
              <div><dt>Destination</dt><dd>{placement(current.asset.label, 'destination')}</dd></div>
            </dl>
          ) : (
            <p className="station-scanned mono">{current.scannedValue}</p>
          )}
          <div className="station-outcome">
            <p className="station-status">
              {statusText(current, recorded, notRecorded)}
            </p>
            {current.recordWarning && <p className="station-warning">{current.recordWarning}</p>}
            {current.state === 'printed' && current.asset && (
              <button type="button" className="mini-btn" onClick={() => act(() => queue.reprint(current.id))}>
                Reprint
              </button>
            )}
            {current.state === 'failed' && current.asset && (
              <button type="button" className="mini-btn" onClick={() => act(() => queue.retry(current.id))}>
                Retry
              </button>
            )}
          </div>
        </section>
      )}

      {listed.length === 0 ? (
        <p className="page-hint">Nothing printed yet.</p>
      ) : (
        <div className="local-table-wrap">
          <table className="local-table scan-list station-list">
            <thead>
              <tr>
                <th>Asset ID</th>
                <th>Name</th>
                <th>Serial</th>
                <th>Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((e) => (
                <tr key={e.id} className={`station-row is-${e.state}`}>
                  <td className="mono">{e.asset?.asset_id ?? e.scannedValue}</td>
                  <td>{e.asset?.name ?? '—'}</td>
                  <td className="mono">{e.asset?.serial_number || '—'}</td>
                  <td className="mono">{printTime(e.scannedAt)}</td>
                  <td>
                    <span className="scan-chip">
                      {statusText(e, recorded, notRecorded)}
                      {e.reprint ? ' (reprint)' : ''}
                    </span>
                    {e.recordWarning && <div className="station-warning">{e.recordWarning}</div>}
                    {e.state === 'failed' && e.asset && e.id !== current?.id && (
                      <button type="button" className="mini-btn" onClick={() => act(() => queue.retry(e.id))}>
                        Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
