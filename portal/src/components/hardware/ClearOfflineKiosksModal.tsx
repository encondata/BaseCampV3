/** ClearOfflineKiosksModal — the confirmation step for "Clear offline and
 *  expired kiosks". It names every kiosk the server's dry run matched, with
 *  its registration state and last-seen time, so an irreversible bulk delete
 *  is read before it is approved rather than trusted blind.
 *
 *  Pure UI: it never calls the API. KioskDevices owns the dry run, the
 *  confirm call and the reload — the same division of labor
 *  RegisterDaysModal.tsx uses. Header/skeleton follow the house
 *  eyebrow/title/description modal pattern (model: LabelRunErrorsModal.tsx),
 *  and the rows go through the sanctioned `DataTable` rather than bare
 *  markup. */

import { useEffect } from 'react';

import DataTable, { type DataTableRow } from '../DataTable';
import type { ClearOfflineKioskItem } from '../../lib/api';
import { subTypeLabel } from '../../lib/devices';
import { relativeTime } from '../../lib/format';

interface Props {
  kiosks: ClearOfflineKioskItem[];
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

const COLUMNS = [
  { key: 'name', label: 'Name', width: '1.6fr' },
  { key: 'sub_type', label: 'Type', width: '0.8fr' },
  { key: 'registration', label: 'Registration', width: '1fr' },
  { key: 'last_seen', label: 'Last seen', width: '1fr', mono: true },
];

/** "registered" can only reach this list through a `skipped` row, but the
 *  wire type carries all three values, so every one gets a chip. */
const REGISTRATION: Record<ClearOfflineKioskItem['registration'], [string, string]> = {
  unregistered: ['Unregistered', 'chip c-slate'],
  expired: ['Expired', 'chip c-red'],
  registered: ['Registered', 'chip c-green'],
};

export default function ClearOfflineKiosksModal({ kiosks, busy, onConfirm, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const noun = kiosks.length === 1 ? 'kiosk' : 'kiosks';

  const rows: DataTableRow[] = kiosks.map((k) => {
    const [label, cls] = REGISTRATION[k.registration];
    return {
      key: k.id,
      cells: [
        <b key="name" className="cell-top">{k.name}</b>,
        <span key="type" className="chip tag">{subTypeLabel(k.sub_type)}</span>,
        <span key="registration" className={cls}>{label}</span>,
        // relativeTime's own null answer is a lowercase "never" mid-sentence;
        // this is a cell of its own, so it reads as a value.
        <span key="last_seen">{k.last_seen_at ? relativeTime(k.last_seen_at) : 'Never'}</span>,
      ],
    };
  });

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="modal-card reports-modal-card rgm-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Kiosk devices</div>
            <h3>Clear offline and expired kiosks</h3>
            <p className="page-hint">
              Kiosks that were never registered or whose registration has expired, and that
              have not been seen in the last 24 hours. Deleting them cannot be undone.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}
                  disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>

        <div className="modal-body">
          {kiosks.length === 0 ? (
            <p className="page-hint">
              Nothing to clear — every kiosk is either registered or has been seen in the
              last 24 hours.
            </p>
          ) : (
            <DataTable ariaLabel="Kiosks that will be deleted" columns={COLUMNS} rows={rows} />
          )}
        </div>

        <div className="modal-foot">
          {kiosks.length === 0 ? (
            <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
          ) : (
            <>
              <button type="button" className="btn-solid btn-danger" onClick={onConfirm}
                      disabled={busy}>
                {busy ? 'Deleting…' : `Delete ${kiosks.length} ${noun}`}
              </button>
              <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
