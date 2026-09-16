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
 * Between the two, an asset that ALREADY carries a tag stops on a
 * confirmation card instead of dropping straight into the tag box: its
 * details and current tag are shown, and only an explicit **Update RFID
 * Value** press opens the box. Focus parks on the card, which is not a
 * control, so a second scan of the same barcode types into nothing and
 * its Enter presses nothing — the double scan this screen is most
 * likely to see cannot retag anything by itself.
 *
 * The tag box has its own gate (`lib/enrollGate.ts`): an entry that is
 * really an asset ID or serial is refused by name, and so is a tag the
 * roster or this session's log (`lib/enrollLog.ts`) already has on
 * another asset. The save still runs its own check — a 409 the gate
 * could not have known about is fed back into the log, so the retry is
 * refused locally.
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
import { checkTagEntry } from '../lib/enrollGate';
import { noteTagHolder, recordEnrollment, tagHolder } from '../lib/enrollLog';
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

/** Which of the screen's three faces is showing. `confirm` only ever
 *  appears for an asset that already has a tag — the gate between a
 *  scan and a replacement. */
type Step = 'asset' | 'confirm' | 'tag';

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

/** The asset a 409 `rfid_in_use` says actually holds the tag, when the
 *  portal named one. Null for every other failure — including a 409
 *  whose detail did not arrive in the shape the endpoint documents. */
function rfidClash(err: unknown): { assetId: string; assetName: string } | null {
  if (!(err instanceof ApiError) || err.code !== 'rfid_in_use') return null;
  const detail = err.detail;
  if (!detail || typeof detail !== 'object') return null;
  const { asset_id: id, asset_name: name } = detail as {
    asset_id?: unknown; asset_name?: unknown;
  };
  if (typeof id !== 'string' || !id) return null;
  return { assetId: id, assetName: typeof name === 'string' && name ? name : 'another asset' };
}

/** What a refused save says out loud. The portal's own code is kept in
 *  the fallback so an unexpected answer is still reportable. The
 *  `rfid_in_use` wording matches the local gate's, because the operator
 *  is being told the same thing either way. */
function saveErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  const status = err instanceof ApiError ? err.status : 0;
  if (code === 'rfid_in_use') {
    return `That tag is already on ${rfidClash(err)?.assetName ?? 'another asset'}.`;
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
  const [step, setStep] = useState<Step>('asset');
  const [value, setValue] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);

  const assetRef = useRef<HTMLInputElement>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
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

  // The confirmation card is focusable but is NOT a control: parking
  // focus there is what makes a stray second scan harmless.
  const stepTarget = (): HTMLElement | null => {
    if (step === 'tag') return tagRef.current;
    if (step === 'confirm') return confirmRef.current;
    return assetRef.current;
  };
  const focusable = (el: HTMLElement | null): el is HTMLElement => (
    el !== null && !(el as Partial<HTMLInputElement>).disabled
  );

  const focusStep = () => {
    const el = stepTarget();
    if (focusable(el)) el.focus();
  };

  useEffect(() => {
    if (!disabled) focusStep();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusStep reads the step
  }, [disabled, step]);

  // Focus is the whole interaction: a scanner types into whatever has
  // it. `focusout` fires before the new element is focused, so the check
  // waits a tick and then looks at where focus actually landed.
  useEffect(() => {
    if (disabled) return undefined;
    const reclaim = () => {
      const el = stepTarget();
      if (!focusable(el) || document.activeElement === el) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stepTarget reads the step
  }, [disabled, step]);

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
    setStep('asset');
    setValue('');
    setTagValue('');
    setSaving(false);
  };

  /** The deliberate press that opens the tag box for an asset that
   *  already has one. Nothing a scanner can do reaches this. */
  const toTagStep = () => {
    clearError();
    setTagValue('');
    setStep('tag');
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
      // An asset that already carries a tag stops for a look first; only
      // an untagged one drops straight into the box. A repeat of an
      // asset THIS session tagged is the duplicate outcome the
      // Containers and Trucks screens use — a third signal for "you
      // already did this", distinct from good and not-found.
      const tagged = Boolean(hit.asset.rfid);
      setStep(tagged ? 'confirm' : 'tag');
      if (tagged && tagHolder(hit.asset.rfid!)?.assetId === hit.asset.id) {
        flash(hslCss(appearance.duplicate_scan), appearance.flash_ms);
        playScanSound('duplicate');
      }
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
        // The gate's fast half learns the tag now, so re-waving it at
        // the next asset is refused without a round trip.
        recordEnrollment({
          tag: result.rfid_tag,
          assetId: target.id,
          assetName: result.asset_name ?? target.name ?? target.asset_id,
        });
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
        // A 409 names the asset that actually holds the tag; remember it
        // so an immediate re-scan is refused here instead of asking the
        // portal the same question again.
        const clash = rfidClash(err);
        if (clash) noteTagHolder(tag, clash.assetId, clash.assetName);
        showError(saveErrorText(err));
      },
    );
  };

  const submitTag = () => {
    const raw = tagValue;
    if (!raw.trim() || saving) return;          // an empty Enter is a no-op
    const gate = checkTagEntry(index, asset!, raw);
    setTagValue('');
    if (!gate.ok) {
      flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
      playScanSound('not_found');
      showError(gate.message);
      return;
    }
    save(gate.tag);
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

  /** Set when THIS kiosk gave the asset the tag it is wearing — the
   *  double-scan case, worth saying out loud on the confirmation card. */
  const thisSession = (asset?.rfid && tagHolder(asset.rfid)?.assetId === asset.id)
    ? tagHolder(asset.rfid) : null;

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

      {asset && (step === 'confirm' || step === 'tag') && (
        <div
          className={`enroll-card${step === 'confirm' ? ' is-confirm' : ''}`}
          ref={confirmRef}
          // Focusable but not a control: on the confirmation step a
          // stray scan types into nothing and its Enter presses nothing.
          tabIndex={step === 'confirm' ? -1 : undefined}
          role={step === 'confirm' ? 'group' : undefined}
          aria-label={step === 'confirm' ? 'Asset already tagged' : undefined}
        >
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
          {step === 'confirm' && (
            <>
              <p className="enroll-replace">
                {thisSession
                  ? `This kiosk tagged it at ${enrolledAt(thisSession.at)}.`
                  : 'This asset already has a tag.'}
                {' '}
                Updating it replaces the tag on the portal.
              </p>
              <div className="enroll-actions">
                <button type="button" className="btn-solid" onClick={toTagStep}>
                  Update RFID Value
                </button>
                <button type="button" className="mini-btn" onClick={toAssetStep}>Cancel</button>
              </div>
            </>
          )}
          {step === 'tag' && asset.rfid && (
            <p className="enroll-replace">
              Scanning a new tag replaces the one above.
            </p>
          )}
        </div>
      )}

      {step === 'tag' && asset ? (
        <>
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
      ) : step === 'asset' ? (
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
      ) : (
        error && <p className="form-error" role="alert">{error}</p>
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
