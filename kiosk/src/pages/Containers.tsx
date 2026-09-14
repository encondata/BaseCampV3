/**
 * Containers — packing and unpacking crates out on the floor.
 *
 * Two steps, one always-focused box at a time, the same shape as RFID
 * Enroll because the job has the same shape: you pick the thing once,
 * then you scan repeatedly against it. **Step one** identifies the
 * container — an RFID tag, a Container Labels tag key, or the crate's
 * name, matched against the containers this kiosk downloaded
 * (`containerMatch.ts`); a typed partial that several names share shows
 * a short tappable list rather than guessing, exactly as the Timeclock
 * screen does. **Step two** is a Pack / Unpack toggle over the asset
 * box, under a card naming the crate and counting what is in it.
 *
 * The asset box matches on RFID, asset ID, or serial — `matchScan`'s
 * full order. Unlike RFID Enroll's first step, an RFID read here is a
 * perfectly good way to say which asset you are holding: nothing is
 * being written onto the tag, so there is no risk of silently re-tagging
 * whatever the tag already belongs to.
 *
 * Pack semantics live on the server (see the endpoint's docstring) and
 * follow from one constraint: `container_assets.asset_id` is UNIQUE, so
 * an asset is in at most one container. Packing something already
 * crated elsewhere therefore MOVES it, and the answer says where from —
 * the row shows "moved from {name}" so nobody has to wonder why another
 * crate just got lighter. Packing into the crate it is already in is a
 * no-op that still records the scan, and the screen says so rather than
 * repeating the good flash: `already_there` gets the **duplicate**
 * color, the duplicate sound, and a marker on the row that is already
 * there — never a second row, because a row is a claim that something
 * happened and nothing did.
 *
 * Online only, deliberately. Membership is relational state the kiosk
 * cannot resolve alone — only the portal knows which other crate holds
 * an asset — so there is no outbox here (unlike Scanning, whose queue
 * exists because a dock loses signal mid-shift). A scan that did not
 * reach the portal did not happen, and the screen says so rather than
 * promising to send it later. An offline queue is the obvious follow-up
 * and is not in this version; see the spec.
 *
 * The session list below is React state only, capped at fifty rows, and
 * cleared by a reload or by Done — it is this crate's context, not a log
 * (the portal's container record and the pack / unpack scans are the
 * record of truth, the same call Timeclock and RFID Enroll made).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { displayRfid } from '@portal/lib/format';

import { ApiError, postContainerAsset } from '../lib/api';
import { hslCss, useAppearance } from '../lib/appearance';
import { useCheckpoint } from '../lib/checkpointSettings';
import {
  buildContainerIndex, matchContainer, searchContainers, type ContainerRow,
} from '../lib/containerMatch';
import { flash } from '../lib/flash';
import { getIdentity, uuid } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';
import { getAll } from '../lib/localDb';
import { buildScanIndex, matchScan, scanTypeFor, type ScanAsset } from '../lib/scanMatch';
import { playScanSound } from '../lib/sound';
import { useSyncStatus } from '../lib/sync';

type LoadStatus = 'loading' | 'ready' | 'error';
type Action = 'pack' | 'unpack';

/** What a row records. `already_in` is not an action — nobody did
 *  anything — so it never wears the Pack chip; it is the honest label for
 *  an asset this session found already crated here. */
type RowKind = Action | 'already_in';

/** One row of the session-only list under the input. `movedFrom` is the
 *  crate the asset came out of, when the unique membership constraint
 *  turned a pack into a move; `again` counts the repeat scans this row
 *  has absorbed, so a sweep of the same crate marks the row instead of
 *  growing the list. `assetId` is what a repeat is matched on. */
interface SessionRow {
  id: string;
  assetId: string;
  name: string;
  serial: string | null;
  rfid: string | null;
  kind: RowKind;
  movedFrom: string | null;
  again: number;
  at: string;
}

const MAX_ROWS = 50;
const MAX_RESULTS = 8;

/** The Scanning page's rule: focus is only reclaimed from things nobody
 *  deliberately moved it to. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

const ERROR_MS = 4_000;

const ACTIONS: { id: Action; label: string }[] = [
  { id: 'pack', label: 'Pack' },
  { id: 'unpack', label: 'Unpack' },
];

/** The chip on a row. Pack and Unpack are things the operator did, and
 *  are titled like actions; "already in" is a state the crate was in
 *  before the scan, and is deliberately not. */
const ROW_LABEL: Record<RowKind, string> = {
  pack: 'Pack', unpack: 'Unpack', already_in: 'already in',
};

/** "scanned again", then "scanned again ×2" — a count only once there is
 *  something to count. */
function againText(n: number): string {
  return n > 1 ? `scanned again ×${n}` : 'scanned again';
}

/** What a refused scan says out loud. The portal's own code is kept in
 *  the fallback so an unexpected answer is still reportable. */
function scanErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  const status = err instanceof ApiError ? err.status : 0;
  if (code === 'not_in_container') {
    const detail = err instanceof ApiError ? err.detail : null;
    const name = (detail && typeof detail === 'object'
      && typeof (detail as { container_name?: unknown }).container_name === 'string')
      ? (detail as { container_name: string }).container_name
      : 'another container';
    return `That asset is in ${name}, not this container.`;
  }
  if (code === 'container_not_found') return 'That container is gone — scan it again.';
  if (code === 'read_only_mode' || status === 423) {
    return 'The portal is in read-only mode. Try again shortly.';
  }
  if (code === 'network') return "Can't reach the portal. That scan was not recorded.";
  return `Couldn't record that (${code}).`;
}

/** The one inline line under the box. A refusal is an `alert` in the
 *  error color; a repeat scan is a `status` in the duplicate color —
 *  nothing went wrong, so nothing shouts. */
interface Message { kind: 'error' | 'note'; text: string }

function ScanMessage({ message }: { message: Message | null }) {
  if (!message) return null;
  return message.kind === 'error'
    ? <p className="form-error" role="alert">{message.text}</p>
    : <p className="ct-note" role="status">{message.text}</p>;
}

/** Matches the Scanning list's time column. */
function scannedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function Containers() {
  const [setup] = useKioskSetup();
  const { phase } = useSyncStatus();
  const [appearance] = useAppearance();
  const [packStatus] = useCheckpoint('containerPack');
  const [unpackStatus] = useCheckpoint('containerUnpack');

  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [assets, setAssets] = useState<ScanAsset[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');

  const [container, setContainer] = useState<ContainerRow | null>(null);
  const [assetCount, setAssetCount] = useState(0);
  const [action, setAction] = useState<Action>('pack');
  const [value, setValue] = useState('');
  const [assetValue, setAssetValue] = useState('');
  const [choices, setChoices] = useState<ContainerRow[]>([]);
  const [sending, setSending] = useState(false);
  // One inline slot, two voices: a refusal is an alert, a repeat scan is
  // a status. Nothing went wrong when a crate already holds the asset,
  // and the line must not read as if it had.
  const [message, setMessage] = useState<Message | null>(null);
  const [rows, setRows] = useState<SessionRow[]>([]);

  const containerRef = useRef<HTMLInputElement>(null);
  const assetRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const firstLoad = useRef(true);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Both local stores are read once and indexed once — a scan must not
  // wait on IndexedDB. Re-read when a sync finishes (the kiosk may have
  // been re-pointed at another move) or when the stores were cleared.
  useEffect(() => {
    const load = () => {
      const myLoad = ++loadId.current;
      Promise.all([getAll<ContainerRow>('containers'), getAll<ScanAsset>('assets')])
        .then(([crates, roster]) => {
          if (myLoad !== loadId.current) return;
          setContainers(crates);
          setAssets(roster);
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
    if (messageTimer.current) clearTimeout(messageTimer.current);
  }, []);

  const containerIndex = useMemo(() => buildContainerIndex(containers), [containers]);
  const assetIndex = useMemo(() => buildScanIndex(assets), [assets]);

  const noContainers = loadStatus === 'ready' && containers.length === 0;
  const disabled = loadStatus !== 'ready' || noContainers || !setup;
  const onAssetStep = container !== null;

  useEffect(() => {
    if (disabled) return;
    const el = onAssetStep ? assetRef.current : containerRef.current;
    if (el && !el.disabled) el.focus();
  }, [disabled, onAssetStep]);

  // Focus is the whole interaction: a scanner types into whatever has
  // it. `focusout` fires before the new element is focused, so the check
  // waits a tick and then looks at where focus actually landed.
  useEffect(() => {
    if (disabled) return undefined;
    const reclaim = () => {
      const el = onAssetStep ? assetRef.current : containerRef.current;
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
  }, [disabled, onAssetStep]);

  const showMessage = (kind: Message['kind'], text: string) => {
    if (messageTimer.current) clearTimeout(messageTimer.current);
    setMessage({ kind, text });
    messageTimer.current = setTimeout(() => setMessage(null), ERROR_MS);
  };

  const showError = (text: string) => showMessage('error', text);
  const showNote = (text: string) => showMessage('note', text);

  const clearMessage = () => {
    if (messageTimer.current) clearTimeout(messageTimer.current);
    setMessage(null);
  };

  const bad = () => {
    flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
    playScanSound('not_found');
  };

  /** A scan that changed nothing: its own color and its own sound, so an
   *  operator sweeping a crate can tell it from a pack without reading. */
  const nothingHappened = () => {
    flash(hslCss(appearance.duplicate_scan), appearance.flash_ms);
    playScanSound('duplicate');
  };

  const pick = (row: ContainerRow) => {
    clearMessage();
    setChoices([]);
    setValue('');
    setAssetValue('');
    setAction('pack');
    setContainer(row);
    setAssetCount(row.asset_count);
  };

  /** Back to step one, empty, ready for the next crate — the session
   *  list goes with it. It is this crate's context, not a log: leaving
   *  the last crate's rows under the next crate's card would read as
   *  "these are in here", which is exactly wrong. */
  const done = () => {
    clearMessage();
    setChoices([]);
    setContainer(null);
    setAssetCount(0);
    setValue('');
    setAssetValue('');
    setSending(false);
    setRows([]);
  };

  const submitContainer = () => {
    const raw = value.trim();
    if (!raw || disabled) return;            // an empty Enter is a no-op
    const hit = matchContainer(containerIndex, raw);
    if (hit) {
      pick(hit.container);
      return;
    }
    // Not an exact match: a typed partial that several crates share is a
    // choice to offer, not a miss — several names on a move differ only
    // by their trailing number.
    const near = searchContainers(containerIndex, raw, MAX_RESULTS);
    if (near.length === 1) {
      pick(near[0]);
      return;
    }
    if (near.length > 1) {
      setChoices(near);
      return;                                // the list stays; they tap one
    }
    setValue('');
    setChoices([]);
    bad();
    showError(`No container found for "${raw}".`);
  };

  const submitAsset = () => {
    const raw = assetValue.trim();
    setAssetValue('');
    if (!raw || !container || sending) return;
    const hit = matchScan(assetIndex, raw);
    if (!hit) {
      bad();
      showError(`No asset found for "${raw}".`);
      return;
    }
    const asset = hit.asset;
    const crate = container;
    setSending(true);
    clearMessage();
    postContainerAsset({
      container_id: crate.id,
      serial: getIdentity().serial,
      asset_id: asset.id,
      action,
      scanned_value: raw,
      scan_type: scanTypeFor(hit.kind),
      scan_status: action === 'pack' ? packStatus : unpackStatus,
      client_scan_id: uuid(),
      site_id: setup?.siteId,
      initiative_id: setup?.initiativeId,
    }).then(
      (result) => {
        setSending(false);
        const name = result.asset.name || asset.name || result.asset.asset_tag || asset.asset_id;
        const serial = result.asset.serial_number ?? asset.serial_number;
        const rfid = result.asset.rfid ?? asset.rfid;

        // An asset is in at most one container, so a repeat pack is a
        // nothing-happened event: no second row, and the header count
        // does not move because nothing moved.
        if (result.already_there) {
          nothingHappened();
          showNote(`${name} is already in this container.`);
          setRows((current) => {
            const at = current.findIndex((r) => r.assetId === asset.id);
            if (at === -1) {
              // Packed earlier, or by someone else: there is nothing to
              // mark, and a "Pack" row would claim work this session
              // never did.
              return [{
                id: uuid(),
                assetId: asset.id,
                name,
                serial,
                rfid,
                kind: 'already_in' as const,
                movedFrom: null,
                again: 0,
                at: new Date().toISOString(),
              }, ...current].slice(0, MAX_ROWS);
            }
            const next = current.slice();
            // The original chip and time are left alone — they record
            // the scan that did something.
            next[at] = { ...next[at], again: next[at].again + 1 };
            return next;
          });
          return;
        }

        flash(hslCss(appearance.good_scan), appearance.flash_ms);
        playScanSound('good');
        setAssetCount(result.container.asset_count);
        setRows((current) => [
          {
            id: uuid(),
            assetId: asset.id,
            name,
            serial,
            rfid,
            kind: result.action,
            movedFrom: result.moved_from?.name ?? null,
            again: 0,
            at: new Date().toISOString(),
          },
          ...current,
        ].slice(0, MAX_ROWS));
      },
      (err: unknown) => {
        bad();
        setSending(false);
        showError(scanErrorText(err));
      },
    );
  };

  // Enter is handled on the key, not left to the form's implicit
  // submission: a scanner's Enter is the only way a scan is ever
  // entered, and Chrome does not implicitly submit a single-input,
  // button-less form (found live on the Scanning page).
  const onKeyDown = (submit: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  };

  const subtitle = setup ? `${setup.initiativeName} · ${setup.siteName}` : '';

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Containers</div>
      <h1 className="page-title">Containers</h1>
      {setup
        ? <p className="page-hint">{subtitle}</p>
        : <p className="page-hint">Finish Kiosk Setup first.</p>}

      {loadStatus === 'error' && (
        <p className="form-error" role="alert">Couldn&apos;t read this kiosk&apos;s local data.</p>
      )}
      {noContainers && (
        <p className="page-hint">No containers on this kiosk. Sync them from Kiosk Setup.</p>
      )}

      {onAssetStep && container ? (
        <>
          <div className="ct-card">
            <div className="ct-card-name">{container.name}</div>
            <dl className="ct-facts">
              <div>
                <dt>Type</dt>
                <dd>{container.container_type || '—'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{container.status_label || container.status}</dd>
              </div>
              <div>
                <dt>Site</dt>
                <dd>{container.site_name || '—'}</dd>
              </div>
              <div>
                <dt>Assets</dt>
                <dd className="ct-count" data-testid="container-asset-count">{assetCount}</dd>
              </div>
            </dl>
          </div>

          <div className="segmented ct-actions" role="radiogroup" aria-label="Pack or unpack">
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={a.id === action}
                className={a.id === action ? 'on' : ''}
                onClick={() => {
                  // Switching mid-stream clears whatever was half-typed:
                  // a value scanned for "pack" must never be sent as an
                  // unpack because the toggle moved under it.
                  setAction(a.id);
                  setAssetValue('');
                  clearMessage();
                  assetRef.current?.focus();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>

          <input
            id="container-asset-input"
            ref={assetRef}
            className="scan-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder={action === 'pack' ? 'Scan an asset to pack' : 'Scan an asset to unpack'}
            aria-label="Asset tag, ID, or serial"
            disabled={sending}
            value={assetValue}
            onChange={(e) => setAssetValue(e.target.value)}
            onKeyDown={onKeyDown(submitAsset)}
          />
          <ScanMessage message={message} />
          <div className="ct-done">
            <button type="button" className="mini-btn" onClick={done}>Done</button>
          </div>
        </>
      ) : (
        <>
          <input
            id="container-input"
            ref={containerRef}
            className="scan-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder="Scan a container tag or type its name"
            aria-label="Container tag or name"
            disabled={disabled}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown(submitContainer)}
          />
          <ScanMessage message={message} />
          {choices.length > 0 && (
            <div className="tc-results">
              {choices.map((row) => (
                <button
                  type="button" key={row.id} className="tc-result"
                  onClick={() => pick(row)}
                >
                  <span className="tc-result-name">{row.name}</span>
                  {row.container_type && (
                    <span className="tc-result-chip">{row.container_type}</span>
                  )}
                  <span className="tc-result-tag">{row.asset_count} assets</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {rows.length > 0 && (
        <div className="local-table-wrap ct-list-wrap">
          <table className="local-table ct-list">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Serial</th>
                <th>RFID</th>
                <th aria-label="Action" />
                <th aria-label="Time" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.name}
                    {row.movedFrom && (
                      <span className="ct-moved">moved from {row.movedFrom}</span>
                    )}
                  </td>
                  <td className="mono">{row.serial || '—'}</td>
                  <td className="mono" title={row.rfid ?? undefined}>
                    {row.rfid ? displayRfid(row.rfid) : '—'}
                  </td>
                  <td>
                    <span className="chip tag ct-chip">{ROW_LABEL[row.kind]}</span>
                    {row.again > 0 && (
                      <span className="chip tag ct-again">{againText(row.again)}</span>
                    )}
                  </td>
                  <td className="mono">{scannedAt(row.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
