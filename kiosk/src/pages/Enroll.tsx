/**
 * RFID Enroll — giving an asset its tag, out on the floor.
 *
 * Two steps, one always-focused box at a time, because both halves of
 * the job are scans and a scanner is a keyboard (the Scanning page's
 * rule, and its focus handling). **Step one** identifies the asset: a
 * serial or an asset ID, matched against the move downloaded to this
 * kiosk — asset ID or serial ONLY (`matchAssetOrSerial`), never RFID,
 * so waving a tag that already belongs to something cannot silently
 * become "re-tag that". **Step two** reads the tag itself, against a
 * card showing which asset is about to get it.
 *
 * A tag is stored as 24 characters, zero-padded (`lib/rfid.ts`). The
 * padding is shown under the box as it is typed so the operator sees
 * exactly what will be written, and the endpoint pads again itself —
 * the preview is a courtesy, not the enforcement.
 *
 * Online only, deliberately: whether a tag is already on another asset
 * is a question only the portal can answer, so there is no outbox here
 * (unlike scanning, whose queue exists because a dock loses signal
 * mid-shift). A save that did not reach the portal did not happen, and
 * the screen says so rather than promising to send it later. The
 * portal's asset record and the enrollment scan are the only trail.
 *
 * Below the input, a session-only list of this session's enrollments
 * (newest first, capped at 25) gives the operator a quick "what did I
 * just do" glance without leaving the screen. It lives in React state
 * only — no IndexedDB — and a reload clears it: the Timeclock screen
 * made the same call for the same reason (Jimmy, 2026-09-14, removing
 * its own recent list), because the portal's asset record and the
 * enrollment scan, not a kiosk-local cache, are the record of truth.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { displayRfid } from '@portal/lib/format';

import { ApiError, postRfidEnroll } from '../lib/api';
import { hslCss, useAppearance } from '../lib/appearance';
import { useCheckpoint } from '../lib/checkpointSettings';
import { flash } from '../lib/flash';
import { getIdentity, uuid } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';
import { getAll, putRows } from '../lib/localDb';
import { padRfid, rfidProblemText } from '../lib/rfid';
import {
  buildScanIndex, matchAssetOrSerial, matchScan, type ScanAsset,
} from '../lib/scanMatch';
import { playScanSound } from '../lib/sound';
import { useSyncStatus } from '../lib/sync';

type LoadStatus = 'loading' | 'ready' | 'error';

/** One row of the session-only "what did I just enroll" list below the
 *  input. Not the portal's `KioskRfidEnroll` shape verbatim — `at` is
 *  added for the list's time column and `replaced` is derived here,
 *  from what the page already knew about the asset before saving. */
interface EnrollmentRow {
  id: string;
  name: string;
  serial: string | null;
  rfid: string;
  replaced: boolean;
  at: string;
}

const MAX_ENROLLMENTS = 25;

/** The Scanning page's rule: focus is only reclaimed from things nobody
 *  deliberately moved it to. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

const TOAST_MS = 5_000;
const ERROR_MS = 4_000;

/** What a refused save says out loud. The portal's own code is kept in
 *  the fallback so an unexpected answer is still reportable. */
function saveErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  const status = err instanceof ApiError ? err.status : 0;
  if (code === 'rfid_in_use') {
    const detail = err instanceof ApiError ? err.detail : null;
    const name = (detail && typeof detail === 'object'
      && typeof (detail as { asset_name?: unknown }).asset_name === 'string')
      ? (detail as { asset_name: string }).asset_name
      : 'another asset';
    return `That tag is already on ${name}.`;
  }
  if (code === 'bad_rfid') return rfidProblemText('not_alphanumeric');
  if (code === 'rfid_too_long') return rfidProblemText('too_long');
  if (code === 'read_only_mode' || status === 423) {
    return 'The portal is in read-only mode. Try again shortly.';
  }
  if (code === 'network') return "Can't reach the portal. The tag was not saved.";
  return `Couldn't save the tag (${code}).`;
}

/** Matches the Scanning list's time column. */
function enrolledAt(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function Enroll() {
  const [setup] = useKioskSetup();
  const { phase } = useSyncStatus();
  const [appearance] = useAppearance();
  const [enrollStatus] = useCheckpoint('enroll');

  const [rows, setRows] = useState<ScanAsset[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');
  const [asset, setAsset] = useState<ScanAsset | null>(null);
  const [value, setValue] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);

  const assetRef = useRef<HTMLInputElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const firstLoad = useRef(true);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The roster is read once and indexed once — a scan must not wait on
  // IndexedDB. Re-read when a sync finishes (the kiosk may have been
  // re-pointed at another move) or when the stores were just cleared.
  useEffect(() => {
    const load = () => {
      const myLoad = ++loadId.current;
      getAll<ScanAsset>('assets')
        .then((assets) => {
          if (myLoad !== loadId.current) return;
          setRows(assets);
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

  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Rebuilt whenever the roster changes — including the row this screen
  // just tagged, so the new tag is known here immediately rather than
  // after the next sync.
  const index = useMemo(() => buildScanIndex(rows), [rows]);

  const empty = loadStatus === 'ready' && rows.length === 0;
  const disabled = loadStatus !== 'ready' || empty || !setup;
  const onTagStep = asset !== null;

  const focusStep = () => {
    const el = onTagStep ? tagRef.current : assetRef.current;
    if (el && !el.disabled) el.focus();
  };

  useEffect(() => {
    if (!disabled) focusStep();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusStep reads the step
  }, [disabled, onTagStep]);

  // Focus is the whole interaction: a scanner types into whatever has
  // it. `focusout` fires before the new element is focused, so the check
  // waits a tick and then looks at where focus actually landed.
  useEffect(() => {
    if (disabled) return undefined;
    const reclaim = () => {
      const el = onTagStep ? tagRef.current : assetRef.current;
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
  }, [disabled, onTagStep]);

  const showError = (text: string, ms = ERROR_MS) => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(text);
    errorTimer.current = setTimeout(() => setError(null), ms);
  };

  const showToast = (text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  const clearError = () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
  };

  /** Back to step one, empty and focused, ready for the next asset. */
  const toAssetStep = () => {
    clearError();
    setAsset(null);
    setValue('');
    setTagValue('');
    setSaving(false);
  };

  const submitAsset = () => {
    const raw = value.trim();
    setValue('');
    if (!raw || disabled) return;            // an empty Enter is a no-op
    const hit = matchAssetOrSerial(index, raw);
    if (hit) {
      clearError();
      setTagValue('');
      setAsset(hit.asset);
      return;
    }
    flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
    playScanSound('not_found');
    // A tag read at this step is a person standing in the wrong box, not
    // a miss — tell them which scan is wanted rather than "no asset".
    const asTag = matchScan(index, raw);
    showError(asTag?.kind === 'rfid'
      ? "That's an RFID tag. Scan the asset's serial or ID first."
      : `No asset found for "${raw}".`);
  };

  const save = (tag: string) => {
    if (!asset || saving) return;
    const target = asset;
    setSaving(true);
    clearError();
    postRfidEnroll({
      asset_id: target.id,
      serial: getIdentity().serial,
      rfid_tag: tag,
      scan_status: enrollStatus,
      client_scan_id: uuid(),
      site_id: setup?.siteId,
      initiative_id: setup?.initiativeId,
    }).then(
      (result) => {
        flash(hslCss(appearance.good_scan), appearance.flash_ms);
        playScanSound('good');
        // The local roster learns the tag now, so the Scanning screen
        // recognizes it without waiting for the next sync.
        const next = { ...target, rfid: result.rfid_tag };
        setRows((current) => current.map((row) => (row.id === target.id ? next : row)));
        void putRows('assets', [next]).catch(() => {
          showError("The tag was saved to the portal, but this kiosk's copy is stale.");
        });
        showToast(`Enrolled ${result.asset_name ?? target.name ?? target.asset_id}`
          + ` → ${displayRfid(result.rfid_tag)}`);
        // "Replaced" means the asset walked in with a different tag
        // already on it — not the already_had_tag case, where the same
        // tag was re-scanned and nothing actually changed.
        setEnrollments((current) => [
          {
            id: uuid(),
            name: result.asset_name ?? target.name ?? target.asset_id,
            serial: result.serial_number ?? target.serial_number,
            rfid: result.rfid_tag,
            replaced: Boolean(target.rfid) && !result.already_had_tag,
            at: new Date().toISOString(),
          },
          ...current,
        ].slice(0, MAX_ENROLLMENTS));
        toAssetStep();
      },
      (err: unknown) => {
        flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
        playScanSound('not_found');
        setSaving(false);
        setTagValue('');
        showError(saveErrorText(err));
      },
    );
  };

  const submitTag = () => {
    const { tag, problem } = padRfid(tagValue);
    if (problem) {
      setTagValue('');
      showError(rfidProblemText(problem));
      return;
    }
    save(tag!);
  };

  // Enter is handled on the key, not left to the form's implicit
  // submission: a scanner's Enter is the only way a scan is ever
  // entered, and whether a browser implicitly submits a single-input,
  // button-less form is not something to bet the feature on (Chrome,
  // driven over CDP, does not).
  const onKeyDown = (submit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  };

  const preview = padRfid(tagValue).tag;
  const subtitle = setup ? `${setup.initiativeName} · ${setup.siteName}` : '';

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · RFID Enroll</div>
      <h1 className="page-title">RFID Enroll</h1>
      {setup
        ? <p className="page-hint">{subtitle}</p>
        : <p className="page-hint">Finish Kiosk Setup first.</p>}

      {loadStatus === 'error' && (
        <p className="form-error" role="alert">Couldn&apos;t read this kiosk&apos;s local data.</p>
      )}
      {empty && (
        <p className="page-hint">No move data on this kiosk. Sync it from Kiosk Setup.</p>
      )}
      {toast && <p className="tc-toast" role="status">{toast}</p>}

      {onTagStep && asset ? (
        <>
          <div className="enroll-card">
            <div className="enroll-card-name">{asset.name || 'Unnamed asset'}</div>
            <dl className="enroll-facts">
              <div>
                <dt>Asset ID</dt>
                <dd className="mono">{asset.asset_id || '—'}</dd>
              </div>
              <div>
                <dt>Serial</dt>
                <dd className="mono">{asset.serial_number || '—'}</dd>
              </div>
              <div>
                <dt>Make / Model</dt>
                <dd>{asset.make_model || '—'}</dd>
              </div>
              {asset.rfid && (
                <div>
                  <dt>Current tag</dt>
                  <dd className="mono" title={asset.rfid}>{displayRfid(asset.rfid)}</dd>
                </div>
              )}
            </dl>
            {asset.rfid && (
              <p className="enroll-replace">
                This asset already has a tag — scanning a new one replaces it.
              </p>
            )}
          </div>

          <input
            id="enroll-tag-input"
            ref={tagRef}
            className="scan-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder="Scan the RFID tag"
            aria-label="RFID tag"
            disabled={saving}
            value={tagValue}
            onChange={(e) => setTagValue(e.target.value)}
            onKeyDown={onKeyDown(submitTag)}
          />
          <p className="enroll-preview">
            {preview
              ? <>Will be stored as <span className="mono">{preview}</span></>
              : <span className="enroll-preview-hint">24 characters, zero-padded.</span>}
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="enroll-actions">
            <button type="button" className="mini-btn" onClick={toAssetStep}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <input
            id="enroll-asset-input"
            ref={assetRef}
            className="scan-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder="Scan a serial or asset ID"
            aria-label="Asset serial or ID"
            disabled={disabled}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown(submitAsset)}
          />
          {error && <p className="form-error" role="alert">{error}</p>}
        </>
      )}

      {enrollments.length > 0 && (
        <div className="local-table-wrap enroll-list-wrap">
          <table className="local-table enroll-list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Serial</th>
                <th>RFID</th>
                <th aria-label="Time" />
              </tr>
            </thead>
            <tbody>
              {enrollments.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td className="mono">{row.serial || '—'}</td>
                  <td className="mono" title={row.rfid}>
                    {displayRfid(row.rfid)}
                    {row.replaced && <span className="chip tag">replaced</span>}
                  </td>
                  <td className="mono">{enrolledAt(row.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
