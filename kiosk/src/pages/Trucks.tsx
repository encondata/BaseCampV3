/**
 * Trucks — loading and unloading trailers out on the dock. The sibling of
 * `Containers.tsx`, and deliberately the same two-step shape: you pick the
 * thing once, then scan repeatedly against it.
 *
 * **Step one is a card picker, not a scan box** — the one real difference
 * from Containers, and it follows from the data. A crate carries an RFID
 * tag and a printed label key; a truck carries neither (`trucks` has no
 * `rfid_tag` column, and there is nothing on a trailer to read), and a
 * move has a handful of them rather than hundreds. So the step looks like
 * Kiosk Setup's wizard: one `.setup-card` per synced truck showing what
 * tells them apart out on the yard — name, load number, status, driver,
 * the route, and how much is already aboard. A `.dir-search` filter above
 * the cards narrows by name or load number so a long list stays fast, and
 * typing a full name or load number and pressing Enter selects that truck
 * outright (`truckMatch.ts`), because someone who knows the load number
 * should not have to look for its card.
 *
 * **Step two takes a container OR an asset.** Trucks carry CONTAINERS —
 * `truck_containers` is keyed on (truck_id, container_id) and there is no
 * asset-to-truck link at all — but the thing in someone's hand on a dock
 * is often an asset, so the box resolves both: a container first (RFID,
 * label tag, exact name), then an asset (RFID, asset ID, serial) whose
 * crate is what actually gets loaded. The row then says "via asset
 * {name}" so nobody thinks the asset moved by itself. An asset in no
 * container cannot be loaded and says exactly that — pack it first.
 *
 * Load semantics live on the server (see the endpoint's docstring) and
 * follow from one crate riding one truck: loading a container that is on
 * ANOTHER truck MOVES it, and the answer says where from ("moved from
 * {truck}"), so nobody wonders why another trailer got lighter. Loading
 * onto the truck it is already on is a no-op that still records the scan.
 * Unloading from the wrong trailer is a refusal naming the right one,
 * never a silent removal.
 *
 * Online only, deliberately, for exactly the reason Containers is: which
 * truck carries a crate is relational state the kiosk cannot resolve
 * alone — only the portal knows whether it is already on another trailer
 * — so there is no outbox here (unlike Scanning, whose queue exists
 * because a dock loses signal mid-shift). A scan that did not reach the
 * portal did not happen, and the screen says so rather than promising to
 * send it later. An offline queue is the obvious follow-up and is not in
 * this version; see the spec.
 *
 * The session list below is React state only, capped at fifty rows, and
 * cleared by a reload or by Done — it is this truck's context, not a log
 * (the portal's truck record and the load / unload scans are the record
 * of truth).
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ApiError, postTruckContainer } from '../lib/api';
import { hslCss, useAppearance } from '../lib/appearance';
import { useCheckpoint } from '../lib/checkpointSettings';
import {
  buildContainerIndex, matchContainer, type ContainerRow,
} from '../lib/containerMatch';
import { flash } from '../lib/flash';
import { getIdentity, uuid } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';
import { getAll } from '../lib/localDb';
import { buildScanIndex, matchScan, scanTypeFor, type ScanAsset } from '../lib/scanMatch';
import { playScanSound } from '../lib/sound';
import { useSyncStatus } from '../lib/sync';
import { buildTruckIndex, filterTrucks, matchTruck, type TruckRow } from '../lib/truckMatch';

type LoadStatus = 'loading' | 'ready' | 'error';
type Action = 'load' | 'unload';

/** A cached asset plus the crate it is packed in — `/kiosk/sync/assets`
 *  carries `container_id` precisely so this screen can resolve a scanned
 *  asset to its container without a round trip. */
type PackedAsset = ScanAsset & { container_id?: string | null };

/** One row of the session-only list under the input. `movedFrom` is the
 *  truck the crate came off, when a load turned into a move; `viaAsset`
 *  is the asset that was actually scanned, when it was not the crate. */
interface SessionRow {
  id: string;
  name: string;
  assetCount: number;
  action: Action;
  movedFrom: string | null;
  viaAsset: string | null;
  at: string;
}

const MAX_ROWS = 50;

/** The Scanning page's rule: focus is only reclaimed from things nobody
 *  deliberately moved it to. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

const ERROR_MS = 4_000;

const ACTIONS: { id: Action; label: string }[] = [
  { id: 'load', label: 'Load' },
  { id: 'unload', label: 'Unload' },
];

/** The magnifying glass the portal's `.dir-search` toolbar draws. Inlined
 *  for the same reason `LocalDataInspector` inlines it: the kiosk cannot
 *  import a portal component, only its stylesheet. */
function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** What a refused scan says out loud. The portal's own code is kept in
 *  the fallback so an unexpected answer is still reportable. */
function scanErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  const status = err instanceof ApiError ? err.status : 0;
  if (code === 'not_on_truck') {
    const detail = err instanceof ApiError ? err.detail : null;
    const name = (detail && typeof detail === 'object'
      && typeof (detail as { truck_name?: unknown }).truck_name === 'string')
      ? (detail as { truck_name: string }).truck_name
      : null;
    return name
      ? `That container is on ${name}, not this truck.`
      : "That container isn't on a truck.";
  }
  if (code === 'container_not_found') return 'That container is gone — scan it again.';
  if (code === 'truck_not_found') return 'That truck is gone — pick it again.';
  if (code === 'read_only_mode' || status === 423) {
    return 'The portal is in read-only mode. Try again shortly.';
  }
  if (code === 'network') return "Can't reach the portal. That scan was not recorded.";
  return `Couldn't record that (${code}).`;
}

/** Matches the Scanning list's time column. */
function scannedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** "NAP11 → ACC4", with an em dash for a leg the truck has not been given. */
function routeText(truck: TruckRow): string {
  return `${truck.start_site_name || '—'} → ${truck.end_site_name || '—'}`;
}

export default function Trucks() {
  const [setup] = useKioskSetup();
  const { phase } = useSyncStatus();
  const [appearance] = useAppearance();
  const [loadCheckpoint] = useCheckpoint('truckLoad');
  const [unloadCheckpoint] = useCheckpoint('truckUnload');

  const [trucks, setTrucks] = useState<TruckRow[]>([]);
  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [assets, setAssets] = useState<PackedAsset[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading');

  const [truck, setTruck] = useState<TruckRow | null>(null);
  const [containerCount, setContainerCount] = useState(0);
  const [action, setAction] = useState<Action>('load');
  const [filter, setFilter] = useState('');
  const [scanValue, setScanValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SessionRow[]>([]);

  const filterRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const firstLoad = useRef(true);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // All three local stores are read once and indexed once — a scan must
  // not wait on IndexedDB. Re-read when a sync finishes (the kiosk may
  // have been re-pointed at another move) or when the stores were
  // cleared.
  useEffect(() => {
    const load = () => {
      const myLoad = ++loadId.current;
      Promise.all([
        getAll<TruckRow>('trucks'), getAll<ContainerRow>('containers'),
        getAll<PackedAsset>('assets'),
      ])
        .then(([fleet, crates, roster]) => {
          if (myLoad !== loadId.current) return;
          setTrucks(fleet);
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
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);

  const truckIndex = useMemo(() => buildTruckIndex(trucks), [trucks]);
  const containerIndex = useMemo(() => buildContainerIndex(containers), [containers]);
  const assetIndex = useMemo(() => buildScanIndex(assets), [assets]);
  const shown = useMemo(() => filterTrucks(truckIndex, filter), [truckIndex, filter]);

  const noTrucks = loadStatus === 'ready' && trucks.length === 0;
  const disabled = loadStatus !== 'ready' || noTrucks || !setup;
  const onScanStep = truck !== null;

  useEffect(() => {
    if (disabled) return;
    const el = onScanStep ? scanRef.current : filterRef.current;
    if (el && !el.disabled) el.focus();
  }, [disabled, onScanStep]);

  // Focus is the whole interaction on step two: a scanner types into
  // whatever has it. `focusout` fires before the new element is focused,
  // so the check waits a tick and then looks at where focus actually
  // landed. Step one keeps the same rule so the filter stays live for
  // someone typing a load number.
  useEffect(() => {
    if (disabled) return undefined;
    const reclaim = () => {
      const el = onScanStep ? scanRef.current : filterRef.current;
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
  }, [disabled, onScanStep]);

  const showError = (text: string) => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(text);
    errorTimer.current = setTimeout(() => setError(null), ERROR_MS);
  };

  const clearError = () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(null);
  };

  const bad = () => {
    flash(hslCss(appearance.not_found_scan), appearance.flash_ms);
    playScanSound('not_found');
  };

  const pick = (row: TruckRow) => {
    clearError();
    setFilter('');
    setScanValue('');
    setAction('load');
    setTruck(row);
    setContainerCount(row.container_count);
  };

  /** Back to step one, empty, ready for the next trailer — the session
   *  list goes with it. It is this truck's context, not a log: leaving
   *  the last truck's rows under the next truck's card would read as
   *  "these are on it", which is exactly wrong. */
  const done = () => {
    clearError();
    setTruck(null);
    setContainerCount(0);
    setFilter('');
    setScanValue('');
    setSending(false);
    setRows([]);
  };

  /** Enter on the filter: an exact name or load number is a selection.
   *  A partial is not — the cards below are already showing it. */
  const submitFilter = () => {
    const raw = filter.trim();
    if (!raw || disabled) return;            // an empty Enter is a no-op
    const hit = matchTruck(truckIndex, raw);
    if (hit) pick(hit.truck);
  };

  const submitScan = () => {
    const raw = scanValue.trim();
    setScanValue('');
    if (!raw || !truck || sending) return;

    // Container first, then asset — a crate is what a truck carries, so
    // a value that names one needs no indirection.
    const crateHit = matchContainer(containerIndex, raw);
    let containerId = crateHit?.container.id ?? null;
    let scanKind: 'rfid' | 'barcode' = crateHit
      ? (crateHit.kind === 'rfid' ? 'rfid' : 'barcode') : 'barcode';
    let viaAsset: string | null = null;

    if (!containerId) {
      const assetHit = matchScan(assetIndex, raw);
      if (!assetHit) {
        bad();
        showError(`No container or asset found for "${raw}".`);
        return;
      }
      const asset = assetHit.asset as PackedAsset;
      if (!asset.container_id) {
        bad();
        showError("That asset isn't in a container yet — pack it first.");
        return;
      }
      containerId = asset.container_id;
      scanKind = scanTypeFor(assetHit.kind);
      viaAsset = asset.name || asset.asset_id;
    }

    const trailer = truck;
    setSending(true);
    clearError();
    postTruckContainer({
      truck_id: trailer.id,
      serial: getIdentity().serial,
      container_id: containerId,
      action,
      scanned_value: raw,
      scan_type: scanKind,
      scan_status: action === 'load' ? loadCheckpoint : unloadCheckpoint,
      client_scan_id: uuid(),
      site_id: setup?.siteId,
      initiative_id: setup?.initiativeId,
    }).then(
      (result) => {
        flash(hslCss(appearance.good_scan), appearance.flash_ms);
        playScanSound('good');
        setSending(false);
        setContainerCount(result.truck.container_count);
        setRows((current) => [
          {
            id: uuid(),
            name: result.container.name,
            assetCount: result.container.asset_count,
            action: result.action,
            movedFrom: result.moved_from?.name ?? null,
            viaAsset,
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
      <div className="eyebrow">Kiosk · Trucks</div>
      <h1 className="page-title">Trucks</h1>
      {setup
        ? <p className="page-hint">{subtitle}</p>
        : <p className="page-hint">Finish Kiosk Setup first.</p>}

      {loadStatus === 'error' && (
        <p className="form-error" role="alert">Couldn&apos;t read this kiosk&apos;s local data.</p>
      )}

      {onScanStep && truck ? (
        <>
          <div className="ct-card">
            <div className="ct-card-name">{truck.name}</div>
            <dl className="ct-facts">
              <div>
                <dt>Load</dt>
                <dd>{truck.load_number || '—'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{truck.status_label || truck.status}</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>{routeText(truck)}</dd>
              </div>
              <div>
                <dt>Containers</dt>
                <dd className="ct-count" data-testid="truck-container-count">
                  {containerCount}
                </dd>
              </div>
            </dl>
          </div>

          <div className="segmented ct-actions" role="radiogroup" aria-label="Load or unload">
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={a.id === action}
                className={a.id === action ? 'on' : ''}
                onClick={() => {
                  // Switching mid-stream clears whatever was half-typed:
                  // a value scanned for "load" must never be sent as an
                  // unload because the toggle moved under it.
                  setAction(a.id);
                  setScanValue('');
                  clearError();
                  scanRef.current?.focus();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>

          <input
            id="truck-container-input"
            ref={scanRef}
            className="scan-input"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            placeholder="Scan a container, or an asset inside one"
            aria-label="Container tag or asset"
            disabled={sending}
            value={scanValue}
            onChange={(e) => setScanValue(e.target.value)}
            onKeyDown={onKeyDown(submitScan)}
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="ct-done">
            <button type="button" className="mini-btn" onClick={done}>Done</button>
          </div>
        </>
      ) : (
        <>
          <div className="local-toolbar tk-filter">
            <div className="dir-search">
              <SearchIcon />
              <input
                id="truck-filter"
                ref={filterRef}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="Filter by name or load number…"
                aria-label="Filter trucks"
                disabled={disabled}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={onKeyDown(submitFilter)}
              />
            </div>
          </div>
          {noTrucks ? (
            <p className="page-hint">No trucks on this move. Ask a coordinator to add one.</p>
          ) : (
            <div className="setup-cards" role="listbox" aria-label="Trucks">
              {shown.map((row) => (
                <button
                  key={row.id} type="button" role="option" aria-selected={false}
                  className="setup-card" onClick={() => pick(row)}
                >
                  <div className="setup-card-title">{row.name}</div>
                  {row.load_number && (
                    <div className="setup-card-role">{row.load_number}</div>
                  )}
                  <span className="chip tag">{row.status_label || row.status}</span>
                  {row.driver_name && (
                    <div className="setup-card-meta">{row.driver_name}</div>
                  )}
                  <div className="setup-card-sites">{routeText(row)}</div>
                  <div className="setup-card-meta">
                    {row.container_count} {row.container_count === 1 ? 'container' : 'containers'}
                  </div>
                </button>
              ))}
            </div>
          )}
          {!noTrucks && shown.length === 0 && (
            <p className="page-hint">No truck matches that.</p>
          )}
        </>
      )}

      {rows.length > 0 && (
        <div className="local-table-wrap ct-list-wrap">
          <table className="local-table ct-list">
            <thead>
              <tr>
                <th>Container</th>
                <th>Assets</th>
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
                    {row.viaAsset && (
                      <span className="ct-moved">via asset {row.viaAsset}</span>
                    )}
                  </td>
                  <td className="mono">{row.assetCount}</td>
                  <td>
                    <span className="chip tag ct-chip">
                      {row.action === 'load' ? 'Load' : 'Unload'}
                    </span>
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
