/**
 * The builder's Load from asset… (spec §4.6): pick a move, then one of the
 * assets on its roster, and every field's sample takes that asset's value
 * (GET /labels/sample-values, the values its label prints, From-To columns
 * included). The page merges them with `fillSamples`: a field the asset has
 * blank keeps the sample it had, so the canvas never goes empty.
 *
 * The report-generate header and step row, the initiative picker's list
 * (reports.css `ini-picker`), sized to its content. The page turns the
 * canvas keyboard off while it is open.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  ApiError, listInitiativeAssets, listInitiatives, loadSampleAsset, type InitiativeAssetRow, type InitiativeItem,
} from '../../../lib/api';
import { sortNatural } from '../../../lib/naturalSort';
import { fmtDate } from '../../../lib/reports';
import '../../../styles/directory.css';
import '../../../styles/profile.css';   /* .btn-solid, .pf-error */
import '../../../styles/reports.css';
import '../../../styles/labelBuilder.css';

export interface LoadFromAssetModalProps {
  /** The asset's values, {field key: text}; the page merges them (fillSamples). */
  onLoad: (values: Record<string, string>) => void;
  onClose: () => void;
}

/** `values` over `samples`: every value the asset has replaces the sample;
 *  a blank one leaves the old sample. Counts what was filled, and the
 *  samples kept because the asset had nothing there. */
export function fillSamples(samples: Readonly<Record<string, string>>, values: Readonly<Record<string, string>>):
  { samples: Record<string, string>; filled: number; kept: number } {
  const out: Record<string, string> = { ...samples };
  let filled = 0;
  let kept = 0;
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      out[key] = value;
      filled += 1;
    } else if (Object.hasOwn(samples, key) && samples[key]) {
      kept += 1;
    }
  }
  return { samples: out, filled, kept };
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'asset_not_on_move') return 'That asset is no longer on this move.';
    if (err.code === 'initiative_not_found') return 'That move is gone, or you can no longer see it.';
  }
  return fallback;
}

function includes(text: string | number | null | undefined, query: string): boolean {
  return String(text ?? '').toLowerCase().includes(query);
}

const SEARCH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
);

export default function LoadFromAssetModal({ onLoad, onClose }: LoadFromAssetModalProps) {
  const [step, setStep] = useState<'move' | 'asset'>('move');
  const [moves, setMoves] = useState<InitiativeItem[] | null>(null);
  const [moveSearch, setMoveSearch] = useState('');
  const [move, setMove] = useState<InitiativeItem | null>(null);
  const [assets, setAssets] = useState<InitiativeAssetRow[] | null>(null);
  const [assetSearch, setAssetSearch] = useState('');
  const [asset, setAsset] = useState<InitiativeAssetRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listInitiatives()
      .then((all) => {
        if (!live) return;
        setMoves(all
          .filter((i) => i.initiative_type === 'move' && !i.archived_at)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
      })
      .catch(() => { if (live) setError("Couldn't load the moves."); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (step !== 'asset' || !move) return undefined;
    let live = true;
    setAssets(null);
    listInitiativeAssets(move.id)
      .then((rows) => { if (live) setAssets(sortNatural(rows, (r) => r.asset.name ?? '')); })
      .catch(() => { if (live) setError("Couldn't load this move's assets."); });
    return () => { live = false; };
  }, [step, move]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const shownMoves = useMemo(() => {
    const q = moveSearch.trim().toLowerCase();
    return (moves ?? []).filter((m) => !q || includes(m.name, q) || includes(m.code, q) || includes(m.client_name, q));
  }, [moves, moveSearch]);

  const shownAssets = useMemo(() => {
    const q = assetSearch.trim().toLowerCase();
    return (assets ?? []).filter((r) => !q || includes(r.asset.name, q) || includes(r.asset.serial_number, q)
      || includes(r.asset.legacy_id, q) || includes(r.asset.rfid_tag, q) || includes(r.destination_rack, q)
      || includes(r.source_rack, q));
  }, [assets, assetSearch]);

  const load = async () => {
    if (!move || !asset) return;
    setBusy(true);
    setError(null);
    try {
      onLoad(await loadSampleAsset(move.id, asset.asset_id));
    } catch (err) {
      setError(errorText(err, "Couldn't load that asset's values."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card lbp-load-card" role="dialog" aria-modal="true"
        aria-label="Load samples from an asset">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Label builder</div>
            <h3>Load samples from an asset</h3>
            <p className="page-hint">Pick a move, then one of its assets: every field&apos;s sample takes that asset&apos;s value.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="rgm-steps">
          <span className={`rgm-step ${step === 'move' ? 'on' : 'done'}`}>
            <span className="rgm-step-num">1</span>
            <span className="rgm-step-label">Move</span>
          </span>
          <span className="rgm-step-sep" />
          <span className={`rgm-step ${step === 'asset' ? 'on' : ''}`}>
            <span className="rgm-step-num">2</span>
            <span className="rgm-step-label">Asset</span>
          </span>
        </div>

        {step === 'move' && (
          <>
            <div className="modal-body">
              <div className="ini-picker">
                <div className="ini-picker-tools">
                  <div className="dir-search">
                    {SEARCH_ICON}
                    <input type="search" aria-label="Search moves" placeholder="Search moves…" value={moveSearch}
                      onChange={(e) => setMoveSearch(e.target.value)} />
                  </div>
                </div>
                <div className="mini-list ini-picker-list" role="radiogroup" aria-label="Moves">
                  {moves === null && !error && <div className="ini-picker-empty">Loading…</div>}
                  {moves !== null && shownMoves.length === 0 && <div className="ini-picker-empty">No moves match.</div>}
                  {shownMoves.map((m) => (
                    <label key={m.id} className={`mini-row ini-picker-row ${move?.id === m.id ? 'on' : ''}`}>
                      <input type="radio" name="lbp-load-move" aria-label={m.name} checked={move?.id === m.id}
                        onChange={() => { setMove(m); setAsset(null); }} />
                      <span className="cell-primary"><span className="pn"><b>{m.name}</b></span></span>
                      <span className="cell-sub">{m.client_name ?? '—'}</span>
                      <span className="chip custom" style={{ '--chip': m.status_color } as CSSProperties}>
                        <span className="dot" />{m.status_label}
                      </span>
                      <span className="mono">{fmtDate(m.scheduled_start)}</span>
                    </label>
                  ))}
                </div>
              </div>
              {error && <div className="pf-error">{error}</div>}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn-solid" disabled={!move}
                onClick={() => { setError(null); setAssetSearch(''); setStep('asset'); }}>Next</button>
            </div>
          </>
        )}

        {step === 'asset' && move && (
          <>
            <div className="modal-body">
              <div className="ini-picker">
                <div className="ini-picker-tools">
                  <div className="dir-search">
                    {SEARCH_ICON}
                    <input type="search" aria-label="Search assets" placeholder="Name, serial, asset ID, RFID or rack…"
                      value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)} />
                  </div>
                </div>
                <div className="mini-list ini-picker-list" role="radiogroup" aria-label={`Assets on ${move.name}`}>
                  {assets === null && !error && <div className="ini-picker-empty">Loading…</div>}
                  {assets !== null && shownAssets.length === 0 && (
                    <div className="ini-picker-empty">{assets.length ? 'No assets match.' : 'This move has no assets yet.'}</div>
                  )}
                  {shownAssets.map((r) => (
                    <label key={r.id} className={`mini-row ini-picker-row ${asset?.id === r.id ? 'on' : ''}`}>
                      <input type="radio" name="lbp-load-asset" aria-label={r.asset.name ?? r.asset.serial_number ?? r.asset_id}
                        checked={asset?.id === r.id} onChange={() => setAsset(r)} />
                      <span className="cell-primary">
                        <span className="pn">
                          <b>{r.asset.name ?? '—'}</b>
                          {r.asset.legacy_id != null && <span>#{r.asset.legacy_id}</span>}
                        </span>
                      </span>
                      <span className="mono">{r.asset.serial_number ?? '—'}</span>
                      <span className="chip custom" style={{ '--chip': r.status_color } as CSSProperties}>
                        <span className="dot" />{r.status_label}
                      </span>
                      <span className="mono">{r.destination_rack ?? r.source_rack ?? '—'}</span>
                    </label>
                  ))}
                </div>
              </div>
              {error && <div className="pf-error">{error}</div>}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn-ghost" disabled={busy}
                onClick={() => { setError(null); setStep('move'); }}>Back</button>
              <button type="button" className="btn-solid" disabled={!asset || busy} onClick={() => void load()}>
                {busy ? 'Loading…' : 'Load samples'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
