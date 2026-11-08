/**
 * Asset Lookup — "what is this device, and where does it go?", by scan
 * or by typing.
 *
 * One always-focused box, as on Scanning and RFID Enroll: a scanner is a
 * keyboard, so focus is the whole interaction. The value is matched by
 * `findAssets` (the API, or the move's synced devices when offline):
 * one device opens straight away, several show a short list to pick
 * from, none says so and keeps the value in the box — selected, so the
 * next scanner burst replaces it rather than appending to it.
 *
 * The card shows everyone the device's keys and its source and
 * destination. Admins also get its status, its moves, where it is now,
 * and (online, when it is on a move) its latest scans. The server
 * decides who gets the admin half (`full` is null below admin); the
 * page only renders what it was given.
 *
 * Read-only, deliberately: a lookup is not a scan, so nothing here
 * records one, queues one, or writes anything at all.
 */

import {
  useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement,
} from 'react';

import type { AssetScanRow } from '@portal/lib/api';
import { displayRfid } from '@portal/lib/format';
import { placementText } from '@portal/lib/placement';

import { useKioskAuth } from '../auth/KioskAuthContext';
import {
  ApiError, fetchAssetScans,
  type KioskAssetDetail, type KioskAssetEnd, type KioskLookupResult,
} from '../lib/api';
import {
  LOOKUP_CAP, MATCH_LABEL, assetDetail, findAssets, scanWhenText,
} from '../lib/assetLookup';
import { getIdentity } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';

/** The newest scans shown; the portal's asset page has the rest. */
const SCAN_LIMIT = 50;

/** The Scanning page's rule: focus is only reclaimed from things nobody
 *  deliberately moved it to. */
const KEEPS_FOCUS = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'A']);

type ScanHistory = AssetScanRow[] | 'loading' | 'error' | null;

/** The portal's status chip (`@portal/lib/chips`, a React module the
 *  kiosk may not import): colored when the value has a color, plain
 *  otherwise — offline the synced status has none. */
function statusChip(
  label: string | null | undefined, color: string | null | undefined,
): ReactElement | null {
  if (!label) return null;
  if (!color) return <span className="chip tag">{label}</span>;
  return (
    <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  );
}

function errorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'unknown_error';
  return `Couldn't look that up (${code}).`;
}

function RouteEnd({ title, end }: { title: string; end: KioskAssetEnd }) {
  const id = useId();
  const asPosition = !end.ru && Boolean(end.position);
  return (
    <div className="lookup-end" role="group" aria-labelledby={id}>
      <div className="lookup-end-title" id={id}>{title}</div>
      <dl className="enroll-facts">
        <div><dt>Site</dt><dd>{end.site_name || '—'}</dd></div>
        <div><dt>Pod</dt><dd className="mono">{end.pod || '—'}</dd></div>
        <div><dt>Rack</dt><dd className="mono">{end.rack || '—'}</dd></div>
        {asPosition
          ? <div><dt>Position</dt><dd className="mono">{end.position}</dd></div>
          : <div><dt>RU</dt><dd className="mono">{end.ru || '—'}</dd></div>}
      </dl>
    </div>
  );
}

function HistoryTable({ rows }: { rows: AssetScanRow[] }) {
  if (rows.length === 0) return <p className="page-hint">No scans recorded for this asset.</p>;
  return (
    <>
      <div className="local-table-wrap lookup-history-wrap">
        <table className="local-table lookup-history" aria-label="Scan history">
          <thead>
            <tr>
              <th>Status</th>
              <th>Scanned</th>
              <th>Method</th>
              <th>Device</th>
              <th>Operator</th>
              <th>Site</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="chips lookup-chips">
                    {statusChip(s.status_label, s.status_color) ?? '—'}
                    {s.off_move && <span className="chip c-amber">Off move</span>}
                  </div>
                </td>
                <td className="mono">{scanWhenText(s.scanned_at)}</td>
                <td>{statusChip(s.scan_type_label, s.scan_type_color) ?? '—'}</td>
                <td className="mono">{s.device_id || '—'}</td>
                <td>{s.operator_name || '—'}</td>
                <td>{s.site_name || '—'}</td>
                <td>{s.location_detail || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length >= SCAN_LIMIT && <p className="page-hint">Latest {SCAN_LIMIT} scans shown.</p>}
    </>
  );
}

export default function AssetLookup() {
  const [setup] = useKioskSetup();
  const { isAdmin } = useKioskAuth();

  const [value, setValue] = useState('');
  const [offline, setOffline] = useState(false);
  const [list, setList] = useState<KioskLookupResult | null>(null);
  const [detail, setDetail] = useState<KioskAssetDetail | null>(null);
  const [miss, setMiss] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scans, setScans] = useState<ScanHistory>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  /** Bumped by every lookup, pick and Clear: an answer to anything older
   *  is dropped, so a slow first answer never replaces the second. */
  const requestId = useRef(0);

  const disabled = !setup;

  /** Back in the box for the next scan. `select` keeps a missed value
   *  but lets the next scanner burst replace it. */
  const focusInput = (select = false) => {
    const el = inputRef.current;
    if (!el || el.disabled) return;
    el.focus();
    if (select) el.select();
  };

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

  // An admin's scan history: online only, and only for a device on a move.
  useEffect(() => {
    const full = detail?.full;
    if (!detail || !full || full.moves.length === 0 || offline) {
      setScans(null);
      return undefined;
    }
    let live = true;
    setScans('loading');
    fetchAssetScans(getIdentity().serial, detail.id, SCAN_LIMIT).then(
      (rows) => { if (live) setScans(rows); },
      () => { if (live) setScans('error'); },
    );
    return () => { live = false; };
  }, [detail, offline]);

  const openAsset = async (id: string, wasOffline: boolean, mine: number) => {
    const answer = await assetDetail(getIdentity().serial, id, wasOffline, isAdmin);
    if (mine !== requestId.current) return;
    setOffline(answer.offline);
    if (answer.detail) setDetail(answer.detail);
    else setError("Couldn't load that asset.");
  };

  const lookup = async () => {
    const q = value.trim();
    if (!q || disabled) return;                 // an empty Enter is a no-op
    const mine = ++requestId.current;
    setList(null);
    setDetail(null);
    setMiss(null);
    setError(null);
    try {
      const { offline: off, result } = await findAssets(getIdentity().serial, q);
      if (mine !== requestId.current) return;
      setOffline(off);
      if (result.matches.length === 0) {
        setMiss(q);
        focusInput(true);
        return;
      }
      setValue('');
      focusInput();
      if (result.matches.length === 1) await openAsset(result.matches[0].id, off, mine);
      else setList(result);
    } catch (err) {
      if (mine !== requestId.current) return;
      setError(errorText(err));
      focusInput(true);
    }
  };

  const pick = (id: string) => {
    const mine = ++requestId.current;
    setDetail(null);
    setError(null);
    focusInput();
    openAsset(id, offline, mine).catch((err: unknown) => {
      if (mine === requestId.current) setError(errorText(err));
    });
  };

  const clear = () => {
    ++requestId.current;
    setValue('');
    setOffline(false);
    setList(null);
    setDetail(null);
    setMiss(null);
    setError(null);
    focusInput();
  };

  // Enter is handled on the key, as RFID Enroll does: a scanner's Enter
  // is how a scan is entered, and implicit form submission is not
  // something to bet the screen on.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void lookup();
  };

  const matches = list?.matches.slice(0, LOOKUP_CAP) ?? [];
  const showMatched = matches.some((m) => m.matched.some((k) => k !== 'name'));
  const full = detail?.full ?? null;
  const manyRoutes = (detail?.routes.length ?? 0) >= 2;

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Asset Lookup</div>
      <h1 className="page-title">Asset Lookup</h1>
      {setup
        ? <p className="page-hint">{`${setup.initiativeName} · ${setup.siteName}`}</p>
        : <p className="page-hint">Finish Kiosk Setup first.</p>}

      <div className="lookup-bar">
        <input
          ref={inputRef}
          className="scan-input"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the point of the screen
          autoFocus
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          placeholder="Scan or type an asset tag, serial, RFID, or name"
          aria-label="Asset lookup value"
          disabled={disabled}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button" className="btn-solid" disabled={disabled}
          onClick={() => { void lookup(); }}
        >
          Search
        </button>
        <button type="button" className="mini-btn" onClick={clear}>Clear</button>
      </div>

      {offline && (
        <p className="lookup-offline" role="status">
          Offline — showing this move&apos;s devices only.
        </p>
      )}
      {miss !== null && <p className="form-error" role="alert">No asset matches {miss}.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {list && (
        <>
          <div className="local-table-wrap lookup-matches-wrap">
            <table className="local-table lookup-matches" aria-label="Matches">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Asset tag</th>
                  <th>Serial</th>
                  {showMatched && <th>Matched on</th>}
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <button type="button" className="lookup-pick" onClick={() => pick(m.id)}>
                        {m.name || 'Unnamed asset'}
                      </button>
                    </td>
                    <td className="mono">{m.asset_tag || '—'}</td>
                    <td className="mono">{m.serial_number || '—'}</td>
                    {showMatched && <td>{m.matched.map((k) => MATCH_LABEL[k]).join(', ')}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.truncated && <p className="page-hint">Refine your search</p>}
        </>
      )}

      {detail && (
        <div className="enroll-card lookup-card">
          <h2 className="enroll-card-name">{detail.name || 'Unnamed asset'}</h2>
          {detail.make_model && <p className="lookup-make">{detail.make_model}</p>}
          <dl className="enroll-facts">
            <div><dt>Asset tag</dt><dd className="mono">{detail.asset_tag || '—'}</dd></div>
            <div><dt>Serial</dt><dd className="mono">{detail.serial_number || '—'}</dd></div>
            <div>
              <dt>RFID</dt>
              <dd className="mono" title={detail.rfid ?? undefined}>
                {detail.rfid ? displayRfid(detail.rfid) : '—'}
              </dd>
            </div>
          </dl>

          {detail.routes.map((route) => (
            <section className="lookup-route" key={route.initiative_id}>
              {manyRoutes && <h3 className="lookup-route-title">{route.initiative_name}</h3>}
              <div className="lookup-routes">
                <RouteEnd title="Source" end={route.source} />
                <RouteEnd title="Destination" end={route.destination} />
              </div>
            </section>
          ))}

          {full && (
            <>
              <dl className="enroll-facts lookup-admin">
                <div>
                  <dt>Status</dt>
                  <dd>{statusChip(full.status_label, full.status_color) ?? '—'}</dd>
                </div>
                <div>
                  <dt>Moves</dt>
                  <dd>
                    {full.moves.length === 0 ? '—' : (
                      <div className="lookup-moves">
                        {full.moves.map((m) => (
                          <span className="lookup-move" key={m.initiative_id}>
                            <span>{m.initiative_name}</span>
                            {statusChip(m.status_label, m.status_color)}
                          </span>
                        ))}
                      </div>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Current location</dt>
                  <dd>{placementText(full) || '—'}</dd>
                </div>
              </dl>

              {(offline || full.moves.length > 0) && (
                <section className="lookup-history-section">
                  <h3 className="lookup-route-title">Scan history</h3>
                  {offline && <p className="page-hint">Scan history needs a connection.</p>}
                  {!offline && scans === 'loading' && <p className="page-hint">Loading…</p>}
                  {!offline && scans === 'error' && (
                    <p className="page-hint">Could not load scan history.</p>
                  )}
                  {!offline && Array.isArray(scans) && <HistoryTable rows={scans} />}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
