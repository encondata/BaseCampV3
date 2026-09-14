/**
 * Scanning — the kiosk's working screen.
 *
 * One text box that always has focus, because a barcode scanner is a
 * keyboard: it types the value and presses Enter into whatever is
 * focused. If focus drifts (someone taps a button, the tab comes back
 * from the background), the next scan lands somewhere harmless and is
 * silently lost — so focus is taken back whenever it leaves and nothing
 * else on the page genuinely wants it.
 *
 * A scan is matched against the move downloaded to this kiosk
 * (`scanMatch.ts`), the whole screen flashes the Appearance tab's good
 * or not-found color and the Sound tab's matching sound plays, and the
 * matched scan goes into the outbox
 * (`outbox.ts`) rather than straight onto the network. The list below
 * is the operator's receipt: newest first, green when the API has taken
 * it, yellow while it is on its way, red when it failed or matched
 * nothing.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { displayRfid } from '@portal/lib/format';

import { hslCss, useAppearance } from '../lib/appearance';
import { flash } from '../lib/flash';
import { useKioskSetup } from '../lib/kioskSetup';
import { getAll } from '../lib/localDb';
import {
  BACKOFF, clearSent, discardFailed, enqueueScan, retryFailed, startSender, stopSender,
  useOutbox, type OutboxRow,
} from '../lib/outbox';
import { buildScanIndex, matchScan, scanTypeFor, type ScanAsset, type ScanIndex } from '../lib/scanMatch';
import { playScanSound } from '../lib/sound';
import { useSyncStatus } from '../lib/sync';

type LoadStatus = 'loading' | 'ready' | 'error';

/** Focus belongs to these when the person deliberately moved it there
 *  — a Settings-page input, say — so the drift handler below leaves it
 *  alone rather than fighting them for it. The scan toolbar's own
 *  one-shot buttons (Retry failed, Clear sent, Discard failed) are the
 *  deliberate exception: they take focus to be clicked, do their job,
 *  and hand it straight back once their action resolves — see
 *  `runToolbarAction`. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

function statusLabel(row: OutboxRow): string {
  switch (row.status) {
    case 'accepted': return 'Sent';
    case 'sending': return 'Sending';
    case 'retrying': return `Retrying (${row.attempts}/${BACKOFF.length})`;
    case 'failed': return `Failed: ${row.last_error ?? 'timeout'}`;
    case 'nomatch': return 'No match';
    default: return 'Queued';
  }
}

function scanTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function Scan() {
  const [setup] = useKioskSetup();
  const { phase } = useSyncStatus();
  const [appearance] = useAppearance();
  const { rows, counts } = useOutbox();
  const [value, setValue] = useState('');
  const [index, setIndex] = useState<ScanIndex | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  // Set by a failed enqueue/toolbar write and left up until something
  // succeeds — an unattended kiosk needs an operator to notice storage
  // is failing, not a toast that vanishes before anyone walks back over.
  const [storageError, setStorageError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const firstLoad = useRef(true);

  // The roster is read once and indexed once — a scan must not wait on
  // IndexedDB. Re-read when a sync finishes (the kiosk may have been
  // re-pointed at another move) or when the stores were just cleared.
  useEffect(() => {
    const load = () => {
      const myLoad = ++loadId.current;
      getAll<ScanAsset>('assets')
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

  // The sender runs while this screen is open. Leaving the page does not
  // drop the queue — it stays in IndexedDB and resumes on the next visit.
  useEffect(() => {
    startSender();
    return () => stopSender();
  }, []);

  const empty = loadStatus === 'ready' && (index?.size ?? 0) === 0;
  const disabled = loadStatus !== 'ready' || empty || !setup;

  const focusInput = () => {
    const el = inputRef.current;
    if (el && !el.disabled) el.focus();
  };

  useEffect(() => {
    if (!disabled) focusInput();
  }, [disabled]);

  // Focus is the whole interaction: a scanner types into whatever has
  // it. `focusout` fires before the new element is focused, so the check
  // waits a tick and then looks at where focus actually landed.
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
    if (!raw || !index || !setup) return;      // an empty Enter is a no-op

    const where = {
      site_id: setup.siteId,
      initiative_id: setup.initiativeId,
      scan_status: setup.scanStatus,
    };
    const match = matchScan(index, raw);
    flash(hslCss(match ? appearance.good_scan : appearance.not_found_scan), appearance.flash_ms);
    // Sound is feedback, never a gate: `playScanSound` swallows its own
    // failures, so a kiosk with no audio device still records the scan.
    playScanSound(match ? 'good' : 'not_found');
    const enqueued = match
      ? enqueueScan({
          scanned_value: raw,
          scan_type: scanTypeFor(match.kind),
          asset: {
            id: match.asset.id,
            asset_id: match.asset.asset_id,
            name: match.asset.name,
            rfid: match.asset.rfid,
            serial_number: match.asset.serial_number,
            make_model: match.asset.make_model,
          },
          ...where,
        })
      : enqueueScan({ scanned_value: raw, scan_type: 'barcode', asset: null, ...where });
    // Attaching both handlers to the same promise (rather than a bare
    // `.catch`) is what keeps a storage failure from a scan the operator
    // never sees resolved — it must land on screen, not vanish as an
    // unhandled rejection nobody was watching for.
    void enqueued.then(
      () => setStorageError(null),
      () => setStorageError(
        "Couldn't save the scan to this kiosk's storage — the last value was not recorded.",
      ),
    );
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitScan();
  };

  // Enter is handled on the key, not left to the form's implicit
  // submission: a scanner's Enter is the only way a scan is ever
  // entered, and whether a browser implicitly submits a
  // single-input, button-less form is not something to bet the
  // feature on (Chrome, driven over CDP, does not).
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitScan();
  };

  const subtitle = useMemo(
    () => (setup ? `${setup.initiativeName} · ${setup.siteName}` : ''),
    [setup],
  );

  // Retry failed / Clear sent / Discard failed are one-shot actions, not
  // sustained focus targets: the general focusout handler above leaves
  // focus wherever the operator clicked (so typing into some other
  // input or select on the page is not fought), but a scanner needs the
  // scan box back the moment one of these buttons has done its job.
  // Storage failures are surfaced instead of swallowed, same as enqueue.
  const runToolbarAction = (action: () => Promise<void>) => {
    void action()
      .then(() => setStorageError(null), () => setStorageError("Couldn't update the scan list."))
      .finally(focusInput);
  };

  const onDiscardFailed = () => {
    if (!window.confirm(
      `Discard ${counts.failed} failed scans? They were never received by the portal.`,
    )) return;
    runToolbarAction(discardFailed);
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Scanning</div>
      <h1 className="page-title">{setup?.scanLabel ?? 'Scanning'}</h1>
      {setup
        ? <p className="page-hint">{subtitle}</p>
        : <p className="page-hint">Finish Kiosk Setup first.</p>}

      {loadStatus === 'error' && (
        <p className="form-error" role="alert">Couldn&apos;t read this kiosk&apos;s local data.</p>
      )}
      {storageError && (
        <p className="form-error scan-storage-error" role="alert">{storageError}</p>
      )}
      {empty && (
        <p className="page-hint">No move data on this kiosk. Sync it from Kiosk Setup.</p>
      )}

      <form onSubmit={onSubmit}>
        <input
          id="scan-input"
          ref={inputRef}
          className="scan-input"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
          autoFocus
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          placeholder="Scan or type a serial, asset ID, or RFID"
          aria-label="Scan value"
          disabled={disabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </form>

      <div className="scan-toolbar">
        <p className="scan-counts">
          {counts.queued} queued · {counts.accepted} sent · {counts.failed} failed
        </p>
        {counts.failed > 0 && (
          <button
            type="button" className="mini-btn"
            onClick={() => runToolbarAction(retryFailed)}
          >
            Retry failed
          </button>
        )}
        {counts.accepted + counts.nomatch > 0 && (
          <button
            type="button" className="mini-btn"
            onClick={() => runToolbarAction(clearSent)}
          >
            Clear sent
          </button>
        )}
        {counts.failed > 0 && (
          <button type="button" className="mini-btn" onClick={onDiscardFailed}>
            Discard failed
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="page-hint">Nothing scanned yet.</p>
      ) : (
        <div className="local-table-wrap">
          <table className="local-table scan-list">
            <thead>
              <tr>
                <th>Serial</th>
                <th>Name</th>
                <th>RFID</th>
                <th>Make / Model</th>
                <th>Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.client_scan_id} className={`scan-row is-${row.status}`}>
                  {/* An unmatched scan has no asset to describe, so the
                      raw value stands in for the serial and the rest is
                      honestly blank. */}
                  <td className="mono">{row.asset?.serial_number || row.scanned_value}</td>
                  <td>{row.asset?.name ?? '—'}</td>
                  <td className="mono" title={row.asset?.rfid ?? undefined}>
                    {row.asset ? displayRfid(row.asset.rfid) : '—'}
                  </td>
                  <td>{row.asset?.make_model || '—'}</td>
                  <td className="mono">{scanTime(row.scanned_at)}</td>
                  <td><span className="scan-chip">{statusLabel(row)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
