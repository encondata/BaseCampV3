/** History tab: every accepted config change, newest first (the
 *  `config_change` audits from GET /devices/{id}/config/history). Columns
 *  At / Source / By / Changes; a row opens to its field-by-field diff.
 *  Follows the list column-floor rules (listGridStyle, list-scroll,
 *  ColHead, cell-line). */

import { useState } from 'react';

import { useAuth } from '../../../auth/AuthContext';
import DataTable from '../../DataTable';
import type { DeviceConfigHistoryItem, KioskSoundItem } from '../../../lib/api';
import { fullDateTime } from '../../../lib/format';
import { agoText, fieldLabel, valueText } from '../../../lib/kioskConfig';
import { ColHead, listGridStyle, listScale, titleFor, type ColumnDef } from '../../../lib/listTools';

// Fit: these four + the 30px chevron track ≤ LIST_FIT.page (asserted in
// pages/hardware/KioskDetail.test.tsx).
export const HISTORY_COLUMNS: ColumnDef[] = [
  { key: 'at', label: 'At', width: '150px', default: true },
  { key: 'source', label: 'Source', width: '110px', default: true },
  { key: 'by', label: 'By', width: '1fr', default: true, min: 140 },
  { key: 'changes', label: 'Changes', width: '2.6fr', default: true, min: 260 },
];
const TRAILING = ['30px'];

const SOURCE_LABELS: Record<string, string> = { portal: 'Portal', kiosk: 'Kiosk' };

export function changesSummary(h: DeviceConfigHistoryItem, sounds: KioskSoundItem[] = []): string {
  const entries = Object.entries(h.changes ?? {});
  if (entries.length === 0) return 'No field changes';
  if (entries.length === 1) {
    const [k, v] = entries[0];
    return `${fieldLabel(k)}: ${valueText(v?.from, sounds)} → ${valueText(v?.to, sounds)}`;
  }
  return `${entries.length} changes: ${entries.map(([k]) => fieldLabel(k)).join(', ')}`;
}

export default function KioskHistoryTab({ history, sounds, error, onRetry }: {
  history: DeviceConfigHistoryItem[] | null;
  sounds: KioskSoundItem[];
  error: string;
  onRetry: () => void;
}) {
  const { preferences } = useAuth();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const grid = listGridStyle(HISTORY_COLUMNS, TRAILING, undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };

  if (error) {
    return (
      <div className="dir-empty">
        <b>{error}</b>
        <button type="button" className="mini-btn" style={{ marginTop: 8 }} onClick={onRetry}>Retry</button>
      </div>
    );
  }
  if (history === null) return <p className="page-hint">Loading…</p>;

  return (
    <div className="dir-list list-scroll">
      <div className="list-head" style={rowStyle}>
        {HISTORY_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
        <span className="col-head" aria-hidden="true" />
      </div>

      {history.length === 0 && (
        <div className="dir-empty"><b>No changes yet</b>Accepted settings changes from the kiosk or the portal show here.</div>
      )}

      {history.map((h, i) => {
        const key = `${h.at}-${h.version ?? i}`;
        const open = openKey === key;
        const by = h.by_name ?? '—';
        const summary = changesSummary(h, sounds);
        const rows = Object.entries(h.changes ?? {}).map(([field, v]) => ({
          key: field,
          cells: [fieldLabel(field), valueText(v?.from, sounds), valueText(v?.to, sounds)],
        }));
        return (
          <div key={key} className={`dir-row${open ? ' open' : ''}`} style={{ minWidth: rowStyle.minWidth }}>
            <div className="row-main" style={rowStyle} role="button" tabIndex={0} aria-expanded={open}
                 onClick={() => setOpenKey(open ? null : key)}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenKey(open ? null : key); }
                 }}>
              <div className="cell" title={fullDateTime(h.at)}>
                <span className="mono cell-line">{agoText(h.at)}</span>
              </div>
              <div className="cell">
                {h.source
                  ? <span className={`chip ${h.source === 'portal' ? 'c-blue' : 'tag'}`}>{SOURCE_LABELS[h.source] ?? h.source}</span>
                  : <span className="cell-top">—</span>}
              </div>
              <div className="cell"><span className="cell-top cell-line" title={titleFor(by)}>{by}</span></div>
              <div className="cell"><span className="cell-top cell-line" title={summary}>{summary}</span></div>
              <div className="cell chevron-cell">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </div>
            </div>
            <div className="detail">
              <div className="detail-clip">
                <div className="detail-inner">
                  {open && (
                    <div className="detail-block" style={{ paddingTop: 16 }}>
                      <DataTable ariaLabel="Field changes" emptyText="No field changes recorded."
                        columns={[
                          { key: 'field', label: 'Field' },
                          { key: 'from', label: 'Before' },
                          { key: 'to', label: 'After' },
                        ]}
                        rows={rows} />
                      <p className="set-note" style={{ padding: 0, marginTop: 8 }}>
                        {fullDateTime(h.at)}{h.version != null ? ` · settings version ${h.version}` : ''}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
