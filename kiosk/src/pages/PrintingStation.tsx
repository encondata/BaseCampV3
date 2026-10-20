/**
 * Printing Station — a laptop Label Station's working screen: scan an
 * asset and its label prints.
 *
 * The scan box works like Scanning's: it always has focus (a barcode
 * scanner is a keyboard), takes focus back when it drifts, and Enter
 * submits. The value is matched by asset ID or serial against the move
 * downloaded to this laptop; the label is the one the edge already
 * generated, sent to the printer saved in Kiosk Setup by the print queue
 * (`printQueue.ts`), one label at a time.
 *
 * The big card is the latest scan: the asset, then "Printed", "Take the
 * label" (peel mode) or what went wrong, with Reprint or Retry. Below it,
 * this session's prints, newest first. The whole screen flashes and the
 * scan sound plays when a label prints or a scan fails, like Scanning.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';

import { getStationLabel, postLabelPrinted } from '../lib/api';
import { hslCss, useAppearance } from '../lib/appearance';
import { flash } from '../lib/flash';
import { useKioskSetup } from '../lib/kioskSetup';
import { getAll } from '../lib/localDb';
import {
  createPrintQueue, type PrintAsset, type PrintQueue, type QueueEntry,
} from '../lib/printQueue';
import { buildScanIndex, matchAssetOrSerial, type ScanIndex } from '../lib/scanMatch';
import { playScanSound } from '../lib/sound';
import { useStationPrinter } from '../lib/useStationPrinter';
import { useSyncStatus } from '../lib/sync';

type LoadStatus = 'loading' | 'ready' | 'error';

/** Focus belongs to these when the person deliberately moved it there;
 *  the card's own buttons hand it back once they've been clicked. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

const STATE_TEXT: Record<QueueEntry['state'], string> = {
  queued: 'Waiting to print',
  printing: 'Printing',
  take_label: 'Take the label',
  printed: 'Printed',
  failed: 'Failed',
};

function printTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** "A12 · RU 22", or a dash when the move has neither. */
function placement(label: Record<string, string> | undefined, side: 'source' | 'destination'): string {
  const rack = label?.[`${side}_raw`]?.trim() ?? '';
  const ru = label?.[`${side}_ru`]?.trim() ?? '';
  const parts = [rack, ru ? `RU ${ru}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

export default function PrintingStation() {
  const [setup] = useKioskSetup();
  const { phase } = useSyncStatus();
  const [appearance] = useAppearance();
  const station = useStationPrinter();
  const [value, setValue] = useState('');
  const [index, setIndex] = useState<ScanIndex | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const firstLoad = useRef(true);

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
      getLabel: getStationLabel,
      recordPrinted: (job) => postLabelPrinted({
        asset_id: job.assetId, scanned_value: job.scannedValue, scanned_at: job.scannedAt,
      }),
      onChange: (s) => setEntries(s.entries),
      onSettled: (entry) => {
        const good = entry.state === 'printed';
        const a = appearanceRef.current;
        flash(hslCss(good ? a.good_scan : a.not_found_scan), a.flash_ms);
        playScanSound(good ? 'good' : 'not_found');
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
      return;
    }
    if (phase === 'done' || phase === 'idle') load();
  }, [phase]);

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
          <p>
            No label printer is saved for this station. Set one up in
            {' '}<Link to="/setup">Kiosk Setup</Link>.
          </p>
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
              {current.state === 'failed' ? current.message : STATE_TEXT[current.state]}
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

      {entries.length === 0 ? (
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
              {entries.map((e) => (
                <tr key={e.id} className={`station-row is-${e.state}`}>
                  <td className="mono">{e.asset?.asset_id ?? e.scannedValue}</td>
                  <td>{e.asset?.name ?? '—'}</td>
                  <td className="mono">{e.asset?.serial_number || '—'}</td>
                  <td className="mono">{printTime(e.scannedAt)}</td>
                  <td>
                    <span className="scan-chip">
                      {e.state === 'failed' ? e.message : STATE_TEXT[e.state]}
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
