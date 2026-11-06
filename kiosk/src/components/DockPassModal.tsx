/**
 * One closed Dock pass in full (the Dock screen's Details): what packing did
 * with each asset, and every read behind the pass (time, tag, what it
 * matched, antenna, signal), so the antennas can be tuned.
 * Loads GET /edge/dock/passes/{id}, and again every 2 s while the pass is
 * waiting to be sent, so it shows the portal's answer once it lands; a
 * failed first load says so and the modal still closes. Escape, the scrim
 * and the close button close it; a long pass scrolls inside the card.
 */

import { useEffect, useState } from 'react';

import {
  getDockPass, type DockPassDetail, type DockPassRow, type DockPassTag, type DockTagKind,
} from '../lib/api';
import { clockText, displayEpc } from '../pages/RfidStatus';

/** How often a pass still waiting to be sent is read again. */
const REFRESH_MS = 2000;

/** Why the portal turned a whole pass away, from its error code. */
function refuseText(code: string): string {
  switch (code) {
    case 'container_not_found': return 'crate not found in the portal';
    case 'move_locked': return 'crate is on another move';
    case 'move_inactive': return 'the move is closed';
    default: return code;
  }
}

/** What became of a closed pass: its Recent passes outcome and this
 *  modal's hint. */
export function passOutcome(p: DockPassRow): string {
  switch (p.status) {
    case 'would_pack': return `Would pack ${p.asset_count} into ${p.container_name ?? '—'}`;
    case 'waiting': return 'Waiting to send';
    case 'packed': return p.refused_count > 0 ? `Packed · ${p.refused_count} not packed` : 'Packed';
    case 'refused': return p.refuse_code ? `Not packed: ${refuseText(p.refuse_code)}` : 'Not packed';
    case 'flagged':
      if (p.flag === 'many_crates') return 'Flagged: More than one crate';
      return p.flag === 'no_crate' ? 'Flagged: No crate read' : 'Flagged';
    case 'nothing': return 'Nothing to pack';
    default: return String(p.status);
  }
}

/** Why the portal refused one asset, from its reason code. */
function reasonText(reason: string): string {
  switch (reason) {
    case 'changed_since_pass': return 'Changed since this pass';
    case 'not_on_move': return 'not on this move';
    case 'asset_not_found': return 'not found in the portal';
    default: return reason;
  }
}

/** What packing did with one asset. Only a sent pass has per-asset
 *  answers; the edge passes the portal's result through as is, so one this
 *  build doesn't know is shown raw. */
function packingText(pass: DockPassRow, tag: DockPassTag): string {
  switch (pass.status) {
    case 'packed': break;
    case 'would_pack': return 'Would pack';
    case 'waiting': return 'Waiting to send';
    default: return 'Not sent';
  }
  const result: string | null = tag.result ?? null;
  switch (result) {
    case 'packed': return 'Packed';
    case 'moved': return tag.moved_from ? `Moved from ${tag.moved_from}` : 'Moved';
    case 'already_there': return 'Already there';
    case 'refused': return tag.reason ? `Not packed: ${reasonText(tag.reason)}` : 'Not packed';
    case null: return '—';
    default: return result;
  }
}

/** What one read matched on the move; `label` is its tag's name. */
function matchedText(kind: DockTagKind | null, label: string | null): string {
  switch (kind) {
    case 'asset': return label ? `Asset ${label}` : 'Asset';
    case 'container': return label ? `Crate ${label}` : 'Crate';
    case 'person': return 'Person';
    case 'off_move': return 'Off-move asset';
    default: return 'Unknown';
  }
}

export default function DockPassModal({ passId, onClose }: { passId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<DockPassDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let loaded = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const d = await getDockPass(passId);
        if (!live) return;
        loaded = true;
        setDetail(d);
        // A pass waiting to be sent changes once the portal answers it.
        if (d.pass.status === 'waiting') timer = window.setTimeout(() => { void load(); }, REFRESH_MS);
      } catch {
        if (!live) return;
        // A failed first load says so; a failed refresh keeps what's shown.
        if (loaded) timer = window.setTimeout(() => { void load(); }, REFRESH_MS);
        else setFailed(true);
      }
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [passId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pass = detail?.pass ?? null;
  const assets = detail ? detail.tags.filter((t) => t.kind === 'asset') : [];
  const labels = new Map(detail?.tags.map((t) => [t.epc, t.label]) ?? []);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card dock-pass-card" role="dialog"
           aria-modal="true" aria-labelledby="dock-pass-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Dock pass</div>
            <h3 id="dock-pass-title">{pass ? `Pass at ${clockText(new Date(pass.opened_at))}` : 'Pass'}</h3>
            {pass && <p className="page-hint">{passOutcome(pass)}</p>}
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {failed && <p className="form-error" role="alert">Couldn&apos;t load this pass.</p>}
          {!failed && !detail && <p className="page-hint">Loading…</p>}
          {pass && detail && (
            <>
              <div className="modal-section">Packing</div>
              <table className="local-table dock-pass-table">
                <thead>
                  <tr><th>Asset</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {assets.length === 0 && (
                    <tr><td colSpan={2} className="rfid-dash-empty">No assets in this pass.</td></tr>
                  )}
                  {assets.map((t) => (
                    <tr key={t.epc}>
                      <td title={t.epc}>{t.label ?? displayEpc(t.epc)}</td>
                      <td>{packingText(pass, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="modal-section">Reads</div>
              <table className="local-table dock-pass-table">
                <thead>
                  <tr><th>Time</th><th>Tag</th><th>Matched</th><th>Antenna</th><th>Signal</th></tr>
                </thead>
                <tbody>
                  {detail.reads.length === 0 && (
                    <tr><td colSpan={5} className="rfid-dash-empty">No reads in this pass.</td></tr>
                  )}
                  {detail.reads.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{clockText(new Date(r.read_at))}</td>
                      <td className="mono" title={r.epc}>{displayEpc(r.epc)}</td>
                      <td>{matchedText(r.kind, labels.get(r.epc) ?? null)}</td>
                      <td className="mono">{r.antenna ?? '—'}</td>
                      <td className="mono">{r.peak_rssi === null ? '—' : `${r.peak_rssi} dBm`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
